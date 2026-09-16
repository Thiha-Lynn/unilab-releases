// Edit PDF — put words, pictures, boxes and freehand ink onto a page that
// already exists.
//
// This is the tool the commercial sites charge for, and the reason is that it
// is genuinely the hardest one to get right: a PDF page is not an image, so
// "just draw on it" means reconciling three coordinate systems (the browser's,
// pdf.js's and pdf-lib's) and then embedding a font that can spell the
// student's own language. Both of those are done properly below.
//
// The workarea is the real page rendered by pdf.js with an absolutely
// positioned overlay on top. Every object is stored as *ratios* of the page,
// never pixels, so the same edit survives a window resize, a phone screen and
// the jump to PDF points at export time.

import { LineCapStyle, PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { canvasToBlob, el, formatBytes, loadImage, stem, toast } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, checkRow, colorField, fileFacts, infoBox, liveExplain,
  optionPanel, segmented, sliderField, tabCards,
} from '../option-ui.js';

// The four things you can put on a page. Their ids double as the object `type`.
const TABS = [
  { id: 'text', label: 'Text', icon: TAB_ICONS.type },
  { id: 'image', label: 'Image', icon: TAB_ICONS.camera },
  { id: 'shape', label: 'Shape', icon: TAB_ICONS.pixels },
  { id: 'ink', label: 'Draw', icon: TAB_ICONS.draw },
];

const SHAPES = [
  { id: 'rect', label: 'Box' },
  { id: 'ellipse', label: 'Oval' },
  { id: 'line', label: 'Line' },
  { id: 'arrow', label: 'Arrow' },
];

const ALIGNS = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
];

const TIPS = {
  text: 'Click anywhere on the page to drop a text box there.',
  image: 'Use “Choose an image” below — a signature, a club logo, a photo of a stamp.',
  shape: 'Drag on the page to draw the box, oval, line or arrow.',
  ink: 'Draw on the page with your finger, a stylus, or the mouse.',
};

const LABELS = { text: 'a text box', image: 'a picture', shape: 'a shape', ink: 'an ink stroke' };

const HANDLING_TIP =
  'Click something to select it · drag to move · corner to resize · Delete to remove · Esc to deselect';

// One multiplier used by the preview *and* the export, so a two-line caption
// takes the same height in both. Changing it changes both at once.
const LINE_HEIGHT = 1.32;

// Latin first, so the common case matches the Helvetica the PDF will actually
// carry; the Noto faces sit behind it to catch Thai and Burmese, which
// Helvetica has no glyphs for at all. Naming only a Latin font would show a row
// of tofu boxes in the preview to exactly the students this tool exists for.
const PREVIEW_STACK =
  '"Helvetica Neue", Helvetica, Arial, "Noto Sans Thai", "Leelawadee UI", "Noto Sans Myanmar", "Myanmar Text", Padauk, sans-serif';

// The two scripts UniLab ships a font for. Everything else (Chinese, Japanese,
// Korean, Arabic, Devanagari…) gets an honest error rather than a page of
// empty boxes.
const THAI = /[\u0E00-\u0E7F]/;
const MYANMAR = /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/;

// Unmodified Google Fonts releases, SIL Open Font License 1.1 — the licence
// text sits beside them in public/fonts/OFL.txt. They are fetched same-origin,
// and only when a text object actually contains one of these scripts, so an
// English-only edit downloads nothing extra.
const FONT_FILES = {
  thai: { regular: 'NotoSansThai-Regular.ttf', bold: 'NotoSansThai-Bold.ttf' },
  myanmar: { regular: 'NotoSansMyanmar-Regular.ttf', bold: 'NotoSansMyanmar-Bold.ttf' },
};

// The smallest a shape's box is allowed to get in either direction — roughly
// eight pixels on a phone-sized stage, which is enough to grab.
const MIN_SHAPE = 0.014;

// A page rendered much larger than this costs memory for no visible gain at the
// ~700 px the workarea gives it, and phones start failing the allocation.
const RENDER_TARGET_PX = 1500;
const MAX_RENDER_PIXELS = 4_000_000;

// How many rendered pages to keep. Each one is up to four megapixels — sixteen
// megabytes — so a 200-page bundle browsed end to end would otherwise fill the
// tab's memory with pictures nobody is looking at any more.
const MAX_CACHED_PAGES = 5;

let nextId = 1;

