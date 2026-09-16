import { canvasToBlob, el, formatBytes, loadImage, stem, MIME_EXT } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, numberField, optionPanel, segmented,
  selectField, sliderField,
} from '../option-ui.js';

// What this tool is, stated once and repeated wherever a student might assume
// otherwise. Their version of this tool runs an AI model on a server; ours does
// arithmetic on the pixels that are already there. Both make a small picture
// bigger; only one of them can be honest about what happens to the detail.
const HONESTY = 'This is high-quality resampling (Lanczos-3), not an AI model. It is sharper than your browser\'s default enlargement, but it cannot invent detail that was never photographed.';

const SCALES = [
  { id: '2', label: '2×' },
  { id: '4', label: '4×' },
  { id: 'custom', label: 'Custom' },
];

const FORMATS = [
  { id: 'keep', label: 'Keep the original format' },
  { id: 'image/png', label: 'PNG — no extra quality loss' },
  { id: 'image/jpeg', label: 'JPG — smallest file' },
  { id: 'image/webp', label: 'WebP — smaller again' },
];

// A browser canvas refuses to allocate past these, and Safari on a phone is the
// strictest of the lot. An enlargement is the one job that walks straight into
// the limit, so both the input and the result are checked against it — a
// silently blank export would be a far worse outcome than a sentence saying
// "2× instead of 4×".
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;

// The side of the two comparison panels, in real pixels on the screen. Big
// enough to show what a kernel does to an eyelash, small enough that both
// panels and the picker fit next to each other on a laptop.
const PATCH = 232;

// Rows between yields in every pixel loop. 24 rows of a 4000-pixel-wide image
// is a few milliseconds of work — short enough that Cancel stays clickable,
// long enough that the yields themselves are not the bottleneck.
// Yield on a time budget rather than a row count. setTimeout is clamped to about
// 4 ms in a visible tab and throttled to roughly once a second in a background
// one, so "yield every 24 rows" turns a 1600-row pass into 66 forced waits — and
// into a 66-second wait the moment the student switches tabs to do something
// else, which is exactly when they would leave a big enlargement running.
// Yielding only once a frame's worth of work has actually gone by keeps the page
// responsive and makes the cost track the work instead of the image height.
const YIELD_BUDGET_MS = 24;
let lastYieldAt = 0;

async function breathe() {
  const now = performance.now();
  if (now - lastYieldAt < YIELD_BUDGET_MS) return false;
  await new Promise((r) => setTimeout(r, 0));
  lastYieldAt = performance.now();
  return true;
}

