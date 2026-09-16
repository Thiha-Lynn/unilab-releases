import { PDFDocument, StandardFonts } from 'pdf-lib';
import { bundledOffline, offlineAsset } from '../offline-assets.js';
import { PSM, createWorker } from 'tesseract.js';
import { canvasToBlob, downloadBlob, el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, numberField, optionPanel, segmented, tokenSelect,
} from '../option-ui.js';

// A scan is a photograph of a page: the words are pixels, so Ctrl+F finds
// nothing and nothing can be copied. Tesseract reads those pixels back into
// text, and we lay that text invisibly over the picture so the page still looks
// exactly like the scan while behaving like a document.
//
// `latin1: true` marks the languages whose alphabet a PDF's built-in fonts can
// actually store — see buildSearchablePdf() for why that matters.
const LANGS = [
  { id: 'tha', label: 'Thai · ไทย' },
  { id: 'eng', label: 'English', latin1: true },
  { id: 'mya', label: 'Burmese · မြန်မာ' },
  { id: 'chi_sim', label: 'Chinese — Simplified · 简体' },
  { id: 'chi_tra', label: 'Chinese — Traditional · 繁體' },
  { id: 'jpn', label: 'Japanese · 日本語' },
  { id: 'kor', label: 'Korean · 한국어' },
  { id: 'lao', label: 'Lao · ລາວ' },
  { id: 'khm', label: 'Khmer · ខ្មែរ' },
  { id: 'vie', label: 'Vietnamese · Tiếng Việt' },
  { id: 'msa', label: 'Malay · Bahasa Melayu', latin1: true },
  { id: 'ind', label: 'Indonesian · Bahasa Indonesia', latin1: true },
  { id: 'hin', label: 'Hindi · हिन्दी' },
  { id: 'ara', label: 'Arabic · العربية' },
  { id: 'rus', label: 'Russian · Русский' },
  { id: 'fra', label: 'French · Français', latin1: true },
  { id: 'deu', label: 'German · Deutsch', latin1: true },
  { id: 'spa', label: 'Spanish · Español', latin1: true },
  { id: 'por', label: 'Portuguese · Português', latin1: true },
];

const OCR_SCALE = 2;             // 2× the page's own size ≈ 150 dpi — what Tesseract likes
const PREVIEW_SCALE = 0.38;
const MAX_PREVIEW_PAGES = 40;    // thumbnails past this help nobody and cost seconds
const DEFAULT_CAP = 20;          // OCR is slow; a 200-page scan must not be a trap
const READ_SHARE = 0.85;         // reading is most of the wait, rebuilding is the rest

// Friendly versions of the engine's own progress labels. The first run of the
// day downloads a lot, and "loading language traineddata" tells a first-year
// student nothing about why they are waiting.
const STATUS_TEXT = [
  ['loading tesseract core', 'Downloading the recognition engine… (first run only)'],
  ['initializing tesseract', 'Starting the recognition engine…'],
  ['loading language traineddata', 'Downloading the language data… (first run only)'],
  ['initializing api', 'Getting the engine ready…'],
  ['recognizing text', 'Reading the page…'],
];

const CHIP_BASE = 'display:block;margin-top:4px;padding:1px 0;border-radius:999px;font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-align:center;';
const CHIPS = {
  queued: { text: 'queued', style: `${CHIP_BASE}background:var(--line);color:var(--faint)` },
  reading: { text: 'reading…', style: `${CHIP_BASE}background:color-mix(in srgb, var(--accent) 20%, transparent);color:var(--accent)` },
  done: { text: 'done', style: `${CHIP_BASE}background:color-mix(in srgb, var(--good) 20%, transparent);color:var(--good)` },
  skip: { text: 'not read', style: `${CHIP_BASE}background:transparent;color:var(--faint);border:1px solid var(--line)` },
};

