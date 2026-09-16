import { OPS } from 'pdfjs-dist';
import JSZip from 'jszip';
import { canvasToBlob, downloadBlob, el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, numberField, optionPanel, selectField,
} from '../option-ui.js';

// A PDF has no paragraphs, no headings and no lists. It has glyphs at
// coordinates. Everything below is the work of guessing the structure back out
// of those coordinates: which runs share a line, which lines share a paragraph,
// which font size means "heading", which columns line up well enough to be a
// table. The guesses are all local and cheap, which is what lets the preview
// rebuild on every option change instead of after a long wait.

const MAX_PAGES = 200;        // a 900-page textbook is not a set of lecture notes
const MAX_THUMBS = 24;
const WORD_GAP = 0.24;        // × font size — a gap this wide means "space"
const COLUMN_GAP = 1.5;       // × font size — a gap this wide means "next column"
const TABLE_MIN_COLS = 3;
const TABLE_MIN_ROWS = 3;
const MIN_FIGURE_PX = 48;     // below this an "image" is a rule or a bullet glyph
const HEADING_LEVELS = 4;

const BULLET_RE = /^[•▪◦‣∙·●○□◘*–—-]\s+(?=\S)/;
const NUMBER_RE = /^(\d{1,2})[.)]\s+(?=\S)/;

const IMAGE_CHOICES = [
  { id: 'skip', label: 'Skip images — text only' },
  { id: 'export', label: 'Export images to a ZIP' },
];

