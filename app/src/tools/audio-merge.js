// Join Audio — stitch voice memos and takes into one file, with equal-power
// crossfades hiding the joins.
//
// Files can come from different phones, which means different sample rates and
// channel counts. Anything that does not match the first file is rendered
// through an OfflineAudioContext at the target rate and channel count — the
// platform's own resampler and channel-mixing rules, not hand-rolled DSP. The
// joins themselves are cos/sin gain curves over the overlap, so two clips share
// the crossfade at constant power instead of dipping in the middle.

import { el } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration, probeMedia } from '../media-utils.js';
import {
  breathe, buffersFrom, decodeAudio, encodeBuffer, measureLoudness, normalizeLoudness,
} from '../audio-fx.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, selectField, sliderField, textField,
} from '../option-ui.js';

const FORMATS = [
  { id: 'mp3', label: 'MP3 — plays everywhere (128 kbps)' },
  { id: 'm4a', label: 'M4A — better quality, same size' },
  { id: 'wav', label: 'WAV — no quality loss, big' },
];
const FORMAT_SHORT = { mp3: 'MP3', m4a: 'M4A', wav: 'WAV' };
const FORMAT_EXT = { mp3: 'mp3', m4a: 'm4a', wav: 'wav' };

export default function render(container, tool) {
  const ui = {};
  const meta = new Map();   // File → { pending?, duration?, error? }
  let rowsHost = null;
  let shellCtx = null;
  let alive = true;
  window.addEventListener('hashchange', () => { alive = false; }, { once: true });

  shellCtx = toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: true,
    minFiles: 2,
    sortable: true,
    pickLabel: 'Select audio files',
    dropLabel: 'or drop them here — they join top to bottom',
    actionLabel: 'Join audio',
    doneTitle: 'Your clips are one file!',
    downloadLabel: 'Download joined audio',
    continueTo: ['enhance-voice', 'normalize-audio', 'trim-audio'],
    note: 'Intro, five takes, outro — line them up, let the half-second crossfades hide the joins, and hand in one clean file. The stitching happens right here; nothing is uploaded.',

    workarea(host, c) { rowsHost = host; shellCtx = c; paintRows(); },

    async onFiles(c) {
      shellCtx = c;
      for (const key of [...meta.keys()]) if (!c.files.includes(key)) meta.delete(key);
      const fresh = c.files.filter((f) => !meta.has(f));
      for (const file of fresh) meta.set(file, { pending: true });
      paintRows();
      update();
      for (const file of fresh) {
        if (!alive) return;
        try {
          const probe = await probeMedia(file);
          if (!probe.hasAudio) throw new Error('no sound track');
          if (!(probe.duration > 0)) throw new Error('length unknown');
          if (meta.has(file)) meta.set(file, { duration: probe.duration });
        } catch {
          if (meta.has(file)) meta.set(file, { error: true });
        }
        paintRows();
        update();
        await breathe();
      }
    },

    options(host) {
      const panel = optionPanel('Join');
      ui.facts = fileFacts();
      ui.fade = sliderField('Crossfade between clips', {
        value: 0.5, min: 0, max: 3, step: 0.1, suffix: ' s',
        onChange: () => update(),
      });
      const fadeHint = el(`<p class="opt__hint" style="margin-top:-10px">Each clip melts into the next instead of cutting hard. 0 joins them end to end.</p>`);
      ui.match = checkRow('Match volume across clips', {
        hint: 'Levels every clip to the group’s average loudness before joining, so one quiet phone doesn’t stick out.',
        onChange: () => update(),
      });
      ui.name = textField('Output file name', { value: 'joined', maxLength: 80, onChange: () => update() });
      ui.format = selectField('Save as', FORMATS, { value: 'mp3', onChange: () => update() });
      ui.mp3note = infoBox('The first MP3 saved loads a small encoder (about 200 KB) into the page. That happens once per visit, and nothing about your audio leaves the device.');
      ui.explain = liveExplain();
      panel.add(ui.facts, ui.fade, fadeHint, ui.match, ui.name, ui.format, ui.mp3note, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      const files = [...ctx.files];
      if (files.length < 2) throw new Error('Add at least two clips to join.');
      for (const f of files) {
        const m = meta.get(f);
        if (m?.error) throw new Error(`${f.name} could not be read as audio — remove it to join the rest.`);
      }
      const fade = ui.fade.value;
      const format = ui.format.value;
      const match = ui.match.value;
      const outName = safeName(ui.name.value) || 'joined';

      // ---- decode everything (0 → 0.4) ----
      const clips = [];
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy((i / files.length) * 0.4, `Reading ${files[i].name} (${i + 1} of ${files.length})…`);
        clips.push(await decodeAudio(files[i]));
        await breathe();
      }

      // ---- conform to one rate and channel count (0.4 → 0.6) ----
      // Target: the first file's sample rate, and the widest channel count in
      // the batch (capped at stereo — MP3 and M4A cannot hold more anyway).
      const targetRate = clips[0].sampleRate;
      const targetChannels = Math.min(2, Math.max(...clips.map((b) => b.numberOfChannels)));
      const lufs = [];
      for (let i = 0; i < clips.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(0.4 + (i / clips.length) * 0.2, `Preparing ${files[i].name}…`);
        if (clips[i].sampleRate !== targetRate || clips[i].numberOfChannels !== targetChannels) {
          clips[i] = await conform(clips[i], targetChannels, targetRate);
        }
        if (match) lufs.push(await measureLoudness(clips[i]));
        await breathe();
      }

      // ---- match loudness across clips (0.6 → 0.7) ----
      if (match) {
        const mean = lufs.reduce((a, b) => a + b, 0) / lufs.length;
        for (let i = 0; i < clips.length; i++) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          ctx.setBusy(0.6 + (i / clips.length) * 0.1, `Levelling ${files[i].name}…`);
          clips[i] = (await normalizeLoudness(clips[i], mean)).buffer;
          await breathe();
        }
      }

      // ---- concatenate with crossfades (0.7 → 0.78) ----
      ctx.setBusy(0.7, fade > 0 ? 'Joining with crossfades…' : 'Joining…');
      const joined = await join(clips, targetRate, targetChannels, fade, ctx.signal);

      // ---- encode (0.78 → 1) ----
      const fmt = FORMAT_SHORT[format];
      ctx.setBusy(0.78, `Saving ${outName}.${FORMAT_EXT[format]} as ${fmt}…`);
      const { blob, ext } = await encodeBuffer(joined, {
        format, kbps: 128, name: outName,
        signal: ctx.signal,
        onProgress: (f) => ctx.setBusy(0.78 + f * 0.22, `Saving ${outName}.${FORMAT_EXT[format]} as ${fmt}…`),
      });
      return {
        outputs: [{ name: `${outName}.${ext}`, blob }],
        doneTitle: `${files.length} clips are now one ${formatDuration(joined.duration)} file.`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // The workarea: one row per clip — order number, name, duration, and the
  // reorder / remove buttons. Same shape merge-pdf gives its PDFs.
  // -------------------------------------------------------------------------

  function paintRows() {
    if (!rowsHost) return;
    rowsHost.innerHTML = '';
    const files = shellCtx?.files ?? [];
    if (!files.length) return;

    rowsHost.appendChild(el(`<p class="ts__hint">They join top to bottom — the first row plays first.</p>`));
    const list = el(`<div class="file-list"></div>`);

    files.forEach((file, i) => {
      const row = el(`
        <div class="file-row">
          <span class="size" style="min-width:20px;text-align:right">${i + 1}.</span>
          <span style="width:34px;min-width:34px;display:grid;place-items:center;font-size:19px">🎵</span>
          <span class="name"></span>
          <span class="size"></span>
          <button class="icon-btn" data-up type="button" title="Move up">↑</button>
          <button class="icon-btn" data-down type="button" title="Move down">↓</button>
          <button class="icon-btn danger" data-rm type="button" title="Remove">✕</button>
        </div>
      `);
      row.querySelector('.name').textContent = file.name;
      const m = meta.get(file);
      row.querySelectorAll('.size')[1].textContent =
        m?.error ? 'not readable' : (!m || m.pending) ? 'reading…' : formatDuration(m.duration);
      if (m?.error) row.querySelector('.name').style.color = 'var(--danger)';

      const up = row.querySelector('[data-up]');
      const down = row.querySelector('[data-down]');
      up.disabled = i === 0;
      down.disabled = i === files.length - 1;
      up.addEventListener('click', () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; paintRows(); update(); });
      down.addEventListener('click', () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; paintRows(); update(); });
      row.querySelector('[data-rm]').addEventListener('click', () => {
        files.splice(i, 1);
        meta.delete(file);
        if (!files.length) shellCtx?.stage('upload');
        shellCtx?.refresh();
        update();
      });
      list.appendChild(row);
    });
    rowsHost.appendChild(list);
  }

  // -------------------------------------------------------------------------
  // Sidebar facts + the live sentence
  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    ui.mp3note?.hide(ui.format.value !== 'mp3');

    const files = shellCtx?.files ?? [];
    const n = files.length;
    if (!n) { ui.facts.set([]); ui.explain.set(''); return; }

    const entries = files.map((f) => meta.get(f));
    const pending = entries.some((m) => !m || m.pending);
    const badIndex = entries.findIndex((m) => m?.error);
    const total = entries.reduce((s, m) => s + (m?.duration ?? 0), 0);
    const fade = ui.fade.value;
    const joined = Math.max(0, total - fade * Math.max(0, n - 1));

    ui.facts.set([
      ['Clips', String(n)],
      ['Total length', pending ? '…' : formatDuration(total)],
      ['After joining', pending ? '…' : `≈ ${formatDuration(joined)}`],
    ]);

    if (badIndex >= 0) {
      ui.explain.set(`${files[badIndex].name} could not be read as audio — remove it to join the rest.`);
      return;
    }
    if (pending) { ui.explain.set('Reading the clips…'); return; }
    if (n < 2) { ui.explain.set('Add at least one more clip — joining needs two.'); return; }

    const outName = `${safeName(ui.name.value) || 'joined'}.${FORMAT_EXT[ui.format.value]}`;
    const fadePhrase = fade === 0 ? 'joined end to end' : `with ${fadeWord(fade)} crossfades`;
    const matchPhrase = ui.match.value ? ', volume matched across clips' : '';
    ui.explain.set(`${n} clips → one ${roughLength(joined)} file ${fadePhrase}${matchPhrase}: ${outName}`);
  }

  // -------------------------------------------------------------------------
  // The joining itself
  // -------------------------------------------------------------------------

  /**
   * Re-renders a buffer at the target sample rate and channel count. The
   * OfflineAudioContext does the resampling and the mono↔stereo (and even
   * 5.1→stereo) mixing by the Web Audio spec's own rules.
   */
  async function conform(buffer, channels, rate) {
    const oc = new OfflineAudioContext(channels, Math.max(1, Math.ceil(buffer.duration * rate)), rate);
    const src = oc.createBufferSource();
    src.buffer = buffer;
    src.connect(oc.destination);
    src.start();
    return oc.startRendering();
  }

  /**
   * Concatenates the clips into fresh Float32Arrays. Where two clips overlap,
   * the outgoing one fades on a cos curve and the incoming one on a sin curve —
   * cos² + sin² = 1, so the crossfade holds constant power all the way through.
   * An overlap is never allowed to eat more than half of either clip.
   */
  async function join(buffers, rate, channels, fade, signal) {
    const n = buffers.length;
    const lens = buffers.map((b) => b.length);
    const overlaps = [];
    for (let i = 1; i < n; i++) {
      overlaps.push(Math.max(0, Math.min(
        Math.round(fade * rate),
        Math.floor(lens[i - 1] / 2),
        Math.floor(lens[i] / 2),
      )));
    }
    const total = lens.reduce((a, b) => a + b, 0) - overlaps.reduce((a, b) => a + b, 0);
    const out = [];
    for (let c = 0; c < channels; c++) out.push(new Float32Array(total));

    const HALF_PI = Math.PI / 2;
    const CHUNK = 1 << 20;
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const buf = buffers[i];
      const len = buf.length;
      const oIn = i > 0 ? overlaps[i - 1] : 0;        // this clip fades in over the previous one
      const oOut = i < n - 1 ? overlaps[i] : 0;       // and fades out under the next
      for (let c = 0; c < channels; c++) {
        const x = buf.getChannelData(c);
        const y = out[c];
        for (let s0 = 0; s0 < len; s0 += CHUNK) {
          if (signal?.aborted) throw new Error('canceled');
          const s1 = Math.min(len, s0 + CHUNK);
          for (let s = s0; s < s1; s++) {
            let v = x[s];
            if (oIn && s < oIn) v *= Math.sin(((s + 0.5) / oIn) * HALF_PI);
            const fromEnd = len - s;
            if (oOut && fromEnd <= oOut) v *= Math.cos(((oOut - fromEnd + 0.5) / oOut) * HALF_PI);
            y[pos + s] += v;
          }
          await breathe();
        }
      }
      buffers[i] = null;   // let a finished clip be reclaimed while the rest copy
      pos += len - oOut;
    }
    return buffersFrom(out, rate);
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function fadeWord(s) {
    if (s === 0.5) return 'half-second';
    if (s === 1) return 'one-second';
    return `${Math.round(s * 10) / 10}-second`;
  }

  function roughLength(seconds) {
    if (seconds >= 5400) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')}-hour`;
    if (seconds >= 90) return `${Math.round(seconds / 60)}-minute`;
    return `${Math.round(seconds)}-second`;
  }

  /** A file name every OS accepts — same rules the PDF tools use. */
  function safeName(label) {
    if (!label) return '';
    return label
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 80);
  }
}
