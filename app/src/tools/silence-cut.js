// Cut Silences — find the dead air in a lecture recording, show every cut on
// the waveform before it happens, then remove it.
//
// The selling number comes first: the moment the file is decoded, the tool says
// "23 silences found — cutting them saves 9 minutes 40 seconds of a 52-minute
// recording". Everything in the sidebar just tunes that sentence. Detection is
// audio-fx.js's RMS-window scan seeded by suggestSilenceThreshold, so nobody
// has to know what a decibel is — the slider is an offset from a threshold
// chosen for this recording's own noise floor.

import { el, stem } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import {
  breathe, cutSilences, decodeAudio, detectSilences, drawWaveform,
  encodeBuffer, suggestSilenceThreshold, waveformPeaks,
} from '../audio-fx.js';
import { toolShell } from '../tool-shell.js';
import {
  fileFacts, infoBox, liveExplain, numberField, optionPanel, selectField, sliderField,
} from '../option-ui.js';

const FORMATS = [
  { id: 'mp3', label: 'MP3 — plays everywhere (128 kbps)' },
  { id: 'm4a', label: 'M4A — better quality, same size' },
  { id: 'wav', label: 'WAV — no quality loss, big' },
];
const FORMAT_SHORT = { mp3: 'MP3', m4a: 'M4A', wav: 'WAV' };
const WAVE_BUCKETS = 1200;

