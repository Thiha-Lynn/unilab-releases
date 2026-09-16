// Shared UI pieces for the video & audio tools: previews, the trim timeline,
// the cancellable progress bar, and the result card. Built on the same helpers
// as every other UniLab tool (see ui.js) so the media pages don't feel bolted on.

import JSZip from 'jszip';
import { el, formatBytes, downloadBlob, toast } from './ui.js';
import { formatDuration, parseTimecode } from './media-utils.js';

// ---------------------------------------------------------------------------
// Preview player
// ---------------------------------------------------------------------------

/**
 * A `<video>`/`<audio>` element wired to a blob URL, with the cleanup that
 * blob URLs need. Always call `destroy()` when swapping files, or the browser
 * holds the whole file in memory.
 */
export function mediaPreview(file, { kind = 'video', muted = false } = {}) {
  const url = URL.createObjectURL(file);
  const node = kind === 'audio'
    ? el(`<audio class="media-el" controls preload="metadata"></audio>`)
    : el(`<video class="media-el" controls playsinline preload="metadata"></video>`);
  node.muted = muted;
  node.src = url;
  return {
    node,
    url,
    destroy() {
      try { node.pause(); } catch { /* already detached */ }
      node.removeAttribute('src');
      try { node.load(); } catch { /* not every browser needs this */ }
      URL.revokeObjectURL(url);
    },
  };
}

/** The "1:23 · 1280×720 · 12.4 MB" strip shown under a loaded file. */
export function mediaStats(probe) {
  const row = el(`<div class="stat-row media-stats"></div>`);
  const add = (v, k) => {
    const s = el(`<div class="stat"><span class="v"></span><span class="k"></span></div>`);
    s.querySelector('.v').textContent = v;
    s.querySelector('.k').textContent = k;
    row.appendChild(s);
  };
  add(formatDuration(probe.duration), 'Length');
  if (probe.video) {
    add(`${probe.video.width}×${probe.video.height}`, 'Resolution');
    if (probe.video.frameRate) add(`${Math.round(probe.video.frameRate)} fps`, 'Frame rate');
  }
  if (probe.audio) add(probe.audio.channels === 1 ? 'Mono' : 'Stereo', `Audio · ${probe.audio.codec ?? '—'}`);
  else if (probe.video) add('None', 'Audio');
  add(formatBytes(probe.size), 'File size');
  return row;
}

// ---------------------------------------------------------------------------
// Trim timeline
// ---------------------------------------------------------------------------

/**
 * A two-handle timeline for picking a start and an end, with timecode boxes
 * that accept "12", "1:15" or "1:02:03". Returns `{ root, get, set, setDuration,
 * setPlayhead }`; `onChange({start, end})` fires while dragging.
 *
 * Pointer events (not mouse events) so it works with touch and stylus — this is
 * the one control students will use on a phone.
 */
