import { el, formatBytes, stem, toast } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, segmented, selectField,
  sliderField,
} from '../option-ui.js';
import {
  breathe, buffersFrom, channelData, decodeAudio, detectSilences, drawWaveform,
  encodeBuffer, encodeWav, eqChain, humNotches, normalizeLoudness, renderGraph,
  rmsDb, spectralDenoise, speechCompressor, suggestSilenceThreshold, waveformPeaks,
} from '../audio-fx.js';

// The one-button clean-up: a presentation run-through recorded on a phone in a
// dorm comes out sounding like a quiet room. Five fixed stages, every one of
// them optional, in the order a studio engineer would run them — filter the
// junk out first, then denoise, then shape and level what is left.

// Loudness targets. −16 LUFS is what podcast platforms normalise to, so a file
// set there sounds "professional" next to real podcasts instead of half as loud.
const TARGETS = {
  '-16': { lufs: -16, label: 'Podcast standard (−16 LUFS)', phrase: 'podcast standard' },
  '-14': { lufs: -14, label: 'Louder — social video (−14 LUFS)', phrase: 'social-video loudness' },
  '-19': { lufs: -19, label: 'Quieter — background listening (−19 LUFS)', phrase: 'a quiet background level' },
};

const FORMATS = {
  mp3: { label: 'MP3' },
  m4a: { label: 'M4A' },
  wav: { label: 'WAV' },
};

// The presence EQ: a small lift where consonants live, a small cut where a
// phone on a desk sounds boxy. ±3 dB is deliberately subtle — this is meant to
// be pressed once and trusted, not tuned.
const PRESENCE_BANDS = [
  { type: 'peaking', frequency: 3000, gain: 3, Q: 1 },
  { type: 'peaking', frequency: 350, gain: -3, Q: 1.2 },
];

const ORIGINAL_COLOR = 'rgba(122,128,154,0.8)';
const PREVIEW_SECONDS = 20;
const PREVIEW_LABEL = 'Preview the first 20 seconds';

