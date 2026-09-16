import { el, dropzone, errorBox, formatBytes, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, formatDuration, isCanceled, probeMedia, requireWebCodecs,
  streamFrames, yieldToBrowser,
} from '../media-utils.js';
import { jobProgress, linkPlayerToTrim, mediaPreview, mediaStats, resultCard, trimBar } from '../media-ui.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// A GIF grows with width × frame rate × seconds, and all three multiply. The
// defaults below (320 px, 10 fps, the first 5 seconds) land around a couple of
// megabytes — small enough to paste into LINE or a slide without thinking.
const DEFAULT_CLIP_SECONDS = 5;

// Past this, a GIF stops being a convenient little loop and becomes a download.
const LONG_CLIP_SECONDS = 10;

// Anything over this is worth saying something about in the result card.
const HEAVY_GIF_BYTES = 8 * 1024 ** 2;

// The shortest gap the two handles are allowed to have between them.
const MIN_CLIP = 0.1;

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  let file = null;
  let probe = null;
  let preview = null;
  let unlinkTrim = null;
  let resultUrl = null;
  // Set when the student navigates away. Quantising frames is a long loop that
  // would otherwise keep chewing through a video for a page nobody is looking
  // at any more.
  let pageGone = false;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: false,
    label: 'Choose a video',
    hint: 'MP4, MOV, WebM or MKV — you only need a few seconds of it',
    onFiles: ([f]) => load(f),
  });

  const info = el(`
    <div hidden>
      <div data-player></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn secondary small" data-mark-start>Start here</button>
        <button class="btn secondary small" data-mark-end>End here</button>
        <span class="note" style="margin:0">Play the video, pause on the moment you want, then press a button.</span>
      </div>
      <div data-trim></div>
      <div data-stats></div>
    </div>
  `);
  const playerHost = info.querySelector('[data-player]');
  const trimHost = info.querySelector('[data-trim]');
  const statsHost = info.querySelector('[data-stats]');

  // One trim bar for the whole page — a new file only resets its duration, so
  // the wiring below happens once instead of on every load.
  const trim = trimBar({
    duration: 0,
    onChange: updateEstimate,
    // Seeking the preview on every handle move is the whole point: you see the
    // frame you are starting on instead of guessing from a timecode.
    onScrub: (t) => {
      if (preview && Number.isFinite(t)) preview.node.currentTime = t;
    },
  });
  trimHost.appendChild(trim.root);

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Width</label>
          <select data-width>
            <option value="240">240 px — smallest</option>
            <option value="320" selected>320 px — good for chat</option>
            <option value="480">480 px — sharper</option>
            <option value="640">640 px — only for very short clips</option>
          </select>
        </div>
        <div class="field">
          <label>Frames per second</label>
          <select data-fps>
            <option value="5">5 — choppy but tiny</option>
            <option value="8">8</option>
            <option value="10" selected>10 — smooth enough</option>
            <option value="12">12</option>
            <option value="15">15 — smoothest, biggest</option>
          </select>
        </div>
        <div class="field">
          <label>Colours</label>
          <select data-colours>
            <option value="64">64 — smallest file</option>
            <option value="128" selected>128 — balanced</option>
            <option value="256">256 — best quality</option>
          </select>
        </div>
        <label class="checkbox"><input type="checkbox" data-loop checked /> Loop forever</label>
      </div>
      <p class="note" data-estimate></p>
      <p class="note warn-note" data-warn hidden></p>
      <div class="actions">
        <button class="btn" data-go>Make GIF</button>
        <button class="btn secondary" data-reset>Choose another video</button>
      </div>
    </div>
  `);

  const widthSel = controls.querySelector('[data-width]');
  const fpsSel = controls.querySelector('[data-fps]');
  const coloursSel = controls.querySelector('[data-colours]');
  const loopBox = controls.querySelector('[data-loop]');
  const estimate = controls.querySelector('[data-estimate]');
  const warnNote = controls.querySelector('[data-warn]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  [widthSel, fpsSel, coloursSel, loopBox].forEach((c) => c.addEventListener('change', updateEstimate));
  controls.querySelector('[data-reset]').addEventListener('click', reset);

  info.querySelector('[data-mark-start]').addEventListener('click', () => markHere('start'));
  info.querySelector('[data-mark-end]').addEventListener('click', () => markHere('end'));

  /** Snaps one handle to wherever the preview is currently paused. */
  function markHere(which) {
    if (!preview) return;
    const t = preview.node.currentTime;
    const { start, end } = trim.get();
    if (which === 'start') {
      if (t > end - MIN_CLIP) { toast('That point is past the end of the clip — move the End handle first'); return; }
      trim.set(t, end);
    } else {
      if (t < start + MIN_CLIP) { toast('That point is before the start of the clip — move the Start handle first'); return; }
      trim.set(start, t);
    }
  }

  function revokeResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }

  function reset() {
    unlinkTrim?.();
    unlinkTrim = null;
    preview?.destroy();
    preview = null;
    file = null;
    probe = null;
    info.hidden = true;
    playerHost.innerHTML = '';
    statsHost.innerHTML = '';
    controls.hidden = true;
    zone.hidden = false;
    revokeResult();
    resultsHost.innerHTML = '';
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    revokeResult();
    resultsHost.innerHTML = '';
    try {
      probe = await probeMedia(f, { frameRate: true });
      if (!probe.hasVideo) throw new Error(`${f.name} has no video track, so there are no frames to turn into a GIF.`);
      // With no usable length the trim bar has nothing to span, and the two
      // handles would sit on top of each other before the student touched them.
      if (!(probe.duration > 0)) {
        throw new Error(`UniLab could not work out how long ${f.name} is, so it cannot pick a piece of it. Convert it to MP4 first with Convert Video, then try again.`);
      }
      file = f;
      zone.hidden = true;
      info.hidden = false;

      unlinkTrim?.();
      preview?.destroy();
      preview = mediaPreview(f, { kind: 'video' });
      unlinkTrim = linkPlayerToTrim(preview.node, trim);

      playerHost.innerHTML = '';
      playerHost.appendChild(preview.node);
      statsHost.innerHTML = '';
      statsHost.appendChild(mediaStats(probe));

      trim.setDuration(probe.duration);
      // Most people want the opening of the clip, and a GIF that long is already
      // pushing it — so start from a selection that is a sensible export.
      trim.set(0, Math.min(DEFAULT_CLIP_SECONDS, probe.duration));

      controls.hidden = false;
      updateEstimate();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** Never upscale: a 320 px phone video blown up to 640 is just a bigger file. */
  function outputWidth() {
    return Math.min(Number(widthSel.value), probe.video.width);
  }

  function updateEstimate() {
    if (!probe) return;
    const { start, end } = trim.get();
    const seconds = Math.max(0, end - start);
    const width = outputWidth();
    const height = Math.max(1, Math.round(probe.video.height * (width / probe.video.width)));
    const fps = Number(fpsSel.value);
    const frames = Math.max(1, Math.round(seconds * fps));

    const parts = [`${formatDuration(seconds, { decimals: 1 })} selected`, `${width}×${height}`, `about ${frames} frames`];
    if (width < Number(widthSel.value)) parts.push(`your video is only ${probe.video.width} px wide`);
    estimate.textContent = `${parts.join(' · ')}.`;

    warnNote.hidden = seconds <= LONG_CLIP_SECONDS;
    warnNote.textContent = `⚠ ${formatDuration(seconds, { decimals: 1 })} is a long GIF. They get very large very fast — every second adds ${fps} full images. Pick a shorter piece, or drop to 5–8 frames per second.`;
  }

  /**
   * Decodes the selected range and writes one GIF frame per 1/fps slot.
   * Resolves to `null` when the job was canceled.
   */
  async function encode(signal) {
    const { start, end } = trim.get();
    const fps = Number(fpsSel.value);
    const colours = Number(coloursSel.value);
    const width = outputWidth();
    const step = 1 / fps;
    const delay = Math.round(1000 / fps);
    const span = Math.max(0.001, end - start);

    const gif = GIFEncoder();
    let nextWanted = null;
    let frames = 0;
    let outW = 0;
    let outH = 0;

    for await (const { canvas, timestamp } of streamFrames(file, { start, end, width, signal })) {
      if (pageGone || job.canceled || signal.aborted) return null;

      // The decoder hands back the frame rate the video was shot at, which is
      // usually 30 or 60. Keeping a "next wanted" clock and ignoring everything
      // before it is what turns that into an even 10 frames per second.
      if (nextWanted === null) nextWanted = timestamp;
      // The tolerance matters: a frame that lands exactly on the grid can still
      // be a float hair under it, and would be thrown away for nothing.
      if (timestamp < nextWanted - 1e-4) continue;

      const w = canvas.width;
      const h = canvas.height;
      if (frames === 0) { outW = w; outH = h; }
      // A GIF has one logical screen size for the whole animation, so a frame
      // that somehow came back a different size is skipped rather than written.
      else if (w !== outW || h !== outH) continue;

      // This canvas comes from a pool and the next iteration may draw over it,
      // so the pixels have to be pulled out right now — never keep the canvas.
      const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
      const palette = quantize(data, colours);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, w, h, {
        palette,
        delay,
        // The loop count belongs to the animation, not the frame; it is read
        // from the first one and ignored everywhere else.
        ...(frames === 0 ? { repeat: loopBox.checked ? 0 : -1 } : {}),
      });
      frames++;

      nextWanted += step;
      // A video slower than the requested rate would leave this clock permanently
      // behind, so re-anchor it and keep at most one frame per slot.
      if (nextWanted <= timestamp) nextWanted = timestamp + step;

      const fraction = Math.min(1, Math.max(0, (timestamp - start) / span));
      job.update(fraction, `${Math.round(fraction * 100)}% · ${frames} ${frames === 1 ? 'frame' : 'frames'}`);
      // Quantising every frame is exactly the long loop that freezes a tab, and
      // a frozen tab means the Cancel button never gets its click either.
      await yieldToBrowser();
    }

    if (pageGone || job.canceled || signal.aborted) return null;
    if (frames === 0) {
      throw new Error('No frames could be read from that part of the video. Try moving the start and end a little further apart.');
    }

    job.update(1, 'Writing the GIF…');
    await yieldToBrowser();
    gif.finish();
    return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), frames, width: outW, height: outH };
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    revokeResult();
    resultsHost.innerHTML = '';

    const { start, end } = trim.get();
    if (end - start < MIN_CLIP) {
      errorBox(panel, 'The start and the end are in the same place, so there are no frames to turn into a GIF. Drag the handles apart, or type the times into the Start and End boxes.');
      return;
    }

    goBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Reading the video…');

    try {
      const result = await encode(signal);
      job.stop();
      if (!result) { if (!pageGone) toast('GIF canceled'); return; }
      showResult(result, performance.now() - started);
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('GIF canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  function showResult({ blob, frames, width, height }, elapsedMs) {
    const name = `${stem(file.name)}.gif`;
    revokeResult();
    resultUrl = URL.createObjectURL(blob);

    const img = el(`<img alt="The finished GIF, playing on a loop" />`);
    img.src = resultUrl;
    // The preview area is wider than most GIFs; letting a 320 px GIF stretch
    // across it would show it blurrier than it really is.
    img.style.maxWidth = `${width}px`;

    resultsHost.appendChild(resultCard({
      heading: '✅ Your GIF is ready',
      message: blob.size > HEAVY_GIF_BYTES
        ? 'That is heavy for a GIF — a smaller width, fewer frames per second or a shorter selection will cut it down a lot.'
        : undefined,
      stats: [
        [String(frames), 'Frames'],
        [`${width}×${height}`, 'Dimensions'],
        [formatBytes(blob.size), 'File size'],
        [`${(elapsedMs / 1000).toFixed(1)}s`, 'Took'],
      ],
      outputs: [{ name, blob }],
      preview: img,
    }));
  }

  // Leaving the page has to stop the frame loop and hand back both blob URLs —
  // the source video and the finished GIF are both held in memory otherwise.
  window.addEventListener('hashchange', () => {
    pageGone = true;
    unlinkTrim?.();
    unlinkTrim = null;
    preview?.destroy();
    preview = null;
    revokeResult();
  }, { once: true });

  panel.append(zone, info, controls, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">A GIF has no sound and no play button — it just loops, which is
    why it beats a video file for showing a bug, a lab result or a five-second demo
    in a group chat. Two or three seconds at 320 px is usually all you need.
    Your video never leaves this device.</p>
  `));
}
