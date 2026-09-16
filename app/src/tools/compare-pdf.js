import { PDFDocument, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import { downloadBlob, el, formatBytes, stem, toast } from '../ui.js';
import { openPdf } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, colorField, fileFacts, infoBox, liveExplain, optionPanel, segmented, sliderField,
} from '../option-ui.js';

// Draft 3 and draft 4 of a group report, and nobody wrote down what they changed.
//
// Two different answers are needed and they are not the same answer:
//   * a pixel diff says *where* on the page something moved — a figure, a table
//     cell, a number in a caption, anything that has no text layer at all;
//   * a text diff says *what* the words now say.
// This tool does both, because either one alone sends you hunting.
//
// The pixel pass runs on a deliberately small render (a few hundred pixels
// wide). That is not a shortcut: at that size, sub-pixel differences in font
// rasterising wash out and only real changes survive, and the luminance of every
// page of both files fits in memory so dragging the sensitivity slider is
// instant instead of re-rendering the whole document.

const DIFF_W = 320;            // width of the comparison render, in pixels
const MAX_PAGES = 50;          // past this the memory cost stops being kind to a phone
const MAX_RECTS_PER_PAGE = 40; // beyond this the honest answer is "this page was rewritten"
const MAX_TEXT_LINES = 400;    // per page, before the line diff falls back to a cheaper one