export default function render(container, tool) {
  const state = {
    file: null,
    srcCanvas: null,       // the photo at its natural size, decoded once
    srcData: null,         // its ImageData — the input to every pass
    width: 0,
    height: 0,
    mode: '2',
    // Where the magnifier is pointing, as a fraction of the photo. The middle
    // is the least useful default on a portrait, but it is the only one that is
    // never wrong, and the box is draggable.
    rx: 0.5,
    ry: 0.5,
  };
  const ui = {};
  let areaHost = null;
  let previewToken = 0;
  // Declared up here with the rest: update() reaches schedulePreview() and
  // would hit the temporal dead zone if this sat next to the function itself.
  let previewTimer = null;

  toolShell(container, tool, {
    accept: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
    multiple: false,
    pickLabel: 'Select an image',
    dropLabel: 'or drop a small photo here',
    actionLabel: 'Enlarge image',
    doneTitle: 'Your image has been enlarged!',
    downloadLabel: 'Download enlarged image',
    continueTo: ['compress-image', 'photo-editor', 'image-text'],
    note: 'Worth knowing before you print: enlarging fixes the pixel count, not the detail. A 400-pixel logo blown up to 1600 will have clean, smooth edges instead of jagged steps — which is exactly what a poster or a slide needs — but the fuzz in a distant, blurry photo stays fuzz. If the original still exists somewhere at a bigger size, that file will always beat this one.',

    // The workarea is a magnifier: the same patch of the photo, enlarged the
    // same amount, side by side with what the browser would have done on its
    // own. That comparison is the entire claim this tool makes, so it should be
    // visible before anyone presses the button.
    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Enlarge');
      ui.facts = fileFacts();
      ui.explain = liveExplain();
      ui.about = infoBox(HONESTY);
      // The one thing that can genuinely fail here is asking for a result no
      // browser can hold. Say so while the settings are still being chosen,
      // not after a long run.
      ui.warn = infoBox('');
      ui.warn.root.classList.add('opt__info--bad');
      ui.warn.root.hidden = true;

      ui.scale = segmented(SCALES, (s) => {
        state.mode = s.id;
        // Landing on Custom with the field still showing the last preset's
        // result is the least surprising starting point.
        if (s.id === 'custom' && state.width) ui.width.value = Math.min(MAX_SIDE, state.width * 2);
        syncVisibility();
        update();
      });
      const scaleField = el(`<div class="opt__field"><label class="opt__label">How much bigger</label></div>`);
      scaleField.appendChild(ui.scale.root);

      ui.width = numberField('Width', {
        value: 1600, min: 16, max: MAX_SIDE, step: 10, suffix: 'px',
        hint: 'The height follows on its own, so the photo keeps its shape.',
        onChange: update,
      });

      ui.sharpen = sliderField('Sharpening', { value: 40, min: 0, max: 100, suffix: '%', onChange: update });
      ui.sharpen.root.appendChild(el(`<p class="opt__hint">An unsharp mask over the enlarged pixels. It puts the bite back into edges that resampling softens. Past about 70% it starts drawing pale halos along strong edges — watch the right-hand panel.</p>`));

      ui.denoise = checkRow('Reduce JPEG noise first', {
        hint: 'A light 3×3 median pass before enlarging. Worth it for a small photo saved and re-saved through chat apps, because enlarging makes its blocky speckle bigger too. Skip it for screenshots and line art — it rounds off fine detail.',
        onChange: update,
      });

      ui.format = selectField('Save as', FORMATS, { value: 'keep', onChange: () => { syncVisibility(); update(); } });
      ui.quality = sliderField('Quality', { value: 92, min: 50, max: 100, suffix: '%', onChange: update });

      panel.add(
        scaleField, ui.width, ui.facts, ui.sharpen, ui.denoise,
        ui.format, ui.quality, ui.explain, ui.warn, ui.about,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.srcData) throw new Error('Choose an image first.');
      const plan = planSize();
      const problem = sizeProblem(plan);
      if (problem) throw new Error(problem);

      const t = outputType();
      ctx.setBusy(0.02, 'Reading the pixels…');
      let work = { data: new Uint8ClampedArray(state.srcData.data), width: state.width, height: state.height };

      if (ui.denoise.value) {
        work = await medianPass(work, {
          signal: ctx.signal,
          onProgress: (f) => ctx.setBusy(0.05 + f * 0.1, 'Smoothing JPEG speckle…'),
        });
      }

      work = await resample(work, plan.w, plan.h, {
        signal: ctx.signal,
        onProgress: (f) => ctx.setBusy(0.15 + f * 0.7, `Resampling to ${plan.w}×${plan.h}…`),
      });

      const amount = ui.sharpen.value / 100;
      if (amount > 0) {
        work = await unsharpMask(work, amount, plan.factor, {
          signal: ctx.signal,
          onProgress: (f) => ctx.setBusy(0.85 + f * 0.1, 'Sharpening the edges…'),
        });
      }

      ctx.setBusy(0.96, 'Saving the image…');
      const canvas = document.createElement('canvas');
      canvas.width = plan.w;
      canvas.height = plan.h;
      const c2 = canvas.getContext('2d');
      c2.putImageData(new ImageData(work.data, plan.w, plan.h), 0, 0);
      if (t === 'image/jpeg') {
        // JPG has no transparency, so a transparent PNG would come out with
        // black where the holes are — white is what a logo on a slide wants.
        // putImageData replaces whatever is underneath rather than drawing over
        // it, so the white has to be composited *under* the pixels afterwards.
        c2.globalCompositeOperation = 'destination-over';
        c2.fillStyle = '#ffffff';
        c2.fillRect(0, 0, plan.w, plan.h);
        c2.globalCompositeOperation = 'source-over';
      }

      const blob = await canvasToBlob(canvas, t, t === 'image/png' ? undefined : ui.quality.value / 100);
      // Hand the pixel buffer back now rather than at the next GC — an enlarged
      // photo is tens of megabytes and the student may well run it again.
      canvas.width = 0;
      canvas.height = 0;

      const label = plan.factor === Math.round(plan.factor) ? `${plan.factor}x` : `${plan.w}px`;
      return {
        outputs: [{ name: `${stem(state.file.name)}-enlarged-${label}.${MIME_EXT[t] ?? 'png'}`, blob }],
        doneTitle: `Enlarged from ${state.width}×${state.height} to ${plan.w}×${plan.h}!`,
        downloadLabel: `Download the ${plan.w}×${plan.h} image · ${formatBytes(blob.size)}`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function loadFile() {
    releaseSource();
    if (!state.file) { state.width = 0; state.height = 0; update(); return; }

    const img = await loadImage(state.file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error(`${state.file.name} came back with no pixels. Try re-saving it as a JPG or PNG first.`);
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
      throw new Error(`${state.file.name} is already ${w}×${h}, which is as much as a browser canvas can hold. Enlarging it further is not possible here — and at that size it almost certainly does not need it.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0);
    state.srcCanvas = canvas;
    state.srcData = canvas.getContext('2d').getImageData(0, 0, w, h);
    state.width = w;
    state.height = h;
    state.rx = 0.5;
    state.ry = 0.5;

    ui.facts.set([
      ['Original size', formatBytes(state.file.size)],
      ['Pixels', `${w}×${h}`],
    ]);
    ui.width.value = Math.min(MAX_SIDE, w * 2);
    // "Keep the original format" only becomes a real format once a file is
    // loaded, and whether the quality slider means anything depends on it.
    syncVisibility();
    paintArea();
    update();
  }

  function releaseSource() {
    if (state.srcCanvas) { state.srcCanvas.width = 0; state.srcCanvas.height = 0; state.srcCanvas = null; }
    state.srcData = null;
  }

  // -------------------------------------------------------------------------
  // The plan the settings describe
  // -------------------------------------------------------------------------

  /** Current settings → the exact output size, and the factor it works out at. */
  function planSize() {
    const { width, height } = state;
    if (!width) return { w: 0, h: 0, factor: 1 };
    if (state.mode === 'custom') {
      const w = Math.max(16, Math.round(ui.width?.value ?? width * 2));
      // Round the height rather than floor it, and never let it hit zero on a
      // very wide panorama.
      return { w, h: Math.max(1, Math.round((w / width) * height)), factor: w / width };
    }
    const f = Number(state.mode);
    return { w: Math.round(width * f), h: Math.round(height * f), factor: f };
  }

  /** null if the plan is achievable, otherwise the sentence explaining why not. */
  function sizeProblem(plan) {
    if (!plan.w || !plan.h) return null;
    if (plan.w > MAX_SIDE || plan.h > MAX_SIDE) {
      return `That would be ${plan.w}×${plan.h}, and no browser will draw an image longer than ${MAX_SIDE} pixels on a side. Choose a smaller enlargement.`;
    }
    if (plan.w * plan.h > MAX_PIXELS) {
      const mp = (plan.w * plan.h / 1e6).toFixed(0);
      return `That would be ${plan.w}×${plan.h} — about ${mp} megapixels, more than a browser (a phone especially) can hold in one image. Try 2× instead of 4×, or crop the part you actually need first.`;
    }
    return null;
  }

  function outputType() {
    const chosen = ui.format.value;
    if (chosen !== 'keep') return chosen;
    // A format canvas cannot write back out becomes PNG rather than silently
    // becoming a JPG nobody asked for.
    return MIME_EXT[state.file?.type] ? state.file.type : 'image/png';
  }

  function syncVisibility() {
    ui.width.root.hidden = state.mode !== 'custom';
    // PNG is lossless, so a quality slider beside it would be a lie.
    ui.quality.root.hidden = outputType() === 'image/png';
  }

  function update() {
    if (!ui.explain) return;
    if (!state.width) { ui.explain.set(''); ui.warn.root.hidden = true; return; }

    const plan = planSize();
    const problem = sizeProblem(plan);
    ui.warn.set(problem ?? '');
    ui.warn.root.hidden = !problem;

    const times = plan.factor >= 1
      ? `${plan.factor % 1 === 0 ? plan.factor : plan.factor.toFixed(2)}× bigger`
      : `${Math.round(plan.factor * 100)}% of its current size`;
    const bits = [];
    if (ui.denoise.value) bits.push('JPEG speckle smoothed first');
    bits.push(ui.sharpen.value > 0 ? `sharpened by ${ui.sharpen.value}%` : 'no sharpening');
    const fmt = ui.format.value === 'keep'
      ? (MIME_EXT[state.file?.type] ?? 'png').toUpperCase()
      : MIME_EXT[ui.format.value].toUpperCase();

    ui.explain.set(
      plan.factor < 1
        ? `This ${state.width}×${state.height} image would come out at ${plan.w}×${plan.h} — that is smaller, not bigger. Lanczos-3 does a good job of shrinking too, but Resize Image is the tool built for it.`
        : `Your ${state.width}×${state.height} image will be enlarged to ${plan.w}×${plan.h} — ${times} — with Lanczos-3 resampling, ${bits.join(' and ')}, saved as ${fmt}. It cannot invent detail that was never photographed.`,
    );
    // How much of the photo fits in a panel depends on the enlargement, so the
    // rectangle on the picker has to be redrawn whenever the settings move —
    // otherwise it shows the region the *previous* setting magnified.
    positionMarker();
    schedulePreview();
  }

  // -------------------------------------------------------------------------
  // The magnifier
  // -------------------------------------------------------------------------

  function paintArea() {
    if (!areaHost) return;
    areaHost.innerHTML = '';
    if (!state.srcCanvas) return;

    const stage = el(`<div style="display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start;justify-content:center"></div>`);

    // ---- the picker: the whole photo, with the magnified region marked ----
    const pickWrap = el(`<div style="flex:0 0 auto;max-width:300px"></div>`);
    const frame = el(`<div style="position:relative;line-height:0;border-radius:8px;overflow:hidden;box-shadow:var(--shadow);touch-action:none;cursor:crosshair"></div>`);
    const shown = document.createElement('canvas');
    // The picker never needs more than a few hundred pixels, and copying the
    // full photo into the DOM a second time would double the memory this tool
    // already holds.
    const pw = Math.min(300, state.width);
    shown.width = Math.max(1, Math.round(pw));
    shown.height = Math.max(1, Math.round((pw / state.width) * state.height));
    shown.getContext('2d').drawImage(state.srcCanvas, 0, 0, shown.width, shown.height);
    shown.style.cssText = 'display:block;width:100%;height:auto';

    // The huge spread shadow is the dimmer: everything outside the marker goes
    // dark, so the magnified patch is obvious at a glance.
    const marker = el(`<div data-marker style="position:absolute;border:2px solid var(--accent);border-radius:3px;box-shadow:0 0 0 9999px rgba(15,20,32,.32);pointer-events:none"></div>`);
    frame.append(shown, marker);
    frame.addEventListener('pointerdown', (e) => {
      frame.setPointerCapture?.(e.pointerId);
      pickRegion(e, frame);
    });
    frame.addEventListener('pointermove', (e) => { if (e.buttons) pickRegion(e, frame); });

    pickWrap.append(
      frame,
      el(`<p class="ts__hint">Drag anywhere on the photo to move the magnifier. Pick something with a hard edge — text, a face, the rim of a logo.</p>`),
    );

    // ---- the two panels ----
    const panels = el(`<div style="flex:1 1 340px;min-width:0"></div>`);
    const row = el(`<div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center"></div>`);
    row.append(panel('before', 'Your browser, enlarging it'), panel('after', 'UniLab — Lanczos-3'));
    panels.append(row, el(`<p class="ts__hint" data-patch style="text-align:center"></p>`));

    stage.append(pickWrap, panels);
    areaHost.appendChild(stage);
    positionMarker();
    schedulePreview();

    function panel(key, caption) {
      const box = el(`<figure style="margin:0;text-align:center"></figure>`);
      const c = document.createElement('canvas');
      c.width = PATCH;
      c.height = PATCH;
      c.dataset.panel = key;
      // Shown at exactly its own pixel size: the whole point is to look at real
      // output pixels, not at a picture of them that the page has rescaled.
      c.style.cssText = `width:${PATCH}px;height:${PATCH}px;max-width:100%;display:block;border-radius:8px;border:1px solid var(--line);background:var(--card);image-rendering:pixelated`;
      const cap = el(`<figcaption class="ts__hint" style="margin-top:6px;font-weight:700"></figcaption>`);
      cap.textContent = caption;
      box.append(c, cap);
      return box;
    }
  }

  function pickRegion(e, frame) {
    const b = frame.getBoundingClientRect();
    if (!b.width) return;
    e.preventDefault();
    state.rx = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    state.ry = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
    positionMarker();
    schedulePreview();
  }

  /** Draws the marker over the picker at the size of the region being magnified. */
  function positionMarker() {
    const marker = areaHost?.querySelector('[data-marker]');
    if (!marker || !state.width) return;
    const region = regionSize();
    const wPct = (region.w / state.width) * 100;
    const hPct = (region.h / state.height) * 100;
    const left = state.rx * 100 - wPct / 2;
    const top = state.ry * 100 - hPct / 2;
    marker.style.width = `${wPct}%`;
    marker.style.height = `${hPct}%`;
    marker.style.left = `${Math.min(100 - wPct, Math.max(0, left))}%`;
    marker.style.top = `${Math.min(100 - hPct, Math.max(0, top))}%`;
  }

  /** How much of the original fits in a panel, in source pixels. */
  function regionSize() {
    const plan = planSize();
    const f = Math.max(0.05, plan.factor);
    const side = Math.max(6, Math.min(state.width, state.height, Math.ceil(PATCH / f)));
    return { w: side, h: side };
  }

  function schedulePreview() {
    // Sliders fire on every pixel of travel. One trailing render per gesture is
    // what the eye needs, and it keeps a 4× patch off the main thread's back.
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { renderPreview().catch(() => { /* a preview is a nicety */ }); }, 90);
  }

  async function renderPreview() {
    if (!areaHost || !state.srcData) return;
    const before = areaHost.querySelector('[data-panel="before"]');
    const after = areaHost.querySelector('[data-panel="after"]');
    if (!before || !after) return;

    const token = ++previewToken;
    const region = regionSize();
    const sx = Math.round(Math.min(state.width - region.w, Math.max(0, state.rx * state.width - region.w / 2)));
    const sy = Math.round(Math.min(state.height - region.h, Math.max(0, state.ry * state.height - region.h / 2)));

    const note = areaHost.querySelector('[data-patch]');
    if (note) note.textContent = `Both panels show the same ${region.w}×${region.h} patch, enlarged to ${PATCH}×${PATCH}. The left one is drawImage — what the browser does when a page simply displays a small photo at a big size.`;

    // Left: exactly what the browser's own smoothing produces.
    const b2 = before.getContext('2d');
    b2.imageSmoothingEnabled = true;
    b2.imageSmoothingQuality = 'high';
    b2.clearRect(0, 0, PATCH, PATCH);
    b2.drawImage(state.srcCanvas, sx, sy, region.w, region.h, 0, 0, PATCH, PATCH);

    // Right: the real pipeline, on the patch only — the same three passes the
    // export runs, so what is on screen is not a different algorithm.
    let patch = cropData(state.srcData, sx, sy, region.w, region.h);
    if (ui.denoise.value) patch = await medianPass(patch, {});
    patch = await resample(patch, PATCH, PATCH, {});
    const amount = ui.sharpen.value / 100;
    if (amount > 0) patch = await unsharpMask(patch, amount, PATCH / region.w, {});
    if (token !== previewToken) return;   // the settings moved on while we worked

    after.getContext('2d').putImageData(new ImageData(patch.data, PATCH, PATCH), 0, 0);
  }

  window.addEventListener('hashchange', function leave() {
    clearTimeout(previewTimer);
    releaseSource();
  }, { once: true });
}

// ===========================================================================
// The pixel passes. Plain functions over {data, width, height} so they can run
// on a 232-pixel patch for the preview and on a 12-megapixel photo for the
// export without knowing the difference.
// ===========================================================================

/** Copies a rectangle out of an ImageData. */
function cropData(src, sx, sy, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * src.width + sx) * 4;
    out.set(src.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * Lanczos-3: sin(πx)·sin(πx/3)/(πx)² out to three source pixels either side.
 * The two extra lobes are negative, which is where the crispness comes from —
 * the filter actively pulls contrast back into an edge that a plain bilinear
 * average would have smeared across the gap.
 */
function lanczos3(x) {
  if (x === 0) return 1;
  const a = Math.abs(x);
  if (a >= 3) return 0;
  const pix = Math.PI * a;
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

/**
 * Precomputes, for every destination position along one axis, which source
 * positions it reads and how much of each. Doing this once per axis instead of
 * once per pixel is the difference between a second and a minute.
 */
function buildWeights(srcLen, dstLen) {
  const scale = dstLen / srcLen;
  // Enlarging reads three source pixels either side. Shrinking has to widen the
  // window to the same three *destination* pixels, or it samples too sparsely
  // and aliases.
  const support = scale >= 1 ? 3 : 3 / scale;
  const maxTaps = Math.min(srcLen, Math.ceil(support * 2) + 2);
  const starts = new Int32Array(dstLen);
  const counts = new Int32Array(dstLen);
  const weights = new Float32Array(dstLen * maxTaps);

  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / scale;
    const first = Math.max(0, Math.floor(center - support + 0.5));
    const last = Math.min(srcLen - 1, Math.ceil(center + support - 0.5));
    const base = i * maxTaps;
    let sum = 0;
    let n = 0;
    for (let j = first; j <= last && n < maxTaps; j++, n++) {
      const w = lanczos3((j + 0.5 - center) * Math.min(1, scale));
      weights[base + n] = w;
      sum += w;
    }
    // Normalising is what stops the edges of the picture going dark: the window
    // is clipped there, so its weights no longer add up to one.
    if (sum !== 0) for (let k = 0; k < n; k++) weights[base + k] /= sum;
    starts[i] = first;
    counts[i] = n;
  }
  return { starts, counts, weights, maxTaps };
}

/** True if any pixel is even slightly transparent. One cheap pass to find out. */
function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

/**
 * Resamples with a separable Lanczos-3 kernel: one horizontal pass, then one
 * vertical pass over the result. Separating the two turns a 7×7 window into
 * 7+7 reads per pixel, which is the only reason this is practical in JS.
 *
 * Both passes yield to the event loop every few rows, so a 4× enlargement of a
 * big photo leaves the tab responsive and the Cancel button live.
 */
async function resample(src, dstW, dstH, { signal, onProgress } = {}) {
  const { width: srcW, height: srcH } = src;
  if (dstW === srcW && dstH === srcH) return src;

  const data = src.data;
  // Colour in a transparent pixel is meaningless, but the filter would still
  // average it in and leave a coloured halo around a cut-out. Weighting colour
  // by alpha first (and dividing it back out after) is the fix; images with no
  // transparency skip both passes.
  //
  // The weighting is done one row at a time into a scratch buffer rather than
  // over the whole image, so the caller's own pixels are never rewritten
  // underneath it — this function is handed the live preview patch as well as
  // the export buffer.
  const premul = hasAlpha(data);

  const hx = buildWeights(srcW, dstW);
  // The intermediate is 8-bit rather than float on purpose: at 16 megapixels a
  // Float32 buffer is a quarter of a gigabyte, and the rounding it would save
  // is invisible next to the kernel's own ringing.
  //
  // It is also stored TRANSPOSED — column-major, [x][y]. The vertical pass that
  // follows walks six taps down a column, and on a row-major buffer those taps
  // sit dstW*4 bytes apart: every single one is a cache miss, and that alone was
  // costing more than all the arithmetic in this function put together. Writing
  // the intermediate sideways makes both passes read straight lines of memory.
  const tmp = new Uint8ClampedArray(dstW * srcH * 4);
  const rowBuf = premul ? new Uint8ClampedArray(srcW * 4) : null;

  for (let y = 0; y < srcH; y++) {
    if (signal?.aborted) throw new Error('canceled');
    let rowSrc = data;
    let rowIn = y * srcW * 4;
    if (premul) {
      for (let i = 0; i < rowBuf.length; i += 4) {
        const alpha = data[rowIn + i + 3] / 255;
        rowBuf[i] = data[rowIn + i] * alpha;
        rowBuf[i + 1] = data[rowIn + i + 1] * alpha;
        rowBuf[i + 2] = data[rowIn + i + 2] * alpha;
        rowBuf[i + 3] = data[rowIn + i + 3];
      }
      rowSrc = rowBuf;
      rowIn = 0;
    }
    for (let x = 0; x < dstW; x++) {
      const base = x * hx.maxTaps;
      const start = hx.starts[x];
      const n = hx.counts[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++) {
        const w = hx.weights[base + k];
        const p = rowIn + (start + k) * 4;
        r += rowSrc[p] * w; g += rowSrc[p + 1] * w; b += rowSrc[p + 2] * w; a += rowSrc[p + 3] * w;
      }
      const o = (x * srcH + y) * 4;          // transposed: column x, row y
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
    if (await breathe()) onProgress?.((y / srcH) * 0.5);
  }

  const vy = buildWeights(srcH, dstH);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    if (signal?.aborted) throw new Error('canceled');
    const base = y * vy.maxTaps;
    const start = vy.starts[y];
    const n = vy.counts[y];
    const rowOut = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const col = x * srcH;
      for (let k = 0; k < n; k++) {
        const w = vy.weights[base + k];
        const p = (col + start + k) * 4;    // contiguous down the transposed column
        r += tmp[p] * w; g += tmp[p + 1] * w; b += tmp[p + 2] * w; a += tmp[p + 3] * w;
      }
      const o = rowOut + x * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    if (await breathe()) onProgress?.(0.5 + (y / dstH) * 0.5);
  }
  onProgress?.(1);

  if (premul) {
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a === 0) continue;
      const f = 255 / a;
      out[i] *= f; out[i + 1] *= f; out[i + 2] *= f;
    }
  }
  return { data: out, width: dstW, height: dstH };
}

/**
 * A 3×3 median on the colour channels. Median is the right filter for JPEG
 * speckle specifically: it throws away the odd wrong pixel entirely instead of
 * averaging it into its neighbours the way a blur would, so edges survive.
 * Alpha is left alone — softening a cut-out's edge is not what was asked for.
 */
async function medianPass(src, { signal, onProgress } = {}) {
  const { width: w, height: h, data } = src;
  if (w < 3 || h < 3) return src;
  const out = new Uint8ClampedArray(data);
  const win = new Uint8Array(9);

  for (let y = 1; y < h - 1; y++) {
    if (signal?.aborted) throw new Error('canceled');
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) win[n++] = data[((y + dy) * w + (x + dx)) * 4 + c];
        }
        // Insertion sort on nine values beats every clever algorithm at this
        // size, and it runs a few million times.
        for (let i = 1; i < 9; i++) {
          const v = win[i];
          let j = i - 1;
          while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
          win[j + 1] = v;
        }
        out[(y * w + x) * 4 + c] = win[4];
      }
    }
    if (await breathe()) onProgress?.(y / h);
  }
  onProgress?.(1);
  return { data: out, width: w, height: h };
}

