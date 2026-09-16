import { el, dropzone, downloadBlob, errorBox, canvasToBlob, formatBytes, loadImage, stem, toast, MIME_EXT } from '../ui.js';
import { resultCard } from '../media-ui.js';

// Every stack ends in the app's own font list rather than in a Latin-only face.
// Canvas falls back per character, so a caption that mixes English with Thai or
// Burmese still renders: the Latin letters come from Georgia (or Menlo, or the
// system UI font) and the rest come from whatever the device has for that
// script. Naming a single font here would give a page full of tofu boxes.
const APP_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, "Noto Sans Thai", "Noto Sans Myanmar", "Myanmar Text"';
const FONTS = {
  system: { label: 'System (sans)', stack: `${APP_FALLBACK}, sans-serif` },
  serif: { label: 'Serif', stack: `Georgia, "Times New Roman", "Noto Serif Thai", ${APP_FALLBACK}, serif` },
  mono: { label: 'Monospace', stack: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", ${APP_FALLBACK}, monospace` },
};

// Canvas 2D refuses to allocate past this in most browsers, and a silently
// blank canvas is a much worse outcome than an honest message.
const MAX_SIDE = 16384;

// Neither is the long side the only limit: Safari on iOS caps a canvas at about
// 16.7 million pixels in total, whichever shape they come in. A 108 MP phone
// photo is well inside MAX_SIDE on both sides and still comes back blank, which
// is exactly the failure worth catching before the student types a caption into
// an image that was never going to save.
const MAX_PIXELS = 16_777_216;

// Thai, Burmese, Lao and Khmer don't put spaces between words, so splitting on
// whitespace would leave one enormous "word" that runs straight off the edge.
// Intl.Segmenter knows where those scripts actually break (ICU does it by
// dictionary, whatever the locale); splitting on spaces is the fallback.
const wordSegmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;
const cellSegmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** Splits a line into the pieces it is allowed to wrap between. */
function splitTokens(text) {
  if (!wordSegmenter) return text.split(/(\s+)/).filter(Boolean);
  const tokens = [];
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    const attachToPrevious = !isWordLike
      && !/^\s+$/.test(segment)
      && tokens.length
      && !/\s$/.test(tokens[tokens.length - 1]);
    // Punctuation belongs to the word in front of it — "Fig." must never wrap
    // between the "g" and the dot.
    if (attachToPrevious) tokens[tokens.length - 1] += segment;
    else tokens.push(segment);
  }
  return tokens;
}

/** Longest prefix of `text` that fits `maxWidth`, cut on grapheme boundaries. */
function headThatFits(ctx, text, maxWidth) {
  const cells = cellSegmenter ? [...cellSegmenter.segment(text)].map((s) => s.segment) : [...text];
  if (cells.length < 2) return null;
  // Binary search rather than walking back one character at a time: measureText
  // is the expensive part, and this runs on every keystroke.
  let lo = 1;
  let hi = cells.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(cells.slice(0, mid).join('')).width <= maxWidth) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return cells.slice(0, best).join('');
}

// A trailing space costs nothing at the end of a line, so it must never count
// towards the width — measuring it pushed perfectly good lines over the limit.
const visible = (s) => s.replace(/\s+$/, '');

/** Greedy word wrap for one source line. Always returns at least one entry. */
function wrapLine(ctx, line, maxWidth) {
  const out = [];
  let current = '';
  const flush = () => { out.push(visible(current)); current = ''; };

  for (const token of splitTokens(line)) {
    const candidate = current + token;
    if (current && ctx.measureText(visible(candidate)).width > maxWidth) {
      flush();
      current = /^\s+$/.test(token) ? '' : token;
    } else {
      current = candidate;
    }
    // A single token can still be wider than the whole image — a long URL, or a
    // script this browser couldn't segment. Break it mid-word rather than let
    // it disappear off the side.
    while (ctx.measureText(visible(current)).width > maxWidth) {
      const head = headThatFits(ctx, visible(current), maxWidth);
      if (!head) break;
      out.push(head);
      current = current.slice(head.length);
    }
  }
  flush();
  return out;
}

/**
 * Black outline under light text, white under dark text. The point of the
 * outlined style is legibility on a photo you don't control, and a black stroke
 * around black text achieves nothing.
 */
