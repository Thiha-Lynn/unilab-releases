import { debugError } from '../log.js';
import { bundledOffline, offlineAsset } from '../offline-assets.js';
import { canvasToBlob, el, formatBytes, loadImage, progressBar, stem, toast } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, colorField, fileFacts, infoBox, liveExplain, optionPanel, segmented, sliderField,
} from '../option-ui.js';

// Cutting a person out of a photo needs a segmentation model, and a segmentation
// model is tens of megabytes. Every commercial "remove background" button solves
// that by sending your photo to a server. UniLab cannot do that and stay UniLab,
// so it does the opposite trade: the *model* comes down to the phone once, and
// the photo never moves at all.
//
// Two honesty rules follow from that, and they shape this whole file:
//
//   1. Nothing is downloaded until the student presses a button that says how
//      big the download is. Opening the tool must cost zero bytes — that is why
//      @imgly/background-removal is behind a dynamic import() instead of a
//      normal top-level one.
//   2. The download is a download of a model *file* from a public CDN, exactly
//      like downloading a font. It carries no photo, no file name, no account.
//      The sidebar says so in those words, right next to the button.
//
// The model is ISNet, quantised to 8 bits (44 MB instead of the 168 MB float
// version). On a five-year-old laptop the quantised one is the difference
// between "slow" and "unusable", and for a slide cut-out the edge quality gap
// is not worth 124 MB of somebody's mobile data.

const MODEL = 'isnet_quint8';

// Measured from the CDN's own resources.json, so the button can promise a real
// number rather than "a large file".
const MODEL_BYTES = 44_348_940;
const RUNTIME_BYTES = { cpu: 11_845_354, gpu: 23_062_350 };

const PREVIEW_MAX = 900;   // a preview wider than this costs time and shows nothing new
const BBOX_SCAN_W = 320;   // the mask is scanned small; a crop box does not need 4000 px of precision

// A browser canvas refuses to allocate past these, and Safari on a phone is the
// strictest of the lot. The cut-out is built at the photo's full size, so a
// silently blank PNG is the failure mode this avoids.
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;

const MODES = [
  { id: 'transparent', label: 'Transparent' },
  { id: 'colour', label: 'Solid colour' },
  { id: 'blur', label: 'Blur the background' },
];

