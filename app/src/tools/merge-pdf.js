import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { el, formatBytes, canvasToBlob } from '../ui.js';
import { openPdf, renderPage, parsePageRanges } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import { optionPanel, fileFacts, textField, checkRow, liveExplain } from '../option-ui.js';

// Merge, but with the trick iLovePDF keeps behind the "Organize" paywall: you
// don't have to take whole files. Every row has a "pages" box — leave it as
// "all", or type "1-3, 7" and only those pages of that file join the merge.
// Cover from one PDF, chapter from another, appendix from a third → one file.

const TOC_TEXT = rgb(0.15, 0.15, 0.19);
const TOC_FAINT = rgb(0.45, 0.45, 0.5);
// Matches the stack the watermark tools use — Thai first, then whatever the OS
// falls back to for CJK and everything else.
const TOC_CANVAS_FONT = `-apple-system, "Segoe UI", system-ui, "Noto Sans Thai", "Noto Sans", sans-serif`;

const TOC_MARGIN = 56;
const TOC_TITLE_SIZE = 20;
const TOC_LINE_SIZE = 12;
const TOC_LEAD = 26;

function tocGeometry(pageH) {
  const top = pageH - TOC_MARGIN - TOC_TITLE_SIZE - 24;
  const perPage = Math.max(1, Math.floor((top - TOC_MARGIN) / TOC_LEAD));
  return { top, perPage };
}
function countTocPages(entryCount, pageH = 841.89) {
  return Math.ceil(entryCount / tocGeometry(pageH).perPage);
}