function outlineColour(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const luma = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  return luma > 0.55 ? '#000000' : '#ffffff';
}

export default function render(container) {
  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);

  let file = null;
  // The source is blitted into this once at load; every redraw is then one
  // drawImage plus the text, which stays smooth even on a 12 MP photo.
  let source = null;
  let canvas = null;

  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp',
    multiple: false,
    label: 'Choose an image',
    hint: 'JPG, PNG or WebP — a screenshot, a photo of the whiteboard',
    onFiles: ([f]) => load(f),
  });

  const editor = el(`
    <div hidden>
      <div class="field" style="margin-top:16px">
        <label>Text</label>
        <textarea class="input" data-text rows="3" placeholder="Fig. 2 — cell structure&#10;6531234567 Somchai P."></textarea>
      </div>
      <div class="controls">
        <div class="field">
          <label>Down the image</label>
          <select data-vpos>
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom" selected>Bottom</option>
          </select>
        </div>
        <div class="field">
          <label>Across the image</label>
          <select data-hpos>
            <option value="left">Left</option>
            <option value="center" selected>Centre</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div class="field">
          <label>Text size — <span data-sizeout>6</span>%</label>
          <input type="range" data-size min="2" max="15" step="0.5" value="6" />
        </div>
        <div class="field">
          <label>Margin — <span data-marginout>5</span>%</label>
          <input type="range" data-margin min="2" max="15" step="0.5" value="5" />
        </div>
        <div class="field">
          <label>Font</label>
          <select data-font></select>
        </div>
        <div class="field">
          <label>Colour</label>
          <input type="color" data-color value="#ffffff" style="width:64px;height:40px;padding:3px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg)" />
        </div>
        <div class="field">
          <label>Style</label>
          <select data-style>
            <option value="plain">Plain</option>
            <option value="outline" selected>Outlined — readable on any photo</option>
            <option value="bar">Solid bar behind the text</option>
          </select>
        </div>
        <div class="field" data-barwrap hidden>
          <label>Bar colour</label>
          <input type="color" data-barcolor value="#000000" style="width:64px;height:40px;padding:3px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg)" />
        </div>
        <div class="field" data-baropacitywrap hidden>
          <label>Bar opacity — <span data-opacityout>60</span>%</label>
          <input type="range" data-baropacity min="10" max="100" step="5" value="60" />
        </div>
        <label class="checkbox"><input type="checkbox" data-bold checked /> Bold</label>
        <label class="checkbox"><input type="checkbox" data-italic /> Italic</label>
        <label class="checkbox"><input type="checkbox" data-upper /> UPPERCASE</label>
      </div>
      <div class="canvas-stage" data-stage></div>
      <p class="note" data-info></p>
      <div class="controls">
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="image/jpeg">JPG — smaller file</option>
            <option value="image/png">PNG — sharpest text</option>
          </select>
        </div>
        <div class="field" data-qwrap>
          <label>JPG quality — <span data-qout>92</span>%</label>
          <input type="range" data-quality min="50" max="100" value="92" />
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-go disabled>Save the image</button>
        <button class="btn secondary" data-reset>Choose another image</button>
      </div>
    </div>
  `);

  const textArea = editor.querySelector('[data-text]');
  const vposSel = editor.querySelector('[data-vpos]');
  const hposSel = editor.querySelector('[data-hpos]');
  const sizeSlider = editor.querySelector('[data-size]');
  const marginSlider = editor.querySelector('[data-margin]');
  const fontSel = editor.querySelector('[data-font]');
  const colourInput = editor.querySelector('[data-color]');
  const styleSel = editor.querySelector('[data-style]');
  const barColourInput = editor.querySelector('[data-barcolor]');
  const barOpacitySlider = editor.querySelector('[data-baropacity]');
  const boldBox = editor.querySelector('[data-bold]');
  const italicBox = editor.querySelector('[data-italic]');
  const upperBox = editor.querySelector('[data-upper]');
  const stage = editor.querySelector('[data-stage]');
  const infoNote = editor.querySelector('[data-info]');
  const formatSel = editor.querySelector('[data-format]');
  const qualitySlider = editor.querySelector('[data-quality]');
  const goBtn = editor.querySelector('[data-go]');

  for (const [key, font] of Object.entries(FONTS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = font.label;
    fontSel.appendChild(o);
  }

  // Live numbers next to the sliders, so a percentage means something.
  const sizeOut = editor.querySelector('[data-sizeout]');
  const marginOut = editor.querySelector('[data-marginout]');
  const opacityOut = editor.querySelector('[data-opacityout]');
  const qualityOut = editor.querySelector('[data-qout]');
  sizeSlider.addEventListener('input', () => { sizeOut.textContent = sizeSlider.value; });
  marginSlider.addEventListener('input', () => { marginOut.textContent = marginSlider.value; });
  barOpacitySlider.addEventListener('input', () => { opacityOut.textContent = barOpacitySlider.value; });
  qualitySlider.addEventListener('input', () => { qualityOut.textContent = qualitySlider.value; });

  styleSel.addEventListener('change', () => {
    const bar = styleSel.value === 'bar';
    editor.querySelector('[data-barwrap]').hidden = !bar;
    editor.querySelector('[data-baropacitywrap]').hidden = !bar;
  });
  formatSel.addEventListener('change', () => {
    editor.querySelector('[data-qwrap]').hidden = formatSel.value !== 'image/jpeg';
  });

  // Every control redraws. Selects and checkboxes fire *both* `input` and
  // `change`, so listening for one event each keeps a single click to a single
  // redraw — which matters when the canvas is a 12 MP photo.
  const controls = [textArea, vposSel, hposSel, sizeSlider, marginSlider, fontSel, colourInput,
    styleSel, barColourInput, barOpacitySlider, boldBox, italicBox, upperBox, formatSel];
  for (const control of controls) {
    const discrete = control.tagName === 'SELECT' || control.type === 'checkbox';
    control.addEventListener(discrete ? 'change' : 'input', draw);
  }

  editor.querySelector('[data-reset]').addEventListener('click', reset);

  /**
   * Zeroing a canvas hands its pixel buffer back straight away instead of
   * waiting for the next GC — a 12 MP photo is ~48 MB of RGBA, and this tool
   * keeps two of them: the untouched source and the one on screen.
   */
  function releaseCanvases() {
    if (source) { source.width = 0; source.height = 0; source = null; }
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
  }

  function reset() {
    file = null;
    releaseCanvases();
    stage.innerHTML = '';
    editor.hidden = true;
    zone.hidden = false;
    resultsHost.innerHTML = '';
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    try {
      const img = await loadImage(f);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) throw new Error(`${f.name} came back with no pixels. Try re-saving it as a JPG or PNG.`);
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
        throw new Error(`${f.name} is ${width}×${height}, which is more than a browser canvas can hold — phones especially. Shrink it with Resize Image first, then add the text.`);
      }

      file = f;
      // The previous image's two buffers go back now, not once the new ones have
      // already been allocated alongside them.
      releaseCanvases();
      source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      source.getContext('2d').drawImage(img, 0, 0);

      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      // CSS scales the canvas down to fit the page (.canvas-stage canvas has
      // max-width:100%), so what you edit is the full-resolution image, not a
      // preview that has to be re-rendered bigger on export.
      stage.innerHTML = '';
      stage.appendChild(canvas);

      // PNG in, PNG out: screenshots are usually PNG, and re-encoding sharp
      // text and thin UI lines as JPG is exactly where JPG looks worst.
      formatSel.value = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
      editor.querySelector('[data-qwrap]').hidden = formatSel.value !== 'image/jpeg';

      infoNote.textContent = `${f.name} · ${width}×${height} · ${formatBytes(f.size)}. The preview is scaled to fit this page; the file you save keeps all ${width}×${height} pixels.`;

      zone.hidden = true;
      editor.hidden = false;
      draw();
      textArea.focus();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** Redraws the whole canvas: the source image, then the text on top. */
  function draw() {
    if (!canvas || !source) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    // JPG has no transparency, so a transparent PNG would come out with black
    // where the holes are. Painting white first means the preview shows exactly
    // what gets saved instead of springing that on the student afterwards.
    if (formatSel.value === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.drawImage(source, 0, 0);

    // toLocaleUpperCase leaves Thai and Burmese untouched — they have no case —
    // while still handling Turkish "i" and German "ß" properly.
    const raw = textArea.value;
    const text = upperBox.checked ? raw.toLocaleUpperCase() : raw;
    goBtn.disabled = !text.trim();
    if (!text.trim()) return;

    // Sizes are percentages of the image width, so the same settings look the
    // same on a 400 px screenshot and a 4000 px phone photo.
    const fontSize = Math.max(6, (width * Number(sizeSlider.value)) / 100);
    const margin = (width * Number(marginSlider.value)) / 100;
    const maxWidth = Math.max(fontSize, width - margin * 2);
    const lineHeight = fontSize * 1.32;

    const weight = boldBox.checked ? 700 : 400;
    const slant = italicBox.checked ? 'italic ' : '';
    ctx.font = `${slant}${weight} ${fontSize}px ${FONTS[fontSel.value].stack}`;

    const lines = text.split(/\r?\n/).flatMap((line) => wrapLine(ctx, line, maxWidth));
    const blockHeight = lines.length * lineHeight;

    const vpos = vposSel.value;
    const blockTop = vpos === 'top' ? margin
      : vpos === 'middle' ? (height - blockHeight) / 2
        : height - margin - blockHeight;

    const hpos = hposSel.value;
    const x = hpos === 'left' ? margin : hpos === 'right' ? width - margin : width / 2;

    if (styleSel.value === 'bar') {
      // The bar has to be measured, not guessed: it wraps the widest wrapped
      // line, not the widest line the student typed.
      const widest = lines.reduce((w, line) => Math.max(w, ctx.measureText(line).width), 0);
      const padX = fontSize * 0.35;
      const padY = fontSize * 0.22;
      const left = hpos === 'left' ? x - padX
        : hpos === 'right' ? x - widest - padX
          : x - widest / 2 - padX;
      ctx.save();
      ctx.globalAlpha = Number(barOpacitySlider.value) / 100;
      ctx.fillStyle = barColourInput.value;
      ctx.fillRect(left, blockTop - padY, widest + padX * 2, blockHeight + padY * 2);
      ctx.restore();
    }

    // The select's values are canvas textAlign values on purpose.
    ctx.textAlign = hpos;
    ctx.textBaseline = 'top';
    ctx.fillStyle = colourInput.value;
    const outlined = styleSel.value === 'outline';
    if (outlined) {
      // A sixth of the font size is the weight that reads as a caption outline
      // at any resolution; round joins stop spikes on sharp corners.
      ctx.lineWidth = fontSize / 6;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = outlineColour(colourInput.value);
    }
    lines.forEach((line, i) => {
      const y = blockTop + i * lineHeight + (lineHeight - fontSize) / 2;
      // Stroke first, then fill: the other way round and the outline eats half
      // the thickness of every letter.
      if (outlined) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    });
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    try {
      const type = formatSel.value;
      const blob = await canvasToBlob(canvas, type, type === 'image/jpeg' ? Number(qualitySlider.value) / 100 : undefined);
      const name = `${stem(file.name)}-labelled.${MIME_EXT[type]}`;
      downloadBlob(blob, name);
      toast('Saved to your downloads');
      resultsHost.appendChild(resultCard({
        heading: '✅ Text added',
        message: 'Saved to your downloads at the image\'s full size. If your phone blocked the download, the button below saves it again. Keep editing above and press Save for another version.',
        stats: [
          [`${canvas.width}×${canvas.height}`, 'Pixels'],
          [formatBytes(blob.size), 'File size'],
          [formatBytes(file.size), 'Original'],
        ],
        outputs: [{ name, blob }],
      }));
    } catch (err) {
      errorBox(panel, `Could not save the image. ${err.message}`);
    } finally {
      goBtn.disabled = false;
    }
  });

  window.addEventListener('hashchange', releaseCanvases, { once: true });

  panel.append(zone, editor);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Outlined white text is the setting to reach for on a photo — a plain
    colour disappears the moment the background behind it changes. If you're labelling a
    screenshot as proof of a submission, put your name and student ID in a corner at about
    4%: big enough to read on a projector, small enough to stay out of the way. The image
    is drawn here in your browser and never uploaded.</p>
  `));
}
