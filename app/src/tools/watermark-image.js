import JSZip from 'jszip';
import { canvasToBlob, downloadBlob, el, formatBytes, loadImage, stem, MIME_EXT } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, colorField, fileFacts, liveExplain, optionPanel, selectField, sliderField, tabCards,
} from '../option-ui.js';
// The same three stacks every UniLab tool that writes on a picture uses. Each
// one ends in the app's own font list rather than in a Latin-only face, so a
// mark that mixes English with Thai or Burmese still comes out as letters:
// canvas falls back per character to whatever the device already has for that
// script. Naming a webfont here would give a row of tofu boxes — and fetching
// one would break the promise that nothing leaves this page.
import { FONTS } from '../text-draw.js';

const MODES = [
  { id: 'text', label: 'Text', icon: TAB_ICONS.type, note: 'Your name, your student ID, "draft" — anything you can type.' },
  { id: 'image', label: 'Image', icon: TAB_ICONS.upload, note: 'A logo or a signature saved as a PNG.' },
];

// Tile first: a faint mark repeated over the whole photo is the only placement
// that actually costs someone something to remove, which is the reason a
// student watermarks a photo of their own artwork in the first place. A corner
// stamp is a signature; a tile is a deterrent.
const SPOTS = [
  { id: 'tile', label: 'Tile — repeated over the whole photo' },
  { id: 'tl', label: 'Top left' },
  { id: 'tc', label: 'Top centre' },
  { id: 'tr', label: 'Top right' },
  { id: 'ml', label: 'Middle left' },
  { id: 'mc', label: 'Centre' },
  { id: 'mr', label: 'Middle right' },
  { id: 'bl', label: 'Bottom left' },
  { id: 'bc', label: 'Bottom centre' },
  { id: 'br', label: 'Bottom right' },
];

const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;
// The preview is a scaled copy, not the real photo: every measurement below is
// a fraction of the canvas width, so the same numbers land in the same place on
// a 900 px preview and a 4032 px original.
const PREVIEW_MAX = 1280;
const MARGIN_FRACTION = 0.045;
// A pathological combination (tiny text, huge photo) could ask for a hundred
// thousand fillText calls. Stop long before the tab does.
const MAX_TILES = 3000;

