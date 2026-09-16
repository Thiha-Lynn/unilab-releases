// Fix Volume — batch loudness levelling for the folder of voice memos a group
// project actually produces.
//
// The engine is audio-fx.js's loudness pipeline: measure in LUFS, gain to a
// target, never past −1 dBFS. What this tool adds is the batch story: every
// file in one run, a lazy per-file measurement so the sidebar can say which
// recording is the whisper, and a "match the loudest" mode for narration
// recorded on three different phones — measure everything first, then raise
// the rest to meet the loudest instead of forcing a number on all of them.

import JSZip from 'jszip';
import { downloadBlob, stem } from '../ui.js';
import { AUDIO_ACCEPT, formatDuration } from '../media-utils.js';
import {
  breathe, decodeAudio, encodeBuffer, measureLoudness, normalizeLoudness,
  renderGraph, speechCompressor,
} from '../audio-fx.js';
import { toolShell } from '../tool-shell.js';
import { checkRow, fileFacts, infoBox, liveExplain, optionPanel, selectField } from '../option-ui.js';

const TARGETS = [
  { id: '-14', label: '−14 LUFS — loud, for social video' },
  { id: '-16', label: '−16 LUFS — podcast standard' },
  { id: '-19', label: '−19 LUFS — soft, for background' },
  { id: 'match', label: 'Just match the loudest file' },
];
const TARGET_PHRASE = {
  '-14': '−14 LUFS (loud, the social-video standard)',
  '-16': '−16 LUFS (podcast standard)',
  '-19': '−19 LUFS (soft, for background listening)',
};
const TARGET_DONE = {
  '-14': 'social-video loudness',
  '-16': 'podcast loudness',
  '-19': 'background loudness',
  match: 'the loudest recording',
};
const FORMATS = [
  { id: 'mp3', label: 'MP3 — plays everywhere (128 kbps)' },
  { id: 'm4a', label: 'M4A — better quality, same size' },
  { id: 'wav', label: 'WAV — no quality loss, big' },
];
const FORMAT_SHORT = { mp3: 'MP3', m4a: 'M4A', wav: 'WAV' };

const fmtLufs = (v) => `${v.toFixed(1).replace('-', '−')} LUFS`;

