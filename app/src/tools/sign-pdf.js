import { PDFDocument, degrees } from 'pdf-lib';
import { el, formatBytes, loadImage, stem, toast } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, colorField, fileFacts, infoBox, liveExplain, optionPanel, segmented,
  sliderField, tabCards,
} from '../option-ui.js';

// Three honest ways to get a signature into a browser. Nobody has a scanner in
// their dorm room, so all three have to work from a phone.
const SOURCES = [
  { id: 'draw', label: 'Draw', icon: TAB_ICONS.draw, note: 'Sign with a finger, a stylus or a trackpad' },
  { id: 'type', label: 'Type', icon: TAB_ICONS.type, note: 'Type your name in a handwriting style' },
  { id: 'upload', label: 'Upload', icon: TAB_ICONS.upload, note: 'A photo of your signature on paper' },
];

// Only families that are already installed. A webfont that fails to load leaves
// a "signature" silently rendered in Arial, which is worse than no signature —
// and loading one would mean a network request, which this app does not make.
const TYPE_STYLES = [
  { id: 'flowing', label: 'Flowing', font: '"Snell Roundhand", "Apple Chancery", "Segoe Script", "Bradley Hand", cursive', italic: false },
  { id: 'formal', label: 'Formal', font: '"Times New Roman", Georgia, "Noto Serif", serif', italic: true },
  { id: 'plain', label: 'Plain', font: 'system-ui, -apple-system, "Segoe UI", sans-serif', italic: false },
];

const PAD_W = 900;            // the pad's backing store: high enough to export from
const PAD_H = 320;
const BASE_STROKE = 2.5;      // CSS px — the flat nib when there is no real pressure
const PREVIEW_SCALE = 1.5;
const MAX_PHOTO_W = 1200;     // a signature stamp never needs more than this
const SOFT_EDGE = 55;         // luminance band that fades to transparent, not a hard cut
const PAPER_MIN = 130;        // 0% removal still lifts off anything close to white
const PAPER_SPAN = 120;       // 100% removal takes everything but genuine ink

// How wide each kind of stamp starts, as a fraction of the page width.
const START_W = { signature: 0.28, initials: 0.1, date: 0.17 };
// Signature lines live near the bottom of a form, so that is where a new stamp
// lands — most of the time it only needs nudging, not moving.
const START_Y = 0.72;

const LABELS = { signature: 'Signature', initials: 'Initials', date: 'Date' };
const NOUNS = {
  signature: ['signature', 'signatures'],
  initials: ['set of initials', 'sets of initials'],
  date: ['date', 'dates'],
};

