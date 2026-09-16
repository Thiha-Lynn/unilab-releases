import { PDFDocument } from 'pdf-lib';
import { canvasToBlob, el, formatBytes, loadImage, stem, toast } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, checkRow, fileFacts, liveExplain, optionPanel, segmented, selectField,
  sliderField, tabCards,
} from '../option-ui.js';

// A phone photo of a page is not a scan: it is dim, warped by the desk lamp, and
// surrounded by whatever the notebook was lying on. What turns it into something
// a lecturer will accept is three cheap pieces of image processing, all in a 2D
// canvas — trim the background away, level the exposure, and (for handwriting)
// threshold against a *local* mean rather than one number for the whole photo.
// The local part is the whole trick: a single global threshold turns the shadowed
// half of a page solid black, which is why phone scans usually look blotchy.

const SRC_MAX = 2400;      // a 48 MP photo of A4 helps nobody and eats the tab's memory
const EXPORT_MAX = 2200;   // ≈ 190 dpi across A4 — sharp print, sane file size
const PREVIEW_MAX = 320;
const BW_BIAS = 8;         // how far below the local mean a pixel must sit to be ink
const JPEG_QUALITY = 0.82;
const BW_QUALITY = 0.92;   // hard black edges need the headroom

const MODES = [
  { id: 'colour', label: 'Colour', note: 'Keeps highlighter pens and coloured diagrams.' },
  { id: 'grey', label: 'Greyscale', note: 'Smaller file, still shows shading.' },
  { id: 'bw', label: 'B & W', note: 'Black & white document mode — crispest for handwriting and printed text.' },
];

const PAGE_SIZES = [
  { id: 'a4', label: 'A4 (210 × 297 mm)' },
  { id: 'letter', label: 'Letter (8.5 × 11 in)' },
  { id: 'fit', label: 'Fit to the photo — no margins' },
];

