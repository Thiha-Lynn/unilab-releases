import { icon } from './icons.js';
import './styles.css';
import { el, formatBytes } from './ui.js';
import { CATEGORIES, TOOLS } from './registry.js';
import { registerServiceWorker } from './register-sw.js';
import { debug, debugError } from './log.js';
import { renderPrivacy } from './privacy.js';
import { isPackagedApp } from './native-save.js';
import { renderInstall } from './install.js';

registerServiceWorker();

// The registry lives in registry.js so tools can import it without a cycle;
// re-exported here because that is where everything already looks for it.
export { CATEGORIES, TOOLS } from './registry.js';


const app = document.getElementById('app');
let activeCategory = 'all';
let searchQuery = '';

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------
function renderHome() {
  document.title = 'UniLab — Every tool a student needs';
  app.innerHTML = '';
  const wrap = el(`<div class="wrap"></div>`);

  wrap.appendChild(el(`
    <header class="topbar">
      <div class="logo"><span class="mark">${icon("brand")}</span><span>Uni<b>Lab</b></span></div>
      <a class="btn secondary small" href="#/install">Get UniLab</a>
    </header>
  `));

  const hero = el(`
    <section class="hero">
      <h1>Your files. Your tools.<br>On your device.</h1>
      <p>Work with PDFs, images, video and audio in one private workspace.
         No account or file uploads. Choose a tool to get started.</p>
      <div class="search">
        <span class="icon">${icon("search")}</span>
        <input type="search" placeholder="Search tools… (e.g. compress video, PDF, GPA)" aria-label="Search tools" />
      </div>
    </section>
  `);
  const searchInput = hero.querySelector('input');
  searchInput.value = searchQuery;
  searchInput.addEventListener('input', () => { searchQuery = searchInput.value; renderGrid(); });
  wrap.appendChild(hero);

  const pills = el(`<nav class="pills" aria-label="Tool categories"></nav>`);
  const cats = [['all', 'All tools'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.name])];
  for (const [key, label] of cats) {
    const b = el(`<button aria-pressed="${key === activeCategory}" class="pill${key === activeCategory ? ' active' : ''}"></button>`);
    b.textContent = label;
    b.addEventListener('click', () => {
      activeCategory = key;
      pills.querySelectorAll('.pill').forEach((p) => { p.classList.remove('active'); p.setAttribute('aria-pressed', 'false'); });
      b.setAttribute('aria-pressed', 'true');
      b.classList.add('active');
      renderGrid();
    });
    pills.appendChild(b);
  }
  wrap.appendChild(pills);

  const grid = el(`<div class="grid" id="tool-grid"></div>`);
  wrap.appendChild(grid);

  function renderGrid() {
    const q = searchQuery.trim().toLowerCase();
    const visible = TOOLS.filter((t) =>
      (activeCategory === 'all' || t.category === activeCategory) &&
      (!q || `${t.name} ${t.desc} ${t.category}`.toLowerCase().includes(q))
    );
    grid.innerHTML = '';
    if (!visible.length) {
      const empty = el('<div class="empty-state"></div>');
      empty.textContent = `No tools match “${q}” — try another word.`;
      grid.appendChild(empty);
      return;
    }
    for (const t of visible) {
      const color = CATEGORIES[t.category].color;
      const card = el(`
        <button class="tool-card" style="--cc:${color}">
          <div class="icon">${t.icon}</div>
          <span class="cat">${CATEGORIES[t.category].name}</span>
          <h3></h3>
          <p></p>
        </button>
      `);
      card.querySelector('h3').textContent = t.name;
      card.querySelector('p').textContent = t.desc;
      card.addEventListener('click', () => { location.hash = `#/${t.id}`; });
      grid.appendChild(card);
    }
  }
  renderGrid();

  wrap.appendChild(el(`
    <footer class="footer">
      <p><b>Private by design:</b> every tool runs 100% in your browser.
      Your files are processed on your device. No file uploads, accounts or ads.</p>
      <p>UniLab · free, open-source tools for everyday file tasks</p>
      <p>Free &amp; open source — <a href="https://github.com/Thiha-Lynn/unilab-releases" target="_blank" rel="noopener">Contribute on GitHub</a>
      &nbsp;·&nbsp; <a href="#/privacy">Privacy</a>
      &nbsp;·&nbsp; <a href="#/install">Install · v${__APP_VERSION__}</a></p>
    </footer>
  `));

  // Offline-mode block (see buildOfflineBlock below). Hidden entirely when
  // the browser has no Service Worker support.
  if ('serviceWorker' in navigator && !isPackagedApp()) {
    wrap.querySelector('.footer').appendChild(buildOfflineBlock());
  }

  app.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Offline mode (home footer block)