export default function render(container, tool) {
  const state = {
    file: null,
    img: null,          // the loaded photo, at its natural size
    mask: null,         // canvas, same size as the photo, alpha = "this pixel is subject"
    bbox: null,         // { x, y, w, h } fractions — the subject's bounding box, for cropping
    mode: 'transparent',
    ready: false,       // the model is downloaded and a session exists
    busy: false,        // a download or a cut-out is running right now
    device: 'cpu',
    loadGen: 0,         // bumped per file so a stale async job cannot paint over a newer one
    split: 0.5,         // where the before/after divider sits, 0…1
  };
  const ui = {};        // sidebar controls, filled in by options()
  let dom = null;       // workarea nodes, built once
  let downloadAbort = null;

  toolShell(container, tool, {
    accept: 'image/*',
    multiple: false,
    pickLabel: 'Select a photo',
    dropLabel: 'or drop it here',
    actionLabel: 'Remove background',
    doneTitle: 'Your cut-out is ready!',
    downloadLabel: 'Download the cut-out',
    continueTo: ['compress-image', 'resize-image', 'image-text'],
    note: 'A transparent PNG of a photo is a big file — a 12 MP phone photo can come out over 10 MB. If it is going into a slide or an LMS upload box, run it through Compress Image or Resize Image afterwards. And the model stays in your browser cache: the second photo you cut out needs no download at all.',

    // The workarea is the two pictures with a divider between them. A cut-out is
    // judged entirely on its edges, and a bad edge is invisible until you can
    // slide the original back over it.
    workarea(host) { buildWorkarea(host); },

    async onFiles(ctx) {
      await loadFile(ctx.files[0] ?? null);
    },

    options(host) {
      const panel = optionPanel('Remove background');

      // The exact number goes in once the graphics-adapter probe settles —
      // setLabel() refreshes both the button and this box together.
      ui.info = infoBox(infoText());

      ui.facts = fileFacts();
      ui.gate = modelGate();

      ui.mode = segmented(MODES, (m) => { state.mode = m.id; syncVisibility(); update(); });

      ui.colour = colorField('Background colour', { value: '#ffffff', onChange: update });

      ui.feather = sliderField('Soften the cut edge', {
        value: 2, min: 0, max: 8, step: 1, suffix: ' px', onChange: update,
      });

      ui.crop = checkRow('Also crop to the subject', {
        hint: 'Trims the empty space away so the subject fills the frame — what you want for a profile picture.',
        onChange: update,
      });

      ui.explain = liveExplain();

      panel.add(ui.info, ui.facts, ui.gate, ui.mode, ui.colour, ui.feather, ui.crop, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.img) throw new Error('Choose a photo first.');
      if (!state.mask) {
        // The gate is deliberate: a 50-odd megabyte download should never start
        // because somebody pressed the big green button expecting it to be
        // instant on hostel wifi.
        throw new Error(
          state.ready
            ? 'The edges have not been found yet. Press "Find the edges" in the panel on the right.'
            : (bundledOffline() ? 'Press "Load the bundled cut-out model" first.' : `The cut-out model has not been downloaded yet. Press "Download the cut-out model" — ${formatBytes(downloadSize())}, once.`),
        );
      }

      ctx.setBusy(0.2, 'Building the full-size cut-out…');
      const canvas = await compose(Infinity);
      if (ctx.signal?.aborted) throw new Error('canceled');

      // A solid colour leaves nothing transparent, so JPG is the honest export —
      // it is a quarter of the size for the same picture. Everything else keeps
      // its alpha channel and has to be a PNG.
      const asJpg = state.mode === 'colour';
      ctx.setBusy(0.7, asJpg ? 'Writing the JPG…' : 'Writing the PNG…');
      const blob = await canvasToBlob(canvas, asJpg ? 'image/jpeg' : 'image/png', asJpg ? 0.92 : undefined);
      ctx.setBusy(1, 'Done');

      return {
        outputs: [{ name: `${stem(state.file.name)}-cutout.${asJpg ? 'jpg' : 'png'}`, blob }],
        doneTitle: state.mode === 'transparent'
          ? 'Your background is gone!'
          : 'Your new background is on!',
      };
    },
  });

  // Leaving the tool drops the photo and the mask. The ONNX session itself is
  // held inside the library's own memoised cache and is released with the page.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    downloadAbort?.abort();
    state.img = null;
    state.mask = null;
  });

  // ---------------------------------------------------------------------------
  // the model gate — the one control that is allowed to touch the network

  function modelGate() {
    const root = el(`
      <div class="opt__field">
        <button class="btn" type="button" data-go style="width:100%"></button>
        <p class="opt__hint" data-status></p>
      </div>
    `);
    const btn = root.querySelector('[data-go]');
    const status = root.querySelector('[data-status]');
    const bar = progressBar();
    root.insertBefore(bar.root, status);

    const setLabel = () => {
      ui.info?.set(state.ready
        ? 'The model is ready to reuse. Each photo is processed on this device.'
        : infoText());
      if (state.busy) return;
      btn.textContent = !state.ready
        ? (bundledOffline() ? 'Load the bundled cut-out model' : `Download the cut-out model (${formatBytes(downloadSize())}, once)`)
        : state.mask ? 'Find the edges again' : 'Find the edges';
      btn.classList.toggle('secondary', state.ready);
      btn.disabled = false;
    };

    btn.addEventListener('click', async () => {
      if (state.busy) { downloadAbort?.abort(); return; }
      if (!state.img) { toast('Choose a photo first.'); return; }
      await getCutout();
    });

    setLabel();
    return {
      root,
      setLabel,
      /** Progress during a download; `text` alone during the inference step. */
      show(fraction, text) {
        if (fraction === null) { bar.hide(); status.textContent = text ?? ''; return; }
        bar.root.hidden = false;
        bar.set(fraction, text);
      },
      hideBar() { bar.hide(); },
      status(text) { status.textContent = text ?? ''; },
      /**
       * `cancellable` is false during inference: a running ONNX session cannot
       * be stopped part-way, and a Cancel button that does nothing is worse
       * than no button. The download step above it is genuinely abortable.
       */
      busy(on, label, cancellable = false) {
        state.busy = on;
        if (on) {
          btn.textContent = label ?? 'Cancel';
          btn.disabled = !cancellable;
          btn.classList.toggle('secondary', true);
        } else {
          setLabel();
        }
      },
    };
  }

  // CPU is the verified cross-platform engine. GPU→CPU retries can poison
  // ONNX's shared WASM initializer; do not probe or initialize a GPU session.
  function pickDevice() { return 'cpu'; }

  /** What the first press of the button will actually cost, in bytes. */
  function downloadSize() {
    return MODEL_BYTES + RUNTIME_BYTES[pickDevice()];
  }

  /**
   * The sentence beside the button. It quotes the whole download, not just the
   * model: the runtime that runs the model is another 11–22 MB, and a student
   * on mobile data is owed the number they will actually be charged for.
   */
  function infoText() {
    if (bundledOffline()) return 'The cut-out model and its CPU engine are bundled in this app. Load them from this device to remove backgrounds offline. Large images still need available memory.';
    return `Cutting a subject out needs a model file and the code that runs it — ${formatBytes(downloadSize())} in total (${formatBytes(MODEL_BYTES)} of it is the model). They come down once, from a public file host, and your browser keeps them after that. Nothing about your photo goes with the request: it is opened, measured and rewritten by this page, on this device.`;
  }

  /** Downloads the model if needed, then produces the mask for the loaded photo. */
  async function getCutout() {
    const gen = state.loadGen;
    const file = state.file;
    downloadAbort = new AbortController();
    ui.gate.busy(true, bundledOffline() ? 'Cancel loading' : 'Cancel the download', true);

    try {
      if (!state.ready) {
        await downloadModel(downloadAbort.signal);
        if (gen !== state.loadGen) return;
        state.ready = true;
      }

      ui.gate.busy(true, 'Working…');
      ui.gate.show(null, state.device === 'gpu'
        ? 'Finding the edges on the graphics chip…'
        : 'Finding the edges — CPU processing may pause the page for a few seconds.');
      paintStatus('Finding the edges…');

      // Yield first, so the status text above actually paints before a CPU run
      // takes the main thread away.
      await new Promise((r) => setTimeout(r, 40));

      const { mask, bbox } = await buildMask(file);
      if (gen !== state.loadGen) return;
      state.mask = mask;
      state.bbox = bbox;
      ui.gate.status('Ready. The model can be reused for the next photo.');
      update();
    } catch (err) {
      if (err?.name === 'AbortError' || /cancel/i.test(err?.message ?? '')) {
        ui.gate.status('Download canceled. Nothing was kept.');
        toast('Canceled');
      } else {
        debugError(err);
        ui.gate.status(friendlyError(err));
      }
      paintStatus(null);
    } finally {
      downloadAbort = null;
      ui.gate.hideBar();
      ui.gate.busy(false);
      update();
    }
  }

  async function downloadModel(signal) {
    // Imported here and nowhere else: opening this tool page must not pull a
    // megabyte of ONNX glue, and must certainly not touch the network.
    const bg = await import('@imgly/background-removal');
    state.device = 'cpu';

    const got = new Map();      // resource key → bytes so far
    // Read at progress time, not captured: a WebGPU session that fails to build
    // switches state.device to 'cpu' halfway through and the total changes.
    const expected = () => MODEL_BYTES + RUNTIME_BYTES[state.device];
    const onProgress = (key, current, total) => {
      if (!key.startsWith('fetch:')) return;
      got.set(key, { current, total });
      let done = 0, known = 0;
      for (const v of got.values()) { done += v.current; known += v.total; }
      // The denominator is the measured estimate until the real totals exceed
      // it, so the bar never sits at 100% with a file still coming down.
      const cap = Math.max(expected(), known);
      ui.gate.show(Math.min(0.99, done / cap), `${bundledOffline() ? "Loading" : "Downloading"} the model — ${formatBytes(done)} of ${formatBytes(cap)}`);
    };

    ui.gate.show(0, bundledOffline() ? 'Loading the bundled model…' : 'Starting the download…');
    await bg.preload(config('cpu', onProgress, signal));
    ui.gate.show(1, 'Model ready.');
  }

  function config(device, progress, signal) {
    return {
      model: MODEL,
      ...(bundledOffline() ? {publicPath:offlineAsset('background/')} : {}),
      device,
      // The verified WASM CPU path does not support the GPU proxy.
      proxyToWorker: false,
      progress,
      fetchArgs: signal ? { signal } : {},
      output: { format: 'image/png' },
    };
  }

  /** Runs the model and returns the alpha mask as a canvas, plus the subject's box. */
  async function buildMask(file) {
    const bg = await import('@imgly/background-removal');
    // segmentForeground gives back the mask on its own — white pixels with the
    // model's confidence in the alpha channel. Keeping the mask rather than the
    // finished cut-out is the whole reason the colour, the feather and the crop
    // can be changed afterwards without running the model again.
    const blob = await bg.segmentForeground(file, config(state.device));
    const bmp = await createImageBitmap(blob);
    const mask = document.createElement('canvas');
    mask.width = bmp.width;
    mask.height = bmp.height;
    mask.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return { mask, bbox: subjectBox(mask) };
  }

  /** The subject's bounding box, as fractions of the photo. */
  function subjectBox(mask) {
    const w = Math.max(1, Math.min(BBOX_SCAN_W, mask.width));
    const h = Math.max(1, Math.round((mask.height / mask.width) * w));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(mask, 0, 0, w, h);
    const { data } = sctx.getImageData(0, 0, w, h);

    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;   // the model found nothing at all
    // A little air around the subject; a crop pressed flat against a shoulder
    // looks like a mistake.
    const pad = 0.02;
    const fx0 = Math.max(0, x0 / w - pad);
    const fy0 = Math.max(0, y0 / h - pad);
    const fx1 = Math.min(1, (x1 + 1) / w + pad);
    const fy1 = Math.min(1, (y1 + 1) / h + pad);
    return { x: fx0, y: fy0, w: fx1 - fx0, h: fy1 - fy0 };
  }

  // ---------------------------------------------------------------------------
  // compositing — one function, used for both the live preview and the export

  /**
   * Builds the result no larger than `maxSide` pixels on its longest edge.
   * Everything the sidebar can change is applied here, from the cached mask, so
   * a colour change repaints in a few milliseconds instead of re-running a
   * 42 MB model. Pass Infinity for the real export.
   */
  async function compose(maxSide) {
    const img = state.img;
    const box = (ui.crop?.value && state.bbox) ? state.bbox : { x: 0, y: 0, w: 1, h: 1 };
    const sx = box.x * img.naturalWidth;
    const sy = box.y * img.naturalHeight;
    const sw = Math.max(1, box.w * img.naturalWidth);
    const sh = Math.max(1, box.h * img.naturalHeight);

    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

    if (state.mask) {
      // Feathering is a blur of the *mask*, not of the picture: it softens where
      // the cut happens, which is what hides the jagged single-pixel staircase
      // the model leaves along hair. The radius is scaled to the output size so
      // "2 px" looks the same on a phone photo and on a screenshot.
      const feather = (ui.feather?.value ?? 0) * (w / 1000);

      // The crop box above is in photo pixels. The mask comes back from the
      // model at the size the *decoder* saw, which is not always the size an
      // <img> reports for the same file (an EXIF-rotated JPEG is the usual
      // culprit), so the rectangle is re-expressed in the mask's own pixels
      // rather than assumed to be the same numbers.
      const mkx = state.mask.width / img.naturalWidth;
      const mky = state.mask.height / img.naturalHeight;
      const mx = sx * mkx;
      const my = sy * mky;
      const mw = Math.max(1, sw * mkx);
      const mh = Math.max(1, sh * mky);

      let src = state.mask, sxm = mx, sym = my, swm = mw, shm = mh, dx = 0, dy = 0, dw = w, dh = h;
      if (feather > 0.2) {
        // Blurring right up to the canvas edge pulls in the transparency that
        // lies outside it, so a subject that runs off the bottom of the frame
        // would fade out along that edge. The mask is therefore blurred inside
        // a padded copy: the pad is filled with a stretched version of the mask
        // (plausible edge content), the true mask is stamped exactly into the
        // middle, and the pad is thrown away on the way back.
        const pad = Math.ceil(feather * 3);
        const padded = document.createElement('canvas');
        padded.width = w + pad * 2;
        padded.height = h + pad * 2;
        const pctx = padded.getContext('2d');
        pctx.drawImage(state.mask, mx, my, mw, mh, 0, 0, padded.width, padded.height);
        pctx.clearRect(pad, pad, w, h);
        pctx.drawImage(state.mask, mx, my, mw, mh, pad, pad, w, h);
        src = padded;
        sxm = 0; sym = 0; swm = padded.width; shm = padded.height;
        dx = -pad; dy = -pad; dw = padded.width; dh = padded.height;
      }

      ctx.globalCompositeOperation = 'destination-in';
      if (feather > 0.2) ctx.filter = `blur(${feather.toFixed(2)}px)`;
      ctx.drawImage(src, sxm, sym, swm, shm, dx, dy, dw, dh);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
    }

    if (state.mode === 'colour' || state.mode === 'blur') {
      ctx.globalCompositeOperation = 'destination-over';
      if (state.mode === 'colour') {
        ctx.fillStyle = ui.colour.value;
        ctx.fillRect(0, 0, w, h);
      } else {
        // Blur samples that fall outside the canvas come back transparent, which
        // would leave a pale rim all the way round. Drawing the backdrop 6%
        // oversized pushes that rim off the edge.
        const over = 0.06;
        ctx.filter = `blur(${Math.max(4, w / 45).toFixed(1)}px)`;
        ctx.drawImage(img, sx, sy, sw, sh, -w * over, -h * over, w * (1 + 2 * over), h * (1 + 2 * over));
        ctx.filter = 'none';
        // A blurred photo is still a photo of the room; a light wash makes the
        // subject read as the subject.
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    return canvas;
  }

  // ---------------------------------------------------------------------------
  // loading

  async function loadFile(file) {
    const gen = ++state.loadGen;
    state.file = file;
    state.mask = null;
    state.bbox = null;

    if (!file) {
      state.img = null;
      ui.facts?.set([]);
      update();
      return;
    }

    const img = await loadImage(file);
    if (gen !== state.loadGen) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error(`${file.name} came back with no pixels. Try re-saving it as a JPG or PNG, then cut it out.`);
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
      throw new Error(`${file.name} is ${w}×${h}, which is bigger than a browser canvas can hold — phones especially. Shrink it with Resize Image first, then come back.`);
    }
    state.img = img;
    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Dimensions', `${img.naturalWidth} × ${img.naturalHeight}`],
    ]);
    ui.gate?.status(state.ready
      ? 'The model is ready. Press "Find the edges again".'
      : '');
    update();

    // The model is already here from a previous photo, so there is nothing to
    // warn about and no reason to make them press the button twice.
    if (state.ready && !state.busy) getCutout();
  }

  // ---------------------------------------------------------------------------
  // the workarea: before and after, with a divider you can drag

  function buildWorkarea(host) {
    if (dom) return;   // refresh() calls workarea() again on every change

    const root = el(`
      <div>
        <div class="actions" style="margin-top:0">
          <span class="ts__hint" data-label style="margin:0">Choose a photo to begin.</span>
        </div>
        <div class="canvas-stage" data-stage style="min-height:220px">
          <div data-frame style="position:relative;max-width:100%;line-height:0;touch-action:none;user-select:none;cursor:ew-resize">
            <p class="ts__hint" data-empty style="margin:0;padding:28px;line-height:1.5">The cut-out will appear here.</p>
          </div>
        </div>
        <p class="ts__hint" data-tip>Drag the divider to slide the original back over the cut-out — the edges are the only part worth checking.</p>
      </div>
    `);

    dom = {
      root,
      label: root.querySelector('[data-label]'),
      frame: root.querySelector('[data-frame]'),
      tip: root.querySelector('[data-tip]'),
    };

    wireSplit(dom.frame);
    host.innerHTML = '';
    host.appendChild(root);
    update();
  }

  function wireSplit(frame) {
    let dragging = false;
    const at = (e) => {
      const r = frame.getBoundingClientRect();
      state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      paintSplit();
    };
    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.mask) return;
      dragging = true;
      frame.setPointerCapture(e.pointerId);
      at(e);
      e.preventDefault();
    });
    frame.addEventListener('pointermove', (e) => { if (dragging) at(e); });
    const stop = () => { dragging = false; };
    frame.addEventListener('pointerup', stop);
    frame.addEventListener('pointercancel', stop);
  }

  /** Repaints both canvases. Called on every option change. */
  async function paintPreview() {
    if (!dom) return;
    if (!state.img) {
      dom.frame.innerHTML = '<p class="ts__hint" data-empty style="margin:0;padding:28px;line-height:1.5">The cut-out will appear here.</p>';
      return;
    }

    const after = await compose(PREVIEW_MAX);

    // The "before" is the same crop of the original, so the two line up pixel
    // for pixel and the divider tells the truth.
    const before = document.createElement('canvas');
    before.width = after.width;
    before.height = after.height;
    {
      const box = (ui.crop?.value && state.bbox) ? state.bbox : { x: 0, y: 0, w: 1, h: 1 };
      const img = state.img;
      before.getContext('2d').drawImage(
        img,
        box.x * img.naturalWidth, box.y * img.naturalHeight,
        box.w * img.naturalWidth, box.h * img.naturalHeight,
        0, 0, before.width, before.height,
      );
    }

    dom.frame.innerHTML = '';
    Object.assign(after.style, { display: 'block', maxWidth: '100%', height: 'auto' });
    Object.assign(before.style, {
      // Sits exactly on top of the cut-out and is revealed by the clip below.
      // The shared .canvas-stage rule gives every canvas a drop shadow, which
      // an overlay must not have.
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      display: 'block', boxShadow: 'none', maxWidth: 'none',
    });
    dom.frame.append(after, before);

    if (state.mask) {
      dom.frame.append(
        el(`<div data-handle style="position:absolute;top:0;bottom:0;width:2px;background:var(--accent);box-shadow:0 0 0 1px rgba(255,255,255,.6);pointer-events:none"><span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-size:14px;line-height:30px;text-align:center">↔</span></div>`),
        tag('Before', 'left'),
        tag('After', 'right'),
      );
    }
    paintSplit();
  }

  function tag(text, side) {
    const node = el(`<span></span>`);
    node.textContent = text;
    Object.assign(node.style, {
      position: 'absolute', top: '8px', [side]: '8px',
      background: 'rgba(23,28,38,.72)', color: '#fff',
      font: '600 11px/1 system-ui, sans-serif', letterSpacing: '.04em',
      padding: '5px 8px', borderRadius: '5px', pointerEvents: 'none',
    });
    node.dataset.tag = side;
    return node;
  }

  function paintSplit() {
    if (!dom) return;
    const before = dom.frame.querySelectorAll('canvas')[1];
    const handle = dom.frame.querySelector('[data-handle]');
    if (!before) return;
    if (!state.mask) {
      // Nothing to compare yet: show the original, whole.
      before.style.clipPath = 'none';
      return;
    }
    const pct = (state.split * 100).toFixed(2);
    before.style.clipPath = `inset(0 ${(100 - state.split * 100).toFixed(2)}% 0 0)`;
    if (handle) handle.style.left = `${pct}%`;
    const leftTag = dom.frame.querySelector('[data-tag="left"]');
    if (leftTag) leftTag.style.opacity = state.split < 0.12 ? '0' : '1';
    const rightTag = dom.frame.querySelector('[data-tag="right"]');
    if (rightTag) rightTag.style.opacity = state.split > 0.88 ? '0' : '1';
  }

  function paintStatus(text) {
    if (!dom) return;
    dom.label.textContent = text ?? currentLabel();
  }

  function currentLabel() {
    if (!state.file) return 'Choose a photo to begin.';
    if (!state.mask) {
      return state.ready
        ? 'Model ready — press "Find the edges" to see the cut-out.'
        : 'This is the original. The cut-out appears after the model is ready.';
    }
    return `${state.file.name} · ${state.img.naturalWidth} × ${state.img.naturalHeight}`;
  }

  // ---------------------------------------------------------------------------

  function syncVisibility() {
    ui.colour.root.hidden = state.mode !== 'colour';
  }

  function update() {
    if (!ui.explain) return;
    ui.gate?.setLabel();
    paintStatus(null);

    if (!state.file) {
      ui.explain.set('');
      paintPreview();
      return;
    }

    const feather = ui.feather.value;
    const cropping = ui.crop.value && state.bbox;
    const where = state.mode === 'transparent'
      ? 'saved as a PNG with a see-through background — drop it straight onto a slide'
      : state.mode === 'colour'
        ? `replaced with solid ${ui.colour.value.toUpperCase()} and saved as a JPG`
        : 'blurred, with the subject left sharp, and saved as a PNG';

    ui.explain.set(
      !state.mask
        ? `Nothing has been cut out yet. ${state.ready ? 'Press "Find the edges" above.' : (bundledOffline() ? 'Press "Load the bundled cut-out model" above.' : `Press the download button above — ${formatBytes(downloadSize())}, once, and your photo stays here.`)}`
        : `The background will be ${where}${cropping ? ', cropped tight to the subject' : ''}${feather ? `, with a ${feather} px soft edge` : ''}.`,
    );
    paintPreview();
  }

  function friendlyError(err) {
    const msg = String(err?.message ?? err);
    if (/fetch|network|Failed to fetch|metadata not found/i.test(msg)) {
      return bundledOffline() ? 'The bundled model could not start. Restart the app or try a smaller photo.' : 'The model could not be downloaded. Check your connection and press the button again — nothing of yours was sent.';
    }
    if (/session|wasm|WebAssembly|memory/i.test(msg)) {
      return 'This browser could not start the model. It needs a fairly recent Chrome, Edge, Safari or Firefox, and a few hundred MB of free memory.';
    }
    return msg;
  }
}
