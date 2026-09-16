import { el, formatBytes, stem, toast } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, numberField, optionPanel, segmented,
  selectField, sliderField,
} from '../option-ui.js';
import {
  breathe, buffersFrom, channelData, decodeAudio, detectSilences, drawWaveform,
  encodeBuffer, encodeWav, eqChain, humNotches, renderGraph, rmsDb,
  spectralDenoise, suggestSilenceThreshold, waveformPeaks,
} from '../audio-fx.js';

// The manual, controllable cousin of Enhance Voice: one job — take the steady
// background sound out — with the controls exposed. The cleaner has to learn
// what "the noise" sounds like before it can subtract it, and this tool lets
// you choose its teacher: the quiet gaps it finds on its own, a section you
// mark by hand, or (experimentally) a small neural network that needs no
// teaching at all.

const FORMATS = {
  mp3: { label: 'MP3' },
  m4a: { label: 'M4A' },
  wav: { label: 'WAV' },
};

const ORIGINAL_COLOR = 'rgba(122,128,154,0.8)';
const PREVIEW_SECONDS = 20;
const PREVIEW_LABEL = 'Preview the first 20 seconds';

// RNNoise operates on exactly this geometry — 48 kHz mono, 480-sample frames —
// and its samples in the 16-bit range. Both constants are the model's, not ours.
const RNNOISE_RATE = 48000;
const RNNOISE_FRAME = 480;
const RNNOISE_SCALE = 32768;

