import { el, dropzone, formatBytes, errorBox, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, CONTAINERS, bitrateForTargetSize, convertMedia, evenSize,
  formatDuration, isCanceled, pickAudioCodec, pickVideoCodec, probeMedia,
  quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, mediaPreview, mediaStats, resultCard } from '../media-ui.js';

// Size caps students actually run into. The value is the cap in bytes; aiming
// slightly under it leaves room for the container overhead.
const TARGETS = [
  { label: '10 MB · email', bytes: 10 * 1024 ** 2 },
  { label: '25 MB · Gmail', bytes: 25 * 1024 ** 2 },
  { label: '50 MB · LMS', bytes: 50 * 1024 ** 2 },
  { label: '100 MB · LINE', bytes: 100 * 1024 ** 2 },
  { label: '200 MB', bytes: 200 * 1024 ** 2 },
];

// Cap applies to the *shorter* side, so a portrait phone video shot at
// 1080×1920 is treated as 1080p, not as 1920p.
const RESOLUTIONS = [
  { label: 'Keep original', cap: 0 },
  { label: '1080p', cap: 1080 },
  { label: '720p', cap: 720 },
  { label: '480p', cap: 480 },
  { label: '360p', cap: 360 },
];

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  let file = null;
  let probe = null;
  let preview = null;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: false,
    label: 'Choose a video',
    hint: 'MP4, MOV, WebM or MKV — even a 2 GB file',
    onFiles: ([f]) => load(f),
  });

  const info = el(`<div hidden></div>`);

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Shrink to</label>
          <select data-mode>
            <option value="target">A file size limit</option>
            <option value="quality">A quality level</option>
          </select>
        </div>
        <div class="field" data-targetwrap>
          <label>Must be under</label>
          <select data-target></select>
        </div>
        <div class="field" data-qualitywrap hidden>
          <label>Quality</label>
          <select data-quality>
            <option value="very-high">Very high — barely smaller</option>
            <option value="high" selected>High — looks the same</option>
            <option value="medium">Medium — good for uploads</option>
            <option value="low">Low — smallest file</option>
          </select>
        </div>
        <div class="field">
          <label>Resolution</label>
          <select data-res></select>
        </div>
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="mp4">MP4 — plays everywhere</option>
            <option value="webm">WebM — smaller, web only</option>
          </select>
        </div>
        <label class="checkbox"><input type="checkbox" data-mute /> Remove the audio</label>
      </div>
      <p class="note" data-estimate></p>
      <div class="actions">
        <button class="btn" data-go>Compress video</button>
        <button class="btn secondary" data-reset>Choose another video</button>
      </div>
    </div>
  `);

  const targetSel = controls.querySelector('[data-target]');
  TARGETS.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = t.label;
    if (t.bytes === 25 * 1024 ** 2) o.selected = true;
    targetSel.appendChild(o);
  });
  const resSel = controls.querySelector('[data-res]');
  RESOLUTIONS.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = r.label;
    if (r.cap === 720) o.selected = true;
    resSel.appendChild(o);
  });

  const modeSel = controls.querySelector('[data-mode]');
  const qualitySel = controls.querySelector('[data-quality]');
  const formatSel = controls.querySelector('[data-format]');
  const muteBox = controls.querySelector('[data-mute]');
  const estimate = controls.querySelector('[data-estimate]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  modeSel.addEventListener('change', () => {
    controls.querySelector('[data-targetwrap]').hidden = modeSel.value !== 'target';
    controls.querySelector('[data-qualitywrap]').hidden = modeSel.value !== 'quality';
    updateEstimate();
  });
  [targetSel, qualitySel, resSel, formatSel, muteBox].forEach((c) =>
    c.addEventListener('change', updateEstimate));

  controls.querySelector('[data-reset]').addEventListener('click', reset);

  function reset() {
    preview?.destroy();
    preview = null;
    file = null;
    probe = null;
    info.hidden = true;
    info.innerHTML = '';
    controls.hidden = true;
    zone.hidden = false;
    resultsHost.innerHTML = '';
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    try {
      probe = await probeMedia(f, { frameRate: true });
      if (!probe.hasVideo) throw new Error(`${f.name} has no video track. For sound-only files, use Compress Audio instead.`);
      file = f;
      zone.hidden = true;
      info.hidden = false;
      info.innerHTML = '';
      preview?.destroy();
      preview = mediaPreview(f, { kind: 'video', muted: true });
      info.append(preview.node, mediaStats(probe));
      controls.hidden = false;
      muteBox.disabled = !probe.hasAudio;
      updateEstimate();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** Target resolution after applying the cap to the shorter side. */
  function targetSize() {
    const cap = RESOLUTIONS[Number(resSel.value)].cap;
    const { width, height } = probe.video;
    if (!cap || Math.min(width, height) <= cap) return { width, height, scaled: false };
    const scale = cap / Math.min(width, height);
    return { width: evenSize(width * scale), height: evenSize(height * scale), scaled: true };
  }

  function audioBitrate() {
    if (!probe.hasAudio || muteBox.checked) return 0;
    // Re-encoding a 64 kbps mono voice track at 128 kbps would grow it for no
    // gain, so never go above what the source already uses.
    const source = probe.audio.bitrate;
    return source ? Math.min(128_000, Math.round(source)) : 128_000;
  }

  /** Roughly what the video track is already using, in bits per second. */
  function sourceVideoBitrate() {
    const total = (probe.size * 8) / Math.max(0.1, probe.duration);
    return Math.max(50_000, total - (probe.hasAudio ? 128_000 : 0));
  }

  /**
   * The bitrate to actually encode at. Aiming at a size limit that the clip is
   * already under would otherwise *raise* the bitrate and hand back a file
   * several times bigger than the original — technically "under 25 MB", and
   * completely useless. Never encode above what the source already carries.
   */
  function chosenBitrate() {
    const wanted = bitrateForTargetSize({
      targetBytes: TARGETS[Number(targetSel.value)].bytes,
      durationSeconds: probe.duration,
      audioBitrate: audioBitrate(),
    });
    return Math.round(Math.min(wanted, sourceVideoBitrate() * 0.95));
  }

  function updateEstimate() {
    if (!probe) return;
    const { width, height, scaled } = targetSize();
    const parts = [`Output: ${width}×${height}${scaled ? '' : ' (unchanged)'}`];
    if (modeSel.value === 'target') {
      const bytes = TARGETS[Number(targetSel.value)].bytes;
      parts.push(`about ${Math.round(chosenBitrate() / 1000)} kbps of video`);
      if (bytes >= probe.size) {
        parts.push(`⚠ this video is already under ${formatBytes(bytes)}, so it will be re-encoded at its current quality rather than made bigger`);
      }
    }
    estimate.textContent = `${parts.join(' · ')}.`;
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Preparing…');

    try {
      const containerId = formatSel.value;
      const { width, height } = targetSize();
      const useTarget = modeSel.value === 'target';
      const bitrate = useTarget ? chosenBitrate() : null;

      const [videoCodec, audioCodec] = await Promise.all([
        pickVideoCodec(containerId, { width, height, bitrate }),
        probe.hasAudio && !muteBox.checked
          ? pickAudioCodec(containerId, { numberOfChannels: probe.audio.channels, sampleRate: probe.audio.sampleRate })
          : Promise.resolve(undefined),
      ]);

      const result = await convertMedia({
        file,
        container: containerId,
        video: {
          width,
          height,
          fit: 'contain',
          codec: videoCodec,
          quality: bitrate ? quality(bitrate) : quality(qualitySel.value),
          // A compressor must always re-encode; without this Mediabunny would
          // happily copy the original stream through untouched when the codec
          // and size already match, and nothing would get smaller.
          forceTranscode: true,
        },
        audio: muteBox.checked || !probe.hasAudio
          ? { discard: true }
          : { codec: audioCodec, quality: quality(audioBitrate()) },
        onProgress: (fraction, processedSeconds) => {
          job.update(fraction, `${Math.round(fraction * 100)}% · ${formatDuration(processedSeconds)} of ${formatDuration(probe.duration)}`);
        },
        signal,
      });

      job.stop();
      showResult(result, performance.now() - started);
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Compression canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  function showResult({ blob, ext, warnings }, elapsedMs) {
    const saved = Math.round((1 - blob.size / probe.size) * 100);
    const name = `${stem(file.name)}-compressed.${ext}`;
    const outPreview = mediaPreview(new File([blob], name, { type: blob.type }), { kind: 'video' });
    const targetBytes = modeSel.value === 'target' ? TARGETS[Number(targetSel.value)].bytes : null;

    const grew = blob.size >= probe.size;
    resultsHost.appendChild(resultCard({
      heading: grew ? '✅ Done — but keep your original' : `✅ Done — ${saved}% smaller`,
      message: grew
        ? 'This video was already compressed about as far as it goes, so the new file is no smaller. Keep the original unless you needed the resolution or format change.'
        : targetBytes
          ? (blob.size <= targetBytes
            ? `Comfortably under the ${formatBytes(targetBytes)} limit.`
            : `This is as small as ${CONTAINERS[formatSel.value].label} goes at this resolution — try a lower resolution to get under ${formatBytes(targetBytes)}.`)
          : undefined,
      stats: [
        [formatBytes(probe.size), 'Before'],
        [formatBytes(blob.size), 'After'],
        [`${Math.max(0, saved)}%`, 'Saved'],
        [`${(elapsedMs / 1000).toFixed(1)}s`, 'Took'],
      ],
      outputs: [{ name, blob }],
      warnings,
      preview: outPreview.node,
    }));
  }

  panel.append(zone, info, controls, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Recording on a phone gives you a huge file for what is usually a
    talking-head video. 720p at the 25 MB setting is the sweet spot for hand-ins —
    it still reads clearly on a projector. Your video never leaves this device.</p>
  `));
}