export default function render(container, tool) {
  const ui = {};
  const state = { file: null, buffer: null, peaks: null, suggested: -40, silences: [], url: null };
  let areaHost = null;
  let canvas = null;
  let builtFor = null;    // which File the workarea DOM was built for
  let debounce = null;
  let alive = true;

  window.addEventListener('hashchange', () => {
    alive = false;
    clearTimeout(debounce);
    if (state.url) { try { URL.revokeObjectURL(state.url); } catch { /* gone */ } state.url = null; }
  }, { once: true });

  toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: false,
    pickLabel: 'Select a recording',
    dropLabel: 'or drop it here — a two-hour lecture is fine',
    actionLabel: 'Cut silences',
    doneTitle: 'The dead air is gone!',
    downloadLabel: 'Download shorter file',
    continueTo: ['audio-speed', 'enhance-voice', 'trim-audio'],
    note: 'A 9 a.m. lecture is easily a fifth dead air — the pause while the slide loads, the shuffle while someone finds the mic. Cut it and the same lecture replays in forty minutes instead of fifty. The recording never leaves this device.',

    workarea(host) {
      areaHost = host;
      if (state.buffer && builtFor !== state.file) buildArea();
    },

    async onFiles(ctx) { await load(ctx); },

    options(host) {
      const panel = optionPanel('Cut silences');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.sense = sliderField('Sensitivity', {
        value: 0, min: -12, max: 12, step: 1, suffix: ' dB',
        onChange: schedule,
      });
      const senseHint = el(`<p class="opt__hint" style="margin-top:-10px">0 is UniLab's suggestion for this recording. Push right and more of it counts as silence (bigger cuts); push left to protect the quiet moments.</p>`);

      ui.minLen = numberField('Only cut silences longer than', {
        value: 1.5, min: 0.5, max: 30, step: 0.5, suffix: 'seconds',
        hint: 'Short pauses under this length are part of how people talk — they stay.',
        onChange: schedule,
      });
      ui.gap = numberField('Leave a gap of', {
        value: 0.3, min: 0, max: 5, step: 0.1, suffix: 'seconds',
        hint: 'What remains of each silence, so sentences still breathe instead of slamming together.',
        onChange: () => { tidyGap(); schedule(); },
      });
      ui.format = selectField('Save as', FORMATS, { value: 'mp3', onChange: () => update() });
      ui.mp3note = infoBox('The first MP3 saved loads a small encoder (about 200 KB) into the page. That happens once per visit, and nothing about your audio leaves the device.');

      panel.add(ui.facts, ui.sense, senseHint, ui.minLen, ui.gap, ui.format, ui.mp3note, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.buffer) throw new Error('Still reading the recording — give it a second and try again.');
      // A slider nudge inside the 200 ms debounce window must not be lost —
      // flush any pending detection so the cut matches what the sidebar says.
      if (debounce) { clearTimeout(debounce); debounce = null; recompute(); }
      const saved = savedSeconds();
      if (!state.silences.length || saved < 0.05) {
        throw new Error('There is nothing to cut at these settings. Push the sensitivity slider right, or lower the minimum silence length, until red bands appear on the waveform.');
      }
      const format = ui.format.value;
      const fmt = FORMAT_SHORT[format];
      ctx.setBusy(0.05, `Cutting ${state.silences.length} silences out…`);
      await breathe();
      const cut = cutSilences(state.buffer, state.silences, { keepGap: ui.gap.value });
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(0.25, `Saving as ${fmt}…`);
      const { blob, ext } = await encodeBuffer(cut, {
        format, kbps: 128, name: stem(state.file.name),
        signal: ctx.signal,
        onProgress: (f) => ctx.setBusy(0.25 + f * 0.72, `Saving as ${fmt}…`),
      });
      const before = state.buffer.duration;
      const after = cut.duration;
      return {
        outputs: [{ name: `${stem(state.file.name)}-no-silence.${ext}`, blob }],
        doneTitle: `${spellDuration(before - after)} of dead air removed — ${formatDuration(before)} → ${formatDuration(after)}.`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Loading and detection
  // -------------------------------------------------------------------------

  async function load(ctx) {
    const file = ctx.files[0] ?? null;
    builtFor = null;
    state.buffer = null;
    state.peaks = null;
    state.silences = [];
    if (state.url) { try { URL.revokeObjectURL(state.url); } catch { /* gone */ } state.url = null; }
    state.file = file;
    update();
    if (!file) { if (areaHost) areaHost.innerHTML = ''; return; }

    if (areaHost) {
      areaHost.innerHTML = '';
      areaHost.appendChild(el(`<p class="ts__hint">Reading the recording — a long lecture can take a few seconds…</p>`));
    }
    let buffer;
    try {
      buffer = await decodeAudio(file);
    } catch (err) {
      if (alive && state.file === file && areaHost) {
        areaHost.innerHTML = '';
        areaHost.appendChild(el(`<p class="ts__hint"></p>`)).textContent =
          'That file could not be read as audio — drop another one here.';
      }
      throw err;
    }
    if (!alive || state.file !== file) return;
    state.suggested = suggestSilenceThreshold(buffer);
    await breathe();
    if (!alive || state.file !== file) return;
    state.buffer = buffer;
    state.peaks = waveformPeaks(buffer, WAVE_BUCKETS);
    buildArea();
    recompute();
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(recompute, 200);
  }

  function recompute() {
    if (!alive) return;
    if (!state.buffer) { update(); return; }
    state.silences = detectSilences(state.buffer, {
      thresholdDb: state.suggested + ui.sense.value,
      minLen: ui.minLen.value,
    });
    update();
    paintWave();
  }

  /** Seconds the current settings actually remove (each silence keeps its gap). */
  function savedSeconds() {
    const keep = ui.gap.value;
    return state.silences.reduce((s, x) => s + Math.max(0, (x.end - x.start) - keep), 0);
  }

  // -------------------------------------------------------------------------
  // Workarea — the full waveform with every planned cut painted red, and a
  // player of the ORIGINAL underneath so the cuts can be checked by ear.
  // -------------------------------------------------------------------------

  function buildArea() {
    if (!areaHost || !state.file) return;
    builtFor = state.file;
    areaHost.innerHTML = '';
    const wrap = el(`
      <div>
        <p class="ts__hint">Every red band is a silence that will be cut. Move the sensitivity slider and watch them change.</p>
        <canvas width="1200" height="150" style="width:100%;height:150px;display:block;margin-top:10px;background:var(--card);border:1px solid var(--line);border-radius:10px"></canvas>
        <p class="ts__hint" style="margin-top:16px">The original, for finding where the quiet parts are:</p>
      </div>
    `);
    canvas = wrap.querySelector('canvas');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.className = 'media-el';
    state.url = URL.createObjectURL(state.file);
    audio.src = state.url;
    wrap.appendChild(audio);
    areaHost.appendChild(wrap);
    paintWave();
  }

  function paintWave() {
    if (!canvas || !state.peaks || !state.buffer) return;
    drawWaveform(canvas, state.peaks, { color: waveColor() });
    const g = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const dur = state.buffer.duration;
    g.fillStyle = 'rgba(214, 69, 69, 0.32)';   // --danger at one third strength
    for (const s of state.silences) {
      const x = (s.start / dur) * w;
      const wide = Math.max(2, ((s.end - s.start) / dur) * w);
      g.fillRect(x, 0, wide, h);
    }
  }

  /** The audio category color, resolved to something a canvas can use. */
  function waveColor() {
    const v = canvas ? getComputedStyle(canvas).getPropertyValue('--cc').trim() : '';
    return v || '#8484e8';
  }

  // -------------------------------------------------------------------------
  // Sidebar facts + the number that sells it
  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    ui.mp3note?.hide(ui.format.value !== 'mp3');

    if (!state.buffer) {
      ui.facts.set(state.file ? [['File', state.file.name], ['Length', '…']] : []);
      ui.explain.set(state.file ? 'Reading the recording…' : '');
      return;
    }
    const dur = state.buffer.duration;
    const saved = savedSeconds();
    const n = state.silences.length;
    ui.facts.set([
      ['Length', formatDuration(dur)],
      ['Silences found', String(n)],
      ['Dead air to cut', formatDuration(saved)],
      ['After cutting', formatDuration(Math.max(0, dur - saved))],
    ]);

    if (!n) {
      ui.explain.set(`No silences longer than ${ui.minLen.value} s at this sensitivity — push the slider right to catch more.`);
    } else if (saved < 1) {
      ui.explain.set(`${n} silence${n === 1 ? '' : 's'} found, but the ${ui.gap.value} s gap keeps nearly all of it — lower the gap to actually save time.`);
    } else {
      ui.explain.set(`${n} silence${n === 1 ? '' : 's'} found — cutting them saves ${spellDuration(saved)} of a ${roughLength(dur)} recording.`);
    }
  }

  /**
   * The numberField steppers do raw float math, so 0.3 − 0.1 lands on
   * 0.19999999999999998. Snap the gap back to one clean decimal — but only
   * when it IS float residue, never while someone is typing 0.35.
   */
  function tidyGap() {
    const raw = ui.gap.value;
    const scaled = raw * 10;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6 && String(Math.round(scaled) / 10) !== String(raw)) {
      ui.gap.value = Math.round(scaled) / 10;
    }
  }
}

/** 580 → "9 minutes 40 seconds" — the sentence form of a duration. */
function spellDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.slice(0, 2).join(' ');
}

/** 3130 → "52-minute" — the adjective form, for "a 52-minute recording". */
function roughLength(seconds) {
  if (seconds >= 5400) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')}-hour`;
  if (seconds >= 90) return `${Math.round(seconds / 60)}-minute`;
  return `${Math.round(seconds)}-second`;
}