export default function render(container, tool) {
  const state = {
    file: null, pdf: null, pageCount: 0,
    parsed: new Map(),      // page number → { num, width, height, lines }
    figures: new Map(),     // page number → [{ id }] found by the operator scan
    scanned: new Set(),
    thumbs: new Map(),
    markdown: '', stats: null, busyNote: '',
  };
  const ui = {};
  let pane = null;
  let parseToken = 0;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a lecture PDF here',
    actionLabel: 'Convert to Markdown',
    doneTitle: 'Your Markdown is ready!',
    downloadLabel: 'Download Markdown',
    continueTo: ['ocr-pdf', 'split-pdf'],
    note: 'Paste the .md straight into Notion or drop it in your Obsidian vault — headings, lists and tables arrive as real headings, lists and tables. If the preview comes back empty the PDF is a photo of a page, not text: run OCR PDF on it first, then come back here.',

    // The left pane is the point of this tool: the Markdown you are about to get,
    // beside the pages it came from, updating as the switches move.
    workarea(host) {
      if (pane) return;
      const root = el(`<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;"></div>`);
      const thumbs = el(`<div style="display:flex;flex-direction:column;gap:10px;width:106px;flex:none;max-height:560px;overflow:auto;"></div>`);
      const right = el(`<div style="flex:1;min-width:250px;display:flex;flex-direction:column;gap:8px;"></div>`);
      const hint = el(`<p class="ts__hint" style="margin:0;"></p>`);
      const pre = el(`<pre style="margin:0;max-height:530px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:var(--ink);"></pre>`);
      right.append(hint, pre);
      root.append(thumbs, right);
      host.appendChild(root);
      pane = { thumbs, pre, hint };
      paintPreview();
    },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('PDF to Markdown');
      ui.facts = fileFacts();
      ui.about = infoBox(
        'A PDF stores letters at coordinates — it does not record what is a heading, a list or a table. All of that is worked out from where the text sits and how big it is set, so it is a good guess rather than a copy. Read the preview on the left before you download: that is exactly what the .md file will contain.',
      );
      ui.explain = liveExplain();

      // A page range, as two bounded numbers. Chapter 3 of a course pack is a
      // far more common ask than the whole 300-page pack.
      const rangeRow = el(`<div class="opt__row"></div>`);
      ui.from = numberField('from page', { value: 1, min: 1, max: 9999, onChange: onRangeChange });
      ui.to = numberField('to', { value: 1, min: 1, max: 9999, onChange: onRangeChange });
      rangeRow.append(ui.from.root, ui.to.root);
      const rangeField = el(`<div class="opt__field"><label class="opt__label">Pages to convert</label></div>`);
      rangeField.appendChild(rangeRow);

      ui.headings = checkRow('Detect headings', {
        checked: true,
        hint: 'Text set larger than the body becomes #, ## and ###.',
        onChange: update,
      });
      ui.tables = checkRow('Detect tables', {
        checked: true,
        hint: 'Rows of three or more aligned columns become a Markdown table.',
        onChange: update,
      });
      ui.links = checkRow('Keep links', { checked: true, onChange: update });
      ui.strip = checkRow('Strip repeated headers and footers', {
        checked: true,
        hint: 'Drops the course code and page number that repeat on every page.',
        onChange: update,
      });

      ui.images = selectField('Images in the PDF', IMAGE_CHOICES, {
        value: 'skip',
        onChange: () => { scheduleImageScan(); update(); },
      });

      panel.add(ui.facts, ui.about, rangeField, ui.headings, ui.tables, ui.links, ui.strip, ui.images, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.pdf) throw new Error('That PDF has not opened yet. Choose the file again, or pick a different one.');
      const { from, to } = range();

      ctx.setBusy(0, 'Reading the text layer…');
      await ensureParsed(from, to, ctx, (done, total) => {
        ctx.setBusy((done / total) * 0.4, `Reading page ${done} of ${total}…`);
      });

      const pages = pagesInRange(from, to);
      if (!pages.some((p) => p.lines.length)) {
        throw new Error('There is no text in these pages — this PDF is a picture of a page, not text. Run OCR PDF on it first, then come back here.');
      }

      // Images are decoded only now: the preview never needs the pixels, and a
      // lecture deck full of photos would make every switch feel slow.
      let figures = new Map();
      if (ui.images.value === 'export') {
        figures = await extractFigures(ctx, from, to);
      }

      ctx.setBusy(0.9, 'Writing the Markdown…');
      const built = buildDoc(pages, currentOptions(), figures);
      const base = stem(state.file.name);
      const mdName = `${base}-notes.md`;
      const outputs = [{
        name: mdName,
        blob: new Blob([built.markdown], { type: 'text/markdown;charset=utf-8' }),
      }];

      const shots = [...figures.values()].flat();
      if (shots.length) {
        const zip = new JSZip();
        for (const shot of shots) zip.file(`images/${shot.name}`, shot.blob);
        outputs.push({
          name: `${base}-images.zip`,
          blob: await zip.generateAsync({ type: 'blob' }),
        });
      }

      ctx.setBusy(1, 'Done');
      return {
        outputs,
        doneTitle: shots.length
          ? `Your Markdown and ${shots.length} image${shots.length === 1 ? '' : 's'} are ready!`
          : 'Your Markdown is ready!',
        downloadLabel: shots.length ? 'Download both files' : 'Download Markdown',
        zip: async () => {
          // One archive that unpacks and just works: the .md at the root, the
          // figures in images/ exactly where the links point.
          const bundle = new JSZip();
          bundle.file(mdName, built.markdown);
          for (const shot of shots) bundle.file(`images/${shot.name}`, shot.blob);
          downloadBlob(await bundle.generateAsync({ type: 'blob' }), `${base}-markdown.zip`);
        },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // loading

  async function loadFile() {
    state.parsed.clear();
    state.figures.clear();
    state.scanned.clear();
    state.thumbs.clear();
    state.markdown = '';
    state.stats = null;
    state.pdf = null;
    state.pageCount = 0;

    const file = state.file;
    if (!file) { ui.facts.set([]); update(); return; }

    try {
      state.pdf = await openPdf(file);
    } catch (err) {
      throw new Error(/password/i.test(err?.message ?? '')
        ? 'That PDF is password-protected. Open it with Unlock PDF first, then bring it back here.'
        : 'That file could not be opened as a PDF. If it came from a chat app, try downloading it again.');
    }
    state.pageCount = state.pdf.numPages;

    ui.from.setMax(state.pageCount);
    ui.to.setMax(state.pageCount);
    ui.from.value = 1;
    ui.to.value = Math.min(state.pageCount, MAX_PAGES);

    setFacts();

    const { from, to } = range();
    setNote(`Reading the text layer of ${to - from + 1} page${to - from ? 's' : ''}…`);
    await ensureParsed(from, to, null, (done, total) => {
      setNote(`Reading page ${done} of ${total}…`);
      // Let the preview grow as the pages arrive. A 200-page course pack takes a
      // few seconds to read, and watching it fill in beats staring at a blank box
      // — but rebuilding the whole document on every page would be quadratic, so
      // it refreshes early and then rarely.
      if (done === 3 || done === 12 || done % 40 === 0) update();
    });
    setNote('');
    setFacts();
    update();
    renderThumbs(from, to);
  }

  /**
   * "Text layer" is the fact that decides whether this tool can help at all, so
   * it sits beside the size and the page count rather than hiding in an error.
   */
  function setFacts() {
    const parsed = [...state.parsed.values()];
    const hasText = parsed.some((p) => p.lines.length);
    ui.facts.set([
      ['Original size', formatBytes(state.file.size)],
      ['Total pages', String(state.pageCount)],
      ['Text layer', parsed.length ? (hasText ? 'Found' : 'None — needs OCR') : 'Reading…'],
    ]);
  }

  /** The current page range, always inside the document and the parse cap. */
  function range() {
    const count = state.pageCount || 1;
    let from = Math.max(1, Math.min(ui.from?.value ?? 1, count));
    let to = Math.max(1, Math.min(ui.to?.value ?? count, count));
    if (to < from) [from, to] = [to, from];
    if (to - from + 1 > MAX_PAGES) to = from + MAX_PAGES - 1;
    return { from, to };
  }

  function pagesInRange(from, to) {
    const out = [];
    for (let n = from; n <= to; n++) {
      const rec = state.parsed.get(n);
      if (rec) out.push(rec);
    }
    return out;
  }

  // Typing "40" in the page box fires an onChange per keystroke, so re-parsing
  // has to wait a beat — the sentence and the preview update straight away from
  // whatever is already cached.
  let rangeTimer = null;
  function onRangeChange() {
    update();
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(async () => {
      if (!state.pdf) return;
      const { from, to } = range();
      const token = ++parseToken;
      setNote('Reading the text layer…');
      await ensureParsed(from, to, null, (done, total) => setNote(`Reading page ${done} of ${total}…`));
      if (token !== parseToken) return;
      setNote('');
      // range() quietly folds a backwards or over-long span back inside the
      // document and the 200-page cap. Once typing has settled, the two boxes
      // are snapped to what will really be converted, so the fields can never
      // claim a page the .md will not contain.
      if (ui.from.value !== from) ui.from.value = from;
      if (ui.to.value !== to) ui.to.value = to;
      await scanFigures(from, to);
      update();
      renderThumbs(from, to);
    }, 280);
  }

  async function ensureParsed(from, to, ctx, onProgress) {
    const missing = [];
    for (let n = from; n <= to; n++) if (!state.parsed.has(n)) missing.push(n);
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i++) {
      if (ctx?.signal?.aborted) throw new Error('canceled');
      const n = missing[i];
      try {
        state.parsed.set(n, await parsePage(state.pdf, n));
      } catch {
        // One unreadable page should not cost the other ninety-nine.
        state.parsed.set(n, { num: n, width: 612, height: 792, lines: [] });
      }
      onProgress?.(i + 1, missing.length);
      // Yield between pages so a long document never freezes the tab.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  function scheduleImageScan() {
    if (ui.images.value !== 'export') return;
    const { from, to } = range();
    scanFigures(from, to).then(update);
  }

  /**
   * Counts the images the range draws, without decoding any of them. It is what
   * lets the preview show the ![figure] lines you are going to get before you
   * commit to a slow decode.
   */
  async function scanFigures(from, to) {
    if (ui.images?.value !== 'export' || !state.pdf) return;
    for (let n = from; n <= to; n++) {
      if (state.scanned.has(n)) continue;
      state.scanned.add(n);
      try {
        const page = await state.pdf.getPage(n);
        const ops = await page.getOperatorList();
        const ids = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] === OPS.paintImageXObject) {
            const id = ops.argsArray[i]?.[0];
            if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
          }
        }
        state.figures.set(n, ids.map((id) => ({ id })));
      } catch {
        state.figures.set(n, []);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ---------------------------------------------------------------------------
  // preview

  function currentOptions() {
    return {
      headings: ui.headings?.value ?? true,
      tables: ui.tables?.value ?? true,
      links: ui.links?.value ?? true,
      stripRunning: ui.strip?.value ?? true,
      images: ui.images?.value ?? 'skip',
    };
  }

  function update() {
    if (!state.pdf) {
      state.markdown = '';
      state.stats = null;
      ui.explain?.set('');
      paintPreview();
      return;
    }
    const { from, to } = range();
    const pages = pagesInRange(from, to);
    const opts = currentOptions();

    // The preview names the figures the scan found; the real export renumbers
    // from the images that actually decoded, so the two can differ by a figure
    // or two on an unusual PDF. That is why the sentence says "up to".
    const preview = opts.images === 'export' ? previewFigures(from, to) : new Map();
    const built = buildDoc(pages, opts, preview);
    state.markdown = built.markdown;
    state.stats = built.stats;

    const s = built.stats;
    const span = from === to ? `Page ${from}` : `Pages ${from}–${to}`;
    if (!pages.length) {
      ui.explain?.set('Reading the pages…');
    } else if (!state.markdown.trim()) {
      ui.explain?.set('No text found on these pages — this looks like a scan. OCR PDF can add a text layer first.');
    } else {
      const bits = [`${s.words.toLocaleString()} words`];
      if (s.headings) bits.push(`${s.headings} heading${s.headings === 1 ? '' : 's'}`);
      if (s.lists) bits.push(`${s.lists} list item${s.lists === 1 ? '' : 's'}`);
      if (s.tables) bits.push(`${s.tables} table${s.tables === 1 ? '' : 's'}`);
      if (s.links) bits.push(`${s.links} link${s.links === 1 ? '' : 's'}`);
      if (s.images) bits.push(`up to ${s.images} image${s.images === 1 ? '' : 's'} in a ZIP`);
      ui.explain?.set(`${span} will become one Markdown file: ${bits.join(', ')}.`);
    }
    paintPreview();
  }

  function previewFigures(from, to) {
    const base = stem(state.file?.name ?? 'pdf');
    const map = new Map();
    for (let n = from; n <= to; n++) {
      const found = state.figures.get(n) ?? [];
      if (found.length) {
        map.set(n, found.map((_, k) => ({ name: `${base}-p${n}-fig${k + 1}.png` })));
      }
    }
    return map;
  }

  function setNote(text) {
    state.busyNote = text;
    if (pane) pane.hint.textContent = text || defaultHint();
  }

  function defaultHint() {
    if (!state.pdf) return '';
    const { from, to } = range();
    return from === to
      ? `Live preview of page ${from}. Everything below is what the .md file will contain.`
      : `Live preview of pages ${from}–${to}. Everything below is what the .md file will contain.`;
  }

  function paintPreview() {
    if (!pane) return;
    pane.hint.textContent = state.busyNote || defaultHint();
    pane.pre.textContent = state.markdown
      || (state.pdf ? 'Nothing readable on these pages yet.' : 'Choose a PDF to see its Markdown here.');
  }

  let thumbToken = 0;
  async function renderThumbs(from, to) {
    if (!pane || !state.pdf) return;
    const token = ++thumbToken;
    const wanted = [];
    for (let n = from; n <= to && wanted.length < MAX_THUMBS; n++) wanted.push(n);
    pane.thumbs.innerHTML = '';
    for (const n of wanted) {
      // A second range change while this one is still rendering must win, or the
      // strip ends up a mix of two page ranges — so the check comes before this
      // pass touches the DOM again, not only after a slow render.
      if (token !== thumbToken) return;
      const cell = el(`<div class="ts__page"><span class="ts__page__n"></span></div>`);
      cell.querySelector('.ts__page__n').textContent = String(n);
      pane.thumbs.appendChild(cell);
      let canvas = state.thumbs.get(n);
      if (!canvas) {
        try {
          canvas = await renderPage(state.pdf, n, 0.3);
          state.thumbs.set(n, canvas);
        } catch { continue; }
        if (token !== thumbToken) return;
        // Yield between pages so a long range never freezes the tab.
        await new Promise((r) => setTimeout(r, 0));
      }
      cell.prepend(cloneCanvas(canvas));
    }
    if (to - from + 1 > MAX_THUMBS) {
      pane.thumbs.appendChild(el(`<p class="ts__hint" style="margin:0;text-align:center;">…</p>`));
    }
  }

  function cloneCanvas(source) {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(source, 0, 0);
    return c;
  }

  // ---------------------------------------------------------------------------
  // images

  async function extractFigures(ctx, from, to) {
    const base = stem(state.file.name);
    const out = new Map();
    const total = to - from + 1;
    for (let n = from; n <= to; n++) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(0.4 + ((n - from) / total) * 0.5, `Pulling images out of page ${n}…`);
      const shots = [];
      try {
        const page = await state.pdf.getPage(n);
        const ops = await page.getOperatorList();
        const seen = new Set();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
          const id = ops.argsArray[i]?.[0];
          if (typeof id !== 'string' || seen.has(id)) continue;
          seen.add(id);
          const img = await readImageObject(page, id);
          const made = img && imageToFile(img);
          if (!made) continue;
          shots.push({
            name: `${base}-p${n}-fig${shots.length + 1}.${made.ext}`,
            blob: await made.toBlob(),
          });
        }
      } catch {
        // An image stream this build of pdf.js cannot decode is not a reason to
        // lose the notes — the text still exports.
      }
      if (shots.length) out.set(n, shots);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }

  /** pdf.js hands images over asynchronously; a stalled one must not wedge the export. */
  function readImageObject(page, id) {
    // Images shared between pages live in commonObjs under a "g_" id.
    const store = id.startsWith('g_') ? page.commonObjs : page.objs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value ?? null); } };
      const guard = setTimeout(() => finish(null), 5000);
      try { store.get(id, (value) => { clearTimeout(guard); finish(value); }); }
      catch { clearTimeout(guard); finish(null); }
    });
  }
}

