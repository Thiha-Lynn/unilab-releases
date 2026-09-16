import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { downloadBlob, el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  TAB_ICONS, checkRow, fileFacts, liveExplain, measureField, numberField,
  optionPanel, repeatRows, segmented, tabCards, textField,
} from '../option-ui.js';

// Three ways to cut a PDF, matching how people actually describe the job:
// by ranges they name, into fixed-size chunks, or under a size limit.
const MODES = [
  { id: 'range', label: 'Range', icon: TAB_ICONS.range },
  { id: 'pages', label: 'Pages', icon: TAB_ICONS.pages },
  { id: 'size', label: 'Size', icon: TAB_ICONS.size },
];

const MAX_PREVIEW_PAGES = 60;   // rendering every page of a 900-page book helps nobody
const MAX_PREVIEW_GROUPS = 24;

export default function render(container, tool) {
  const state = { file: null, doc: null, pageCount: 0, thumbs: [], mode: 'range', rangeMode: 'custom' };
  const ui = {};   // the option controls, filled in by options()
  let groupsHost = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a PDF here',
    actionLabel: 'Split PDF',
    doneTitle: 'Your PDF has been split!',
    downloadLabel: 'Download split PDF',
    continueTo: ['merge-pdf', 'compress-pdf', 'organize-pdf', 'page-numbers-pdf'],
    note: 'Pulling chapter 3 out for a reading response, or one page out of a scanned form — both are two clicks, and the PDF never leaves your device.',

    // The workarea shows the pages grouped exactly as the current settings would
    // split them, so the outcome is visible before committing to it.
    workarea(host) { groupsHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Split');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.tabs = tabCards(MODES, (t) => { state.mode = t.id; syncVisibility(); update(); });

      ui.rangeMode = segmented(
        [{ id: 'custom', label: 'Custom' }, { id: 'fixed', label: 'Fixed' }],
        (m) => { state.rangeMode = m.id; syncVisibility(); update(); },
      );

      ui.ranges = repeatRows({
        label: 'Range',
        addLabel: '+ Add range',
        onChange: update,
        make: (index) => {
          const wrap = el(`<div></div>`);
          const numbers = el(`<div class="opt__row"></div>`);
          const max = state.pageCount || 9999;
          const from = numberField('from page', { value: 1, min: 1, max, onChange: update });
          const to = numberField('to', { value: state.pageCount || 1, min: 1, max, onChange: update });
          numbers.append(from.root, to.root);
          // Naming a range is what turns "split this" into "give me the chapters".
          // The label becomes the output filename, so a 300-page textbook comes out
          // as cover.pdf / chapter-1.pdf / appendix.pdf rather than pages-12-48.pdf.
          const label = textField('label', {
            placeholder: index === 0 ? 'cover' : `part-${index + 1}`,
            maxLength: 60,
            onChange: update,
          });
          wrap.append(numbers, label.root);
          return {
            root: wrap,
            get value() { return { from: from.value, to: to.value, label: label.value.trim() }; },
            // Called when a document loads: a fresh range covers the whole file,
            // which is what "Range 1" should mean before anyone touches it.
            fit(n) { from.setMax(n); to.setMax(n); from.value = 1; to.value = n; },
          };
        },
      });

      ui.every = numberField('Split every', { value: 1, min: 1, max: 999, suffix: 'pages', onChange: update });
      ui.maxSize = measureField('Maximum size per file', {
        value: 2, min: 1, max: 999,
        units: [{ id: 'KB', label: 'KB' }, { id: 'MB', label: 'MB' }],
        unitActive: 1, onChange: update,
      });
      ui.merge = checkRow('Merge all ranges into one PDF file', { onChange: update });

      panel.add(ui.tabs, ui.facts, ui.rangeMode, ui.ranges, ui.every, ui.maxSize, ui.merge, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      const groups = plan();
      if (!groups.length) throw new Error('That selection covers no pages. Check the page numbers and try again.');

      const base = stem(state.file.name);
      const outputs = [];
      const merged = state.mode !== 'size' && ui.merge.value && groups.length > 1;

      if (merged) {
        const flat = [...new Set(groups.flat())].sort((a, b) => a - b);
        outputs.push({ name: `${base}-selected.pdf`, blob: await buildPdf(flat) });
      } else {
        for (let i = 0; i < groups.length; i++) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          ctx.setBusy(i / groups.length, `Writing file ${i + 1} of ${groups.length}…`);
          const g = groups[i];
          // A named range keeps its name; an unnamed one falls back to the pages
          // it covers, which is still better than "part 3".
          const fallback = g.length === 1 ? `page-${g[0]}` : `pages-${g[0]}-${g.at(-1)}`;
          outputs.push({ name: `${base}-${safeName(g.label) || fallback}.pdf`, blob: await buildPdf(g) });
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      return {
        outputs,
        doneTitle: outputs.length > 1
          ? `Your PDF has been split into ${outputs.length} files!`
          : 'Your PDF has been split!',
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}-split.zip`);
        },
      };
    },

    async thumbnail(file) {
      const pdf = await openPdf(file);
      return renderPage(pdf, 1, 0.5);
    },
  });

  // -------------------------------------------------------------------------

  function syncVisibility() {
    const { mode, rangeMode } = state;
    ui.rangeMode.root.hidden = mode !== 'range';
    ui.ranges.root.hidden = !(mode === 'range' && rangeMode === 'custom');
    ui.every.root.hidden = !((mode === 'range' && rangeMode === 'fixed') || mode === 'pages');
    ui.maxSize.root.hidden = mode !== 'size';
    ui.merge.root.hidden = mode === 'size';
  }

  async function loadFile() {
    const file = state.file;
    if (!file) { state.doc = null; state.pageCount = 0; state.thumbs = []; update(); return; }

    state.doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    state.pageCount = state.doc.getPageCount();
    paintFacts();
    // Bound every field by the real page count so page 40 of a 6-page file is
    // simply not expressible.
    for (const row of ui.ranges.rows) row.fit(state.pageCount);
    ui.every.setMax(Math.max(1, state.pageCount));
    update();
    await renderThumbs(file);
  }

  /** Current settings → a list of page-number groups (1-based). */
  function plan() {
    const { pageCount, mode, rangeMode } = state;
    if (!pageCount) return [];
    const all = Array.from({ length: pageCount }, (_, i) => i + 1);
    const chunk = (size) => {
      const out = [];
      for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
      return out;
    };

    if (mode === 'pages') return chunk(ui.every.value);
    if (mode === 'size') {
      // Pages are copied, not re-encoded, so the file's own bytes-per-page is
      // the honest estimate. The result screen shows what actually landed.
      const bytesPerPage = (state.file?.size ?? 0) / pageCount;
      const cap = ui.maxSize.value * (ui.maxSize.unit === 'MB' ? 1024 ** 2 : 1024);
      return chunk(Math.max(1, Math.floor(cap / Math.max(1, bytesPerPage))));
    }
    if (rangeMode === 'fixed') return chunk(ui.every.value);

    return ui.ranges.values
      .map(({ from, to, label }) => {
        const lo = Math.max(1, Math.min(from, to));
        const hi = Math.min(pageCount, Math.max(from, to));
        const pages = hi >= lo ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [];
        pages.label = label;
        return pages;
      })
      .filter((g) => g.length);
  }

  async function buildPdf(pages) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(state.doc, pages.map((p) => p - 1));
    copied.forEach((p) => out.addPage(p));
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  function update() {
    if (!state.pageCount) { ui.explain?.set(''); paintGroups(); return; }
    const groups = plan();
    const merged = state.mode !== 'size' && ui.merge.value && groups.length > 1;
    const count = merged ? 1 : groups.length;
    const pages = new Set(groups.flat()).size;

    ui.explain.set(
      !count
        ? 'That selection covers no pages yet.'
        : state.mode === 'size'
          ? `This PDF will be split into ${count} file${count === 1 ? '' : 's'} of no more than ${ui.maxSize.value} ${ui.maxSize.unit} each.`
          : `${pages} page${pages === 1 ? '' : 's'} will be saved as ${count} PDF file${count === 1 ? '' : 's'}.`,
    );
    paintFacts();
    paintGroups();
  }

  /**
   * The summary panel. Coverage is the number worth showing: on a 300-page book
   * split into chapters, "78% covered" is how you notice you forgot the index
   * before you export forty files and check them by hand.
   */
  function paintFacts() {
    if (!ui.facts || !state.file) return;
    const rows = [
      ['Original size', formatBytes(state.file.size)],
      ['Total pages', String(state.pageCount)],
    ];
    if (state.pageCount) {
      const groups = plan();
      const covered = new Set(groups.flat()).size;
      const merged = state.mode !== 'size' && ui.merge?.value && groups.length > 1;
      rows.push(
        ['Files to create', String(merged ? 1 : groups.length)],
        ['Pages covered', `${covered} of ${state.pageCount}`],
        ['Coverage', `${Math.round((covered / state.pageCount) * 100)}%`],
      );
      if (covered < state.pageCount) {
        rows.push(['Not in any range', String(state.pageCount - covered)]);
      }
    }
    ui.facts.set(rows);
  }

  async function renderThumbs(file) {
    if (!groupsHost) return;
    groupsHost.innerHTML = '<p class="ts__hint">Rendering pages…</p>';
    const pdf = await openPdf(file);
    const thumbs = [];
    for (let i = 1; i <= Math.min(state.pageCount, MAX_PREVIEW_PAGES); i++) {
      thumbs.push(await renderPage(pdf, i, 0.4));
      // Yield between pages so a long document never freezes the tab.
      await new Promise((r) => setTimeout(r, 0));
    }
    state.thumbs = thumbs;
    paintGroups();
  }

  function paintGroups() {
    if (!groupsHost) return;
    if (!state.thumbs.length) return;
    groupsHost.innerHTML = '';
    const groups = plan();
    for (const [i, group] of groups.slice(0, MAX_PREVIEW_GROUPS).entries()) {
      const box = el(`<div class="ts__group"><span class="ts__group__tag"></span><div class="ts__group__pages"></div></div>`);
      box.querySelector('.ts__group__tag').textContent =
        group.label ? group.label
          : state.mode === 'size' ? `File ${i + 1}`
            : `Range ${i + 1}`;
      const pagesHost = box.querySelector('.ts__group__pages');
      // A long range shows its first and last page with an ellipsis between —
      // showing forty identical thumbnails communicates nothing extra.
      const show = group.length > 4 ? [group[0], null, group.at(-1)] : group;
      for (const p of show) {
        if (p === null) { pagesHost.appendChild(el(`<span class="ts__group__more">…</span>`)); continue; }
        const cell = el(`<div class="ts__page"><span class="ts__page__n"></span></div>`);
        cell.querySelector('.ts__page__n').textContent = String(p);
        const src = state.thumbs[p - 1];
        if (src) cell.prepend(cloneCanvas(src));
        pagesHost.appendChild(cell);
      }
      groupsHost.appendChild(box);
    }
    if (groups.length > MAX_PREVIEW_GROUPS) {
      groupsHost.appendChild(el(`<p class="ts__hint">…and ${groups.length - MAX_PREVIEW_GROUPS} more files.</p>`));
    }

    // Pages nobody claimed. Showing them as their own group is the whole point of
    // a coverage number — it turns "78%" into the actual pages you missed.
    const covered = new Set(groups.flat());
    const loose = [];
    for (let p = 1; p <= state.pageCount; p++) if (!covered.has(p)) loose.push(p);
    if (loose.length) {
      const box = el(`<div class="ts__group ts__group--loose"><span class="ts__group__tag"></span><div class="ts__group__pages"></div></div>`);
      box.querySelector('.ts__group__tag').textContent = `Not in any range · ${loose.length} page${loose.length === 1 ? '' : 's'}`;
      const host = box.querySelector('.ts__group__pages');
      const show = loose.length > 8 ? [...loose.slice(0, 4), null, ...loose.slice(-3)] : loose;
      for (const p of show) {
        if (p === null) { host.appendChild(el(`<span class="ts__group__more">…</span>`)); continue; }
        const cell = el(`<div class="ts__page"><span class="ts__page__n"></span></div>`);
        cell.querySelector('.ts__page__n').textContent = String(p);
        const src = state.thumbs[p - 1];
        if (src) cell.prepend(cloneCanvas(src));
        host.appendChild(cell);
      }
      groupsHost.appendChild(box);
    }
  }

  /** A label a filesystem will accept, on every OS, in any script. */
  function safeName(label) {
    if (!label) return '';
    return label
      .replace(/[\\/:*?"<>|]/g, '-')     // characters Windows refuses outright
      .replace(/\s+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')   // no leading dot: that hides the file
      .slice(0, 60);
  }

  function cloneCanvas(source) {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(source, 0, 0);
    return c;
  }
}