/**
 * Unsharp mask: blur a copy, then push every pixel away from that blur.
 *
 * The blur radius follows the enlargement, because that is what the softness
 * follows too — after a 4× enlargement one original pixel covers four, so a
 * one-pixel blur would sharpen nothing you can see.
 */
async function unsharpMask(src, amount, factor, { signal, onProgress } = {}) {
  const { width: w, height: h, data } = src;
  const radius = Math.max(1, Math.min(4, Math.round(factor)));
  const kernel = gaussianKernel(radius);
  const blurred = await blur(data, w, h, kernel, radius, { signal, onProgress: (f) => onProgress?.(f * 0.8) });

  const out = new Uint8ClampedArray(data);
  const strength = amount * 1.2;
  // Row by row rather than one straight run over the buffer: at 16 megapixels
  // that is fifty million operations, and Cancel has to stay clickable through
  // it like it does through the other two passes.
  for (let y = 0; y < h; y++) {
    if (signal?.aborted) throw new Error('canceled');
    const row = y * w * 4;
    for (let i = row; i < row + w * 4; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        out[i + c] = v + (v - blurred[i + c]) * strength;
      }
    }
    if (await breathe()) onProgress?.(0.8 + (y / h) * 0.2);
  }
  onProgress?.(1);
  return { data: out, width: w, height: h };
}