// -----------------------------------------------------------------------------
// One page of a PDF → lines of positioned cells.

/** 3×2 matrix multiply — the same one pdf.js's own text layer uses. */
function mul(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

async function parsePage(pdf, num) {
  const page = await pdf.getPage(num);
  // Working in viewport space rather than raw PDF space means a page saved
  // sideways (a phone scan rotated in Preview) still reads top-to-bottom.
  const viewport = page.getViewport({ scale: 1 });
  const [content, annots] = await Promise.all([
    page.getTextContent(),
    page.getAnnotations().catch(() => []),
  ]);

  // A link annotation carries a rectangle, never the words inside it, so the
  // only way to keep [text](url) is to intersect each text run with each box.
  const links = [];
  for (const a of annots) {
    // Any annotation carrying a URL is a link for our purposes; checking the URL
    // rather than the subtype also catches the widget-shaped links some export
    // tools produce.
    const url = a.url ?? a.unsafeUrl;
    if (!url || !Array.isArray(a.rect) || !/^https?:|^mailto:/i.test(url)) continue;
    const [ax, ay] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [bx, by] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    links.push({
      url,
      x0: Math.min(ax, bx), x1: Math.max(ax, bx),
      y0: Math.min(ay, by), y1: Math.max(ay, by),
    });
  }

  const runs = [];
  for (const item of content.items) {
    if (item.type || !item.str || !item.str.trim()) continue;
    const t = mul(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]) || item.height || 10;
    const run = {
      text: item.str,
      x: t[4],
      y: t[5],
      width: item.width ?? 0,
      size,
    };
    run.url = linkAt(links, run);
    runs.push(run);
  }

  runs.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const lines = [];
  for (const run of runs) {
    const last = lines[lines.length - 1];
    // Two runs are on the same line when their baselines sit closer than half a
    // character height — loose enough for superscripts and mixed fonts, tight
    // enough not to weld two rows of a dense table together.
    if (last && Math.abs(run.y - last.y) <= Math.max(1.5, Math.min(run.size, last.size) * 0.5)) {
      last.runs.push(run);
    } else {
      lines.push({ y: run.y, runs: [run] });
    }
  }

  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.size = Math.max(...line.runs.map((r) => r.size));
    line.cells = buildCells(line.runs);
    line.x0 = line.cells.length ? line.cells[0].x : 0;
    line.text = line.cells.map((c) => c.text).join(' ').trim();
  }

  return {
    num,
    width: viewport.width,
    height: viewport.height,
    lines: lines.filter((l) => l.text),
  };
}

