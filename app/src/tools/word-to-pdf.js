import { PDFDocument } from 'pdf-lib';
import { el, formatBytes, stem } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, selectField,
} from '../option-ui.js';
import {
  FontBank, MARGIN_PRESETS, PAGE_SIZES, captionedPage, drawOps, previewPage,
  previewStrip, scriptsUsed, wrapRuns,
} from '../office-text.js';

// A .docx is a ZIP of XML, and mammoth is very good at the hard half of the job:
// pulling *semantic* HTML out of it — headings that are headings, lists that are
// lists, tables that are tables — instead of the pile of styled spans Word's own
// HTML export produces. What it does not do is decide where page 2 starts, so
// everything below that point is ours: flow the parsed blocks onto a page, wrap
// each line against the real font metrics, and start a new page when the next
// line would fall past the bottom margin.
//
// The tempting shortcut — render the HTML in a hidden div and screenshot it — is
// deliberately not taken. It produces a PDF that is one fuzzy image per page:
// nothing is selectable, nothing is searchable, a marker cannot leave a comment
// on it, and it weighs five times as much. Laying it out by hand keeps real text
// in the file.

const HEADING_SCALE = [1.9, 1.55, 1.3, 1.12];   // h1 … h4, × the base size
const LINE_HEIGHT = 1.45;
const ASCENT = 0.95;          // baseline position inside a line box, × size
const PARA_GAP = 0.55;        // × base size
const HEADING_BEFORE = 0.9;
const HEADING_AFTER = 0.3;
const LIST_INDENT = 20;       // points per nesting level
const CELL_PAD = 5;
const TABLE_GAP = 8;
const IMAGE_GAP = 8;

const INK = '#1a1a1a';
const LINK = '#1a5fb4';
const RULE = '#c3c9d2';
const HEAD_TINT = '#eef1f6';

// Word images are stored at 96 dpi; a PDF point is 1/72 inch.
const PX_TO_PT = 0.75;

const MAX_PREVIEW_PAGES = 40;
const MAX_IMAGES = 80;        // a photo-essay of 300 pictures is not a report

const SIZE_CHOICES = [9, 10, 11, 12, 14].map((n) => ({ id: String(n), label: `${n} pt` }));