export default function render(container, tool) {
  // Per-file state, keyed by the File object itself so it survives reordering.
  // { doc, pageCount, thumb, rangeText, loading, loadError, rowEls }
  const meta = new Map();
  const ui = {};
  let rowsHost = null;
  let shellCtx = null;

  shellCtx = toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: true,
    minFiles: 2,
    sortable: true,
    pickLabel: 'Select PDF files',
    dropLabel: 'or drop them here — they merge top to bottom',
    actionLabel: 'Merge PDFs',
    doneTitle: 'Your PDFs have been merged!',
    downloadLabel: 'Download merged PDF',
    continueTo: ['compress-pdf', 'page-numbers-pdf', 'watermark-pdf'],
    note: 'Cover page + report + appendix → one file for submission. And the “pages” box on each row means you can take just pages 1-3 of one PDF and 7 of another — the kind of pick-and-merge that is a paid “Organize” tier elsewhere. Nothing leaves your device.',

    workarea(host, c) { rowsHost = host; shellCtx = c; paintRows(); },

    async onFiles(c) {
      shellCtx = c;
      // Drop metadata for files that are gone, load it for files that are new.
      for (const file of [...meta.keys()]) if (!c.files.includes(file)) meta.delete(file);
      const fresh = c.files.filter((f) => !meta.has(f));
      for (const file of fresh) meta.set(file, { rangeText: 'all', loading: true, pageCount: 0 });
      paintRows();
      update();
      for (const file of fresh) {
        await loadFile(file);
        // Yield between files so ten dropped PDFs never freeze the tab.
        await new Promise((r) => setTimeout(r, 0));
      }
    },

    options(host) {
      const panel = optionPanel('Merge');
      ui.facts = fileFacts();
      ui.name = textField('Output file name', { value: 'merged', maxLength: 80, onChange: update });
      ui.toc = checkRow('Add a numbered table of contents page', {
        hint: 'A first page listing each source file and the page it starts on.',
        onChange: update,
      });
      ui.explain = liveExplain();
      panel.add(ui.facts, ui.name, ui.toc, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(runCtx) {
      // Refuse before touching anything if a row can't be honoured, naming the file.
      for (const file of runCtx.files) {
        const m = meta.get(file);
        if (!m || m.loading) throw new Error(`Still reading ${file.name} — give it a second and try again.`);
        if (m.loadError) throw new Error(`${file.name} could not be read as a PDF (${m.loadError}). Remove it to merge the rest.`);
        const sel = selection(file);
        if (sel.error) throw new Error(`The “pages” box for ${file.name} isn't valid: ${sel.error}`);
      }

      const out = await PDFDocument.create();
      const entries = [];
      let cursor = 0;
      for (let i = 0; i < runCtx.files.length; i++) {
        if (runCtx.signal?.aborted) throw new Error('canceled');
        const file = runCtx.files[i];
        runCtx.setBusy((i / runCtx.files.length) * 0.85, `Adding ${file.name} (${i + 1} of ${runCtx.files.length})…`);
        const pages = selection(file).pages;
        const copied = await out.copyPages(meta.get(file).doc, pages.map((p) => p - 1));
        copied.forEach((pg) => out.addPage(pg));
        entries.push({ name: file.name, start: cursor + 1, count: pages.length });
        cursor += pages.length;
        await new Promise((r) => setTimeout(r, 0));
      }

      if (ui.toc.value) {
        if (runCtx.signal?.aborted) throw new Error('canceled');
        runCtx.setBusy(0.88, 'Writing the contents page…');
        await prependToc(out, entries);
      }

      runCtx.setBusy(0.96, 'Saving…');
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      const name = `${safeName(ui.name.value) || 'merged'}.pdf`;
      return {
        outputs: [{ name, blob }],
        doneTitle: `${runCtx.files.length} PDFs are now one ${out.getPageCount()}-page file!`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Loading a file: page count via pdf-lib (reused for the merge itself),
  // first-page thumbnail via pdf.js.
  // -------------------------------------------------------------------------

  async function loadFile(file) {
    const m = meta.get(file);
    if (!m) return;   // removed while we were queued
    try {
      m.doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      m.pageCount = m.doc.getPageCount();
      m.loading = false;
      paintRow(file);
      update();
      const pdf = await openPdf(file);
      m.thumb = await renderPage(pdf, 1, 0.3);
      paintRow(file);
    } catch (err) {
      m.loading = false;
      m.loadError = err?.message ?? 'unreadable';
      paintRow(file);
      update();
    }
  }

  /** The current page selection for one file: { pages: [1-based…], error }. */
  function selection(file) {
    const m = meta.get(file);
    if (!m || !m.pageCount) return { pages: [], error: null };
    const text = (m.rangeText ?? '').trim();
    if (!text || /^all$/i.test(text)) {
      return { pages: Array.from({ length: m.pageCount }, (_, i) => i + 1), error: null };
    }
    try {
      return { pages: parsePageRanges(text, m.pageCount), error: null };
    } catch (err) {
      return { pages: [], error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // The workarea: one row per file — thumbnail, name, page count, a "pages"
  // box, and reorder / remove buttons.
  // -------------------------------------------------------------------------

  function paintRows() {
    if (!rowsHost) return;
    rowsHost.innerHTML = '';
    const files = shellCtx?.files ?? [];
    if (!files.length) return;

    rowsHost.appendChild(el(`<p class="ts__hint">They merge top to bottom. “pages” takes all of a file, or just some of it — like <b>1-3, 7</b>.</p>`));
    const list = el(`<div class="file-list"></div>`);

    files.forEach((file, i) => {
      const wrap = el(`
        <div>
          <div class="file-row">
            <span class="mg-thumb" style="width:40px;min-width:40px;display:grid;place-items:center">📄</span>
            <span class="name"></span>
            <span class="size"></span>
            <input type="text" class="opt__text" spellcheck="false" autocomplete="off"
                   style="flex:0 0 104px;width:104px" title="Pages to take from this file — all, or e.g. 1-3, 7" />
            <button class="icon-btn" data-up type="button" title="Move up">↑</button>
            <button class="icon-btn" data-down type="button" title="Move down">↓</button>
            <button class="icon-btn danger" data-rm type="button" title="Remove">✕</button>
          </div>
          <p class="opt__hint" style="color:var(--danger);margin:4px 0 0 52px" hidden></p>
        </div>
      `);
      const m = meta.get(file) ?? { rangeText: 'all' };
      m.rowEls = {
        thumb: wrap.querySelector('.mg-thumb'),
        name: wrap.querySelector('.name'),
        size: wrap.querySelector('.size'),
        input: wrap.querySelector('input'),
        hint: wrap.querySelector('.opt__hint'),
      };
      m.rowEls.name.textContent = file.name;
      m.rowEls.input.value = m.rangeText ?? 'all';
      m.rowEls.input.addEventListener('input', () => {
        m.rangeText = m.rowEls.input.value;
        paintRowStatus(file);
        update();
      });

      const up = wrap.querySelector('[data-up]');
      const down = wrap.querySelector('[data-down]');
      up.disabled = i === 0;
      down.disabled = i === files.length - 1;
      up.addEventListener('click', () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; paintRows(); update(); });
      down.addEventListener('click', () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; paintRows(); update(); });
      wrap.querySelector('[data-rm]').addEventListener('click', () => {
        files.splice(i, 1);
        meta.delete(file);
        if (!files.length) shellCtx?.stage('upload');
        shellCtx?.refresh();   // re-runs this workarea and the go-button check
        update();
      });

      list.appendChild(wrap);
      paintRow(file);
    });

    rowsHost.appendChild(list);
  }

  /** Fill one row's thumbnail / facts in place (no rebuild, keeps focus). */
  function paintRow(file) {
    const m = meta.get(file);
    if (!m?.rowEls) return;
    if (m.thumb) {
      m.rowEls.thumb.textContent = '';
      m.thumb.className = 'thumb';   // .file-row .thumb: 40px, object-fit cover
      m.rowEls.thumb.replaceWith(m.thumb);
      m.rowEls.thumb = m.thumb;
    }
    paintRowStatus(file);
  }

  /** The per-row page count and the red hint under an invalid "pages" box. */
  function paintRowStatus(file) {
    const m = meta.get(file);
    if (!m?.rowEls) return;
    const { size, input, hint } = m.rowEls;
    if (m.loading) { size.textContent = 'reading…'; return; }
    if (m.loadError) {
      size.textContent = formatBytes(file.size);
      hint.textContent = `Not a readable PDF — remove this file to merge the rest.`;
      hint.hidden = false;
      input.disabled = true;
      return;
    }
    const sel = selection(file);
    const taking = sel.pages.length;
    size.textContent = taking === m.pageCount
      ? `${m.pageCount} page${m.pageCount === 1 ? '' : 's'}`
      : `${taking} of ${m.pageCount} pages`;
    input.setAttribute('aria-invalid', String(!!sel.error));
    input.style.borderColor = sel.error ? 'var(--danger)' : '';
    hint.hidden = !sel.error;
    if (sel.error) hint.textContent = `${sel.error} — this file has ${m.pageCount} pages.`;
  }

  // -------------------------------------------------------------------------
  // Sidebar facts + the live sentence
  // -------------------------------------------------------------------------

  function update() {
    if (!ui.facts) return;
    const files = shellCtx?.files ?? [];
    if (!files.length) { ui.facts.set([]); ui.explain.set(''); return; }

    let pages = 0;
    let estBytes = 0;
    let loading = 0;
    let bad = 0;
    for (const file of files) {
      const m = meta.get(file);
      if (!m || m.loading) { loading++; continue; }
      if (m.loadError) { bad++; continue; }
      const sel = selection(file);
      if (sel.error) { bad++; continue; }
      pages += sel.pages.length;
      // Pages are copied, not re-encoded, so the file's own bytes-per-page is
      // the honest estimate — same reasoning as Split.
      if (m.pageCount) estBytes += file.size * (sel.pages.length / m.pageCount);
    }
    const tocPages = ui.toc.value && pages ? countTocPages(files.length) : 0;

    ui.facts.set([
      ['Files', String(files.length)],
      ['Pages selected', loading ? '…' : String(pages + tocPages)],
      ['Estimated size', loading ? '…' : `≈ ${formatBytes(Math.round(estBytes))}`],
    ]);

    ui.explain.set(
      bad ? `Fix the red “pages” box${bad === 1 ? '' : 'es'} before merging.`
        : loading ? 'Reading the files…'
          : files.length < 2 ? 'Add at least one more PDF to merge.'
            : `${files.length} PDFs → one ${pages + tocPages}-page file${tocPages ? ' (contents page included)' : ''}: ${safeName(ui.name.value) || 'merged'}.pdf`,
    );
  }

  // -------------------------------------------------------------------------
  // The table of contents page
  // -------------------------------------------------------------------------

  /**
   * Prepends the contents page(s). Filenames Helvetica can't encode (Thai, CJK,
   * …) are NOT transliterated — that line is rendered to a transparent PNG by a
   * canvas using the system fonts, embedded at the same baseline, so the name
   * appears exactly as the student wrote it.
   */
  async function prependToc(doc, entries) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ref = doc.getPage(0).getSize();   // match the first content page
    const { top, perPage } = tocGeometry(ref.height);
    const tocPages = Math.ceil(entries.length / perPage);

    // Page numbers refer to the finished file, so the contents page(s) count too.
    const rows = entries.map((e, i) => ({ ...e, n: i + 1, page: e.start + tocPages }));
    for (let t = 0; t < tocPages; t++) doc.insertPage(t, [ref.width, ref.height]);

    for (let t = 0; t < tocPages; t++) {
      const page = doc.getPage(t);
      if (t === 0) {
        page.drawText('Contents', {
          x: TOC_MARGIN, y: ref.height - TOC_MARGIN - TOC_TITLE_SIZE,
          size: TOC_TITLE_SIZE, font: bold, color: TOC_TEXT,
        });
      }
      let y = top;
      for (const row of rows.slice(t * perPage, (t + 1) * perPage)) {
        const num = String(row.page);
        const numW = font.widthOfTextAtSize(num, TOC_LINE_SIZE);
        page.drawText(num, {
          x: ref.width - TOC_MARGIN - numW, y,
          size: TOC_LINE_SIZE, font, color: TOC_FAINT,
        });
        const label = `${row.n}.  ${row.name}`;
        const maxW = ref.width - TOC_MARGIN * 2 - numW - 18;
        if (canEncode(font, label)) {
          page.drawText(fitText(font, label, TOC_LINE_SIZE, maxW), {
            x: TOC_MARGIN, y, size: TOC_LINE_SIZE, font, color: TOC_TEXT,
          });
        } else {
          const line = await lineImage(label, TOC_LINE_SIZE, maxW);
          const img = await doc.embedPng(line.bytes);
          page.drawImage(img, { x: TOC_MARGIN, y: y - line.descent, width: line.width, height: line.height });
        }
        y -= TOC_LEAD;
      }
    }
  }

  /** Helvetica is WinAnsi-only; measuring is the reliable way to find out. */
  function canEncode(font, text) {
    try { font.widthOfTextAtSize(text, 10); return true; } catch { return false; }
  }

  function fitText(font, text, size, maxW) {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    let t = text;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  /**
   * One TOC line rendered by the browser instead of pdf-lib: transparent PNG,
   * drawn at 3× and scaled down so it stays crisp in print. Returns the size in
   * PDF points plus the baseline's distance from the image bottom, so the line
   * sits on the same baseline as the Helvetica page number beside it.
   */
  async function lineImage(text, sizePt, maxWidthPt) {
    const SCALE = 3;
    const px = sizePt * SCALE;
    const canvas = document.createElement('canvas');
    let g = canvas.getContext('2d');
    const setFont = () => { g.font = `${px}px ${TOC_CANVAS_FONT}`; g.textBaseline = 'alphabetic'; };
    setFont();

    let t = text;
    if (g.measureText(t).width > maxWidthPt * SCALE) {
      while (t.length > 1 && g.measureText(`${t}…`).width > maxWidthPt * SCALE) t = t.slice(0, -1);
      t = `${t}…`;
    }
    const m = g.measureText(t);
    // Thai stacks marks above and below the line — trust the real ink extents.
    const ascent = Math.ceil(m.actualBoundingBoxAscent ?? px * 0.9);
    const descent = Math.ceil(m.actualBoundingBoxDescent ?? px * 0.3);
    canvas.width = Math.max(1, Math.ceil(m.width) + 2);
    canvas.height = ascent + descent + 2;
    g = canvas.getContext('2d');   // resizing resets the context
    setFont();
    g.fillStyle = 'rgb(38, 38, 48)';
    g.fillText(t, 1, 1 + ascent);

    const blob = await canvasToBlob(canvas, 'image/png');
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width / SCALE,
      height: canvas.height / SCALE,
      descent: (canvas.height - 1 - ascent) / SCALE,
    };
  }

  /** A file name every OS accepts — same rules as Split uses. */
  function safeName(label) {
    if (!label) return '';
    return label
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 80);
  }
}