export default function render(container, tool) {
  const state = {
    file: null, buffer: null, decoding: false,
    peaks: null,          // cached waveform buckets — redrawn on every overlay change
    silences: [],         // the detected quiet regions, drawn over the waveform
    quietest: null, noiseFloorDb: null,
  };
  const ui = {};
  const urls = { before: null, after: null };
  let waveUI = null;
  let previewCtl = null;
  let shellCtx = null;

  shellCtx = toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: false,
    pickLabel: 'Select an audio file',
    dropLabel: 'or drop a recording here',
    actionLabel: 'Remove noise',
    doneTitle: 'Noise removed!',
    downloadLabel: 'Download cleaned audio',
    continueTo: ['enhance-voice', 'normalize-audio', 'trim-audio'],
    note: 'Steady sound is what this removes — fans, aircon hiss, mains buzz, the '
      + 'sound of the room itself. It works by learning that sound and subtracting '
      + 'it, so a motorbike that passes through one sentence is part of the sentence '
      + 'now. Your recording never leaves this device.',

    workarea(host) {
      if (!waveUI) buildWorkarea();
      if (waveUI.root.parentElement !== host) {
        host.innerHTML = '';
        host.appendChild(waveUI.root);
      }
    },

    async onFiles(ctx) {
      previewCtl?.abort();
      previewCtl = null;
      state.file = ctx.files[0] ?? null;
      state.buffer = null;
      state.peaks = null;
      state.silences = [];
      state.quietest = null;
      state.noiseFloorDb = null;
      resetWorkarea();
      paintFacts();
      if (!state.file) return;

      state.decoding = true;
      ctx.refresh();
      waveUI.status.textContent = 'Reading the recording…';
      waveUI.status.hidden = false;
      try {
        const buffer = await decodeAudio(state.file);
        state.buffer = buffer;
        state.peaks = waveformPeaks(buffer, 720);
        // The quiet regions serve two jobs: they are drawn over the waveform so
        // "quiet moments (auto)" is something you can see, and the quietest one
        // is where the done screen measures its before/after noise floor.
        state.silences = detectSilences(buffer, { thresholdDb: suggestSilenceThreshold(buffer), minLen: 0.4 });
        state.quietest = await pickQuietest(buffer, state.silences);
        state.noiseFloorDb = state.quietest ? regionRms(buffer, state.quietest) : null;
        ui.regionStart.setMax(Math.max(0.1, buffer.duration));
        ui.regionEnd.setMax(Math.max(0.1, buffer.duration));
        ui.regionStart.value = 0;
        ui.regionEnd.value = Math.min(2, buffer.duration);
        drawBeforeWave();
        setBeforeAudio();
        ui.longNote?.hide(buffer.duration <= 30 * 60);
        paintFacts();
        updateExplain();
      } finally {
        state.decoding = false;
        waveUI.status.hidden = true;
      }
    },

    options(host, ctx) {
      shellCtx = ctx;
      const panel = optionPanel('Remove noise');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.strength = sliderField('Strength', {
        value: 70, min: 0, max: 100, suffix: '%',
        onChange: () => updateExplain(),
      });

      // ---- the experimental neural path ----
      ui.neural = checkRow('Neural voice mode (experimental)', {
        hint: 'Runs the RNNoise neural network instead of the spectral cleaner — 112 KB, bundled with UniLab, nothing fetched from a third party. Trained on voices; the Strength slider sets how much of its output you take.',
        onChange: () => { syncVisibility(); drawBeforeWave(); updateExplain(); },
      });

      // ---- where the standard cleaner learns the noise ----
      ui.learn = segmented(
        [{ id: 'auto', label: 'Quiet moments (auto)' }, { id: 'manual', label: 'A section I mark' }],
        () => { syncVisibility(); drawBeforeWave(); updateExplain(); },
      );
      ui.learnWrap = el(`<div class="opt__field"><span class="opt__label">Learn the noise from</span></div>`);
      ui.learnWrap.appendChild(ui.learn.root);

      ui.regionStart = numberField('Noise starts at', {
        value: 0, min: 0, max: 9999, step: 0.1, suffix: 's',
        onChange: () => { drawBeforeWave(); updateExplain(); },
      });
      ui.regionEnd = numberField('and ends at', {
        value: 2, min: 0, max: 9999, step: 0.1, suffix: 's',
        onChange: () => { drawBeforeWave(); updateExplain(); },
      });
      ui.regionRow = el(`<div class="opt__row"></div>`);
      ui.regionRow.append(ui.regionStart.root, ui.regionEnd.root);
      ui.regionInfo = infoBox('Play the recording and find a second or two where ONLY the background noise is audible — no voice, no clicks. Mark its start and end here and the cleaner learns exactly that sound.');

      // ---- the fixed filters ----
      ui.hum = segmented(
        [{ id: '50', label: '50 Hz' }, { id: '60', label: '60 Hz' }, { id: 'off', label: 'Off' }],
        () => updateExplain(),
      );
      ui.humWrap = el(`<div class="opt__field"><span class="opt__label">Mains hum filter</span></div>`);
      ui.humWrap.appendChild(ui.hum.root);
      ui.humWrap.appendChild(el(`<p class="opt__hint">Electrical buzz hums at the mains frequency: 50 Hz in Thailand and Myanmar, 60 Hz in the Americas.</p>`));
      ui.rumble = checkRow('Rumble filter (below 80 Hz)', {
        checked: true,
        hint: 'Cuts desk thumps, footsteps and traffic rumble under the voice.',
        onChange: () => updateExplain(),
      });

      // ---- preview ----
      ui.previewBtn = el(`<button class="btn secondary" type="button" style="width:100%"></button>`);
      ui.previewBtn.textContent = PREVIEW_LABEL;
      ui.previewBtn.addEventListener('click', () => {
        if (previewCtl) previewCtl.abort();
        else runPreview();
      });
      const previewWrap = el(`<div class="opt__field"></div>`);
      previewWrap.appendChild(ui.previewBtn);
      previewWrap.appendChild(el(`<p class="opt__hint">Runs the same clean-up on just the first ${PREVIEW_SECONDS} seconds, so you hear the effect before committing the whole file.</p>`));

      // ---- export ----
      ui.format = selectField('Save as', [
        { id: 'mp3', label: 'MP3 — 128 kbps, plays everywhere' },
        { id: 'm4a', label: 'M4A — same quality, a little smaller' },
        { id: 'wav', label: 'WAV — uncompressed, big' },
      ], { value: 'mp3', onChange: () => { syncVisibility(); updateExplain(); } });
      ui.mp3Note = infoBox('The MP3 encoder is a separate ~200 KB download, fetched the first time you save an MP3. The audio itself still never leaves your device.');
      ui.longNote = infoBox('This recording is over 30 minutes, so the full clean-up takes a couple of minutes. Try the 20-second preview first to check the settings.');
      ui.longNote.hide(true);

      panel.add(
        ui.facts,
        ui.strength,
        ui.neural,
        ui.learnWrap, ui.regionRow, ui.regionInfo,
        ui.humWrap, ui.rumble,
        previewWrap,
        ui.format, ui.mp3Note, ui.longNote,
        ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      updateExplain();
      return {};
    },

    async run(ctx) {
      if (state.decoding) throw new Error('The recording is still being read — give it a second and press the button again.');
      if (!state.buffer) throw new Error('That file could not be read as audio. Pick an MP3, M4A, WAV or OGG recording and try again.');
      previewCtl?.abort();

      const buffer = state.buffer;
      const cfg = readConfig(buffer.duration);
      const base = stem(state.file.name);
      const beforeDb = state.quietest ? regionRms(buffer, state.quietest) : null;

      const processed = await runPipeline(buffer, cfg, {
        signal: ctx.signal,
        progress: (f, text) => ctx.setBusy(f, text),
      });
      if (ctx.signal?.aborted) throw new Error('canceled');

      // Same seconds, same maths, on the cleaned audio — the only kind of
      // number the done screen is allowed to show.
      const afterDb = state.quietest ? regionRms(processed, state.quietest) : null;

      ctx.setBusy(0.78, 'Drawing the result…');
      await breathe();
      drawAfterWave(processed);

      const fmt = FORMATS[cfg.format];
      ctx.setBusy(0.8, `Saving as ${fmt.label}…`);
      const { blob, ext } = await encodeBuffer(processed, {
        format: cfg.format, kbps: 128, name: base,
        onProgress: (f) => ctx.setBusy(0.8 + Math.min(1, f) * 0.19, `Saving as ${fmt.label}…`),
        signal: ctx.signal,
      });
      setAfterAudio(blob, 'After');

      const drop = beforeDb !== null && afterDb !== null ? beforeDb - afterDb : null;
      const how = cfg.neural ? 'Noise removed with the neural model' : 'Noise removed';
      return {
        outputs: [{ name: `${base}-cleaned.${ext}`, blob }],
        doneTitle: drop !== null && drop >= 1
          ? `${how} — background noise down ${Math.round(drop)} dB.`
          : `${how} — play the After strip to compare.`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // The pipeline — filters first so the cleaner never wastes its learning on
  // hum we can notch out exactly, then the cleaner itself. Shared between the
  // preview and the full run so the preview never lies. Progress lands in
  // 0..0.76; the caller owns the rest of the bar.
  // -------------------------------------------------------------------------

  async function runPipeline(input, cfg, { signal, progress }) {
    const aborted = () => { if (signal?.aborted) throw new Error('canceled'); };
    let buf = input;
    aborted();

    if (cfg.rumble || cfg.hum !== 'off') {
      progress(0.05, 'Cutting rumble and hum…');
      const bands = [];
      if (cfg.rumble) bands.push({ type: 'highpass', frequency: 80, Q: 0.7 });
      if (cfg.hum !== 'off') bands.push(...humNotches(Number(cfg.hum)));
      buf = await renderGraph(buf, (actx, src) => eqChain(actx, src, bands));
    }
    aborted();

    if (cfg.neural) {
      progress(0.09, 'Loading the neural model…');
      buf = await neuralDenoise(buf, {
        strength: cfg.strength / 100,
        signal,
        onProgress: (p) => progress(0.12 + p * 0.62, 'Neural clean-up…'),
      });
    } else {
      buf = await spectralDenoise(buf, {
        strength: cfg.strength / 100,
        noiseRegion: cfg.noiseRegion,
        signal,
        onProgress: (p) => progress(0.1 + p * 0.64, 'Removing background noise…'),
      });
    }
    aborted();
    progress(0.76, 'Nearly done…');
    return buf;
  }

  async function runPreview() {
    if (state.decoding) { toast('The recording is still being read — one second'); return; }
    if (!state.buffer) { toast('Pick a recording first'); return; }
    const ctl = new AbortController();
    previewCtl = ctl;
    const sr = state.buffer.sampleRate;
    const previewLen = Math.min(state.buffer.duration, PREVIEW_SECONDS);
    let cfg;
    try {
      // Validate against the full duration — the marked region can be anywhere
      // in the file even when the preview only plays the start of it.
      cfg = readConfig(state.buffer.duration);
    } catch (err) {
      previewCtl = null;
      shellCtx.error(err.message);
      return;
    }
    // A marked noise section that lies beyond the preview window cannot teach a
    // preview anything — fall back to auto for the preview only, and say so.
    if (cfg.noiseRegion && cfg.noiseRegion.end > previewLen) {
      cfg.noiseRegion = null;
      toast('Your marked section is after the preview window, so the preview learns from quiet moments — the full run uses your section');
    }
    const n = Math.min(state.buffer.length, Math.floor(sr * PREVIEW_SECONDS));
    try {
      const channels = [];
      for (const ch of channelData(state.buffer)) {
        channels.push(ch.slice(0, n));
        await breathe();
      }
      const slice = buffersFrom(channels, sr);
      const processed = await runPipeline(slice, cfg, {
        signal: ctl.signal,
        progress: (f) => {
          ui.previewBtn.textContent = `Previewing… ${Math.min(99, Math.round((f / 0.76) * 100))}% — press to cancel`;
        },
      });
      if (ctl.signal.aborted) return;
      drawAfterWave(processed);
      setAfterAudio(encodeWav(processed),
        state.buffer.duration > PREVIEW_SECONDS + 0.5 ? `After — first ${PREVIEW_SECONDS} seconds only` : 'After');
      toast('Preview ready — press play on the After player');
    } catch (err) {
      if (err?.name !== 'AbortError' && !/cancel/i.test(err?.message ?? '')) shellCtx.error(err.message);
    } finally {
      if (previewCtl === ctl) previewCtl = null;
      // Reset the label unless a newer preview is already writing its own.
      if (previewCtl === null) ui.previewBtn.textContent = PREVIEW_LABEL;
    }
  }

  // -------------------------------------------------------------------------
  // RNNoise — the optional neural path. The model and its runtime ship inside
  // UniLab's own bundle (a 112 KB wasm asset on this origin); nothing is
  // fetched from a CDN, so the privacy promise holds unchanged.
  // -------------------------------------------------------------------------

  let rnnoisePromise = null;

  function loadRnnoise() {
    if (!rnnoisePromise) {
      rnnoisePromise = (async () => {
        const [{ default: createModule }, wasmUrl] = await Promise.all([
          import('@jitsi/rnnoise-wasm/dist/rnnoise.js'),
          import('@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url').then((m) => m.default),
        ]);
        const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
        return createModule({ wasmBinary });
      })();
      // A failed load (offline before the asset was cached, say) must not poison
      // every later attempt.
      rnnoisePromise.catch(() => { rnnoisePromise = null; });
    }
    return rnnoisePromise;
  }

  /**
   * Run every channel through its own RNNoise state, 480 samples at a time.
   * The model wants 48 kHz; decodeAudio already lands there, but resample via
   * an OfflineAudioContext if a buffer ever arrives at another rate. `strength`
   * blends the model's output with the original, because RNNoise itself has no
   * strength knob — it is all or nothing per frame.
   */
  async function neuralDenoise(buffer, { strength, signal, onProgress }) {
    let mod;
    try {
      mod = await loadRnnoise();
    } catch {
      throw new Error('The neural model could not be loaded. Untick "Neural voice mode" to use the standard cleaner.');
    }
    let work = buffer;
    if (work.sampleRate !== RNNOISE_RATE) {
      const actx = new OfflineAudioContext(work.numberOfChannels, Math.ceil(work.duration * RNNOISE_RATE), RNNOISE_RATE);
      const src = actx.createBufferSource();
      src.buffer = work;
      src.connect(actx.destination);
      src.start();
      work = await actx.startRendering();
    }

    const inPtr = mod._malloc(RNNOISE_FRAME * 4);
    const outPtr = mod._malloc(RNNOISE_FRAME * 4);
    const channels = [];
    try {
      for (let c = 0; c < work.numberOfChannels; c++) {
        const x = work.getChannelData(c);
        const out = new Float32Array(x.length);
        const rnState = mod._rnnoise_create(0);
        if (!rnState) throw new Error('The neural model could not start. Untick "Neural voice mode" to use the standard cleaner.');
        try {
          const frame = new Float32Array(RNNOISE_FRAME);
          const frames = Math.ceil(x.length / RNNOISE_FRAME);
          for (let f = 0; f < frames; f++) {
            if (signal?.aborted) throw new Error('canceled');
            const off = f * RNNOISE_FRAME;
            for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = (x[off + i] ?? 0) * RNNOISE_SCALE;
            // mod.HEAPF32 is re-read on every use: the view is replaced whenever
            // the wasm memory grows, and a stale one goes silently dead.
            mod.HEAPF32.set(frame, inPtr >> 2);
            mod._rnnoise_process_frame(rnState, outPtr, inPtr);
            const res = mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + RNNOISE_FRAME);
            const valid = Math.min(RNNOISE_FRAME, x.length - off);
            for (let i = 0; i < valid; i++) {
              out[off + i] = (res[i] / RNNOISE_SCALE) * strength + x[off + i] * (1 - strength);
            }
            if ((f & 127) === 0) {
              onProgress?.((c + f / frames) / work.numberOfChannels);
              await breathe();
            }
          }
        } finally {
          mod._rnnoise_destroy(rnState);
        }
        channels.push(out);
      }
    } finally {
      mod._free(inPtr);
      mod._free(outPtr);
    }
    return buffersFrom(channels, RNNOISE_RATE);
  }

  // -------------------------------------------------------------------------
  // Workarea — the original waveform with the cleaner's homework drawn on it:
  // shaded stripes over the quiet moments (or the marked section), so "learn
  // from quiet moments" is something you can point at rather than magic.
  // -------------------------------------------------------------------------

  function buildWorkarea() {
    waveUI = {};
    waveUI.root = el(`
      <div style="max-width:780px">
        <p class="ts__hint" data-status hidden></p>
        <div data-before hidden>
          <span class="opt__label">Before</span>
          <canvas width="720" height="88" style="width:100%;height:88px;display:block;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--card)"></canvas>
          <p class="ts__hint" data-overlayhint style="margin-top:6px"></p>
          <audio class="media-el" controls style="margin-top:8px"></audio>
        </div>
        <div data-after hidden style="margin-top:22px">
          <span class="opt__label" data-afterlabel>After</span>
          <canvas width="720" height="88" style="width:100%;height:88px;display:block;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--card)"></canvas>
          <audio class="media-el" controls></audio>
        </div>
        <p class="ts__hint" style="margin-top:14px">Grey is your recording as it is. The coloured strip appears underneath once it has been cleaned — play both and compare.</p>
      </div>
    `);
    waveUI.status = waveUI.root.querySelector('[data-status]');
    waveUI.before = waveUI.root.querySelector('[data-before]');
    waveUI.after = waveUI.root.querySelector('[data-after]');
    waveUI.afterLabel = waveUI.root.querySelector('[data-afterlabel]');
    waveUI.overlayHint = waveUI.root.querySelector('[data-overlayhint]');
    [waveUI.beforeCanvas, waveUI.afterCanvas] = waveUI.root.querySelectorAll('canvas');
    [waveUI.beforeAudio, waveUI.afterAudio] = waveUI.root.querySelectorAll('audio');

    // The Before player carries the original file itself — no copy, which
    // matters on an hour-long lecture. If this browser can decode it but not
    // play it (rare), fall back to a WAV built from the decoded samples.
    waveUI.beforeAudio.addEventListener('error', () => {
      if (waveUI.beforeFellBack || !state.buffer) return;
      waveUI.beforeFellBack = true;
      waveUI.beforeAudio.src = setUrl('before', encodeWav(state.buffer));
    });
  }

  function resetWorkarea() {
    if (!waveUI) return;
    waveUI.beforeFellBack = false;
    waveUI.before.hidden = true;
    waveUI.after.hidden = true;
    for (const a of [waveUI.beforeAudio, waveUI.afterAudio]) {
      a.pause();
      a.removeAttribute('src');
    }
  }

  function setUrl(which, blob) {
    if (urls[which]) URL.revokeObjectURL(urls[which]);
    urls[which] = URL.createObjectURL(blob);
    return urls[which];
  }

  function currentMode() {
    if (ui.neural?.value) return 'neural';
    return ui.learn?.value === 'manual' ? 'manual' : 'auto';
  }

  function drawBeforeWave() {
    if (!waveUI || !state.buffer || !state.peaks) return;
    const canvas = waveUI.beforeCanvas;
    drawWaveform(canvas, state.peaks, { color: ORIGINAL_COLOR });

    const g = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const dur = state.buffer.duration;
    const mode = currentMode();
    g.save();
    g.fillStyle = accentColor();
    g.globalAlpha = 0.16;
    if (mode === 'auto') {
      for (const r of state.silences) {
        g.fillRect((r.start / dur) * w, 0, Math.max(2, ((r.end - r.start) / dur) * w), h);
      }
    } else if (mode === 'manual') {
      const s = ui.regionStart.value, e = ui.regionEnd.value;
      if (e > s) g.fillRect((s / dur) * w, 0, Math.max(2, ((e - s) / dur) * w), h);
    }
    g.restore();

    waveUI.overlayHint.textContent =
      mode === 'neural' ? 'The neural network decides what is voice frame by frame — nothing needs marking.'
        : mode === 'manual' ? 'The shaded stripe is the section the cleaner will learn the background sound from.'
          : state.silences.length ? 'Shaded stripes are the quiet moments the cleaner found — it learns the background sound from these.'
            : 'No clearly quiet stretch was found, so the cleaner will fall back on the quietest tenth of the recording. Marking a noise-only section yourself may work better.';
    waveUI.before.hidden = false;
  }

  function setBeforeAudio() {
    waveUI.beforeAudio.src = setUrl('before', state.file);
  }

  function drawAfterWave(buffer) {
    drawWaveform(waveUI.afterCanvas, waveformPeaks(buffer, 720), { color: accentColor() });
    waveUI.after.hidden = false;
  }

  function setAfterAudio(blob, label) {
    waveUI.afterAudio.pause();
    waveUI.afterAudio.src = setUrl('after', blob);
    waveUI.afterLabel.textContent = label;
    waveUI.after.hidden = false;
  }

  /** The audio category colour, resolved to a real value the canvas can use. */
  function accentColor() {
    const v = getComputedStyle(waveUI.beforeCanvas).getPropertyValue('--cc').trim();
    return v || '#0e9bb5';
  }

  // -------------------------------------------------------------------------
  // Measurement helpers
  // -------------------------------------------------------------------------

  /**
   * RMS of just one region, without letting rmsDb copy the whole file to mono
   * first — on an hour-long lecture that copy would cost more than the measure.
   */
  function regionRms(buffer, region) {
    const sr = buffer.sampleRate;
    const i0 = Math.max(0, Math.floor(region.start * sr));
    const i1 = Math.min(buffer.length, Math.floor(region.end * sr));
    if (i1 - i0 < 16) return null;
    const slice = buffersFrom(channelData(buffer).map((ch) => ch.subarray(i0, i1)), sr);
    return rmsDb(slice);
  }

  /** The quietest detected silence — the honest stand-in for "just the room". */
  async function pickQuietest(buffer, silences) {
    let best = null, bestDb = Infinity;
    for (const region of silences) {
      const db = regionRms(buffer, region);
      if (db !== null && db < bestDb) { bestDb = db; best = region; }
      await breathe();
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Sidebar state
  // -------------------------------------------------------------------------

  /** Reads the sidebar into one config object. Throws plain sentences. */
  function readConfig(duration) {
    const cfg = {
      strength: ui.strength.value,
      neural: ui.neural.value,
      hum: ui.hum.value,
      rumble: ui.rumble.value,
      format: ui.format.value,
      noiseRegion: null,
    };
    if (!cfg.neural && ui.learn.value === 'manual') {
      const start = Math.max(0, Math.min(ui.regionStart.value, duration));
      const end = Math.max(0, Math.min(ui.regionEnd.value, duration));
      if (end - start < 0.25) {
        throw new Error('The marked noise section is too short. Give the cleaner at least a quarter of a second where only the background noise is audible.');
      }
      cfg.noiseRegion = { start, end };
    }
    return cfg;
  }

  function syncVisibility() {
    const neural = ui.neural.value;
    const manual = !neural && ui.learn.value === 'manual';
    ui.learnWrap.hidden = neural;
    ui.regionRow.hidden = !manual;
    ui.regionInfo.hide(!manual);
    ui.mp3Note.hide(ui.format.value !== 'mp3');
  }

  function paintFacts() {
    if (!ui.facts) return;
    if (!state.buffer || !state.file) { ui.facts.set([]); return; }
    const b = state.buffer;
    const rows = [
      ['Length', formatDuration(b.duration)],
      ['File size', formatBytes(state.file.size)],
      ['Quiet moments found', String(state.silences.length)],
    ];
    if (state.noiseFloorDb !== null) rows.push(['Noise floor', `${state.noiseFloorDb.toFixed(0)} dBFS`]);
    ui.facts.set(rows);
  }

  function updateExplain() {
    if (!ui.explain) return;
    const strength = ui.strength.value;
    const mode = currentMode();
    const parts = [];
    if (mode === 'neural') {
      parts.push(`background noise reduced by the RNNoise neural network at a ${strength}% blend`);
    } else if (mode === 'manual') {
      const s = ui.regionStart.value, e = ui.regionEnd.value;
      parts.push(`background noise reduced at ${strength}% strength, learned from the section you marked (${s}–${e} s)`);
    } else {
      parts.push(`background noise reduced at ${strength}% strength, learned from the quiet moments between sentences`);
    }
    if (ui.hum.value !== 'off') parts.push(`${ui.hum.value} Hz mains hum notched out`);
    if (ui.rumble.value) parts.push('rumble filtered below 80 Hz');
    const sentence = parts.join(', ');
    ui.explain.set(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} — as ${FORMATS[ui.format.value].label}.`);
  }

  // Leaving the tool lets go of the audio: stop the preview job, silence the
  // players, and release both object URLs.
  window.addEventListener('hashchange', () => {
    previewCtl?.abort();
    if (waveUI) {
      for (const a of [waveUI.beforeAudio, waveUI.afterAudio]) {
        a.pause();
        a.removeAttribute('src');
      }
    }
    for (const k of Object.keys(urls)) {
      if (urls[k]) { URL.revokeObjectURL(urls[k]); urls[k] = null; }
    }
  }, { once: true });
}