function linkAt(links, run) {
  if (!links.length) return null;
  const cx = run.x + run.width / 2;
  const cy = run.y - run.size * 0.35;   // the middle of the glyphs, not the baseline
  for (const l of links) {
    if (cx >= l.x0 && cx <= l.x1 && cy >= l.y0 && cy <= l.y1) return l.url;
  }
  return null;
}

/**
 * Runs → cells. A cell breaks on a gap wide enough to be a table column, or on
 * a change of link target, which is what makes `[title](url) — Author` come out
 * with the link ending in the right place.
 */
function buildCells(runs) {
  const cells = [];
  let cur = null;
  for (const run of runs) {
    const gap = cur ? run.x - cur.x1 : 0;
    if (!cur || gap > cur.size * COLUMN_GAP || cur.url !== (run.url ?? null)) {
      cur = { x: run.x, x1: run.x + run.width, text: run.text, url: run.url ?? null, size: run.size };
      cells.push(cur);
      continue;
    }
    if (gap > cur.size * WORD_GAP && !/\s$/.test(cur.text) && !/^\s/.test(run.text)) cur.text += ' ';
    cur.text += run.text;
    cur.x1 = run.x + run.width;
    cur.size = Math.max(cur.size, run.size);
  }
  for (const cell of cells) cell.text = cell.text.replace(/\s+/g, ' ').trim();
  return cells.filter((c) => c.text);
}

