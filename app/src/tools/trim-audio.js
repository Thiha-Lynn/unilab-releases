import { el, dropzone, formatBytes, errorBox, stem, toast } from '../ui.js';
import {
  MEDIA_ACCEPT, CONTAINERS, convertMedia, formatDuration, isCanceled,
  pickAudioCodec, probeMedia, quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, linkPlayerToTrim, mediaPreview, mediaStats, resultCard, trimBar } from '../media-ui.js';

// Below this the two handles are effectively on top of each other and the
// encoder would be asked to write a clip with no sound in it.
const MIN_CLIP = 0.1;

// What "Same as the original" resolves to. Video files land on the audio
// container that usually already holds their sound (AAC in MP4/MOV, Opus in
// WebM/MKV), which is what makes the copy path below reachable for them too.
// FLAC and anything else UniLab can read but not write land on WAV, so a
// lossless source never gets silently squashed into a lossy file.
const SOURCE_BY_EXT = {
  mp3: 'mp3',
  m4a: 'm4a', aac: 'm4a', mp4: 'm4a', m4v: 'm4a', mov: 'm4a', qt: 'm4a', ts: 'm4a',
  wav: 'wav', flac: 'wav',
  ogg: 'ogg', oga: 'ogg', opus: 'ogg', webm: 'ogg', mkv: 'ogg',
};
const SOURCE_BY_MIME = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'video/mp4': 'm4a', 'video/quicktime': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'wav', 'audio/x-flac': 'wav',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'video/webm': 'ogg', 'video/x-matroska': 'ogg',
};

