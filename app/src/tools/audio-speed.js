// Change Speed — listen to a lecture at 1.5× and SAVE it that way, so it plays
// fast on any player: the phone's own audio app, the car stereo, a friend's
// laptop. No per-app speed setting to hunt for, because the speed is baked into
// the file itself.
//
// Two engines, honestly labelled. "Pitch preserved" is the WSOLA time-stretch
// from audio-fx.js — slower to run, but the lecturer stays human at any speed.
// "Chipmunk mode" is a plain rate change rendered through an OfflineAudioContext
// — near-instant, and the pitch moves with the speed, which is exactly what the
// name warns you about.

import { el, formatBytes, stem, toast } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import {
  breathe, buffersFrom, channelData, decodeAudio, drawWaveform, encodeBuffer,
  encodeWav, timeStretch, waveformPeaks,
} from '../audio-fx.js';
import { toolShell } from '../tool-shell.js';
import {
  fileFacts, infoBox, liveExplain, optionPanel, segmented, selectField, sliderField,
} from '../option-ui.js';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 3];
const DEFAULT_SPEED = 1.5;
const PREVIEW_SECONDS = 15;
const LONG_FILE_SECONDS = 30 * 60;
const PREVIEW_LABEL = '▶ Preview 15 seconds from the middle';

const FORMATS = [
  { id: 'mp3', label: 'MP3 — plays everywhere' },
  { id: 'm4a', label: 'M4A (AAC) — smaller, Apple-friendly' },
  { id: 'wav', label: 'WAV — uncompressed, big' },
];

const MODE_HINTS = {
  pitch: 'WSOLA time-stretch — the speaker stays human at any speed. The slow, good one.',
  chipmunk: 'A plain rate change — quick, but the pitch moves with the speed. Faster really does sound like a chipmunk.',
};

/** 1.5 → "1.5×", 2 → "2×" — for sentences and titles. */
function fmtRate(rate) {
  return `${String(+rate.toFixed(2))}×`;
}

/** The ASCII twin of fmtRate, safe inside a filename on every OS. */
function rateSlug(rate) {
  return `${String(+rate.toFixed(2))}x`;
}