export default function render(container, tool) {
  const state = {
    file: null, pdf: null, pageCount: 0,
    cells: new Map(),        // page number → its chip element, so a run repaints one page
    status: new Map(),       // page number → 'queued' | 'reading' | 'done' | 'skip'
    hasTextAlready: false,
  };
  const ui = {};
  let areaHost = null;
  let gridHost = null;
  let textHost = null;
  let textBody = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a scanned PDF',
    dropLabel: 'or drop it here',
    actionLabel: 'Read the pages',
    doneTitle: 'Your PDF can be searched now!',
    downloadLabel: 'Download searchable PDF',
    continueTo: ['pdf-to-markdown', 'compress-pdf', 'split-pdf'],
    note: 'Once the words are real text you can Ctrl+F a 60-page scanned handout for the one definition you need, and paste a quote into your report instead of retyping it. Installed APK and desktop packages include all language data. In the web app, language data is downloaded on first use.',

    // The workarea is the operation: every page that will be read, with a chip
    // that turns over as the run moves through them, and the words found on the
    // page underneath so the wait is visibly doing something.
    workarea(host) {
      if (areaHost === host) return;
      areaHost = host;
      host.innerHTML = '';
      const grid = el(`<div class="ts__group"><span class="ts__group__tag">Pages</span><div class="ts__group__pages"></div></div>`);
      gridHost = grid.querySelector('.ts__group__pages');
      const text = el(`<div class="ts__group"><span class="ts__group__tag">Words found</span><div></div></div>`);
      textHost = text;
      textBody = text.querySelector('div');
      textBody.style.cssText = 'max-height:220px;overflow:auto;font-size:13px;line-height:1.55;color:var(--muted);white-space:pre-wrap;text-align:left';
      textHost.hidden = true;
      host.append(grid, text);
      paintGrid();
    },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('OCR');

      // The one thing a privacy-first tool has to be straight about: this is the
      // one tool here that needs the network at all, so say what it fetches and
      // what it does not, before the student presses the button.
      ui.download = infoBox(
        bundledOffline() ? 'The recognition engine and all 19 language packs are bundled in this app. OCR runs on this device without an internet connection.' : 'The first run downloads the recognition engine (about 5 MB) and the language data '
        + '(roughly 10–15 MB per language) from a public CDN, then keeps them in this browser. '
        + 'The document itself is never sent — only the recognition engine is downloaded.',
      );

      ui.facts = fileFacts();
      ui.already = infoBox('');
      ui.already.hide();

      ui.langs = tokenSelect('Languages on the page', LANGS, {
        max: 3, selected: ['eng'], onChange: update,
      });

      ui.output = segmented(
        [{ id: 'pdf', label: 'Searchable PDF' }, { id: 'txt', label: 'Plain text (.txt)' }],
        update,
      );

      ui.cap = numberField('Read only the first', {
        value: DEFAULT_CAP, min: 1, max: 9999, suffix: 'pages',
        hint: 'A page takes a few seconds. Start small, run it again if you need the rest.',
        onChange: update,
      });

      ui.rotate = checkRow('Also fix page rotation', {
        hint: 'Straightens a crooked phone photo before reading it, which finds more words. The saved page still shows the original crooked picture — only the reading is straightened.',
        onChange: update,
      });

      ui.script = infoBox('');
      ui.script.hide();
      ui.explain = liveExplain();

      panel.add(ui.download, ui.facts, ui.already, ui.langs, ui.output, ui.cap, ui.rotate, ui.script, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      const langs = ui.langs.value;
      if (!langs.length) throw new Error('Pick at least one language first — the engine has to know what alphabet it is looking at.');
      if (!state.pdf) throw new Error('That PDF could not be opened. Try it in Unlock PDF first if it asks for a password.');

      const total = readCount();
      if (!total) throw new Error('There are no pages to read. Check the page limit and try again.');
      const wantPdf = ui.output.value === 'pdf';
      // Which languages the sidebar already warned cannot be spelled by a PDF's
      // built-in fonts — see the .txt companion decision at the end of the run.
      const nonLatinPicked = langs.some((id) => !LANGS.find((l) => l.id === id)?.latin1);

      // Reset the board so a second run does not start with the first run's chips.
      for (let n = 1; n <= state.pageCount; n++) state.status.set(n, n <= total ? 'queued' : 'skip');
      showText('');
      paintChips();

      let phase = 'setup';
      let pageIndex = 0;
      let worker;
      try {
        worker = await createWorker(langs.join('+'), 1, {
          ...(bundledOffline() ? {workerPath:offlineAsset('ocr/worker.min.js'),corePath:offlineAsset('ocr/core'),langPath:offlineAsset('ocr/lang'),workerBlobURL:false} : {}),
          logger: (m) => {
            if (ctx.signal?.aborted) return;
            if (phase === 'setup') { ctx.setBusy(m.progress ?? 0, friendlyStatus(m.status)); return; }
            // Once reading has started the page counter is the honest progress:
            // the engine's own fraction only covers the page it is on.
            if (m.status === 'recognizing text') {
              ctx.setBusy(((pageIndex + (m.progress ?? 0)) / total) * (wantPdf ? READ_SHARE : 1),
                `Reading page ${pageIndex + 1} of ${total}…`);
            }
          },
        });
      } catch {
        throw new Error(bundledOffline() ? 'The bundled recognition engine could not start. Try a smaller PDF or restart the app.' : 'The recognition engine could not be downloaded. Check your connection — it is a one-time download of about 15 MB, and it needs to finish before any reading can start.');
      }

      // Cancel pressed during the download: the fetch cannot be called back, but
      // the engine can be let go of before it reads a single page.
      if (ctx.signal?.aborted) { await worker.terminate(); throw new Error('canceled'); }

      const pages = [];
      try {
        phase = 'read';
        const opts = {
          // Full page layout analysis: scans of handouts have headers, columns
          // and captions, and the library's default (one single block) merges
          // them into nonsense.
          tessedit_pageseg_mode: PSM.AUTO,
          // Straightens the page before reading it — where the accuracy is won
          // on a phone photo of a handout. One caveat, deliberately accepted:
          // the word boxes then belong to the straightened page while the
          // picture we keep is the original, so on a page that actually needed
          // straightening the hidden words sit a degree or two off the visible
          // ones. Ctrl+F does not care, and the engine does not report the
          // centre it rotated about, so mapping them back would be a guess.
          rotateAuto: ui.rotate.value,
        };

        for (let i = 0; i < total; i++) {
          if (ctx.signal?.aborted) throw new Error('canceled');
          pageIndex = i;
          const n = i + 1;
          setStatus(n, 'reading');
          ctx.setBusy((i / total) * (wantPdf ? READ_SHARE : 1), `Reading page ${n} of ${total}…`);

          const canvas = await renderPage(state.pdf, n, OCR_SCALE);
          const { data } = await worker.recognize(canvas, opts, { text: true, blocks: true });

          const page = await state.pdf.getPage(n);
          const view = page.getViewport({ scale: 1 });
          // Keep the picture as JPEG bytes and drop the canvas straight away —
          // twenty full-page bitmaps at 2× is a lot of memory to sit on.
          const jpeg = wantPdf
            ? new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.82)).arrayBuffer())
            : null;
          pages.push({
            n,
            text: (data.text ?? '').trim(),
            words: wordsOf(data),
            jpeg,
            imgW: canvas.width,
            imgH: canvas.height,
            ptW: view.width,
            ptH: view.height,
          });
          canvas.width = 0;
          canvas.height = 0;

          setStatus(n, 'done');
          showText(pages.at(-1).text || '(no words found on this page)', n);
          // Yield so the tab stays alive between pages, and so the chips above
          // actually repaint on a phone.
          await new Promise((r) => setTimeout(r, 0));
        }
      } finally {
        await worker.terminate();
      }

      const base = stem(state.file.name);
      const found = pages.reduce((s, p) => s + p.text.length, 0);
      if (!found) {
        throw new Error('No words could be read from those pages. If the scan is faint or sideways, try "Also fix page rotation", or pick the language that is actually on the page.');
      }

      const plainText = pages.map((p) => `=== Page ${p.n} ===\n\n${p.text}\n`).join('\n');

      if (!wantPdf) {
        return {
          outputs: [{ name: `${base}-text.txt`, blob: new Blob([plainText], { type: 'text/plain;charset=utf-8' }) }],
          doneTitle: 'Your text is ready!',
          downloadLabel: 'Download text file',
        };
      }

      const { blob, skipped, counted } = await buildSearchablePdf(pages, ctx);
      const outputs = [{ name: `${base}-searchable.pdf`, blob }];

      // Thai, Burmese, Khmer, CJK: the words are read perfectly but a PDF's
      // built-in fonts cannot store those letters (see buildSearchablePdf), so
      // the .txt goes along with the PDF rather than the words being lost.
      //
      // The sidebar promised this .txt the moment a non-Latin language was
      // picked, so one dropped word is enough to keep that promise. When the
      // languages were all Latin the .txt is a surprise, so it takes a real
      // share of the words going missing to earn one — a single dropped em
      // dash is not a lost document.
      const textLost = skipped > 0
        && (nonLatinPicked || (skipped >= 8 && skipped / Math.max(1, counted) > 0.15));
      if (textLost) {
        outputs.push({ name: `${base}-text.txt`, blob: new Blob([plainText], { type: 'text/plain;charset=utf-8' }) });
      }

      return {
        outputs,
        doneTitle: textLost
          ? 'Your PDF is done — and the full text is beside it'
          : 'Your PDF can be searched now!',
        downloadLabel: outputs.length > 1 ? 'Download both files' : 'Download searchable PDF',
        zip: async () => {
          // JSZip is only needed on the rare two-file run, so it is fetched then.
          const { default: JSZip } = await import('jszip');
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}-ocr.zip`);
        },
      };
    },

    async thumbnail(file) {
      // The card only needs page 1, so this document is closed again straight
      // away rather than left holding a pdf.js worker for the whole session.
      const pdf = await openPdf(file);
      try {
        return await renderPage(pdf, 1, 0.5);
      } finally {
        try { pdf.destroy?.(); } catch { /* already gone */ }
      }
    },
  });

  // Leaving the tool releases the pdf.js document and its worker; the shell
  // tears down its own state on the same event.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    try { state.pdf?.destroy?.(); } catch { /* already gone */ }
    state.pdf = null;
  });

  // -------------------------------------------------------------------------

  async function loadFile() {
    const file = state.file;
    // A previous document keeps a pdf.js worker and its page cache alive; drop
    // it before opening the next one.
    try { await state.pdf?.destroy(); } catch { /* already gone */ }
    state.pdf = null;
    state.pageCount = 0;     // a file that fails to open must not leave the last one's count
    state.cells.clear();
    state.status.clear();

    if (!file) {
      showText('');
      paintGrid();
      update();
      return;
    }

    state.pdf = await openPdf(file);
    state.pageCount = state.pdf.numPages;
    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Total pages', String(state.pageCount)],
    ]);
    ui.cap.setMax(state.pageCount);
    ui.cap.value = Math.min(DEFAULT_CAP, state.pageCount);

    state.hasTextAlready = await looksLikeRealText(state.pdf);
    ui.already.hide(!state.hasTextAlready);
    if (state.hasTextAlready) {
      ui.already.set('This PDF already has text you can select and search. Running OCR anyway is fine, but it will replace the crisp text with a picture of the page — you probably do not need this tool.');
    }

    update();
    await renderThumbs();
  }

  /** Pages 1…n that the current settings will actually read. */
  function readCount() {
    return Math.max(0, Math.min(ui.cap.value, state.pageCount));
  }

  function update() {
    if (!ui.explain) return;
    const langs = ui.langs.value;
    const names = langs.map((id) => LANGS.find((l) => l.id === id)?.label.split(' · ')[0] ?? id);
    const cap = readCount();
    const wantPdf = ui.output.value === 'pdf';

    // Warn before the run, not after: a Thai scan still becomes a perfectly good
    // .txt, and saying so here is the difference between a surprise and a choice.
    const nonLatin = langs.filter((id) => !LANGS.find((l) => l.id === id)?.latin1);
    const showScript = wantPdf && nonLatin.length > 0;
    ui.script.hide(!showScript);
    if (showScript) {
      const names2 = nonLatin.map((id) => LANGS.find((l) => l.id === id)?.label.split(' · ')[0]).join(' and ');
      ui.script.set(`A PDF can only hide ${names2} text behind the page if it carries a font for that alphabet, and UniLab does not ship one — so the hidden layer keeps the Latin words, and every ${names2} word is saved in a .txt next to the PDF instead. Choose "Plain text" if the words are all you need.`);
    }

    if (!state.pageCount || !langs.length) {
      ui.explain.set(!langs.length ? 'Pick at least one language on the page.' : '');
    } else {
      const where = cap === 1 ? 'Page 1' : `Pages 1–${cap}`;
      const rest = state.pageCount > cap ? ` (${state.pageCount - cap} left unread)` : '';
      ui.explain.set(
        wantPdf
          ? `${where} of ${state.pageCount}${rest} will be read in ${names.join(' + ')}, then saved as a new PDF: a picture of each page with the words hidden behind it, so Ctrl+F finds them. Unread pages are not included, and the picture is re-saved as a JPEG, so the file size changes.`
          : `${where} of ${state.pageCount}${rest} will be read in ${names.join(' + ')} and saved as one .txt file you can paste into Word.`,
      );
    }

    for (let n = 1; n <= state.pageCount; n++) {
      const now = state.status.get(n);
      if (now === 'reading' || now === 'done') continue;
      state.status.set(n, n <= cap ? 'queued' : 'skip');
    }
    paintChips();
  }

  async function renderThumbs() {
    if (!gridHost) return;
    gridHost.innerHTML = '';
    gridHost.appendChild(el(`<p class="ts__hint">Drawing the pages…</p>`));
    // The document this run belongs to. Choosing a second file closes it, and
    // half of file A's pages must not end up drawn under file B's name.
    const doc = state.pdf;
    const shown = Math.min(state.pageCount, MAX_PREVIEW_PAGES);
    const canvases = [];
    for (let n = 1; n <= shown; n++) {
      let canvas;
      try {
        canvas = await renderPage(doc, n, PREVIEW_SCALE);
      } catch (err) {
        if (state.pdf !== doc) return;   // closed mid-render: a swap, not a failure
        throw err;
      }
      if (state.pdf !== doc) return;
      canvases.push(canvas);
      await new Promise((r) => setTimeout(r, 0));   // never freeze the tab on a long scan
    }
    gridHost.innerHTML = '';
    canvases.forEach((canvas, i) => {
      const n = i + 1;
      const cell = el(`<div class="ts__page"><span class="ts__page__n"></span></div>`);
      cell.querySelector('.ts__page__n').textContent = `Page ${n}`;
      cell.prepend(canvas);
      const chip = el(`<span></span>`);
      cell.appendChild(chip);
      state.cells.set(n, chip);
      gridHost.appendChild(cell);
    });
    if (state.pageCount > shown) {
      gridHost.appendChild(el(`<span class="ts__group__more">…</span>`));
      gridHost.appendChild(el(`<p class="ts__hint">${state.pageCount - shown} more pages in the file.</p>`));
    }
    paintChips();
  }

  function paintGrid() {
    if (!gridHost) return;
    if (!state.pageCount) {
      gridHost.innerHTML = '';
      gridHost.appendChild(el(`<p class="ts__hint">Choose a scanned PDF and its pages appear here.</p>`));
    }
  }

  function paintChips() {
    for (const [n, chip] of state.cells) {
      const s = CHIPS[state.status.get(n) ?? 'queued'];
      chip.textContent = s.text;
      chip.style.cssText = s.style;
    }
  }

  function setStatus(n, value) {
    state.status.set(n, value);
    paintChips();
  }

  function showText(text, n) {
    if (!textHost) return;
    textHost.hidden = !text;
    if (!text) { textBody.textContent = ''; return; }
    textHost.querySelector('.ts__group__tag').textContent = n ? `Words found on page ${n}` : 'Words found';
    textBody.textContent = text;
  }

  /**
   * True when the PDF already carries selectable text. A born-digital lecture
   * slide deck does; a photo of one does not.
   */
  async function looksLikeRealText(pdf) {
    let chars = 0;
    for (let n = 1; n <= Math.min(3, pdf.numPages); n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      chars += content.items.reduce((s, it) => s + (it.str ?? '').trim().length, 0);
      if (chars > 200) return true;
    }
    return false;
  }

  /** Every recognised word, whichever shape this version of the engine returns. */
  function wordsOf(data) {
    if (Array.isArray(data.words)) return data.words;
    const out = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) out.push(...(line.words ?? []));
      }
    }
    return out;
  }

  /**
   * Rebuild the document: the picture of each page, with the recognised words
   * laid invisibly on top of the pixels they came from. That is what "searchable
   * PDF" means everywhere — the page you see is the scan, the text Ctrl+F finds
   * is this hidden layer.
   */
  async function buildSearchablePdf(pages, ctx) {
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    let skippedWords = 0;
    let totalWords = 0;

    for (const [i, p] of pages.entries()) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(READ_SHARE + ((i / pages.length) * (1 - READ_SHARE)), `Rebuilding page ${i + 1} of ${pages.length}…`);

      const img = await out.embedJpg(p.jpeg);
      const page = out.addPage([p.ptW, p.ptH]);
      page.drawImage(img, { x: 0, y: 0, width: p.ptW, height: p.ptH });

      // Word boxes come back in image pixels with the origin top-left; a PDF
      // measures in points from the bottom-left.
      const sx = p.ptW / p.imgW;
      const sy = p.ptH / p.imgH;

      for (const word of p.words) {
        const raw = (word.text ?? '').trim();
        if (!raw) continue;
        totalWords++;
        const text = winAnsiOnly(raw);
        if (!text) { skippedWords++; continue; }

        const { x0, y0, x1, y1 } = word.bbox ?? {};
        if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
        const boxW = (x1 - x0) * sx;
        const boxH = (y1 - y0) * sy;
        if (boxW <= 0 || boxH <= 0) continue;

        let size = boxH * 0.86;
        const natural = font.widthOfTextAtSize(text, size);
        // Squeeze a long word back inside its own box so a text selection drawn
        // by the reader follows the ink rather than running off the line.
        if (natural > boxW && natural > 0) size *= boxW / natural;
        if (size < 0.6) continue;

        try {
          page.drawText(text, {
            x: x0 * sx,
            y: p.ptH - (y1 * sy) + (boxH * 0.16),
            size,
            font,
            // pdf-lib has no text render mode 3 (the "invisible text" mode a real
            // OCR layer uses), so the text is drawn fully transparent instead.
            // It looks like a mistake; it is the only way to get an invisible,
            // selectable, searchable layer out of this library.
            opacity: 0,
          });
        } catch {
          // A stray control character the standard font still refuses: the word
          // is not worth failing the whole document over.
          skippedWords++;
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    const bytes = await out.save();
    // run() decides what a dropped word means — it is the only place that knows
    // which languages the sidebar already warned about.
    return {
      blob: new Blob([bytes], { type: 'application/pdf' }),
      skipped: skippedWords,
      counted: totalWords,
    };
  }

  /**
   * pdf-lib's standard fonts are WinAnsi-encoded, which covers Latin-1 and
   * nothing else — a Thai or Chinese character thrown at drawText raises an
   * error rather than being dropped. Embedding a Unicode font would mean
   * shipping a Thai, Burmese and CJK font with the page (tens of megabytes), so
   * the hidden layer keeps what it can encode and run() saves the rest as .txt.
   */
  function winAnsiOnly(text) {
    return text.replace(/[^\x20-\x7E¡-ÿ]/g, '').trim();
  }

  function friendlyStatus(status = '') {
    const hit = STATUS_TEXT.find(([key]) => status.startsWith(key));
    if (!hit) return 'Working…';
    if (status.includes('cache')) return 'Loading the language data this browser already has…';
    return hit[1];
  }
}
