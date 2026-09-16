// Equalizer — eight bands, six presets, and the one thing a static tool can't
// give you: you hear the sliders move. A live Web Audio chain plays the original
// file through eight BiquadFilterNodes that mirror the sidebar, so "is +3 dB at
// 2.4 kHz too much?" is answered by ear, not by exporting and checking.
//
// The export path is separate and deterministic: the same eight bands rebuilt in
// an OfflineAudioContext via renderGraph + eqChain, optionally re-leveled back
// to the file's original loudness so the EQ changes the tone and not the volume.

import { el, formatBytes, stem, toast } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import {
  breathe, decodeAudio, drawWaveform, encodeBuffer, eqChain, measureLoudness,
  normalizeLoudness, renderGraph, waveformPeaks,
} from '../audio-fx.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, selectField, sliderField,
} from '../option-ui.js';

// The shelves catch everything below 60 and above 16k; the peaking bands in
// between are wide (Q ≈ 1.1) — musical strokes, not surgical notches.
const PEAKING_Q = 1.1;
const BANDS = [
  { hz: 60, type: 'lowshelf', label: '60 Hz', word: 'rumble' },
  { hz: 150, type: 'peaking', label: '150 Hz', word: 'boom' },
  { hz: 400, type: 'peaking', label: '400 Hz', word: 'mud' },
  { hz: 1000, type: 'peaking', label: '1 kHz', word: 'body' },
  { hz: 2400, type: 'peaking', label: '2.4 kHz', word: 'presence' },
  { hz: 6000, type: 'peaking', label: '6 kHz', word: 'clarity' },
  { hz: 12000, type: 'peaking', label: '12 kHz', word: 'sparkle' },
  { hz: 16000, type: 'highshelf', label: '16 kHz', word: 'air' },
];