export default function render(container, tool) {
  const state = {
    file: null,
    pdf: null,                 // the pdf.js document — for rendering the preview only
    pageCount: 0,
    pageSizes: [],             // [{ w, h }] in PDF points, already rotated and cropped
    current: 1,
    objects: [],
    selectedId: null,
    tab: 'text',
    // What a *new* object of each kind starts as, and what the sidebar shows
    // when nothing is selected. Editing a selected object writes back here too,
    // so the next thing you add inherits the look of the last thing you styled.
    defaults: {
      text: { sizeRatio: 3.2, color: '#1a1a1a', bold: false, italic: false, align: 'left', opacity: 100 },
      image: { opacity: 100, lockAspect: true },
      shape: { shape: 'rect', fillOn: false, fill: '#ffe066', strokeOn: true, stroke: '#d64545', strokeRatio: 0.35, opacity: 100 },
      ink: { stroke: '#1f6feb', strokeRatio: 0.45, opacity: 100 },
    },
  };

  const ui = {};                    // sidebar controls, filled in by options()
  const cache = new Map();          // page number → rendered canvas
  const imageUrls = new Set();      // object URLs to revoke when we leave
  let host = null;                  // the workarea host handed to us by the shell
  let dom = null;                   // the workarea skeleton, built once
  let observer = null;
  let syncing = false;              // guards segmented/tabCards .select() re-entry
  let dragging = false;             // one gesture at a time; a second finger is ignored

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a PDF here',
    actionLabel: 'Apply changes',
    doneTitle: 'Your edited PDF is ready!',
    downloadLabel: 'Download edited PDF',
    continueTo: ['sign-pdf', 'compress-pdf', 'merge-pdf'],
    note: 'Everything you add here is printed into the page, not clipped on as a note — so it survives being emailed, opened on a phone, or printed at the copy shop. Keep the file you started with: this is a one-way edit, and the original is the only way back.',

    // We own the left pane. A file list would tell a student nothing; the real
    // page with their words already on it tells them everything.
    workarea(h) { host = h; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(h) {
      const panel = optionPanel('Edit');

      ui.tabs = tabCards(TABS, (t) => {
        if (syncing) return;
        state.tab = t.id;
        // Switching tool means "I'm done with that one" — otherwise the panel
        // would claim to show Text settings while a shape is still selected.
        select(null);
      });

      ui.facts = fileFacts();
      ui.hint = infoBox(TIPS.text);

      // ---- text ----
      ui.text = textArea('Text', {
        placeholder: 'Somchai P. 6531234567\nสวัสดีครับ',
        onChange: (v) => setProp('text', v),
      });
      ui.size = sliderField('Text size', {
        value: 3.2, min: 0.6, max: 14, step: 0.1, suffix: '%',
        onChange: (v) => setProp('sizeRatio', v),
      });
      ui.align = segmented(ALIGNS, (a) => { if (!syncing) setProp('align', a.id); });
      ui.bold = checkRow('Bold', { onChange: (v) => setProp('bold', v) });
      ui.italic = checkRow('Italic', {
        hint: 'Thai and Burmese have no italic in Noto Sans — and no tradition of one — so this slants Latin letters only.',
        onChange: (v) => setProp('italic', v),
      });
      ui.color = colorField('Colour', { value: '#1a1a1a', onChange: (v) => setProp('color', v) });

      // ---- image ----
      ui.pick = buttonRow('Choose an image', () => imageInput.click());
      ui.lock = checkRow('Keep the picture’s shape', {
        checked: true, onChange: (v) => setProp('lockAspect', v),
      });

      // ---- shape ----
      ui.shape = segmented(SHAPES, (s) => { if (!syncing) setProp('shape', s.id); });
      ui.fillOn = checkRow('Fill', { onChange: (v) => setProp('fillOn', v) });
      ui.fill = colorField('Fill colour', { value: '#ffe066', onChange: (v) => setProp('fill', v) });
      ui.strokeOn = checkRow('Border', { checked: true, onChange: (v) => setProp('strokeOn', v) });

      // ---- shared by shapes and ink ----
      ui.stroke = colorField('Line colour', { value: '#d64545', onChange: (v) => setProp('stroke', v) });
      ui.strokeW = sliderField('Line thickness', {
        value: 0.35, min: 0.05, max: 3, step: 0.05, suffix: '%',
        onChange: (v) => setProp('strokeRatio', v),
      });

      // ---- everything ----
      ui.opacity = sliderField('Opacity', {
        value: 100, min: 10, max: 100, step: 1, suffix: '%',
        onChange: (v) => setProp('opacity', v),
      });
      ui.remove = buttonRow('Remove this item', () => removeSelected());
      ui.explain = liveExplain();

      panel.add(
        ui.tabs, ui.facts, ui.hint,
        ui.text, ui.size, ui.align, ui.bold, ui.italic, ui.color,
        ui.pick, ui.lock,
        ui.shape, ui.fillOn, ui.fill, ui.strokeOn,
        ui.stroke, ui.strokeW,
        ui.opacity, ui.remove, ui.explain,
      );
      h.appendChild(panel.root);
      syncPanel();
      update();
      return {};
    },

    async run(ctx) {
      const usable = state.objects.filter((o) => o.type !== 'text' || o.text.trim());
      if (!usable.length) {
        throw new Error('There is nothing on the page yet. Pick Text, Image, Shape or Draw on the right, then click the page where it should go.');
      }

      ctx.setBusy(0, 'Opening the PDF…');
      const doc = await PDFDocument.load(await state.file.arrayBuffer(), { ignoreEncryption: true });
      const pages = doc.getPages();
      const fonts = new FontBox(doc);
      const images = new Map();     // Blob → the image already embedded for it

      // Group by page so each page's geometry is worked out once, and so the
      // progress bar counts something a person can actually see happening.
      const byPage = new Map();
      for (const obj of usable) {
        if (!byPage.has(obj.page)) byPage.set(obj.page, []);
        byPage.get(obj.page).push(obj);
      }

      let done = 0;
      for (const pageNo of [...byPage.keys()].sort((a, b) => a - b)) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const page = pages[pageNo - 1];
        if (!page) continue;
        const geo = pageGeometry(page);

        for (const obj of byPage.get(pageNo)) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          ctx.setBusy(done / usable.length, `Drawing on page ${pageNo}…`);
          if (obj.type === 'text') await drawTextObject(page, geo, obj, fonts);
          else if (obj.type === 'image') await drawImageObject(doc, page, geo, obj, images);
          else drawPathObject(page, geo, obj);
          done++;
          // Yield between items, not just between pages: subsetting a Thai font
          // and encoding a photo are each long enough to freeze a phone, and
          // forty captions on one page is a perfectly ordinary lab report.
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      ctx.setBusy(0.98, 'Saving the PDF…');
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      const word = byPage.size === 1 ? 'page' : 'pages';
      return {
        outputs: [{ name: `${stem(state.file.name)}-edited.pdf`, blob }],
        doneTitle: `Your PDF has been edited on ${byPage.size} ${word}!`,
      };
    },

    async thumbnail(file) {
      const pdf = await openPdf(file);
      return renderPage(pdf, 1, 0.5);
    },
  });

  // A hidden input rather than a second drop target: the shell already owns
  // page-level dropping, and two drop targets fighting is worse than a button.
  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/png,image/jpeg,image/webp,image/*';
  imageInput.hidden = true;
  imageInput.addEventListener('change', () => {
    if (imageInput.files.length) addImage(imageInput.files[0]).catch((err) => toast(err.message));
    imageInput.value = '';
  });
  container.appendChild(imageInput);

  // =========================================================================
  // Loading the document
  // =========================================================================

  async function loadFile() {
    resetDocument();
    const file = state.file;
    if (!file) { update(); return; }

    try {
      state.pdf = await openPdf(file);
    } catch (err) {
      // pdf.js throws a PasswordException, whose message is not a sentence
      // anyone should have to read.
      if (/password/i.test(err?.name ?? '') || /password/i.test(err?.message ?? '')) {
        throw new Error('That PDF is password-protected, so nothing can be drawn onto it. Run it through Unlock PDF first, then come back here.');
      }
      throw new Error(`That file could not be opened as a PDF. ${err.message}`);
    }

    state.pageCount = state.pdf.numPages;
    state.pageSizes = [];
    for (let i = 1; i <= state.pageCount; i++) {
      const page = await state.pdf.getPage(i);
      // getViewport at scale 1 already applies /Rotate and the crop box, so
      // this is the page exactly as a reader sees it, measured in PDF points.
      const view = page.getViewport({ scale: 1 });
      state.pageSizes.push({ w: view.width, h: view.height });
    }

    ui.facts?.set([
      ['Original size', formatBytes(file.size)],
      ['Total pages', String(state.pageCount)],
      ['Page size', `${Math.round(state.pageSizes[0].w)} × ${Math.round(state.pageSizes[0].h)} pt`],
    ]);

    buildWorkarea();
    await showPage(1);
  }

  function resetDocument() {
    // destroy() resolves once the worker has let go; a page still rendering
    // rejects it, and an unhandled rejection is not worth a red console.
    state.pdf?.destroy?.()?.catch?.(() => { /* already torn down */ });
    state.pdf = null;
    state.pageCount = 0;
    state.pageSizes = [];
    state.current = 1;
    state.objects = [];
    state.selectedId = null;
    for (const url of imageUrls) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    imageUrls.clear();
    // Zeroing a canvas hands its pixel buffer back now rather than at the next
    // GC — a dozen rendered A4 pages is well over a hundred megabytes.
    for (const canvas of cache.values()) { canvas.width = 0; canvas.height = 0; }
    cache.clear();
  }

  // =========================================================================
  // The workarea: the page, the overlay, the page bar
  // =========================================================================

  function buildWorkarea() {
    if (!host || dom) return;
    host.innerHTML = '';
    const root = el(`
      <div style="max-width:760px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 14px;">
          <button class="ts__icon-btn" data-prev type="button" title="Previous page">‹</button>
          <span data-label style="font-size:13.5px;font-weight:700;color:var(--muted);min-width:120px;text-align:center;"></span>
          <button class="ts__icon-btn" data-next type="button" title="Next page">›</button>
        </div>
        <div data-stage style="position:relative;background:#fff;border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);">
          <div data-canvas></div>
          <div data-overlay style="position:absolute;inset:0;touch-action:none;"></div>
        </div>
        <p class="ts__hint" data-tip style="text-align:center;"></p>
      </div>
    `);
    dom = {
      root,
      prev: root.querySelector('[data-prev]'),
      next: root.querySelector('[data-next]'),
      label: root.querySelector('[data-label]'),
      stage: root.querySelector('[data-stage]'),
      canvasHost: root.querySelector('[data-canvas]'),
      overlay: root.querySelector('[data-overlay]'),
      tip: root.querySelector('[data-tip]'),
    };
    dom.prev.addEventListener('click', () => showPage(state.current - 1));
    dom.next.addEventListener('click', () => showPage(state.current + 1));
    dom.overlay.addEventListener('pointerdown', onStagePointerDown);
    host.appendChild(root);

    // Font sizes and line thicknesses in the overlay are pixels derived from
    // the stage's current width, so the overlay has to be repainted whenever
    // the column changes width — a phone rotating, the sidebar wrapping.
    // Never mid-gesture: a move keeps a reference to the node it is dragging,
    // and rebuilding the overlay under it would strand that reference and leave
    // the object frozen where the drag started.
    observer = new ResizeObserver(() => { if (!dragging) paintOverlay(); });
    observer.observe(dom.stage);
  }

  async function showPage(n) {
    if (!state.pdf || !dom) return;
    const page = Math.min(state.pageCount, Math.max(1, n));
    state.current = page;
    state.selectedId = null;
    dom.label.textContent = `Page ${page} of ${state.pageCount}`;
    dom.prev.disabled = page <= 1;
    dom.next.disabled = page >= state.pageCount;

    let canvas = cache.get(page);
    if (!canvas) {
      dom.canvasHost.innerHTML = '<p class="ts__hint" style="padding:60px 20px;text-align:center;">Rendering page…</p>';
      const { w, h } = state.pageSizes[page - 1];
      // Render about twice the size it will be shown at, so the text under the
      // overlay stays crisp — but never past a pixel budget a phone can hold.
      let scale = RENDER_TARGET_PX / w;
      if (w * h * scale * scale > MAX_RENDER_PIXELS) scale = Math.sqrt(MAX_RENDER_PIXELS / (w * h));
      canvas = await renderPage(state.pdf, page, scale);
      cache.set(page, canvas);
      trimCache(page);
    }
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    dom.canvasHost.innerHTML = '';
    dom.canvasHost.appendChild(canvas);
    paintOverlay();
    syncPanel();
    update();
  }

  /**
   * Drop the least recently rendered pages once the cache is over its budget.
   * A Map keeps insertion order, so the oldest key is simply the first one —
   * and the page on screen is never a candidate, however old it is.
   */
  function trimCache(keep) {
    for (const page of [...cache.keys()]) {
      if (cache.size <= MAX_CACHED_PAGES) break;
      if (page === keep) continue;
      const canvas = cache.get(page);
      // Zeroing hands the pixel buffer back now rather than at the next GC.
      canvas.width = 0;
      canvas.height = 0;
      cache.delete(page);
    }
  }

  /** Current stage size in CSS pixels — the bridge between ratios and the DOM. */
  function stagePx() {
    const rect = dom?.overlay.getBoundingClientRect();
    return { w: rect?.width || 1, h: rect?.height || 1 };
  }

  function pageObjects() {
    return state.objects.filter((o) => o.page === state.current);
  }

  function paintOverlay() {
    if (!dom) return;
    dom.overlay.innerHTML = '';
    const px = stagePx();
    for (const obj of pageObjects()) dom.overlay.appendChild(objectNode(obj, px));
    dom.overlay.style.cursor = state.tab === 'image' ? 'default' : 'crosshair';
    dom.tip.textContent = state.objects.length ? HANDLING_TIP : TIPS[state.tab];
  }

  function objectNode(obj, px) {
    const isSelected = obj.id === state.selectedId;
    const node = el(`<div data-obj="${obj.id}"></div>`);
    Object.assign(node.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      left: `${obj.xRatio * 100}%`,
      top: `${obj.yRatio * 100}%`,
      width: `${obj.wRatio * 100}%`,
      height: `${obj.hRatio * 100}%`,
      opacity: String(obj.opacity / 100),
      cursor: 'move',
      touchAction: 'none',
      outline: isSelected
        ? '1.5px solid var(--accent)'
        : '1px dashed color-mix(in srgb, var(--ink) 25%, transparent)',
      outlineOffset: '2px',
    });

    if (obj.type === 'text') {
      const size = obj.sizeRatio / 100 * px.w;
      const line = size * LINE_HEIGHT;
      const inner = el(`<div></div>`);
      Object.assign(inner.style, {
        // `pre` rather than wrapping, because the export does not wrap either:
        // what breaks a line here is a line break the student typed, and the
        // finished PDF gets exactly the same lines.
        whiteSpace: 'pre',
        font: `${obj.italic ? 'italic ' : ''}${obj.bold ? '700' : '400'} ${size}px/${line}px ${PREVIEW_STACK}`,
        color: obj.color,
        textAlign: obj.align,
        width: '100%',
      });
      // A brand-new empty box still needs something to click on.
      inner.textContent = textLines(obj.text).join('\n') || ' ';
      node.appendChild(inner);
    } else if (obj.type === 'image') {
      // The same element every time: resizing repaints the overlay on every
      // pointermove, and a fresh <img> each frame makes the picture flicker
      // while the browser re-decodes it.
      node.appendChild(obj.imgEl);
    } else {
      const w = Math.max(0.01, obj.wRatio * px.w);
      const h = Math.max(0.01, obj.hRatio * px.h);
      const strokePx = obj.strokeRatio / 100 * px.w;
      const d = obj.type === 'ink'
        ? inkPath(obj.points, w, h)
        : shapePath(obj.shape, w, h, obj.p1, obj.p2, strokePx);
      const svg = el(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path/></svg>`);
      Object.assign(svg.style, { width: '100%', height: '100%', display: 'block', overflow: 'visible' });
      const path = svg.querySelector('path');
      const filled = obj.type === 'shape' && obj.fillOn && (obj.shape === 'rect' || obj.shape === 'ellipse');
      path.setAttribute('d', d);
      path.setAttribute('fill', filled ? obj.fill : 'none');
      path.setAttribute('stroke', obj.type === 'ink' || obj.strokeOn || !filled ? obj.stroke : 'none');
      path.setAttribute('stroke-width', String(strokePx));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      // The viewBox is in the same pixels as the box, so the scale is 1 and the
      // stroke would be right anyway — but a mid-drag frame can be off by a
      // fraction, and a wobbling line thickness looks broken.
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      node.appendChild(svg);
    }

    if (isSelected) {
      const handle = el(`<span></span>`);
      Object.assign(handle.style, {
        position: 'absolute', right: '-7px', bottom: '-7px', width: '14px', height: '14px',
        borderRadius: '4px', background: 'var(--accent)', border: '2px solid #fff',
        boxShadow: 'var(--shadow)', cursor: 'nwse-resize', touchAction: 'none',
      });
      handle.addEventListener('pointerdown', (e) => startResize(e, obj));
      node.appendChild(handle);
    }

    node.addEventListener('pointerdown', (e) => startMove(e, obj));
    node.addEventListener('dblclick', () => { if (obj.type === 'text') ui.text?.focus(); });
    return node;
  }

  // =========================================================================
  // Pointer interaction
  //
  // Every gesture captures the pointer on the *overlay*, never on an object
  // node. Selecting or resizing repaints the overlay's children, and a node
  // that has been replaced mid-drag silently stops receiving pointermove — the
  // overlay itself is the one element that survives the whole gesture.
  // =========================================================================

  function gesture(e, { move, end }) {
    dragging = true;
    dom.overlay.setPointerCapture(e.pointerId);
    const onMove = (ev) => move(ev);
    const onUp = () => {
      dom.overlay.removeEventListener('pointermove', onMove);
      dom.overlay.removeEventListener('pointerup', onUp);
      dom.overlay.removeEventListener('pointercancel', onUp);
      dragging = false;
      end();
    };
    dom.overlay.addEventListener('pointermove', onMove);
    dom.overlay.addEventListener('pointerup', onUp);
    dom.overlay.addEventListener('pointercancel', onUp);
  }

  function startMove(e, obj) {
    if (dragging) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();
    select(obj.id);
    const node = dom.overlay.querySelector(`[data-obj="${obj.id}"]`);
    if (!node) return;

    const px = stagePx();
    const start = { x: e.clientX, y: e.clientY, xr: obj.xRatio, yr: obj.yRatio };
    gesture(e, {
      move(ev) {
        obj.xRatio = clampPos(start.xr + (ev.clientX - start.x) / px.w, obj.wRatio);
        obj.yRatio = clampPos(start.yr + (ev.clientY - start.y) / px.h, obj.hRatio);
        // Restyle in place: nothing about the object's contents changed, and
        // rebuilding the overlay sixty times a second would be wasteful.
        node.style.left = `${obj.xRatio * 100}%`;
        node.style.top = `${obj.yRatio * 100}%`;
      },
      end() { update(); },
    });
  }

  function startResize(e, obj) {
    if (dragging) return;
    e.stopPropagation();
    e.preventDefault();
    const px = stagePx();
    const start = { x: e.clientX, y: e.clientY, w: obj.wRatio, h: obj.hRatio, size: obj.sizeRatio };

    gesture(e, {
      move(ev) {
        const dw = (ev.clientX - start.x) / px.w;
        const dh = (ev.clientY - start.y) / px.h;
        if (obj.type === 'text') {
          // A text box has no height of its own — it is however tall its lines
          // make it. So the corner grows the *type*, which is what someone
          // dragging the corner of a caption is actually asking for.
          const factor = Math.max(0.15, (start.w + dw) / Math.max(0.02, start.w));
          obj.sizeRatio = clamp(start.size * factor, 0.6, 14);
          obj.wRatio = clamp(start.w * factor, 0.05, 1);
          syncTextBox(obj);
        } else {
          let w = clamp(start.w + dw, 0.01, 1.5);
          let h = clamp(start.h + dh, 0.01, 1.5);
          if (obj.type === 'image' && obj.lockAspect) {
            // Follow whichever edge the pointer moved further along, so the
            // drag never feels like it is fighting back.
            if (Math.abs(dw * px.w) >= Math.abs(dh * px.h)) h = (w * px.w) / obj.aspect / px.h;
            else w = (h * px.h * obj.aspect) / px.w;
          }
          obj.wRatio = w;
          obj.hRatio = h;
        }
        paintOverlay();
      },
      end() {
        if (obj.type === 'text') {
          state.defaults.text.sizeRatio = obj.sizeRatio;
          ui.size.value = Math.round(obj.sizeRatio * 10) / 10;
        }
        paintOverlay();
        update();
      },
    });
  }

  function onStagePointerDown(e) {
    if (!state.pdf || dragging) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const px = stagePx();
    const rect = dom.overlay.getBoundingClientRect();
    const at = { x: (e.clientX - rect.left) / px.w, y: (e.clientY - rect.top) / px.h };

    if (state.tab === 'ink') { e.preventDefault(); startInk(e, at, px); return; }
    if (state.tab === 'shape') { e.preventDefault(); startShape(e, at, px); return; }

    // Text and Image: a click on blank paper first means "I'm finished with
    // that one". Only a click with nothing selected makes something new, which
    // is what stops a stray tap from littering the page with empty boxes.
    if (state.selectedId) { select(null); return; }
    if (state.tab === 'text') addText(at);
  }

  function startShape(e, at, px) {
    const d = state.defaults.shape;
    select(null);
    const preview = el(`<div></div>`);
    Object.assign(preview.style, {
      position: 'absolute', border: '1.5px dashed var(--accent)', pointerEvents: 'none',
      left: `${at.x * 100}%`, top: `${at.y * 100}%`, width: '0', height: '0',
    });
    dom.overlay.appendChild(preview);
    let tip = at;

    gesture(e, {
      move(ev) {
        const rect = dom.overlay.getBoundingClientRect();
        tip = { x: (ev.clientX - rect.left) / px.w, y: (ev.clientY - rect.top) / px.h };
        preview.style.left = `${Math.min(at.x, tip.x) * 100}%`;
        preview.style.top = `${Math.min(at.y, tip.y) * 100}%`;
        preview.style.width = `${Math.abs(tip.x - at.x) * 100}%`;
        preview.style.height = `${Math.abs(tip.y - at.y) * 100}%`;
      },
      end() {
        preview.remove();
        // A tap is not a shape. Demanding a real drag means an accidental
        // touch never leaves a one-pixel box behind on someone's assignment.
        if (Math.abs(tip.x - at.x) * px.w < 8 && Math.abs(tip.y - at.y) * px.h < 8) {
          paintOverlay();
          return;
        }
        // A dead-straight line drawn left to right has no height at all, and a
        // zero-height box cannot be selected, dragged or resized. Give every
        // shape a floor, centred on what was drawn, and remember where inside
        // that box the two endpoints really were.
        let x = Math.min(at.x, tip.x);
        let y = Math.min(at.y, tip.y);
        let w = Math.abs(tip.x - at.x);
        let h = Math.abs(tip.y - at.y);
        if (w < MIN_SHAPE) { x -= (MIN_SHAPE - w) / 2; w = MIN_SHAPE; }
        if (h < MIN_SHAPE) { y -= (MIN_SHAPE - h) / 2; h = MIN_SHAPE; }
        const obj = {
          id: nextId++, type: 'shape', page: state.current,
          xRatio: x, yRatio: y, wRatio: w, hRatio: h,
          p1: { x: (at.x - x) / w, y: (at.y - y) / h },
          p2: { x: (tip.x - x) / w, y: (tip.y - y) / h },
          shape: d.shape, fillOn: d.fillOn, fill: d.fill,
          strokeOn: d.strokeOn, stroke: d.stroke, strokeRatio: d.strokeRatio, opacity: d.opacity,
        };
        state.objects.push(obj);
        select(obj.id);
      },
    });
  }

  function startInk(e, at, px) {
    const d = state.defaults.ink;
    select(null);
    const pts = [at];
    const svg = el(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px.w} ${px.h}" preserveAspectRatio="none"><path fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    const path = svg.querySelector('path');
    path.setAttribute('stroke', d.stroke);
    path.setAttribute('stroke-width', String(d.strokeRatio / 100 * px.w));
    path.setAttribute('opacity', String(d.opacity / 100));
    dom.overlay.appendChild(svg);

    gesture(e, {
      move(ev) {
        const rect = dom.overlay.getBoundingClientRect();
        const p = { x: (ev.clientX - rect.left) / px.w, y: (ev.clientY - rect.top) / px.h };
        const last = pts[pts.length - 1];
        // Drop samples closer together than a pixel. A stylus fires hundreds a
        // second and every one of them would end up in the PDF's content
        // stream, making the file bigger and the curve no smoother.
        if (Math.hypot((p.x - last.x) * px.w, (p.y - last.y) * px.h) < 1.2) return;
        pts.push(p);
        path.setAttribute('d', inkPath(pts.map((q) => ({ x: q.x * px.w, y: q.y * px.h })), 1, 1));
      },
      end() {
        svg.remove();
        if (pts.length < 2) { paintOverlay(); return; }
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        // A perfectly straight horizontal stroke has zero height, and dividing
        // by it would send every point to NaN. Give the box a floor instead.
        const w = Math.max(Math.max(...xs) - minX, 0.004);
        const h = Math.max(Math.max(...ys) - minY, 0.004);
        const obj = {
          id: nextId++, type: 'ink', page: state.current,
          xRatio: minX, yRatio: minY, wRatio: w, hRatio: h,
          points: pts.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h })),
          stroke: d.stroke, strokeRatio: d.strokeRatio, opacity: d.opacity,
        };
        state.objects.push(obj);
        select(obj.id);
      },
    });
  }

  function addText(at) {
    const d = state.defaults.text;
    const obj = {
      id: nextId++, type: 'text', page: state.current,
      xRatio: clamp(at.x, 0, 0.94), yRatio: clamp(at.y, 0, 0.96),
      wRatio: Math.max(0.12, Math.min(0.5, 1 - at.x)), hRatio: 0.05,
      text: 'Text', sizeRatio: d.sizeRatio, color: d.color,
      bold: d.bold, italic: d.italic, align: d.align, opacity: d.opacity,
    };
    syncTextBox(obj);
    state.objects.push(obj);
    select(obj.id);
    // Select the placeholder so the very first keystroke replaces it.
    ui.text?.focus(true);
  }

  async function addImage(file) {
    if (!state.pdf) return;
    const img = await loadImage(file).catch(() => {
      throw new Error(`${file.name} could not be opened as an image. JPG and PNG always work.`);
    });
    const aspect = img.naturalWidth / img.naturalHeight;

    // pdf-lib can only embed JPEG and PNG. Anything else — a WebP screenshot,
    // a converted HEIC — goes through a canvas and comes out as PNG, which is
    // also the format that keeps transparency for the signature case.
    let blob = file;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      blob = await canvasToBlob(canvas, 'image/png');
      canvas.width = 0;
      canvas.height = 0;
    }

    const url = URL.createObjectURL(blob);
    imageUrls.add(url);
    const imgEl = new Image();
    imgEl.src = url;
    imgEl.alt = '';
    Object.assign(imgEl.style, { width: '100%', height: '100%', display: 'block', objectFit: 'fill' });
    const px = stagePx();
    const wRatio = 0.34;                                   // a third of the page, to start
    const hRatio = (wRatio * px.w) / aspect / px.h;
    const obj = {
      id: nextId++, type: 'image', page: state.current,
      xRatio: (1 - wRatio) / 2, yRatio: clamp((1 - hRatio) / 2, 0.02, 0.9),
      wRatio, hRatio, blob, url, aspect, imgEl,
      opacity: state.defaults.image.opacity, lockAspect: state.defaults.image.lockAspect,
    };
    state.objects.push(obj);
    select(obj.id);
    toast(`${file.name} added — drag it where it belongs`);
  }

  // =========================================================================
  // Selection and the sidebar
  // =========================================================================

  function selected() {
    return state.objects.find((o) => o.id === state.selectedId) ?? null;
  }

  function select(id) {
    state.selectedId = id;
    const obj = selected();
    if (obj) state.tab = obj.type;
    syncing = true;
    ui.tabs?.select(Math.max(0, TABS.findIndex((t) => t.id === state.tab)));
    syncing = false;
    paintOverlay();
    syncPanel();
    update();
  }

  function removeSelected() {
    const obj = selected();
    if (!obj) return;
    if (obj.url) {
      try { URL.revokeObjectURL(obj.url); } catch { /* already gone */ }
      imageUrls.delete(obj.url);
    }
    state.objects = state.objects.filter((o) => o.id !== obj.id);
    select(null);
  }

  /** Writes one property to the selected object, or to the tool's defaults. */
  function setProp(key, value) {
    const obj = selected();
    if (obj) {
      obj[key] = value;
      // Remember it as a default too, so the next thing added matches the last
      // thing styled — which is how anyone labelling six pages expects it.
      state.defaults[obj.type][key] = value;
      if (obj.type === 'text') syncTextBox(obj);
      paintOverlay();
    } else {
      state.defaults[state.tab][key] = value;
    }
    // Fill and border have to be able to appear and disappear as they are
    // switched on, so the panel re-evaluates its own visibility every change.
    syncPanel();
    update();
  }

  /** Recomputes a text box's height from its own lines — nothing else sets it. */
  function syncTextBox(obj) {
    const lines = textLines(obj.text || ' ').length;
    const { w, h } = state.pageSizes[obj.page - 1] ?? { w: 1, h: 1 };
    obj.hRatio = (lines * (obj.sizeRatio / 100) * w * LINE_HEIGHT) / h;
  }

  function syncPanel() {
    const obj = selected();
    const kind = obj?.type ?? state.tab;
    const src = obj ?? state.defaults[kind];
    const wasSyncing = syncing;
    syncing = true;

    const solid = kind === 'shape' && (src.shape === 'rect' || src.shape === 'ellipse');
    const lineColour = kind === 'ink' || (kind === 'shape' && (!solid || src.strokeOn));
    show(ui.text, kind === 'text' && !!obj);
    show(ui.size, kind === 'text');
    show(ui.align, kind === 'text');
    show(ui.bold, kind === 'text');
    show(ui.italic, kind === 'text');
    show(ui.color, kind === 'text');
    show(ui.pick, kind === 'image');
    show(ui.lock, kind === 'image');
    show(ui.shape, kind === 'shape');
    show(ui.fillOn, solid);
    show(ui.fill, solid && src.fillOn);
    show(ui.strokeOn, solid);
    show(ui.stroke, lineColour);
    show(ui.strokeW, lineColour);
    show(ui.opacity, true);
    show(ui.remove, !!obj);

    if (kind === 'text') {
      if (obj) ui.text.value = obj.text;
      ui.size.value = src.sizeRatio;
      ui.align.select(Math.max(0, ALIGNS.findIndex((a) => a.id === src.align)));
      ui.bold.value = !!src.bold;
      ui.italic.value = !!src.italic;
      setColor(ui.color, src.color);
    }
    if (kind === 'image') ui.lock.value = !!src.lockAspect;
    if (kind === 'shape') {
      ui.shape.select(Math.max(0, SHAPES.findIndex((s) => s.id === src.shape)));
      ui.fillOn.value = !!src.fillOn;
      setColor(ui.fill, src.fill);
      ui.strokeOn.value = !!src.strokeOn;
    }
    if (lineColour) {
      setColor(ui.stroke, src.stroke);
      ui.strokeW.value = src.strokeRatio;
    }
    ui.opacity.value = src.opacity ?? 100;
    ui.hint.set(obj
      ? `Selected: ${LABELS[obj.type]} on page ${obj.page}. Drag to move it, pull the corner to resize, press Delete to remove it.`
      : TIPS[kind]);

    syncing = wasSyncing;
  }

  function update() {
    ui.explain?.set(explain());
    if (dom) dom.tip.textContent = state.objects.length ? HANDLING_TIP : TIPS[state.tab];
  }

  function explain() {
    if (!state.pageCount) return '';
    const usable = state.objects.filter((o) => o.type !== 'text' || o.text.trim());
    if (!usable.length) return 'Nothing has been added yet. Pick a tool above, then click or drag on the page.';

    const pages = new Set(usable.map((o) => o.page)).size;
    const untouched = state.pageCount - pages;
    let sentence = `${usable.length} item${usable.length === 1 ? '' : 's'} will be printed permanently onto ${pages} page${pages === 1 ? '' : 's'}`;
    sentence += untouched
      ? `, and the other ${untouched} page${untouched === 1 ? '' : 's'} stay${untouched === 1 ? 's' : ''} exactly as ${untouched === 1 ? 'it is' : 'they are'}.`
      : '.';

    // Which font is going in matters enough to say out loud: it is the
    // difference between a Thai caption that reads and one that arrives as a
    // row of empty rectangles on the lecturer's laptop.
    const scripts = new Set(
      state.objects.filter((o) => o.type === 'text' && o.text.trim()).map((o) => scriptOf(o.text)),
    );
    if (scripts.has('thai') && scripts.has('myanmar')) sentence += ' Thai and Burmese each get their own Noto font embedded in the file.';
    else if (scripts.has('thai')) sentence += ' The Thai text carries Noto Sans Thai inside the PDF, so it reads correctly on any computer.';
    else if (scripts.has('myanmar')) sentence += ' The Burmese text carries Noto Sans Myanmar inside the PDF, so it reads correctly on any computer.';
    else if (scripts.has('std')) sentence += ' The text uses the PDF’s own built-in Helvetica, so the file barely grows.';

    // "3.2% of the page width" means nothing on its own, so name the points.
    const obj = selected();
    if (obj?.type === 'text') {
      const pt = (obj.sizeRatio / 100) * (state.pageSizes[obj.page - 1]?.w ?? 595);
      sentence += ` The selected text is about ${pt.toFixed(0)} pt.`;
    }
    return sentence;
  }

  // =========================================================================
  // Keyboard
  // =========================================================================

  function onKeyDown(e) {
    if (e.key === 'Escape') { if (state.selectedId) select(null); return; }
    if (!state.selectedId) return;
    // Backspace inside the text box means "delete a letter", not "delete the
    // whole object" — a distinction worth getting right the first time.
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
    const obj = selected();
    const step = e.shiftKey ? 0.02 : 0.004;
    if (e.key === 'ArrowLeft') obj.xRatio = clampPos(obj.xRatio - step, obj.wRatio);
    else if (e.key === 'ArrowRight') obj.xRatio = clampPos(obj.xRatio + step, obj.wRatio);
    else if (e.key === 'ArrowUp') obj.yRatio = clampPos(obj.yRatio - step, obj.hRatio);
    else if (e.key === 'ArrowDown') obj.yRatio = clampPos(obj.yRatio + step, obj.hRatio);
    else return;
    e.preventDefault();
    paintOverlay();
  }
  document.addEventListener('keydown', onKeyDown);

  // Leaving the tool releases the page canvases, the image URLs, the observer
  // and the key listener; the shell only knows how to clean up its own things.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    document.removeEventListener('keydown', onKeyDown);
    observer?.disconnect();
    resetDocument();
  });

  // =========================================================================
  // Export — where the coordinate systems finally have to agree
  // =========================================================================

  /**
   * Everything needed to place a display-space ratio onto a pdf-lib page.
   *
   * Three things can each break this independently, so all three are handled
   * here rather than at every call site:
   *
   *  1. pdf-lib's origin is the bottom-left of user space and y grows upward;
   *     the overlay's origin is the top-left and y grows downward. Hence the
   *     `1 - b` at the end of `point()`.
   *  2. The visible page is the crop box, and it may sit anywhere in user
   *     space — a media box starting at (0, 421) turns up in scanned bundles
   *     all the time, and assuming (0, 0) puts everything half a page out.
   *     pdf.js renders the crop box, so pdf-lib has to use the same rectangle.
   *  3. /Rotate 90, 180 or 270 means the page a reader sees is the stored page
   *     turned clockwise by that much. pdf.js hands us the turned page; pdf-lib
   *     draws into the stored one. So `point()` maps the position backwards
   *     through the same rotation, and every draw call is additionally
   *     pre-rotated counter-clockwise by the same angle (`angle`), so the
   *     viewer's own rotation cancels it and the words come out upright.
   *     pdf-lib rotates about the anchor point it is given, which is why each
   *     draw below maps exactly one corner and leaves the size alone: lengths
   *     are unchanged by rotation, so widths and heights stay in the reader's
   *     own points throughout.
   */
  function pageGeometry(page) {
    const media = page.getMediaBox();
    const crop = page.getCropBox() ?? media;
    // Intersect the two: no viewer honours a crop box bigger than the media
    // box, and pdf.js clips it, so we must clip it the same way.
    const x0 = Math.max(media.x, crop.x);
    const y0 = Math.max(media.y, crop.y);
    const x1 = Math.min(media.x + media.width, crop.x + crop.width);
    const y1 = Math.min(media.y + media.height, crop.y + crop.height);
    const box = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };

    // /Rotate is defined as a multiple of 90, but files in the wild carry 89
    // and -270 and 450, so normalise before switching on it.
    const raw = page.getRotation().angle ?? 0;
    const rot = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
    const disp = rot % 180 === 0
      ? { w: box.width, h: box.height }
      : { w: box.height, h: box.width };

    /** (u, v) as ratios of the displayed page, v downward → a PDF user-space point. */
    const point = (u, v) => {
      let a; let b;                        // ratios of the *stored* page, b downward
      if (rot === 90) { a = v; b = 1 - u; }
      else if (rot === 180) { a = 1 - u; b = 1 - v; }
      else if (rot === 270) { a = 1 - v; b = u; }
      else { a = u; b = v; }
      return { x: box.x + a * box.width, y: box.y + (1 - b) * box.height };
    };

    return { box, rot, disp, point, angle: degrees(rot) };
  }

  async function drawTextObject(page, geo, obj, fonts) {
    const lines = textLines(obj.text);
    // The coverage probe below is given the lines joined by spaces, never the
    // raw field: WinAnsi has no code for a newline or a tab, so probing the
    // typed string would reject every perfectly ordinary two-line caption.
    const font = await fonts.get(scriptOf(obj.text), obj.bold, obj.italic, lines.join(' '));
    const size = (obj.sizeRatio / 100) * geo.disp.w;
    const lineH = size * LINE_HEIGHT;
    const boxW = obj.wRatio * geo.disp.w;
    const left = obj.xRatio * geo.disp.w;
    const top = obj.yRatio * geo.disp.h;

    // CSS puts the first baseline at half the leading plus the ascender, and so
    // does this. That single shared formula is why a two-line caption sits in
    // the same place on the finished page as it did in the preview.
    const full = font.heightAtSize(size);
    const ascent = font.heightAtSize(size, { descender: false });
    const firstBaseline = (lineH - full) / 2 + ascent;

    const color = hexToRgb(obj.color);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;                     // a blank line still advances i
      const lineW = font.widthOfTextAtSize(line, size);
      const dx = obj.align === 'center' ? (boxW - lineW) / 2
        : obj.align === 'right' ? boxW - lineW
          : 0;
      // drawText anchors at the start of the baseline and rotates about it.
      const at = geo.point((left + dx) / geo.disp.w, (top + firstBaseline + i * lineH) / geo.disp.h);
      page.drawText(line, {
        x: at.x, y: at.y, size, font, color,
        opacity: obj.opacity / 100,
        rotate: geo.angle,
      });
    }
  }

  async function drawImageObject(doc, page, geo, obj, images) {
    let embedded = images.get(obj.blob);
    if (!embedded) {
      const bytes = new Uint8Array(await obj.blob.arrayBuffer());
      embedded = obj.blob.type === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      images.set(obj.blob, embedded);
    }
    // drawImage anchors at the lower-left corner and rotates about it, so the
    // point to map is the bottom-left of the box *as the reader sees it*.
    const at = geo.point(obj.xRatio, obj.yRatio + obj.hRatio);
    page.drawImage(embedded, {
      x: at.x, y: at.y,
      width: obj.wRatio * geo.disp.w,
      height: obj.hRatio * geo.disp.h,
      opacity: obj.opacity / 100,
      rotate: geo.angle,
    });
  }

  /**
   * Shapes and ink both come out of the same two path builders the overlay
   * uses, so what lands in the PDF is the identical curve rather than a second
   * implementation that drifts away from the preview over time. drawSvgPath
   * anchors the path's own (0,0) at (x, y) and flips the y axis itself, which
   * is exactly the top-left, y-downward space the overlay already works in.
   */
  function drawPathObject(page, geo, obj) {
    const w = obj.wRatio * geo.disp.w;
    const h = obj.hRatio * geo.disp.h;
    const strokeW = (obj.strokeRatio / 100) * geo.disp.w;
    const d = obj.type === 'ink'
      ? inkPath(obj.points, w, h)
      : shapePath(obj.shape, w, h, obj.p1, obj.p2, strokeW);
    const at = geo.point(obj.xRatio, obj.yRatio);

    const opts = { x: at.x, y: at.y, rotate: geo.angle, scale: 1, borderLineCap: LineCapStyle.Round };
    const filled = obj.type === 'shape' && obj.fillOn && (obj.shape === 'rect' || obj.shape === 'ellipse');
    // These keys have to be genuinely *absent*, not set to undefined: pdf-lib
    // tests `'color' in options`, and passing an undefined one convinces it the
    // shape has both a fill and a border, after which it draws neither.
    if (filled) {
      opts.color = hexToRgb(obj.fill);
      opts.opacity = obj.opacity / 100;
    }
    if (obj.type === 'ink' || obj.strokeOn || !filled) {
      opts.borderColor = hexToRgb(obj.stroke);
      opts.borderWidth = Math.max(0.2, strokeW);
      opts.borderOpacity = obj.opacity / 100;
    }
    page.drawSvgPath(d, opts);
  }

  // =========================================================================
  // Fonts
  // =========================================================================

  /** Which of our three font families can spell this string. */
  function scriptOf(text) {
    if (THAI.test(text)) return 'thai';
    if (MYANMAR.test(text)) return 'myanmar';
    return 'std';
  }

  /**
   * Embeds fonts on demand and keeps one copy of each in the document.
   *
   * The common case — a name, a student ID, a date, a "Approved" — is pure
   * Latin, and pdf-lib writes that with the PDF's own built-in Helvetica: no
   * download, no embedded font, no extra bytes. Only when a text object really
   * contains Thai or Burmese do we pull in fontkit and a Noto face, and even
   * then `subset: true` means the finished PDF carries just the handful of
   * glyphs that were actually typed rather than the whole 180 KB family.
   */
  class FontBox {
    constructor(doc) {
      this.doc = doc;
      this.cache = new Map();
      this.fontkitReady = false;
    }

    async std(bold, italic) {
      const name = bold && italic ? StandardFonts.HelveticaBoldOblique
        : bold ? StandardFonts.HelveticaBold
          : italic ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
      if (!this.cache.has(name)) this.cache.set(name, await this.doc.embedFont(name));
      return this.cache.get(name);
    }

    async get(script, bold, italic, text) {
      if (script === 'std') {
        const font = await this.std(bold, italic);
        try {
          // The cheapest coverage check available, and the most accurate: ask
          // the font itself. Helvetica is WinAnsi-only, so anything outside it
          // throws here instead of silently vanishing off the finished page.
          font.encodeText(text);
          return font;
        } catch {
          throw new Error(`“${firstOddCharacter(text, font)}” is not a letter this tool can put into a PDF. UniLab ships fonts for English, Thai and Burmese; other scripts need a font we would have to redistribute. Add Text to Image will handle that passage as a picture instead.`);
        }
      }

      const key = `${script}-${bold ? 'bold' : 'regular'}`;
      if (this.cache.has(key)) return this.cache.get(key);

      if (!this.fontkitReady) {
        // Imported only at this point: fontkit is a large module, and an
        // English-only edit should never have to download it.
        const { default: fontkit } = await import('@pdf-lib/fontkit');
        this.doc.registerFontkit(fontkit);
        this.fontkitReady = true;
      }

      const file = FONT_FILES[script][bold ? 'bold' : 'regular'];
      const url = new URL(`${import.meta.env.BASE_URL}fonts/${file}`, document.baseURI);
      let bytes;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw new Error(`The ${script === 'thai' ? 'Thai' : 'Burmese'} font could not be loaded from this site (${err.message}). It comes from this page, not from anywhere else, so check your connection and press the button again — it is only needed once.`);
      }
      // Noto Sans Thai and Noto Sans Myanmar have no italic cut, and neither
      // script uses one typographically, so an italic tick is ignored here
      // rather than faked with a skew that would tear the vowel marks off.
      const font = await this.doc.embedFont(bytes, { subset: true });
      this.cache.set(key, font);
      return font;
    }
  }

  /** The first character in `text` this font genuinely cannot write. */
  function firstOddCharacter(text, font) {
    for (const ch of text) {
      try { font.encodeText(ch); } catch { return ch; }
    }
    return text.slice(0, 1);
  }

  // =========================================================================
  // Small local controls
  // =========================================================================

  /** A multi-line text field in the sidebar's house style. */
  function textArea(label, { placeholder = '', onChange } = {}) {
    const root = el(`
      <div class="opt__field">
        <label class="opt__label"></label>
        <textarea class="input" rows="3" spellcheck="false" style="width:100%;resize:vertical"></textarea>
      </div>
    `);
    root.querySelector('.opt__label').textContent = label;
    const field = root.querySelector('textarea');
    field.placeholder = placeholder;
    field.addEventListener('input', () => onChange?.(field.value));
    return {
      root,
      get value() { return field.value; },
      set value(v) { if (field.value !== v) field.value = v; },
      focus(selectAll) { field.focus(); if (selectAll) field.select(); },
    };
  }

  /** A full-width action button that sits in the option flow. */
  function buttonRow(label, onClick) {
    const root = el(`<div class="opt__field"><button class="btn small secondary" type="button" style="width:100%"></button></div>`);
    const button = root.querySelector('button');
    button.textContent = label;
    button.addEventListener('click', onClick);
    return { root, el: button };
  }

  /**
   * colorField in option-ui.js exposes a getter but no setter, and this sidebar
   * has to follow the selection, so we reach into its two inputs. It is the one
   * control in that vocabulary missing a `set value` — worth adding there.
   */
  function setColor(handle, hex) {
    if (!handle || !hex) return;
    const [picker, text] = handle.root.querySelectorAll('input');
    picker.value = hex;
    text.value = hex;
  }

  function show(handle, visible) { if (handle) handle.root.hidden = !visible; }
}

// ===========================================================================
// Pure geometry — shared by the overlay and the export, and deliberately unit
// agnostic: the caller passes CSS pixels for the preview and PDF points for
// the file, and gets back the same shape either way.
// ===========================================================================

/**
 * The lines a text object will actually be drawn as. Tabs become four spaces
 * because WinAnsi has no code for a tab at all, and a tab that reaches
 * pdf-lib's encoder throws rather than indenting anything; four spaces is what
 * the preview shows too, so the two agree.
 */
function textLines(text) {
  return (text ?? '').replace(/\t/g, '    ').split(/\r?\n/);
}

const KAPPA = 0.5522847498307936;
const round2 = (v) => (Math.round(v * 100) / 100).toString();

/**
 * One shape as an SVG path, in a box `w` × `h` with (0,0) at the top-left and
 * y growing downward. A line or an arrow carries its own two endpoints as
 * fractions of that box rather than being assumed to run corner to corner:
 * that is what lets a dead-straight horizontal arrow keep a box tall enough to
 * grab hold of, instead of collapsing to a zero-height sliver.
 */
function shapePath(kind, w, h, p1, p2, strokeW) {
  if (kind === 'rect') {
    return `M 0 0 L ${round2(w)} 0 L ${round2(w)} ${round2(h)} L 0 ${round2(h)} Z`;
  }

  if (kind === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    const ox = rx * KAPPA;
    const oy = ry * KAPPA;
    return [
      `M 0 ${round2(ry)}`,
      `C 0 ${round2(ry - oy)} ${round2(rx - ox)} 0 ${round2(rx)} 0`,
      `C ${round2(rx + ox)} 0 ${round2(w)} ${round2(ry - oy)} ${round2(w)} ${round2(ry)}`,
      `C ${round2(w)} ${round2(ry + oy)} ${round2(rx + ox)} ${round2(h)} ${round2(rx)} ${round2(h)}`,
      `C ${round2(rx - ox)} ${round2(h)} 0 ${round2(ry + oy)} 0 ${round2(ry)}`,
      'Z',
    ].join(' ');
  }

  const from = { x: p1.x * w, y: p1.y * h };
  const to = { x: p2.x * w, y: p2.y * h };
  const shaft = `M ${round2(from.x)} ${round2(from.y)} L ${round2(to.x)} ${round2(to.y)}`;
  if (kind === 'line') return shaft;

  // Arrow head: two barbs swept back from the tip, long enough to read at this
  // line weight but never more than a third of the arrow itself, so a short
  // arrow does not turn into a solid triangle.
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const head = Math.min(len / 3, Math.max(strokeW * 4, len * 0.22));
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = (spread) => ({
    x: to.x - head * Math.cos(angle + spread),
    y: to.y - head * Math.sin(angle + spread),
  });
  const a = barb(0.45);
  const b = barb(-0.45);
  return `${shaft} M ${round2(a.x)} ${round2(a.y)} L ${round2(to.x)} ${round2(to.y)} L ${round2(b.x)} ${round2(b.y)}`;
}

/**
 * Freehand points (normalised 0–1 inside their own box) as a smooth path.
 * Quadratic segments through the midpoints of consecutive samples turn a
 * jittery list of pointer events into something that reads as a pen stroke,
 * and pdf-lib's SVG path parser understands `Q`, so the PDF receives the exact
 * curve the screen showed rather than a polyline approximation of it.
 */
function inkPath(points, w, h) {
  const p = points.map((q) => [q.x * w, q.y * h]);
  if (!p.length) return 'M 0 0';
  if (p.length === 1) return `M ${round2(p[0][0])} ${round2(p[0][1])} L ${round2(p[0][0])} ${round2(p[0][1])}`;
  let d = `M ${round2(p[0][0])} ${round2(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2;
    const my = (p[i][1] + p[i + 1][1]) / 2;
    d += ` Q ${round2(p[i][0])} ${round2(p[i][1])} ${round2(mx)} ${round2(my)}`;
  }
  const last = p[p.length - 1];
  return `${d} L ${round2(last[0])} ${round2(last[1])}`;
}

function hexToRgb(hex) {
  const v = Number.parseInt((hex || '#000000').slice(1), 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Keeps at least a sliver of an object on the page, however hard you drag. */
function clampPos(v, extent) { return clamp(v, -extent + 0.03, 0.97); }
