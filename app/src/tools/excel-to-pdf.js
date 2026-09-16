import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { el, errorBox, formatBytes, stem } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, numberField, optionPanel, segmented, selectField,
} from '../option-ui.js';
import {
  FontBank, PAGE_SIZES, captionedPage, drawOps, previewPage, previewStrip,
  scriptsUsed,
} from '../office-text.js';

// An .xlsx is a ZIP of XML files, and JSZip is already here, so the workbook is
// read directly rather than through a spreadsheet library. That is a deliberate
// choice, not laziness: the npm build of `xlsx` carries an unfixed high-severity
// prototype-pollution advisory, and a tool a whole faculty is told to use should
// not ship a known hole to save an afternoon. The parts we need are small:
//
//   xl/workbook.xml          the sheet names, in tab order
//   xl/_rels/workbook.xml.rels   which file each sheet lives in
//   xl/sharedStrings.xml     every string in the book, stored once
//   xl/styles.xml            enough of it to tell 45678 from 3 January 2025
//   xl/worksheets/sheetN.xml the cells themselves
//
// CSV and TSV skip all of that and are read as text, because half the marks
// sheets in the world arrive that way.

const ROW_SIZE = 9.5;         // body text, points
const ROW_H = ROW_SIZE * 1.95;
const CELL_PAD = 4;
const MIN_COL_W = 26;
const MIN_TEXT = 6;           // never shrink a cell below this — it stops being readable
const PAGE_MARGIN = 36;
const FOOTER_H = 20;

const INK = '#1a1a1a';
const RULE = '#c3c9d2';
const HEAD_TINT = '#eef1f6';
const FAINT = '#6b7280';

const MAX_SHEET_ROWS = 50000;   // a hard stop before the browser runs out of memory
const MAX_PREVIEW_PAGES = 30;

// Excel's built-in number formats, by id. Only the ones that change what a
// number *means* matter here.
const DATE_IDS = new Set([14, 15, 16, 17, 22]);
const TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
const PERCENT_IDS = new Set([9, 10]);

