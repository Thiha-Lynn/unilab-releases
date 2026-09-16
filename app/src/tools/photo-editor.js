import { canvasToBlob, el, formatBytes, loadImage, stem, toast, MIME_EXT } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, colorField, fileFacts, liveExplain, optionPanel,
  selectField, sliderField, tabCards,
} from '../option-ui.js';
import { FONTS, outlineColour, wrapText } from '../text-draw.js';

// iLoveIMG's Photo Editor is the tool on the front of their site, and it is one
// screen doing five jobs: straighten and crop, push the colour around, drop a
// preset on top, put a frame round it, and stick something on it. Everything
// here is a canvas operation, so the whole editor runs on the photo already in
// this tab — no upload, no round trip, no account.

const TABS = [
  { id: 'adjust', label: 'Adjust', icon: TAB_ICONS.percent },
  { id: 'filter', label: 'Filter', icon: TAB_ICONS.draw },
  { id: 'frame', label: 'Frame', icon: TAB_ICONS.size },
  { id: 'sticker', label: 'Sticker', icon: TAB_ICONS.type },
];

// Each preset is a CSS filter string, optionally with one tint painted over the
// top. Two cheap primitives, but they are what separates "Fade" from "Vivid",
// and both are things a GPU does to a whole photo in one pass.
const FILTERS = [
  { id: 'none', label: 'None', filter: '' },
  { id: 'mono', label: 'Mono', filter: 'grayscale(1) contrast(1.08)' },
  { id: 'warm', label: 'Warm', filter: 'saturate(1.12)', overlay: { color: '#ff8a3d', alpha: 0.22 } },
  { id: 'cool', label: 'Cool', filter: 'saturate(1.05)', overlay: { color: '#3da2ff', alpha: 0.22 } },
  { id: 'fade', label: 'Fade', filter: 'contrast(0.86) saturate(0.82) brightness(1.07)', overlay: { color: '#f4ead9', alpha: 0.16 } },
  { id: 'vivid', label: 'Vivid', filter: 'saturate(1.45) contrast(1.14)' },
  { id: 'sepia', label: 'Sepia', filter: 'sepia(0.72) contrast(1.06) brightness(1.02)' },
  { id: 'punch', label: 'High contrast', filter: 'contrast(1.42) saturate(1.06)' },
];

const CROPS = [
  { id: 'original', label: 'Original shape', ratio: null },
  { id: '1:1', label: 'Square 1:1 — profile picture', ratio: 1 },
  { id: '4:5', label: 'Portrait 4:5 — Instagram', ratio: 4 / 5 },
  { id: '3:4', label: 'Photo 3:4 — ID photo', ratio: 3 / 4 },
  { id: '16:9', label: 'Wide 16:9 — slide', ratio: 16 / 9 },
  { id: '9:16', label: 'Tall 9:16 — story', ratio: 9 / 16 },
];

const FRAMES = [
  { id: 'none', label: 'No frame' },
  { id: 'white', label: 'Border' },
  { id: 'rounded', label: 'Rounded corners' },
  { id: 'polaroid', label: 'Polaroid — space to write under' },
  { id: 'shadow', label: 'Soft shadow' },
];

const TEXT_STYLES = [
  { id: 'outline', label: 'Outlined — readable on any photo' },
  { id: 'plain', label: 'Plain' },
  { id: 'bar', label: 'Solid bar behind the text' },
];

const FORMATS = [
  { id: 'image/jpeg', label: 'JPG — smallest file' },
  { id: 'image/png', label: 'PNG — sharpest text, keeps transparency' },
  { id: 'image/webp', label: 'WebP — smaller again' },
];

// Emoji rather than shipped artwork: there is nothing to license, nothing to
// download, and every phone already has a full colour set of them. They are
// drawn with fillText like any other glyph.
const STICKERS = [
  '⭐', '🔥', '❤️', '✅', '❌', '📌', '💡', '🎓',
  '📚', '☕', '✨', '🎉', '😂', '😎', '🥲', '👍',
  '🐱', '🌸', '⚡', '🎯', '🧠', '🫶', '🍜', '➡️',
];
const EMOJI_STACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

// A browser canvas refuses to allocate past these, and Safari on a phone is the
// strictest of the lot. A silently blank export is far worse than a sentence
// telling the student to shrink the photo first.
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;

// The editing canvas is a downscaled copy. Every slider redraws the whole
// photo, and dragging brightness across a 12 MP image thirty times a second is
// how a tab stops responding.
const PREVIEW_MAX = 1280;
const THUMB = 92;

const defaultAdjust = () => ({ brightness: 0, contrast: 0, saturation: 0, warmth: 0, straighten: 0 });

