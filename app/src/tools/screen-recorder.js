import { el, errorBox, formatBytes, toast } from '../ui.js';
import {
  convertMedia, evenSize, formatDuration, isCanceled, pickAudioCodec,
  pickVideoCodec, quality, requireWebCodecs,
} from '../media-utils.js';
import { jobProgress, mediaPreview, resultCard } from '../media-ui.js';

// The height is only a hint — the browser decides what it can really capture,
// and sharing a small window records at that window's size. The bitrate is what
// actually decides the file size: an hour at 1.5 Mbps lands around 650 MB,
// which is why the "long recording" preset drops the frame rate too. Slides and
// documents look fine at 15 fps; only video playback and cursor animation don't.
const QUALITIES = [
  { label: '1080p · 30 fps — sharpest text', height: 1080, frameRate: 30, bitrate: 6_000_000 },
  { label: '720p · 30 fps — good for hand-ins', height: 720, frameRate: 30, bitrate: 3_000_000 },
  { label: '720p · 15 fps — smallest, for long recordings', height: 720, frameRate: 15, bitrate: 1_500_000 },
];

// MP4 first: Safari and newer Chrome can record it directly, which skips the
// conversion step entirely. Everything else lands on WebM.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

const MIC_BITRATE = 128_000;

// What the empty stage says before anything has been captured. It is swapped
// for a "your recording is below" line once there is one, and swapped back when
// the next recording starts.
const IDLE_PLACEHOLDER = 'Nothing recorded yet — press Start recording and pick the screen, window or tab you want to show.';