export function trimBar({ duration = 0, onChange, onScrub } = {}) {
  let total = duration;
  let start = 0;
  let end = duration;

  const root = el(`
    <div class="trim">
      <div class="trim-bar" role="group" aria-label="Trim range">
        <div class="trim-track"></div>
        <div class="trim-sel"></div>
        <div class="trim-play" hidden></div>
        <button class="trim-handle" data-h="start" aria-label="Start of clip"></button>
        <button class="trim-handle" data-h="end" aria-label="End of clip"></button>
      </div>
      <div class="trim-fields">
        <div class="field">
          <label>Start</label>
          <input type="text" data-start inputmode="decimal" placeholder="0:00" />
        </div>
        <div class="field">
          <label>End</label>
          <input type="text" data-end inputmode="decimal" placeholder="0:00" />
        </div>
        <div class="trim-len">Clip length <b data-len>0:00</b></div>
      </div>
    </div>
  `);

  const bar = root.querySelector('.trim-bar');
  const sel = root.querySelector('.trim-sel');
  const playhead = root.querySelector('.trim-play');
  const hStart = root.querySelector('[data-h="start"]');
  const hEnd = root.querySelector('[data-h="end"]');
  const fStart = root.querySelector('[data-start]');
  const fEnd = root.querySelector('[data-end]');
  const lenOut = root.querySelector('[data-len]');

  const pct = (t) => (total > 0 ? (t / total) * 100 : 0);

  function paint({ typing = false } = {}) {
    sel.style.left = `${pct(start)}%`;
    sel.style.width = `${Math.max(0, pct(end) - pct(start))}%`;
    hStart.style.left = `${pct(start)}%`;
    hEnd.style.left = `${pct(end)}%`;
    lenOut.textContent = formatDuration(Math.max(0, end - start), { decimals: 1 });
    if (!typing) {
      fStart.value = formatDuration(start, { decimals: 1 });
      fEnd.value = formatDuration(end, { decimals: 1 });
    }
  }

  function commit(opts) {
    paint(opts);
    onChange?.({ start, end });
  }

  function timeFromEvent(e) {
    const rect = bar.getBoundingClientRect();
    const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    return Math.min(total, Math.max(0, ratio * total));
  }

  // A handle keeps pointer capture for the whole drag, so the pointer can leave
  // the bar without the drag getting stuck.
  for (const handle of [hStart, hEnd]) {
    const which = handle.dataset.h;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const t = timeFromEvent(e);
      if (which === 'start') start = Math.min(t, end - 0.05);
      else end = Math.max(t, start + 0.05);
      start = Math.max(0, start);
      end = Math.min(total, end);
      commit();
      onScrub?.(which === 'start' ? start : end);
    });
    const release = (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -step;
      else if (e.key === 'ArrowRight') delta = step;
      else return;
      e.preventDefault();
      if (which === 'start') start = Math.max(0, Math.min(start + delta, end - 0.05));
      else end = Math.min(total, Math.max(end + delta, start + 0.05));
      commit();
      onScrub?.(which === 'start' ? start : end);
    });
  }

  // Clicking the empty track moves whichever handle is nearer.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.trim-handle')) return;
    const t = timeFromEvent(e);
    if (Math.abs(t - start) <= Math.abs(t - end)) start = Math.min(t, end - 0.05);
    else end = Math.max(t, start + 0.05);
    commit();
    onScrub?.(t);
  });

  function readField(input, which) {
    const t = parseTimecode(input.value);
    if (t === null) return;
    if (which === 'start') start = Math.max(0, Math.min(t, end - 0.05));
    else end = Math.min(total, Math.max(t, start + 0.05));
    commit({ typing: true });
  }
  fStart.addEventListener('input', () => readField(fStart, 'start'));
  fEnd.addEventListener('input', () => readField(fEnd, 'end'));
  fStart.addEventListener('blur', () => paint());
  fEnd.addEventListener('blur', () => paint());

  paint();

  return {
    root,
    get: () => ({ start, end }),
    set(nextStart, nextEnd) {
      start = Math.max(0, Math.min(nextStart, total));
      end = Math.max(start + 0.05, Math.min(nextEnd, total));
      commit();
    },
    setDuration(d) {
      total = d;
      start = 0;
      end = d;
      commit();
    },
    setPlayhead(t) {
      if (!Number.isFinite(t) || total <= 0) { playhead.hidden = true; return; }
      playhead.hidden = false;
      playhead.style.left = `${pct(t)}%`;
    },
  };
}

/**
 * Keeps a `<video>`/`<audio>` element and a trim bar in sync: the playhead
 * follows playback, playback loops inside the selected range, and scrubbing a
 * handle seeks the preview so you can see the exact frame you're cutting on.
 */
export function linkPlayerToTrim(player, trim) {
  const onTime = () => {
    trim.setPlayhead(player.currentTime);
    const { start, end } = trim.get();
    if (player.currentTime > end + 0.05 || player.currentTime < start - 0.05) {
      if (!player.paused) player.currentTime = start;
    }
  };
  player.addEventListener('timeupdate', onTime);
  return () => player.removeEventListener('timeupdate', onTime);
}

// ---------------------------------------------------------------------------
// Progress with a cancel button
// ---------------------------------------------------------------------------

/**
 * Progress bar + percentage + Cancel. Media jobs can take a minute on a long
 * clip, so every one of them must be interruptible — `job.signal` is handed to
 * `convertMedia`, and pressing Cancel aborts it.
 */
