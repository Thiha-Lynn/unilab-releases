import { el, dropzone, errorBox, formatBytes, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, convertMedia, evenSize, formatDuration, grabFrame, isCanceled,
  pickAudioCodec, pickVideoCodec, probeMedia, quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, mediaPreview, mediaStats, presetRow, resultCard } from '../media-ui.js';

// The five shapes students are actually asked for. `ratio` is width ÷ height;
// null means "type your own". `where` names the platform out loud, because
// "4:5" on its own means nothing an hour before a deadline.
const PRESETS = [
  { label: '9:16', ratio: 9 / 16, where: 'TikTok, Reels and IG Story — fills a phone screen top to bottom.' },
  { label: '1:1', ratio: 1, where: 'A square feed post — Instagram, Facebook, LINE.' },
  { label: '4:5', ratio: 4 / 5, where: 'Instagram portrait — the tallest a normal feed post is allowed to be.' },
  { label: '16:9', ratio: 16 / 9, where: 'YouTube, slides, and anything going on a projector.' },
  { label: 'Custom', ratio: null, where: 'Your own width and height, in pixels.' },
];

// The shorter side is what gets set, so a 9:16 story and a 16:9 slide at the
// same setting carry the same amount of detail.
const SHORT_SIDES = [1080, 720, 480];