export default function render(container, tool) {
  const state = {
    file: null,
    pdf: null,
    pageCount: 0,
    page: 1,
    boxes: [],               // per page: the PDF's own crop box, in points
    rotations: [],           // per page: /Rotate, which pdf.js has already applied
    source: 'draw',
    strokes: [],             // the draw pad, as arrays of {x, y, w}
    ink: '#12203f',
    typeStyle: 'flowing',
    photo: null,             // the uploaded image, before the paper is knocked out
    stamp: null,             // the current signature, as a trimmed canvas
    stampUrl: null,
    stamps: [],              // everything placed on the document
    seq: 0,
  };

  const ui = {};
  let pad = null;
  let areaHost = null;
  let frame = null;
  let overlay = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop the form here',
    actionLabel: 'Sign PDF',
    doneTitle: 'Your PDF is signed!',
    downloadLabel: 'Download signed PDF',
    continueTo: ['compress-pdf', 'merge-pdf', 'watermark-pdf'],
    // A signature is the one thing in this whole toolbox worth holding for a
    // shorter time than everything else.
    ttlMinutes: 10,
    note: 'Send this back as the PDF it is, not as a photo of a printed page: it stays searchable, it is a tenth of the size, and the office does not have to guess at a crooked JPG.',

    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Sign');
      ui.facts = fileFacts();
      ui.explain = liveExplain();
      // Say plainly what comes out, because "Sign PDF" can mean two very
      // different things and only one of them is what this does.
      ui.what = infoBox('This prints a picture of your signature onto the page — the same thing as signing a printout and scanning it back, which is what a university office asks for. It is not a certificate-based digital signature.');

      ui.tabs = tabCards(SOURCES, (t) => {
        state.source = t.id;
        syncVisibility();
        refreshStamp();
      });

      // ---- Draw ----------------------------------------------------------
      pad = el(`<canvas width="${PAD_W}" height="${PAD_H}" style="width:100%;height:auto;display:block;background:#fff;border:1.5px solid var(--line);border-radius:9px;touch-action:none;cursor:crosshair"></canvas>`);
      const padWrap = el(`<div style="position:relative"></div>`);
      // The baseline is a DOM element, not something painted into the canvas, so
      // it guides the hand without ending up in the exported PNG.
      padWrap.append(pad, el(`<div style="position:absolute;left:8%;right:8%;bottom:24%;border-bottom:1.5px dashed var(--line);pointer-events:none"></div>`));
      wirePad();

      const padBtns = el(`<div class="opt__row"></div>`);
      const clearBtn = el(`<button class="btn small secondary" type="button" style="flex:1">Clear</button>`);
      const undoBtn = el(`<button class="btn small secondary" type="button" style="flex:1">Undo last stroke</button>`);
      clearBtn.addEventListener('click', () => { state.strokes = []; repaintPad(); refreshStamp(); });
      undoBtn.addEventListener('click', () => { state.strokes.pop(); repaintPad(); refreshStamp(); });
      padBtns.append(clearBtn, undoBtn);

      ui.draw = wrapField('Sign here', padWrap, padBtns);

      // ---- Type ----------------------------------------------------------
      ui.name = textInput('Your name', {
        placeholder: 'e.g. Kanya Suriyawong',
        onInput: refreshStamp,
      });
      ui.style = segmented(TYPE_STYLES, (s) => { state.typeStyle = s.id; refreshStamp(); });
      ui.type = wrapField('', ui.name.root, ui.style.root);

      // ---- Upload --------------------------------------------------------
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg';
      fileInput.hidden = true;
      const pickBtn = el(`<button class="btn small secondary" type="button" style="width:100%">Choose a photo of your signature</button>`);
      pickBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f) return;
        try {
          state.photo = await loadImage(f);
          refreshStamp();
        } catch (err) {
          toast(err.message);
        }
      });
      // A luminance number means nothing to anyone. The slider is a strength,
      // and the mapping to a threshold happens where the pixels are read.
      ui.threshold = sliderField('Paper removal', {
        value: 62, min: 0, max: 100, step: 1, suffix: '%',
        onChange: refreshStamp,
      });
      ui.upload = wrapField(
        'Photo of your signature',
        pickBtn, fileInput, ui.threshold.root,
        el(`<p class="opt__hint">Sign a blank sheet in a dark pen, photograph it in daylight, then slide until the paper disappears and only the ink is left.</p>`),
      );

      // ---- Ink -----------------------------------------------------------
      ui.ink = colorField('Ink colour', {
        value: state.ink,
        onChange: (v) => { state.ink = v; repaintPad(); refreshStamp(); },
      });
      const inkPresets = el(`<div class="opt__row"></div>`);
      for (const [label, hex] of [['Black', '#111111'], ['Dark blue', '#12203f']]) {
        const b = el(`<button class="btn small secondary" type="button" style="flex:1"></button>`);
        b.textContent = label;
        b.addEventListener('click', () => {
          state.ink = hex;
          ui.ink.root.querySelector('input[type="color"]').value = hex;
          ui.ink.root.querySelector('.opt__color__hex').value = hex;
          repaintPad();
          refreshStamp();
        });
        inkPresets.appendChild(b);
      }
      ui.inkRow = wrapField('', ui.ink.root, inkPresets,
        el(`<p class="opt__hint">Most Thai university offices expect dark blue on a form, so a photocopy is obviously not the original.</p>`));

      // ---- Preview + placement -------------------------------------------
      ui.preview = el(`<div style="min-height:64px;display:grid;place-items:center;background:var(--bg);border:1.5px dashed var(--line);border-radius:9px;padding:10px"></div>`);
      ui.addSig = el(`<button class="btn small" type="button" style="width:100%">Add signature to this page</button>`);
      ui.addSig.addEventListener('click', () => addStamp('signature'));
      ui.previewRow = wrapField('Your signature', ui.preview, ui.addSig);

      ui.initials = textInput('Initials', {
        placeholder: 'e.g. KS',
        hint: 'Forms with a box on every page usually want these, not a full signature.',
        onInput: update,
      });
      const addIni = el(`<button class="btn small secondary" type="button" style="flex:1">Add initials</button>`);
      const addDate = el(`<button class="btn small secondary" type="button" style="flex:1"></button>`);
      addDate.textContent = `Add date · ${todayText()}`;
      addIni.addEventListener('click', () => addStamp('initials'));
      addDate.addEventListener('click', () => addStamp('date'));
      const stampRow = el(`<div class="opt__row"></div>`);
      stampRow.append(addIni, addDate);
      ui.extras = wrapField('', ui.initials.root, stampRow);

      ui.placed = el(`<div class="opt__tokens__chips"></div>`);
      ui.placedRow = wrapField('Placed on the document', ui.placed);

      panel.add(
        ui.tabs, ui.facts, ui.what, ui.draw, ui.type, ui.upload, ui.inkRow,
        ui.previewRow, ui.extras, ui.placedRow, ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      refreshStamp();
      return {};
    },

    async run(ctx) {
      if (!state.stamps.length) {
        throw new Error('Nothing has been placed on the form yet. Make your signature, press "Add signature to this page", then drag it onto the line.');
      }

      // Fresh bytes each run: pdf-lib mutates the document it loaded, so pressing
      // the button twice would otherwise stamp the same page twice over.
      const doc = await PDFDocument.load(await state.file.arrayBuffer(), { ignoreEncryption: true });
      const embedded = new Map();   // one embed per distinct image, not per placement

      for (let i = 0; i < state.stamps.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const s = state.stamps[i];
        ctx.setBusy(i / state.stamps.length, `Placing ${LABELS[s.kind].toLowerCase()} on page ${s.page}…`);

        let img = embedded.get(s.url);
        if (!img) {
          img = await doc.embedPng(s.url);
          embedded.set(s.url, img);
        }

        const r = toUserSpace(s.page, ratioRect(s));
        const rot = state.rotations[s.page - 1] ?? 0;
        // pdf-lib rotates about the (x, y) anchor, so on a rotated page the anchor
        // moves to a different corner of the rectangle we actually want filled.
        let box = { x: r.x, y: r.y, width: r.width, height: r.height };
        if (rot === 90) box = { x: r.x + r.width, y: r.y, width: r.height, height: r.width };
        else if (rot === 180) box = { x: r.x + r.width, y: r.y + r.height, width: r.width, height: r.height };
        else if (rot === 270) box = { x: r.x, y: r.y + r.height, width: r.height, height: r.width };

        doc.getPage(s.page - 1).drawImage(img, { ...box, rotate: degrees(rot) });
        await new Promise((res) => setTimeout(res, 0));
      }

      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      return {
        outputs: [{ name: `${stem(state.file.name)}-signed.pdf`, blob }],
        doneTitle: 'Your PDF is signed!',
      };
    },

    async thumbnail(file) {
      const pdf = await openPdf(file);
      return renderPage(pdf, 1, 0.5);
    },
  });

  // -------------------------------------------------------------------------
  // Sidebar plumbing
  // -------------------------------------------------------------------------

  /** A labelled group of arbitrary nodes, in the same shape option-ui produces. */
  function wrapField(label, ...nodes) {
    const root = el(`<div class="opt__field"></div>`);
    if (label) {
      const l = el(`<label class="opt__label"></label>`);
      l.textContent = label;
      root.appendChild(l);
    }
    root.append(...nodes);
    return { root };
  }

  /**
   * option-ui has no plain text field, and inventing a CSS class here would put
   * this one tool out of step with the other forty-odd. `.opt__select` is already
   * the house text-box look, so it is reused rather than duplicated.
   */
  function textInput(label, { value = '', placeholder = '', hint, onInput } = {}) {
    const root = el(`<div class="opt__field"></div>`);
    if (label) {
      const l = el(`<label class="opt__label"></label>`);
      l.textContent = label;
      root.appendChild(l);
    }
    const input = el(`<input type="text" class="opt__select" spellcheck="false" autocomplete="off" />`);
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener('input', () => onInput?.(input.value));
    root.appendChild(input);
    if (hint) {
      const h = el(`<p class="opt__hint"></p>`);
      h.textContent = hint;
      root.appendChild(h);
    }
    return { root, get value() { return input.value; } };
  }

  function syncVisibility() {
    ui.draw.root.hidden = state.source !== 'draw';
    ui.type.root.hidden = state.source !== 'type';
    ui.upload.root.hidden = state.source !== 'upload';
    // The ink colour recolours strokes and type. An uploaded photo keeps the
    // colour of the pen it was actually signed with, so the picker would lie.
    ui.inkRow.root.hidden = state.source === 'upload';
  }

  /**
   * The rectangle a reader actually sees: the crop box clipped to the media box.
   * pdf.js clips it that way before rendering, so pdf-lib has to measure the
   * same rectangle or every stamp lands somewhere else on the page.
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

  async function loadFile() {
    const file = state.file;
    if (!file) {
      closeDoc();
      state.pageCount = 0;
      state.stamps = [];
      ui.facts.set([]);
      paint();
      update();
      return;
    }
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      throw new Error('That file is not a PDF. Choose the form you were sent — a photo of a form will not work here.');
    }

    state.stamps = [];
    state.page = 1;
    closeDoc();
    state.pdf = await openPdf(file);
    state.pageCount = state.pdf.numPages;

    // pdf-lib knows the page boxes and rotation, pdf.js knows how to draw. Both
    // are needed, and they disagree about which corner the origin sits in.
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    state.boxes = doc.getPages().map(visibleBox);
    state.rotations = doc.getPages().map(pageRotation);

    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Total pages', String(state.pageCount)],
    ]);
    await showPage(1);
  }

  // -------------------------------------------------------------------------
  // The signature itself
  // -------------------------------------------------------------------------

  function wirePad() {
    let drawing = false;

    const point = (e) => {
      const b = pad.getBoundingClientRect();
      const sx = PAD_W / (b.width || PAD_W);
      const sy = PAD_H / (b.height || PAD_H);
      return {
        x: (e.clientX - b.left) * sx,
        y: (e.clientY - b.top) * sy,
        w: nibWidth(e) * sx,
      };
    };

    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture?.(e.pointerId);
      drawing = true;
      state.strokes.push([point(e)]);
      repaintPad();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      e.preventDefault();
      state.strokes.at(-1).push(point(e));
      repaintPad();
    });
    const stop = () => {
      if (!drawing) return;
      drawing = false;
      refreshStamp();
    };
    pad.addEventListener('pointerup', stop);
    pad.addEventListener('pointercancel', stop);
  }

  /**
   * Pointer Events hand a mouse a constant 0.5 and most touchscreens either 0 or
   * 1, so only a genuine stylus reports something worth varying the nib for.
   * Everything else gets the flat line, which is what a felt-tip does anyway.
   */
  function nibWidth(e) {
    return e.pointerType === 'pen' && e.pressure > 0
      ? BASE_STROKE * (0.5 + e.pressure * 1.6)
      : BASE_STROKE;
  }

  function repaintPad() {
    if (!pad) return;
    const c = pad.getContext('2d');
    c.clearRect(0, 0, PAD_W, PAD_H);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = state.ink;
    c.fillStyle = state.ink;
    for (const stroke of state.strokes) {
      if (stroke.length === 1) {
        // A tap is a full stop, and a signature usually has one.
        c.beginPath();
        c.arc(stroke[0].x, stroke[0].y, Math.max(1, stroke[0].w / 2), 0, Math.PI * 2);
        c.fill();
        continue;
      }
      for (let i = 1; i < stroke.length; i++) {
        c.beginPath();
        c.lineWidth = Math.max(1, (stroke[i - 1].w + stroke[i].w) / 2);
        c.moveTo(stroke[i - 1].x, stroke[i - 1].y);
        c.lineTo(stroke[i].x, stroke[i].y);
        c.stroke();
      }
    }
  }

  /** Text on a transparent canvas, measured so nothing is clipped or padded oddly. */
  function renderText(text, family, italic, color, size = 170) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${italic ? 'italic ' : ''}${size}px ${family}`;
    ctx.font = font;
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent || size * 0.8;
    const descent = m.actualBoundingBoxDescent || size * 0.32;
    const padX = Math.round(size * 0.14);
    const padY = Math.round(size * 0.12);
    c.width = Math.max(8, Math.ceil(m.width) + padX * 2);
    c.height = Math.max(8, Math.ceil(ascent + descent) + padY * 2);
    // Resizing a canvas resets its context, so the font has to be set again.
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, padX, ascent + padY);
    return c;
  }

  /**
   * The touch that makes an uploaded signature look signed rather than
   * photocopied: everything paler than the threshold becomes transparent, with a
   * soft band just below it so the strokes keep their edges instead of turning
   * into a jagged stencil.
   */
  function knockOutPaper(img, threshold) {
    const scale = Math.min(1, MAX_PHOTO_W / (img.naturalWidth || img.width || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);

    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const luma = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      if (luma >= threshold) px[i + 3] = 0;
      else if (luma > threshold - SOFT_EDGE) px[i + 3] = Math.round((255 * (threshold - luma)) / SOFT_EDGE);
    }
    ctx.putImageData(data, 0, 0);
    return trim(c);
  }

  /** Crop a canvas to what was actually drawn on it, plus a hair of margin. */
  function trim(canvas, padRatio = 0.03) {
    const w = canvas.width;
    const h = canvas.height;
    const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let top = h; let left = w; let right = -1; let bottom = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 12) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (right < 0) return null;   // nothing was drawn

    const padX = Math.round((right - left + 1) * padRatio) + 4;
    const padY = Math.round((bottom - top + 1) * padRatio) + 4;
    const x0 = Math.max(0, left - padX);
    const y0 = Math.max(0, top - padY);
    const out = document.createElement('canvas');
    out.width = Math.min(w, right + 1 + padX) - x0;
    out.height = Math.min(h, bottom + 1 + padY) - y0;
    out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  function styleOf() {
    return TYPE_STYLES.find((s) => s.id === state.typeStyle) ?? TYPE_STYLES[0];
  }

  /** Rebuild the current signature from whichever tab is open. */
  function refreshStamp() {
    let canvas = null;
    if (state.source === 'draw') {
      canvas = state.strokes.length ? trim(pad) : null;
    } else if (state.source === 'type') {
      const name = ui.name.value.trim();
      const style = styleOf();
      canvas = name ? renderText(name, style.font, style.italic, state.ink) : null;
    } else if (state.photo) {
      canvas = knockOutPaper(state.photo, PAPER_MIN + ui.threshold.value * PAPER_SPAN / 100);
    }

    state.stamp = canvas;
    state.stampUrl = canvas ? canvas.toDataURL('image/png') : null;

    ui.preview.innerHTML = '';
    if (canvas) {
      const img = el(`<img alt="Your signature" style="max-width:100%;max-height:96px;display:block" />`);
      img.src = state.stampUrl;
      ui.preview.appendChild(img);
    } else {
      const line = el(`<p class="opt__hint" style="margin:0;text-align:center"></p>`);
      // "Choose a photo above" is the wrong thing to say to someone who already
      // chose one and slid the paper removal far enough to erase the ink too.
      line.textContent = state.source === 'draw'
        ? 'Nothing yet — sign in the box above.'
        : state.source === 'type'
          ? 'Nothing yet — type your name above.'
          : state.photo
            ? 'Nothing left of that photo — slide “Paper removal” down until the ink comes back.'
            : 'Nothing yet — choose a photo above.';
      ui.preview.appendChild(line);
    }
    ui.addSig.disabled = !canvas || !state.pageCount;
    update();
  }

  function todayText() {
    // d MMM yyyy — unambiguous whichever way round the reader expects the day
    // and the month, which 22/08/2026 is not.
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // -------------------------------------------------------------------------
  // Placements
  // -------------------------------------------------------------------------

  function addStamp(kind) {
    if (!state.pageCount) return;
    let canvas = null;
    if (kind === 'signature') canvas = state.stamp;
    else if (kind === 'initials') {
      const text = ui.initials.value.trim();
      if (!text) { toast('Type your initials first — two or three letters is normal.'); return; }
      const style = styleOf();
      canvas = renderText(text, style.font, style.italic, state.ink);
    } else {
      canvas = renderText(todayText(), 'system-ui, -apple-system, "Segoe UI", sans-serif', false, state.ink, 120);
    }
    if (!canvas) { toast('Make your signature first.'); return; }

    const w = START_W[kind];
    state.stamps.push({
      id: ++state.seq,
      kind,
      page: state.page,
      // Ratios, not pixels: the placement survives page navigation, a window
      // resize, and the difference between the preview scale and the real page.
      x: 0.5 - w / 2,
      y: START_Y,
      w,
      aspect: canvas.height / canvas.width,
      // Snapshot, not a live link — tweaking the pad afterwards must never
      // silently rewrite something you already placed and checked.
      url: canvas.toDataURL('image/png'),
    });
    paintStamps();
    update();
    toast(`${LABELS[kind]} added to page ${state.page} — drag it into place.`);
  }

  function removeStamp(id) {
    state.stamps = state.stamps.filter((s) => s.id !== id);
    paintStamps();
    update();
  }

  /** A stamp's full rectangle in display ratios; the height follows the image. */
  function ratioRect(s) {
    const d = displaySize(s.page);
    return { x: s.x, y: s.y, w: s.w, h: s.w * (d.w / d.h) * s.aspect };
  }

  function displaySize(pageNum) {
    const b = state.boxes[pageNum - 1] ?? { width: 595, height: 842 };
    const rot = state.rotations[pageNum - 1] ?? 0;
    return (rot === 90 || rot === 270) ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
  }

  /**
   * pdf.js draws the page the way a reader sees it: top-left origin, /Rotate
   * already applied. pdf-lib places images in the page's own coordinates:
   * bottom-left origin, unrotated. Every mapping between the two lives here.
   */
  function toUserSpace(pageNum, r) {
    const b = state.boxes[pageNum - 1];
    const rot = state.rotations[pageNum - 1] ?? 0;
    const { x: bx, y: by, width: bw, height: bh } = b;
    const { x: L, y: T, w: W, h: H } = r;

    if (rot === 90) return { x: bx + T * bw, y: by + L * bh, width: H * bw, height: W * bh };
    if (rot === 180) return { x: bx + (1 - L - W) * bw, y: by + T * bh, width: W * bw, height: H * bh };
    if (rot === 270) return { x: bx + (1 - T - H) * bw, y: by + (1 - L - W) * bh, width: H * bw, height: W * bh };
    return { x: bx + L * bw, y: by + (1 - T - H) * bh, width: W * bw, height: H * bh };
  }

  // -------------------------------------------------------------------------
  // Workarea
  // -------------------------------------------------------------------------

  async function showPage(n) {
    if (!state.pdf) return;
    state.page = Math.min(state.pageCount, Math.max(1, n));
    paint();
    const canvas = await renderPage(state.pdf, state.page, PREVIEW_SCALE);
    canvas.style.cssText = 'display:block;width:100%;height:auto';
    frame?.querySelector('canvas')?.remove();
    frame?.prepend(canvas);
    paintStamps();
    if (ui.addSig) ui.addSig.disabled = !state.stamp;
    update();
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

    frame = el(`<div style="position:relative;background:#fff;border-radius:6px;box-shadow:var(--shadow);line-height:0;touch-action:none"></div>`);
    overlay = el(`<div style="position:absolute;inset:0"></div>`);
    frame.appendChild(overlay);

    stage.append(nav, frame, el(`<p class="ts__hint" style="text-align:center">Drag a stamp to move it, pull the corner to resize. Turn the page and add another — every page keeps its own.</p>`));
    areaHost.appendChild(stage);
  }

  function paintStamps() {
    if (!overlay) return;
    overlay.innerHTML = '';
    for (const s of state.stamps.filter((p) => p.page === state.page)) {
      const box = el(`<div style="position:absolute;cursor:move;touch-action:none;outline:1.5px dashed var(--accent);outline-offset:3px"></div>`);
      box.style.left = `${s.x * 100}%`;
      box.style.top = `${s.y * 100}%`;
      box.style.width = `${s.w * 100}%`;

      const img = el(`<img alt="" style="width:100%;height:auto;display:block;pointer-events:none" />`);
      img.src = s.url;

      const grip = el(`<div style="position:absolute;right:-9px;bottom:-9px;width:17px;height:17px;background:var(--card);border:2px solid var(--accent);border-radius:4px;cursor:nwse-resize;touch-action:none"></div>`);
      const rm = el(`<button type="button" aria-label="Remove" style="position:absolute;top:-11px;right:-11px;width:22px;height:22px;border:none;border-radius:50%;background:var(--danger);color:#fff;font-size:11px;line-height:1;padding:0">✕</button>`);
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeStamp(s.id); });

      box.addEventListener('pointerdown', (e) => { if (e.target === box) drag(e, s, box, 'move'); });
      grip.addEventListener('pointerdown', (e) => drag(e, s, box, 'size'));

      box.append(img, grip, rm);
      overlay.appendChild(box);
    }
    paintChips();
  }

  function drag(e, s, box, kind) {
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width) return;
    const start = { x: s.x, y: s.y, w: s.w };
    const ox = (e.clientX - bounds.left) / bounds.width;
    const oy = (e.clientY - bounds.top) / bounds.height;
    target.setPointerCapture?.(e.pointerId);

    const move = (ev) => {
      const dx = (ev.clientX - bounds.left) / bounds.width - ox;
      const dy = (ev.clientY - bounds.top) / bounds.height - oy;
      if (kind === 'move') {
        s.x = Math.min(Math.max(-0.02, start.x + dx), 0.98);
        s.y = Math.min(Math.max(-0.02, start.y + dy), 0.98);
        box.style.left = `${s.x * 100}%`;
        box.style.top = `${s.y * 100}%`;
      } else {
        s.w = Math.min(Math.max(0.04, start.w + dx), 1.2);
        box.style.width = `${s.w * 100}%`;
      }
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      update();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  function paintChips() {
    if (!ui.placed) return;
    ui.placed.innerHTML = '';
    if (!state.stamps.length) {
      ui.placed.appendChild(el(`<p class="opt__hint" style="margin:0">Nothing placed yet.</p>`));
      return;
    }
    for (const s of [...state.stamps].sort((a, b) => a.page - b.page)) {
      const chip = el(`<span class="opt__chip"><span style="cursor:pointer"></span><button type="button" aria-label="Remove">✕</button></span>`);
      chip.querySelector('span').textContent = `Page ${s.page} · ${LABELS[s.kind]}`;
      chip.querySelector('span').addEventListener('click', () => showPage(s.page));
      chip.querySelector('button').addEventListener('click', () => removeStamp(s.id));
      ui.placed.appendChild(chip);
    }
  }

  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    paintChips();
    if (!state.pageCount) { ui.explain.set(''); return; }

    if (!state.stamps.length) {
      ui.explain.set('Nothing is on the form yet. Make your signature on the left, press “Add signature to this page”, then drag it onto the line.');
      return;
    }

    const counts = state.stamps.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
    const parts = Object.entries(counts).map(([kind, n]) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`);
    const phrase = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

    const pages = [...new Set(state.stamps.map((s) => s.page))].sort((a, b) => a - b);
    const pageList = pages.length === 1
      ? `page ${pages[0]}`
      : `pages ${pages.slice(0, -1).join(', ')} and ${pages.at(-1)}`;

    ui.explain.set(`${capitalise(phrase)} will be stamped onto ${pageList}. Everything already in the PDF stays exactly as it is.`);
  }

  function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // Leaving the tool hands the rendered page and the pdf.js worker back now,
  // rather than leaving a whole document parked in memory behind a dead screen.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    closeDoc();
    state.stamps = [];
  });
}
