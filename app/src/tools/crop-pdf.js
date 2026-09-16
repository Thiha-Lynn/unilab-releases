import { PDFDocument } from 'pdf-lib';
import { el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, liveExplain, numberField, optionPanel, segmented,
} from '../option-ui.js';

// A phone-scanned handout is mostly paper. Cropping is the difference between a
// page you can read on a 6-inch screen and one you have to pinch-zoom around.
const SCOPES = [
  { id: 'all', label: 'All pages' },
  { id: 'this', label: 'This page only' },
  { id: 'range', label: 'Page range' },
];
const PRESETS = [
  { id: 'auto', label: 'Auto-detect margins' },
  { id: 'manual', label: 'Manual' },
];

const PT_PER_MM = 72 / 25.4;
const PREVIEW_SCALE = 1.5;    // readable in the workarea without being slow
const DETECT_SCALE = 0.55;    // detection reads every pixel, so keep it cheap
const INK_LUMA = 244;         // darker than this counts as content, not paper
const PAD = 0.012;            // a little breathing room around what we found
const MIN_SIDE = 0.06;        // the rectangle can never collapse to nothing

// The eight grips, keyed by the compass direction they pull. The key is also the
// resize logic: a name containing 'w' moves the left edge, 'n' the top edge.
const HANDLES = {
  nw: 'left:-8px;top:-8px;cursor:nwse-resize',
  n: 'left:50%;top:-8px;margin-left:-8px;cursor:ns-resize',
  ne: 'right:-8px;top:-8px;cursor:nesw-resize',
  e: 'right:-8px;top:50%;margin-top:-8px;cursor:ew-resize',
  se: 'right:-8px;bottom:-8px;cursor:nwse-resize',
  s: 'left:50%;bottom:-8px;margin-left:-8px;cursor:ns-resize',
  sw: 'left:-8px;bottom:-8px;cursor:nesw-resize',
  w: 'left:-8px;top:50%;margin-top:-8px;cursor:ew-resize',
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));