// ---------------------------------------------------------------------------
// Must match CACHE_NAME in public/sw.js — if that bumps, bump this with it so
// the "already downloaded" flag resets for the new cache version.
const SW_CACHE_NAME = `unilab-${__RELEASE_ID__}`;
const OFFLINE_FLAG = `unilab.offline.${SW_CACHE_NAME}`;

function buildOfflineBlock() {
  const block = el(`
    <div style="margin-top:18px">
      <button class="btn secondary small">Make UniLab work offline</button>
      <p class="note" style="margin-bottom:0"></p>
      <p class="note" style="margin-top:6px">Download the core tools in under 8 MB. OCR and background removal need extra engines or model data on first use; prepare those while online. Large files are limited by your device.</p>
    </div>
  `);
  const btn = block.querySelector('button');
  const status = block.querySelector('.note'); // first .note is the status line

  // Restore the "already downloaded" state — but only trust the flag if the
  // versioned cache still exists (the browser may have evicted it).
  if (localStorage.getItem(OFFLINE_FLAG)) {
    caches.has(SW_CACHE_NAME).then((exists) => {
      if (exists) status.textContent = 'Available offline';
      else localStorage.removeItem(OFFLINE_FLAG);
    }).catch(() => {});
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Preparing download…';
    try {
      // Wait (briefly) for an active service worker — on the very first visit
      // it may still be installing, and registration can also have failed.
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('sw-not-ready')), 4000)),
      ]);
      if (!registration.active) throw new Error('sw-not-ready');

      // Best-effort storage check first — the page can't know the download
      // size up front, so this only warns when space is clearly tight; real
      // quota failures surface as PRECACHE_ERROR from the worker.
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota && est.quota - (est.usage || 0) < 50 * 1024 * 1024) {
          status.textContent = 'Heads up: device storage is nearly full — this may not fit…';
        }
      } catch (_) { /* estimate unsupported — fine */ }

      const onMessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('PRECACHE_')) return;
        if (msg.type === 'PRECACHE_PROGRESS') {
          const cur = Math.min(msg.done + 1, msg.total);
          status.textContent = `Downloading tool ${cur} of ${msg.total}…`;
        } else if (msg.type === 'PRECACHE_DONE') {
          navigator.serviceWorker.removeEventListener('message', onMessage);
          btn.disabled = false;
          if (msg.failed) {
            status.textContent = `Note: ${msg.total - msg.failed} of ${msg.total} files saved (${formatBytes(msg.bytes)}) — ${msg.failed} failed. Try again for full offline support.`;
          } else {
            localStorage.setItem(OFFLINE_FLAG, String(Date.now()));
            status.textContent = `Core tools saved for offline use (${formatBytes(msg.bytes)}). OCR and background removal require their optional downloads first.`;
          }
        } else if (msg.type === 'PRECACHE_ERROR') {
          navigator.serviceWorker.removeEventListener('message', onMessage);
          btn.disabled = false;
          status.textContent = 'Note: Download stopped — your device storage may have run out. Free some space and try again.';
          debug('[offline] precache failed at:', msg.url, msg.error);
        }
      };
      navigator.serviceWorker.addEventListener('message', onMessage);
      registration.active.postMessage({ type: 'PRECACHE_ALL' });
    } catch (err) {
      btn.disabled = false;
      status.textContent = 'Offline setup isn’t ready yet — reload the page once, then try again.';
      debug('[offline]', err);
    }
  });

  return block;
}

// ---------------------------------------------------------------------------
// Tool page
// ---------------------------------------------------------------------------
async function renderTool(tool) {
  document.title = `${tool.name} — UniLab`;
  app.innerHTML = '';
  const color = CATEGORIES[tool.category].color;
  const wrap = el(`<div class="wrap tool-page" style="--cc:${color}"></div>`);
  wrap.appendChild(el(`<a class="backlink" href="#/">← All tools</a>`));
  wrap.appendChild(el(`
    <div class="tool-head">
      <div class="icon">${tool.icon}</div>
      <h1>${tool.name}</h1>
      <p>${tool.desc}</p>
    </div>
  `));
  const container = el(`<div></div>`);
  wrap.appendChild(container);
  app.appendChild(wrap);

  try {
    const mod = await tool.load();
    mod.default(container, tool);
  } catch (err) {
    debugError(err);
    container.appendChild(el(`<div class="error-box">This tool failed to load: ${err.message}</div>`));
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route() {
  const id = location.hash.replace(/^#\/?/, '');
  const tool = TOOLS.find((t) => t.id === id);
  if (tool) renderTool(tool);
  // Not a tool, but a page rule.md PDPA 25 requires us to ship.
  else if (id === 'install') { app.innerHTML = ''; renderInstall(app); }
  else if (id === 'privacy') { app.innerHTML = ''; renderPrivacy(app); }
  else renderHome();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