// Which source codecs each container can hold untouched. Only when the track is
// already one of these can the cut be a straight copy — otherwise Mediabunny
// has to re-encode it and calling the result "lossless" on screen would be a lie.
const COPYABLE = { mp3: ['mp3'], m4a: ['aac'], ogg: ['opus', 'vorbis'] };

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
    // MEDIA_ACCEPT, not AUDIO_ACCEPT: the hint below offers video files, and an
    // audio-only accept list would grey them out in the phone's file picker.
    accept: MEDIA_ACCEPT,
    multiple: false,
    label: 'Choose a recording',
    hint: 'MP3, M4A, WAV or OGG — a two-hour lecture is fine. You can drop a video here too',
    onFiles: ([f]) => load(f),
  });

  const info = el(`
    <div hidden>
      <div data-player></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn secondary small" data-mark-start>Start here</button>
        <button class="btn secondary small" data-mark-end>End here</button>
        <button class="btn secondary small" data-play-sel>▶ Play selection</button>
        <span class="note" style="margin:0">Play the recording, pause where you want the cut, then press a button.</span>
      </div>
      <div data-trim></div>
      <div data-stats></div>
      <p class="note" data-videonote hidden></p>
    </div>
  `);
  const playerHost = info.querySelector('[data-player]');
  const trimHost = info.querySelector('[data-trim]');
  const statsHost = info.querySelector('[data-stats]');
  const videoNote = info.querySelector('[data-videonote]');

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="same" selected>Same as the original</option>
            <option value="mp3">MP3 — plays everywhere</option>
            <option value="m4a">M4A — better quality, same size</option>
            <option value="wav">WAV — no quality loss, big</option>
            <option value="ogg">OGG — smallest for voice</option>
          </select>
        </div>
        <div class="field" data-ratewrap>
          <label>Sound quality</label>
          <select data-rate>
            <option value="keep" selected>Same as the original</option>
            <option value="192000">192 kbps — music</option>
            <option value="128000">128 kbps — everyday</option>
            <option value="96000">96 kbps — voice</option>
            <option value="64000">64 kbps — smallest</option>
          </select>
        </div>
        <label class="checkbox"><input type="checkbox" data-mono /> Mono (one channel — halves the size of a voice recording)</label>
      </div>
      <p class="note" data-copyhelp></p>
      <p class="note" data-estimate></p>
      <div class="actions">
        <button class="btn" data-go>Trim audio</button>
        <button class="btn secondary" data-reset>Choose another file</button>
      </div>
    </div>
  `);

  const sameOption = controls.querySelector('[data-format] option[value="same"]');
  const formatSel = controls.querySelector('[data-format]');
  const rateWrap = controls.querySelector('[data-ratewrap]');
  const rateSel = controls.querySelector('[data-rate]');
  const monoBox = controls.querySelector('[data-mono]');
  const copyHelp = controls.querySelector('[data-copyhelp]');
  const estimate = controls.querySelector('[data-estimate]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  // One trim bar for the whole page — a new file just resets its duration, so
  // the player link and the handle wiring below are only ever set up once.
  const trim = trimBar({
    duration: 0,
    onChange: updateEstimate,
    // Seeking the preview on every handle move is the whole point: with no
    // picture to look at, hearing where the cut lands is the only way to aim it.
    onScrub: (t) => {
      if (preview && Number.isFinite(t)) preview.node.currentTime = t;
    },
  });
  trimHost.appendChild(trim.root);

  info.querySelector('[data-mark-start]').addEventListener('click', () => markHere('start'));
  info.querySelector('[data-mark-end]').addEventListener('click', () => markHere('end'));
  info.querySelector('[data-play-sel]').addEventListener('click', playSelection);

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

  /** Jumps to the start of the selection and plays it, so you hear the cut. */
  function playSelection() {
    if (!preview) return;
    preview.node.currentTime = trim.get().start;
    // Autoplay is blocked until the page has been interacted with on some
    // phones; the click counts, but a rejected promise must not go unexplained.
    preview.node.play().catch(() => toast('Press play on the player once, then try again'));
  }

  [formatSel, rateSel, monoBox].forEach((c) => c.addEventListener('change', updateEstimate));
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
    videoNote.hidden = true;
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
      probe = await probeMedia(f);
      if (!probe.hasAudio) throw new Error(`${f.name} has no sound track, so there is nothing to trim.`);
      // A file with no usable duration gives the trim bar nothing to work with,
      // and the guard on the Trim button would blame the student for it.
      if (!(probe.duration > 0)) throw new Error(`UniLab could not work out how long ${f.name} is, so there is nothing to trim. Try converting it to MP3 first with Convert Audio.`);
      file = f;
      zone.hidden = true;
      info.hidden = false;

      unlink?.();
      preview?.destroy();
      // An <audio> player even for a video file: the picture is being thrown
      // away anyway, and the waveform-free player keeps the page short on a phone.
      preview = mediaPreview(f, { kind: 'audio' });
      playerHost.innerHTML = '';
      playerHost.appendChild(preview.node);
      statsHost.innerHTML = '';
      statsHost.appendChild(mediaStats(probe));

      videoNote.hidden = !probe.hasVideo;
      if (probe.hasVideo) videoNote.textContent = `${f.name} is a video — you'll get a sound-only file out, with the picture dropped. Use Trim Video if you wanted to keep the picture.`;

      trim.setDuration(probe.duration);
      unlink = linkPlayerToTrim(preview.node, trim);

      sameOption.textContent = `Same as the original — ${CONTAINERS[sourceContainer()].label}`;
      controls.hidden = false;
      updateEstimate();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** The CONTAINERS key that best matches the file the student picked. */
  function sourceContainer() {
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
    const mime = (probe.mimeType ?? '').split(';')[0].trim().toLowerCase();
    return SOURCE_BY_EXT[ext] ?? SOURCE_BY_MIME[mime] ?? 'mp3';
  }

  function chosenContainer() {
    return formatSel.value === 'same' ? sourceContainer() : formatSel.value;
  }

  /** True when the student asked for fewer channels than the file already has. */
  function changesChannels() {
    return monoBox.checked && probe.audio.channels > 1;
  }

  /**
   * The cut is a copy — instant, and bit-for-bit the sound that went in — only
   * when the output container would hold the existing track as-is and nothing
   * about the audio itself was asked to change.
   *
   * The start time is part of that. Compressed audio is stored in packets of a
   * few dozen milliseconds each, so a cut that begins part-way through the file
   * can only land on the exact requested moment by decoding and re-encoding —
   * Mediabunny does that automatically, and it is the right call, because the
   * alternative is a clip that starts up to a packet early or late. Only a cut
   * that keeps the very beginning can copy the packets straight across. Trimming
   * just the end of a lecture is exactly that case, and it stays instant.
   */
  function canCopy() {
    const id = chosenContainer();
    if (id !== sourceContainer()) return false;
    if (changesChannels()) return false;
    if (trim.get().start > 0) return false;
    // WAV is uncompressed, so the bitrate menu is meaningless there and hidden;
    // whatever it happens to be left on must not count as a change.
    if (id !== 'wav' && rateSel.value !== 'keep') return false;
    const codec = probe.audio.codec ?? '';
    return id === 'wav' ? codec.startsWith('pcm') : (COPYABLE[id] ?? []).includes(codec);
  }

  /**
   * Bits per second to encode at when re-encoding. "Same as the original" has to
   * become a real number here: matching what the file already uses keeps a
   * 64 kbps voice memo from being blown up to 128 kbps for no gain.
   */
  function targetBitrate() {
    if (chosenContainer() === 'wav') return null;
    if (rateSel.value !== 'keep') return Number(rateSel.value);
    const source = probe.audio.bitrate;
    return source ? Math.min(192_000, Math.max(64_000, Math.round(source))) : 128_000;
  }

  /** Rough output size in bytes, or 0 when there is nothing honest to say. */
  function estimateBytes(length) {
    if (!(length > 0)) return 0;
    if (chosenContainer() === 'wav') {
      const channels = monoBox.checked ? 1 : probe.audio.channels;
      return probe.audio.sampleRate * channels * 2 * length;
    }
    if (canCopy()) {
      // Only the sound track's own share of the file scales with the clip, and
      // for a video source the file size says nothing at all about the sound.
      const bits = probe.hasVideo ? probe.audio.bitrate : (probe.size * 8) / probe.duration;
      return bits ? (bits * length) / 8 : 0;
    }
    return (targetBitrate() * length) / 8;
  }

  function updateEstimate() {
    if (!probe) return;
    rateWrap.hidden = chosenContainer() === 'wav';

    const { start, end } = trim.get();
    const length = Math.max(0, end - start);
    const parts = [`Keeping ${formatDuration(length, { decimals: 1 })} of ${formatDuration(probe.duration)}`];
    const guess = estimateBytes(length);
    if (guess) parts.push(`roughly ${formatBytes(guess)}`);
    if (start <= 0.05 && end >= probe.duration - 0.05) parts.push('nothing is being cut off yet');
    estimate.textContent = `${parts.join(' · ')}.`;

    const spec = CONTAINERS[chosenContainer()];
    copyHelp.textContent = canCopy()
      ? 'Instant and lossless — you are only cutting the end, so the sound is copied across as it is and a two-hour file cuts in seconds.'
      : start > 0 && chosenContainer() === sourceContainer() && !changesChannels() && rateSel.value === 'keep'
        ? `Re-encoded as ${spec.label}, because the clip starts part-way in and the cut has to land on the exact second you picked. Move Start back to 0:00 if you only want the end trimmed off — that copies instead, and finishes in seconds.`
        : `Re-encoded as ${spec.label}. ${spec.note}`;
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    outPreview?.destroy();
    outPreview = null;

    const { start, end } = trim.get();
    const length = end - start;
    if (length < MIN_CLIP) {
      errorBox(panel, 'The start and the end are in the same place, so there would be no sound left. Drag the handles apart, or type the times into the Start and End boxes.');
      return;
    }
    const copying = canCopy();
    if (!copying && !probe.audio.decodable) {
      errorBox(panel, `This browser cannot decode the sound inside ${file.name}, so it cannot be re-encoded. You can still cut the end off it: set "Save as" back to "Same as the original", leave the quality and Mono alone, and drag Start back to 0:00. The cut then copies the sound across instead of re-encoding it. Otherwise try this page in Chrome or Edge.`);
      return;
    }

    goBtn.disabled = true;
    const signal = job.start('Preparing…');

    try {
      // Read once, here: the menus stay live while the job runs, and the result
      // card below must describe what was actually written, not whatever the
      // student was idly clicking through while they waited.
      const containerId = chosenContainer();
      const containerLabel = CONTAINERS[containerId].label;
      const mono = monoBox.checked;
      const bitrate = targetBitrate();
      // Only ask the browser what it can encode when we are actually going to
      // encode something. Naming a codec is a request to re-encode in it, so on
      // the copy path the audio options stay empty on purpose.
      const audioOptions = copying
        ? {}
        : {
          codec: await pickAudioCodec(containerId, {
            numberOfChannels: mono ? 1 : probe.audio.channels,
            sampleRate: probe.audio.sampleRate,
          }),
          ...(bitrate ? { quality: quality(bitrate) } : {}),
          ...(mono ? { numberOfChannels: 1 } : {}),
        };

      const result = await convertMedia({
        file,
        container: containerId,
        // Explicit rather than implicit: an audio container drops the video
        // track anyway, and saying so here keeps it out of the warnings list.
        video: { discard: true },
        audio: audioOptions,
        trim: { start, end },
        onProgress: (fraction, processedSeconds) => {
          job.update(fraction, `${Math.round(fraction * 100)}% · ${formatDuration(processedSeconds)} of ${formatDuration(length)}`);
        },
        signal,
      });

      job.stop();
      showResult(result, { length, copying, containerLabel, mono });
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Trim canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  function showResult({ blob, ext, mime, warnings }, { length, copying, containerLabel, mono }) {
    const name = `${stem(file.name)}-trimmed.${ext}`;
    const saved = Math.round((1 - blob.size / probe.size) * 100);
    outPreview = mediaPreview(new File([blob], name, { type: mime }), { kind: 'audio' });

    resultsHost.appendChild(resultCard({
      heading: `✅ Done — your clip is ${formatDuration(length)}`,
      message: copying
        ? 'Copied without re-encoding, so it sounds exactly like the original did.'
        : `Re-encoded as ${containerLabel}${mono ? ' in mono' : ''}. Tick Mono, or drop the quality to 96 kbps, if a voice recording still needs to be smaller.`,
      stats: [
        [formatDuration(probe.duration), 'Was'],
        [formatDuration(length), 'Now'],
        [formatBytes(blob.size), 'New size'],
        [`${Math.max(0, saved)}%`, 'Saved'],
      ],
      outputs: [{ name, blob }],
      warnings,
      preview: outPreview.node,
    }));
    toast(`Trimmed to ${formatDuration(length)}`);
  }

  // Both players hold a blob URL of a whole recording, and an <audio> element
  // that is detached mid-playback can keep going. Let go of them on the way out.
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
    <p class="note">A two-hour lecture recording is mostly admin and other people's
    questions. Cutting it to the ten minutes you'll actually revise makes it small
    enough to send on LINE and quick enough to replay the night before.
    Your recording never leaves this device.</p>
  `));
}
