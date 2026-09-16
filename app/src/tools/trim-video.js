import { el, dropzone, formatBytes, errorBox, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, CONTAINERS, convertMedia, formatDuration, isCanceled,
  pickVideoCodec, probeMedia, quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, linkPlayerToTrim, mediaPreview, mediaStats, resultCard, trimBar } from '../media-ui.js';

// Below this the two handles are effectively on top of each other and the
// encoder would be asked to write a clip with no frames in it.
const MIN_CLIP = 0.1;

// What "Same as the original" resolves to. Mediabunny reads more formats than
// it can write (MPEG-TS, for one), so anything not listed here lands on MP4.
const SOURCE_BY_EXT = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', qt: 'mov', webm: 'webm', mkv: 'mkv' };
const SOURCE_BY_MIME = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
};

// Which video codecs each output container can carry across untouched. This is
// Mediabunny's own rule, and it decides whether a trim is a two-second copy or
// a full re-encode: WebM has no room for the H.264 a phone records, so saving a
// phone clip as WebM is never the fast path however little you are cutting.
const CARRIES_VIDEO = {
  mp4: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
  mov: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
  mkv: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
  webm: ['vp9', 'av1', 'vp8'],
};

// MP4 and MOV can record "this was filmed sideways" as a note next to the
// picture; MKV and WebM cannot in a way players respect, so a rotated phone
// clip has to be redrawn upright on its way into one of those.
const KEEPS_ROTATION = { mp4: true, mov: true, mkv: false, webm: false };

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  let file = null;
  let probe = null;
  let preview = null;
  let unlink = null;      // detaches the player ⇄ trim bar link
  let outPreview = null;  // the player inside the result card

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: false,
    label: 'Choose a video',
    hint: 'MP4, MOV, WebM or MKV — a lecture recording is fine',
    onFiles: ([f]) => load(f),
  });

  const info = el(`
    <div hidden>
      <div data-player></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn secondary small" data-mark-start>Start here</button>
        <button class="btn secondary small" data-mark-end>End here</button>
        <span class="note" style="margin:0">Play the video, pause where you want the cut, then press a button.</span>
      </div>
      <div data-trim></div>
      <div data-stats></div>
    </div>
  `);
  const playerHost = info.querySelector('[data-player]');
  const trimHost = info.querySelector('[data-trim]');
  const statsHost = info.querySelector('[data-stats]');

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="same" selected>Same as the original</option>
            <option value="mp4">MP4 — most common</option>
            <option value="webm">WebM — smaller, web only</option>
          </select>
        </div>
        <label class="checkbox"><input type="checkbox" data-mute /> Remove the audio</label>
      </div>
      <p class="note" data-estimate></p>
      <p class="note" data-speed></p>
      <div class="actions">
        <button class="btn" data-go>Trim video</button>
        <button class="btn secondary" data-reset>Choose another video</button>
      </div>
    </div>
  `);

  const sameOption = controls.querySelector('[data-format] option[value="same"]');
  const formatSel = controls.querySelector('[data-format]');
  const muteBox = controls.querySelector('[data-mute]');
  const estimate = controls.querySelector('[data-estimate]');
  const speedNote = controls.querySelector('[data-speed]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  // One trim bar for the whole page — a new file just resets its duration, so
  // the player link and the handle wiring below are only ever set up once.
  const trim = trimBar({
    duration: 0,
    onChange: updateEstimate,
    // Seeking the preview on every handle move is the whole point: you see the
    // frame you are cutting on instead of guessing from a timecode.
    onScrub: (t) => {
      if (preview && Number.isFinite(t)) preview.node.currentTime = t;
    },
  });
  trimHost.appendChild(trim.root);

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

  [formatSel, muteBox].forEach((c) => c.addEventListener('change', updateEstimate));
  controls.querySelector('[data-reset]').addEventListener('click', reset);

  function reset() {
    unlink?.();
    unlink = null;
    preview?.destroy();
    preview = null;
    outPreview?.destroy();
    outPreview = null;
    file = null;
    probe = null;
    info.hidden = true;
    playerHost.innerHTML = '';
    statsHost.innerHTML = '';
    controls.hidden = true;
    zone.hidden = false;
    resultsHost.innerHTML = '';
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    outPreview?.destroy();
    outPreview = null;
    try {
      probe = await probeMedia(f, { frameRate: true });
      if (!probe.hasVideo) throw new Error(`${f.name} has no video track. For a sound-only file, use Trim Audio instead.`);
      // A file with no usable duration gives the trim bar nothing to work with,
      // and the guard on the Trim button would blame the student for it.
      if (!(probe.duration > 0)) throw new Error(`UniLab could not work out how long ${f.name} is, so there is nothing to trim. Try converting it to MP4 first with Convert Video.`);
      file = f;
      zone.hidden = true;
      info.hidden = false;

      unlink?.();
      preview?.destroy();
      // Not muted: finding the exact moment someone stops talking is a lot
      // easier with the sound on.
      preview = mediaPreview(f, { kind: 'video' });
      playerHost.innerHTML = '';
      playerHost.appendChild(preview.node);
      statsHost.innerHTML = '';
      statsHost.appendChild(mediaStats(probe));

      trim.setDuration(probe.duration);
      unlink = linkPlayerToTrim(preview.node, trim);

      sameOption.textContent = `Same as the original — ${CONTAINERS[sourceContainer()].label}`;
      controls.hidden = false;
      muteBox.disabled = !probe.hasAudio;
      if (!probe.hasAudio) muteBox.checked = false;
      updateEstimate();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** The CONTAINERS key that matches the file the student picked. */
  function sourceContainer() {
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
    const mime = (probe.mimeType ?? '').split(';')[0].trim().toLowerCase();
    return SOURCE_BY_EXT[ext] ?? SOURCE_BY_MIME[mime] ?? 'mp4';
  }

  function chosenContainer() {
    return formatSel.value === 'same' ? sourceContainer() : formatSel.value;
  }

  /**
   * True when this trim cannot be done by copying the encoded packets across.
   *
   * This is the whole speed story of the tool, and none of it is a choice we
   * get to make — it is exactly when Mediabunny gives up the fast path:
   *
   *  1. The clip starts partway in. There is no "cut at the nearest keyframe
   *     and copy the rest" path; the moment the Start handle moves off zero,
   *     every frame from there on is decoded and encoded again. Cutting only
   *     the *end* stays a copy, because the last packet is simply dropped.
   *  2. The chosen container cannot hold the codec the video is already in.
   *  3. The video was filmed sideways and the container cannot say so.
   */
  function willReencode() {
    if (trim.get().start > 0) return true;
    const target = chosenContainer();
    if (!CARRIES_VIDEO[target].includes(probe.video.codec)) return true;
    return !!probe.video.rotation && !KEEPS_ROTATION[target];
  }

  /**
   * Roughly what the video track is already using, in bits per second. When a
   * trim does have to re-encode, this keeps the clip at the weight it had in
   * the original instead of letting the encoder's default quality hand back a
   * ten-second clip bigger than the minute it came from.
   */
  function sourceVideoBitrate() {
    const total = (probe.size * 8) / Math.max(0.1, probe.duration);
    return Math.max(120_000, Math.round(total - (probe.hasAudio ? 128_000 : 0)));
  }

  function updateEstimate() {
    if (!probe) return;

    const { start, end } = trim.get();
    const length = Math.max(0, end - start);
    const parts = [`Keeping ${formatDuration(length, { decimals: 1 })} of ${formatDuration(probe.duration)}`];
    if (probe.duration > 0) {
      parts.push(`roughly ${formatBytes(Math.round(probe.size * (length / probe.duration)))}`);
    }
    if (start <= 0 && end >= probe.duration - 0.05) parts.push('nothing is being cut off yet');
    estimate.textContent = `${parts.join(' · ')}.`;

    if (!willReencode()) {
      speedNote.textContent = 'Straight copy: seconds even on a two-hour lecture, and not one pixel is re-encoded. Moving the Start handle off the beginning is what makes it slow.';
    } else if (start > 0) {
      speedNote.textContent = 'Your clip starts partway in, so the video has to be rebuilt from that point — about as long as compressing takes. The cut lands exactly on your Start time. Cutting only the end instead is nearly instant.';
    } else {
      speedNote.textContent = `Saving as ${CONTAINERS[chosenContainer()].label} means rebuilding the video, so this takes about as long as compressing does. "Same as the original" keeps it a straight copy.`;
    }
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    outPreview?.destroy();
    outPreview = null;

    const { start, end } = trim.get();
    const length = end - start;
    if (length < MIN_CLIP) {
      errorBox(panel, 'The start and the end are in the same place, so there would be no video left. Drag the handles apart, or type the times into the Start and End boxes.');
      return;
    }
    const reencodes = willReencode();
    if (reencodes && !probe.video.decodable) {
      errorBox(panel, `This browser cannot open the video inside ${file.name}, so it can only be cut at the end, not at the start. Drag the Start handle back to the beginning, or run the file through Convert Video into MP4 (H.264) first.`);
      return;
    }

    goBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Preparing…');

    try {
      const containerId = chosenContainer();
      // Only ask the browser what it can encode when something is actually
      // going to be encoded; naming a codec on the copy path would itself be a
      // request to re-encode, and would throw the fast path away.
      const bitrate = reencodes ? sourceVideoBitrate() : null;
      const videoCodec = reencodes
        ? await pickVideoCodec(containerId, { width: probe.video.width, height: probe.video.height, bitrate })
        : undefined;

      const result = await convertMedia({
        file,
        container: containerId,
        // Never forceTranscode: a trim should copy whenever it legally can, and
        // that is exactly what an empty video option asks for. When the clip
        // starts partway in, Mediabunny re-encodes on its own because it has
        // to — and the bitrate below keeps the clip at the weight it had.
        video: reencodes ? { codec: videoCodec, quality: quality(bitrate) } : {},
        audio: muteBox.checked || !probe.hasAudio ? { discard: true } : {},
        trim: { start, end },
        onProgress: (fraction, processedSeconds) => {
          job.update(fraction, `${Math.round(fraction * 100)}% · ${formatDuration(processedSeconds)} of ${formatDuration(length)}`);
        },
        signal,
      });

      job.stop();
      showResult(result, length, reencodes, performance.now() - started);
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Trim canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  function showResult({ blob, ext, mime, warnings }, length, reencodes, elapsedMs) {
    const name = `${stem(file.name)}-trimmed.${ext}`;
    outPreview = mediaPreview(new File([blob], name, { type: mime }), { kind: 'video' });

    resultsHost.appendChild(resultCard({
      heading: `✅ Done — your clip is ${formatDuration(length)}`,
      message: reencodes
        ? 'The clip starts exactly where you put the Start handle. Everything from there had to be rebuilt, so the picture went through the encoder once, at the bitrate the original was already using.'
        : 'Only the end was cut, so the video was copied straight across — the picture is byte-for-byte what it was.',
      stats: [
        [formatDuration(probe.duration), 'Was'],
        [formatDuration(length), 'Now'],
        [formatBytes(blob.size), 'New size'],
        [`${(elapsedMs / 1000).toFixed(1)}s`, 'Took'],
      ],
      outputs: [{ name, blob }],
      warnings,
      preview: outPreview.node,
    }));
  }

  // The preview holds a blob URL for the whole source file — a two-hour lecture
  // would stay in memory for the rest of the session otherwise.
  window.addEventListener('hashchange', () => {
    unlink?.();
    unlink = null;
    preview?.destroy();
    preview = null;
    outPreview?.destroy();
    outPreview = null;
  }, { once: true });

  panel.append(zone, info, controls, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Cutting only the end is the cheap one — the video is copied, not
    re-encoded, so a two-hour lecture is done in seconds. Trimming the last ten seconds
    of "is it still recording?" often drops a presentation under an upload limit on its
    own, before you compress anything. Your video never leaves this device.</p>
  `));
}