// Gains in BANDS order: 60 / 150 / 400 / 1k / 2.4k / 6k / 12k / 16k.
const PRESETS = [
  { name: 'Flat', slug: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Clear voice', slug: 'clear-voice', gains: [0, -2, -3, 0, 3, 2, 0, 0] },
  { name: 'Warm', slug: 'warm', gains: [2, 3, 0, 0, 0, -1, 0, 0] },
  { name: 'Bass boost', slug: 'bass-boost', gains: [5, 3, 0, 0, 0, 0, 0, 0] },
  { name: 'Less harsh', slug: 'less-harsh', gains: [0, 0, 0, 0, 0, -4, -3, 0] },
  { name: 'Phone speaker', slug: 'phone-speaker', gains: [-6, -4, 0, 2, 3, 0, 0, 0] },
];

const FORMATS = [
  { id: 'mp3', label: 'MP3 — plays everywhere' },
  { id: 'm4a', label: 'M4A (AAC) — smaller, Apple-friendly' },
  { id: 'wav', label: 'WAV — uncompressed, big' },
];

const PLAY_LABEL = '▶ Play with the live EQ';

export default function render(container, tool) {
  const state = { file: null, buffer: null, decoding: false, preset: 'Flat' };
  const ui = {};
  const area = {};
  const chips = [];   // [{ chip, name }] — the preset row plus the Custom label
  // The live chain: one hidden <audio> on a blob URL of the untouched file,
  // routed through eight filters. Rebuilt from scratch per file, because a media
  // element can only ever feed the first MediaElementSource created for it.
  let live = null;    // { audioEl, url, actx, filters }

  toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: false,
    pickLabel: 'Select an audio file',
    dropLabel: 'or drop a recording here',
    actionLabel: 'Apply EQ',
    doneTitle: 'Your equalized audio is ready',
    downloadLabel: 'Download audio',
    continueTo: ['enhance-voice', 'normalize-audio', 'convert-audio'],
    note: 'Tinny phone recording, boomy room, a mix that hurts on earphones — '
      + 'eight sliders fix more than you would think, and because the preview is '
      + 'live you tune by ear instead of by guesswork. The recording never leaves this device.',

    workarea(host) { if (!area.root) buildArea(host); },

    async onFiles(ctx) {
      const file = ctx.files[0] ?? null;
      stopLive({ close: true });
      state.file = file;
      state.buffer = null;
      update();
      paintArea();
      if (!file) return;
      state.decoding = true;
      try {
        const buffer = await decodeAudio(file);
        // A different file may have been dropped while this one decoded.
        if (state.file !== file) return;
        state.buffer = buffer;
      } finally {
        if (state.file === file) {
          state.decoding = false;
          update();
          paintArea();
        }
      }
    },

    options(host) {
      const panel = optionPanel('Equalizer');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      // Preset chips — same .chip vocabulary the rest of the app uses. The
      // trailing "Custom" chip is a label more than a button: it lights up the
      // moment any slider stops matching a preset.
      const chipRow = el(`<div class="chip-row"></div>`);
      for (const preset of PRESETS) {
        const chip = el(`<button class="chip" type="button"></button>`);
        chip.textContent = preset.name;
        chip.addEventListener('click', () => applyPreset(preset));
        chipRow.appendChild(chip);
        chips.push({ chip, name: preset.name });
      }
      const customChip = el(`<button class="chip" type="button"></button>`);
      customChip.textContent = 'Custom';
      customChip.addEventListener('click', () => { setActivePreset('Custom'); update(); });
      chipRow.appendChild(customChip);
      chips.push({ chip: customChip, name: 'Custom' });

      const presetWrap = el(`<div class="opt__field"><span class="opt__label">Preset</span></div>`);
      presetWrap.appendChild(chipRow);

      ui.sliders = BANDS.map((band, i) => sliderField(band.label, {
        value: 0, min: -12, max: 12, step: 1, suffix: ' dB',
        onChange: (v) => {
          setLiveGain(i, v);   // straight into the running filter — heard instantly
          const gains = gainsNow();
          const match = PRESETS.find((p) => p.gains.every((g, j) => g === gains[j]));
          setActivePreset(match ? match.name : 'Custom');
          update();
        },
      }));

      ui.relevel = checkRow('Re-level volume afterwards', {
        checked: true,
        hint: 'Measures the loudness before the EQ and brings the result back to it, so the tone changes but the overall volume does not.',
        onChange: update,
      });

      ui.format = selectField('Save as', FORMATS, { value: 'mp3', onChange: update });
      ui.mp3Note = infoBox('The first MP3 export downloads a small encoder (about 200 KB) once. After that it is cached, even offline.');

      panel.add(ui.facts, presetWrap, ...ui.sliders, ui.relevel, ui.format, ui.mp3Note, ui.explain);
      host.appendChild(panel.root);
      setActivePreset('Flat');
      update();
      return {};
    },

    async run(ctx) {
      const buffer = state.buffer;
      if (!buffer) {
        throw new Error(state.decoding
          ? 'Still reading the recording — give it a moment, then press the button again.'
          : 'Choose an audio file first.');
      }
      const gains = gainsNow();
      if (gains.every((g) => g === 0)) {
        throw new Error('All eight bands are flat, so nothing would change. Pick a preset or move a slider first — or use Fix Volume if you only want it louder.');
      }
      // The live preview and the offline render must not fight over the file.
      stopLive({ close: true });
      paintArea();

      const relevel = ui.relevel.value;
      const format = ui.format.value;
      const presetName = state.preset;

      let target = null;
      if (relevel) {
        ctx.setBusy(0.04, 'Measuring the loudness before the EQ…');
        await breathe(0);
        target = await measureLoudness(buffer);
        if (ctx.signal?.aborted) throw new Error('canceled');
      }

      ctx.setBusy(relevel ? 0.18 : 0.08, 'Applying the EQ…');
      await breathe(0);
      let out = await renderGraph(buffer, (octx, src) => eqChain(octx, src, BANDS.map((band, i) => ({
        type: band.type, frequency: band.hz, gain: gains[i], Q: band.type === 'peaking' ? PEAKING_Q : 1,
      }))));
      if (ctx.signal?.aborted) throw new Error('canceled');

      if (relevel) {
        ctx.setBusy(0.5, 'Re-leveling to the original loudness…');
        await breathe(0);
        out = (await normalizeLoudness(out, target)).buffer;
        if (ctx.signal?.aborted) throw new Error('canceled');
      }

      ctx.setBusy(0.62, `Encoding ${format.toUpperCase()}…`);
      await breathe(0);
      const slug = PRESETS.find((p) => p.name === presetName)?.slug ?? 'equalized';
      const name = `${stem(state.file.name)}-${presetName === 'Custom' ? 'equalized' : slug}`;
      const { blob, ext } = await encodeBuffer(out, {
        format,
        name,
        onProgress: (f) => ctx.setBusy(0.62 + f * 0.38, `Encoding ${format.toUpperCase()} — ${Math.round(f * 100)}%`),
        signal: ctx.signal,
      });

      return {
        outputs: [{ name: `${name}.${ext}`, blob }],
        doneTitle: presetName === 'Custom'
          ? `Custom EQ applied — saved as ${format.toUpperCase()}.`
          : `${presetName} EQ applied — saved as ${format.toUpperCase()}.`,
      };
    },
  });

  // -------------------------------------------------------------------------

  function gainsNow() {
    return ui.sliders.map((s) => s.value);
  }

  function setActivePreset(name) {
    state.preset = name;
    for (const { chip, name: n } of chips) chip.classList.toggle('active', n === name);
  }

  function applyPreset(preset) {
    preset.gains.forEach((g, i) => {
      ui.sliders[i].value = g;   // the setter repaints without firing onChange
      setLiveGain(i, g);
    });
    setActivePreset(preset.name);
    update();
  }

  /** The strongest moves, in words — "+3 dB presence, −3 dB mud". */
  function describeMoves(gains) {
    return gains
      .map((g, i) => ({ g, word: BANDS[i].word }))
      .filter((e) => e.g !== 0)
      .sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || b.g - a.g)
      .slice(0, 3)
      .map((e) => `${e.g > 0 ? '+' : '−'}${Math.abs(e.g)} dB ${e.word}`);
  }

  function update() {
    if (!ui.explain) return;
    ui.mp3Note.hide(ui.format.value !== 'mp3');

    const buffer = state.buffer;
    ui.facts.set(!state.file ? [] : [
      ['Length', buffer ? formatDuration(buffer.duration) : (state.decoding ? 'reading…' : '—')],
      ['Channels', buffer ? (buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo') : '—'],
      ['File size', formatBytes(state.file.size)],
    ]);

    if (!state.file) { ui.explain.set(''); return; }
    const moves = describeMoves(gainsNow());
    if (!moves.length) {
      ui.explain.set('All eight bands are flat — the file would come out sounding exactly as it does now. Pick a preset or drag a slider.');
    } else {
      const name = state.preset === 'Custom' ? 'Custom EQ' : `${state.preset} preset`;
      ui.explain.set(`${name} — ${moves.join(', ')} — saved as ${ui.format.value.toUpperCase()}.`);
    }
  }

  // ---- workarea: waveform + the live listen --------------------------------

  function buildArea(host) {
    area.root = el(`
      <div>
        <p class="ts__hint" data-label hidden></p>
        <canvas data-wave width="640" height="96" hidden></canvas>
        <div class="actions">
          <button class="btn small" type="button" data-play disabled></button>
        </div>
        <p class="ts__hint" data-hint hidden>Press play, then drag any slider — you hear the change instantly, straight off the original file. Nothing is written until you press Apply EQ.</p>
      </div>
    `);
    area.label = area.root.querySelector('[data-label]');
    area.wave = area.root.querySelector('[data-wave]');
    area.playBtn = area.root.querySelector('[data-play]');
    area.hint = area.root.querySelector('[data-hint]');
    area.wave.style.width = '100%';
    area.playBtn.textContent = PLAY_LABEL;
    area.playBtn.addEventListener('click', () => { togglePlay(); });
    host.appendChild(area.root);
  }

  function paintArea() {
    if (!area.root) return;
    // Playing needs only the file, not the decoded buffer — so the live listen
    // works the moment the file lands, even while a long recording decodes.
    area.playBtn.disabled = !state.file;
    area.hint.hidden = !state.file;
    syncPlayBtn();
    const buffer = state.buffer;
    area.label.hidden = !buffer;
    area.wave.hidden = !buffer;
    if (!buffer) return;
    area.label.textContent = `${state.file.name} — ${formatDuration(buffer.duration)}`;
    drawWaveform(area.wave, waveformPeaks(buffer, 640));
  }

  function syncPlayBtn() {
    if (!area.playBtn) return;
    const playing = !!live && !live.audioEl.paused;
    area.playBtn.textContent = playing ? '⏸ Pause' : PLAY_LABEL;
  }

  async function togglePlay() {
    if (!state.file) return;
    try {
      if (!live) {
        const url = URL.createObjectURL(state.file);
        const audioEl = new Audio();
        audioEl.src = url;
        audioEl.preload = 'auto';
        audioEl.addEventListener('ended', syncPlayBtn);
        live = { audioEl, url, actx: null, filters: null };
      }
      if (!live.actx) {
        // Created inside the click so autoplay policies count the gesture.
        const AC = window.AudioContext || window.webkitAudioContext;
        const actx = new AC();
        const src = actx.createMediaElementSource(live.audioEl);
        const filters = BANDS.map((band, i) => {
          const f = actx.createBiquadFilter();
          f.type = band.type;
          f.frequency.value = band.hz;
          f.Q.value = band.type === 'peaking' ? PEAKING_Q : 1;
          f.gain.value = ui.sliders[i].value;
          return f;
        });
        let node = src;
        for (const f of filters) { node.connect(f); node = f; }
        node.connect(actx.destination);
        live.actx = actx;
        live.filters = filters;
      }
      if (live.audioEl.paused) {
        await live.actx.resume();
        await live.audioEl.play();
      } else {
        live.audioEl.pause();
        await live.actx.suspend();
      }
    } catch {
      toast('The browser blocked playback — press the button once more.');
    }
    syncPlayBtn();
  }

  /** Slider → running filter, with no render in between. */
  function setLiveGain(i, value) {
    if (live?.filters) live.filters[i].gain.value = value;
  }

  function stopLive({ close = false } = {}) {
    if (!live) return;
    try { live.audioEl.pause(); } catch { /* nothing was playing */ }
    if (close) {
      live.audioEl.removeAttribute('src');
      try { live.audioEl.load(); } catch { /* not every browser needs this */ }
      URL.revokeObjectURL(live.url);
      live.actx?.close().catch(() => { /* already closed */ });
      live = null;
    } else {
      live.actx?.suspend().catch(() => { /* already suspended */ });
    }
    syncPlayBtn();
  }

  // The live chain holds a blob URL of the whole recording and an AudioContext
  // with a hardware voice — leaving the tool lets go of both.
  window.addEventListener('hashchange', () => { stopLive({ close: true }); }, { once: true });
}