// The framing preview is drawn small enough to sit on a phone screen; the real
// export always uses the full target pixels.
const PREVIEW_MAX = 320;

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  let file = null;
  let probe = null;
  let preview = null;
  let outPreview = null;
  let activeIndex = 0;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: false,
    label: 'Choose a video',
    hint: 'MP4, MOV, WebM or MKV — straight off your phone is fine',
    onFiles: ([f]) => load(f),
  });

  const info = el(`<div hidden></div>`);

  const controls = el(`
    <div hidden>
      <div class="field">
        <label>Shape</label>
        <div data-presets></div>
      </div>
      <p class="note" data-where></p>
      <div class="controls">
        <div class="field" data-shortwrap>
          <label>Short side</label>
          <select data-short></select>
        </div>
        <div class="field" data-customwrap hidden>
          <label>Width (px)</label>
          <input type="number" data-cw min="16" max="7680" step="2" />
        </div>
        <div class="field" data-customwrap hidden>
          <label>Height (px)</label>
          <input type="number" data-ch min="16" max="7680" step="2" />
        </div>
        <div class="field">
          <label>Fit</label>
          <select data-fit>
            <option value="cover">Crop to fill</option>
            <option value="contain">Fit with bars</option>
          </select>
        </div>
        <div class="field">
          <label>Rotate</label>
          <select data-rotate>
            <option value="0">None</option>
            <option value="90">90° right</option>
            <option value="180">180°</option>
            <option value="270">90° left</option>
          </select>
        </div>
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="mp4">MP4 — plays everywhere</option>
            <option value="webm">WebM — smaller, web only</option>
          </select>
        </div>
      </div>
      <p class="note">Crop to fill zooms in until the frame is full and loses the edges;
        fit with bars keeps everything in shot and pads the rest with black.</p>
      <div class="canvas-stage" data-stage></div>
      <p class="note" data-size></p>
      <div class="actions">
        <button class="btn" data-go>Resize video</button>
        <button class="btn secondary" data-reset>Choose another video</button>
      </div>
    </div>
  `);

  const presetHost = controls.querySelector('[data-presets]');
  const whereNote = controls.querySelector('[data-where]');
  const shortWrap = controls.querySelector('[data-shortwrap]');
  const shortSel = controls.querySelector('[data-short]');
  const customWraps = [...controls.querySelectorAll('[data-customwrap]')];
  const customW = controls.querySelector('[data-cw]');
  const customH = controls.querySelector('[data-ch]');
  const fitSel = controls.querySelector('[data-fit]');
  const rotateSel = controls.querySelector('[data-rotate]');
  const formatSel = controls.querySelector('[data-format]');
  const sizeNote = controls.querySelector('[data-size]');
  const stage = controls.querySelector('[data-stage]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  const stageCanvas = document.createElement('canvas');
  stage.appendChild(stageCanvas);

  SHORT_SIDES.forEach((px) => {
    const o = document.createElement('option');
    o.value = String(px);
    o.textContent = `${px}p`;
    shortSel.appendChild(o);
  });

  shortSel.addEventListener('change', () => { paintPresets(); refresh(); });
  [fitSel, rotateSel, formatSel].forEach((c) => c.addEventListener('change', refresh));
  [customW, customH].forEach((c) => c.addEventListener('input', refresh));
  controls.querySelector('[data-reset]').addEventListener('click', reset);

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  // Bumped on every file so a frame grab started for the previous video can
  // never land in the preview of the current one.
  let loadId = 0;
  let sourceFrame = null;
  let sourceFramePromise = null;

  function reset() {
    preview?.destroy();
    preview = null;
    file = null;
    probe = null;
    loadId++;
    sourceFrame = null;
    sourceFramePromise = null;
    // A framing redraw queued a moment ago would otherwise fire after the file
    // is gone and walk straight into a null probe.
    clearTimeout(framingTimer);
    framingTimer = null;
    framingToken++;
    info.hidden = true;
    info.innerHTML = '';
    controls.hidden = true;
    zone.hidden = false;
    clearResult();
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    clearResult();
    try {
      probe = await probeMedia(f);
      if (!probe.hasVideo) throw new Error(`${f.name} has no picture, only sound. There is nothing to reframe — try Convert Audio instead.`);
      file = f;
      loadId++;
      sourceFrame = null;
      sourceFramePromise = null;
      zone.hidden = true;
      info.hidden = false;
      info.innerHTML = '';
      preview?.destroy();
      preview = mediaPreview(f, { kind: 'video', muted: true });
      info.append(preview.node, mediaStats(probe));
      customW.value = String(probe.video.width);
      customH.value = String(probe.video.height);
      controls.hidden = false;
      paintPresets();
      refresh();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Target size
  // -------------------------------------------------------------------------

  /**
   * The bitrate to reframe at, in bits per second.
   *
   * Left unset, Mediabunny encodes at its own `high` quality, which is picked
   * from the *output* resolution alone. Reframe a 2 Mbps lecture recording into
   * a 1080×1920 story and it comes back several times heavier than the video it
   * started from, which is the opposite of what anybody wants an hour before a
   * deadline. So the source's own bitrate is the starting point, scaled down
   * with the pixel count — by its square root, because halving the pixels needs
   * rather more than half the bits to still look the same.
   */
  function encodeBitrate(box) {
    const total = (probe.size * 8) / Math.max(0.1, probe.duration);
    const sourceVideo = Math.max(150_000, total - (probe.hasAudio ? 128_000 : 0));
    const sourcePixels = Math.max(1, probe.video.width * probe.video.height);
    const scale = Math.min(1, (box.width * box.height) / sourcePixels);
    return Math.max(150_000, Math.round(sourceVideo * Math.sqrt(scale)));
  }

  /** The pixel box a ratio preset maps to at the chosen short side. */
  function boxFor(preset, short) {
    const long = short / Math.min(preset.ratio, 1 / preset.ratio);
    return preset.ratio >= 1
      ? { width: evenSize(long), height: evenSize(short) }
      : { width: evenSize(short), height: evenSize(long) };
  }

  /** The box we will actually encode, or null while a custom size is unusable. */
  function targetSize() {
    const preset = PRESETS[activeIndex];
    if (preset.ratio) return boxFor(preset, Number(shortSel.value));
    const w = Number(customW.value);
    const h = Number(customH.value);
    if (!(w >= 16 && w <= 7680) || !(h >= 16 && h <= 7680)) return null;
    return { width: evenSize(w), height: evenSize(h) };
  }

  function paintPresets() {
    const short = Number(shortSel.value);
    const row = presetRow(
      PRESETS.map((p) => ({
        label: p.ratio ? `${p.label} · ${boxFor(p, short).width}×${boxFor(p, short).height}` : p.label,
        hint: p.where,
      })),
      (_, i) => { activeIndex = i; refresh(); },
      { activeIndex },
    );
    row.style.marginTop = '0';
    presetHost.innerHTML = '';
    presetHost.appendChild(row);
  }

  function refresh() {
    if (!probe) return;
    const preset = PRESETS[activeIndex];
    const custom = !preset.ratio;
    shortWrap.hidden = custom;
    customWraps.forEach((n) => { n.hidden = !custom; });
    whereNote.textContent = preset.where;

    const box = targetSize();
    goBtn.disabled = !box;
    if (box) {
      const bits = encodeBitrate(box) + (probe.hasAudio ? 128_000 : 0);
      sizeNote.textContent = `Output: ${box.width}×${box.height} pixels, from ${probe.video.width}×${probe.video.height} — roughly ${formatBytes(Math.round((bits / 8) * probe.duration))}.`;
    } else {
      sizeNote.textContent = 'Type a width and a height between 16 and 7680 pixels.';
    }
    scheduleFraming(box);
  }

  // -------------------------------------------------------------------------
  // Live framing preview
  //
  // The whole point of the tool is knowing whether your face survives the crop,
  // so a real frame from the video is redrawn into the target box on every
  // change instead of an abstract diagram.
  // -------------------------------------------------------------------------

  let framingTimer = null;
  let framingToken = 0;

  function scheduleFraming(box) {
    // Cancel first, even when there is nothing to draw: while a custom width is
    // half-typed and unusable, a redraw queued for the *previous* size must not
    // land and show a box the student is no longer asking for.
    clearTimeout(framingTimer);
    framingTimer = null;
    if (!box) return;
    framingTimer = setTimeout(() => renderFraming(box), 120);
  }

  async function renderFraming(box) {
    const token = ++framingToken;
    // Draw the empty frame straight away so the box reacts the instant a
    // control moves, then fill in the picture when it arrives.
    paintFraming(box);
    try {
      await ensureSourceFrame();
    } catch {
      // A frame we cannot decode does not deserve an error box — the preview
      // just stays black, and the conversion will report the real problem.
    }
    if (token !== framingToken) return;
    paintFraming(box);
  }

  /** Decodes one frame per file and keeps it, so redraws stay instant. */
  function ensureSourceFrame() {
    if (sourceFrame) return Promise.resolve(sourceFrame);
    if (!sourceFramePromise) {
      const mine = loadId;
      const at = Math.min(1, Math.max(0, probe.duration - 0.1));
      const width = Math.min(640, probe.video.width);
      sourceFramePromise = grabFrame(file, at, { width }).then((canvas) => {
        if (!canvas || mine !== loadId) return null;
        // CanvasSink hands out canvases from a pool it reuses, so the pixels
        // have to be copied out before the generator moves on.
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        sourceFrame = copy;
        return copy;
      });
    }
    return sourceFramePromise;
  }

  function paintFraming(box) {
    const scale = PREVIEW_MAX / Math.max(box.width, box.height);
    const cw = Math.max(2, Math.round(box.width * scale));
    const ch = Math.max(2, Math.round(box.height * scale));
    stageCanvas.width = cw;
    stageCanvas.height = ch;
    const ctx = stageCanvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (!sourceFrame) return;

    // Rotation happens before the resize, so a quarter turn swaps what "wide"
    // and "tall" mean for everything below.
    const rotation = Number(rotateSel.value);
    const quarter = rotation === 90 || rotation === 270;
    const sw = quarter ? sourceFrame.height : sourceFrame.width;
    const sh = quarter ? sourceFrame.width : sourceFrame.height;
    const fit = fitSel.value === 'cover'
      ? Math.max(cw / sw, ch / sh)
      : Math.min(cw / sw, ch / sh);
    const dw = sw * fit;
    const dh = sh * fit;

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    // Inside the rotated frame the picture's own width and height swap back.
    ctx.drawImage(sourceFrame, quarter ? -dh / 2 : -dw / 2, quarter ? -dw / 2 : -dh / 2, quarter ? dh : dw, quarter ? dw : dh);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Converting
  // -------------------------------------------------------------------------

  goBtn.addEventListener('click', async () => {
    const box = targetSize();
    if (!box) return;
    errorBox(panel, null);
    clearResult();
    // Reframing means decoding every frame and drawing it again, so a video
    // this browser cannot open is a dead end — and saying so now beats a raw
    // decoder error two minutes into the job.
    if (!probe.video.decodable) {
      errorBox(panel, `This browser cannot open the video inside ${file.name}, so it cannot be reframed. Run it through Convert Video into MP4 (H.264) first, then come back here.`);
      return;
    }
    // The shape chips and the Fit menu stay clickable while the job runs, so
    // every setting is read once here. The result card has to describe what was
    // actually encoded, not what is on screen when it finishes.
    const preset = PRESETS[activeIndex];
    const fitMode = fitSel.value;
    const rotation = Number(rotateSel.value);
    goBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Preparing…');

    try {
      const containerId = formatSel.value;
      const bitrate = encodeBitrate(box);
      const [videoCodec, audioCodec] = await Promise.all([
        pickVideoCodec(containerId, { width: box.width, height: box.height, bitrate }),
        probe.hasAudio
          ? pickAudioCodec(containerId, { numberOfChannels: probe.audio.channels, sampleRate: probe.audio.sampleRate })
          : Promise.resolve(undefined),
      ]);

      const result = await convertMedia({
        file,
        container: containerId,
        video: {
          width: box.width,
          height: box.height,
          fit: fitMode,
          rotate: rotation,
          codec: videoCodec,
          // Reframing rewrites every pixel, so this is a re-encode either way —
          // saying it out loud keeps Mediabunny from copying the original
          // stream through on the day the sizes happen to already match.
          forceTranscode: true,
          quality: quality(bitrate),
        },
        audio: probe.hasAudio ? { codec: audioCodec } : { discard: true },
        onProgress: (fraction, processedSeconds) => {
          job.update(fraction, `${Math.round(fraction * 100)}% · ${formatDuration(processedSeconds)} of ${formatDuration(probe.duration)}`);
        },
        signal,
      });

      job.stop();
      showResult(result, { box, preset, fitMode }, performance.now() - started);
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Resize canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = !targetSize();
    }
  });

  function clearResult() {
    outPreview?.destroy();
    outPreview = null;
    resultsHost.innerHTML = '';
  }

  function showResult({ blob, ext, mime, warnings }, { box, preset, fitMode }, elapsedMs) {
    const name = `${stem(file.name)}-${box.width}x${box.height}.${ext}`;
    const fitLine = fitMode === 'cover'
      ? 'Cropped to fill the frame — the edges of the original are gone.'
      : 'The whole picture is still there, sitting inside black bars.';
    outPreview = mediaPreview(new File([blob], name, { type: mime }), { kind: 'video' });

    resultsHost.appendChild(resultCard({
      heading: `✅ Done — ${box.width}×${box.height}`,
      message: preset.ratio ? `${preset.label} · ${fitLine}` : fitLine,
      stats: [
        [`${probe.video.width}×${probe.video.height}`, 'Before'],
        [`${box.width}×${box.height}`, 'After'],
        [formatBytes(blob.size), 'File size'],
        [`${(elapsedMs / 1000).toFixed(1)}s`, 'Took'],
      ],
      outputs: [{ name, blob }],
      warnings,
      preview: outPreview.node,
    }));
  }

  // Walking away from the page leaves a queued framing redraw and two blob URLs
  // — one of them the whole source video — with nothing left to clean them up.
  window.addEventListener('hashchange', () => {
    clearTimeout(framingTimer);
    framingTimer = null;
    framingToken++;
    preview?.destroy();
    preview = null;
    clearResult();
  }, { once: true });

  panel.append(zone, info, controls, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Filmed the whole thing sideways? Rotate it here instead of re-shooting.
    And when you are not sure the crop will keep your head in frame, choose "fit with bars" —
    a Reel with black bars still beats a Reel with the top of your head cut off.
    Your video never leaves this device.</p>
  `));
}
