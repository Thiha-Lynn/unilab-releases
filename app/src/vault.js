// The results vault — UniLab's answer to iLovePDF's "File available time" dialog.
//
// Their version counts down two hours until *their servers* delete your upload.
// Ours counts down until the finished files are dropped from this tab's memory.
// The difference is the whole product: there is no second copy to wait on, so the
// countdown is something the user can verify rather than a promise they have to
// trust. Everything here is deliberately in-memory only — writing results to
// Cache Storage or OPFS would make the countdown survive a reload at the cost of
// leaving files on disk, which is the wrong trade for this product.

import { debug } from './log.js';

const DEFAULT_TTL_MINUTES = 30;

let items = [];          // { id, name, blob, url }
let expiresAt = 0;
let timer = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(snapshot()); } catch (err) { debug('[vault] listener failed:', err); }
  }
}

function snapshot() {
  return {
    count: items.length,
    bytes: items.reduce((sum, i) => sum + (i.blob?.size ?? 0), 0),
    msLeft: items.length ? Math.max(0, expiresAt - Date.now()) : 0,
    items,
  };
}

/** Revokes every object URL and drops the blobs. Safe to call at any time. */
export function purge({ silent = false } = {}) {
  for (const item of items) {
    if (item.url) {
      try { URL.revokeObjectURL(item.url); } catch { /* already gone */ }
    }
    item.blob = null;
  }
  items = [];
  expiresAt = 0;
  if (timer) { clearInterval(timer); timer = null; }
  if (!silent) notify();
}

/**
 * Hands a finished job's outputs to the vault and starts the countdown.
 * Returns the stored items, each with a `url` ready for a download link.
 */
export function store(outputs, { ttlMinutes = DEFAULT_TTL_MINUTES } = {}) {
  purge({ silent: true });
  items = outputs.map((out, i) => ({
    id: `${Date.now()}-${i}`,
    name: out.name,
    blob: out.blob,
    url: URL.createObjectURL(out.blob),
  }));
  expiresAt = Date.now() + ttlMinutes * 60_000;

  // One shared ticker rather than one per subscriber — the countdown only needs
  // to be right to the second.
  timer = setInterval(() => {
    if (Date.now() >= expiresAt) purge();
    else notify();
  }, 1000);

  notify();
  return items;
}

/** Subscribe to countdown ticks and purges. Returns an unsubscribe function. */
export function watch(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function state() {
  return snapshot();
}

/** "29:58" — the countdown string, matching how long a student would read it. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const TTL_MINUTES = DEFAULT_TTL_MINUTES;

// Leaving the page drops everything immediately — no waiting for the timer, and
// nothing lingering in a backgrounded tab.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => purge());
}
