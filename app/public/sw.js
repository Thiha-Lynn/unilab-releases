// UniLab service worker
// Plain ES2020 service-worker script — no imports, no bundler.
// Strategy: cache-first for the app shell, with runtime caching of
// same-origin GET responses so hashed asset chunks get cached as they're
// visited (exact hashed filenames aren't known at write-time, so we can't
// precache everything up front).

const CACHE_NAME = 'unilab-v4';
const PRECACHE_URLS = ['./', './index.html'];

// ---------------------------------------------------------------------------
// install: open the cache and best-effort precache the app shell.
// Never fail install just because a precache URL couldn't be fetched.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        try {
          await cache.addAll(PRECACHE_URLS);
        } catch (err) {
          // Ignore individual precache failures (e.g. offline at install time,
          // or a URL that doesn't resolve at this scope) — runtime caching
          // will pick things up as the user actually visits pages.
          console.warn('[sw] precache addAll failed (non-fatal):', err);
        }
      } catch (err) {
        console.warn('[sw] install: could not open cache (non-fatal):', err);
      }
    })()
  );
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// activate: clean up old cache versions that don't match CACHE_NAME.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith('unilab-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        );
      } catch (err) {
        console.warn('[sw] activate: cache cleanup failed (non-fatal):', err);
      }
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// fetch strategy:
//  - Navigations (the HTML shell): NETWORK-first, cache fallback. Cache-first
//    here would pin returning visitors to a stale index.html forever, since
//    sw.js itself rarely changes between deploys. Network-first means a deploy
//    reaches users on their next visit, while offline still serves the cache.
//  - Everything else (Vite's content-hashed assets are immutable): cache-first
//    with runtime caching, so tool chunks work offline once visited.
// Never let a caching error break a fetch — always fall back to network.
// ---------------------------------------------------------------------------
async function stashInCache(request, response) {
  try {
    const isSameOrigin = new URL(request.url).origin === self.location.origin;
    if (isSameOrigin && response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
  } catch (err) {
    console.warn('[sw] runtime cache put failed (non-fatal):', err);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests; let everything else (POST, etc.) pass through.
  if (request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          await stashInCache(request, networkResponse);
          return networkResponse;
        } catch (err) {
          const cached = await caches.match(request).catch(() => null)
            || await caches.match('./index.html').catch(() => null)
            || await caches.match('./').catch(() => null);
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
      } catch (err) {
        console.warn('[sw] cache match failed (non-fatal):', err);
      }

      try {
        const networkResponse = await fetch(request);
        await stashInCache(request, networkResponse);
        return networkResponse;
      } catch (err) {
        // Network failed too (offline, no cache hit). Nothing more we can do.
        console.warn('[sw] fetch failed and no cache match:', err);
        throw err;
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// message: explicit offline core precache. The home page's
// "Make UniLab work offline" button posts { type: 'PRECACHE_ALL' }.
// precache.json is written at build time (see vite.config.js) and lists every
// core app file (optional AI runtimes excluded); each entry is fetched and stored in the SAME versioned cache the
// fetch handler reads from. OCR/model downloads must be prepared separately.
// Replies to the requesting page:
//   { type: 'PRECACHE_PROGRESS', done, total }      after each batch
//   { type: 'PRECACHE_DONE', bytes, failed, total } on completion
//   { type: 'PRECACHE_ERROR', url, error }          on a hard failure
// Hard failures (abort the run): precache.json unreachable, cache unopenable,
// cache.put throwing (usually storage quota). Individual fetch failures are
// soft: skipped, counted, and reported in PRECACHE_DONE.failed.
// ---------------------------------------------------------------------------
const PRECACHE_BATCH_SIZE = 4;

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'PRECACHE_ALL') return;

  const source = event.source;
  const post = (msg) => {
    try {
      if (source) { source.postMessage(msg); return; }
      // No source (shouldn't happen for page-sent messages) — broadcast.
      self.clients.matchAll({ includeUncontrolled: true })
        .then((cs) => cs.forEach((c) => c.postMessage(msg)))
        .catch(() => {});
    } catch (err) {
      console.warn('[sw] precache postMessage failed (non-fatal):', err);
    }
  };

  event.waitUntil((async () => {
    // 1. Get the build manifest. Failing here is a hard failure.
    let urls;
    try {
      const res = await fetch('./precache.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      urls = await res.json();
      if (!Array.isArray(urls)) throw new Error('precache.json is not an array');
    } catch (err) {
      post({ type: 'PRECACHE_ERROR', url: './precache.json', error: String(err) });
      return;
    }

    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (err) {
      post({ type: 'PRECACHE_ERROR', url: '', error: String(err) });
      return;
    }

    // 2. Fetch + cache in small parallel batches, reporting progress.
    const total = urls.length;
    let done = 0;
    let failed = 0;
    let bytes = 0;
    post({ type: 'PRECACHE_PROGRESS', done, total });

    for (let i = 0; i < total; i += PRECACHE_BATCH_SIZE) {
      const batch = urls.slice(i, i + PRECACHE_BATCH_SIZE);
      try {
        await Promise.all(batch.map(async (url) => {
          let res;
          try {
            res = await fetch(url);
          } catch (err) {
            failed += 1; // network hiccup on one file: skip it, keep going
            return;
          }
          if (!res || !res.ok) { failed += 1; return; }
          try {
            await cache.put(url, res.clone());
          } catch (err) {
            // cache.put throwing usually means the storage quota is full —
            // every later put would fail too, so abort the whole run.
            try { err.precacheUrl = url; } catch (_) { /* not extensible */ }
            throw err;
          }
          // Sum sizes where readable; a failure here must not fail the run.
          try { bytes += (await res.blob()).size; } catch (_) { /* fine */ }
        }));
      } catch (err) {
        post({ type: 'PRECACHE_ERROR', url: (err && err.precacheUrl) || '', error: String(err) });
        return;
      }
      done = Math.min(i + PRECACHE_BATCH_SIZE, total);
      post({ type: 'PRECACHE_PROGRESS', done, total });
    }

    post({ type: 'PRECACHE_DONE', bytes, failed, total });
  })());
});
