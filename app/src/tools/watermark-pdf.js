import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { canvasToBlob, el, formatBytes, loadImage, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, colorField, fileFacts, liveExplain, numberField, optionPanel,
  segmented, sliderField, tabCards, textField,
} from '../option-ui.js';
// The app's own font list, so a mark that mixes English with Thai or Burmese
// still comes out as letters in the preview — canvas falls back per character
// to whatever the device already has for that script.
import { APP_FALLBACK } from '../text-draw.js';

// Watermark PDF — text or image, anywhere on the page, on any page range.
//
// iLovePDF sells the image watermark, the position control and the
// transparency slider as premium. All three run fine in a browser, so here
// they are: a Text / Image switch, nine positions plus the classic diagonal
// DRAFT plus a tiled repeat (the only placement that actually costs someone
// something to crop out), opacity and rotation, and an all-pages / page-range
// choice — previewed live on the page itself before anything is written.

const MODES = [
  { id: 'text', label: 'Text', icon: TAB_ICONS.type, note: '“DRAFT”, your name, your student ID — anything you can type.' },
  { id: 'image', label: 'Image', icon: TAB_ICONS.upload, note: 'A logo or signature saved as a PNG or JPG.' },
];

const PLACES = [
  { id: 'diag', label: 'Diagonal', note: 'The classic DRAFT — once across the middle, along the page’s own diagonal.' },
  { id: 'spot', label: 'One spot', note: 'Pick one of nine positions below.' },
  { id: 'tile', label: 'Tile', note: 'Repeated over the whole page — the placement that actually deters reuse.' },
];

const ANGLES = [
  { id: 0, label: '0°' },
  { id: 30, label: '30°' },
  { id: 45, label: '45°' },
  { id: 90, label: '90°' },
];

const PAGE_MODES = [
  { id: 'all', label: 'All pages' },
  { id: 'range', label: 'Page range' },
];

// The nine positions, laid out as the 3×3 they are.
const SPOT_ROWS = [['tl', 'tc', 'tr'], ['ml', 'mc', 'mr'], ['bl', 'bc', 'br']];
const SPOT_GLYPH = { tl: '↖', tc: '↑', tr: '↗', ml: '←', mc: '●', mr: '→', bl: '↙', bc: '↓', br: '↘' };
const SPOT_NAME = {
  tl: 'top left', tc: 'top centre', tr: 'top right',
  ml: 'middle left', mc: 'centre', mr: 'middle right',
  bl: 'bottom left', bc: 'bottom centre', br: 'bottom right',
};

const MARGIN_FRACTION = 0.05;
const PREVIEW_SCALE = 0.6;
// Per page — every stamped page repeats the grid, so a runaway tile would
// both hang the tab now and bloat the exported PDF with thousands of draw
// operations on every page.
const MAX_TILES = 240;
// The canvas-rendered text mark is drawn at this font size in pixels and then
// scaled down onto the page, so it stays crisp when zoomed or printed.
const RENDER_FONT_PX = 400;
const FONT_STACK = `${APP_FALLBACK}, sans-serif`;