export default function render(container, tool) {
  const ui = {};
  // File → { pending?, duration?, lufs?, error? } — measured lazily after add,
  // so the facts panel can name the loudest and quietest file before the run.
  const meta = new Map();
  let lastCtx = null;
  let alive = true;
  window.addEventListener('hashchange', () => { alive = false; }, { once: true });

  toolShell(container, tool, {
    accept: AUDIO_ACCEPT,
    multiple: true,
    sortable: true,
    pickLabel: 'Select audio files',
    dropLabel: 'or drop a whole folder of voice memos here',
    actionLabel: 'Fix volume',
    doneTitle: 'Your recordings are levelled!',
    downloadLabel: 'Download levelled audio',
    continueTo: ['enhance-voice', 'audio-merge', 'convert-audio'],
    note: 'Three group members record narration on three different phones, and one is always a whisper. Drop the whole folder here, pick “match the loudest”, and the final cut sounds like one room — without any file leaving your device.',

    async onFiles(ctx) { await measure(ctx); },
    onChange(ctx) { update(ctx); },

    options(host, ctx) {
      const panel = optionPanel('Fix volume');
      ui.facts = fileFacts();
      ui.target = selectField('Bring every file to', TARGETS, { value: '-16', onChange: () => update() });
      ui.compress = checkRow('Also even out volume within each file', {
        hint: 'Runs a light speech compressor first, so mumbling and near-shouting inside one recording end up closer together.',
        onChange: () => update(),
      });
      ui.format = selectField('Save as', FORMATS, { value: 'mp3', onChange: () => update() });
      ui.mp3note = infoBox('The first MP3 saved loads a small encoder (about 200 KB) into the page. That happens once per visit, and nothing about your audio leaves the device.');
      ui.explain = liveExplain();
      panel.add(ui.facts, ui.target, ui.compress, ui.format, ui.mp3note, ui.explain);
      host.appendChild(panel.root);
      update(ctx);
      return {};
    },

    async run(ctx) {
      const files = [...ctx.files];
      if (!files.length) throw new Error('Add a recording first.');
      for (const f of files) {
        if (meta.get(f)?.error) {
          throw new Error(`${f.name} could not be read as audio — remove it to level the rest.`);
        }
      }
      const mode = ui.target.value;
      const format = ui.format.value;
      const compress = ui.compress.value;
      const naming = uniqueNames();

      // "Match the loudest" needs every file measured before the first gain is
      // chosen. Usually the lazy measurement has already done this; anything
      // still pending is measured now, on the front slice of the progress bar.
      let target;
      let lead = 0;
      if (mode === 'match') {
        const missing = files.filter((f) => !Number.isFinite(meta.get(f)?.lufs));
        lead = missing.length ? 0.15 : 0;
        for (let i = 0; i < missing.length; i++) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          const file = missing[i];
          ctx.setBusy((i / missing.length) * lead, `Measuring ${file.name}…`);
          const buffer = await decodeAudio(file);
          meta.set(file, { duration: buffer.duration, lufs: await measureLoudness(buffer) });
          await breathe();
        }
        target = Math.max(...files.map((f) => meta.get(f).lufs));
      } else {
        target = Number(mode);
      }

      const outputs = [];
      const applied = [];
      const span = (1 - lead) / files.length;
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const file = files[i];
        const base = lead + i * span;
        const tag = files.length > 1 ? ` (${i + 1} of ${files.length})` : '';
        ctx.setBusy(base, `Reading ${file.name}${tag}…`);
        let buffer = await decodeAudio(file);
        if (ctx.signal?.aborted) throw new Error('canceled');
        if (compress) {
          ctx.setBusy(base + span * 0.2, `Evening out ${file.name}${tag}…`);
          buffer = await renderGraph(buffer, (c, src) => speechCompressor(c, src));
          if (ctx.signal?.aborted) throw new Error('canceled');
        }
        ctx.setBusy(base + span * 0.4, `Levelling ${file.name}${tag}…`);
        const { buffer: levelled, appliedDb } = await normalizeLoudness(buffer, target);
        applied.push(appliedDb);
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(base + span * 0.55, `Saving ${file.name} as ${FORMAT_SHORT[format]}${tag}…`);
        const { blob, ext } = await encodeBuffer(levelled, {
          format, kbps: 128, name: stem(file.name),
          signal: ctx.signal,
          onProgress: (f) => ctx.setBusy(base + span * (0.55 + f * 0.45), `Saving ${file.name} as ${FORMAT_SHORT[format]}${tag}…`),
        });
        outputs.push({ name: naming(`${stem(file.name)}-levelled.${ext}`), blob });
        await breathe();
      }

      return {
        outputs,
        doneTitle: doneTitleFor(files.length, mode, applied),
        zip: outputs.length > 1
          ? async () => {
            const zip = new JSZip();
            outputs.forEach((o) => zip.file(o.name, o.blob));
            downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-levelled.zip');
          }
          : undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Lazy measurement — the compress-pdf pending pattern: mark every fresh file
  // pending, then decode and measure them one at a time in the background while
  // the facts panel shows "…" for anything not finished yet.
  // -------------------------------------------------------------------------

  async function measure(ctx) {
    lastCtx = ctx;
    for (const key of [...meta.keys()]) if (!ctx.files.includes(key)) meta.delete(key);
    update(ctx);
    for (const file of [...ctx.files]) {
      if (!alive) return;
      if (meta.has(file)) continue;   // measured, in flight, or failed already
      meta.set(file, { pending: true });
      update(ctx);
      try {
        const buffer = await decodeAudio(file);
        const lufs = await measureLoudness(buffer);
        if (meta.has(file)) meta.set(file, { duration: buffer.duration, lufs });
      } catch (err) {
        if (meta.has(file)) meta.set(file, { error: err?.message ?? 'unreadable' });
      }
      update(ctx);
      await breathe();
    }
    for (const key of [...meta.keys()]) if (!ctx.files.includes(key)) meta.delete(key);
    update(ctx);
  }

  // -------------------------------------------------------------------------
  // Sidebar facts + the live sentence
  // -------------------------------------------------------------------------

  function update(ctx) {
    if (ctx) lastCtx = ctx;
    if (!ui.explain) return;
    ui.mp3note?.hide(ui.format.value !== 'mp3');

    const files = lastCtx?.files ?? [];
    const n = files.length;
    if (!n) { ui.facts.set([]); ui.explain.set(''); return; }

    const entries = files.map((f) => meta.get(f));
    const pending = entries.some((m) => !m || m.pending);
    const bad = entries.find((m) => m?.error);
    const measured = entries.filter((m) => Number.isFinite(m?.lufs));
    const total = measured.reduce((s, m) => s + m.duration, 0);
    const loudest = measured.length ? Math.max(...measured.map((m) => m.lufs)) : null;
    const quietest = measured.length ? Math.min(...measured.map((m) => m.lufs)) : null;

    const rows = [
      ['Files', String(n)],
      ['Total length', pending ? '…' : formatDuration(total)],
    ];
    if (n === 1) {
      rows.push(['Measured loudness', pending ? '…' : fmtLufs(loudest)]);
    } else {
      rows.push(
        ['Loudest file', pending ? '…' : fmtLufs(loudest)],
        ['Quietest file', pending ? '…' : fmtLufs(quietest)],
      );
    }
    ui.facts.set(rows);

    if (bad) {
      const name = files[entries.indexOf(bad)]?.name ?? 'One file';
      ui.explain.set(`${name} could not be read as audio — remove it to level the rest.`);
      return;
    }

    const mode = ui.target.value;
    const fmt = FORMAT_SHORT[ui.format.value];
    const head = n === 1 ? 'This recording' : `${n} recordings`;
    const compressTail = ui.compress.value ? ' Volume inside each file is evened out first.' : '';

    if (mode === 'match') {
      if (n === 1) {
        ui.explain.set('Matching the loudest needs at least two recordings — add more, or pick a loudness target instead.');
      } else if (pending) {
        ui.explain.set(`Still measuring the ${n} recordings — the quieter ones will be raised to match the loudest.${compressTail}`);
      } else {
        ui.explain.set(`${head} will be gained to match the loudest of them (${fmtLufs(loudest)}) as ${fmt} — one session, even if it was recorded on three different phones.${compressTail}`);
      }
      return;
    }
    ui.explain.set(
      `${head} will be brought to ${TARGET_PHRASE[mode]} as ${fmt} — ${n === 1 ? 'louder or softer as needed, never clipping' : 'quiet ones up, loud ones down, never clipping'}.${compressTail}`,
    );
  }

  function doneTitleFor(n, mode, applied) {
    const where = TARGET_DONE[mode];
    const db = (v) => `${Math.abs(v).toFixed(1)} dB`;
    if (n === 1) {
      const v = applied[0];
      const change = Math.abs(v) < 0.05 ? 'it was already there'
        : v > 0 ? `brought up ${db(v)}` : `brought down ${db(v)}`;
      return `Levelled to ${where} — ${change}.`;
    }
    const up = Math.max(...applied);
    const down = Math.min(...applied);
    const parts = [];
    if (up >= 0.05) parts.push(`quietest came up ${db(up)}`);
    if (down <= -0.05) parts.push(`loudest came down ${db(down)}`);
    return `${n} recordings levelled to ${where} — ${parts.length ? parts.join(', ') : 'they were already close'}.`;
  }

  /** Two memos from different folders can share a name; a ZIP is keyed by name. */
  function uniqueNames() {
    const used = new Set();
    return (name) => {
      if (!used.has(name)) { used.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const base = dot < 1 ? name : name.slice(0, dot);
      const ext = dot < 1 ? '' : name.slice(dot);
      let i = 2;
      while (used.has(`${base}-${i}${ext}`)) i++;
      used.add(`${base}-${i}${ext}`);
      return `${base}-${i}${ext}`;
    };
  }
}