export default function render(container, tool) {
  const state = {
    a: null, b: null,           // { file, pdf, lib } — lib is the pdf-lib document
    pageCount: 0,
    limited: false,             // true when the document is longer than MAX_PAGES
    pages: [],                  // per page: luminance, fits, rects, text diff
    totals: { changes: 0, pages: 0 },
    ready: false,
    gen: 0,                     // bumped whenever the pair changes; stale work bails out
  };
  const ui = {};
  let dom = null;
  let observers = [];
  let sensitivityTimer = null;
  // The shell owns the live file array; workarea() hands us the ctx that wraps
  // it, and that is how "swap" and "choose different files" reach it.
  let shellCtx = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: true,
    minFiles: 2,
    pickLabel: 'Select two PDF files',
    dropLabel: 'or drop both of them here',
    actionLabel: 'Compare PDF',
    doneTitle: 'Your comparison is ready!',
    downloadLabel: 'Download the comparison',
    continueTo: ['merge-pdf', 'split-pdf'],
    note: 'Feed it the two drafts in the order they were written — the older one first. Everything is read on this device, so a report that is still confidential stays that way.',

    workarea(host, ctx) { shellCtx = ctx; buildWorkarea(host); },

    async onFiles(ctx) {
      // Exactly two. A third file has no meaning here, and silently ignoring it
      // would leave someone comparing the wrong pair without knowing.
      let extra = 0;
      if (ctx.files.length > 2) {
        extra = ctx.files.length - 2;
        ctx.files.length = 2;
      }
      await loadPair(ctx.files[0] ?? null, ctx.files[1] ?? null);
      if (extra) {
        throw new Error(`Compare PDF lines up exactly two files. I kept the first two and left ${extra} out — press “Choose different files” if that was the wrong pair.`);
      }
    },

    options(host) {
      const panel = optionPanel('Compare');

      ui.info = infoBox(
        'Both files are drawn page by page and compared pixel by pixel, so a moved figure or a changed number in a scanned table shows up even with no text to read. The words are compared separately, line by line. If a paragraph was added early on, everything after it shifts down and the whole rest of the page lights up — that is real, and the line list underneath tells you which words actually changed.',
      );
      ui.facts = fileFacts();

      ui.mode = segmented(
        [{ id: 'side', label: 'Side by side' }, { id: 'overlay', label: 'Overlay' }],
        () => { paintView(); update(); },
      );

      // Re-thresholding fifty pages of cached luminance is a few million
      // comparisons; debounced, dragging the slider stays smooth on a phone.
      ui.sensitivity = sliderField('Difference sensitivity', {
        value: 60, min: 5, max: 100, step: 5,
        onChange: () => {
          clearTimeout(sensitivityTimer);
          sensitivityTimer = setTimeout(() => {
            recomputeRects();
            paintBoxes();
            update();
          }, 140);
        },
      });

      ui.colour = colorField('Highlight colour', {
        value: '#d64545',
        onChange: () => paintBoxes(),
      });

      ui.onlyChanged = checkRow('Only show pages that changed', {
        hint: 'Also decides what goes in the marked-up PDF: ticked, it only carries the changed pages.',
        onChange: () => { paintView(); update(); },
      });

      ui.explain = liveExplain();

      panel.add(ui.info, ui.facts, ui.mode, ui.sensitivity, ui.colour, ui.onlyChanged, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.ready) throw new Error('Still lining the two drafts up. Give it a couple of seconds and press Compare again.');
      if (!state.totals.changes) {
        throw new Error('These two files look identical at this sensitivity. Drag “Difference sensitivity” up if you were expecting a change.');
      }

      // Sliced rather than run through short(): a filename with an ellipsis in
      // it looks like a broken download.
      const base = `${stem(state.a.file.name).slice(0, 28)}-vs-${stem(state.b.file.name).slice(0, 28)}`;
      const pdf = await buildMarkedPdf(ctx);
      const txt = new Blob([buildChangeList()], { type: 'text/plain;charset=utf-8' });
      const outputs = [
        { name: `${base}-changes.pdf`, blob: pdf },
        { name: `${base}-changes.txt`, blob: txt },
      ];

      return {
        outputs,
        doneTitle: `${state.totals.changes} change${state.totals.changes === 1 ? '' : 's'} on ${state.totals.pages} page${state.totals.pages === 1 ? '' : 's'}.`,
        downloadLabel: 'Download both files',
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
        },
      };
    },
  });

  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    state.gen++;
    clearTimeout(sensitivityTimer);
    dropObservers();
    state.a?.pdf?.destroy?.();
    state.b?.pdf?.destroy?.();
  });

  // ---------------------------------------------------------------------------
  // loading and the comparison pass

  async function loadPair(fileA, fileB) {
    const gen = ++state.gen;
    dropObservers();
    state.a?.pdf?.destroy?.();
    state.b?.pdf?.destroy?.();
    state.a = state.b = null;
    state.pages = [];
    state.totals = { changes: 0, pages: 0 };
    state.ready = false;
    paintView();

    if (!fileA || !fileB) {
      state.pageCount = 0;
      state.limited = false;
      ui.facts?.set(fileA ? [['First file', short(fileA.name, 26)], ['Waiting for', 'the second PDF']] : []);
      status(fileA ? 'One more PDF and the comparison starts by itself.' : '');
      update();
      return;
    }

    const [pdfA, pdfB] = await Promise.all([openPdf(fileA), openPdf(fileB)]);
    if (gen !== state.gen) { pdfA.destroy?.(); pdfB.destroy?.(); return; }

    state.a = { file: fileA, pdf: pdfA };
    state.b = { file: fileB, pdf: pdfB };
    const longest = Math.max(pdfA.numPages, pdfB.numPages);
    state.limited = longest > MAX_PAGES;
    state.pageCount = Math.min(longest, MAX_PAGES);

    ui.facts.set([
      ['A (older)', short(fileA.name, 24)],
      ['B (newer)', short(fileB.name, 24)],
      ['Pages', `${pdfA.numPages} vs ${pdfB.numPages}`],
      ['Size', `${formatBytes(fileA.size)} vs ${formatBytes(fileB.size)}`],
    ]);
    if (dom) dom.pair.textContent = `A · ${short(fileA.name, 28)}   ⇄   B · ${short(fileB.name, 28)}`;
    update();

    // Deliberately not awaited: comparing forty pages takes a while, and the
    // shell is waiting on onFiles() before it will even re-enable its button.
    // The run() guard on state.ready is what keeps the export honest.
    comparePass(gen).catch((err) => {
      if (gen === state.gen) status(`Could not finish comparing these two files: ${err.message}`);
    });
  }

  /**
   * Renders every page of both files small, keeps the luminance, and diffs the
   * text. This is the only expensive pass; everything the sidebar can change
   * afterwards is recomputed from what it leaves behind.
   */
  async function comparePass(gen) {
    const pages = [];
    for (let n = 1; n <= state.pageCount; n++) {
      if (gen !== state.gen) return;
      status(`Comparing page ${n} of ${state.pageCount}…`);

      const inA = n <= state.a.pdf.numPages;
      const inB = n <= state.b.pdf.numPages;
      const shape = await pageShape(inA ? state.a.pdf : state.b.pdf, n);
      const W = DIFF_W;
      const H = Math.max(40, Math.round(DIFF_W * shape.height / shape.width));

      const a = inA ? await renderFitted(state.a.pdf, n, W, H) : null;
      const b = inB ? await renderFitted(state.b.pdf, n, W, H) : null;

      const entry = {
        n, W, H, inA, inB,
        fitA: a?.fit ?? null,
        fitB: b?.fit ?? null,
        lumaA: a ? luminance(a.canvas) : null,
        lumaB: b ? luminance(b.canvas) : null,
        rects: [],
        text: [],
      };
      release(a?.canvas);
      release(b?.canvas);

      const linesA = inA ? await pageLines(state.a.pdf, n) : [];
      const linesB = inB ? await pageLines(state.b.pdf, n) : [];
      entry.text = diffLines(linesA, linesB);

      pages.push(entry);
      state.pages = pages;
      // Yield between pages so the tab stays alive on a long report, and so the
      // pages already compared can be looked at while the rest catch up.
      await new Promise((r) => setTimeout(r, 0));
    }

    if (gen !== state.gen) return;
    state.ready = true;
    recomputeRects();
    status('');
    paintView();
    update();
  }

  async function pageShape(pdf, n) {
    const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  }

  /** Draws one page centred inside a fixed W×H canvas on white, and reports the fit. */
  async function renderFitted(pdf, pageNo, W, H) {
    const page = await pdf.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const s = Math.min(W / base.width, H / base.height);
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const dx = (W - viewport.width) / 2;
    const dy = (H - viewport.height) / 2;
    // intent:'print' for the same reason pdf-utils uses it — a backgrounded tab
    // must not stall halfway through comparing a 40-page report.
    await page.render({
      canvasContext: ctx, viewport, canvas, intent: 'print',
      transform: [1, 0, 0, 1, dx, dy],
    }).promise;
    return { canvas, fit: { s, dx, dy, vw: base.width, vh: base.height } };
  }

  // ---------------------------------------------------------------------------
  // where it changed

  function recomputeRects() {
    if (!state.pages.length) { state.totals = { changes: 0, pages: 0 }; return; }
    // A high sensitivity means a small brightness difference already counts.
    const threshold = Math.max(4, Math.round(70 - ui.sensitivity.value * 0.62));
    let changes = 0;
    let changed = 0;

    for (const p of state.pages) {
      if (!p.inA || !p.inB) {
        // A page that only exists in one file is one enormous change.
        p.rects = [{ x0: 0, y0: 0, x1: p.W, y1: p.H, whole: true }];
      } else {
        const mask = new Uint8Array(p.W * p.H);
        let hits = 0;
        for (let i = 0; i < mask.length; i++) {
          if (Math.abs(p.lumaA[i] - p.lumaB[i]) > threshold) { mask[i] = 1; hits++; }
        }
        p.rects = hits ? groupRects(mask, p.W, p.H) : [];
        if (p.rects.length > MAX_RECTS_PER_PAGE) {
          p.rects = [{ x0: 0, y0: 0, x1: p.W, y1: p.H, whole: true }];
        }
      }
      if (p.rects.length) { changed++; changes += p.rects.length; }
    }
    state.totals = { changes, pages: changed };
  }

  /**
   * Changed pixels → a short list of rectangles.
   *
   * Row by row: find the runs of changed pixels, join runs separated by less
   * than a word-gap, then extend whichever rectangle from the row above overlaps
   * them. A rectangle that goes a few rows without a hit is closed. It is not
   * connected-component labelling and does not need to be — the output is a box
   * a human looks at, and boxing a whole changed sentence in one rectangle is
   * more useful than boxing each letter.
   */
  function groupRects(mask, W, H) {
    const gapX = Math.max(4, Math.round(W * 0.025));
    const gapY = Math.max(3, Math.round(H * 0.012));
    const minArea = Math.max(9, Math.round(W * H * 0.00025));
    let open = [];
    const closed = [];

    for (let y = 0; y < H; y++) {
      const runs = [];
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && mask[y * W + x] === 1;
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          const last = runs[runs.length - 1];
          if (last && start - last[1] <= gapX) last[1] = x;
          else runs.push([start, x]);
          start = -1;
        }
      }

      open = open.filter((r) => {
        if (y - r.lastRow <= gapY) return true;
        closed.push(r);
        return false;
      });

      for (const [a, b] of runs) {
        const touching = open.filter((r) => a < r.x1 + gapX && b > r.x0 - gapX);
        if (touching.length) {
          // One run can bridge two rectangles that were growing separately.
          const merged = touching.reduce((acc, r) => ({
            x0: Math.min(acc.x0, r.x0), x1: Math.max(acc.x1, r.x1),
            y0: Math.min(acc.y0, r.y0), y1: Math.max(acc.y1, r.y1),
            lastRow: y,
          }), { x0: a, x1: b, y0: y, y1: y + 1, lastRow: y });
          merged.y1 = Math.max(merged.y1, y + 1);
          open = open.filter((r) => !touching.includes(r));
          open.push(merged);
        } else {
          open.push({ x0: a, x1: b, y0: y, y1: y + 1, lastRow: y });
        }
      }
    }
    closed.push(...open);

    return closed
      .filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) >= minArea && r.x1 - r.x0 >= 3 && r.y1 - r.y0 >= 3)
      .sort((r, s) => r.y0 - s.y0 || r.x0 - s.x0);
  }

  // ---------------------------------------------------------------------------
  // what changed

  /** One page's text as reading-order lines. */
  async function pageLines(pdf, n) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      // Everything sharing a baseline (to within a couple of points) is one line.
      const key = Math.round((item.transform?.[5] ?? 0) / 2);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(item);
    }
    return [...rows.entries()]
      .sort((r, s) => s[0] - r[0])                    // PDF y grows upward; top line first
      .map(([, items]) => items
        .sort((i, j) => (i.transform?.[4] ?? 0) - (j.transform?.[4] ?? 0))
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean);
  }

  /** Longest-common-subsequence line diff → a list of − and + lines. */
  function diffLines(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n && !m) return [];
    if (n > MAX_TEXT_LINES || m > MAX_TEXT_LINES) {
      // A page with hundreds of lines is a table or a reference list; the cheap
      // set comparison still says what appeared and what vanished.
      const inB = new Set(b);
      const inA = new Set(a);
      return [
        ...a.filter((l) => !inB.has(l)).map((text) => ({ type: '-', text })),
        ...b.filter((l) => !inA.has(l)).map((text) => ({ type: '+', text })),
      ];
    }

    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }

    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ type: '-', text: a[i++] });
      else out.push({ type: '+', text: b[j++] });
    }
    while (i < n) out.push({ type: '-', text: a[i++] });
    while (j < m) out.push({ type: '+', text: b[j++] });
    return out;
  }

  // ---------------------------------------------------------------------------
  // the workarea

  function buildWorkarea(host) {
    if (dom) return;
    const root = el(`
      <div>
        <div class="actions" style="margin-top:0">
          <span class="ts__hint" style="margin:0" data-pair>Two PDFs, oldest first.</span>
          <span style="flex:1"></span>
          <button class="btn small secondary" data-swap type="button">Swap A and B</button>
          <button class="btn small secondary" data-change type="button">Choose different files</button>
        </div>
        <p class="ts__hint" data-status></p>
        <div data-view></div>
        <div data-text></div>
      </div>
    `);
    dom = {
      root,
      pair: root.querySelector('[data-pair]'),
      status: root.querySelector('[data-status]'),
      view: root.querySelector('[data-view]'),
      text: root.querySelector('[data-text]'),
      rows: new Map(),
    };

    root.querySelector('[data-swap]').addEventListener('click', () => {
      if (!state.a || !state.b) return;
      const files = shellFiles();
      if (files.length !== 2) return;
      files.reverse();
      loadPair(files[0], files[1]);
      toast('Swapped — B is now the newer draft.');
    });
    root.querySelector('[data-change]').addEventListener('click', () => {
      const files = shellFiles();
      files.length = 0;
      state.gen++;
      dropObservers();
      loadPair(null, null);
      shellCtx?.refresh();
      shellCtx?.stage('upload');
    });

    host.innerHTML = '';
    host.appendChild(root);
    paintView();
    update();
  }

  function shellFiles() { return shellCtx?.files ?? []; }

  function status(text) {
    if (!dom) return;
    dom.status.textContent = text;
    dom.status.hidden = !text;
  }

  function paintView() {
    if (!dom) return;
    dropObservers();
    dom.rows.clear();
    dom.view.innerHTML = '';
    dom.text.innerHTML = '';
    if (!state.pages.length) return;

    const shown = state.pages.filter((p) => !ui.onlyChanged?.value || p.rects.length);
    if (!shown.length) {
      dom.view.appendChild(el(`<p class="ts__hint">No page changed at this sensitivity — untick “Only show pages that changed” to see the documents anyway.</p>`));
      return;
    }

    if (ui.mode.value === 'overlay') paintOverlay(shown);
    else paintSideBySide(shown);
    paintTextDiff(shown);
  }

  function paintSideBySide(shown) {
    const grid = el(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"></div>`);
    const cols = ['a', 'b'].map((which) => {
      const box = el(`
        <div>
          <p class="ts__hint" style="margin:0 0 6px;font-weight:700"></p>
          <div data-col style="height:min(58vh,600px);overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--card)"></div>
        </div>
      `);
      box.querySelector('p').textContent = which === 'a'
        ? `A · ${short(state.a.file.name, 30)}`
        : `B · ${short(state.b.file.name, 30)}`;
      grid.appendChild(box);
      return box.querySelector('[data-col]');
    });
    // In the document before anything is observed or measured: a detached
    // column has no box for IntersectionObserver to intersect and no
    // clientWidth to render a page against.
    dom.view.appendChild(grid);

    for (const [which, col] of [['a', cols[0]], ['b', cols[1]]]) {
      for (const p of shown) col.appendChild(pageRow(p, which, '#ffffff'));
      observeColumn(col);
    }
    // Both columns hold the same pages at the same aspect, so mirroring the
    // scroll position keeps page 7 of the draft opposite page 7 of the redraft.
    syncScroll(cols[0], cols[1]);
  }

  function paintOverlay(shown) {
    const box = el(`
      <div>
        <p class="ts__hint" style="margin:0 0 6px;font-weight:700">Both drafts on one canvas — black means identical, anything that glows moved.</p>
        <div data-col style="height:min(58vh,600px);overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#111"></div>
      </div>
    `);
    const col = box.querySelector('[data-col]');
    dom.view.appendChild(box);
    for (const p of shown) col.appendChild(pageRow(p, 'overlay', '#000000'));
    observeColumn(col);
  }

  function pageRow(page, which, background) {
    const row = el(`
      <div style="margin-bottom:14px">
        <div data-frame style="position:relative;line-height:0;border:1px solid var(--line);border-radius:6px;overflow:hidden"></div>
        <span class="ts__page__n"></span>
      </div>
    `);
    // The frame reserves the page's shape before anything is drawn into it.
    // Without that every row would be zero pixels tall, they would all be "in
    // view" at once, and the lazy render would render the whole document.
    const frame = row.querySelector('[data-frame]');
    frame.style.background = background;
    frame.style.aspectRatio = `${page.W} / ${page.H}`;
    row.querySelector('.ts__page__n').textContent = pageLabel(page, which);
    row.dataset.page = String(page.n);
    row.dataset.doc = which;
    dom.rows.set(`${which}:${page.n}`, row);
    return row;
  }

  function pageLabel(page, which) {
    if (which === 'a' && !page.inA) return `Page ${page.n} — not in this draft`;
    if (which === 'b' && !page.inB) return `Page ${page.n} — removed in this draft`;
    const count = page.rects.length;
    if (which === 'overlay' || which === 'b') {
      return count ? `Page ${page.n} · ${count} change${count === 1 ? '' : 's'}` : `Page ${page.n} · unchanged`;
    }
    return `Page ${page.n}`;
  }

  /** Pages render only when they are about to be looked at. */
  function observeColumn(col) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        fillRow(entry.target);
      }
    }, { root: col, rootMargin: '400px 0px' });
    for (const row of col.children) io.observe(row);
    observers.push(io);
  }

  function dropObservers() {
    for (const io of observers) io.disconnect();
    observers = [];
  }

  async function fillRow(row) {
    if (row.dataset.filled) return;
    row.dataset.filled = '1';
    const gen = state.gen;
    const n = Number(row.dataset.page);
    const which = row.dataset.doc;
    const page = state.pages[n - 1];
    if (!page) return;

    const frame = row.querySelector('[data-frame]');
    const width = Math.max(160, Math.round(frame.clientWidth || 260));
    const height = Math.max(60, Math.round(width * page.H / page.W));

    try {
      let canvas;
      if (which === 'overlay') {
        canvas = await overlayCanvas(page, width, height);
      } else {
        const doc = which === 'a' ? state.a : state.b;
        const present = which === 'a' ? page.inA : page.inB;
        canvas = present ? (await renderFitted(doc.pdf, n, width, height)).canvas : blankCanvas(width, height);
      }
      if (gen !== state.gen) { release(canvas); return; }
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.display = 'block';
      frame.innerHTML = '';
      frame.appendChild(canvas);
      frame.style.aspectRatio = 'auto';   // the canvas sets the height from here on
      paintBoxesIn(row, page);
    } catch {
      // One page that refuses to render must not take the other 39 with it.
      frame.innerHTML = '';
      frame.style.aspectRatio = 'auto';
      frame.style.background = 'var(--card)';
      frame.appendChild(el(`<p class="ts__hint" style="margin:0;padding:16px;line-height:1.5">This page could not be drawn.</p>`));
    }
  }

  async function overlayCanvas(page, W, H) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    const a = page.inA ? await renderFitted(state.a.pdf, page.n, W, H) : null;
    const b = page.inB ? await renderFitted(state.b.pdf, page.n, W, H) : null;
    if (a) ctx.drawImage(a.canvas, 0, 0);
    if (b) {
      // 'difference' subtracts one draft from the other: identical ink cancels to
      // black, and everything that moved is left glowing.
      ctx.globalCompositeOperation = a ? 'difference' : 'source-over';
      ctx.drawImage(b.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    release(a?.canvas);
    release(b?.canvas);
    return canvas;
  }

  function blankCanvas(W, H) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2f3f7';
    ctx.fillRect(0, 0, W, H);
    return canvas;
  }

  /** Rectangles are fractions of the same fitted box in both columns. */
  function paintBoxesIn(row, page) {
    const frame = row.querySelector('[data-frame]');
    frame.querySelectorAll('[data-box]').forEach((n) => n.remove());
    if (!frame.querySelector('canvas')) return;
    const colour = ui.colour?.value ?? '#d64545';
    for (const r of page.rects) {
      const node = el(`<div data-box></div>`);
      Object.assign(node.style, {
        position: 'absolute',
        left: `${(r.x0 / page.W) * 100}%`,
        top: `${(r.y0 / page.H) * 100}%`,
        width: `${((r.x1 - r.x0) / page.W) * 100}%`,
        height: `${((r.y1 - r.y0) / page.H) * 100}%`,
        border: `2px solid ${colour}`,
        borderRadius: '2px',
        background: `${colour}22`,
        pointerEvents: 'none',
      });
      frame.appendChild(node);
    }
  }

  function paintBoxes() {
    if (!dom) return;
    for (const [key, row] of dom.rows) {
      const n = Number(key.split(':')[1]);
      const page = state.pages[n - 1];
      if (!page) continue;
      row.querySelector('.ts__page__n').textContent = pageLabel(page, row.dataset.doc);
      if (row.dataset.filled) paintBoxesIn(row, page);
    }
  }

  function paintTextDiff(shown) {
    const withText = shown.filter((p) => p.text.length);
    if (!withText.length) {
      dom.text.appendChild(el(`<p class="ts__hint">No wording changed — whatever moved is a picture, a table rule or a layout shift.</p>`));
      return;
    }
    const panel = el(`<div class="panel" style="margin-top:16px"><h3 style="margin:0 0 12px;font-size:15px">What the words say now</h3></div>`);
    let printed = 0;
    for (const p of withText) {
      if (printed > 160) {
        panel.appendChild(el(`<p class="ts__hint">…and more. The full list is in the .txt file you download.</p>`));
        break;
      }
      const head = el(`<p style="margin:14px 0 4px;font-size:12.5px;font-weight:700;color:var(--muted)"></p>`);
      head.textContent = `Page ${p.n}`;
      panel.appendChild(head);
      for (const line of p.text.slice(0, 12)) {
        const node = el(`<p style="margin:2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5;word-break:break-word"></p>`);
        node.style.color = line.type === '-' ? 'var(--danger)' : 'var(--good)';
        node.textContent = `${line.type} ${line.text}`;
        panel.appendChild(node);
        printed++;
      }
      if (p.text.length > 12) {
        panel.appendChild(el(`<p class="ts__hint" style="margin:2px 0">…${p.text.length - 12} more line${p.text.length - 12 === 1 ? '' : 's'} on this page.</p>`));
      }
    }
    dom.text.appendChild(panel);
  }

  function syncScroll(one, two) {
    let lock = false;
    const link = (from, to) => from.addEventListener('scroll', () => {
      if (lock) return;
      lock = true;
      const fromRange = from.scrollHeight - from.clientHeight;
      const toRange = to.scrollHeight - to.clientHeight;
      to.scrollTop = fromRange > 0 ? (from.scrollTop / fromRange) * toRange : 0;
      // Released on a timer, not rAF: a background tab stops firing frames and
      // the columns would stay welded together until you looked at them again.
      setTimeout(() => { lock = false; }, 0);
    }, { passive: true });
    link(one, two);
    link(two, one);
  }

  // ---------------------------------------------------------------------------
  // output

  /** The newer draft with every change boxed, ready to print or hand to a tutor. */
  async function buildMarkedPdf(ctx) {
    const libA = await PDFDocument.load(await state.a.file.arrayBuffer(), { ignoreEncryption: true });
    const libB = await PDFDocument.load(await state.b.file.arrayBuffer(), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const colour = hexToRgb(ui.colour.value);
    const wanted = state.pages.filter((p) => (ui.onlyChanged.value ? p.rects.length : true));
    if (!wanted.length) throw new Error('Nothing to export — untick “Only show pages that changed” or drag the sensitivity up.');

    // The newer draft is the one worth marking up; a page that only exists in
    // the older one is carried over so the deletion is visible too. Copy each
    // source in one call, or pdf-lib re-embeds the document's fonts per page.
    const idxB = wanted.filter((p) => p.inB).map((p) => p.n - 1);
    const idxA = wanted.filter((p) => !p.inB).map((p) => p.n - 1);
    const gotB = idxB.length ? await out.copyPages(libB, idxB) : [];
    const gotA = idxA.length ? await out.copyPages(libA, idxA) : [];
    const fromB = new Map(idxB.map((idx, i) => [idx, gotB[i]]));
    const fromA = new Map(idxA.map((idx, i) => [idx, gotA[i]]));

    for (const [i, p] of wanted.entries()) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(i / wanted.length, `Boxing page ${i + 1} of ${wanted.length}…`);

      const page = out.addPage(p.inB ? fromB.get(p.n - 1) : fromA.get(p.n - 1));

      // The rectangles live in comparison-canvas pixels; the stored fit and
      // convertToPdfPoint put them back on the real page, rotation and all.
      const fit = p.inB ? p.fitB : p.fitA;
      const vp = (await (p.inB ? state.b : state.a).pdf.getPage(p.n)).getViewport({ scale: 1 });
      for (const r of p.rects) {
        const [x0, y0] = vp.convertToPdfPoint((r.x0 - fit.dx) / fit.s, (r.y0 - fit.dy) / fit.s);
        const [x1, y1] = vp.convertToPdfPoint((r.x1 - fit.dx) / fit.s, (r.y1 - fit.dy) / fit.s);
        page.drawRectangle({
          x: Math.min(x0, x1), y: Math.min(y0, y1),
          width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
          borderColor: colour,
          borderWidth: 1.2,
        });
      }
      await new Promise((done) => setTimeout(done, 0));
    }

    ctx.setBusy(1, 'Saving…');
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  function buildChangeList() {
    const lines = [];
    lines.push('UniLab — Compare PDF');
    lines.push(`A (older): ${state.a.file.name} — ${state.a.pdf.numPages} pages`);
    lines.push(`B (newer): ${state.b.file.name} — ${state.b.pdf.numPages} pages`);
    lines.push(`Difference sensitivity: ${ui.sensitivity.value}`);
    lines.push(`${state.totals.changes} change${state.totals.changes === 1 ? '' : 's'} on ${state.totals.pages} page${state.totals.pages === 1 ? '' : 's'}.`);
    if (state.limited) lines.push(`Only the first ${MAX_PAGES} pages were compared.`);
    lines.push('');
    lines.push('“-” is the line as it was in A. “+” is the line as it is now in B.');
    lines.push('='.repeat(60));

    const quiet = [];
    for (const p of state.pages) {
      if (!p.rects.length && !p.text.length) { quiet.push(p.n); continue; }
      lines.push('');
      if (!p.inB) lines.push(`Page ${p.n} — this page is gone from ${state.b.file.name}`);
      else if (!p.inA) lines.push(`Page ${p.n} — this page is new in ${state.b.file.name}`);
      else lines.push(`Page ${p.n} — ${p.rects.length} changed region${p.rects.length === 1 ? '' : 's'}`);
      for (const line of p.text) lines.push(`  ${line.type} ${line.text}`);
      if (!p.text.length) lines.push('  (nothing in the words changed — a figure, a table rule or the layout moved)');
    }

    if (quiet.length) {
      lines.push('');
      lines.push(`Unchanged pages: ${quiet.join(', ')}`);
    }
    lines.push('');
    lines.push('Compared entirely inside the browser. Neither file was uploaded anywhere.');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    if (!state.a || !state.b) {
      ui.explain.set(state.a ? 'Add the second PDF and the comparison starts on its own.' : '');
      return;
    }
    if (!state.ready) {
      ui.explain.set('Reading both files page by page — the boxes appear as it goes.');
      return;
    }
    const { changes, pages } = state.totals;
    if (!changes) {
      ui.explain.set('No differences at this sensitivity. Drag the slider up if you were expecting some.');
      return;
    }
    const where = ui.mode.value === 'overlay'
      ? 'The overlay stacks the two drafts and subtracts one from the other, so anything that moved glows.'
      : 'Both drafts scroll together with each change boxed on both sides.';
    const scope = ui.onlyChanged.value
      ? `You will get the ${pages} changed page${pages === 1 ? '' : 's'} of the newer draft with the boxes drawn in`
      : 'You will get the whole newer draft with the boxes drawn in';
    ui.explain.set(`${changes} change${changes === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}. ${where} ${scope}, plus a .txt listing every line that changed.${state.limited ? ` Only the first ${MAX_PAGES} pages were compared.` : ''}`);
  }

}

function luminance(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }
  return out;
}

/** Canvases hold their pixels until they are collected; this frees them now. */
function release(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function short(name, max = 30) {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