// -----------------------------------------------------------------------------
// Lines → Markdown.

function buildDoc(pages, opts, figures) {
  const stats = { headings: 0, lists: 0, tables: 0, links: 0, images: 0, words: 0 };
  if (!pages.length) return { markdown: '', stats };

  const body = modalSize(pages);
  const ladder = opts.headings ? headingLadder(pages, body) : [];
  const running = opts.stripRunning ? runningLines(pages) : new Set();
  const blocks = [];

  for (const page of pages) {
    const kept = page.lines.filter((line) => !running.has(runningKey(page, line)));
    const tol = Math.max(6, page.width * 0.02);
    const tables = opts.tables ? findTables(kept, tol) : [];
    const covered = new Map();
    for (const t of tables) for (let i = t.start; i <= t.end; i++) covered.set(i, t);

    let para = null;
    let list = null;
    let prev = null;

    const flushPara = () => { if (para !== null) { blocks.push(para); para = null; } };
    const flushList = () => { if (list) { blocks.push(list.join('\n')); list = null; } };
    const flush = () => { flushPara(); flushList(); };

    for (let i = 0; i < kept.length; i++) {
      const table = covered.get(i);
      if (table) {
        if (table.start === i) {
          flush();
          blocks.push(renderTable(kept.slice(table.start, table.end + 1), table.cols, tol, opts, stats));
          stats.tables++;
        }
        prev = kept[i];
        continue;
      }

      const line = kept[i];
      const text = lineMarkdown(line, opts, stats);
      if (!text) { prev = line; continue; }

      const level = headingLevel(line, ladder);
      if (level) {
        flush();
        blocks.push(`${'#'.repeat(level)} ${text}`);
        stats.headings++;
        prev = line;
        continue;
      }

      const bullet = asListItem(text);
      if (bullet) {
        flushPara();
        (list ??= []).push(bullet);
        stats.lists++;
        prev = line;
        continue;
      }

      // An unmarked line indented past the bullet it follows is the rest of that
      // bullet, not a new paragraph.
      if (list && prev && line.x0 > prev.x0 + line.size * 0.5 && line.y - prev.y < line.size * 2.2) {
        list[list.length - 1] += ` ${text}`;
        prev = line;
        continue;
      }
      flushList();

      const safe = escapeLeader(text);
      if (para !== null && prev && line.y - prev.y <= prev.size * 2) {
        para = joinWrapped(para, safe);
      } else {
        flushPara();
        para = safe;
      }
      prev = line;
    }
    flush();

    // Figures land at the end of the page they were drawn on. Placing them at
    // the exact point in the text flow would mean replaying the whole content
    // stream to track each image's matrix — a lot of machinery for a guess that
    // is still only sometimes right.
    for (const shot of figures.get(page.num) ?? []) {
      blocks.push(`![Figure from page ${page.num}](images/${shot.name})`);
      stats.images++;
    }
  }

  const markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // Count real words, not the pipes and hashes the Markdown itself is made of.
  stats.words = (markdown.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu) ?? []).length;
  return { markdown: markdown ? `${markdown}\n` : '', stats };
}