export function jobProgress({ cancelLabel = 'Cancel' } = {}) {
  const root = el(`
    <div class="job" hidden>
      <div class="progress-bar"><div></div></div>
      <div class="job-row">
        <span class="progress-label"></span>
        <button class="btn secondary small" data-cancel></button>
      </div>
    </div>
  `);
  const fill = root.querySelector('.progress-bar > div');
  const label = root.querySelector('.progress-label');
  const cancelBtn = root.querySelector('[data-cancel]');
  cancelBtn.textContent = cancelLabel;

  let controller = null;

  cancelBtn.addEventListener('click', () => {
    controller?.abort();
    label.textContent = 'Canceling…';
    cancelBtn.disabled = true;
  });

  return {
    root,
    get signal() { return controller?.signal; },
    get canceled() { return !!controller?.signal.aborted; },
    start(text = 'Working…') {
      controller = new AbortController();
      root.hidden = false;
      cancelBtn.disabled = false;
      fill.style.width = '0%';
      label.textContent = text;
      return controller.signal;
    },
    update(fraction, text) {
      const pct = Math.min(100, Math.max(0, Math.round((fraction || 0) * 100)));
      fill.style.width = `${pct}%`;
      label.textContent = text ?? `${pct}%`;
    },
    stop() {
      root.hidden = true;
      controller = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

/**
 * The green "done" panel: headline stats, a download button per output, a
 * "download all" ZIP when there are several, and any track warnings.
 *
 * outputs: [{ name, blob }]   stats: [[value, label], …]
 */
export function resultCard({ heading, message, stats = [], outputs = [], warnings = [], zipName = 'unilab-media.zip', preview }) {
  const box = el(`
    <div class="result">
      <h3></h3>
      <p hidden></p>
      <div class="stat-row" hidden></div>
      <div class="result-preview" hidden></div>
      <div class="actions"></div>
    </div>
  `);
  box.querySelector('h3').textContent = heading;
  const msg = box.querySelector('p');
  if (message) { msg.hidden = false; msg.textContent = message; }

  const statRow = box.querySelector('.stat-row');
  if (stats.length) {
    statRow.hidden = false;
    for (const [v, k] of stats) {
      const s = el(`<div class="stat"><span class="v"></span><span class="k"></span></div>`);
      s.querySelector('.v').textContent = v;
      s.querySelector('.k').textContent = k;
      statRow.appendChild(s);
    }
  }

  if (preview) {
    const host = box.querySelector('.result-preview');
    host.hidden = false;
    host.appendChild(preview);
  }

  const actions = box.querySelector('.actions');
  for (const out of outputs) {
    const b = el(`<button class="btn secondary small"></button>`);
    b.textContent = `⬇ ${out.name} (${formatBytes(out.blob.size)})`;
    b.addEventListener('click', () => downloadBlob(out.blob, out.name));
    actions.appendChild(b);
  }
  if (outputs.length > 1) {
    const zipBtn = el(`<button class="btn small">⬇ Download all (.zip)</button>`);
    zipBtn.addEventListener('click', async () => {
      zipBtn.disabled = true;
      zipBtn.textContent = 'Zipping…';
      try {
        const zip = new JSZip();
        outputs.forEach((o) => zip.file(o.name, o.blob));
        downloadBlob(await zip.generateAsync({ type: 'blob' }), zipName);
        toast('ZIP downloaded');
      } finally {
        zipBtn.disabled = false;
        zipBtn.textContent = '⬇ Download all (.zip)';
      }
    });
    actions.appendChild(zipBtn);
  }

  for (const w of warnings) {
    const note = el(`<p class="note warn-note"></p>`);
    note.textContent = `⚠ ${w}`;
    box.appendChild(note);
  }
  return box;
}

/** A row of one-click preset buttons. `onPick(preset)` fires on click. */
export function presetRow(presets, onPick, { activeIndex = -1 } = {}) {
  const row = el(`<div class="chip-row"></div>`);
  presets.forEach((p, i) => {
    const chip = el(`<button class="chip" type="button"></button>`);
    chip.textContent = p.label;
    if (p.hint) chip.title = p.hint;
    if (i === activeIndex) chip.classList.add('active');
    chip.addEventListener('click', () => {
      row.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      onPick(p, i);
    });
    row.appendChild(chip);
  });
  return row;
}