export default function render(container, tool) {
  const state = { files: [], index: 0, mode: 'text' };
  const ui = {};
  const logo = { file: null, img: null };
  // The decoded, scaled copy of whichever photo is being previewed.
  const preview = { file: null, canvas: null, w: 0, h: 0 };
  const thumbUrls = new Map();   // File → object URL for its strip thumbnail

  let stageHost = null;
  let hintEl = null;
  let stripHost = null;
  let previewCanvas = null;
  let paintTimer = null;
  let paintToken = 0;
  let stripKey = null;
  let previewWanted = null;   // the file a decode is currently in flight for
  let previewFailed = null;   // a file the browser could not open — do not retry it forever

  const shell = toolShell(container, tool, {
    accept: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
    multiple: true,
    sortable: true,
    pickLabel: 'Select images',
    dropLabel: 'or drop them here — as many as you like',
    actionLabel: 'Add watermark',
    doneTitle: 'Your photos are marked!',
    downloadLabel: 'Download watermarked image',
    continueTo: ['compress-image', 'resize-image', 'image-text'],
    note: 'Before a photo of your own drawing, your notes or your ID goes into a group chat, a tiled mark at 20–25% opacity is the setting that survives a screenshot and a crop. A single corner stamp is easy to cut off. Everything here is drawn by your browser — the photo and the logo both stay on this device.',

    // The left pane is the photo with the mark already on it, at the real
    // proportions, rather than a list of filenames.
    workarea(host) {
      ensurePane(host);
      syncStrip();
      schedulePaint();
    },

    async onFiles(ctx) {
      state.files = ctx.files;
      if (state.index >= ctx.files.length) state.index = 0;
      await refreshPreviewSource();
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
        value: 'Your name · ชื่อของคุณ',
        placeholder: 'Somchai P. · 6531234567',
        onInput: update,
      });
      ui.colour = colorField('Colour', { value: '#ffffff', onChange: update });
      ui.textOpacity = sliderField('Opacity', { value: 25, min: 5, max: 100, suffix: '%', onChange: update });
      ui.size = sliderField('Size', { value: 9, min: 2, max: 40, step: 0.5, suffix: '% of width', onChange: update });
      ui.rotation = sliderField('Rotation', { value: -30, min: -90, max: 90, step: 5, suffix: '°', onChange: update });
      ui.font = selectField('Font', Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label })), {
        value: 'system',
        hint: 'All three fall back to the fonts already on your device, so Thai and Burmese come out as letters, not boxes.',
        onChange: update,
      });

      // ---- image mark ----
      ui.logoField = el(`<div class="opt__field"><label class="opt__label">Logo or signature</label></div>`);
      ui.logoPick = el(`<button class="opt__add" type="button">+ Choose a PNG</button>`);
      ui.logoName = el(`<p class="opt__hint">Nothing chosen yet. A PNG with a transparent background looks best.</p>`);
      ui.logoField.append(ui.logoPick, ui.logoName);
      const logoInput = document.createElement('input');
      logoInput.type = 'file';
      logoInput.accept = 'image/png,image/jpeg,image/webp';
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

      ui.logoOpacity = sliderField('Logo opacity', { value: 35, min: 5, max: 100, suffix: '%', onChange: update });
      ui.logoScale = sliderField('Logo size', { value: 22, min: 3, max: 100, step: 1, suffix: '% of width', onChange: update });

      // ---- shared ----
      ui.spot = selectField('Placement', SPOTS, { value: 'tile', onChange: update });

      panel.add(
        ui.tabs, ui.facts,
        ui.text, ui.colour, ui.textOpacity, ui.size, ui.rotation, ui.font,
        ui.logoField, ui.logoOpacity, ui.logoScale,
        ui.spot, ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      const files = ctx.files;
      if (!files.length) throw new Error('Add at least one photo first.');
      if (state.mode === 'text' && !ui.text.value.trim()) {
        throw new Error('Type the words you want stamped on the photos — your name, or your student ID.');
      }
      if (state.mode === 'image' && !logo.img) {
        throw new Error('Choose the logo image you want stamped on the photos first.');
      }

      const outputs = [];
      const naming = uniqueNames();
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const file = files[i];
        ctx.setBusy(i / files.length, `Marking ${file.name} — ${i + 1} of ${files.length}…`);
        const made = await markOne(file);
        outputs.push({ name: naming(made.name), blob: made.blob });
        // Full-resolution work between yields: a 12 MP decode, a composite and
        // a re-encode. Without this the cancel button never gets a turn.
        await new Promise((r) => setTimeout(r, 0));
      }

      return {
        outputs,
        doneTitle: outputs.length > 1
          ? `All ${outputs.length} photos are marked!`
          : 'Your photo is marked!',
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-watermarked.zip');
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Sidebar plumbing

  /**
   * Two photos picked from two different folders can share a filename, and a
   * ZIP is keyed by name — the second entry would quietly replace the first and
   * the student would get fewer files than the button promised. This hands the
   * repeats a -2, -3 suffix instead.
   */
  function uniqueNames() {
    const used = new Set();
    return (name) => {
      if (!used.has(name)) { used.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const base = dot < 1 ? name : name.slice(0, dot);
      const ext = dot < 1 ? '' : name.slice(dot);
      let n = 2;
      while (used.has(`${base}-${n}${ext}`)) n++;
      used.add(`${base}-${n}${ext}`);
      return `${base}-${n}${ext}`;
    };
  }

  /**
   * A one-line text input in the house style. option-ui.js has no text field
   * yet, and `.opt__select` is the same bordered box every other field uses.
   */
  function textField(label, { value = '', placeholder = '', hint, onInput } = {}) {
    const root = el(`<div class="opt__field"><label class="opt__label"></label></div>`);
    root.querySelector('.opt__label').textContent = label;
    const input = el(`<input type="text" class="opt__select" spellcheck="false" />`);
    input.value = value;
    input.placeholder = placeholder;
    root.appendChild(input);
    if (hint) { const h = el(`<p class="opt__hint"></p>`); h.textContent = hint; root.appendChild(h); }
    input.addEventListener('input', () => onInput?.(input.value));
    return { root, get value() { return input.value; } };
  }

  function syncVisibility() {
    const text = state.mode === 'text';
    for (const key of ['text', 'colour', 'textOpacity', 'size', 'rotation', 'font']) ui[key].root.hidden = !text;
    for (const node of [ui.logoField, ui.logoOpacity.root, ui.logoScale.root]) node.hidden = text;
  }

  /** The opacity slider that belongs to the tab currently showing, as 0…1. */
  function opacity() {
    return (state.mode === 'text' ? ui.textOpacity.value : ui.logoOpacity.value) / 100;
  }

  // -------------------------------------------------------------------------
  // Drawing the mark. Everything here is expressed as a fraction of the canvas
  // it is given, so the preview and the full-size export are the same picture.

  /** Where a mark sits inside a W×H canvas, for the nine fixed placements. */
  function anchorFor(spot, W, H) {
    const m = Math.round(W * MARGIN_FRACTION);
    const col = spot[1];
    const row = spot[0];
    const x = col === 'l' ? m : col === 'r' ? W - m : W / 2;
    const y = row === 't' ? m : row === 'b' ? H - m : H / 2;
    return {
      x,
      y,
      align: col === 'l' ? 'left' : col === 'r' ? 'right' : 'center',
      baseline: row === 't' ? 'top' : row === 'b' ? 'bottom' : 'middle',
    };
  }

  /** Draws the current watermark onto a 2D context of logical size W×H. */
  function stamp(c2, W, H) {
    if (!ui.spot) return;            // the sidebar has not been built yet
    const spot = ui.spot.value;
    c2.save();
    c2.globalAlpha = opacity();
    if (state.mode === 'text') stampText(c2, W, H, spot);
    else stampLogo(c2, W, H, spot);
    c2.restore();
  }

  function stampText(c2, W, H, spot) {
    const text = ui.text.value.trim();
    if (!text) return;
    // A minimum of 6 px keeps a 2% mark on a thumbnail-sized image legible
    // rather than a smudge.
    const fontSize = Math.max(6, (W * ui.size.value) / 100);
    c2.font = `700 ${fontSize}px ${FONTS[ui.font.value].stack}`;
    c2.fillStyle = ui.colour.value;
    const rad = (ui.rotation.value * Math.PI) / 180;

    if (spot !== 'tile') {
      const { x, y, align, baseline } = anchorFor(spot, W, H);
      // Rotate about the anchor, not the canvas centre, so a corner mark stays
      // in its corner however far it is turned.
      c2.translate(x, y);
      c2.rotate(rad);
      c2.textAlign = align;
      c2.textBaseline = baseline;
      c2.fillText(text, 0, 0);
      return;
    }

    const markW = Math.max(1, c2.measureText(text).width);
    let stepX = markW + fontSize * 1.5;
    let stepY = fontSize * 2.6;
    // The grid is drawn rotated, so it has to cover the photo's diagonal in
    // both directions or the corners come out bare.
    const half = Math.hypot(W, H) / 2;
    const tilesFor = (sx, sy) => (Math.ceil((2 * (half + sy)) / sx) + 1) * (Math.ceil((2 * (half + sy)) / sy) + 1);
    if (tilesFor(stepX, stepY) > MAX_TILES) {
      // A very small mark on a very big photo could ask for forty thousand
      // fillText calls, which would hang the tab. Spreading the grid out keeps
      // it a tile — still repeated over the whole photo, just with more air
      // between the marks — rather than quietly becoming a single stamp the
      // sidebar never promised.
      const spread = Math.sqrt(tilesFor(stepX, stepY) / MAX_TILES);
      stepX *= spread;
      stepY *= spread;
    }
    const reach = half + stepY;
    c2.translate(W / 2, H / 2);
    c2.rotate(rad);
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    let row = 0;
    for (let y = -reach; y <= reach; y += stepY, row++) {
      // Offset every other row by half a step: a brick pattern leaves no clean
      // vertical alley to crop the photo down.
      const offset = row % 2 ? stepX / 2 : 0;
      for (let x = -reach + offset; x <= reach; x += stepX) c2.fillText(text, x, y);
    }
  }

  function stampLogo(c2, W, H, spot) {
    if (!logo.img) return;
    const lw = logo.img.naturalWidth;
    const lh = logo.img.naturalHeight;
    const drawW = Math.max(1, (W * ui.logoScale.value) / 100);
    const drawH = Math.max(1, (drawW * lh) / lw);

    if (spot !== 'tile') {
      const { x, y, align, baseline } = anchorFor(spot, W, H);
      const left = align === 'left' ? x : align === 'right' ? x - drawW : x - drawW / 2;
      const top = baseline === 'top' ? y : baseline === 'bottom' ? y - drawH : y - drawH / 2;
      c2.drawImage(logo.img, left, top, drawW, drawH);
      return;
    }

    let stepX = drawW * 1.6;
    let stepY = drawH * 1.9;
    // Same rule as the text tile: a tiny logo on a huge photo gets a coarser
    // grid, never a silent demotion to one stamp in the middle.
    const tilesFor = (sx, sy) => (Math.ceil(W / sx) + 2) * (Math.ceil(H / sy) + 2);
    if (tilesFor(stepX, stepY) > MAX_TILES) {
      const spread = Math.sqrt(tilesFor(stepX, stepY) / MAX_TILES);
      stepX *= spread;
      stepY *= spread;
    }
    let row = 0;
    for (let y = -stepY / 2; y < H + stepY; y += stepY, row++) {
      const offset = row % 2 ? stepX / 2 : 0;
      for (let x = -stepX / 2 + offset; x < W + stepX; x += stepX) {
        c2.drawImage(logo.img, x, y, drawW, drawH);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The export

  async function markOne(file) {
    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error(`${file.name} came back with no pixels. Try re-saving it as a JPG or PNG, then mark it.`);
    if (w * h > MAX_PIXELS || w > MAX_SIDE || h > MAX_SIDE) {
      throw new Error(`${file.name} is ${w}×${h}, which is bigger than a browser canvas can hold — phones especially. Shrink it with Resize Image first, then come back.`);
    }

    // JPG has no transparency, so a PNG with holes in it would come out with
    // black patches. Painting white first matches what the preview shows.
    const type = MIME_EXT[file.type] ? file.type : 'image/png';
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c2 = canvas.getContext('2d');
    if (type === 'image/jpeg') { c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, w, h); }
    c2.drawImage(img, 0, 0);
    // The mark is drawn at the photo's own resolution — not scaled up from the
    // preview — so the text stays as crisp as the photo it sits on.
    stamp(c2, w, h);

    const blob = await canvasToBlob(canvas, type, type === 'image/png' ? undefined : 0.92);
    // Hand ~48 MB of RGBA back now rather than at the next GC; the next photo
    // in the batch is usually the same size.
    canvas.width = 0;
    canvas.height = 0;
    return { name: `${stem(file.name)}-watermarked.${MIME_EXT[type]}`, blob };
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
        <div class="ts__group__pages" data-strip style="margin-top:14px"></div>
      </div>
    `);
    host.appendChild(wrap);
    stageHost = wrap.querySelector('[data-stage]');
    hintEl = wrap.querySelector('[data-hint]');
    stripHost = wrap.querySelector('[data-strip]');
  }

  /**
   * The row of small photos under the preview: click one to preview it. update()
   * runs on every keystroke and every slider tick, so the DOM (and the object
   * URL behind each thumbnail) is only rebuilt when the file list itself
   * changes — minting a URL per redraw would leak a photo's worth of memory
   * every few milliseconds.
   */
  function syncStrip() {
    if (!stripHost) return;
    // One photo needs no chooser — the preview above already is that photo.
    const show = state.files.length > 1;
    stripHost.hidden = !show;
    const key = show ? state.files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|') : '';
    if (key !== stripKey) { stripKey = key; buildStrip(show); }
    [...stripHost.children].forEach((cell, i) => {
      cell.style.outline = i === state.index ? '2px solid var(--cc, var(--accent))' : 'none';
    });
  }

  function buildStrip(show) {
    stripHost.innerHTML = '';
    // Any photo no longer in the list takes its thumbnail URL with it.
    for (const [file, url] of [...thumbUrls]) {
      if (!show || !state.files.includes(file)) { URL.revokeObjectURL(url); thumbUrls.delete(file); }
    }
    if (!show) return;
    state.files.forEach((file, i) => {
      const cell = el(`
        <div class="ts__page" style="cursor:pointer">
          <img alt="" style="display:block;max-width:76px;height:auto;border-radius:3px" />
          <span class="ts__page__n"></span>
          <div class="ts__card__acts" style="opacity:1;top:2px;right:2px">
            <button class="ts__card__btn" type="button" title="Remove this photo">✕</button>
          </div>
        </div>
      `);
      let url = thumbUrls.get(file);
      if (!url) { url = URL.createObjectURL(file); thumbUrls.set(file, url); }
      cell.querySelector('img').src = url;
      cell.querySelector('.ts__page__n').textContent = String(i + 1);
      cell.addEventListener('click', () => {
        state.index = i;
        refreshPreviewSource().then(update);
      });
      cell.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        removeAt(i);
      });
      stripHost.appendChild(cell);
    });
  }

  /**
   * Defining workarea() means the shell hides its own file cards, so removing a
   * photo has to happen here. Splicing the shell's own array and refreshing is
   * exactly what its ✕ button does; an empty list goes back to the uploader,
   * because a work screen with no file in it is a dead end.
   */
  function removeAt(i) {
    state.files.splice(i, 1);
    if (state.index >= state.files.length) state.index = Math.max(0, state.files.length - 1);
    refreshPreviewSource().then(() => {
      shell.refresh();
      if (!state.files.length) shell.stage('upload');
    });
  }

  /** Decodes the selected photo once, scaled down, and keeps it for redraws. */
  async function refreshPreviewSource() {
    const file = state.files[state.index] ?? null;
    if (!file) { previewWanted = null; releasePreview(); paint(); return; }
    // update() runs on every slider tick, so without these a slow decode would
    // be started again on each one — and a photo this browser simply cannot
    // open would be retried forever.
    if (preview.file === file || previewWanted === file || previewFailed === file) return;
    previewWanted = file;
    const token = ++paintToken;
    try {
      const img = await loadImage(file);
      if (token !== paintToken) return;   // the student clicked another photo
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) throw new Error('no pixels');
      const scale = Math.min(1, PREVIEW_MAX / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      releasePreview();
      preview.file = file;
      preview.canvas = c;
      preview.w = w;
      preview.h = h;
      previewFailed = null;
    } catch {
      releasePreview();
      previewFailed = file;
    }
    if (previewWanted === file) previewWanted = null;
    paint();
  }

  function releasePreview() {
    if (preview.canvas) { preview.canvas.width = 0; preview.canvas.height = 0; }
    preview.file = null;
    preview.canvas = null;
    preview.w = 0;
    preview.h = 0;
  }

  /**
   * Every slider fires on each pixel of drag. Redrawing a 1280 px canvas plus a
   * few hundred tiles on every one of those events is what makes a preview feel
   * broken, so the redraw waits for the drag to settle.
   */
  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paint, 80);
  }

  function paint() {
    if (!stageHost) return;
    if (!preview.canvas) {
      stageHost.innerHTML = '';
      previewCanvas = null;
      if (hintEl) {
        hintEl.textContent = state.files.length
          ? 'That photo could not be opened here. Remove it below, or try re-saving it as a JPG or PNG.'
          : '';
      }
      return;
    }
    if (!previewCanvas || previewCanvas.width !== preview.canvas.width || previewCanvas.height !== preview.canvas.height) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.width = preview.canvas.width;
      previewCanvas.height = preview.canvas.height;
      stageHost.innerHTML = '';
      stageHost.appendChild(previewCanvas);
    }
    const c2 = previewCanvas.getContext('2d');
    c2.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    c2.drawImage(preview.canvas, 0, 0);
    stamp(c2, previewCanvas.width, previewCanvas.height);

    if (hintEl) {
      const n = state.files.length;
      hintEl.textContent = n > 1
        ? `Previewing photo ${state.index + 1} of ${n} — ${preview.w}×${preview.h}. Every photo gets the same mark, drawn at its own full size.`
        : `${preview.w}×${preview.h}. The preview is scaled to fit this pane; the file you download keeps every pixel.`;
    }
  }

  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    // The A-Z sort button reorders the shell's own array underneath us, so the
    // photo the index points at may no longer be the one decoded for the
    // preview. Catch it up rather than captioning the wrong picture.
    if (state.files.length && state.files[state.index] !== preview.file) refreshPreviewSource();
    syncStrip();
    schedulePaint();
    paintFacts();

    const n = state.files.length;
    if (!n) { ui.explain.set(''); return; }

    const photos = n === 1 ? 'this photo' : `all ${n} photos`;
    const spot = SPOTS.find((s) => s.id === ui.spot.value);
    const where = ui.spot.value === 'tile' ? 'repeated across' : `placed ${spot.label.toLowerCase()} on`;
    const pct = Math.round(opacity() * 100);
    if (state.mode === 'text') {
      const text = ui.text.value.trim();
      if (!text) {
        ui.explain.set('Type the words you want stamped — your name, your student ID, or just “draft”.');
        return;
      }
      const short = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      ui.explain.set(`“${short}” will be ${where} ${photos} at ${pct}% opacity, ${ui.size.value}% of each photo's width.`);
    } else if (!logo.img) {
      ui.explain.set('Choose the logo or signature you want stamped. A PNG with a transparent background sits on a photo best.');
    } else {
      ui.explain.set(`Your logo will be ${where} ${photos} at ${pct}% opacity, ${ui.logoScale.value}% of each photo's width.`);
    }
  }

  function paintFacts() {
    if (!ui.facts) return;
    const n = state.files.length;
    if (!n) { ui.facts.set([]); return; }
    const bytes = state.files.reduce((s, f) => s + f.size, 0);
    ui.facts.set([
      ['Photos', String(n)],
      ['Total size', formatBytes(bytes)],
    ]);
  }

  // Leaving the tool releases the two canvases and every thumbnail URL — the
  // shell revokes the ones it made, not the ones this pane made.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    clearTimeout(paintTimer);
    releasePreview();
    if (previewCanvas) { previewCanvas.width = 0; previewCanvas.height = 0; previewCanvas = null; }
    for (const url of thumbUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    thumbUrls.clear();
  });
}