export default function render(container, tool) {
  const state = {
    file: null,
    pdf: null,               // pdf.js document, for rendering and detection
    pageCount: 0,
    page: 1,
    boxes: [],               // per page: the PDF's own crop box, in points
    rotations: [],           // per page: /Rotate, which pdf.js has already applied
    scope: 'all',
    preset: 'auto',
    // The rectangle, always in *display* ratios of the rendered page: 0,0 is the
    // top-left of the page as you see it, which is not where PDF coordinates start.
    rect: { x: 0.06, y: 0.06, w: 0.88, h: 0.88 },
    detected: new Map(),     // pageNum → ratio rect, so re-visiting a page is instant
  };

  const ui = {};
  let areaHost = null;
  let frame = null;          // the positioned box the page canvas sits in
  let cropEl = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a PDF here',
    actionLabel: 'Crop PDF',
    doneTitle: 'Your PDF has been cropped!',
    downloadLabel: 'Download cropped PDF',
    continueTo: ['compress-pdf', 'pdf-to-images', 'merge-pdf'],
    note: 'Cropping sets the page\'s visible area, so nothing under the margin is thrown away — it is simply no longer shown. If you need the margins gone for good, run the cropped file through PDF → Images and back.',

    // The workarea is the page itself with the rectangle drawn on it. Numbers in
    // a sidebar cannot tell you whether you clipped the last line of a paragraph.
    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Crop');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.scope = segmented(SCOPES, (s) => {
        state.scope = s.id;
        syncVisibility();
        update();
      });

      ui.from = numberField('from page', { value: 1, min: 1, max: 9999, onChange: update });
      ui.to = numberField('to', { value: 1, min: 1, max: 9999, onChange: update });
      const rangeRow = el(`<div class="opt__row"></div>`);
      rangeRow.append(ui.from.root, ui.to.root);
      ui.range = { root: rangeRow };

      ui.keepSame = checkRow('Keep the same size on every page', {
        checked: true,
        hint: 'Off, every page keeps its own margins. On, every page comes out the same size — which is what you want if you are printing or binding it.',
        onChange: update,
      });

      ui.preset = segmented(PRESETS, (p) => {
        state.preset = p.id;
        if (p.id === 'auto') applyDetected(state.page);
        update();
      }, { active: 0 });

      panel.add(
        labelled('Crop which pages', ui.scope),
        ui.range,
        ui.facts,
        labelled('Where the edges go', ui.preset),
        ui.keepSame,
        ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      const pages = targetPages();
      if (!pages.length) throw new Error('That page range is outside this PDF. Check the page numbers and try again.');

      // Fresh bytes every run: pdf-lib mutates the document it loaded, so reusing
      // it would crop an already-cropped page the second time you press the button.
      const doc = await PDFDocument.load(await state.file.arrayBuffer(), { ignoreEncryption: true });

      // Step 1 — work out the rectangle for each page.
      const rects = new Map();
      if (state.preset === 'auto') {
        for (let i = 0; i < pages.length; i++) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          ctx.setBusy((i / pages.length) * 0.8, `Measuring the margins on page ${pages[i]}…`);
          rects.set(pages[i], await detect(pages[i]));
          await new Promise((r) => setTimeout(r, 0));
        }
        if (ui.keepSame.value && pages.length > 1) {
          // One rectangle that contains every page's content — otherwise page 4,
          // which happens to have a wide table, loses its right-hand column.
          // The first detected rectangle is the seed: an invented starting box
          // has no width or height of its own, and every corner would come out
          // as NaN the moment it was asked for one.
          const union = [...rects.values()].reduce((a, b) => {
            const x = Math.min(a.x, b.x);
            const y = Math.min(a.y, b.y);
            return {
              x,
              y,
              w: Math.max(a.x + a.w, b.x + b.w) - x,
              h: Math.max(a.y + a.h, b.y + b.h) - y,
            };
          });
          for (const p of pages) rects.set(p, union);
        }
      } else {
        for (const p of pages) rects.set(p, state.rect);
      }

      // Step 2 — the reference size, when every page must come out identical.
      const ref = ui.keepSame.value ? toUserSpace(pages[0], rects.get(pages[0])) : null;

      for (let i = 0; i < pages.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.8 + (i / pages.length) * 0.2, `Cropping page ${pages[i]} of ${state.pageCount}…`);
        const n = pages[i];
        const box = state.boxes[n - 1];
        let r = toUserSpace(n, rects.get(n));
        if (ref) {
          // Same width and height on every page; only the position follows the page.
          r = {
            width: Math.min(ref.width, box.width),
            height: Math.min(ref.height, box.height),
            x: r.x, y: r.y,
          };
          r.x = Math.min(Math.max(r.x, box.x), box.x + box.width - r.width);
          r.y = Math.min(Math.max(r.y, box.y), box.y + box.height - r.height);
        }
        doc.getPage(n - 1).setCropBox(r.x, r.y, r.width, r.height);
        if (i % 12 === 0) await new Promise((res) => setTimeout(res, 0));
      }

      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      return {
        outputs: [{ name: `${stem(state.file.name)}-cropped.pdf`, blob }],
        doneTitle: pages.length === 1 ? 'Your page has been cropped!' : 'Your PDF has been cropped!',
      };
    },

    async thumbnail(file) {
      const pdf = await openPdf(file);
      return renderPage(pdf, 1, 0.5);
    },
  });

  // -------------------------------------------------------------------------

  /** A labelled wrapper, in the same markup option-ui's own fields use. */
  function labelled(label, ...nodes) {
    const root = el(`<div class="opt__field"><label class="opt__label"></label></div>`);
    root.querySelector('.opt__label').textContent = label;
    root.append(...nodes.map((n) => n?.root ?? n));
    return { root };
  }

  /**
   * The rectangle a reader actually sees: the crop box clipped to the media box.
   * pdf.js clips it that way before rendering, so pdf-lib has to measure the
   * same rectangle or every ratio below lands somewhere else on the page.
   */
  function visibleBox(page) {
    const media = page.getMediaBox();
    const crop = page.getCropBox() ?? media;
    const x0 = Math.max(media.x, crop.x);
    const y0 = Math.max(media.y, crop.y);
    const x1 = Math.min(media.x + media.width, crop.x + crop.width);
    const y1 = Math.min(media.y + media.height, crop.y + crop.height);
    return x1 > x0 && y1 > y0
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : media;
  }

  /** /Rotate as one of 0/90/180/270 — files in the wild carry -90, 450 and 89. */
  function pageRotation(page) {
    const raw = page.getRotation().angle ?? 0;
    return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  }

  function closeDoc() {
    const doc = state.pdf;
    state.pdf = null;
    doc?.destroy?.()?.catch?.(() => { /* already torn down */ });
  }

  function syncVisibility() {
    ui.range.root.hidden = state.scope !== 'range';
    // "The same size on every page" only means something across several pages.
    ui.keepSame.root.hidden = state.scope === 'this';
  }

  async function loadFile() {
    const file = state.file;
    if (!file) { closeDoc(); state.pageCount = 0; ui.facts.set([]); paint(); return; }
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      throw new Error('That file is not a PDF. Choose the PDF you want to crop.');
    }

    state.detected.clear();
    state.page = 1;
    closeDoc();
    state.pdf = await openPdf(file);
    state.pageCount = state.pdf.numPages;

    // pdf-lib knows the boxes and the page rotation; pdf.js knows how to draw.
    // Both are needed, and they disagree about which corner is the origin.
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    state.boxes = doc.getPages().map(visibleBox);
    state.rotations = doc.getPages().map(pageRotation);

    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Total pages', String(state.pageCount)],
    ]);
    ui.from.setMax(state.pageCount);
    ui.to.setMax(state.pageCount);
    ui.from.value = 1;
    ui.to.value = state.pageCount;

    await showPage(1);
  }

  function targetPages() {
    const { pageCount, scope } = state;
    if (!pageCount) return [];
    if (scope === 'this') return [state.page];
    if (scope === 'range') {
      const lo = Math.max(1, Math.min(ui.from.value, ui.to.value));
      const hi = Math.min(pageCount, Math.max(ui.from.value, ui.to.value));
      return hi >= lo ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [];
    }
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  // ---- auto-detect --------------------------------------------------------

  /**
   * Render the page small, then walk the pixels inward from each edge until a
   * line of them stops being paper. This is the whole trick: a scan of a
   * textbook page has 2 cm of nothing on every side, and the numbers to remove
   * it are already sitting in the bitmap.
   */
  async function detect(pageNum) {
    if (state.detected.has(pageNum)) return state.detected.get(pageNum);

    const canvas = await renderPage(state.pdf, pageNum, DETECT_SCALE);
    const w = canvas.width;
    const h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;

    const rows = new Uint32Array(h);
    const cols = new Uint32Array(w);
    for (let y = 0; y < h; y++) {
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const p = base + x * 4;
        // Rec.601 luma, so the cream-coloured background of a phone scan still
        // reads as paper while grey printed text does not.
        const luma = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000;
        if (luma < INK_LUMA) { rows[y]++; cols[x]++; }
      }
    }

    // A single dark speck is dust on the lens, not content. Require a short run
    // of dark pixels before a line counts, or every scan detects its own noise.
    const rowMin = Math.max(2, Math.round(w * 0.004));
    const colMin = Math.max(2, Math.round(h * 0.004));
    const first = (arr, min) => { for (let i = 0; i < arr.length; i++) if (arr[i] >= min) return i; return -1; };
    const last = (arr, min) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= min) return i; return -1; };

    const top = first(rows, rowMin);
    const bottom = last(rows, rowMin);
    const left = first(cols, colMin);
    const right = last(cols, colMin);

    // A genuinely blank page has nothing to crop to, so leave it whole.
    const rect = (top < 0 || left < 0)
      ? { x: 0, y: 0, w: 1, h: 1 }
      : (() => {
        const x0 = clamp01(left / w - PAD);
        const x1 = clamp01((right + 1) / w + PAD);
        const y0 = clamp01(top / h - PAD);
        const y1 = clamp01((bottom + 1) / h + PAD);
        // A page with one stray mark on it can detect a sliver; the minimum side
        // then has to be pushed back inside the page rather than off its edge.
        const w2 = Math.max(MIN_SIDE, x1 - x0);
        const h2 = Math.max(MIN_SIDE, y1 - y0);
        return { x: Math.min(x0, 1 - w2), y: Math.min(y0, 1 - h2), w: w2, h: h2 };
      })();

    state.detected.set(pageNum, rect);
    return rect;
  }

  async function applyDetected(pageNum) {
    if (!state.pdf) return;
    state.rect = { ...(await detect(pageNum)) };
    paintRect();
    update();
  }

  // ---- display ratios → PDF user space ------------------------------------

  /**
   * pdf.js draws the page the way a reader sees it: top-left origin, /Rotate
   * already applied. pdf-lib writes boxes in the page's own coordinates:
   * bottom-left origin, unrotated. Every mapping between the two lives here.
   */
  function toUserSpace(pageNum, r) {
    const box = state.boxes[pageNum - 1];
    const rot = state.rotations[pageNum - 1] ?? 0;
    const { x: bx, y: by, width: bw, height: bh } = box;
    const { x: L, y: T, w: W, h: H } = r;

    if (rot === 90) {
      return { x: bx + T * bw, y: by + L * bh, width: H * bw, height: W * bh };
    }
    if (rot === 180) {
      return { x: bx + (1 - L - W) * bw, y: by + T * bh, width: W * bw, height: H * bh };
    }
    if (rot === 270) {
      return { x: bx + (1 - T - H) * bw, y: by + (1 - L - W) * bh, width: H * bw, height: W * bh };
    }
    return { x: bx + L * bw, y: by + (1 - T - H) * bh, width: W * bw, height: H * bh };
  }

  // ---- workarea -----------------------------------------------------------

  async function showPage(n) {
    if (!state.pdf) return;
    state.page = Math.min(state.pageCount, Math.max(1, n));
    paint();
    const canvas = await renderPage(state.pdf, state.page, PREVIEW_SCALE);
    canvas.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px';
    if (frame) {
      frame.querySelector('canvas')?.remove();
      frame.prepend(canvas);
    }
    if (state.preset === 'auto') await applyDetected(state.page);
    else update();
  }

  function paint() {
    if (!areaHost) return;
    areaHost.innerHTML = '';
    if (!state.pageCount) return;

    const stage = el(`<div style="max-width:720px;margin:0 auto"></div>`);
    const nav = el(`
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 14px">
        <button class="ts__icon-btn" data-prev type="button" aria-label="Previous page">‹</button>
        <span class="ts__hint" data-count style="margin:0;font-weight:700"></span>
        <button class="ts__icon-btn" data-next type="button" aria-label="Next page">›</button>
      </div>
    `);
    nav.querySelector('[data-count]').textContent = `${state.page} / ${state.pageCount}`;
    nav.querySelector('[data-prev]').disabled = state.page <= 1;
    nav.querySelector('[data-next]').disabled = state.page >= state.pageCount;
    nav.querySelector('[data-prev]').addEventListener('click', () => showPage(state.page - 1));
    nav.querySelector('[data-next]').addEventListener('click', () => showPage(state.page + 1));

    frame = el(`
      <div style="position:relative;overflow:hidden;background:#fff;border-radius:6px;box-shadow:var(--shadow);touch-action:none;line-height:0"></div>
    `);

    // The rectangle itself. The huge spread box-shadow is what dims everything
    // outside it — one element instead of four, and it can never drift out of
    // alignment with the rectangle it is supposed to frame.
    cropEl = el(`
      <div style="position:absolute;border:2px solid var(--accent);box-shadow:0 0 0 9999px rgba(12,16,26,.55);cursor:move;touch-action:none"></div>
    `);
    for (const [kind, pos] of Object.entries(HANDLES)) {
      const grip = el(`<div style="position:absolute;width:15px;height:15px;background:var(--card);border:2px solid var(--accent);border-radius:4px;touch-action:none;${pos}"></div>`);
      grip.addEventListener('pointerdown', (e) => beginDrag(e, kind));
      cropEl.appendChild(grip);
    }
    cropEl.addEventListener('pointerdown', (e) => {
      if (e.target === cropEl) beginDrag(e, 'move');
    });
    frame.appendChild(cropEl);

    stage.append(nav, frame, el(`<p class="ts__hint" style="text-align:center">Drag the rectangle or its corners. Auto-detect switches to Manual the moment you move it.</p>`));
    areaHost.appendChild(stage);
    paintRect();
  }

  function paintRect() {
    if (!cropEl) return;
    const { x, y, w, h } = state.rect;
    cropEl.style.left = `${x * 100}%`;
    cropEl.style.top = `${y * 100}%`;
    cropEl.style.width = `${w * 100}%`;
    cropEl.style.height = `${h * 100}%`;
  }

  function beginDrag(e, kind) {
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const start = { ...state.rect };
    const ox = (e.clientX - bounds.left) / bounds.width;
    const oy = (e.clientY - bounds.top) / bounds.height;
    target.setPointerCapture?.(e.pointerId);

    // Touching the rectangle means you have an opinion about it, so stop
    // auto-detect from overwriting your work on the next repaint.
    if (state.preset === 'auto') ui.preset.select(1);

    const move = (ev) => {
      const dx = (ev.clientX - bounds.left) / bounds.width - ox;
      const dy = (ev.clientY - bounds.top) / bounds.height - oy;
      let { x, y, w, h } = start;
      if (kind === 'move') {
        x = Math.min(Math.max(0, x + dx), 1 - w);
        y = Math.min(Math.max(0, y + dy), 1 - h);
      } else {
        if (kind.includes('w')) { const nx = Math.min(Math.max(0, x + dx), x + w - MIN_SIDE); w += x - nx; x = nx; }
        if (kind.includes('e')) { w = Math.min(Math.max(MIN_SIDE, w + dx), 1 - x); }
        if (kind.includes('n')) { const ny = Math.min(Math.max(0, y + dy), y + h - MIN_SIDE); h += y - ny; y = ny; }
        if (kind.includes('s')) { h = Math.min(Math.max(MIN_SIDE, h + dy), 1 - y); }
      }
      state.rect = { x, y, w, h };
      paintRect();
      update();
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  // ---- live explain -------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    if (!state.pageCount) { ui.explain.set(''); return; }

    const pages = targetPages();
    if (!pages.length) { ui.explain.set('That page range is outside this PDF.'); return; }

    const r = toUserSpace(state.page, state.rect);
    const mmW = Math.round(r.width / PT_PER_MM);
    const mmH = Math.round(r.height / PT_PER_MM);
    const removed = Math.round((1 - state.rect.w * state.rect.h) * 100);
    const who = state.scope === 'this'
      ? `Page ${state.page}`
      : pages.length === state.pageCount ? 'Each page' : `Pages ${pages[0]}–${pages.at(-1)}`;
    const autoMany = state.preset === 'auto' && pages.length > 1;
    const sizeText = autoMany && !ui.keepSame.value
      ? 'its own detected content, page by page'
      : autoMany
        // The finished size is the box that holds every page's content, so it
        // can only be bigger than the one page being previewed here.
        ? `one size that fits every page — at least ${mmW} × ${mmH} mm`
        : `${mmW} × ${mmH} mm`;

    ui.explain.set(
      removed <= 0
        ? `${who} will keep its full size — there is nothing to trim yet.`
        : `${who} will be cropped to ${sizeText} — about ${removed}% of the page put out of view.`,
    );
  }

  // Leaving the tool hands the rendered pages and the pdf.js worker back now,
  // rather than leaving a whole document parked in memory behind a dead screen.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    closeDoc();
    state.detected.clear();
  });
}
