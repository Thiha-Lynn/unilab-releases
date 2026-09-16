// Compress PDF — the iLovePDF three-level compressor, rebuilt honestly, plus a
// "must be under X" target mode they don't offer.
//
// How it actually compresses: every page is re-rendered to a canvas and
// re-encoded as a JPEG, then the JPEGs are rebuilt into a fresh PDF at the
// original page sizes. That is why it works so well on scanned readings and
// slide exports — and why the output pages are pictures: text stops being
// selectable and searchable. The UI says so up front instead of hiding it.
//
// Where iLovePDF puts batch compression behind Premium, this one takes as many
// PDFs as you drop on it, on-device, for nothing.

import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { canvasToBlob, downloadBlob, el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, fileFacts, infoBox, liveExplain, measureField, optionPanel, tabCards,
} from '../option-ui.js';

const ICON_CHECK = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M6.2 12.1L2.4 8.3l1.2-1.2 2.6 2.6 6.2-6.2 1.2 1.2z"/></svg>`;

const MODES = [
  { id: 'level', label: 'Level', icon: TAB_ICONS.percent },
  { id: 'target', label: 'Target size', icon: TAB_ICONS.size, note: 'Give a size cap instead of a quality level' },
];

// The three iLovePDF-style levels, with our own honest descriptions.
const LEVELS = [
  { id: 'extreme', name: 'Extreme', title: 'Extreme compression', desc: 'Smallest file, visibly rougher pages.', scale: 1.2, quality: 0.45 },
  { id: 'recommended', name: 'Recommended', title: 'Recommended compression', desc: 'Good quality, good compression.', scale: 1.5, quality: 0.7 },
  { id: 'low', name: 'Low', title: 'Low compression', desc: 'High quality, mildly smaller file.', scale: 2, quality: 0.85 },
];

// Target mode's ladder: start at Recommended, then step down until the file
// fits under the cap or the rungs run out.
const RUNGS = [
  { quality: 0.7, scale: 1.5 },
  { quality: 0.6, scale: 1.4 },
  { quality: 0.5, scale: 1.2 },
  { quality: 0.4, scale: 1.0 },
  { quality: 0.3, scale: 0.9 },
];