export default function render(container, tool) {
  const state = {
    file: null,
    kind: null,          // 'xlsx' | 'csv'
    zip: null,
    book: null,          // { sheets, shared, formats, date1904 }
    sheetIndex: 0,
    rows: [],            // the parsed sheet: [[{ v, num }, …], …]
    bank: null,
    scripts: [],
    plan: null,
  };
  const ui = {};
  let pane = null;

  toolShell(container, tool, {
    accept: '.xlsx,.csv,.tsv,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    multiple: false,
    pickLabel: 'Select a spreadsheet',
    dropLabel: 'or drop an .xlsx, .csv or .tsv here',
    actionLabel: 'Convert to PDF',
    doneTitle: 'Your table is ready!',
    downloadLabel: 'Download PDF',
    continueTo: ['compress-pdf', 'merge-pdf'],
    note: 'A marks sheet or a club budget printed straight from Excel usually loses the last two columns off the right edge. Landscape plus "fit all columns" is the fix, and the preview here shows you the result before you print anything.',

    // The left pane is the printout: the same pages, the same column widths, the
    // same row on the same page as the PDF you are about to download.
    workarea(host) {
      if (pane) return;
      pane = previewStrip();
      host.appendChild(pane.root);
      paint();
    },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Spreadsheet to PDF');

      ui.facts = fileFacts();
      ui.about = infoBox('Every cell prints as the value Excel last saved for it — a formula arrives as its result, a date as a date. Colours, charts, images and merged cells do not come across; this is a clean table of the numbers, not a photograph of the workbook. Each cell is one line: text too wide for its column is set smaller, and cut with a … if it still will not fit.');
      ui.warn = infoBox('');
      ui.warn.root.classList.add('opt__info--bad');
      ui.warn.hide();

      ui.sheet = selectField('Sheet', [{ id: '0', label: 'Sheet 1' }], {
        value: '0',
        onChange: async (v) => {
          state.sheetIndex = Number(v);
          errorBox(container, null);
          try {
            await loadSheet();
            // A workbook can hold an English sheet and a Thai one, so the fonts,
            // the row cap and the facts all belong to the sheet, not to the file.
            await afterSheet();
          } catch (err) {
            state.rows = [];
            errorBox(container, err.message);
          }
          update();
        },
      });
      ui.sheet.root.hidden = true;

      ui.orient = segmented(
        [{ id: 'portrait', label: 'Portrait' }, { id: 'landscape', label: 'Landscape' }],
        update,
        { active: 1 },   // a table is wider than it is tall far more often than not
      );

      ui.size = selectField('Page size', [
        { id: 'a4', label: PAGE_SIZES.a4.label },
        { id: 'letter', label: PAGE_SIZES.letter.label },
      ], { value: 'a4', onChange: update });

      ui.repeat = checkRow('Repeat the header row on every page', { checked: true, onChange: update });
      ui.grid = checkRow('Draw grid lines', { checked: true, onChange: update });
      ui.fit = checkRow('Fit all columns to one page width', {
        checked: true,
        hint: 'Off, the extra columns continue on later pages instead of being squeezed.',
        onChange: update,
      });

      ui.maxRows = numberField('Maximum rows', {
        value: 500, min: 1, max: MAX_SHEET_ROWS, step: 50, suffix: 'rows',
        hint: 'Counting the header. Stops a 40,000-row export becoming a 900-page PDF.',
        onChange: update,
      });

      ui.explain = liveExplain();

      panel.add(ui.facts, ui.about, ui.sheet, ui.orient, ui.size, ui.repeat, ui.grid, ui.fit, ui.maxRows, ui.warn, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.rows.length) throw new Error('There is no table to print yet — choose a spreadsheet first.');
      const plan = state.plan;
      if (!plan?.pages.length) throw new Error('That sheet is empty. Pick another sheet, or check the file has data in it.');

      const doc = await PDFDocument.create();
      const bank = new FontBank(doc);
      ctx.setBusy(0.05, 'Preparing fonts…');
      await bank.prepare(state.scripts);

      for (const [i, ops] of plan.pages.entries()) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.1 + (i / plan.pages.length) * 0.85, `Drawing page ${i + 1} of ${plan.pages.length}…`);
        const page = doc.addPage([plan.pw, plan.ph]);
        drawOps(page, ops, bank);
        // setTimeout, not requestAnimationFrame — a 200-page table has to keep
        // going while the student reads LINE in another tab.
        await new Promise((r) => setTimeout(r, 0));
      }

      ctx.setBusy(0.98, 'Saving…');
      const bytes = await doc.save();
      const label = state.book && state.book.sheets.length > 1
        ? `-${safeName(state.book.sheets[state.sheetIndex].name)}`
        : '';
      return {
        outputs: [{
          name: `${stem(state.file.name)}${label}.pdf`,
          blob: new Blob([bytes], { type: 'application/pdf' }),
        }],
        doneTitle: `Your ${plan.pages.length}-page table is ready!`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Reading the file
  // -------------------------------------------------------------------------

  async function loadFile() {
    // Good file or bad, the preview must end up showing this one and not the
    // spreadsheet before it.
    try {
      await readFile();
    } finally {
      update();
    }
  }

  async function readFile() {
    const file = state.file;
    state.zip = null; state.book = null; state.rows = []; state.plan = null;
    state.sheetIndex = 0;
    ui.facts.set([]);
    if (!file) return;

    if (/\.xls$/i.test(file.name)) {
      throw new Error('This is an old .xls file, and browsers cannot read that format. Open it in Excel or Google Sheets and save it as .xlsx or .csv, then come back.');
    }

    if (pane) pane.hint.textContent = 'Reading the spreadsheet…';

    if (/\.(csv|tsv|txt)$/i.test(file.name) || /csv|tab-separated/i.test(file.type)) {
      state.kind = 'csv';
      state.rows = parseDelimited(await file.text(), file.name);
      ui.sheet.root.hidden = true;
    } else {
      state.kind = 'xlsx';
      state.zip = await openZip(file);
      state.book = await readBook(state.zip);
      if (!state.book.sheets.length) throw new Error('No sheets were found inside that file. If it came from LINE or Gmail, download it again — a half-downloaded file fails exactly like this.');
      // The sheet picker only earns its space in a workbook that has several.
      ui.sheet.el.innerHTML = '';
      state.book.sheets.forEach((s, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = s.name;
        ui.sheet.el.appendChild(opt);
      });
      ui.sheet.value = '0';
      ui.sheet.root.hidden = state.book.sheets.length < 2;
      await loadSheet();
    }

    await afterSheet();
  }

  /** Everything that belongs to the sheet on screen rather than to the file. */
  async function afterSheet() {
    if (!state.rows.length) throw new Error('That sheet has no rows in it. Try another sheet, or check the file in Excel first.');

    // Only the scripts really used get a font embedded — an all-English marks
    // sheet downloads nothing extra.
    const seen = new Set();
    for (const row of state.rows) for (const cell of row) scriptsUsed(cell.v, seen);
    state.scripts = [...seen];
    const scratch = await PDFDocument.create();
    state.bank = new FontBank(scratch);
    await state.bank.prepare(state.scripts);

    ui.maxRows.setMax(Math.max(1, state.rows.length));
    if (ui.maxRows.value > state.rows.length) ui.maxRows.value = state.rows.length;

    ui.facts.set([
      ['Original size', formatBytes(state.file.size)],
      ['Rows', state.rows.length.toLocaleString()],
      ['Columns', String(Math.max(...state.rows.map((r) => r.length)))],
      ...(state.book ? [['Sheets', String(state.book.sheets.length)]] : []),
    ]);
  }

  async function openZip(file) {
    try {
      return await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
      throw new Error('That file is not a readable .xlsx — it did not open as a workbook. Re-save it from Excel or Google Sheets and try again.');
    }
  }

  /** Sheet names, shared strings and just enough of the style table. */
  async function readBook(zip) {
    const workbook = parseXml(await text(zip, 'xl/workbook.xml'), 'xl/workbook.xml');
    const rels = zip.file('xl/_rels/workbook.xml.rels')
      ? parseXml(await text(zip, 'xl/_rels/workbook.xml.rels'), 'workbook.xml.rels')
      : null;

    const targets = new Map();
    if (rels) {
      for (const r of tags(rels, 'Relationship')) {
        targets.set(r.getAttribute('Id'), r.getAttribute('Target'));
      }
    }

    const sheets = [];
    for (const [i, sheet] of [...tags(workbook, 'sheet')].entries()) {
      const rid = sheet.getAttribute('r:id') ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let path = targets.get(rid);
      // Not every producer writes the rels we expect; the conventional path is
      // a reliable fallback, and the tab order is what really matters.
      if (!path) path = `worksheets/sheet${i + 1}.xml`;
      path = path.replace(/^\//, '').replace(/^xl\//, '');
      sheets.push({ name: sheet.getAttribute('name') || `Sheet ${i + 1}`, path: `xl/${path}` });
    }

    // 1904 dating is a Mac-Excel legacy that shifts every date by four years.
    const pr = [...tags(workbook, 'workbookPr')][0];
    const date1904 = pr?.getAttribute('date1904') === '1' || pr?.getAttribute('date1904') === 'true';

    const shared = [];
    if (zip.file('xl/sharedStrings.xml')) {
      const doc = parseXml(await text(zip, 'xl/sharedStrings.xml'), 'sharedStrings.xml');
      for (const si of tags(doc, 'si')) {
        // Rich text splits one string over several <r><t> runs; joining them is
        // the whole of what "rich text" means to a plain table.
        shared.push([...tags(si, 't')].map((t) => t.textContent).join(''));
      }
    }

    const formats = await readFormats(zip);
    return { sheets, shared, formats, date1904 };
  }

  /**
   * styles.xml → for each cell style index, what kind of number it is.
   * Without this a date is an unhelpful 45678 and a percentage is 0.87.
   */
  async function readFormats(zip) {
    const out = [];
    if (!zip.file('xl/styles.xml')) return out;
    const doc = parseXml(await text(zip, 'xl/styles.xml'), 'styles.xml');

    const custom = new Map();
    for (const f of tags(doc, 'numFmt')) {
      custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
    }
    const xfs = [...tags(doc, 'cellXfs')][0];
    if (!xfs) return out;
    for (const xf of tags(xfs, 'xf')) {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      out.push(classifyFormat(id, custom.get(id) ?? ''));
    }
    return out;
  }

  function classifyFormat(id, code) {
    if (DATE_IDS.has(id)) return { kind: id === 22 ? 'datetime' : 'date', decimals: 0 };
    if (TIME_IDS.has(id)) return { kind: 'time', decimals: 0 };
    if (PERCENT_IDS.has(id)) return { kind: 'percent', decimals: id === 10 ? 2 : 0 };
    if (!code) return { kind: 'number', decimals: -1 };

    // Quoted literals in a format code can contain anything, so they come out
    // before the code is sniffed for date letters.
    const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
    const hasDate = /[yd]/i.test(bare) || /m{3,}/i.test(bare);
    const hasTime = /[hs]/i.test(bare);
    const decimals = (bare.match(/\.(0+)/)?.[1].length) ?? 0;
    if (hasDate && hasTime) return { kind: 'datetime', decimals: 0 };
    if (hasDate) return { kind: 'date', decimals: 0 };
    if (hasTime) return { kind: 'time', decimals: 0 };
    if (bare.includes('%')) return { kind: 'percent', decimals };
    if (/m/i.test(bare) && !/[#0]/.test(bare)) return { kind: 'date', decimals: 0 };
    return { kind: 'number', decimals: bare.includes('.') ? decimals : -1 };
  }

  async function loadSheet() {
    const sheet = state.book.sheets[state.sheetIndex];
    const entry = state.zip.file(sheet.path) ?? state.zip.file(sheet.path.replace('xl/', ''));
    if (!entry) throw new Error(`The sheet "${sheet.name}" is missing from inside this file. Try another sheet.`);
    state.rows = readSheet(parseXml(await entry.async('string'), sheet.path), state.book);
  }

  /** One worksheet's XML → a rectangular array of cells. */
  function readSheet(doc, book) {
    const rows = [];
    let widest = 0;
    for (const rowEl of tags(doc, 'row')) {
      const index = Number(rowEl.getAttribute('r') || rows.length + 1) - 1;
      if (index >= MAX_SHEET_ROWS) break;
      const cells = [];
      for (const c of tags(rowEl, 'c')) {
        const col = colIndex(c.getAttribute('r') ?? '');
        cells[col >= 0 ? col : cells.length] = readCell(c, book);
      }
      widest = Math.max(widest, cells.length);
      rows[index] = cells;
    }

    // Spreadsheets are sparse — an empty row simply is not in the file — so the
    // holes are filled here rather than everywhere downstream.
    const table = [];
    for (let r = 0; r < rows.length; r++) {
      const src = rows[r] ?? [];
      const row = [];
      for (let c = 0; c < widest; c++) row.push(src[c] ?? { v: '', num: false });
      table.push(row);
    }
    return trimTable(table);
  }

  function readCell(c, book) {
    const type = c.getAttribute('t') ?? 'n';
    const vEl = [...tags(c, 'v')][0];
    const raw = vEl?.textContent ?? '';

    if (type === 's') return { v: book.shared[Number(raw)] ?? '', num: false };
    if (type === 'inlineStr') return { v: [...tags(c, 't')].map((t) => t.textContent).join(''), num: false };
    if (type === 'str') return { v: raw, num: false };
    if (type === 'b') return { v: raw === '1' ? 'TRUE' : 'FALSE', num: false };
    if (type === 'e') return { v: raw, num: false };
    if (raw === '') return { v: '', num: false };

    const n = Number(raw);
    if (!Number.isFinite(n)) return { v: raw, num: false };
    const fmt = book.formats[Number(c.getAttribute('s') ?? 0)] ?? { kind: 'number', decimals: -1 };
    return { v: formatNumber(n, fmt, book.date1904), num: fmt.kind === 'number' || fmt.kind === 'percent' };
  }

  function formatNumber(n, fmt, date1904) {
    if (fmt.kind === 'date' || fmt.kind === 'time' || fmt.kind === 'datetime') {
      const d = excelDate(n, date1904);
      if (!d) return cleanNumber(n, fmt.decimals);
      const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      if (fmt.kind === 'date') return day;
      if (fmt.kind === 'time') return time;
      return `${day} ${time}`;
    }
    if (fmt.kind === 'percent') return `${cleanNumber(n * 100, fmt.decimals)}%`;
    return cleanNumber(n, fmt.decimals);
  }

  /**
   * Excel counts days from 1899-12-30, not 1900-01-01, because it kept a bug
   * from Lotus 1-2-3 that treats 1900 as a leap year. Serials below 60 predate
   * the phantom 29 February and need the other epoch.
   */
  function excelDate(serial, date1904) {
    if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
    const epoch = date1904 ? Date.UTC(1904, 0, 1)
      : serial < 60 ? Date.UTC(1899, 11, 31)
        : Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(serial * 86400000));
  }

  function cleanNumber(n, decimals) {
    if (decimals >= 0) return n.toFixed(decimals);
    // Binary floating point turns 0.1 + 0.2 into a horror show; rounding at the
    // tenth decimal removes the noise without touching real precision.
    return String(Number(n.toFixed(10)));
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** "BC7" → 54. The column letters are base-26 with no zero. */
  function colIndex(ref) {
    const m = /^([A-Z]+)/i.exec(ref);
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /** Drops the empty rows and columns that trail almost every export. */
  function trimTable(table) {
    let last = -1;
    for (const [i, row] of table.entries()) if (row.some((c) => c.v !== '')) last = i;
    const rows = table.slice(0, last + 1);
    let lastCol = -1;
    for (const row of rows) {
      for (let c = row.length - 1; c > lastCol; c--) if (row[c].v !== '') { lastCol = c; break; }
    }
    return rows.map((row) => row.slice(0, lastCol + 1));
  }

  /** CSV/TSV, including quoted fields with commas and newlines inside them. */
  function parseDelimited(text, name) {
    const body = text.replace(/^﻿/, '');
    // Excel in a Thai or European locale writes semicolons, not commas, and a
    // file that parses as one giant column is the classic symptom.
    const head = body.slice(0, 4000);
    const delim = /\.tsv$/i.test(name) || head.includes('\t')
      ? '\t'
      : (head.split(';').length > head.split(',').length ? ';' : ',');

    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quoted) {
        if (ch === '"') {
          if (body[i + 1] === '"') { field += '"'; i += 1; }
          else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === delim) { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    row.push(field);
    rows.push(row);

    const width = Math.max(...rows.map((r) => r.length));
    const table = rows.map((r) => {
      const out = [];
      for (let c = 0; c < width; c++) {
        const v = (r[c] ?? '').trim();
        out.push({ v, num: v !== '' && /^-?[\d,]*\.?\d+%?$/.test(v) });
      }
      return out;
    });
    return trimTable(table);
  }

  // ---- tiny XML helpers ----------------------------------------------------

  async function text(zip, path) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`This .xlsx is missing ${path}, so it cannot be read as a workbook. Re-save it from Excel and try again.`);
    return entry.async('string');
  }

  function parseXml(source, what) {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error(`The ${what} inside this file is damaged, so the workbook cannot be read. Re-save it from Excel and try again.`);
    }
    return doc;
  }

  // Namespace-agnostic: some writers prefix every tag, most prefix none.
  const tags = (root, name) => root.getElementsByTagNameNS('*', name);

  const safeName = (s) => s.replace(/[^\w฀-๿ -]+/g, '').trim().slice(0, 40) || 'sheet';

  // -------------------------------------------------------------------------
  // Layout — one pass, used by both the preview and the export
  // -------------------------------------------------------------------------

  function buildPlan() {
    const bank = state.bank;
    if (!bank || !state.rows.length) return null;

    const paper = PAGE_SIZES[ui.size.value];
    const landscape = ui.orient.value === 'landscape';
    const pw = landscape ? paper.h : paper.w;
    const ph = landscape ? paper.w : paper.h;
    const contentW = pw - PAGE_MARGIN * 2;
    const contentBottom = ph - PAGE_MARGIN - FOOTER_H;

    const table = state.rows.slice(0, ui.maxRows.value);
    const cols = Math.max(...table.map((r) => r.length));
    const header = table[0] ?? [];

    // Column widths start from the widest cell in each column, capped so one
    // long comment cannot squeeze every other column into nothing.
    const natural = new Array(cols).fill(MIN_COL_W);
    for (const row of table) {
      for (let c = 0; c < cols; c++) {
        const cell = row[c];
        if (!cell?.v) continue;
        const w = measure(cell.v, row === header, ROW_SIZE) + CELL_PAD * 2;
        natural[c] = Math.max(natural[c], Math.min(w, contentW * 0.55));
      }
    }

    // Either everything is squeezed onto one page width, or the columns keep
    // their natural width and continue on later pages — the same two choices
    // Excel's own print dialog offers.
    const bands = [];
    if (ui.fit.value) {
      const total = natural.reduce((a, b) => a + b, 0);
      const scale = contentW / total;
      bands.push({ from: 0, to: cols - 1, widths: natural.map((n) => n * scale) });
    } else {
      let from = 0;
      while (from < cols) {
        let to = from;
        let sum = natural[from];
        while (to + 1 < cols && sum + natural[to + 1] <= contentW) { to += 1; sum += natural[to]; }
        bands.push({ from, to, widths: natural.slice(from, to + 1) });
        from = to + 1;
      }
    }

    const pages = [];
    const marks = [];   // what each page shows, for the footers
    for (const [b, band] of bands.entries()) {
      let row = 1;                     // row 0 is the header
      let firstOfBand = true;
      do {
        const ops = [];
        let y = PAGE_MARGIN;
        const showHeader = firstOfBand || ui.repeat.value;
        if (showHeader && table.length) { drawRow(ops, header, band, y, true); y += ROW_H; }
        const room = Math.max(1, Math.floor((contentBottom - y) / ROW_H));
        const start = row;
        for (let k = 0; k < room && row < table.length; k++, row += 1) {
          drawRow(ops, table[row], band, y, false);
          y += ROW_H;
        }
        pages.push(ops);
        marks.push({ band: b, from: start, to: row - 1 });
        firstOfBand = false;
      } while (row < table.length);
    }

    // The footer needs the total, so it is written once every page exists.
    const sheetName = state.book?.sheets[state.sheetIndex]?.name ?? stem(state.file?.name ?? 'Sheet');
    pages.forEach((ops, i) => {
      const left = bands.length > 1
        ? `${sheetName} · columns ${colName(bands[marks[i].band].from)}–${colName(bands[marks[i].band].to)}`
        : sheetName;
      const right = `Page ${i + 1} of ${pages.length}`;
      const size = 8;
      ops.push({
        kind: 'text', x: PAGE_MARGIN, base: ph - PAGE_MARGIN + 6, size, color: FAINT,
        text: bank.safe(left, 'std', false, false), script: 'std', bold: false, italic: false,
      });
      ops.push({
        kind: 'text', x: pw - PAGE_MARGIN - bank.width(right, 'std', false, false, size),
        base: ph - PAGE_MARGIN + 6, size, color: FAINT,
        text: right, script: 'std', bold: false, italic: false,
      });
    });

    return { pages, pw, ph, bands, rows: table.length, cols, truncated: state.rows.length - table.length };

    // ---- one row of cells ------------------------------------------------
    function drawRow(ops, row, band, top, isHeader) {
      const width = band.widths.reduce((a, b) => a + b, 0);
      if (isHeader) ops.push({ kind: 'rect', x: PAGE_MARGIN, top, w: width, h: ROW_H, fill: HEAD_TINT });

      let x = PAGE_MARGIN;
      for (let c = band.from; c <= band.to; c++) {
        const w = band.widths[c - band.from];
        const cell = row?.[c];
        if (cell?.v) {
          const avail = w - CELL_PAD * 2;
          const fitted = fit(cell.v, isHeader, avail);
          // Numbers right, words left — the convention that makes a column of
          // marks readable at a glance.
          const tx = cell.num && !isHeader ? x + w - CELL_PAD - fitted.width : x + CELL_PAD;
          ops.push({
            kind: 'text', x: tx, base: top + ROW_H / 2 + fitted.size * 0.34,
            size: fitted.size, text: fitted.text, script: fitted.script,
            bold: isHeader, italic: false, color: INK,
          });
        }
        if (ui.grid.value) {
          ops.push({ kind: 'line', x1: x, y1: top, x2: x, y2: top + ROW_H, thickness: 0.5, color: RULE });
        }
        x += w;
      }
      if (ui.grid.value) {
        ops.push({ kind: 'line', x1: x, y1: top, x2: x, y2: top + ROW_H, thickness: 0.5, color: RULE });
        ops.push({ kind: 'line', x1: PAGE_MARGIN, y1: top, x2: PAGE_MARGIN + width, y2: top, thickness: 0.5, color: RULE });
        ops.push({ kind: 'line', x1: PAGE_MARGIN, y1: top + ROW_H, x2: PAGE_MARGIN + width, y2: top + ROW_H, thickness: 0.5, color: RULE });
      } else if (isHeader) {
        // With the grid off the header still needs a rule, or the table has no
        // visible top edge at all.
        ops.push({ kind: 'line', x1: PAGE_MARGIN, y1: top + ROW_H, x2: PAGE_MARGIN + width, y2: top + ROW_H, thickness: 0.8, color: RULE });
      }
    }

    /** A cell is one line: shrink it a little, and clip it only if it must. */
    function fit(value, bold, avail) {
      const script = scriptOf(value);
      const text = bank.safe(value, script, bold, false);
      let width = bank.width(text, script, bold, false, ROW_SIZE);
      if (width <= avail) return { text, size: ROW_SIZE, width, script };

      const shrunk = Math.max(MIN_TEXT, ROW_SIZE * (avail / width));
      width = bank.width(text, script, bold, false, shrunk);
      if (width <= avail) return { text, size: shrunk, width, script };

      // Still too long even at 6 pt: cut it and say so with an ellipsis, which
      // is honest, rather than letting it run into the next column.
      let cut = text;
      while (cut.length > 1 && bank.width(`${cut}…`, script, bold, false, shrunk) > avail) {
        cut = cut.slice(0, -1);
      }
      const out = `${cut}…`;
      return { text: out, size: shrunk, width: bank.width(out, script, bold, false, shrunk), script };
    }

    function measure(value, bold, size) {
      const script = scriptOf(value);
      return bank.width(bank.safe(value, script, bold, false), script, bold, false, size);
    }
  }

  function scriptOf(text) {
    const found = scriptsUsed(text, new Set());
    return found.has('thai') ? 'thai' : found.has('myanmar') ? 'myanmar' : 'std';
  }

  /** 0 → "A", 27 → "AB" — for naming which columns a page carries. */
  function colName(i) {
    let n = i + 1;
    let out = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - r) / 26);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Preview + sidebar
  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    state.plan = buildPlan();

    if (!state.plan) {
      ui.explain.set('');
      ui.warn.hide();
      paint();
      return;
    }

    const { pages, bands, rows, cols, truncated } = state.plan;
    const sheet = state.book?.sheets[state.sheetIndex]?.name;
    ui.explain.set(
      `${sheet ? `${sheet}: ` : ''}${rows} row${rows === 1 ? '' : 's'} × ${cols} column${cols === 1 ? '' : 's'} ` +
      `on ${pages.length} ${ui.orient.value} page${pages.length === 1 ? '' : 's'}` +
      `${bands.length > 1 ? `, the columns continuing across ${bands.length} sets of pages` : ''}.`,
    );

    const problems = [];
    if (truncated > 0) {
      problems.push(`${truncated.toLocaleString()} more row${truncated === 1 ? '' : 's'} in this sheet ${truncated === 1 ? 'is' : 'are'} not printed — raise "Maximum rows" if you need ${truncated === 1 ? 'it' : 'them'}.`);
    }
    const missing = [...(state.bank?.missing ?? [])].slice(0, 6).join(' ');
    if (missing) {
      problems.push(`UniLab ships fonts for English, Thai and Burmese only, so these characters are written as "?": ${missing}`);
    }
    if (problems.length) { ui.warn.set(problems.join(' ')); ui.warn.hide(false); }
    else ui.warn.hide();

    paint();
  }

  function paint() {
    if (!pane) return;
    pane.pages.innerHTML = '';
    const plan = state.plan;
    if (!plan) {
      // The hint set while reading stays put; an empty plan after that means the
      // shell is already showing why.
      pane.hint.textContent = '';
      return;
    }
    pane.hint.textContent = `${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} · ${plan.rows.toLocaleString()} rows`;
    const shown = plan.pages.slice(0, MAX_PREVIEW_PAGES);
    const scale = plan.pw > plan.ph ? 0.4 : 0.46;
    for (const [i, ops] of shown.entries()) {
      pane.pages.appendChild(captionedPage(previewPage(ops, { w: plan.pw, h: plan.ph, scale }), `Page ${i + 1}`));
    }
    if (plan.pages.length > shown.length) {
      pane.pages.appendChild(el(`<p class="ts__hint" style="align-self:center;margin:0;">…and ${plan.pages.length - shown.length} more pages, all of them in the PDF.</p>`));
    }
  }
}