/** The size most of the characters are set in — the definition of "body text". */
function modalSize(pages) {
  const tally = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      const key = Math.round(line.size * 2) / 2;
      tally.set(key, (tally.get(key) ?? 0) + line.text.length);
    }
  }
  let best = 11;
  let bestChars = -1;
  for (const [size, chars] of tally) {
    if (chars > bestChars) { best = size; bestChars = chars; }
  }
  return best;
}

/** The distinct sizes above body text, biggest first → #, ##, ###, ####. */
function headingLadder(pages, body) {
  const sizes = new Set();
  for (const page of pages) {
    for (const line of page.lines) {
      const size = Math.round(line.size * 2) / 2;
      if (size > body * 1.12 && line.text.length <= 140) sizes.add(size);
    }
  }
  return [...sizes].sort((a, b) => b - a).slice(0, HEADING_LEVELS);
}

function headingLevel(line, ladder) {
  if (!ladder.length) return 0;
  // A long stretch of large text is a pull quote or a title page, not a heading;
  // turning it into "# …" would wreck the outline in Notion.
  if (line.text.length > 140) return 0;
  const idx = ladder.indexOf(Math.round(line.size * 2) / 2);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Lines that appear in the same margin band, with the same shape, on most of the
 * pages: the course code at the top and "Page 4 of 30" at the bottom. Digits are
 * blanked before comparing, because a page number changes and the line does not.
 */
function runningLines(pages) {
  if (pages.length < 3) return new Set();
  const counts = new Map();
  for (const page of pages) {
    const seen = new Set(page.lines.map((l) => runningKey(page, l)).filter(Boolean));
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const need = Math.max(3, Math.ceil(pages.length * 0.6));
  return new Set([...counts].filter(([, n]) => n >= need).map(([key]) => key));
}

function runningKey(page, line) {
  const rel = line.y / (page.height || 1);
  if (rel > 0.12 && rel < 0.9) return '';   // only the margins can hold a running head
  const shape = line.text.replace(/\d+/g, '#').trim().toLowerCase();
  if (!shape || shape.length > 90) return '';
  return `${Math.round(rel * 40)}|${shape}`;
}

function lineMarkdown(line, opts, stats) {
  return line.cells.map((cell) => cellMarkdown(cell, opts, stats)).filter(Boolean).join(' ').trim();
}

function cellMarkdown(cell, opts, stats) {
  const text = cell.text.trim();
  if (!text) return '';
  if (opts.links && cell.url) {
    stats.links++;
    return `[${text}](${cell.url})`;
  }
  return text;
}

function asListItem(text) {
  if (BULLET_RE.test(text)) return `- ${text.replace(BULLET_RE, '')}`;
  const m = text.match(NUMBER_RE);
  return m ? `${m[1]}. ${text.slice(m[0].length)}` : null;
}

/** A body line that starts with # or > would become a heading or a quote by accident. */
function escapeLeader(text) {
  return text.replace(/^(#{1,6}|>)(\s)/, '\\$1$2');
}

function joinWrapped(para, next) {
  // PDF line-wrapping often splits a word with a hyphen; gluing it back is the
  // difference between "univer- sity" and "university" in the pasted note.
  if (/[a-z฀-๿]-$/.test(para) && /^[a-z]/.test(next)) return para.slice(0, -1) + next;
  return `${para} ${next}`;
}

// ---- tables ----------------------------------------------------------------

function findTables(lines, tol) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].cells.length < TABLE_MIN_COLS) { i++; continue; }
    const cols = lines[i].cells.map((c) => c.x);
    let j = i + 1;
    while (j < lines.length && rowFits(lines[j], cols, tol)) j++;
    if (j - i >= TABLE_MIN_ROWS) { tables.push({ start: i, end: j - 1, cols }); i = j; }
    else i++;
  }
  return tables;
}