function gaussianKernel(radius) {
  const sigma = Math.max(0.6, radius / 2);
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable gaussian blur over RGB, used only as the unsharp mask's reference. */
async function blur(data, w, h, kernel, radius, { signal, onProgress } = {}) {
  const tmp = new Uint8ClampedArray(data);
  const out = new Uint8ClampedArray(data);

  for (let y = 0; y < h; y++) {
    if (signal?.aborted) throw new Error('canceled');
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        // Clamping at the edge repeats the border pixel, which is what stops a
        // dark rim appearing around the whole picture.
        const sx = Math.min(w - 1, Math.max(0, x + k));
        const p = (y * w + sx) * 4;
        const wt = kernel[k + radius];
        r += data[p] * wt; g += data[p + 1] * wt; b += data[p + 2] * wt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
    if (await breathe()) onProgress?.((y / h) * 0.5);
  }

  for (let y = 0; y < h; y++) {
    if (signal?.aborted) throw new Error('canceled');
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        const p = (sy * w + x) * 4;
        const wt = kernel[k + radius];
        r += tmp[p] * wt; g += tmp[p + 1] * wt; b += tmp[p + 2] * wt;
      }
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
    if (await breathe()) onProgress?.(0.5 + (y / h) * 0.5);
  }
  return out;
}
