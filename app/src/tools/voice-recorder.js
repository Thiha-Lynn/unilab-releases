import { downloadBlob, el, errorBox, formatBytes, stem, toast } from '../ui.js';
import {
  CONTAINERS, convertMedia, ensureMp3Encoder, formatDuration, isCanceled,
  pickAudioCodec, probeMedia, quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, linkPlayerToTrim, mediaPreview, resultCard, trimBar } from '../media-ui.js';

// Below this the two handles sit on top of each other and there would be no
// sound left to write.
const MIN_CLIP = 0.1;

// Opus first — it is the best-sounding thing a browser will record at this
// bitrate, and the recording is re-encoded on the way out anyway. Safari only
// offers MP4/AAC. Mediabunny reads every one of these back.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
];

// What MediaRecorder holds in the tab while you talk. It only has to be
// comfortably better than the file you save, and this keeps a long interview
// from filling memory.
const RECORD_BITRATE = 128_000;

const BITRATES = [
  { label: '128 kbps — best, for interviews and music', value: 128_000 },
  { label: '96 kbps — clear speech, small file', value: 96_000 },
  { label: '64 kbps — smallest (a 1-hour lecture ≈ 30 MB)', value: 64_000 },
];
const DEFAULT_BITRATE = 1;

// Extension for the file MediaRecorder handed back, so the in-memory recording
// is named honestly even before it is converted.
const RAW_EXT = [[/mp4/, 'm4a'], [/ogg/, 'ogg'], [/webm/, 'webm']];