export default function render(container, tool) {
  const state = {
    file: null, buffer: null, decoding: false,
    // The quietest between-sentence gap of the original, and its level. This is
    // what turns the done screen's "noise down 12 dB" into a measured fact.
    quietest: null, noiseFloorDb: null,
  };
  const ui = {};
  const urls = { before: null, after: null };
  let waveUI = null;      // the before/after canvases and players, built once
  let previewCtl = null;  // AbortController for the 20-second preview
  let shellCtx = null;

  shellCtx = toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: false,
    pickLabel: 'Select an audio file',
    dropLabel: 'or drop a recording here',
    actionLabel: 'Enhance voice',
    doneTitle: 'Voice enhanced!',
    downloadLabel: 'Download enhanced audio',
    continueTo: ['silence-cut', 'audio-speed', 'trim-audio'],
    note: 'This is honest signal processing, not AI reconstruction: steady background '
      + 'sound — the fan, the aircon, the fridge, mains hum — is what it removes. '
      + 'A voice buried under a passing truck stays buried. Your recording never '
      + 'leaves this device.',

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
      state.quietest = null;
      state.noiseFloorDb = null;
      resetWorkarea();
      paintFacts();
      if (!state.file) return;

      // Mount the workarea before the decode so the wait has a face on it.
      state.decoding = true;
      ctx.refresh();
      waveUI.status.textContent = 'Reading the recording…';
      waveUI.status.hidden = false;
      try {
        const buffer = await decodeAudio(state.file);
        state.buffer = buffer;
        // Find the gaps between sentences now, with a threshold suggested from
        // this file's own floor — run() measures the noise drop inside the
        // quietest one, and the facts panel can show the floor immediately.
        const silences = detectSilences(buffer, { thresholdDb: suggestSilenceThreshold(buffer), minLen: 0.4 });
        state.quietest = await pickQuietest(buffer, silences);
        state.noiseFloorDb = state.quietest ? regionRms(buffer, state.quietest) : null;
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
      const panel = optionPanel('Enhance');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      // ---- stage 1: rumble + mains hum ----
      ui.filters = checkRow('Cut rumble and hum', {
        checked: true,
        hint: 'A steep filter below 80 Hz takes out desk thumps and traffic rumble; notches take out electrical buzz.',
        onChange: () => { syncVisibility(); updateExplain(); },
      });
      ui.hum = segmented(
        [{ id: '50', label: '50 Hz' }, { id: '60', label: '60 Hz' }, { id: 'off', label: 'Off' }],
        () => updateExplain(),
      );
      ui.humWrap = el(`<div class="opt__field"><span class="opt__label">Mains hum</span></div>`);
      ui.humWrap.appendChild(ui.hum.root);
      ui.humWrap.appendChild(el(`<p class="opt__hint">Electrical buzz hums at the mains frequency: 50 Hz in Thailand and Myanmar, 60 Hz in the Americas.</p>`));

      // ---- stage 2: spectral denoise ----
      ui.denoise = checkRow('Reduce background noise', {
        checked: true,
        onChange: () => { syncVisibility(); updateExplain(); },
      });
      ui.strength = sliderField('Noise reduction', {
        value: 70, min: 0, max: 100, suffix: '%',
        onChange: () => updateExplain(),
      });

      // ---- stages 3–5 ----
      ui.presence = checkRow('Lift the voice', {
        checked: true,
        hint: 'A gentle EQ: clarity up at 3 kHz, phone-on-a-desk boxiness down at 350 Hz.',
        onChange: () => updateExplain(),
      });
      ui.compress = checkRow('Even out the volume', {
        checked: true,
        hint: 'Quiet sentences come up, sudden peaks come down — the level stays steady.',
        onChange: () => updateExplain(),
      });
      ui.loudness = checkRow('Set the loudness', {
        checked: true,
        onChange: () => { syncVisibility(); updateExplain(); },
      });
      ui.target = selectField('Loudness target',
        Object.entries(TARGETS).map(([id, t]) => ({ id, label: t.label })),
        { value: '-16', onChange: () => updateExplain() });

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
        ui.filters, ui.humWrap,
        ui.denoise, ui.strength,
        ui.presence, ui.compress,
        ui.loudness, ui.target,
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

      const cfg = readConfig();
      const buffer = state.buffer;
      const base = stem(state.file.name);
      const beforeDb = state.quietest ? regionRms(buffer, state.quietest) : null;

      const processed = await runPipeline(buffer, cfg, {
        signal: ctx.signal,
        progress: (f, text) => ctx.setBusy(f, text),
      });
      if (ctx.signal?.aborted) throw new Error('canceled');

      // Measure the same quiet gap in the processed audio. Same seconds, same
      // maths — the only kind of number the done screen is allowed to show.
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
      // The After player gets the very file being handed over — what you
      // audition on the way back is exactly what you downloaded.
      setAfterAudio(blob, 'After');

      const claims = [];
      const drop = beforeDb !== null && afterDb !== null ? beforeDb - afterDb : null;
      if (drop !== null && drop >= 1) claims.push(`background noise down ${Math.round(drop)} dB`);
      if (cfg.loudness) claims.push(`loudness set to ${TARGETS[cfg.targetId].phrase}`);
      return {
        outputs: [{ name: `${base}-enhanced.${ext}`, blob }],
        doneTitle: claims.length
          ? `Voice enhanced — ${claims.join(', ')}.`
          : 'Voice enhanced — play the After strip to judge it.',
      };
    },
  });

  // -------------------------------------------------------------------------
  // The pipeline — one function, run on the full file and on the preview slice,
  // so the preview never lies about what the real run will do. Progress lands
  // in 0..0.76; the caller owns the rest of the bar (waveform + encode).
  // -------------------------------------------------------------------------

  async function runPipeline(input, cfg, { signal, progress }) {
    const aborted = () => { if (signal?.aborted) throw new Error('canceled'); };
    let buf = input;
    aborted();

    if (cfg.filters) {
      progress(0.04, 'Cutting rumble and hum…');
      const bands = [{ type: 'highpass', frequency: 80, Q: 0.7 }];
      if (cfg.hum !== 'off') bands.push(...humNotches(Number(cfg.hum)));
      buf = await renderGraph(buf, (actx, src) => eqChain(actx, src, bands));
    }
    aborted();

    if (cfg.denoise) {
      // The long pole — its own progress runs 0..1, scaled into the middle
      // half of the bar so the bar keeps moving for the whole wait.
      buf = await spectralDenoise(buf, {
        strength: cfg.strength / 100,
        signal,
        onProgress: (p) => progress(0.08 + p * 0.52, 'Removing background noise…'),
      });
    }
    aborted();

    if (cfg.presence || cfg.compress) {
      progress(0.62, cfg.presence ? 'Lifting the voice…' : 'Evening out the volume…');
      buf = await renderGraph(buf, (actx, src) => {
        let node = src;
        if (cfg.presence) node = eqChain(actx, node, PRESENCE_BANDS);
        if (cfg.compress) node = speechCompressor(actx, node);
        return node;
      });
    }
    aborted();

    if (cfg.loudness) {
      progress(0.7, 'Setting the loudness…');
      ({ buffer: buf } = await normalizeLoudness(buf, cfg.target));
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
    const cfg = readConfig();
    const sr = state.buffer.sampleRate;
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
  // Workarea — the original waveform in grey with its player, and the processed
  // one in the audio accent underneath, so "cleaner" is something you can see
  // before you trust your ears with it.
  // -------------------------------------------------------------------------

  function buildWorkarea() {
    waveUI = {};
    waveUI.root = el(`
      <div style="max-width:780px">
        <p class="ts__hint" data-status hidden></p>
        <div data-before hidden>
          <span class="opt__label">Before</span>
          <canvas width="720" height="88" style="width:100%;height:88px;display:block;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--card)"></canvas>
          <audio class="media-el" controls></audio>
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

  function drawBeforeWave() {
    drawWaveform(waveUI.beforeCanvas, waveformPeaks(state.buffer, 720), { color: ORIGINAL_COLOR });
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
    const v = getComputedStyle(waveUI.afterCanvas).getPropertyValue('--cc').trim();
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

  function readConfig() {
    return {
      filters: ui.filters.value,
      hum: ui.hum.value,
      denoise: ui.denoise.value,
      strength: ui.strength.value,
      presence: ui.presence.value,
      compress: ui.compress.value,
      loudness: ui.loudness.value,
      targetId: ui.target.value,
      target: TARGETS[ui.target.value].lufs,
      format: ui.format.value,
    };
  }

  function syncVisibility() {
    ui.humWrap.hidden = !ui.filters.value;
    ui.strength.root.hidden = !ui.denoise.value;
    ui.target.root.hidden = !ui.loudness.value;
    ui.mp3Note.hide(ui.format.value !== 'mp3');
  }

  function paintFacts() {
    if (!ui.facts) return;
    if (!state.buffer || !state.file) { ui.facts.set([]); return; }
    const b = state.buffer;
    const rows = [
      ['Length', formatDuration(b.duration)],
      ['File size', formatBytes(state.file.size)],
      ['Channels', b.numberOfChannels === 1 ? 'Mono' : b.numberOfChannels === 2 ? 'Stereo' : `${b.numberOfChannels} channels`],
    ];
    if (state.noiseFloorDb !== null) rows.push(['Noise floor', `${state.noiseFloorDb.toFixed(0)} dBFS`]);
    ui.facts.set(rows);
  }

  function updateExplain() {
    if (!ui.explain) return;
    const cfg = readConfig();
    const parts = [];
    if (cfg.denoise && cfg.filters && cfg.hum !== 'off') parts.push(`hiss and hum removed at ${cfg.strength}% strength`);
    else if (cfg.denoise) parts.push(`hiss reduced at ${cfg.strength}% strength`);
    else if (cfg.filters) parts.push(cfg.hum === 'off' ? 'rumble cut' : `rumble and ${cfg.hum} Hz hum cut`);
    if (cfg.presence) parts.push('voice lifted');
    if (cfg.compress) parts.push('levels evened out');
    if (cfg.loudness) parts.push(`volume set to ${TARGETS[cfg.targetId].phrase}`);
    const fmt = FORMATS[cfg.format].label;
    if (!parts.length) {
      ui.explain.set(`Every step is switched off — the file would come out unchanged, saved as ${fmt}.`);
      return;
    }
    const sentence = parts.join(', ');
    ui.explain.set(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} — as ${fmt}.`);
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