export default function render(container, tool) {
  const state = { mode: 'level', level: 'recommended' };
  const ui = {};
  const meta = new Map();   // File → { pages, pending?, error? }
  // Declared up here, not next to update(): toolShell() calls back synchronously
  // during mount, so anything those callbacks touch must already be initialised.
  let lastCtx = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: true,
    sortable: true,
    pickLabel: 'Select PDF files',
    dropLabel: 'or drop them here — batches welcome',
    actionLabel: 'Compress PDF',
    doneTitle: 'Your PDF is compressed!',
    downloadLabel: 'Download compressed PDF',
    continueTo: ['merge-pdf', 'split-pdf', 'page-numbers-pdf'],
    note: 'Most LMS upload boxes cap a single file somewhere between 2 and 50 MB, and the error only shows up after the upload fails. “Target size” exists for exactly that moment: type the cap the box enforces and let the tool find the best quality that fits under it.',

    // First page of each file as the card thumbnail.
    async thumbnail(file) {
      const pdf = await openPdf(file);
      const canvas = await renderPage(pdf, 1, 0.5);
      try { pdf.destroy(); } catch { /* already gone */ }
      return canvas;
    },

    async onFiles(ctx) {
      await countPages(ctx);
    },

    onChange(ctx) { update(ctx); },

    options(host, ctx) {
      const panel = optionPanel('Compress');
      ui.facts = fileFacts();
      ui.explain = liveExplain();
      ui.honesty = infoBox('Compression re-draws every page as a picture (JPEG). Files get much smaller, but text stops being selectable and searchable — fine for uploading, wrong for editing.');

      ui.tabs = tabCards(MODES, (t) => { state.mode = t.id; syncVisibility(); update(); });

      ui.levels = levelCards(LEVELS, (lv) => { state.level = lv.id; update(); }, { active: 1 });

      ui.maxSize = measureField('Must be under', {
        value: 2, min: 1, max: 999,
        units: [{ id: 'KB', label: 'KB' }, { id: 'MB', label: 'MB' }],
        unitActive: 1,
        hint: 'Starts at Recommended quality, then steps down until each file fits.',
        onChange: update,
      });

      panel.add(ui.tabs, ui.facts, ui.levels, ui.maxSize, ui.honesty, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update(ctx);
      return {};
    },

    async run(ctx) {
      const files = [...ctx.files];
      if (!files.length) throw new Error('Add at least one PDF first.');
      const naming = uniqueNames();

      if (state.mode === 'target') return runTarget(ctx, files, naming);
      return runLevel(ctx, files, naming);
    },
  });

  // -------------------------------------------------------------------------
  // Level mode: one pass per file at the chosen scale/quality.

  async function runLevel(ctx, files, naming) {
    const level = LEVELS.find((l) => l.id === state.level) ?? LEVELS[1];
    const outputs = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const blob = await compressFile(file, level, (p, total) => {
        ctx.setBusy(
          (i + (p - 1) / total) / files.length,
          `${file.name} — page ${p} of ${total}${files.length > 1 ? ` (file ${i + 1} of ${files.length})` : ''}`,
        );
      }, ctx.signal);
      outputs.push({ name: naming(`${stem(file.name)}-compressed.pdf`), blob });
    }

    const grew = outputs.filter((o, i) => o.blob.size >= files[i].size).length;
    return {
      outputs,
      showSavings: true,
      doneTitle:
        grew === files.length
          ? (files.length > 1
            ? 'These PDFs were already small — the new copies are no smaller.'
            : 'That PDF was already small — the new copy is no smaller. Keep the original.')
          : (files.length > 1 ? `All ${files.length} PDFs are compressed!` : 'Your PDF is compressed!'),
      zip: zipper(outputs),
    };
  }

  // -------------------------------------------------------------------------
  // Target mode: Recommended first, then down the ladder until it fits.

  async function runTarget(ctx, files, naming) {
    const cap = ui.maxSize.value * (ui.maxSize.unit === 'MB' ? 1024 ** 2 : 1024);
    const capText = `${ui.maxSize.value} ${ui.maxSize.unit}`;
    const outputs = [];
    const misses = [];   // { name, over }
    let untouched = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let best = null;   // smallest attempt so far
      let fitted = null; // first attempt under the cap

      for (let a = 0; a < RUNGS.length; a++) {
        const rung = RUNGS[a];
        const blob = await compressFile(file, rung, (p, total) => {
          const prefix = a > 0 ? `Attempt ${a + 1} — quality ${Math.round(rung.quality * 100)}% · ` : '';
          ctx.setBusy(
            (i + (a + (p - 1) / total) / RUNGS.length) / files.length,
            `${prefix}${file.name}, page ${p} of ${total}${files.length > 1 ? ` (file ${i + 1} of ${files.length})` : ''}`,
          );
        }, ctx.signal);
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= cap) { fitted = blob; break; }
      }

      if (fitted) {
        outputs.push({ name: naming(`${stem(file.name)}-compressed.pdf`), blob: fitted });
      } else if (file.size <= cap) {
        // Every rasterized attempt came out over the cap, but the original was
        // already under it. Handing over a bigger, worse file would be absurd —
        // the untouched original wins, and keeps its selectable text.
        outputs.push({ name: naming(file.name), blob: file });
        untouched++;
      } else {
        outputs.push({ name: naming(`${stem(file.name)}-compressed.pdf`), blob: best });
        misses.push({ name: file.name, over: best.size - cap });
      }
    }

    let doneTitle;
    if (!misses.length) {
      doneTitle = files.length > 1 ? `All ${files.length} PDFs fit under ${capText}!` : `Your PDF fits under ${capText}!`;
      if (untouched) doneTitle += ` ${untouched === 1 ? 'One was' : `${untouched} were`} already under it and left untouched.`;
    } else if (files.length === 1) {
      doneTitle = `Couldn't reach ${capText} — the smallest version is ${formatBytes(outputs[0].blob.size)}, ${formatBytes(misses[0].over)} over the cap.`;
    } else {
      const worst = misses.reduce((m, x) => (x.over > m.over ? x : m));
      doneTitle = `${files.length - misses.length} of ${files.length} fit under ${capText} — ${misses.length} could not, the furthest off by ${formatBytes(worst.over)} (${worst.name}).`;
    }

    return { outputs, showSavings: true, doneTitle, zip: zipper(outputs) };
  }

  // -------------------------------------------------------------------------
  // The compressor itself: render each page, JPEG it, rebuild with pdf-lib at
  // the original page sizes so the result prints identically.

  async function compressFile(file, { scale, quality }, onPage, signal) {
    let pdf;
    try {
      pdf = await openPdf(file);
    } catch (err) {
      throw new Error(`${file.name}: ${err?.message ?? 'could not be opened as a PDF'}`);
    }
    try {
      const out = await PDFDocument.create();
      for (let p = 1; p <= pdf.numPages; p++) {
        if (signal?.aborted) throw new Error('canceled');
        onPage(p, pdf.numPages);
        const canvas = await renderPage(pdf, p, scale);
        const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
        canvas.width = 0; canvas.height = 0;   // release the bitmap right away
        const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const outPage = out.addPage([vp.width, vp.height]);
        outPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
        // Yield between pages so cancel gets a turn and the tab never freezes.
        await new Promise((r) => setTimeout(r, 0));
      }
      return new Blob([await out.save()], { type: 'application/pdf' });
    } finally {
      try { pdf.destroy(); } catch { /* already gone */ }
    }
  }

  function zipper(outputs) {
    return async () => {
      const zip = new JSZip();
      outputs.forEach((o) => zip.file(o.name, o.blob));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-compressed.zip');
    };
  }

  /**
   * Two PDFs picked from different folders can share a filename, and a ZIP is
   * keyed by name — the second would quietly replace the first. Repeats get a
   * -2, -3 suffix instead.
   */
  function uniqueNames() {
    const used = new Set();
    return (name) => {
      if (!used.has(name)) { used.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const base = dot < 1 ? name : name.slice(0, dot);
      const ext = dot < 1 ? '' : name.slice(dot);
      let n = 2;
      while (used.has(`${base}-${n}${ext}`)) n++;
      used.add(`${base}-${n}${ext}`);
      return `${base}-${n}${ext}`;
    };
  }

  // -------------------------------------------------------------------------
  // Sidebar plumbing

  /**
   * The three stacked level cards — iLovePDF's compression picker, built from
   * the existing .opt__tab pieces laid out as full-width rows: a bold title, an
   * honest one-line description, and the green check on the active one.
   */
  function levelCards(levels, onPick, { active = 0 } = {}) {
    const root = el(`<div class="opt__tabs" role="radiogroup" aria-label="Compression level" style="grid-template-columns:1fr"></div>`);
    const nodes = levels.map((lv, i) => {
      const card = el(`
        <button class="opt__tab" type="button" role="radio" style="align-items:flex-start;text-align:left;padding:11px 14px 10px;gap:3px">
          <span class="opt__tab__badge">${ICON_CHECK}</span>
          <span class="opt__tab__label" style="font-size:12.5px;letter-spacing:.03em;text-transform:uppercase"></span>
          <span class="opt__hint"></span>
        </button>
      `);
      card.querySelector('.opt__tab__label').textContent = lv.title;
      card.querySelector('.opt__hint').textContent = lv.desc;
      card.setAttribute('aria-checked', String(i === active));
      if (i === active) card.classList.add('is-active');
      card.addEventListener('click', () => select(i));
      root.appendChild(card);
      return card;
    });
    let current = active;
    function select(i) {
      current = i;
      nodes.forEach((n, j) => {
        n.classList.toggle('is-active', j === i);
        n.setAttribute('aria-checked', String(j === i));
      });
      onPick?.(levels[i], i);
    }
    return { root, select, get value() { return levels[current]?.id ?? null; } };
  }

  function syncVisibility() {
    ui.levels.root.hidden = state.mode !== 'level';
    ui.maxSize.root.hidden = state.mode !== 'target';
  }

  /** Page counts for the facts panel, cached per file. */
  async function countPages(ctx) {
    for (const file of [...ctx.files]) {
      if (meta.has(file)) continue;
      meta.set(file, { pages: 0, pending: true });
      try {
        const pdf = await openPdf(file);
        meta.set(file, { pages: pdf.numPages });
        try { pdf.destroy(); } catch { /* already gone */ }
      } catch (err) {
        meta.set(file, { pages: 0, error: err?.message ?? 'unreadable' });
      }
      update(ctx);
    }
    for (const key of [...meta.keys()]) if (!ctx.files.includes(key)) meta.delete(key);
    update(ctx);
  }

  function update(ctx) {
    if (ctx) lastCtx = ctx;
    const files = lastCtx?.files ?? [];
    if (!ui.explain) return;

    if (!files.length) {
      ui.explain.set('');
      ui.facts?.set([]);
      return;
    }

    const n = files.length;
    const entries = files.map((f) => meta.get(f));
    const pending = entries.some((m) => !m || m.pending);
    const pages = entries.reduce((s, m) => s + (m?.pages ?? 0), 0);

    ui.facts.set([
      ['Files', String(n)],
      ['Total size', formatBytes(files.reduce((s, f) => s + f.size, 0))],
      ['Total pages', pending ? '…' : String(pages)],
    ]);

    if (state.mode === 'target') {
      const capText = `${ui.maxSize.value} ${ui.maxSize.unit}`;
      ui.explain.set(
        n > 1
          ? `Each PDF will be squeezed under ${capText}, stepping down quality until it fits — pages become images, text will no longer be selectable.`
          : `This PDF will be squeezed under ${capText}, stepping down quality until it fits — pages become images, text will no longer be selectable.`,
      );
    } else {
      const name = (LEVELS.find((l) => l.id === state.level) ?? LEVELS[1]).name;
      ui.explain.set(
        n > 1
          ? `${n} PDFs will be compressed at the ${name} level — pages become images, text will no longer be selectable.`
          : `This PDF will be compressed at the ${name} level — pages become images, text will no longer be selectable.`,
      );
    }
  }
}