const ORIENTATIONS = [
  { id: 'auto', label: 'Match each photo' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
];

const SHEET = { a4: [595.28, 841.89], letter: [612, 792] };

export default function render(container, tool) {
  const state = { pages: [], tab: 'camera', stream: null, shots: 0 };
  const ui = {};
  let pane = null;
  let shell = null;
  let repaintToken = 0;
  let repaintTimer = null;

  shell = toolShell(container, tool, {
    accept: 'image/*',
    multiple: true,
    minFiles: 1,
    pickLabel: 'Select photos of your notes',
    dropLabel: 'or drop them here',
    actionLabel: 'Make the PDF',
    doneTitle: 'Your scan is ready!',
    downloadLabel: 'Download PDF',
    continueTo: ['ocr-pdf', 'compress-pdf', 'merge-pdf'],
    note: 'Photograph one page at a time, flat, with the light behind you rather than behind the page — then let "Trim the background" do the cropping. For handwriting, Black & white almost always beats Colour: it is smaller and far easier to read.',

    // The workarea is the camera itself plus the pages you have so far, each one
    // showing the cleaned-up result rather than the raw photo — so the sliders
    // are judged on the thing you are actually going to hand in.
    workarea(host) {
      if (pane) return;
      const root = el(`
        <div>
          <div data-cam></div>
          <div class="thumb-grid" data-pages style="margin-top:16px;"></div>
          <p class="ts__hint" data-empty></p>
        </div>
      `);
      host.appendChild(root);
      pane = {
        cam: root.querySelector('[data-cam]'),
        pages: root.querySelector('[data-pages]'),
        empty: root.querySelector('[data-empty]'),
      };
      paintCamera();
      paintGrid();
    },

    async onFiles(ctx) {
      // syncPages reports the files it could not open by throwing, and the shell
      // shows that message — but the good photos beside them are already in
      // state.pages, so the grid has to be repainted either way.
      let added = false;
      try {
        added = await syncPages(ctx);
      } finally {
        if (added && !state.stream && state.tab !== 'files') ui.tabs.select(1);
        paintGrid();
        update();
      }
    },

    options(host) {
      const panel = optionPanel('Scan to PDF');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.tabs = tabCardsRow();

      ui.mode = segmented(MODES, () => { update(); schedulePreview(); }, { active: 2 });
      ui.brightness = sliderField('Brightness', {
        value: 0, min: -60, max: 60, onChange: () => { update(); schedulePreview(); },
      });
      ui.contrast = sliderField('Contrast', {
        value: 12, min: -60, max: 60, onChange: () => { update(); schedulePreview(); },
      });
      ui.trim = checkRow('Trim the background around the page', {
        checked: true,
        hint: 'Finds the edges of the paper and crops the desk away. It is a straight rectangular crop — it cannot flatten a page photographed at an angle, so hold the phone square to the page.',
        onChange: () => { update(); schedulePreview(); },
      });
      ui.size = selectField('Page size', PAGE_SIZES, {
        value: 'a4',
        onChange: () => { syncVisibility(); update(); },
      });
      ui.orient = selectField('Orientation', ORIENTATIONS, { value: 'auto', onChange: update });

      panel.add(ui.tabs, ui.facts, ui.mode, ui.brightness, ui.contrast, ui.trim, ui.size, ui.orient, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.pages.length) throw new Error('There are no pages yet. Take a photo, or add one from your files.');
      const opts = currentOptions();
      const doc = await PDFDocument.create();

      for (let i = 0; i < state.pages.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(i / state.pages.length, `Cleaning up page ${i + 1} of ${state.pages.length}…`);

        const canvas = processPage(state.pages[i], opts, EXPORT_MAX);
        // JPEG, always. pdf-lib copies JPEG bytes into the file untouched, while
        // a PNG has to be decoded and re-deflated in JavaScript — on the phone
        // this tool is aimed at, that is the difference between a twenty-page
        // scan finishing and the tab being killed. Black & white pages get the
        // higher quality, because hard black edges are exactly what JPEG puts a
        // grey halo around.
        const quality = opts.mode === 'bw' ? BW_QUALITY : JPEG_QUALITY;
        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));

        const sheet = sheetFor(canvas.width, canvas.height, opts);
        const page = doc.addPage([sheet.w, sheet.h]);
        const scale = Math.min(sheet.w / canvas.width, sheet.h / canvas.height);
        const w = canvas.width * scale;
        const h = canvas.height * scale;
        page.drawImage(image, { x: (sheet.w - w) / 2, y: (sheet.h - h) / 2, width: w, height: h });

        // Yield between pages so a twenty-page scan never freezes the tab.
        await new Promise((r) => setTimeout(r, 0));
      }

      ctx.setBusy(1, 'Saving the PDF…');
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      const count = state.pages.length;
      return {
        outputs: [{ name: outputName(), blob }],
        doneTitle: `Your scan is ready — ${count} page${count === 1 ? '' : 's'}, ${formatBytes(blob.size)}.`,
      };
    },
  });

  // The uploader stage offers a file picker and nothing else, and the headline
  // act of this tool is the camera. Without this one button, "scan your notes"
  // would really mean "find the photos you already took".
  const uploader = container.querySelector('.ts__uploader');
  if (uploader && cameraSupported()) {
    const btn = el(`<button class="btn secondary" type="button" style="margin-top:18px;color:var(--cc);border-color:var(--cc);">📷 Use the camera instead</button>`);
    btn.addEventListener('click', () => {
      shell.stage('work');
      ui.tabs.select(0);
    });
    uploader.querySelector('.ts__privacy').before(btn);
  }

  // Leaving the tool must switch the camera light off. The shell purges the
  // vault on the same event; the stream is ours to clean up.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    clearTimeout(repaintTimer);
    repaintToken++;
    stopCamera();
  });

  // ---------------------------------------------------------------------------
  // sidebar plumbing

  /** Camera / Files. Picking a tab here switches hardware on and off, so the
   *  handler lives next to the camera code rather than in the generic panel. */
  function tabCardsRow() {
    return tabCards([
      { id: 'camera', label: 'Camera', icon: TAB_ICONS.camera, note: 'Photograph a page right now' },
      { id: 'files', label: 'Files', icon: TAB_ICONS.upload, note: 'Photos you have already taken' },
    ], (tab) => {
      state.tab = tab.id;
      if (tab.id === 'camera') startCamera();
      else stopCamera();
      paintCamera();
      update();
    }, { active: 0 });
  }

  function syncVisibility() {
    // "Fit to the photo" already answers the orientation question, so asking it
    // again would just be a control that does nothing.
    ui.orient.root.hidden = ui.size.value === 'fit';
  }

  function currentOptions() {
    return {
      mode: ui.mode?.value ?? 'bw',
      brightness: ui.brightness?.value ?? 0,
      contrast: ui.contrast?.value ?? 0,
      trim: ui.trim?.value ?? true,
      size: ui.size?.value ?? 'a4',
      orient: ui.size?.value === 'fit' ? 'auto' : (ui.orient?.value ?? 'auto'),
    };
  }

  function update() {
    const n = state.pages.length;
    ui.facts?.set(n ? [
      ['Pages', String(n)],
      ['Photos', formatBytes(state.pages.reduce((s, p) => s + (p.file?.size ?? 0), 0))],
    ] : []);

    if (!n) {
      ui.explain?.set(state.tab === 'camera'
        ? 'Take a photo of the first page and it will appear here.'
        : 'Add photos of your notes and they become the pages of one PDF.');
      if (pane) pane.empty.textContent = state.tab === 'camera'
        ? 'Every shot you take is added here as a page. Nothing is uploaded — the photo goes straight into this tab.'
        : 'Add photos and each one becomes a page, in the order you add them.';
      return;
    }

    const opts = currentOptions();
    const mode = { colour: 'in colour', grey: 'in greyscale', bw: 'in black & white' }[opts.mode];
    const sheet = { a4: 'A4', letter: 'Letter', fit: 'photo-shaped' }[opts.size];
    const trimmed = opts.trim ? ', with the background trimmed off' : '';
    ui.explain?.set(`${n} photo${n === 1 ? '' : 's'} will become a ${n}-page ${sheet} PDF ${mode}${trimmed}. Each page is the photo itself, resized to about 190 dpi and saved as a JPEG — sharp to print, but not text you can search. Run OCR PDF on it afterwards if you need to search it.`);
    if (pane) pane.empty.textContent = 'Use ← and → to reorder, ✕ to drop a page. Every thumbnail shows the cleaned-up result, not the raw photo.';
  }

  // ---------------------------------------------------------------------------
  // pages

  async function syncPages(ctx) {
    const known = new Map(state.pages.map((p) => [p.file, p]));
    const next = [];
    const bad = [];
    let added = false;
    for (const file of ctx.files) {
      const existing = known.get(file);
      if (existing) { next.push(existing); continue; }
      try {
        next.push(await makePage(file));
        added = true;
      } catch {
        // One unreadable file must not cost the nine good photos beside it.
        bad.push(file);
      }
    }
    state.pages = next;
    // Keep the shell's own list identical to what is on screen, so the count
    // badge and the "at least one page" rule can never disagree with the grid.
    ctx.files.length = 0;
    ctx.files.push(...next.map((p) => p.file));
    if (bad.length) {
      throw new Error(bad.length === 1
        ? `${bad[0].name} could not be opened as a photo. iPhone .HEIC files need HEIC to JPG first — that tool is two taps away.`
        : `${bad.length} of those files could not be opened as photos. iPhone .HEIC files need HEIC to JPG first; the rest have been added.`);
    }
    return added;
  }

  async function makePage(file) {
    const img = await loadImage(file);
    // The photo is copied once, downscaled, and the original is never touched
    // again: every slider move re-reads this canvas instead of decoding a 12 MP
    // JPEG all over again.
    const scale = Math.min(1, SRC_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(img.naturalWidth * scale));
    src.height = Math.max(1, Math.round(img.naturalHeight * scale));
    src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
    return { file, src, box: undefined };
  }

  function removePage(i) {
    state.pages.splice(i, 1);
    shell.files.splice(i, 1);
    paintGrid();
    update();
    shell.refresh();
    if (!state.pages.length && !state.stream) shell.stage('upload');
  }

  function movePage(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.pages.length) return;
    [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
    [shell.files[i], shell.files[j]] = [shell.files[j], shell.files[i]];
    paintGrid();
  }

  function paintGrid() {
    if (!pane) return;
    pane.pages.innerHTML = '';
    state.pages.forEach((page, i) => {
      const cell = el(`
        <div class="page-thumb">
          <div class="num"></div>
          <div class="ops">
            <button class="icon-btn" data-left type="button" title="Move earlier">←</button>
            <button class="icon-btn danger" data-del type="button" title="Remove this page">✕</button>
            <button class="icon-btn" data-right type="button" title="Move later">→</button>
          </div>
        </div>
      `);
      cell.querySelector('.num').textContent = `Page ${i + 1}`;
      cell.querySelector('[data-left]').disabled = i === 0;
      cell.querySelector('[data-right]').disabled = i === state.pages.length - 1;
      cell.querySelector('[data-left]').addEventListener('click', () => movePage(i, -1));
      cell.querySelector('[data-right]').addEventListener('click', () => movePage(i, 1));
      cell.querySelector('[data-del]').addEventListener('click', () => removePage(i));
      pane.pages.appendChild(cell);
      page.cell = cell;
    });
    repaintPreviews();
  }

  function schedulePreview() {
    // Dragging a slider fires on every pixel; one repaint per frame-ish is
    // plenty, and the token makes sure a slow pass never paints over a newer one.
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(repaintPreviews, 70);
  }

  async function repaintPreviews() {
    if (!pane) return;
    const token = ++repaintToken;
    const opts = currentOptions();
    for (const page of state.pages) {
      if (token !== repaintToken) return;
      if (!page.cell) continue;
      const canvas = processPage(page, opts, PREVIEW_MAX);
      page.cell.querySelector('canvas')?.remove();
      page.cell.prepend(canvas);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  function outputName() {
    const first = state.pages[0]?.file;
    if (!first || first.__fromCamera) {
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `scan-${stamp}.pdf`;
    }
    return `${stem(first.name)}-scanned.pdf`;
  }

  // ---------------------------------------------------------------------------
  // camera

  function cameraSupported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  function paintCamera() {
    if (!pane) return;
    pane.cam.innerHTML = '';
    if (state.tab !== 'camera') return;

    if (!cameraSupported()) {
      pane.cam.appendChild(el(`
        <div class="panel media-unsupported">
          <h3>This browser can't reach a camera</h3>
          <p>Taking photos needs a browser feature this one doesn't offer, and it is
             also switched off on pages served over plain http. Take the photos with
             your phone's camera app and add them through the <b>Files</b> tab —
             everything else in this tool works exactly the same.</p>
        </div>
      `));
      return;
    }

    if (!state.stream) {
      const box = el(`
        <div style="text-align:center;">
          <div class="rec-stage"><p class="placeholder">The camera is off. Nothing is recorded until you press the button.</p></div>
          <div class="actions" style="justify-content:center;">
            <button class="btn" data-start type="button">Start the camera</button>
          </div>
          <p class="ts__hint" data-err></p>
        </div>
      `);
      box.querySelector('[data-start]').addEventListener('click', startCamera);
      pane.cam.appendChild(box);
      pane.camError = box.querySelector('[data-err]');
      return;
    }

    const box = el(`
      <div style="text-align:center;">
        <div class="rec-stage"><video playsinline muted></video></div>
        <div class="actions" style="justify-content:center;">
          <button class="btn" data-shot type="button">📸 Take photo</button>
          <button class="btn secondary small" data-stop type="button">Turn the camera off</button>
        </div>
        <p class="ts__hint">Lay the page flat and fill the frame. Each shot is added as a page below.</p>
      </div>
    `);
    const video = box.querySelector('video');
    video.srcObject = state.stream;
    video.play().catch(() => { /* autoplay refusal on a muted stream is harmless */ });
    box.querySelector('[data-shot]').addEventListener('click', () => capture(video));
    box.querySelector('[data-stop]').addEventListener('click', () => { stopCamera(); paintCamera(); });
    pane.cam.appendChild(box);
  }

  async function startCamera() {
    if (state.stream || !cameraSupported()) { paintCamera(); return; }
    try {
      // facingMode is a hint, not a demand: `ideal` keeps a laptop with one
      // front camera working instead of failing with OverconstrainedError.
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
      });
      paintCamera();
    } catch (err) {
      state.stream = null;
      paintCamera();
      if (pane?.camError) {
        pane.camError.textContent = cameraMessage(err);
        pane.camError.classList.add('warn-note');
      }
    }
  }

  function stopCamera() {
    if (!state.stream) return;
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }

  function cameraMessage(err) {
    const name = err?.name ?? '';
    if (window.isSecureContext === false) {
      return 'Browsers only hand the camera to pages served over https. Open this page on its https address and the camera button will work.';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The camera is blocked for this page. Tap the padlock or camera icon next to the address, allow the camera, then press Start the camera again. The picture never leaves this tab either way.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'No camera on this device. Take the photos on your phone and add them in the Files tab — or finish one scan and use the QR button to open this tool on your phone.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Another app is already using the camera. Close Zoom, LINE or the Camera app, then press Start the camera again.';
    }
    return `The camera could not start${name ? ` (${name})` : ''}. The Files tab still works with photos you already took.`;
  }

  async function capture(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) { toast('The camera is still warming up — try again in a second'); return; }

    const shot = document.createElement('canvas');
    const scale = Math.min(1, SRC_MAX / Math.max(w, h));
    shot.width = Math.round(w * scale);
    shot.height = Math.round(h * scale);
    shot.getContext('2d').drawImage(video, 0, 0, shot.width, shot.height);

    const blob = await canvasToBlob(shot, 'image/jpeg', 0.92);
    const file = new File([blob], `scan-${String(++state.shots).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
    file.__fromCamera = true;

    // The shot joins ctx.files as a real File, so the shell's own count badge and
    // its "at least one file" rule keep working without a parallel bookkeeping.
    shell.files.push(file);
    state.pages.push({ file, src: shot, box: undefined });
    paintGrid();
    update();
    shell.refresh();
    toast(`Page ${state.pages.length} added`);
  }
}

// -----------------------------------------------------------------------------
// The image pipeline. Everything below is pure: a source canvas and a settings
// object in, a finished canvas out, so the preview and the export cannot drift.

function processPage(page, opts, maxSide) {
  const src = page.src;
  if (opts.trim && page.box === undefined) page.box = findPageBox(src);
  const box = opts.trim ? page.box : null;

  const sx = box ? box.x : 0;
  const sy = box ? box.y : 0;
  const sw = box ? box.w : src.width;
  const sh = box ? box.h : src.height;

  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  c2d.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const image = c2d.getImageData(0, 0, canvas.width, canvas.height);
  applyMode(image, canvas.width, canvas.height, opts);
  c2d.putImageData(image, 0, 0);
  return canvas;
}

function applyMode(image, w, h, opts) {
  const px = image.data;
  // The classic contrast curve: pivot around mid-grey so raising contrast
  // darkens ink and lightens paper instead of just darkening everything.
  const c = opts.contrast * 2.1;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = opts.brightness * 1.6;
  const tone = (v) => f * (v - 128) + 128 + b;

  if (opts.mode === 'colour') {
    for (let i = 0; i < px.length; i += 4) {
      px[i] = tone(px[i]);
      px[i + 1] = tone(px[i + 1]);
      px[i + 2] = tone(px[i + 2]);
    }
    return;
  }

  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < px.length; i++, p += 4) {
    gray[i] = tone(0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]);
  }

  const out = opts.mode === 'bw' ? adaptiveThreshold(gray, w, h) : gray;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    px[p] = out[i];
    px[p + 1] = out[i];
    px[p + 2] = out[i];
    px[p + 3] = 255;
  }
}

/**
 * Bradley-style adaptive threshold: every pixel is compared with the mean of the
 * square around it, not with one number for the whole page. That is what keeps a
 * pencil note readable in the corner the desk lamp missed — a global threshold
 * would either lose it or fill the shadow in solid black.
 *
 * The summed-area table makes the local mean four array reads however big the
 * window is, so the cost does not grow with the window.
 */
function adaptiveThreshold(gray, w, h) {
  const stride = w + 1;
  const sat = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      sat[(y + 1) * stride + (x + 1)] = sat[y * stride + (x + 1)] + rowSum;
    }
  }

  // A window about a twentieth of the page wide spans several letters but far
  // less than a paragraph, which is the size that separates ink from paper.
  const radius = Math.max(4, Math.round(w / 22));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = sat[(y1 + 1) * stride + (x1 + 1)]
        - sat[y0 * stride + (x1 + 1)]
        - sat[(y1 + 1) * stride + x0]
        + sat[y0 * stride + x0];
      // Without the bias, blank paper (where a pixel *is* its own local mean)
      // breaks up into salt-and-pepper speckle.
      out[y * w + x] = gray[y * w + x] * area < sum - BW_BIAS * area ? 0 : 255;
    }
  }
  return out;
}

/**
 * Where does the paper stop and the desk start? Looked for in a 220-pixel-wide
 * copy: the page edge is an enormous feature, and at that size the grain of the
 * wood and the texture of the paper both disappear.
 */
function findPageBox(src) {
  const W = 220;
  const H = Math.max(1, Math.round(src.height * (W / src.width)));
  const small = document.createElement('canvas');
  small.width = W;
  small.height = H;
  const c2d = small.getContext('2d', { willReadFrequently: true });
  c2d.drawImage(src, 0, 0, W, H);
  const px = c2d.getImageData(0, 0, W, H).data;

  const gray = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) | 0;
    gray[i] = v;
    hist[v]++;
  }

  const cut = otsu(hist, W * H);
  const rows = new Float32Array(H);
  const cols = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (gray[y * W + x] >= cut) { rows[y]++; cols[x]++; }
    }
  }
  for (let y = 0; y < H; y++) rows[y] /= W;
  for (let x = 0; x < W; x++) cols[x] /= H;

  const [y0, y1] = longestRun(rows, 0.5);
  const [x0, x1] = longestRun(cols, 0.5);
  if (y1 <= y0 || x1 <= x0) return null;

  const coverage = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (W * H);
  // Above 96% there was no visible background to trim; below 18% the detector
  // has latched onto a bright patch rather than the page, and cropping to it
  // would throw the notes away. Both cases are better left alone.
  if (coverage > 0.96 || coverage < 0.18) return null;

  const kx = src.width / W;
  const ky = src.height / H;
  return {
    x: Math.round(x0 * kx),
    y: Math.round(y0 * ky),
    w: Math.max(1, Math.round((x1 - x0 + 1) * kx)),
    h: Math.max(1, Math.round((y1 - y0 + 1) * ky)),
  };
}

/** Otsu's method: the grey level that splits paper from everything else. */
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * ((sumB / wB) - ((sum - sumB) / wF)) ** 2;
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/** The longest unbroken stretch of rows (or columns) that are mostly paper. */
function longestRun(profile, min) {
  let bestStart = 0;
  let bestEnd = -1;
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= min) {
      if (start < 0) start = i;
      if (i - start > bestEnd - bestStart) { bestStart = start; bestEnd = i; }
    } else {
      start = -1;
    }
  }
  return [bestStart, bestEnd];
}

function sheetFor(imgW, imgH, opts) {
  if (opts.size === 'fit') {
    // Keep the photo's own shape, scaled so its long side matches A4's — a page
    // with no margins that is still a printable size.
    const scale = 841.89 / Math.max(imgW, imgH);
    return { w: imgW * scale, h: imgH * scale };
  }
  let [w, h] = SHEET[opts.size] ?? SHEET.a4;
  const landscape = opts.orient === 'landscape'
    || (opts.orient === 'auto' && imgW > imgH);
  if (landscape) [w, h] = [h, w];
  return { w, h };
}