export default function render(container, tool) {
  const state = { file: null, pdf: null, pageCount: 0, mode: 'text', spot: 'mc' };
  const logo = { file: null, img: null };
  const ui = {};

  let stageHost = null;
  let hintEl = null;
  let viewCanvas = null;
  let measureCanvas = null;
  let paintTimer = null;
  let loadToken = 0;
  const baseCache = new Map();   // pageNo → rendered page canvas at PREVIEW_SCALE
  const basePending = new Set();

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a PDF here',
    actionLabel: 'Add watermark',
    doneTitle: 'Your PDF is watermarked!',
    downloadLabel: 'Download watermarked PDF',
    continueTo: ['compress-pdf', 'merge-pdf', 'page-numbers-pdf'],
    note: 'Classic use: your student ID across a shared draft, or “DRAFT” before peer review. A single corner stamp is easy to crop off — Tile is the placement that survives a screenshot. Thai and Burmese wording works too: the browser draws it and embeds it as a picture, so it never turns into boxes. As always, the PDF never leaves this device.',

    // The left pane is page one of the range with the mark already on it,
    // composited exactly as the export will draw it.
    workarea(host) {
      ensurePane(host);
      schedulePaint();
    },

    async onFiles(ctx) {
      const file = ctx.files[0] ?? null;
      const token = ++loadToken;
      state.file = file;
      state.pdf = null;
      state.pageCount = 0;
      baseCache.clear();
      basePending.clear();
      viewCanvas = null;
      if (!file) { update(); return; }
      try {
        const pdf = await openPdf(file);
        if (token !== loadToken) return;
        state.pdf = pdf;
        state.pageCount = pdf.numPages;
      } catch {
        throw new Error(`Could not open ${file.name}. If it is password-protected, run it through Unlock PDF first.`);
      }
      // Bound the range fields by the real page count, and reset them to mean
      // "the whole document" for the file that just arrived.
      ui.from?.setMax(state.pageCount);
      ui.to?.setMax(state.pageCount);
      if (ui.from) ui.from.value = 1;
      if (ui.to) ui.to.value = state.pageCount;
      update();
    },

    onChange() { update(); },

    options(host) {
      const panel = optionPanel('Watermark');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.tabs = tabCards(MODES, (t) => { state.mode = t.id; syncVisibility(); update(); });

      // ---- text mark ----
      ui.text = textField('Text', {
        value: 'DRAFT',
        placeholder: 'DRAFT · your name · 6531234567',
        maxLength: 80,
        onChange: update,
      });
      ui.colour = colorField('Colour', { value: '#808080', onChange: update });
      ui.size = sliderField('Size', { value: 12, min: 3, max: 30, step: 0.5, suffix: '% of width', onChange: update });
      ui.textOpacity = sliderField('Opacity', { value: 18, min: 5, max: 100, suffix: '%', onChange: update });

      // ---- image mark ----
      ui.logoField = el(`<div class="opt__field"><label class="opt__label">Logo or signature</label></div>`);
      ui.logoPick = el(`<button class="opt__add" type="button">+ Choose a PNG or JPG</button>`);
      ui.logoName = el(`<p class="opt__hint">Nothing chosen yet. A PNG with a transparent background sits on a page best.</p>`);
      ui.logoField.append(ui.logoPick, ui.logoName);
      const logoInput = document.createElement('input');
      logoInput.type = 'file';
      // PNG and JPG only: they are the two formats pdf-lib can embed directly.
      logoInput.accept = 'image/png,image/jpeg';
      logoInput.hidden = true;
      ui.logoField.appendChild(logoInput);
      ui.logoPick.addEventListener('click', () => logoInput.click());
      logoInput.addEventListener('change', async () => {
        const file = logoInput.files?.[0];
        logoInput.value = '';
        if (!file) return;
        try {
          const img = await loadImage(file);
          if (!img.naturalWidth || !img.naturalHeight) throw new Error('that file has no pixels');
          logo.file = file;
          logo.img = img;
          ui.logoName.textContent = `${file.name} · ${img.naturalWidth}×${img.naturalHeight} · ${formatBytes(file.size)}`;
          ui.logoPick.textContent = '+ Choose a different logo';
          update();
        } catch (err) {
          ui.logoName.textContent = `Could not read that logo — ${err.message}. Try a PNG or JPG.`;
        }
      });
      ui.logoScale = sliderField('Logo size', { value: 30, min: 5, max: 100, suffix: '% of width', onChange: update });
      ui.logoOpacity = sliderField('Logo opacity', { value: 35, min: 5, max: 100, suffix: '%', onChange: update });

      // ---- shared: placement ----
      ui.place = segmented(PLACES, () => { syncVisibility(); update(); }, { active: 0 });
      const placeField = el(`<div class="opt__field"><label class="opt__label">Placement</label></div>`);
      placeField.appendChild(ui.place.root);

      // The nine positions as a 3×3 of segmented buttons — three .opt__seg
      // rows stacked, with the active state managed across all nine.
      ui.spotField = el(`<div class="opt__field"><label class="opt__label">Position</label></div>`);
      const spotBtns = new Map();
      for (const row of SPOT_ROWS) {
        const line = el(`<div class="opt__seg" role="group"></div>`);
        for (const id of row) {
          const b = el(`<button class="opt__seg__btn" type="button"></button>`);
          b.textContent = SPOT_GLYPH[id];
          b.title = SPOT_NAME[id][0].toUpperCase() + SPOT_NAME[id].slice(1);
          if (id === state.spot) b.classList.add('is-active');
          b.addEventListener('click', () => {
            state.spot = id;
            for (const [sid, sb] of spotBtns) sb.classList.toggle('is-active', sid === id);
            update();
          });
          spotBtns.set(id, b);
          line.appendChild(b);
        }
        ui.spotField.appendChild(line);
      }

      ui.angle = segmented(ANGLES, () => update(), { active: 2 });
      ui.angleField = el(`<div class="opt__field"><label class="opt__label">Rotation</label></div>`);
      ui.angleField.appendChild(ui.angle.root);

      // ---- shared: pages ----
      ui.pages = segmented(PAGE_MODES, () => { syncVisibility(); update(); }, { active: 0 });
      const pagesField = el(`<div class="opt__field"><label class="opt__label">Pages</label></div>`);
      pagesField.appendChild(ui.pages.root);
      ui.from = numberField('from page', { value: 1, min: 1, max: 9999, onChange: update });
      ui.to = numberField('to', { value: 1, min: 1, max: 9999, onChange: update });
      ui.rangeRow = el(`<div class="opt__row"></div>`);
      ui.rangeRow.append(ui.from.root, ui.to.root);

      panel.add(
        ui.tabs, ui.facts,
        ui.text, ui.colour, ui.size, ui.textOpacity,
        ui.logoField, ui.logoScale, ui.logoOpacity,
        placeField, ui.spotField, ui.angleField,
        pagesField, ui.rangeRow,
        ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.file) throw new Error('Add a PDF first.');
      const text = ui.text.value.trim();
      if (state.mode === 'text' && !text) {
        throw new Error('Type the words you want stamped — “DRAFT”, your name, or your student ID.');
      }
      if (state.mode === 'image' && !logo.img) {
        throw new Error('Choose the PNG or JPG logo you want stamped first.');
      }
      const pageNos = targets();
      if (!pageNos.length) throw new Error('That page range covers no pages. Check the numbers and try again.');

      ctx.setBusy(0.02, 'Opening PDF…');
      // A fresh copy every run: run() draws straight onto the document, and
      // stamping the one kept from a previous run would double every mark.
      let doc;
      try {
        doc = await PDFDocument.load(await state.file.arrayBuffer(), { ignoreEncryption: true });
      } catch {
        throw new Error(`Could not open ${state.file.name}. If it is password-protected, run it through Unlock PDF first.`);
      }

      const kit = { text, color: hexToRgb(ui.colour.value), alpha: opacity(), helvetica: null, markImage: null };
      if (state.mode === 'text' && /^[\x20-\x7E]+$/.test(text)) {
        // Pure-ASCII wording draws as real vector text.
        kit.helvetica = await doc.embedFont(StandardFonts.HelveticaBold);
      } else if (state.mode === 'text') {
        kit.markImage = await embedRenderedText(doc, text);
      } else {
        const bytes = await logo.file.arrayBuffer();
        kit.markImage = {
          img: logo.file.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes),
        };
      }

      const pages = doc.getPages();
      for (let i = 0; i < pageNos.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.05 + (i / pageNos.length) * 0.8, `Stamping page ${pageNos[i]} — ${i + 1} of ${pageNos.length}…`);
        stampPage(pages[pageNos[i] - 1], kit);
        // Yield every few pages so cancel keeps its turn on a long document.
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }

      ctx.setBusy(0.9, 'Writing PDF…');
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      return {
        outputs: [{ name: `${stem(state.file.name)}-watermarked.pdf`, blob }],
        doneTitle: `Watermarked ${pageNos.length} page${pageNos.length === 1 ? '' : 's'}!`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Sidebar plumbing

  function syncVisibility() {
    const text = state.mode === 'text';
    for (const k of ['text', 'colour', 'size', 'textOpacity']) ui[k].root.hidden = !text;
    ui.logoField.hidden = text;
    ui.logoScale.root.hidden = text;
    ui.logoOpacity.root.hidden = text;
    ui.spotField.hidden = ui.place.value !== 'spot';
    // The diagonal takes its angle from the page's own proportions, so the
    // rotation switch would be a lie there.
    ui.angleField.hidden = ui.place.value === 'diag';
    ui.rangeRow.hidden = ui.pages.value !== 'range';
  }

  /** The 1-based page numbers the current settings will stamp. */
  function targets() {
    const n = state.pageCount;
    if (!n) return [];
    if (ui.pages?.value !== 'range') return Array.from({ length: n }, (_, i) => i + 1);
    const lo = Math.max(1, Math.min(ui.from.value, ui.to.value));
    const hi = Math.min(n, Math.max(ui.from.value, ui.to.value));
    return hi >= lo ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [];
  }

  /** The opacity slider belonging to the mode currently showing, as 0…1. */
  function opacity() {
    return (state.mode === 'text' ? ui.textOpacity.value : ui.logoOpacity.value) / 100;
  }

  function fontSize(Wd) {
    return Math.max(4, (Wd * ui.size.value) / 100);
  }

  function measureCtx() {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    return measureCanvas.getContext('2d');
  }

  function hexToRgb(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  // -------------------------------------------------------------------------
  // Geometry, shared by the preview and the export.
  //
  // Everything is planned in *display* space — the page as a viewer shows it,
  // origin top-left, sizes as fractions of the page width — and the export
  // maps the plan into raw PDF coordinates afterwards. One planner means the
  // preview cannot drift from what run() writes.

  /** Visual counterclockwise tilt of the mark, in degrees. */
  function markAngle(Wd, Hd) {
    if (ui.place.value === 'diag') return (Math.atan2(Hd, Wd) * 180) / Math.PI;
    return Number(ui.angle.value) || 0;
  }

  /**
   * Unrotated size of one mark on a page Wd wide. Text is measured with the
   * same canvas font the preview draws with, so spot insets and tile spacing
   * come out identical in both places.
   */
  function markBox(Wd) {
    if (state.mode === 'image') {
      if (!logo.img) return null;
      const w = Math.max(1, (Wd * ui.logoScale.value) / 100);
      return { w, h: (w * logo.img.naturalHeight) / logo.img.naturalWidth };
    }
    const text = ui.text.value.trim();
    if (!text) return null;
    const f = fontSize(Wd);
    const c2 = measureCtx();
    c2.font = `700 ${f}px ${FONT_STACK}`;
    return { w: Math.max(1, c2.measureText(text).width), h: f };
  }

  /** Where every mark on a Wd×Hd page goes: centres in top-left coords + tilt. */
  function planStamps(Wd, Hd) {
    if (!ui.place) return null;
    const box = markBox(Wd);
    if (!box) return null;
    const A = markAngle(Wd, Hd);
    const rad = (A * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    const bw = box.w * c + box.h * s;   // the mark's rotated bounding box
    const bh = box.w * s + box.h * c;
    const place = ui.place.value;

    if (place === 'spot') {
      // Inset by half the rotated box so a corner mark sits inside the page,
      // whatever its tilt.
      const m = Wd * MARGIN_FRACTION;
      const col = state.spot[1];
      const row = state.spot[0];
      const x = col === 'l' ? m + bw / 2 : col === 'r' ? Wd - m - bw / 2 : Wd / 2;
      const y = row === 't' ? m + bh / 2 : row === 'b' ? Hd - m - bh / 2 : Hd / 2;
      return { A, box, centers: [{ x, y }] };
    }
    if (place !== 'tile') {
      return { A, box, centers: [{ x: Wd / 2, y: Hd / 2 }] };
    }

    // Tile: a brick grid laid out in the rotated frame — offset rows leave no
    // clean alley to crop along — with spacing proportional to the mark.
    let stepX = state.mode === 'image' ? box.w * 1.6 : box.w + box.h * 1.5;
    let stepY = state.mode === 'image' ? box.h * 1.9 : box.h * 2.6;
    const half = Math.hypot(Wd, Hd) / 2;
    const tilesFor = (sx, sy) =>
      (Math.ceil((2 * (half + sy)) / sx) + 1) * (Math.ceil((2 * (half + sy)) / sy) + 1);
    if (tilesFor(stepX, stepY) > MAX_TILES) {
      // A tiny mark on a big page could ask for tens of thousands of draws per
      // page. Spreading the grid keeps it a tile — just with more air — rather
      // than hanging the tab and bloating the export.
      const spread = Math.sqrt(tilesFor(stepX, stepY) / MAX_TILES);
      stepX *= spread;
      stepY *= spread;
    }
    const cosD = Math.cos(-rad);   // canvas space is y-down, so visual CCW = −A
    const sinD = Math.sin(-rad);
    const reach = half + stepY;
    const cull = Math.max(bw, bh);
    const centers = [];
    let row = 0;
    for (let gy = -reach; gy <= reach; gy += stepY, row++) {
      const offset = row % 2 ? stepX / 2 : 0;
      for (let gx = -reach + offset; gx <= reach; gx += stepX) {
        const x = Wd / 2 + gx * cosD - gy * sinD;
        const y = Hd / 2 + gx * sinD + gy * cosD;
        // The rotated grid covers a circle wider than the page; marks that
        // cannot touch the page are dropped, not written invisibly.
        if (x < -cull || x > Wd + cull || y < -cull || y > Hd + cull) continue;
        centers.push({ x, y });
      }
    }
    return { A, box, centers };
  }

  // -------------------------------------------------------------------------
  // The export

  /**
   * Why the detour through a picture for non-Latin text: pdf-lib can only draw
   * text with its 14 built-in standard fonts, and those encode WinAnsi
   * (Latin-1) — hand Helvetica a Thai or Burmese string and it throws before
   * anything is drawn. Embedding a real Unicode font would fix that, but this
   * tool deliberately ships no font files: covering Thai + Burmese + Latin is
   * megabytes of bundle for one watermark, and the device already has good
   * faces for those scripts. So the browser draws the wording onto a
   * transparent canvas with the app's own font stack — the exact glyphs the
   * preview shows — at high resolution, and that bitmap is embedded and
   * stamped like a logo.
   */
  async function embedRenderedText(doc, text) {
    const f = RENDER_FONT_PX;
    const c2 = measureCtx();
    c2.font = `700 ${f}px ${FONT_STACK}`;
    const m = c2.measureText(text);
    // Thai and Burmese stack marks above and below the line, so the box comes
    // from the measured ink bounds, not the nominal em square.
    const ascent = Math.ceil(m.actualBoundingBoxAscent ?? f);
    const descent = Math.ceil(m.actualBoundingBoxDescent ?? f * 0.4);
    const pad = Math.ceil(f * 0.08);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(m.width) + pad * 2);
    canvas.height = Math.max(1, ascent + descent + pad * 2);
    const cc = canvas.getContext('2d');
    cc.font = `700 ${f}px ${FONT_STACK}`;   // resizing a canvas resets its context
    cc.fillStyle = ui.colour.value;
    cc.textBaseline = 'alphabetic';
    cc.fillText(text, pad, pad + ascent);
    // PDF points per point of font size, so pages of different widths each get
    // the mark at their own percentage of width.
    const wPerF = canvas.width / f;
    const hPerF = canvas.height / f;
    const blob = await canvasToBlob(canvas, 'image/png');
    const img = await doc.embedPng(await blob.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    return { img, wPerF, hPerF };
  }

  /** Draws the planned marks onto one pdf-lib page. */
  function stampPage(page, kit) {
    // Plan in display space, then map back into raw page coordinates. A page
    // that already carries a /Rotate flag — a scan fixed with Rotate PDF, say —
    // would otherwise get its watermark stamped sideways.
    const R = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
    const { width: W, height: H } = page.getSize();
    const sideways = R === 90 || R === 270;
    const Wd = sideways ? H : W;
    const Hd = sideways ? W : H;
    const plan = planStamps(Wd, Hd);
    if (!plan) return;
    const Ap = plan.A + R;             // drawn angle compensates the page's own turn
    const rad = (Ap * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    for (const center of plan.centers) {
      // Display top-left coords → display bottom-left (PDF-style, y up)…
      const xd = center.x;
      const yd = Hd - center.y;
      // …→ raw page coords: the inverse of the clockwise turn /Rotate applies.
      let x;
      let y;
      if (R === 90) { x = W - yd; y = xd; }
      else if (R === 180) { x = W - xd; y = H - yd; }
      else if (R === 270) { x = yd; y = H - xd; }
      else { x = xd; y = yd; }

      if (kit.helvetica) {
        const f = fontSize(Wd);
        const tw = kit.helvetica.widthOfTextAtSize(kit.text, f);
        const th = f * 0.72;   // optical cap box — centres like the preview's "middle" baseline
        // drawText anchors at the baseline start and rotates about it, so the
        // anchor is walked back from the mark's centre by half the rotated box.
        page.drawText(kit.text, {
          x: x - (tw / 2) * cos + (th / 2) * sin,
          y: y - (tw / 2) * sin - (th / 2) * cos,
          size: f,
          font: kit.helvetica,
          color: kit.color,
          opacity: kit.alpha,
          rotate: degrees(Ap),
        });
      } else {
        const { img } = kit.markImage;
        let w;
        let h;
        if (state.mode === 'text') {
          const f = fontSize(Wd);
          w = kit.markImage.wPerF * f;
          h = kit.markImage.hPerF * f;
        } else {
          w = (Wd * ui.logoScale.value) / 100;
          h = (w * img.height) / img.width;
        }
        // drawImage anchors at the picture's bottom-left and rotates about it —
        // the same walk-back as the text case.
        page.drawImage(img, {
          x: x - (w / 2) * cos + (h / 2) * sin,
          y: y - (w / 2) * sin - (h / 2) * cos,
          width: w,
          height: h,
          rotate: degrees(Ap),
          opacity: kit.alpha,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The live preview

  function ensurePane(host) {
    if (stageHost && host.contains(stageHost)) return;
    host.innerHTML = '';
    const wrap = el(`
      <div>
        <div class="canvas-stage" data-stage></div>
        <p class="ts__hint" data-hint></p>
      </div>
    `);
    host.appendChild(wrap);
    stageHost = wrap.querySelector('[data-stage]');
    hintEl = wrap.querySelector('[data-hint]');
    viewCanvas = null;
  }

  /**
   * Sliders fire on every pixel of drag; redrawing a rendered PDF page plus a
   * few hundred tiles on each of those events is what makes a preview feel
   * broken. The redraw waits ~150 ms for the drag to settle instead.
   */
  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paint, 150);
  }

  /** The page the preview shows: the first page the current range stamps. */
  function previewPageNo() {
    const t = targets();
    return t.length ? t[0] : 1;
  }

  async function ensureBase(pageNo) {
    if (!state.pdf || baseCache.has(pageNo) || basePending.has(pageNo)) return;
    basePending.add(pageNo);
    const token = loadToken;
    try {
      const canvas = await renderPage(state.pdf, pageNo, PREVIEW_SCALE);
      if (token !== loadToken) return;
      // Scrubbing the range fields can touch many pages; keep a handful.
      if (baseCache.size > 8) baseCache.clear();
      baseCache.set(pageNo, canvas);
      paint();
    } catch {
      if (hintEl) hintEl.textContent = 'That page could not be rendered for preview — it will still be stamped.';
    } finally {
      basePending.delete(pageNo);
    }
  }

  function paint() {
    if (!stageHost) return;
    if (!state.pdf) {
      stageHost.innerHTML = '';
      viewCanvas = null;
      if (hintEl) hintEl.textContent = '';
      return;
    }
    const pageNo = previewPageNo();
    const base = baseCache.get(pageNo);
    if (!base) {
      if (hintEl) hintEl.textContent = 'Rendering preview…';
      ensureBase(pageNo);
      return;
    }
    if (!viewCanvas || viewCanvas.width !== base.width || viewCanvas.height !== base.height) {
      viewCanvas = document.createElement('canvas');
      viewCanvas.width = base.width;
      viewCanvas.height = base.height;
      stageHost.innerHTML = '';
      stageHost.appendChild(viewCanvas);
    }
    const c2 = viewCanvas.getContext('2d');
    c2.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
    c2.drawImage(base, 0, 0);
    stampCanvas(c2, viewCanvas.width, viewCanvas.height);
    if (hintEl) {
      const t = targets();
      const scope = t.length === state.pageCount
        ? `every page`
        : `${t.length} page${t.length === 1 ? '' : 's'}`;
      hintEl.textContent = `Previewing page ${pageNo} of ${state.pageCount} — ${scope} will carry this exact mark.`;
    }
  }

  /** The same plan the export draws, painted with the app font stack. */
  function stampCanvas(c2, W, H) {
    if (state.mode === 'text' && !ui.text.value.trim()) return;
    if (state.mode === 'image' && !logo.img) return;
    const plan = planStamps(W, H);
    if (!plan) return;
    const rad = (plan.A * Math.PI) / 180;
    c2.save();
    c2.globalAlpha = opacity();
    if (state.mode === 'text') {
      c2.font = `700 ${fontSize(W)}px ${FONT_STACK}`;
      c2.fillStyle = ui.colour.value;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
    }
    for (const { x, y } of plan.centers) {
      c2.save();
      c2.translate(x, y);
      c2.rotate(-rad);   // canvas is y-down, so visual counterclockwise = negative
      if (state.mode === 'text') c2.fillText(ui.text.value.trim(), 0, 0);
      else c2.drawImage(logo.img, -plan.box.w / 2, -plan.box.h / 2, plan.box.w, plan.box.h);
      c2.restore();
    }
    c2.restore();
  }

  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    schedulePaint();
    paintFacts();

    if (!state.file) { ui.explain.set(''); return; }
    if (!state.pageCount) { ui.explain.set('Reading pages…'); return; }
    const t = targets();
    if (!t.length) { ui.explain.set('That page range covers no pages yet.'); return; }

    const n = state.pageCount;
    const pagesPhrase = t.length === n
      ? `all ${n} page${n === 1 ? '' : 's'}`
      : t.length === 1 ? `page ${t[0]}` : `pages ${t[0]}–${t.at(-1)}`;
    const pct = Math.round(opacity() * 100);
    const place = ui.place.value;
    const wherePhrase = place === 'diag' ? `stamped diagonally across ${pagesPhrase}`
      : place === 'tile' ? `tiled across ${pagesPhrase}`
        : `stamped at the ${SPOT_NAME[state.spot]} of ${pagesPhrase}`;
    const tail = place === 'tile' ? ' — hard to crop out' : '';

    if (state.mode === 'text') {
      const text = ui.text.value.trim();
      if (!text) {
        ui.explain.set('Type the words to stamp — “DRAFT”, your name, or your student ID.');
        return;
      }
      const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
      ui.explain.set(`“${short}” will be ${wherePhrase} at ${pct}% opacity${tail}.`);
    } else if (!logo.img) {
      ui.explain.set('Choose the PNG or JPG logo you want stamped. One with a transparent background sits best.');
    } else {
      ui.explain.set(`Your logo will be ${wherePhrase} at ${pct}% opacity, ${ui.logoScale.value}% of the page width${tail}.`);
    }
  }

  function paintFacts() {
    if (!ui.facts) return;
    if (!state.file) { ui.facts.set([]); return; }
    const rows = [['Original size', formatBytes(state.file.size)]];
    if (state.pageCount) {
      rows.push(
        ['Total pages', String(state.pageCount)],
        ['Pages to stamp', `${targets().length} of ${state.pageCount}`],
      );
    }
    ui.facts.set(rows);
  }

  // Leaving the tool releases the canvases this pane made; the shell tears
  // down its own pieces.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    clearTimeout(paintTimer);
    baseCache.clear();
    if (viewCanvas) { viewCanvas.width = 0; viewCanvas.height = 0; viewCanvas = null; }
    if (measureCanvas) { measureCanvas.width = 0; measureCanvas.height = 0; measureCanvas = null; }
  });
}