export default function render(container, tool) {
  const state = { file: null, buffer: null, decoding: false, rate: DEFAULT_SPEED, mode: 'pitch' };
  const ui = {};
  const area = {};
  let previewUrl = null;
  let previewController = null;
  let modeHint = null;

  toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: false,
    pickLabel: 'Select an audio file',
    dropLabel: 'or drop a recording here',
    actionLabel: 'Change speed',
    doneTitle: 'Your re-timed audio is ready',
    downloadLabel: 'Download audio',
    continueTo: ['silence-cut', 'extract-audio', 'convert-audio'],
    note: 'Saving the speed into the file beats fiddling with player settings: a '
      + '90-minute lecture at 1.5× is an hour and a minute on any device, in any '
      + 'app — and the recording never leaves this one.',

    workarea(host) { if (!area.root) buildArea(host); },

    async onFiles(ctx) {
      const file = ctx.files[0] ?? null;
      resetPreview();
      state.file = file;
      state.buffer = null;
      if (!file) { update(); paintArea(); return; }
      state.decoding = true;
      update();
      paintArea();
      try {
        const buffer = await decodeAudio(file);
        // The user may have dropped a different file while this one decoded.
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
      const panel = optionPanel('Change speed');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      // Seven pills won't fit one row of a 300px sidebar; let the segmented
      // control wrap into two rows rather than squeezing the labels illegible.
      ui.speed = segmented(
        SPEEDS.map((s) => ({ id: String(s), label: `${String(s)}×` })),
        (item) => {
          state.rate = Number(item.id);
          ui.fine.value = state.rate;   // presets drive the fine-tune slider…
          update();
        },
        { active: SPEEDS.indexOf(DEFAULT_SPEED) },
      );
      ui.speed.root.style.flexWrap = 'wrap';
      for (const b of ui.speed.root.querySelectorAll('.opt__seg__btn')) b.style.flex = '1 1 56px';

      ui.fine = sliderField('Fine tune', {
        value: DEFAULT_SPEED, min: 0.5, max: 3, step: 0.05, suffix: '×',
        onChange: (v) => { state.rate = v; update(); },   // …and snaps back onto them when it lands on one
      });

      ui.mode = segmented(
        [{ id: 'pitch', label: 'Pitch preserved' }, { id: 'chipmunk', label: 'Chipmunk mode' }],
        (item) => {
          state.mode = item.id;
          if (modeHint) modeHint.textContent = MODE_HINTS[item.id];
          update();
        },
      );

      ui.format = selectField('Save as', FORMATS, { value: 'mp3', onChange: update });

      ui.mp3Note = infoBox('The first MP3 export downloads a small encoder (about 200 KB) once. After that it is cached, even offline.');
      ui.longNote = infoBox('Over 30 minutes — a long lecture takes a minute or two to re-time with the voice kept natural. It keeps working in a background tab, and Cancel works at any time.');
      ui.longNote.hide(true);

      const speedWrap = labelled('Speed', ui.speed.root);
      const modeWrap = labelled('Keep voice natural', ui.mode.root, MODE_HINTS.pitch);
      modeHint = modeWrap.hint;

      panel.add(ui.facts, speedWrap.root, ui.fine, modeWrap.root, ui.format, ui.mp3Note, ui.longNote, ui.explain);
      host.appendChild(panel.root);
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
      const rate = state.rate;
      if (Math.abs(rate - 1) < 1e-3) {
        throw new Error('The speed is set to 1×, which changes nothing. Pick a speed above or below 1× first.');
      }
      // A preview render fighting the real job for the CPU helps neither.
      previewController?.abort();
      try { area.player?.pause(); } catch { /* nothing was playing */ }

      const mode = state.mode;
      const format = ui.format.value;

      let out;
      if (mode === 'pitch') {
        out = await timeStretch(buffer, rate, {
          signal: ctx.signal,
          onProgress: (f) => ctx.setBusy(f * 0.72, `Re-timing at ${fmtRate(rate)} — ${Math.round(f * 100)}%`),
        });
      } else {
        // The offline renderer is the platform's own resampler: fast, native,
        // and with no progress callback to report from.
        ctx.setBusy(0.1, `Resampling at ${fmtRate(rate)}…`);
        await breathe(0);
        out = await chipmunk(buffer, rate);
      }
      if (ctx.signal?.aborted) throw new Error('canceled');

      ctx.setBusy(0.72, `Encoding ${format.toUpperCase()}…`);
      await breathe(0);   // let the busy text paint before the encoder takes over
      const name = `${stem(state.file.name)}-${rateSlug(rate)}`;
      const { blob, ext } = await encodeBuffer(out, {
        format,
        name,
        onProgress: (f) => ctx.setBusy(0.72 + f * 0.28, `Encoding ${format.toUpperCase()} — ${Math.round(f * 100)}%`),
        signal: ctx.signal,
      });

      return {
        outputs: [{ name: `${name}.${ext}`, blob }],
        doneTitle: `Saved at ${fmtRate(rate)} — ${formatDuration(buffer.duration)} → ${formatDuration(out.duration)}.`,
      };
    },
  });

  // -------------------------------------------------------------------------

  /** Option-panel field wrapper for controls that don't bring their own label. */
  function labelled(text, node, hintText) {
    const wrap = el(`<div class="opt__field"><span class="opt__label"></span></div>`);
    wrap.querySelector('.opt__label').textContent = text;
    wrap.appendChild(node);
    let hint = null;
    if (hintText !== undefined) {
      hint = el(`<p class="opt__hint"></p>`);
      hint.textContent = hintText;
      wrap.appendChild(hint);
    }
    return { root: wrap, hint };
  }

  /** Highlights whichever speed pill the fine-tune slider currently sits on. */
  function syncSpeedHighlight() {
    const buttons = ui.speed.root.querySelectorAll('.opt__seg__btn');
    buttons.forEach((btn, i) => btn.classList.toggle('is-active', Math.abs(SPEEDS[i] - state.rate) < 0.001));
  }

  function update() {
    if (!ui.explain) return;
    syncSpeedHighlight();
    ui.mp3Note.hide(ui.format.value !== 'mp3');

    const buffer = state.buffer;
    if (!buffer) {
      ui.explain.set(state.decoding ? 'Reading the recording…' : '');
      ui.facts.set([]);
      ui.longNote.hide(true);
      return;
    }

    const rate = state.rate;
    const fmt = ui.format.value.toUpperCase();
    if (Math.abs(rate - 1) < 1e-3) {
      ui.explain.set(`At 1× your ${formatDuration(buffer.duration)} recording keeps its length — pick a speed above or below 1× to change it.`);
    } else {
      const voice = state.mode === 'pitch'
        ? 'voice kept natural'
        : rate > 1 ? 'pitch rises (chipmunk)' : 'pitch drops (slow-motion voice)';
      ui.explain.set(`Your ${formatDuration(buffer.duration)} recording becomes ${formatDuration(buffer.duration / rate)} at ${fmtRate(rate)} — ${voice}, saved as ${fmt}.`);
    }

    ui.facts.set([
      ['Length now', formatDuration(buffer.duration)],
      [`At ${fmtRate(rate)}`, formatDuration(buffer.duration / rate)],
      ['Channels', buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'],
      ['File size', formatBytes(state.file?.size ?? 0)],
    ]);
    ui.longNote.hide(buffer.duration <= LONG_FILE_SECONDS);
  }

  // ---- workarea: waveform + the 15-second ear test -------------------------

  function buildArea(host) {
    area.root = el(`
      <div>
        <p class="ts__hint" data-label hidden></p>
        <canvas data-wave width="640" height="96" hidden></canvas>
        <div class="actions">
          <button class="btn secondary small" type="button" data-preview disabled></button>
        </div>
        <p class="ts__hint" data-caption hidden></p>
        <audio class="media-el" controls></audio>
      </div>
    `);
    area.label = area.root.querySelector('[data-label]');
    area.wave = area.root.querySelector('[data-wave]');
    area.previewBtn = area.root.querySelector('[data-preview]');
    area.caption = area.root.querySelector('[data-caption]');
    area.player = area.root.querySelector('audio');
    area.wave.style.width = '100%';
    // .media-el sets display:block, which would override the hidden attribute —
    // so the player is shown and hidden through its inline display instead.
    area.player.style.display = 'none';
    area.previewBtn.textContent = PREVIEW_LABEL;
    area.previewBtn.addEventListener('click', makePreview);
    host.appendChild(area.root);
  }

  function paintArea() {
    if (!area.root) return;
    const buffer = state.buffer;
    area.previewBtn.disabled = !buffer || !!previewController;
    area.label.hidden = !buffer;
    area.wave.hidden = !buffer;
    if (!buffer) return;
    area.label.textContent = `${state.file.name} — ${formatDuration(buffer.duration)}`;
    drawWaveform(area.wave, waveformPeaks(buffer, 640));
  }

  /**
   * Fifteen seconds from the middle of the recording, run through exactly the
   * same engine the real job uses, played back from a WAV blob. The middle, not
   * the start, because the start of a lecture recording is chair-scraping and
   * "can everyone hear me" — the middle is what the whole file sounds like.
   */
  async function makePreview() {
    const buffer = state.buffer;
    if (!buffer || previewController) return;
    const rate = state.rate;
    const mode = state.mode;
    if (Math.abs(rate - 1) < 1e-3) { toast('The speed is set to 1× — the preview would sound identical.'); return; }

    previewController = new AbortController();
    const { signal } = previewController;
    area.previewBtn.disabled = true;
    try {
      const sr = buffer.sampleRate;
      const want = Math.min(buffer.length, Math.floor(PREVIEW_SECONDS * sr));
      const start = Math.max(0, Math.floor((buffer.length - want) / 2));
      const channels = channelData(buffer).map((ch) => ch.slice(start, start + want));
      await breathe(0);
      if (signal.aborted) throw new Error('canceled');
      const slice = buffersFrom(channels, sr);

      let out;
      if (mode === 'pitch') {
        area.previewBtn.textContent = 'Re-timing the preview…';
        out = await timeStretch(slice, rate, {
          signal,
          onProgress: (f) => { area.previewBtn.textContent = `Re-timing the preview… ${Math.round(f * 100)}%`; },
        });
      } else {
        area.previewBtn.textContent = 'Rendering the preview…';
        out = await chipmunk(slice, rate);
      }
      if (signal.aborted) throw new Error('canceled');

      const url = URL.createObjectURL(encodeWav(out));
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
      area.player.src = url;
      area.player.style.display = '';
      area.caption.hidden = false;
      area.caption.textContent = `Preview at ${fmtRate(rate)} — ${mode === 'pitch' ? 'pitch preserved' : 'plain rate change'} · `
        + (want < buffer.length ? `${Math.round(want / sr)} seconds from the middle` : 'the whole clip');
      area.player.play().catch(() => { /* controls are visible — pressing play works */ });
    } catch (err) {
      if (!/cancel/i.test(err?.message ?? '')) toast(err.message);
    } finally {
      previewController = null;
      area.previewBtn.textContent = PREVIEW_LABEL;
      area.previewBtn.disabled = !state.buffer;
    }
  }

  function resetPreview() {
    previewController?.abort();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (area.player) {
      try { area.player.pause(); } catch { /* nothing was playing */ }
      area.player.removeAttribute('src');
      area.player.style.display = 'none';
    }
    if (area.caption) area.caption.hidden = true;
  }

  /**
   * The honest chipmunk: play the buffer faster (or slower) through the offline
   * renderer, output length scaled by the rate. Pitch follows speed, on purpose.
   */
  async function chipmunk(buffer, rate) {
    const length = Math.max(1, Math.ceil(buffer.length / rate));
    const octx = new OfflineAudioContext(buffer.numberOfChannels, length, buffer.sampleRate);
    const src = octx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(octx.destination);
    src.start();
    return octx.startRendering();
  }

  // The preview player holds a blob URL of rendered audio; leaving the tool
  // must let go of it, and of any preview still rendering.
  window.addEventListener('hashchange', () => { resetPreview(); }, { once: true });
}