export default function render(container, tool) {
  const state = {
    file: null,
    blocks: [],
    stats: null,
    pages: [],          // [[op, …], …] — the laid-out document
    bank: null,         // measuring FontBank, on a throwaway PDFDocument
    scripts: [],
    imageMeta: new Map(),   // data URI → { w, h } in points
    dropped: 0,             // pictures the browser could not decode
    skipped: 0,             // pictures past the cap below
  };
  const ui = {};
  let pane = null;

  toolShell(container, tool, {
    accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    multiple: false,
    pickLabel: 'Select a Word file',
    dropLabel: 'or drop a .docx here',
    actionLabel: 'Convert to PDF',
    doneTitle: 'Your PDF is ready!',
    downloadLabel: 'Download PDF',
    continueTo: ['compress-pdf', 'merge-pdf', 'page-numbers-pdf'],
    note: 'Hand this in rather than the .docx and the marker sees exactly the layout you see here — no missing font, no "this file is not supported", no Google Docs reflow. Keep the .docx too: this is a one-way trip.',

    // The whole point of the left pane: the finished pages, at the size and
    // margins currently chosen, so the page count is a fact before you export
    // rather than a surprise afterwards.
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
      const panel = optionPanel('Word to PDF');

      ui.facts = fileFacts();
      ui.about = infoBox('Headings, lists, tables, bold, italic, underline and pictures all carry over as real text you can select and search. Word\'s own page breaks, columns, text boxes, headers and footers do not — the words are laid out fresh onto the page you choose here, so line and page breaks will not match Word exactly. Web links keep their blue underline but stop being clickable.');
      ui.warn = infoBox('');
      ui.warn.root.classList.add('opt__info--bad');
      ui.warn.hide();

      ui.pageSize = selectField('Page size', [
        { id: 'a4', label: PAGE_SIZES.a4.label },
        { id: 'letter', label: PAGE_SIZES.letter.label },
      ], { value: 'a4', onChange: update });

      ui.margin = selectField('Margins', [
        { id: 'narrow', label: MARGIN_PRESETS.narrow.label },
        { id: 'normal', label: MARGIN_PRESETS.normal.label },
        { id: 'wide', label: MARGIN_PRESETS.wide.label },
      ], { value: 'normal', onChange: update });

      ui.base = selectField('Body text size', SIZE_CHOICES, {
        value: '11',
        hint: 'Headings scale up from this. 11 pt is what most Thai universities ask for.',
        onChange: update,
      });

      ui.numbers = checkRow('Add page numbers', {
        checked: false,
        hint: 'A plain number, centred at the foot of every page.',
        onChange: update,
      });

      ui.explain = liveExplain();

      panel.add(ui.facts, ui.about, ui.pageSize, ui.margin, ui.base, ui.numbers, ui.warn, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.blocks.length) throw new Error('There is nothing to convert yet — choose a .docx file first.');
      if (!state.pages.length) throw new Error('That document came out empty. Open it in Word and check there is text in it, not just pictures in text boxes.');

      const doc = await PDFDocument.create();
      const bank = new FontBank(doc);
      ctx.setBusy(0.04, 'Preparing fonts…');
      await bank.prepare(state.scripts);

      // Every distinct picture is embedded once, however many times it appears.
      const images = new Map();
      const srcs = [...new Set(state.pages.flat().filter((o) => o.kind === 'image').map((o) => o.src))];
      for (const [i, src] of srcs.entries()) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.05 + (i / srcs.length) * 0.25, `Adding picture ${i + 1} of ${srcs.length}…`);
        try {
          images.set(src, await embedImage(doc, src));
        } catch {
          // Already decoded once during the preview, so this is rare — but a
          // single awkward picture must not lose the whole conversion.
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const size = PAGE_SIZES[ui.pageSize.value];
      for (const [i, ops] of state.pages.entries()) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.3 + (i / state.pages.length) * 0.68, `Drawing page ${i + 1} of ${state.pages.length}…`);
        const page = doc.addPage([size.w, size.h]);
        drawOps(page, ops.map((op) => (op.kind === 'image' ? { ...op, img: images.get(op.src) } : op)), bank);
        // Yield between pages: a 90-page thesis must not freeze the tab, and
        // setTimeout keeps running when the tab is in the background.
        await new Promise((r) => setTimeout(r, 0));
      }

      ctx.setBusy(0.99, 'Saving…');
      const bytes = await doc.save();
      return {
        outputs: [{
          name: `${stem(state.file.name)}.pdf`,
          blob: new Blob([bytes], { type: 'application/pdf' }),
        }],
        doneTitle: `Your ${state.pages.length}-page PDF is ready!`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Reading the .docx
  // -------------------------------------------------------------------------

  async function loadFile() {
    // Whatever happens below — a good document, an old .doc, a half-downloaded
    // file — the preview has to end up showing this file and not the last one.
    try {
      await readFile();
    } finally {
      update();
    }
  }

  async function readFile() {
    const file = state.file;
    reset();
    if (!file) return;

    if (/\.docx?$/i.test(file.name) && !/\.docx$/i.test(file.name)) {
      throw new Error('This is an old .doc file, and no browser can read that format. Open it in Word or Google Docs and use "Save as .docx", then come back.');
    }

    if (pane) pane.hint.textContent = 'Reading the document…';

    // mammoth is a big module and only this tool needs it, so it arrives when a
    // file does rather than in the app's first download.
    let mammoth;
    try {
      const mod = await import('mammoth');
      mammoth = mod.default ?? mod;
    } catch {
      throw new Error('The Word reader could not be loaded. Check your connection and open this tool again.');
    }

    let html;
    try {
      html = (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value;
    } catch (err) {
      throw new Error(`That file could not be opened as a Word document (${err.message}). If it came from LINE or Gmail, download it again — half-downloaded files fail exactly like this.`);
    }

    state.blocks = blocksFromHtml(html);
    await measureImages();

    // Only the scripts actually present get a font embedded, so an English
    // essay never downloads Noto Sans Thai.
    const seen = new Set();
    for (const text of allText(state.blocks)) scriptsUsed(text, seen);
    state.scripts = [...seen];

    const scratch = await PDFDocument.create();
    state.bank = new FontBank(scratch);
    await state.bank.prepare(state.scripts);

    state.stats = summarise(state.blocks);
    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Words', state.stats.words.toLocaleString()],
      ['Pictures', String(state.stats.images)],
      ['Tables', String(state.stats.tables)],
    ]);
  }

  function reset() {
    state.blocks = [];
    state.pages = [];
    state.stats = null;
    state.bank = null;
    state.scripts = [];
    state.imageMeta.clear();
    state.dropped = 0;
    state.skipped = 0;
    ui.facts?.set([]);
  }

  /** mammoth's HTML → a flat list of blocks we know how to lay out. */
  function blocksFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    walk(doc.body, out, 0);
    return out;
  }

  function walk(parent, out, listLevel) {
    for (const node of parent.children) {
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = Math.min(4, Number(tag[1]));
        emit(piecesOf(node, { bold: true }), out, { kind: 'heading', level });
      } else if (tag === 'p') {
        emit(piecesOf(node, {}), out, { kind: 'para' });
      } else if (tag === 'ul' || tag === 'ol') {
        walkList(node, tag === 'ol', listLevel, out);
      } else if (tag === 'table') {
        const table = readTable(node);
        if (table) out.push(table);
      } else if (tag === 'img') {
        out.push({ kind: 'image', src: node.getAttribute('src') });
      } else if (tag === 'blockquote') {
        // A quotation keeps its indent, because that is the whole visual point
        // of one in an essay.
        const inner = [];
        walk(node, inner, listLevel);
        for (const b of inner) out.push({ ...b, indent: (b.indent ?? 0) + LIST_INDENT });
      } else {
        walk(node, out, listLevel);
      }
    }
  }

  function walkList(list, ordered, level, out) {
    let n = 1;
    for (const li of list.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const nested = [];
      const pieces = piecesOf(li, {}, nested);
      const marker = ordered ? `${n}.` : '•';
      emit(pieces, out, { kind: 'li', marker, indent: LIST_INDENT * (level + 1) });
      n += 1;
      // A nested list is laid out after its parent item, one indent deeper.
      for (const sub of nested) walkList(sub, sub.tagName.toLowerCase() === 'ol', level + 1, out);
    }
  }

  /**
   * Flattens an element into styled pieces. Images and <br> come back as their
   * own pieces so the caller can turn them into their own blocks — a picture in
   * the middle of a paragraph has to interrupt the text flow, not sit inside a
   * line.
   */
  function piecesOf(node, style, nestedLists = null, out = []) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        // Word writes a lot of incidental whitespace; HTML rules collapse it.
        const text = child.nodeValue.replace(/\s+/g, ' ');
        if (text) out.push({ type: 'run', text, ...style });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { out.push({ type: 'break' }); continue; }
      if (tag === 'img') { out.push({ type: 'image', src: child.getAttribute('src') }); continue; }
      if ((tag === 'ul' || tag === 'ol') && nestedLists) { nestedLists.push(child); continue; }

      const next = { ...style };
      if (tag === 'strong' || tag === 'b') next.bold = true;
      if (tag === 'em' || tag === 'i') next.italic = true;
      if (tag === 'u' || tag === 'ins') next.underline = true;
      if (tag === 'a') { next.color = LINK; next.underline = true; }
      if (tag === 'sup' || tag === 'sub') next.small = true;
      piecesOf(child, next, nestedLists, out);
    }
    return out;
  }

  /** Pieces → blocks, splitting at pictures and hard line breaks. */
  function emit(pieces, out, base) {
    let runs = [];
    let first = true;
    const flush = () => {
      const trimmed = trimRuns(runs);
      if (trimmed.length) {
        out.push(first ? { ...base, runs: trimmed } : { kind: 'para', runs: trimmed, indent: base.indent ?? 0, tight: true });
        first = false;
      }
      runs = [];
    };
    for (const p of pieces) {
      if (p.type === 'run') { runs.push(p); continue; }
      flush();
      if (p.type === 'image') out.push({ kind: 'image', src: p.src });
    }
    flush();
    // An empty paragraph in Word is a deliberate blank line, so it keeps its space.
    if (first && base.kind === 'para' && pieces.length === 0) out.push({ kind: 'blank' });
  }

  function trimRuns(runs) {
    const copy = runs.map((r) => ({ ...r }));
    if (copy.length) copy[0].text = copy[0].text.replace(/^\s+/, '');
    if (copy.length) copy.at(-1).text = copy.at(-1).text.replace(/\s+$/, '');
    return copy.filter((r) => r.text);
  }

  function readTable(node) {
    const rows = [];
    for (const tr of node.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.children) {
        const tag = cell.tagName.toLowerCase();
        if (tag !== 'td' && tag !== 'th') continue;
        const pieces = piecesOf(cell, {}).filter((p) => p.type === 'run');
        cells.push({ runs: trimRuns(pieces), header: tag === 'th' });
      }
      if (cells.length) rows.push(cells);
    }
    return rows.length ? { kind: 'table', rows } : null;
  }

  /**
   * Pictures have to be decoded before they can be laid out — the .docx knows
   * their size in EMUs, but mammoth hands us a data URI and nothing else.
   */
  async function measureImages() {
    const srcs = [...new Set(state.blocks.filter((b) => b.kind === 'image').map((b) => b.src))];
    let used = 0;
    for (const src of srcs) {
      if (!src) continue;
      if (used >= MAX_IMAGES) { state.skipped += 1; continue; }
      try {
        const img = new Image();
        img.src = src;
        await img.decode();
        state.imageMeta.set(src, { w: img.naturalWidth * PX_TO_PT, h: img.naturalHeight * PX_TO_PT });
        used += 1;
      } catch {
        // Word charts and drawings are stored as EMF/WMF, which no browser can
        // decode. Counting them is more honest than a blank space.
        state.dropped += 1;
      }
    }
    state.blocks = state.blocks.filter((b) => b.kind !== 'image' || state.imageMeta.has(b.src));
  }

  function* allText(blocks) {
    for (const b of blocks) {
      for (const r of b.runs ?? []) yield r.text;
      for (const row of b.rows ?? []) for (const cell of row) for (const r of cell.runs) yield r.text;
    }
  }

  function summarise(blocks) {
    let words = 0;
    let images = 0;
    let tables = 0;
    for (const b of blocks) {
      if (b.kind === 'image') { images += 1; continue; }
      if (b.kind === 'table') tables += 1;
      for (const t of textOf(b)) words += (t.match(/[^\s]+/g) ?? []).length;
    }
    return { words, images, tables };
  }

  function* textOf(block) {
    for (const r of block.runs ?? []) yield r.text;
    for (const row of block.rows ?? []) for (const cell of row) for (const r of cell.runs) yield r.text;
  }

  // -------------------------------------------------------------------------
  // Layout — the same pass feeds the preview and the export
  // -------------------------------------------------------------------------

  function layout() {
    const bank = state.bank;
    if (!bank || !state.blocks.length) return [];

    const page = PAGE_SIZES[ui.pageSize.value];
    const margin = MARGIN_PRESETS[ui.margin.value].v;
    const baseSize = Number(ui.base.value);
    const contentW = page.w - margin * 2;
    const footer = ui.numbers.value ? 22 : 0;
    const bottom = page.h - margin - footer;

    const pages = [];
    let ops = [];
    let y = margin;
    pages.push(ops);
    const newPage = () => { ops = []; pages.push(ops); y = margin; };

    /** Draws already-wrapped lines and moves the cursor down past them. */
    const drawLines = (lines, x, { gapAfter = 0 } = {}) => {
      for (const line of lines) {
        const size = Math.max(...line.map((p) => p.size));
        const lineH = size * LINE_HEIGHT;
        if (y + lineH > bottom && ops.length) newPage();
        let cursor = x;
        for (const piece of line) {
          const base = y + size * ASCENT;
          ops.push({
            kind: 'text', x: cursor, base, size: piece.size, text: piece.text,
            script: piece.script, bold: !!piece.bold, italic: !!piece.italic,
            color: piece.color ?? INK,
          });
          if (piece.underline) {
            ops.push({
              kind: 'line', x1: cursor, y1: base + piece.size * 0.13,
              x2: cursor + piece.width, y2: base + piece.size * 0.13,
              thickness: Math.max(0.4, piece.size * 0.05), color: piece.color ?? INK,
            });
          }
          cursor += piece.width;
        }
        y += lineH;
      }
      y += gapAfter;
    };

    /** Styled runs → wrapped, measured, script-split lines. */
    const wrap = (runs, width, size, { bold = false } = {}) => wrapRuns(
      runs.map((r) => ({
        text: r.text,
        bold: !!(r.bold || bold),
        italic: !!r.italic,
        underline: !!r.underline,
        color: r.color ?? INK,
        size: r.small ? size * 0.75 : size,
      })),
      width,
      (p) => bank.width(bank.safe(p.text, p.script, p.bold, p.italic), p.script, p.bold, p.italic, p.size),
    ).map((line) => line.map((p) => ({ ...p, text: bank.safe(p.text, p.script, p.bold, p.italic) })));

    for (const block of state.blocks) {
      const indent = block.indent ?? 0;
      const x = margin + indent;
      const width = contentW - indent;

      if (block.kind === 'blank') { y += baseSize * LINE_HEIGHT; continue; }

      if (block.kind === 'heading') {
        const size = baseSize * HEADING_SCALE[block.level - 1];
        if (ops.length) y += baseSize * HEADING_BEFORE;
        const lines = wrap(block.runs, width, size, { bold: true });
        // A heading alone at the foot of a page is worse than a shorter page.
        if (y + size * LINE_HEIGHT * Math.min(2, lines.length + 1) > bottom && ops.length) newPage();
        drawLines(lines, x, { gapAfter: baseSize * HEADING_AFTER });
        continue;
      }

      if (block.kind === 'para') {
        drawLines(wrap(block.runs, width, baseSize), x, { gapAfter: block.tight ? 0 : baseSize * PARA_GAP });
        continue;
      }

      if (block.kind === 'li') {
        const lines = wrap(block.runs, width, baseSize);
        if (lines.length) {
          // The bullet hangs in the margin of the item, level with its first
          // line, the way every word processor sets a list.
          const size = baseSize;
          if (y + size * LINE_HEIGHT > bottom && ops.length) newPage();
          ops.push({
            kind: 'text', x: Math.max(margin, x - 14), base: y + size * ASCENT,
            size, text: block.marker, script: 'std', bold: false, italic: false, color: INK,
          });
        }
        drawLines(lines, x, { gapAfter: baseSize * 0.18 });
        continue;
      }

      if (block.kind === 'image') {
        const meta = state.imageMeta.get(block.src);
        if (!meta) continue;
        let w = meta.w;
        let h = meta.h;
        const fit = Math.min(1, width / w, (bottom - margin) / h);
        w *= fit; h *= fit;
        if (y + h > bottom && ops.length) newPage();
        ops.push({ kind: 'image', x, top: y, w, h, src: block.src });
        y += h + IMAGE_GAP;
        continue;
      }

      if (block.kind === 'table') layoutTable(block, x, width);
    }

    // A document that ends exactly on a page boundary leaves one empty page
    // behind; nobody wants to print that. This has to happen before the page
    // numbers go on, or the number is itself content and the blank page stays.
    while (pages.length > 1 && !pages.at(-1).length) pages.pop();
    if (pages.length === 1 && !pages[0].length) return [];

    if (ui.numbers.value) {
      pages.forEach((pageOps, i) => {
        const label = String(i + 1);
        const size = 9;
        pageOps.push({
          kind: 'text', size, text: label, script: 'std', bold: false, italic: false,
          color: '#666c76',
          x: (page.w - bank.width(label, 'std', false, false, size)) / 2,
          base: page.h - Math.max(20, margin * 0.5),
        });
      });
    }

    return pages;

    // ---- tables ----------------------------------------------------------
    function layoutTable(block, x, width) {
      const size = baseSize * 0.94;
      const cols = Math.max(...block.rows.map((r) => r.length));
      const widths = tableWidths(block, cols, width, size);

      // A table that continues onto the next page repeats its header row,
      // because a column of numbers with no headings is unreadable.
      const headerRow = block.rows[0]?.some((c) => c.header) ? block.rows[0] : null;
      y += TABLE_GAP;

      const rowLines = (row) => row.map((cell, i) => wrap(cell.runs, Math.max(size, widths[i] - CELL_PAD * 2), size, { bold: cell.header }));
      const rowHeight = (lines) => Math.max(size * LINE_HEIGHT, ...lines.map((l) => Math.max(1, l.length) * size * LINE_HEIGHT)) + CELL_PAD * 2;

      const drawRow = (row, lines, height, isHeader) => {
        if (isHeader) ops.push({ kind: 'rect', x, top: y, w: widths.reduce((a, b) => a + b, 0), h: height, fill: HEAD_TINT });
        let cx = x;
        row.forEach((cell, i) => {
          let cy = y + CELL_PAD;
          for (const line of lines[i]) {
            let tx = cx + CELL_PAD;
            for (const piece of line) {
              ops.push({
                kind: 'text', x: tx, base: cy + size * ASCENT, size: piece.size, text: piece.text,
                script: piece.script, bold: !!piece.bold, italic: !!piece.italic, color: piece.color ?? INK,
              });
              tx += piece.width;
            }
            cy += size * LINE_HEIGHT;
          }
          cx += widths[i];
        });
        // Grid: one box per row plus the vertical rules between columns.
        const total = widths.reduce((a, b) => a + b, 0);
        ops.push({ kind: 'line', x1: x, y1: y, x2: x + total, y2: y, thickness: 0.5, color: RULE });
        ops.push({ kind: 'line', x1: x, y1: y + height, x2: x + total, y2: y + height, thickness: 0.5, color: RULE });
        let vx = x;
        for (let i = 0; i <= widths.length; i++) {
          ops.push({ kind: 'line', x1: vx, y1: y, x2: vx, y2: y + height, thickness: 0.5, color: RULE });
          vx += widths[i] ?? 0;
        }
        y += height;
      };

      let headerHeight = 0;
      let headerLines = null;
      if (headerRow) { headerLines = rowLines(headerRow); headerHeight = rowHeight(headerLines); }

      for (const [i, row] of block.rows.entries()) {
        const isHeader = headerRow && i === 0;
        const lines = isHeader ? headerLines : rowLines(row);
        const height = isHeader ? headerHeight : rowHeight(lines);
        if (y + height > bottom && ops.length) {
          newPage();
          if (headerRow && !isHeader) drawRow(headerRow, headerLines, headerHeight, true);
        }
        drawRow(row, lines, height, !!isHeader);
      }
      y += TABLE_GAP;
    }

    /** Column widths proportional to the widest cell, capped so one long
     *  sentence cannot squeeze every other column to nothing. */
    function tableWidths(block, cols, width, size) {
      const natural = new Array(cols).fill(size * 3);
      for (const row of block.rows) {
        row.forEach((cell, i) => {
          if (i >= cols) return;
          const text = cell.runs.map((r) => r.text).join('');
          const script = scriptOf(text);
          const w = bank.width(bank.safe(text, script, false, false), script, false, false, size) + CELL_PAD * 2;
          natural[i] = Math.max(natural[i], Math.min(w, width * 0.5));
        });
      }
      const total = natural.reduce((a, b) => a + b, 0);
      return natural.map((n) => (n / total) * width);
    }

    function scriptOf(text) {
      const found = scriptsUsed(text, new Set());
      return found.has('thai') ? 'thai' : found.has('myanmar') ? 'myanmar' : 'std';
    }
  }

  // -------------------------------------------------------------------------
  // Preview + sidebar
  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    if (!state.blocks.length) {
      state.pages = [];
      ui.explain.set('');
      ui.warn.hide();
      paint();
      return;
    }

    state.pages = layout();

    const n = state.pages.length;
    const size = PAGE_SIZES[ui.pageSize.value];
    ui.explain.set(
      `This document will become a ${n}-page ${size === PAGE_SIZES.a4 ? 'A4' : 'Letter'} PDF with selectable text` +
      `${ui.numbers.value ? ', numbered at the foot of each page' : ''}.`,
    );

    const problems = [];
    if (state.dropped) {
      problems.push(`${state.dropped} picture${state.dropped === 1 ? '' : 's'} in this file ${state.dropped === 1 ? 'is a Word drawing or chart' : 'are Word drawings or charts'} that browsers cannot read, so ${state.dropped === 1 ? 'it was' : 'they were'} left out. Screenshot ${state.dropped === 1 ? 'it' : 'them'} and use Image to PDF if you need ${state.dropped === 1 ? 'it' : 'them'}.`);
    }
    const missing = [...(state.bank?.missing ?? [])].slice(0, 6).join(' ');
    if (state.skipped) {
      problems.push(`This file has more than ${MAX_IMAGES} pictures in it. Only the first ${MAX_IMAGES} are included; ${state.skipped.toLocaleString()} more ${state.skipped === 1 ? 'was' : 'were'} left out to keep the PDF a size you can actually send.`);
    }
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
    if (!state.pages.length) {
      // The explicit hint set while reading stays; an empty result after that
      // means the shell is already showing why.
      pane.hint.textContent = '';
      return;
    }
    const size = PAGE_SIZES[ui.pageSize.value];
    const shown = state.pages.slice(0, MAX_PREVIEW_PAGES);
    pane.hint.textContent = `${state.pages.length} page${state.pages.length === 1 ? '' : 's'} · ${state.stats.words.toLocaleString()} words`;
    for (const [i, ops] of shown.entries()) {
      pane.pages.appendChild(captionedPage(previewPage(ops, { w: size.w, h: size.h, scale: 0.44 }), `Page ${i + 1}`));
    }
    if (state.pages.length > shown.length) {
      pane.pages.appendChild(el(`<p class="ts__hint" style="align-self:center;margin:0;">…and ${state.pages.length - shown.length} more pages, all of them in the PDF.</p>`));
    }
  }

  // -------------------------------------------------------------------------

  async function embedImage(doc, src) {
    if (/^data:image\/png/i.test(src)) return doc.embedPng(src);
    if (/^data:image\/jpe?g/i.test(src)) return doc.embedJpg(src);
    // GIF, BMP and WebP are not PDF image formats, so anything the browser can
    // decode is repainted as a PNG on the way through.
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return doc.embedPng(await blob.arrayBuffer());
  }
}