/** A filename you can still identify a week later, in the phone's own timezone. */
function recordingName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `voice-note-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Chrome's MediaRecorder writes a WebM with no duration in its header, so the
 * <audio> element reports Infinity and shows a seek bar you cannot drag.
 * Seeking far past the end makes it scan to the last packet and work the real
 * duration out — the only fix a web page has for this.
 *
 * `onReady` runs once that is over, and nothing may listen to the player before
 * it does: mid-scan the element honestly reports a position of 1e6 seconds, and
 * a trim bar handed that would fling its playhead off the side of the page.
 */
function unlockSeeking(player, onReady) {
  let done = false;
  const ready = () => {
    if (done) return;
    done = true;
    onReady();
  };
  // However this goes, the trim bar is worth having.
  setTimeout(ready, 3000);

  const scan = () => {
    if (Number.isFinite(player.duration)) { ready(); return; }
    player.addEventListener('seeked', () => {
      player.currentTime = 0;
      ready();
    }, { once: true });
    try { player.currentTime = 1e6; } catch { ready(); }
  };
  if (player.readyState > 0) scan();
  else player.addEventListener('loadedmetadata', scan, { once: true });
}

export default function render(container) {
  // A page can only reach a microphone through getUserMedia, and only capture
  // it with MediaRecorder. Both are missing on very old browsers and on any
  // page served over plain HTTP — a dead Record button would be a worse answer.
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    container.appendChild(el(`
      <div class="panel media-unsupported">
        <h3>This browser can't reach the microphone</h3>
        <p>Recording needs a browser feature this one doesn't offer. Chrome, Edge,
           Firefox and Safari all have it, on laptops and on phones.</p>
        <p>If you already have a recording — a voice memo from your phone, say —
           <b>Trim Audio</b> and <b>Convert Audio</b> still work here.</p>
      </div>
    `));
    return;
  }

  const panel = el(`
    <div class="panel">
      <div data-setup>
        <div class="controls">
          <div class="field">
            <label>Microphone</label>
            <select data-mic></select>
          </div>
        </div>
        <p class="note">The recording is held in this tab and never uploaded. It only
          becomes a file on your device when you press Save.</p>
        <div class="actions">
          <button class="btn" data-start>Start recording</button>
        </div>
      </div>

      <div class="rec-status" hidden data-status>
        <span class="rec-dot" data-dot></span>
        <span data-time>0:00</span>
        <div class="level-meter" title="How loud you are right now"><div data-level></div></div>
        <button class="btn secondary small" data-pause>Pause</button>
        <button class="btn secondary small" data-stop>Stop</button>
      </div>

      <p class="note" hidden data-hint></p>

      <div hidden data-review>
        <div data-player></div>
        <div class="actions" style="margin-top:12px">
          <button class="btn secondary small" data-mark-start>Start here</button>
          <button class="btn secondary small" data-mark-end>End here</button>
          <span class="note" style="margin:0">Play it back, pause where you want the cut,
            then press a button.</span>
        </div>
        <div data-trim></div>
        <div class="controls">
          <div class="field">
            <label>Save as</label>
            <select data-format>
              <option value="mp3" selected>MP3 — opens on anything</option>
              <option value="m4a">M4A — same quality, a little smaller</option>
              <option value="ogg">OGG — smallest for speech</option>
              <option value="wav">WAV — uncompressed, for editing</option>
            </select>
          </div>
          <div class="field" data-qualitywrap>
            <label>Quality</label>
            <select data-quality></select>
          </div>
          <label class="checkbox"><input type="checkbox" data-mono checked /> Mono — half the size, and speech gains nothing from stereo</label>
        </div>
        <p class="note" data-estimate></p>
        <div class="actions">
          <button class="btn" data-save>Save recording</button>
          <button class="btn secondary" data-again>Record again</button>
        </div>
        <div data-fallback></div>
      </div>
    </div>
  `);

  const setupBlock = panel.querySelector('[data-setup]');
  const micSel = panel.querySelector('[data-mic]');
  const startBtn = panel.querySelector('[data-start]');
  const status = panel.querySelector('[data-status]');
  const dot = panel.querySelector('[data-dot]');
  const timeOut = panel.querySelector('[data-time]');
  const levelBar = panel.querySelector('[data-level]');
  const pauseBtn = panel.querySelector('[data-pause]');
  const stopBtn = panel.querySelector('[data-stop]');
  const hint = panel.querySelector('[data-hint]');
  const review = panel.querySelector('[data-review]');
  const playerHost = review.querySelector('[data-player]');
  const trimHost = review.querySelector('[data-trim]');
  const formatSel = review.querySelector('[data-format]');
  const qualityWrap = review.querySelector('[data-qualitywrap]');
  const qualitySel = review.querySelector('[data-quality]');
  const monoBox = review.querySelector('[data-mono]');
  const estimate = review.querySelector('[data-estimate]');
  const saveBtn = review.querySelector('[data-save]');
  const fallbackHost = review.querySelector('[data-fallback]');
  const resultsHost = el(`<div></div>`);
  const job = jobProgress();

  BITRATES.forEach((b, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = b.label;
    if (i === DEFAULT_BITRATE) o.selected = true;
    qualitySel.appendChild(o);
  });

  let recorder = null;
  let stream = null;
  let audioCtx = null;
  let meterFrame = null;    // rAF handle for the input level meter
  let ticker = null;        // setInterval behind the elapsed clock
  let chunks = [];
  let segmentStart = 0;     // when the current un-paused stretch began
  let recordedMs = 0;       // everything captured before that stretch
  let recorded = null;      // the finished recording, as a File
  let probe = null;         // what Mediabunny can tell us about it
  let duration = 0;
  let preview = null;
  let unlink = null;        // detaches the player ⇄ trim bar link
  let outPreview = null;    // the player inside the result card
  let micsLabelled = false;

  const trim = trimBar({
    duration: 0,
    onChange: updateEstimate,
    onScrub: (t) => {
      if (preview && Number.isFinite(t)) preview.node.currentTime = t;
    },
  });
  trimHost.appendChild(trim.root);

  // -------------------------------------------------------------------------
  // Microphones
  // -------------------------------------------------------------------------

  /**
   * Fills the microphone list. Before the first permission grant a browser will
   * not tell a page that the headset is called "AirPods Pro" — the labels come
   * back empty — so this runs again the moment recording first starts.
   */
  async function refreshMics() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const previous = micSel.value;
    micSel.innerHTML = '';
    const auto = el(`<option value=""></option>`);
    auto.textContent = 'Default microphone';
    micSel.appendChild(auto);
    mics.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      micSel.appendChild(o);
    });
    if (previous && [...micSel.options].some((o) => o.value === previous)) micSel.value = previous;
  }
  refreshMics();
  navigator.mediaDevices.addEventListener?.('devicechange', refreshMics);

  /** What to tell someone whose microphone didn't open, in their own terms. */
  function micMessage(err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'This page is not allowed to use the microphone. Tap the padlock in the address bar, set Microphone to Allow, then press Start recording again. On an iPhone it lives in Settings → Safari → Microphone.';
    }
    if (err.name === 'NotFoundError') {
      return 'No microphone was found. Plug in a headset, or check that your laptop\'s built-in mic is not switched off, then press Start recording again.';
    }
    if (err.name === 'OverconstrainedError') {
      return 'That microphone is not connected any more. Pick a different one from the list — "Default microphone" always works.';
    }
    if (err.name === 'NotReadableError') {
      return 'Another app is holding the microphone — Zoom, Teams, LINE and Discord are the usual ones. Close it and press Start recording again.';
    }
    return `The microphone could not be opened: ${err.message}`;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Closes the stretch of recording that is currently running and adds it to the
   * total. Safe to call twice, and it has to be: a MediaRecorder that hits an
   * error goes inactive by itself, so 'stop' can arrive without `stopRecording`
   * ever having run. A stretch left open would count as zero, and `finish` would
   * throw away a perfectly good recording as "empty" — the one failure a
   * recorder must never have.
   */
  function closeSegment() {
    if (!segmentStart) return;
    recordedMs += Date.now() - segmentStart;
    segmentStart = 0;
  }

  function elapsedSeconds() {
    return (recordedMs + (segmentStart ? Date.now() - segmentStart : 0)) / 1000;
  }

  function showHint(text) {
    hint.textContent = text;
    hint.hidden = false;
  }

  function setPhase(phase) {
    setupBlock.hidden = phase !== 'idle';
    status.hidden = phase !== 'recording';
    review.hidden = phase !== 'review';
    startBtn.disabled = false;
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
    dot.style.animationPlayState = '';
    if (phase !== 'recording') levelBar.style.width = '0%';
  }

  /**
   * Draws the input level. A requestAnimationFrame loop is the right tool here
   * and nowhere else in UniLab: it is a decoration that should stop while the
   * tab is hidden, and nothing depends on it — the capture itself happens
   * inside MediaRecorder, well out of reach of the frame clock.
   */
  function startMeter() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // getUserMedia has already resolved by the time this runs, which on some
    // browsers is far enough from the button press that the context starts
    // suspended — and a suspended analyser reads pure silence, so the meter
    // would sit flat while the recording itself was perfectly fine.
    audioCtx.resume().catch(() => { /* already running */ });
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    const draw = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      // Someone talking normally sits around 0.05–0.25 RMS. Scaling by 3.5 puts
      // that in the middle of the bar instead of as a sliver at the far left,
      // so "the meter barely moves" really does mean "speak up".
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 3.5);
      levelBar.style.width = `${Math.round(level * 100)}%`;
      meterFrame = requestAnimationFrame(draw);
    };
    meterFrame = requestAnimationFrame(draw);
  }

  /**
   * Hands the microphone back. Until every track is stopped the browser keeps
   * its recording indicator lit, and a student who sees that reasonably assumes
   * they are still being listened to — so this runs the moment the audio is
   * safely in hand, not when they leave the page.
   */
  function releaseMic() {
    if (meterFrame) cancelAnimationFrame(meterFrame);
    meterFrame = null;
    levelBar.style.width = '0%';
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audioCtx?.close().catch(() => { /* already closed */ });
    audioCtx = null;
  }

  function tick() {
    const paused = recorder?.state === 'paused';
    timeOut.textContent = `${formatDuration(elapsedSeconds())}${paused ? ' · paused' : ''}`;
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stopRecording);
  pauseBtn.addEventListener('click', togglePause);

  async function start() {
    errorBox(panel, null);
    hint.hidden = true;
    resultsHost.innerHTML = '';
    startBtn.disabled = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micSel.value ? { deviceId: { exact: micSel.value } } : {}),
          // A laptop mic on a canteen table picks up the whole room. These three
          // are what make the difference between a voice note you can listen
          // back to and one you can't.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      startBtn.disabled = false;
      errorBox(panel, micMessage(err));
      return;
    }

    // The device list was unlabelled until this grant, so this is the moment
    // "Microphone 2" can finally become the real name of the headset.
    if (!micsLabelled) {
      micsLabelled = true;
      refreshMics();
    }

    try {
      const options = { audioBitsPerSecond: RECORD_BITRATE };
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      if (mimeType) options.mimeType = mimeType;
      recorder = new MediaRecorder(stream, options);

      chunks = [];
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      });
      recorder.addEventListener('stop', finish);
      recorder.addEventListener('error', (e) => {
        errorBox(panel, `The recording stopped unexpectedly: ${e.error?.message ?? 'unknown error'}. Whatever was captured up to that point is kept below.`);
        stopRecording();
      });
      // Unplugging a headset mid-sentence ends the track; without this the
      // recorder would sit there capturing silence.
      stream.getAudioTracks()[0]?.addEventListener('ended', stopRecording);

      // One-second slices: a crashed tab then loses at most a second, instead
      // of the whole rehearsal.
      recorder.start(1000);
      recordedMs = 0;
      segmentStart = Date.now();
      startMeter();
      ticker = setInterval(tick, 200);
      tick();
      setPhase('recording');
      showHint('Recording. Hold the phone or the mic about a hand\'s width from your mouth — closer is louder, but it also picks up every breath.');
    } catch (err) {
      releaseMic();
      recorder = null;
      startBtn.disabled = false;
      errorBox(panel, `Recording could not start: ${err.message}`);
    }
  }

  function togglePause() {
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      closeSegment();
      pauseBtn.textContent = 'Resume';
      // A still dot reads as "not capturing" at a glance; a pulsing one does
      // not, however clear the label next to it is.
      dot.style.animationPlayState = 'paused';
    } else if (recorder.state === 'paused') {
      recorder.resume();
      segmentStart = Date.now();
      pauseBtn.textContent = 'Pause';
      dot.style.animationPlayState = '';
    }
    tick();
  }

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    closeSegment();
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    recorder.stop();
  }

  async function finish() {
    clearInterval(ticker);
    ticker = null;
    closeSegment();
    const measured = recordedMs / 1000;
    const mimeType = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
    const blob = new Blob(chunks, { type: mimeType });
    chunks = [];
    recorder = null;
    releaseMic();

    if (!blob.size || measured < 0.3) {
      setPhase('idle');
      showHint('That recording came back empty — it was stopped before any sound was captured. Press Start recording and give it a second or two before you stop.');
      return;
    }

    const ext = RAW_EXT.find(([re]) => re.test(mimeType))?.[1] ?? 'webm';
    recorded = new File([blob], `${recordingName()}.${ext}`, { type: mimeType });

    // Reading an hour-long recording back takes a moment, and a frozen timer
    // with two dead buttons is how a student decides the tool has crashed.
    showHint('Finishing the recording…');

    // Ask the file how long it is, and fall back on the clock we just ran: a
    // WebM straight out of MediaRecorder often carries no duration at all, and
    // an unreadable one must never cost somebody their recording.
    try {
      probe = await probeMedia(recorded);
    } catch {
      probe = null;
    }
    duration = Number.isFinite(probe?.duration) && probe.duration > 0 ? probe.duration : measured;
    hint.hidden = true;

    unlink?.();
    unlink = null;
    preview?.destroy();
    preview = mediaPreview(recorded, { kind: 'audio' });
    playerHost.innerHTML = '';
    playerHost.appendChild(preview.node);
    trim.setDuration(duration);

    const player = preview.node;
    unlockSeeking(player, () => {
      // Somebody can leave the page, or start a new recording, during the scan.
      if (preview?.node === player) unlink = linkPlayerToTrim(player, trim);
    });

    setPhase('review');
    updateEstimate();
  }

  // -------------------------------------------------------------------------
  // Review and save
  // -------------------------------------------------------------------------

  review.querySelector('[data-mark-start]').addEventListener('click', () => markHere('start'));
  review.querySelector('[data-mark-end]').addEventListener('click', () => markHere('end'));

  /** Snaps one handle to wherever the playback is currently paused. */
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

  formatSel.addEventListener('change', () => {
    // WAV writes raw samples, so a bitrate would mean nothing there.
    qualityWrap.hidden = formatSel.value === 'wav';
    updateEstimate();
  });
  [qualitySel, monoBox].forEach((c) => c.addEventListener('change', updateEstimate));
  review.querySelector('[data-again]').addEventListener('click', recordAgain);

  function chosenBitrate() {
    return BITRATES[Number(qualitySel.value)].value;
  }

  function channelCount() {
    return monoBox.checked ? 1 : (probe?.audio?.channels ?? 2);
  }

  /** Roughly what the saved file will weigh — close enough to plan an upload by. */
  function estimateBytes(length) {
    if (formatSel.value === 'wav') {
      const rate = probe?.audio?.sampleRate ?? 48_000;
      return length * rate * channelCount() * 2;
    }
    return (length * chosenBitrate()) / 8;
  }

  function updateEstimate() {
    if (!recorded) return;
    const { start, end } = trim.get();
    const length = Math.max(0, end - start);
    const parts = [
      length < duration - 0.05
        ? `Saving ${formatDuration(length, { decimals: 1 })} of the ${formatDuration(duration)} you recorded`
        : `Saving all ${formatDuration(duration)}`,
      `about ${formatBytes(estimateBytes(length))} as ${CONTAINERS[formatSel.value].label}`,
    ];
    estimate.textContent = `${parts.join(' · ')}.`;
  }

  function recordAgain() {
    unlink?.();
    unlink = null;
    preview?.destroy();
    preview = null;
    outPreview?.destroy();
    outPreview = null;
    recorded = null;
    probe = null;
    duration = 0;
    playerHost.innerHTML = '';
    fallbackHost.innerHTML = '';
    resultsHost.innerHTML = '';
    trim.setDuration(0);
    errorBox(panel, null);
    hint.hidden = true;
    setPhase('idle');
  }

  /**
   * The escape hatch for a browser that can record but can't re-encode: the
   * recording is already sitting in memory, and losing it because the browser
   * is old would be the one unforgivable failure in a recorder.
   */
  function offerRawDownload() {
    const btn = el(`<button class="btn"></button>`);
    btn.textContent = `⬇ Download the recording as it is (${formatBytes(recorded.size)})`;
    btn.addEventListener('click', () => downloadBlob(recorded, recorded.name));
    const row = el(`<div class="actions"></div>`);
    row.appendChild(btn);
    fallbackHost.append(row, el(`<p class="note">This is the untrimmed recording in the
      format your browser captured it in. Most players open it; PowerPoint may not.</p>`));
  }

  saveBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    outPreview?.destroy();
    outPreview = null;

    const { start, end } = trim.get();
    const length = Math.max(0, end - start);
    if (length < MIN_CLIP) {
      errorBox(panel, 'The start and the end are in the same place, so there would be no sound left. Drag the handles apart, or type the times into the Start and End boxes.');
      return;
    }

    // Recording needs nothing but MediaRecorder — only this step needs
    // WebCodecs — so the check waits until now instead of turning away a
    // browser that could have recorded perfectly well.
    if (!requireWebCodecs(fallbackHost)) {
      saveBtn.remove();
      offerRawDownload();
      return;
    }

    saveBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Getting ready…');

    try {
      const containerId = formatSel.value;
      // The LAME encoder is a separate ~200 KB download, fetched the first time
      // somebody actually asks for an MP3.
      if (containerId === 'mp3') await ensureMp3Encoder();

      const channels = channelCount();
      const codec = await pickAudioCodec(containerId, {
        numberOfChannels: channels,
        sampleRate: probe?.audio?.sampleRate,
      });

      const audio = { codec };
      // Only pin the channel count when downmixing is what was asked for —
      // otherwise the recording keeps whatever layout the microphone gave it.
      if (monoBox.checked) audio.numberOfChannels = 1;
      if (containerId !== 'wav') {
        audio.quality = quality(chosenBitrate());
        // Saving an Opus recording into an OGG would otherwise copy the stream
        // straight through, quietly ignoring both the Quality and the Mono
        // choice — which are the whole point of this step.
        audio.forceTranscode = true;
      }

      const result = await convertMedia({
        file: recorded,
        container: containerId,
        audio,
        trim: { start, end },
        onProgress: (fraction, processedSeconds) => {
          job.update(fraction, fraction > 0
            ? `${Math.round(fraction * 100)}% · ${formatDuration(processedSeconds)} of ${formatDuration(length)}`
            : 'Saving…');
        },
        signal,
      });

      job.stop();
      showResult(result, length, performance.now() - started);
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Save canceled');
      else errorBox(panel, err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  function showResult({ blob, ext, mime, warnings }, length, elapsedMs) {
    const name = `${stem(recorded.name)}.${ext}`;
    outPreview = mediaPreview(new File([blob], name, { type: mime }), { kind: 'audio' });
    const trimmed = length < duration - 0.2;

    resultsHost.appendChild(resultCard({
      heading: '✅ Saved',
      message: trimmed
        ? `Kept ${formatDuration(length)} of the ${formatDuration(duration)} you recorded — the rest is gone from the file.`
        : 'The whole recording, ready to hand in or send.',
      stats: [
        [formatDuration(length), 'Length'],
        [formatBytes(blob.size), 'Size'],
        [CONTAINERS[formatSel.value].label, 'Format'],
        [`${(elapsedMs / 1000).toFixed(1)}s`, 'Took'],
      ],
      outputs: [{ name, blob }],
      warnings,
      preview: outPreview.node,
    }));
  }

  /**
   * Leaving for another tool must let the microphone go. Without this the
   * recorder keeps running on a page nobody is looking at, and the browser's
   * recording indicator stays lit over every other tab.
   */
  function cleanup() {
    clearInterval(ticker);
    ticker = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.removeEventListener('stop', finish);
      try { recorder.stop(); } catch { /* nothing left to flush */ }
    }
    recorder = null;
    chunks = [];
    releaseMic();
    unlink?.();
    unlink = null;
    preview?.destroy();
    preview = null;
    outPreview?.destroy();
    outPreview = null;
    navigator.mediaDevices.removeEventListener?.('devicechange', refreshMics);
  }
  window.addEventListener('hashchange', cleanup, { once: true });

  panel.appendChild(job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Rehearsing a presentation? Record it once, then listen back at the
    part where you sped up — that is the bit that needs another run, not the whole
    script. Nothing here is uploaded: the recording stays on this device.</p>
  `));
}