/** A row belongs to the table when every cell lands in its own known column. */
function rowFits(line, cols, tol) {
  if (line.cells.length < TABLE_MIN_COLS) return false;
  const used = new Set();
  for (const cell of line.cells) {
    const k = nearestCol(cols, cell.x, tol);
    if (k < 0 || used.has(k)) return false;
    used.add(k);
  }
  return true;
}

function nearestCol(cols, x, tol) {
  let best = -1;
  let bestD = tol;
  for (let k = 0; k < cols.length; k++) {
    const d = Math.abs(cols[k] - x);
    if (d <= bestD) { bestD = d; best = k; }
  }
  return best;
}

function renderTable(lines, cols, tol, opts, stats) {
  const rows = lines.map((line) => {
    const row = cols.map(() => '');
    for (const cell of line.cells) {
      const k = nearestCol(cols, cell.x, tol);
      if (k >= 0) row[k] = cellMarkdown(cell, opts, stats).replace(/\|/g, '\\|');
    }
    return row;
  });
  const head = rows[0];
  const rest = rows.slice(1);
  return [
    `| ${head.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rest.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

// ---- image objects ---------------------------------------------------------

/**
 * A pdf.js image object → a canvas plus the right encoder for it. PNG keeps a
 * diagram's transparency and its hard edges; a photograph with no alpha is far
 * smaller as a JPEG, and a 40-photo lecture deck as PNG is a ZIP nobody can send.
 */
function imageToFile(img) {
  const w = img.width | 0;
  const h = img.height | 0;
  if (w < MIN_FIGURE_PX || h < MIN_FIGURE_PX) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext('2d');
  c2d.fillStyle = '#ffffff';
  c2d.fillRect(0, 0, w, h);

  let opaque = true;
  if (img.bitmap) {
    c2d.drawImage(img.bitmap, 0, 0, w, h);
    opaque = false;      // an ImageBitmap may carry alpha we cannot cheaply check
  } else if (img.data) {
    const out = c2d.createImageData(w, h);
    opaque = fillPixels(out.data, img, w, h);
    c2d.putImageData(out, 0, 0);
  } else {
    return null;
  }

  const type = opaque ? 'image/jpeg' : 'image/png';
  return {
    ext: opaque ? 'jpg' : 'png',
    toBlob: () => canvasToBlob(canvas, type, opaque ? 0.9 : undefined),
  };
}

/** Returns true when every pixel is fully opaque. */
function fillPixels(px, img, w, h) {
  const data = img.data;
  const pixels = w * h;
  if (data.length >= pixels * 4) {
    px.set(data.subarray(0, pixels * 4));
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return false;
    return true;
  }
  if (data.length >= pixels * 3) {
    for (let i = 0, j = 0; i < pixels; i++, j += 3) {
      px[i * 4] = data[j];
      px[i * 4 + 1] = data[j + 1];
      px[i * 4 + 2] = data[j + 2];
      px[i * 4 + 3] = 255;
    }
    return true;
  }
  // 1 bit per pixel, rows padded to whole bytes — line art and fax-style scans.
  const rowBytes = (w + 7) >> 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const byte = data[y * rowBytes + (x >> 3)] ?? 0;
      const on = (byte >> (7 - (x & 7))) & 1;
      const v = on ? 255 : 0;
      const o = (y * w + x) * 4;
      px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
    }
  }
  return true;
}