/** A filename you can still identify a week later, in the phone's own timezone. */
function recordingName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `screen-recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export default function render(container) {
  // iOS Safari has no getDisplayMedia and never will — a web page can't reach
  // the iPhone's screen. There's no partial version of this tool to offer, so
  // point at the thing that does work instead of showing a dead button.
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    container.appendChild(el(`
      <div class="panel media-unsupported">
        <h3>This browser can't record the screen</h3>
        <p>On an iPhone or iPad, only the phone itself is allowed to record the screen.
           Open <b>Settings → Control Centre</b>, add <b>Screen Recording</b>, then swipe
           down and tap the record button — press and hold it first if you want your voice
           in the recording too.</p>
        <p>Once it's saved in Photos, come back here: <b>Trim Video</b> cuts off the start
           and end, and <b>Compress Video</b> gets it under your LMS limit. On a laptop,
           Chrome, Edge and Firefox can all record straight from this page.</p>
      </div>
    `));
    return;
  }

  const panel = el(`
    <div class="panel">
      <div class="rec-stage">
        <div class="placeholder" data-placeholder>Nothing recorded yet — press <b>Start recording</b>
          and pick the screen, window or tab you want to show.</div>
      </div>
      <div class="controls" data-options>
        <div class="field">
          <label>Record</label>
          <select data-source>
            <option value="mic" selected>Screen + microphone</option>
            <option value="screen">Screen only</option>
          </select>
        </div>
        <div class="field">
          <label>Quality</label>
          <select data-quality></select>
        </div>
      </div>
      <p class="note" data-privacy>The recording is held in this tab's memory and never
        uploaded. It only becomes a file on your device when you press Download.</p>
      <div class="actions" data-idleactions>
        <button class="btn" data-start>Start recording</button>
      </div>
      <div class="rec-status" hidden data-status>
        <span class="rec-dot"></span>
        <span data-time>0:00</span>
        <span data-size>0 B</span>
        <button class="btn secondary small" data-stop style="margin-left:auto">Stop recording</button>
      </div>
      <p class="note" hidden data-hint></p>
    </div>
  `);

  const stage = panel.querySelector('.rec-stage');
  const placeholder = panel.querySelector('[data-placeholder]');
  const options = panel.querySelector('[data-options]');
  const sourceSel = panel.querySelector('[data-source]');
  const qualitySel = panel.querySelector('[data-quality]');
  const idleActions = panel.querySelector('[data-idleactions]');
  const startBtn = panel.querySelector('[data-start]');
  const status = panel.querySelector('[data-status]');
  const stopBtn = panel.querySelector('[data-stop]');
  const timeOut = panel.querySelector('[data-time]');
  const sizeOut = panel.querySelector('[data-size]');
  const hint = panel.querySelector('[data-hint]');
  const resultsHost = el(`<div></div>`);
  const job = jobProgress({ cancelLabel: 'Cancel' });

  QUALITIES.forEach((q, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = q.label;
    if (i === 1) o.selected = true;
    qualitySel.appendChild(o);
  });

  let recorder = null;
  let chunks = [];
  let bytes = 0;
  let displayStream = null;
  let micStream = null;
  let mixedTrack = null;
  let audioCtx = null;
  let liveVideo = null;
  let ticker = null;
  let startedAt = 0;
  let elapsed = 0;
  let recordedAudio = false;
  let capture = { width: 0, height: 0, bitrate: QUALITIES[1].bitrate };
  let previews = [];

  function showHint(text) {
    hint.textContent = text;
    hint.hidden = false;
  }

  function destroyPreviews() {
    previews.forEach((p) => p.destroy());
    previews = [];
  }

  /**
   * Hands the screen back. Until every track is stopped the browser keeps its
   * "you are sharing your screen" bar up, which students read as "it's still
   * recording me" — so this runs the moment the data is safely in hand.
   */
  function releaseCapture() {
    for (const stream of [displayStream, micStream]) stream?.getTracks().forEach((t) => t.stop());
    mixedTrack?.stop();
    displayStream = null;
    micStream = null;
    mixedTrack = null;
    audioCtx?.close().catch(() => { /* already closed */ });
    audioCtx = null;
    if (liveVideo) {
      liveVideo.srcObject = null;
      liveVideo.remove();
      liveVideo = null;
    }
  }

  function setPhase(phase) {
    const recording = phase === 'recording';
    placeholder.hidden = recording;
    status.hidden = !recording;
    idleActions.hidden = recording;
    sourceSel.disabled = recording;
    qualitySel.disabled = recording;
    startBtn.disabled = false;
    stopBtn.disabled = false;
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stopRecording);

  async function start() {
    errorBox(panel, null);
    hint.hidden = true;
    resultsHost.innerHTML = '';
    destroyPreviews();
    placeholder.textContent = IDLE_PLACEHOLDER;
    startBtn.disabled = true;

    const q = QUALITIES[Number(qualitySel.value)];
    const wantMic = sourceSel.value === 'mic';

    try {
      // Asking for audio here is what makes Chrome offer the "share tab audio"
      // switch. The user can still leave it off — and usually does.
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: q.frameRate }, height: { ideal: q.height } },
        audio: true,
      });
    } catch (err) {
      startBtn.disabled = false;
      if (err.name === 'NotAllowedError') {
        showHint('Nothing was recorded — screen sharing was canceled. Press "Start recording" again and choose a screen, window or tab.');
      } else {
        errorBox(panel, `The screen picker could not open: ${err.message}`);
      }
      return;
    }

    try {
      if (wantMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch (err) {
          // A blocked or missing mic is not a reason to throw away a screen
          // share the user just granted — record the picture and say so.
          toast(err.name === 'NotAllowedError'
            ? 'Microphone blocked — recording the screen without your voice'
            : 'No microphone found — recording the screen only');
        }
      }

      const videoTrack = displayStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('That share came back without any picture. Try again and pick a screen or a window.');

      const stream = new MediaStream([videoTrack, ...audioTrackFor()]);
      recordedAudio = stream.getAudioTracks().length > 0;

      const settings = videoTrack.getSettings();
      capture = {
        width: settings.width || 0,
        height: settings.height || 0,
        bitrate: q.bitrate,
      };

      const recorderOptions = { videoBitsPerSecond: q.bitrate, audioBitsPerSecond: MIC_BITRATE };
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      if (mimeType) recorderOptions.mimeType = mimeType;
      recorder = new MediaRecorder(stream, recorderOptions);

      chunks = [];
      bytes = 0;
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          bytes += e.data.size;
        }
      });
      recorder.addEventListener('stop', finish);
      recorder.addEventListener('error', (e) => {
        errorBox(panel, `The recording stopped unexpectedly: ${e.error?.message ?? 'unknown error'}. Anything captured up to that point is still below.`);
        stopRecording();
      });

      // Stopping from the browser's own sharing bar is how most people end a
      // recording, and it only shows up as the track ending.
      videoTrack.addEventListener('ended', stopRecording);

      liveVideo = el(`<video playsinline autoplay></video>`);
      liveVideo.muted = true;   // unmuted, the mic would howl through the speakers
      liveVideo.srcObject = stream;
      stage.appendChild(liveVideo);

      // A 1-second timeslice keeps the "size so far" counter honest and means a
      // crashed tab loses at most one second of the recording.
      recorder.start(1000);
      startedAt = Date.now();
      elapsed = 0;
      tick();
      ticker = setInterval(tick, 250);
      setPhase('recording');
      showHint(recordedAudio
        ? 'Recording. Talk normally — the sound is being captured too.'
        : 'Recording without sound. To narrate, choose "Screen + microphone" next time; to catch a video\'s audio, tick "Share tab audio" in the picker.');
    } catch (err) {
      releaseCapture();
      recorder = null;
      startBtn.disabled = false;
      errorBox(panel, `Recording could not start: ${err.message}`);
    }
  }

  /**
   * System audio and the mic are two separate streams, and MediaRecorder only
   * writes one audio track — so they get mixed into one through an AudioContext.
   * With a single source there is nothing to mix, and using its track directly
   * keeps one more moving part out of the recording.
   */
  function audioTrackFor() {
    const sources = [];
    if (displayStream.getAudioTracks().length) sources.push(displayStream);
    if (micStream?.getAudioTracks().length) sources.push(micStream);

    if (!sources.length) return [];
    if (sources.length === 1) return [sources[0].getAudioTracks()[0]];

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // A context that starts suspended produces a silent track without ever
    // erroring — the recording would look fine and have no sound at all.
    audioCtx.resume().catch(() => { /* already running */ });
    const destination = audioCtx.createMediaStreamDestination();
    for (const source of sources) audioCtx.createMediaStreamSource(source).connect(destination);
    mixedTrack = destination.stream.getAudioTracks()[0];
    return [mixedTrack];
  }

  function tick() {
    timeOut.textContent = formatDuration(startedAt ? (Date.now() - startedAt) / 1000 : elapsed);
    sizeOut.textContent = formatBytes(bytes);
  }

  /**
   * Freezes the length of the recording. Safe to call twice, and it has to be:
   * a MediaRecorder that hits an error goes inactive on its own, so the 'stop'
   * event can arrive without `stopRecording` ever having run — and a clock left
   * open would report the recording as "0:00" on the result card.
   */
  function closeClock() {
    if (!startedAt) return;
    elapsed = (Date.now() - startedAt) / 1000;
    startedAt = 0;
  }

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    stopBtn.disabled = true;
    closeClock();
    recorder.stop();
  }

  function finish() {
    clearInterval(ticker);
    ticker = null;
    closeClock();
    // getSettings() reports what was asked for about as often as what was
    // captured, and sharing a window gives that window's size — the preview
    // element is the one thing that knows how big the frames really are.
    if (liveVideo?.videoWidth) {
      capture = { ...capture, width: liveVideo.videoWidth, height: liveVideo.videoHeight };
    }
    const mimeType = recorder?.mimeType || chunks[0]?.type || 'video/webm';
    const blob = new Blob(chunks, { type: mimeType });
    chunks = [];
    recorder = null;
    releaseCapture();
    setPhase('idle');
    startBtn.textContent = 'Record again';

    if (!blob.size) {
      showHint('That recording came back empty — sharing was stopped before anything was captured. Press "Record again" and give it a second before you stop.');
      return;
    }
    hint.hidden = true;
    // The stage is empty again now the share has been handed back, and "nothing
    // recorded yet" sitting above a finished recording reads as a failure.
    placeholder.textContent = 'Your recording is below — play it back before you hand it in.';
    showResult(blob, mimeType);
  }

  function showResult(blob, mimeType) {
    const isMp4 = /mp4/i.test(mimeType);
    const base = recordingName();
    const name = `${base}.${isMp4 ? 'mp4' : 'webm'}`;
    const file = new File([blob], name, { type: blob.type });
    const preview = mediaPreview(file, { kind: 'video' });
    previews.push(preview);

    const card = resultCard({
      heading: '✅ Recording finished',
      message: isMp4
        ? 'MP4 — this opens in PowerPoint, on phones and in Google Drive as it is.'
        : 'This is a WebM file. It plays in any browser, but PowerPoint and most phones will not open it — convert it to MP4 below before you hand it in.',
      stats: [
        [formatDuration(elapsed), 'Length'],
        [capture.width ? `${capture.width}×${capture.height}` : '—', 'Resolution'],
        [formatBytes(blob.size), 'Size'],
        [isMp4 ? 'MP4' : 'WebM', 'Format'],
      ],
      outputs: [{ name, blob }],
      preview: preview.node,
    });
    resultsHost.appendChild(card);

    if (isMp4) return;

    const convertHost = el(`<div></div>`);
    const convertBtn = el(`<button class="btn small">Convert to MP4</button>`);
    card.querySelector('.actions').appendChild(convertBtn);
    card.append(job.root, convertHost);

    convertBtn.addEventListener('click', async () => {
      // Recording itself needs nothing but MediaRecorder, so the WebCodecs check
      // waits until somebody actually asks for the conversion — otherwise a
      // browser that can record perfectly well would be turned away at the door.
      if (!requireWebCodecs(convertHost)) {
        convertBtn.remove();
        return;
      }
      errorBox(convertHost, null);
      convertBtn.disabled = true;
      const signal = job.start('Getting ready…');
      try {
        // Sharing a window hands back whatever size that window happens to be,
        // and half of those are odd numbers — which H.264 will not encode,
        // because it stores colour two pixels at a time. Rounding to even costs
        // at most one row of pixels and is the difference between an MP4 and an
        // encoder error.
        const width = capture.width ? evenSize(capture.width) : 0;
        const height = capture.height ? evenSize(capture.height) : 0;
        const [videoCodec, audioCodec] = await Promise.all([
          pickVideoCodec('mp4', { width, height, bitrate: capture.bitrate }),
          recordedAudio
            ? pickAudioCodec('mp4', { numberOfChannels: 2, sampleRate: 48_000 })
            : Promise.resolve(undefined),
        ]);

        const result = await convertMedia({
          file,
          container: 'mp4',
          video: {
            ...(width && height ? { width, height, fit: 'fill' } : {}),
            codec: videoCodec,
            quality: quality(capture.bitrate),
          },
          audio: recordedAudio
            ? { codec: audioCodec, quality: quality(MIC_BITRATE) }
            : { discard: true },
          onProgress: (fraction) => {
            // A WebM straight out of MediaRecorder often carries no duration, so
            // the progress fraction can be missing for the whole job.
            job.update(fraction, fraction > 0 ? `${Math.round(fraction * 100)}% converted` : 'Converting…');
          },
          signal,
        });

        job.stop();
        const mp4Name = `${base}.${result.ext}`;
        resultsHost.appendChild(resultCard({
          heading: '✅ MP4 ready',
          message: 'Safe to drop into a slide deck, LINE or your LMS.',
          stats: [
            [formatBytes(blob.size), 'WebM'],
            [formatBytes(result.blob.size), 'MP4'],
          ],
          outputs: [{ name: mp4Name, blob: result.blob }],
          warnings: result.warnings,
        }));
        convertBtn.remove();
      } catch (err) {
        job.stop();
        convertBtn.disabled = false;
        if (isCanceled(err)) toast('Conversion canceled');
        else errorBox(convertHost, `Could not make an MP4: ${err.message}`);
      }
    });
  }

  /**
   * Leaving for another tool must release the screen share — the recorder keeps
   * running otherwise, and the browser's sharing bar stays up over every tab.
   */
  function cleanup() {
    clearInterval(ticker);
    ticker = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.removeEventListener('stop', finish);
      try { recorder.stop(); } catch { /* nothing to flush */ }
    }
    recorder = null;
    chunks = [];
    releaseCapture();
    destroyPreviews();
  }
  window.addEventListener('hashchange', cleanup, { once: true });

  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Share the single tab or window you're presenting, not the whole screen —
    the text stays sharper at the same file size, and your notifications stay out of the
    hand-in. If it's still too big for the LMS, run it through Compress Video afterwards.</p>
  `));
}