export default function render(container, tool) {
  const state = {
    file: null,
    source: null,        // the photo at full size
    preview: null,       // the same photo, small enough to redraw on every drag
    width: 0,
    height: 0,
    tab: 'adjust',
    adjust: defaultAdjust(),
    turn: 0,
    flip: false,
    crop: 'original',
    filter: 'none',
    frame: { kind: 'none', width: 5, color: '#ffffff' },
    objects: [],
    selectedId: null,
    geom: null,          // where the photo sits inside the last composed canvas
  };
  const ui = {};
  const history = { stack: [], index: -1, tag: null, at: 0 };
  let areaHost = null;
  let stageCanvas = null;
  let overlay = null;
  let nextId = 1;
  let endDrag = null;      // tears down the window listeners of a drag in flight

  toolShell(container, tool, {
    accept: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
    multiple: false,
    pickLabel: 'Select a photo',
    dropLabel: 'or drop one here',
    actionLabel: 'Save photo',
    doneTitle: 'Your photo is ready!',
    downloadLabel: 'Download edited photo',
    continueTo: ['compress-image', 'crop-image', 'watermark-image'],
    note: 'Everything here happens on the copy in this tab — the file on your phone or in your Drive is untouched until you download the result. If you are making a profile picture, Square 1:1 with a thin border is the safe recipe: most sites crop to a circle, and the border keeps your head out of the part they cut off.',

    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Edit');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.tabs = tabCards(TABS, (t) => { state.tab = t.id; syncVisibility(); });

      panel.add(
        ui.tabs, ui.facts,
        buildAdjust(), buildFilter(), buildFrame(), buildSticker(),
        buildLayers(), buildExport(), ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.source) throw new Error('Choose a photo first.');
      const type = ui.format.value;
      const size = exportSize();
      if (size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_PIXELS) {
        throw new Error(`With that frame the saved photo would be ${size.w}×${size.h}, which is more than a browser can draw. Use a thinner frame, or crop tighter.`);
      }

      ctx.setBusy(0.15, 'Drawing your photo at full size…');
      // One yield before the heavy draw so the progress bar is actually on
      // screen when a 12 MP composite starts.
      await new Promise((r) => setTimeout(r, 0));
      if (ctx.signal?.aborted) throw new Error('canceled');

      const canvas = document.createElement('canvas');
      compose(state.source, canvas, { forExport: true, type });

      ctx.setBusy(0.7, 'Saving the image…');
      await new Promise((r) => setTimeout(r, 0));
      if (ctx.signal?.aborted) throw new Error('canceled');

      const blob = await canvasToBlob(canvas, type, type === 'image/png' ? undefined : ui.quality.value / 100);
      const w = canvas.width;
      const h = canvas.height;
      // Hand back ~50 MB of RGBA now rather than at the next GC — students edit
      // and re-save the same photo three or four times in a row.
      canvas.width = 0;
      canvas.height = 0;

      return {
        outputs: [{ name: `${stem(state.file.name)}-edited.${MIME_EXT[type]}`, blob }],
        doneTitle: 'Your photo is edited!',
        downloadLabel: `Download the ${w}×${h} photo · ${formatBytes(blob.size)}`,
      };
    },
  });

  // =========================================================================
  // Loading
  // =========================================================================

  async function loadFile() {
    release();
    if (!state.file) { state.width = 0; update(); return; }

    const img = await loadImage(state.file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error(`${state.file.name} came back with no pixels. Try re-saving it as a JPG or PNG first.`);
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
      throw new Error(`${state.file.name} is ${w}×${h}, which is more than a browser canvas can hold — phones especially. Shrink it with Resize Image first, then edit it here.`);
    }

    state.source = document.createElement('canvas');
    state.source.width = w;
    state.source.height = h;
    state.source.getContext('2d').drawImage(img, 0, 0);
    state.width = w;
    state.height = h;

    // The editing copy. A photo that is already small is used as it is.
    const scale = Math.min(1, PREVIEW_MAX / Math.max(w, h));
    state.preview = document.createElement('canvas');
    state.preview.width = Math.max(1, Math.round(w * scale));
    state.preview.height = Math.max(1, Math.round(h * scale));
    const p2 = state.preview.getContext('2d');
    p2.imageSmoothingQuality = 'high';
    p2.drawImage(state.source, 0, 0, state.preview.width, state.preview.height);

    // A screenshot with transparency should not silently gain a white
    // background, so PNG in means PNG out until the student says otherwise.
    ui.format.value = state.file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    syncVisibility();

    state.objects = [];
    state.selectedId = null;
    state.adjust = defaultAdjust();
    resetHistory();
    buildStage();
    buildThumbs();
    update();
  }

  function release() {
    for (const key of ['source', 'preview']) {
      const c = state[key];
      if (c) { c.width = 0; c.height = 0; state[key] = null; }
    }
  }

  // =========================================================================
  // The sidebar
  // =========================================================================

  /** A labelled group of arbitrary nodes, in the shape option-ui produces. */
  function field(label, ...nodes) {
    const root = el(`<div class="opt__field"></div>`);
    if (label) {
      const l = el(`<label class="opt__label"></label>`);
      l.textContent = label;
      root.appendChild(l);
    }
    root.append(...nodes.map((n) => n?.root ?? n));
    return { root };
  }

  function hint(text) {
    const p = el(`<p class="opt__hint"></p>`);
    p.textContent = text;
    return p;
  }

  function buildAdjust() {
    const box = el(`<div></div>`);

    const turnRow = el(`<div class="opt__row"></div>`);
    const left = el(`<button class="btn small secondary" type="button" style="flex:1">↺ Left</button>`);
    const right = el(`<button class="btn small secondary" type="button" style="flex:1">↻ Right</button>`);
    const flip = el(`<button class="btn small secondary" type="button" style="flex:1">⇄ Flip</button>`);
    left.addEventListener('click', () => { state.turn = (state.turn + 270) % 360; repaint(); });
    right.addEventListener('click', () => { state.turn = (state.turn + 90) % 360; repaint(); });
    flip.addEventListener('click', () => { state.flip = !state.flip; repaint(); });
    turnRow.append(left, right, flip);

    ui.crop = selectField('Crop to', CROPS, { value: 'original', onChange: (v) => { state.crop = v; repaint(); } });

    ui.brightness = slider('Brightness', 'brightness');
    ui.contrast = slider('Contrast', 'contrast');
    ui.saturation = slider('Saturation', 'saturation');
    ui.warmth = slider('Warmth', 'warmth');
    ui.straighten = sliderField('Straighten', {
      value: 0, min: -15, max: 15, step: 0.5, suffix: '°',
      onChange: (v) => { state.adjust.straighten = v; repaint(); },
    });
    ui.straighten.root.appendChild(hint('For a photo taken at a slight angle. The picture is scaled up just enough to fill the frame, so there are never white corners.'));

    const reset = el(`<button class="btn small secondary" type="button">Reset all adjustments</button>`);
    reset.addEventListener('click', () => {
      state.adjust = defaultAdjust();
      state.turn = 0;
      state.flip = false;
      state.crop = 'original';
      ui.crop.value = 'original';
      for (const [k, control] of [['brightness', ui.brightness], ['contrast', ui.contrast],
        ['saturation', ui.saturation], ['warmth', ui.warmth], ['straighten', ui.straighten]]) {
        control.value = 0;
        state.adjust[k] = 0;
      }
      repaint();
      toast('Adjustments reset');
    });

    box.append(
      field('Turn', turnRow).root, ui.crop.root,
      ui.brightness.root, ui.contrast.root, ui.saturation.root, ui.warmth.root,
      ui.straighten.root, field('', reset).root,
    );
    ui.adjustBox = box;
    return box;

    function slider(label, key) {
      return sliderField(label, {
        value: 0, min: -100, max: 100, step: 1,
        onChange: (v) => { state.adjust[key] = v; repaint(); },
      });
    }
  }

  function buildFilter() {
    const box = el(`<div></div>`);
    // Four across fits the sidebar without the labels wrapping.
    ui.thumbs = el(`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px"></div>`);
    box.append(
      field('Filter', ui.thumbs).root,
      hint('Every thumbnail is your own photo with that filter on it, so what you see is what you get. The filters stack on top of the sliders in the Adjust tab.'),
    );
    ui.filterBox = box;
    return box;
  }

  function buildFrame() {
    const box = el(`<div></div>`);
    ui.frameKind = selectField('Frame', FRAMES, {
      value: 'none',
      onChange: (v) => { state.frame.kind = v; syncVisibility(); repaint(); },
    });
    ui.frameWidth = sliderField('Frame width', {
      value: 5, min: 1, max: 15, step: 0.5, suffix: '%',
      onChange: (v) => { state.frame.width = v; repaint(); },
    });
    ui.frameWidth.root.appendChild(hint('A percentage of the photo\'s short side, so the frame looks the same on a small screenshot and a big photo. The saved file grows by the frame.'));
    ui.frameColor = colorField('Frame colour', { value: '#ffffff', onChange: (v) => { state.frame.color = v; repaint(); } });
    box.append(ui.frameKind.root, ui.frameWidth.root, ui.frameColor.root);
    ui.frameBox = box;
    return box;
  }

  function buildSticker() {
    const box = el(`<div></div>`);

    const grid = el(`<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:5px"></div>`);
    for (const emoji of STICKERS) {
      const b = el(`<button type="button" style="border:1px solid var(--line);background:var(--card);border-radius:8px;padding:4px 0;font-size:18px;line-height:1.2"></button>`);
      b.textContent = emoji;
      b.title = `Add ${emoji}`;
      b.addEventListener('click', () => addSticker(emoji));
      grid.appendChild(b);
    }

    const addText = el(`<button class="btn small secondary" type="button" style="width:100%">+ Add a text label</button>`);
    addText.addEventListener('click', addTextObject);

    // ---- properties of whatever is selected ----
    ui.textArea = el(`<textarea class="opt__select" rows="2" spellcheck="false" style="resize:vertical"></textarea>`);
    ui.textArea.addEventListener('input', () => {
      const o = selected();
      if (!o || o.type !== 'text') return;
      o.text = ui.textArea.value;
      repaint();
      commit(`text:${o.id}`);
    });
    ui.textField = field('Text', ui.textArea);

    ui.font = selectField('Font', Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label })), {
      value: 'system',
      onChange: (v) => withSelected('text', (o) => { o.font = v; }, 'font'),
    });
    ui.textColor = colorField('Text colour', {
      value: '#ffffff',
      onChange: (v) => withSelected('text', (o) => { o.color = v; }, 'colour'),
    });
    ui.textStyle = selectField('Style', TEXT_STYLES, {
      value: 'outline',
      onChange: (v) => withSelected('text', (o) => { o.style = v; }, 'style'),
    });
    ui.objSize = sliderField('Size', {
      value: 12, min: 2, max: 60, step: 0.5, suffix: '%',
      onChange: (v) => withSelected(null, (o) => { o.size = v / 100; }, 'size'),
    });
    ui.objSize.root.appendChild(hint('A percentage of the photo\'s width — or just drag the square handle on the corner.'));

    ui.propsBox = el(`<div></div>`);
    ui.propsBox.append(ui.textField.root, ui.font.root, ui.textColor.root, ui.textStyle.root, ui.objSize.root);

    ui.nothingSelected = hint('Tap a sticker above to drop it on the photo, then drag it where you want it.');

    box.append(field('Stickers', grid).root, field('Text', addText).root, ui.nothingSelected, ui.propsBox);
    ui.stickerBox = box;
    return box;
  }

  function buildLayers() {
    const box = el(`<div></div>`);
    ui.layers = el(`<div style="display:flex;flex-direction:column;gap:6px"></div>`);

    const row = el(`<div class="opt__row"></div>`);
    ui.undo = el(`<button class="btn small secondary" type="button" style="flex:1">↶ Undo</button>`);
    ui.redo = el(`<button class="btn small secondary" type="button" style="flex:1">↷ Redo</button>`);
    ui.undo.addEventListener('click', undo);
    ui.redo.addEventListener('click', redo);
    row.append(ui.undo, ui.redo);

    box.append(field('Layers', ui.layers).root, row,
      hint('Undo and redo cover everything you have put on the photo. Ctrl+Z (⌘Z on a Mac) works too.'));
    return box;
  }

  function buildExport() {
    const box = el(`<div></div>`);
    ui.format = selectField('Save as', FORMATS, { value: 'image/jpeg', onChange: () => { syncVisibility(); update(); } });
    ui.quality = sliderField('Quality', { value: 92, min: 50, max: 100, suffix: '%', onChange: update });
    box.append(ui.format.root, ui.quality.root);
    return box;
  }

  function syncVisibility() {
    ui.adjustBox.hidden = state.tab !== 'adjust';
    ui.filterBox.hidden = state.tab !== 'filter';
    ui.frameBox.hidden = state.tab !== 'frame';
    ui.stickerBox.hidden = state.tab !== 'sticker';

    const o = selected();
    ui.propsBox.hidden = !o;
    ui.nothingSelected.hidden = !!o;
    // A sticker has no words, no font and no outline — only a size.
    const isText = o?.type === 'text';
    ui.textField.root.hidden = !isText;
    ui.font.root.hidden = !isText;
    ui.textColor.root.hidden = !isText;
    ui.textStyle.root.hidden = !isText;

    const kind = state.frame.kind;
    ui.frameWidth.root.hidden = kind === 'none';
    // Only the two frames that actually paint a border have a colour.
    ui.frameColor.root.hidden = !(kind === 'white' || kind === 'polaroid');

    // PNG is lossless, so a quality slider beside it would be a lie.
    ui.quality.root.hidden = ui.format.value === 'image/png';
  }

  // =========================================================================
  // Objects
  // =========================================================================

  // Declared as a function, not a const arrow: toolShell() calls options() and
  // ctx.refresh() synchronously from inside the call below, and those paths reach
  // here long before a const on this line would have been initialised.
  function selected() {
    return state.objects.find((o) => o.id === state.selectedId) ?? null;
  }

  function withSelected(type, mutate, tag) {
    const o = selected();
    if (!o || (type && o.type !== type)) return;
    mutate(o);
    repaint();
    commit(`${tag}:${o.id}`);
  }

  function addSticker(emoji) {
    if (!state.source) return;
    state.objects.push({ id: nextId++, type: 'sticker', emoji, x: 0.5, y: 0.5, size: 0.18 });
    state.selectedId = state.objects.at(-1).id;
    // select() fires the tab's own onPick, which is what sets state.tab.
    ui.tabs.select(TABS.findIndex((t) => t.id === 'sticker'));
    afterAdd();
  }

  function addTextObject() {
    if (!state.source) return;
    state.objects.push({
      id: nextId++, type: 'text', text: 'Your text here', font: 'system',
      color: ui.textColor.value, style: ui.textStyle.value,
      // Low down and across most of the width is where a caption belongs, and
      // it is the position nobody has to drag it out of.
      x: 0.5, y: 0.84, size: 0.08, wrap: 0.86,
    });
    state.selectedId = state.objects.at(-1).id;
    afterAdd();
    ui.textArea.focus();
    ui.textArea.select();
  }

  function afterAdd() {
    syncSelectionUi();
    repaint();
    commit(null);
  }

  function removeObject(id) {
    state.objects = state.objects.filter((o) => o.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    syncSelectionUi();
    repaint();
    commit(null);
  }

  function select(id) {
    state.selectedId = id;
    syncSelectionUi();
    paintOverlay();
    paintLayers();
  }

  /** Pushes the sidebar controls to whatever is selected now. */
  function syncSelectionUi() {
    const o = selected();
    if (o) {
      ui.objSize.value = Math.round(o.size * 1000) / 10;
      if (o.type === 'text') {
        ui.textArea.value = o.text;
        ui.font.value = o.font;
        ui.textStyle.value = o.style;
        // colorField exposes no setter — its two inputs are its whole state, so
        // writing them directly is the honest way to reflect a new selection.
        for (const input of ui.textColor.root.querySelectorAll('input')) input.value = o.color;
      }
    }
    syncVisibility();
    paintLayers();
    update();
  }

  function paintLayers() {
    if (!ui.layers) return;
    ui.layers.innerHTML = '';
    if (!state.objects.length) {
      ui.layers.appendChild(hint('Nothing on the photo yet.'));
      return;
    }
    // Top-most first: the list reads the way the picture looks.
    [...state.objects].reverse().forEach((o) => {
      const i = state.objects.indexOf(o);
      const row = el(`<div style="display:flex;align-items:center;gap:5px"></div>`);
      const name = el(`<button type="button" style="flex:1;min-width:0;text-align:left;border:1.5px solid var(--line);background:var(--card);border-radius:9px;padding:6px 9px;font-size:13.5px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></button>`);
      name.textContent = o.type === 'sticker' ? `${o.emoji}  Sticker` : `T  ${o.text.split('\n')[0] || 'Text'}`;
      if (o.id === state.selectedId) name.style.borderColor = 'var(--accent)';
      name.addEventListener('click', () => select(o.id));

      const up = iconBtn('↑', 'Bring forward', () => move(i, 1));
      const down = iconBtn('↓', 'Send backward', () => move(i, -1));
      const rm = iconBtn('✕', 'Remove', () => removeObject(o.id));
      up.disabled = i === state.objects.length - 1;
      down.disabled = i === 0;

      row.append(name, up, down, rm);
      ui.layers.appendChild(row);
    });

    function move(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= state.objects.length) return;
      [state.objects[i], state.objects[j]] = [state.objects[j], state.objects[i]];
      repaint();
      commit(null);
    }
  }

  function iconBtn(glyph, title, onClick) {
    const b = el(`<button class="ts__icon-btn" type="button" style="width:28px;height:28px;border-radius:8px;font-size:13px;flex:0 0 auto"></button>`);
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // =========================================================================
  // Undo / redo
  // =========================================================================

  function resetHistory() {
    history.stack = [snapshot()];
    history.index = 0;
    history.tag = null;
    paintHistoryButtons();
  }

  // Hoisted for the same reason as selected(): resetHistory() runs during the
  // synchronous part of toolShell().
  function snapshot() {
    return JSON.parse(JSON.stringify(state.objects));
  }

  /**
   * Records one step. Dragging a size slider fires on every pixel of travel, so
   * consecutive edits of the same kind to the same object inside a second
   * collapse into one entry — otherwise a single drag would cost forty presses
   * of Ctrl+Z to undo.
   */
  function commit(tag) {
    const now = performance.now();
    const same = tag && history.tag === tag && now - history.at < 900;
    history.tag = tag;
    history.at = now;
    if (same) {
      history.stack[history.index] = snapshot();
      return;
    }
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snapshot());
    // A long session should not keep every state of every sticker forever.
    if (history.stack.length > 60) history.stack.shift();
    history.index = history.stack.length - 1;
    paintHistoryButtons();
  }

  function undo() { step(-1); }
  function redo() { step(1); }

  function step(dir) {
    const next = history.index + dir;
    if (next < 0 || next >= history.stack.length) return;
    history.index = next;
    history.tag = null;
    state.objects = JSON.parse(JSON.stringify(history.stack[next]));
    if (!state.objects.some((o) => o.id === state.selectedId)) state.selectedId = null;
    // Ids come back with the restored objects, so a new sticker must not reuse
    // one of them.
    nextId = Math.max(nextId, ...state.objects.map((o) => o.id + 1), 1);
    syncSelectionUi();
    repaint();
    paintHistoryButtons();
  }

  function paintHistoryButtons() {
    if (!ui.undo) return;
    ui.undo.disabled = history.index <= 0;
    ui.redo.disabled = history.index >= history.stack.length - 1;
  }

  function onKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    // Inside a text box, Ctrl+Z belongs to the text box.
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
  document.addEventListener('keydown', onKey);

  // =========================================================================
  // The workarea
  // =========================================================================

  function buildStage() {
    if (!areaHost) return;
    areaHost.innerHTML = '';
    if (!state.source) return;

    const stage = el(`<div style="max-width:760px;margin:0 auto"></div>`);
    const frame = el(`<div style="position:relative;display:block;line-height:0;touch-action:none"></div>`);
    stageCanvas = document.createElement('canvas');
    stageCanvas.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px';
    overlay = el(`<div style="position:absolute;inset:0"></div>`);
    // A click on the picture itself, not on a handle, means "nothing selected".
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) select(null); });
    frame.append(stageCanvas, overlay);

    stage.append(
      frame,
      el(`<p class="ts__hint" style="text-align:center">Drag a sticker or a label to move it, pull the corner square to resize, and press ✕ to take it off. The preview is scaled to fit this page — the file you save keeps every pixel.</p>`),
    );
    areaHost.appendChild(stage);
    repaint();
  }

  function repaint() {
    if (!state.preview || !stageCanvas) { update(); return; }
    compose(state.preview, stageCanvas, {});
    paintOverlay();
    update();
  }

  function paintOverlay() {
    if (!overlay || !state.geom) return;
    overlay.innerHTML = '';
    const g = state.geom;
    const measure = stageCanvas.getContext('2d');

    for (const o of state.objects) {
      const box = objectBox(o, g, measure);
      const node = el(`<div style="position:absolute;touch-action:none;cursor:move"></div>`);
      node.style.left = `${(box.x / g.canvasW) * 100}%`;
      node.style.top = `${(box.y / g.canvasH) * 100}%`;
      node.style.width = `${(box.w / g.canvasW) * 100}%`;
      node.style.height = `${(box.h / g.canvasH) * 100}%`;
      if (o.id === state.selectedId) node.style.outline = '1.5px dashed var(--accent)';
      node.style.outlineOffset = '3px';

      node.addEventListener('pointerdown', (e) => {
        if (e.target !== node) return;
        // Start the drag before selecting: select() repaints the overlay, which
        // throws this very node away, and a drag that depended on it would die
        // on the first pixel of movement.
        drag(e, o, 'move');
        select(o.id);
      });

      if (o.id === state.selectedId) {
        const grip = el(`<div style="position:absolute;right:-9px;bottom:-9px;width:17px;height:17px;background:var(--card);border:2px solid var(--accent);border-radius:4px;cursor:nwse-resize;touch-action:none"></div>`);
        grip.addEventListener('pointerdown', (e) => drag(e, o, 'size'));
        const rm = el(`<button type="button" aria-label="Remove" style="position:absolute;top:-11px;right:-11px;width:22px;height:22px;border:none;border-radius:50%;background:var(--danger);color:#fff;font-size:11px;line-height:1;padding:0">✕</button>`);
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeObject(o.id); });
        node.append(grip, rm);
      }
      overlay.appendChild(node);
    }
  }

  /**
   * One pointer drag on a sticker or a label.
   *
   * The move and end handlers go on the window rather than on the handle that
   * was pressed, because every repaint rebuilds the overlay from scratch — the
   * pressed node is detached a few milliseconds later, and a browser releases
   * pointer capture the moment the capturing element leaves the document. Held
   * on the window, the drag survives every redraw underneath it.
   */
  function drag(e, o, kind) {
    e.preventDefault();
    e.stopPropagation();
    const g = state.geom;
    const bounds = stageCanvas?.getBoundingClientRect();
    if (!g || !bounds?.width) return;
    endDrag?.();

    // Everything about an object is stored as a fraction of the photo, not of
    // the canvas, so a frame appearing later does not move it.
    const perPxX = g.canvasW / bounds.width / g.photoW;
    const perPxY = g.canvasH / bounds.height / g.photoH;
    const start = { x: o.x, y: o.y, size: o.size, cx: e.clientX, cy: e.clientY };

    const move = (ev) => {
      const dx = (ev.clientX - start.cx) * perPxX;
      const dy = (ev.clientY - start.cy) * perPxY;
      if (kind === 'move') {
        // A little overhang is allowed: half a sticker off the corner is a
        // deliberate look, but losing one entirely is never intended.
        o.x = Math.min(1.1, Math.max(-0.1, start.x + dx));
        o.y = Math.min(1.1, Math.max(-0.1, start.y + dy));
      } else {
        o.size = Math.min(1.4, Math.max(0.02, start.size + dx));
      }
      repaint();
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      endDrag = null;
      if (kind === 'size') ui.objSize.value = Math.round(o.size * 1000) / 10;
      commit(null);
    };
    endDrag = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // =========================================================================
  // Drawing — one function for the preview and the export
  // =========================================================================

  function filterString() {
    const a = state.adjust;
    const preset = FILTERS.find((f) => f.id === state.filter);
    const parts = [];
    if (preset?.filter) parts.push(preset.filter);
    if (a.brightness) parts.push(`brightness(${(1 + a.brightness / 100).toFixed(3)})`);
    if (a.contrast) parts.push(`contrast(${(1 + a.contrast / 100).toFixed(3)})`);
    if (a.saturation) parts.push(`saturate(${(1 + a.saturation / 100).toFixed(3)})`);
    return parts.join(' ') || 'none';
  }

  /** The size the exported file will be, frame included. */
  function exportSize() {
    const g = layout(state.width, state.height);
    return { w: g.canvasW, h: g.canvasH };
  }

  /** Works out every rectangle for a source of this size. No drawing. */
  function layout(sw, sh) {
    const swapped = state.turn % 180 !== 0;
    const tw = swapped ? sh : sw;
    const th = swapped ? sw : sh;

    const ratio = CROPS.find((c) => c.id === state.crop)?.ratio ?? null;
    let cw = tw;
    let ch = th;
    if (ratio) {
      // The biggest rectangle of that shape that fits inside the photo, centred.
      if (tw / th > ratio) { ch = th; cw = th * ratio; } else { cw = tw; ch = tw / ratio; }
    }
    const photoW = Math.max(1, Math.round(cw));
    const photoH = Math.max(1, Math.round(ch));

    const b = Math.round((state.frame.width / 100) * Math.min(photoW, photoH));
    let padL = 0; let padT = 0; let padR = 0; let padB = 0;
    let radius = 0;
    const kind = state.frame.kind;
    if (kind === 'white') { padL = padT = padR = padB = b; }
    else if (kind === 'polaroid') { padL = padT = padR = b; padB = Math.round(b * 3); }
    else if (kind === 'shadow') { padL = padT = padR = padB = Math.round(b * 1.6); }
    else if (kind === 'rounded') { radius = Math.min(photoW, photoH) / 2 >= b * 2 ? b * 2 : Math.min(photoW, photoH) / 2; }

    return {
      photoX: padL, photoY: padT, photoW, photoH, radius, border: b,
      canvasW: photoW + padL + padR, canvasH: photoH + padT + padB,
    };
  }

  function roundedPath(g2, x, y, w, h, r) {
    g2.beginPath();
    if (!r) { g2.rect(x, y, w, h); return; }
    const rad = Math.min(r, w / 2, h / 2);
    g2.moveTo(x + rad, y);
    g2.arcTo(x + w, y, x + w, y + h, rad);
    g2.arcTo(x + w, y + h, x, y + h, rad);
    g2.arcTo(x, y + h, x, y, rad);
    g2.arcTo(x, y, x + w, y, rad);
    g2.closePath();
  }

  /**
   * Draws the whole edit into `target`. The preview passes the small copy and
   * the export passes the full-size one; every measurement below is a fraction
   * of the photo, so the two come out identical apart from the pixel count.
   */
  function compose(source, target, { forExport = false, type = 'image/png' } = {}) {
    const g = layout(source.width, source.height);
    state.geom = g;
    target.width = g.canvasW;
    target.height = g.canvasH;
    const g2 = target.getContext('2d');
    g2.clearRect(0, 0, g.canvasW, g.canvasH);

    // JPG has no transparency: a rounded corner or a soft shadow would come out
    // black instead of empty, so the whole canvas gets a white underlay.
    if (forExport && type === 'image/jpeg') {
      g2.fillStyle = '#ffffff';
      g2.fillRect(0, 0, g.canvasW, g.canvasH);
    }

    const kind = state.frame.kind;
    if (kind === 'white' || kind === 'polaroid') {
      g2.fillStyle = state.frame.color;
      g2.fillRect(0, 0, g.canvasW, g.canvasH);
    }
    if (kind === 'shadow') {
      g2.save();
      g2.shadowColor = 'rgba(18, 22, 32, 0.38)';
      g2.shadowBlur = Math.max(2, g.border * 1.1);
      g2.shadowOffsetY = Math.max(1, g.border * 0.35);
      g2.fillStyle = '#ffffff';
      roundedPath(g2, g.photoX, g.photoY, g.photoW, g.photoH, 0);
      g2.fill();
      g2.restore();
    }

    // ---- the photo, cropped by the clip ----
    g2.save();
    roundedPath(g2, g.photoX, g.photoY, g.photoW, g.photoH, g.radius);
    g2.clip();

    g2.save();
    g2.filter = filterString();
    g2.imageSmoothingQuality = 'high';
    g2.translate(g.photoX + g.photoW / 2, g.photoY + g.photoH / 2);
    const theta = (state.adjust.straighten * Math.PI) / 180;
    if (theta) {
      g2.rotate(theta);
      // Scaling up by the bounding box of the tilted rectangle is what stops
      // empty corners appearing — a straighten that left white triangles would
      // be worse than the tilt.
      const c = Math.abs(Math.cos(theta));
      const s = Math.abs(Math.sin(theta));
      const cover = Math.max(
        (g.photoW * c + g.photoH * s) / g.photoW,
        (g.photoW * s + g.photoH * c) / g.photoH,
      );
      g2.scale(cover, cover);
    }
    g2.rotate((state.turn * Math.PI) / 180);
    if (state.flip) g2.scale(-1, 1);
    g2.drawImage(source, -source.width / 2, -source.height / 2);
    g2.restore();

    drawTints(g2, g);
    g2.restore();

    // Stickers and labels are drawn after the photo's clip is released. The
    // polaroid frame exists so there is somewhere to write under the picture,
    // and a caption dragged into that white strip has to survive the export
    // rather than being cut off at the edge of the photo.
    drawObjects(g2, g);
    return g;
  }

  function drawTints(g2, g) {
    const tints = [];
    const preset = FILTERS.find((f) => f.id === state.filter);
    if (preset?.overlay) tints.push(preset.overlay);
    const warmth = state.adjust.warmth;
    // ctx.filter has no white-balance primitive — sepia() would drain the
    // colour instead of shifting it — so warmth is a tint in soft-light, which
    // is what a photo app's temperature slider looks like anyway.
    if (warmth) tints.push({ color: warmth > 0 ? '#ff8a3d' : '#3da2ff', alpha: (Math.abs(warmth) / 100) * 0.38 });

    for (const t of tints) {
      g2.save();
      g2.globalCompositeOperation = 'soft-light';
      g2.globalAlpha = t.alpha;
      g2.fillStyle = t.color;
      g2.fillRect(g.photoX, g.photoY, g.photoW, g.photoH);
      g2.restore();
    }
  }

  function drawObjects(g2, g) {
    for (const o of state.objects) {
      const cx = g.photoX + o.x * g.photoW;
      const cy = g.photoY + o.y * g.photoH;
      const size = Math.max(1, o.size * g.photoW);
      g2.save();
      // Objects sit on top of the photo, not inside it: a filter that made the
      // picture grey must not grey out the sticker as well.
      g2.filter = 'none';
      if (o.type === 'sticker') {
        g2.font = `${size}px ${EMOJI_STACK}`;
        g2.textAlign = 'center';
        g2.textBaseline = 'middle';
        g2.fillText(o.emoji, cx, cy);
      } else {
        drawText(g2, o, cx, cy, size, g);
      }
      g2.restore();
    }
  }

  /** One text object, wrapped and styled exactly as Add Text to Image does it. */
  function drawText(g2, o, cx, cy, size, g) {
    g2.font = `700 ${size}px ${FONTS[o.font]?.stack ?? FONTS.system.stack}`;
    const maxWidth = Math.max(size, (o.wrap ?? 0.86) * g.photoW);
    const lines = wrapText(g2, o.text || ' ', maxWidth);
    const lineHeight = size * 1.32;
    const blockH = lines.length * lineHeight;
    const top = cy - blockH / 2;

    if (o.style === 'bar') {
      const widest = lines.reduce((w, line) => Math.max(w, g2.measureText(line).width), 0);
      const padX = size * 0.35;
      const padY = size * 0.22;
      g2.save();
      g2.globalAlpha = 0.55;
      g2.fillStyle = outlineColour(o.color);
      g2.fillRect(cx - widest / 2 - padX, top - padY, widest + padX * 2, blockH + padY * 2);
      g2.restore();
    }

    g2.textAlign = 'center';
    g2.textBaseline = 'top';
    g2.fillStyle = o.color;
    const outlined = o.style === 'outline';
    if (outlined) {
      // A sixth of the font size is the weight that reads as a caption outline
      // at any resolution; round joins stop spikes on sharp corners.
      g2.lineWidth = size / 6;
      g2.lineJoin = 'round';
      g2.miterLimit = 2;
      g2.strokeStyle = outlineColour(o.color);
    }
    lines.forEach((line, i) => {
      const y = top + i * lineHeight + (lineHeight - size) / 2;
      // Stroke first, then fill: the other way round and the outline eats half
      // the thickness of every letter.
      if (outlined) g2.strokeText(line, cx, y);
      g2.fillText(line, cx, y);
    });
  }

  /** Where an object lands on the canvas, in canvas pixels — for its handles. */
  function objectBox(o, g, measure) {
    const cx = g.photoX + o.x * g.photoW;
    const cy = g.photoY + o.y * g.photoH;
    const size = Math.max(1, o.size * g.photoW);
    if (o.type === 'sticker') {
      measure.font = `${size}px ${EMOJI_STACK}`;
      const w = Math.max(size * 0.8, measure.measureText(o.emoji).width);
      return { x: cx - w / 2, y: cy - size / 2, w, h: size };
    }
    measure.font = `700 ${size}px ${FONTS[o.font]?.stack ?? FONTS.system.stack}`;
    const maxWidth = Math.max(size, (o.wrap ?? 0.86) * g.photoW);
    const lines = wrapText(measure, o.text || ' ', maxWidth);
    const widest = lines.reduce((w, line) => Math.max(w, measure.measureText(line).width), size * 0.5);
    const h = lines.length * size * 1.32;
    return { x: cx - widest / 2, y: cy - h / 2, w: widest, h };
  }

  // =========================================================================
  // Filter thumbnails — the student's own photo, not a swatch
  // =========================================================================

  function buildThumbs() {
    if (!ui.thumbs || !state.source) return;
    ui.thumbs.innerHTML = '';

    // One square centre crop, reused by all eight previews.
    const side = Math.min(state.source.width, state.source.height);
    const base = document.createElement('canvas');
    base.width = THUMB;
    base.height = THUMB;
    base.getContext('2d').drawImage(
      state.source,
      (state.source.width - side) / 2, (state.source.height - side) / 2, side, side,
      0, 0, THUMB, THUMB,
    );

    for (const preset of FILTERS) {
      const btn = el(`<button type="button" style="border:1.5px solid var(--line);background:var(--card);border-radius:9px;padding:3px;display:flex;flex-direction:column;gap:3px;align-items:center;overflow:hidden"></button>`);
      btn.dataset.filter = preset.id;
      const c = document.createElement('canvas');
      c.width = THUMB;
      c.height = THUMB;
      c.style.cssText = 'width:100%;height:auto;display:block;border-radius:6px';
      const t2 = c.getContext('2d');
      t2.filter = preset.filter || 'none';
      t2.drawImage(base, 0, 0);
      if (preset.overlay) {
        t2.filter = 'none';
        t2.globalCompositeOperation = 'soft-light';
        t2.globalAlpha = preset.overlay.alpha;
        t2.fillStyle = preset.overlay.color;
        t2.fillRect(0, 0, THUMB, THUMB);
      }
      const label = el(`<span style="font-size:10.5px;font-weight:700;color:var(--muted);line-height:1.15;text-align:center"></span>`);
      label.textContent = preset.label;
      btn.append(c, label);
      btn.addEventListener('click', () => {
        state.filter = preset.id;
        markThumbs();
        repaint();
      });
      ui.thumbs.appendChild(btn);
    }
    base.width = 0;
    base.height = 0;
    markThumbs();
  }

  function markThumbs() {
    for (const btn of ui.thumbs?.children ?? []) {
      const on = btn.dataset.filter === state.filter;
      btn.style.borderColor = on ? 'var(--accent)' : 'var(--line)';
      btn.style.background = on ? 'var(--accent-soft)' : 'var(--card)';
    }
  }

  // =========================================================================
  // The live sentence
  // =========================================================================

  function update() {
    if (!ui.explain) return;
    if (!state.width) { ui.explain.set(''); ui.facts.set([]); return; }

    const size = exportSize();
    ui.facts.set([
      ['Original', `${state.width}×${state.height} · ${formatBytes(state.file.size)}`],
      ['You will save', `${size.w}×${size.h}`],
    ]);

    const bits = [];
    const preset = FILTERS.find((f) => f.id === state.filter);
    if (preset && preset.id !== 'none') bits.push(`the ${preset.label} filter`);
    const a = state.adjust;
    const tweaks = [
      ['brightness', a.brightness], ['contrast', a.contrast],
      ['saturation', a.saturation], ['warmth', a.warmth],
    ].filter(([, v]) => v !== 0);
    if (tweaks.length) bits.push(tweaks.map(([k, v]) => `${k} ${v > 0 ? '+' : '−'}${Math.abs(v)}`).join(', '));
    if (a.straighten) bits.push(`straightened ${Math.abs(a.straighten)}° ${a.straighten > 0 ? 'clockwise' : 'anticlockwise'}`);
    if (state.turn) bits.push(`turned ${state.turn}°`);
    if (state.flip) bits.push('flipped');
    if (state.crop !== 'original') bits.push(`cropped to ${state.crop}`);
    if (state.frame.kind !== 'none') {
      bits.push(`a ${FRAMES.find((f) => f.id === state.frame.kind).label.split(' — ')[0].toLowerCase()} frame`);
    }
    const stickers = state.objects.filter((o) => o.type === 'sticker').length;
    const texts = state.objects.length - stickers;
    if (stickers) bits.push(`${stickers} sticker${stickers === 1 ? '' : 's'}`);
    if (texts) bits.push(`${texts} text label${texts === 1 ? '' : 's'}`);

    const fmt = MIME_EXT[ui.format.value].toUpperCase();
    ui.explain.set(
      bits.length
        ? `${capitalise(bits.join(', '))} — saved as a ${size.w}×${size.h} ${fmt}.`
        : `Nothing changed yet. As it stands you would save the same picture as a ${size.w}×${size.h} ${fmt}. Start with the Filter tab if you are not sure what you want.`,
    );
  }

  const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Leaving the tool drops the two canvases, the shortcut listener and any
  // half-finished drag still holding listeners on the window.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    document.removeEventListener('keydown', onKey);
    endDrag?.();
    release();
  });
}
