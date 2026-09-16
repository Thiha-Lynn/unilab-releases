import { PDFDocument, rgb } from 'pdf-lib';
import { redactPdf } from '../redaction.js';
import { canvasToBlob, el, formatBytes, stem, toast } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, segmented, sliderField,
} from '../option-ui.js';

// The whole point of this tool, and the reason it is not "draw a shape in Preview":
//
// A filled black rectangle sitting on top of text is not a redaction. The text
// is still in the file, one layer down; select it, copy it, and the bank number
// is right there. Every "I redacted it" leak works exactly like that.
//
// So when the student ticks "also remove the text under the box", the export
// path rasterizes: each marked page is re-rendered through pdf.js at print
// quality, the boxes are painted onto that flat canvas, and the page is rebuilt
// from the image. There is no text layer left to copy from. Pages with no boxes
// are copied through byte-for-byte, which keeps the file small and keeps their
// text selectable and searchable — rasterizing a whole document to hide one line
// would be vandalism.

// Rendering the preview much wider than this buys nothing on screen and costs
// real time on a phone.
const PREVIEW_MAX_W = 900;

// A hard ceiling on the rebuilt page bitmap. 300 DPI sounds harmless until the
// page is an A0 conference poster: 3370 pt at 300 DPI is 14,000 px on the long
// side, past what a browser canvas will allocate — it comes back blank, which
// would silently ship an empty redacted page. Clamping the scale instead means
// the poster is a little softer and definitely correct.


// Below this (a fraction of the page) a drag is a mis-click, not a box.
const MIN_BOX_W = 0.006;
const MIN_BOX_H = 0.004;

const COLOURS = { black: '#000000', white: '#ffffff' };

export default function render(container, tool) {
  const state = {
    file: null,
    pdf: null,            // the pdf.js document, used for rendering and for text search
    pageCount: 0,
    page: 1,              // 1-based, the page the workarea is showing
    boxes: [],            // { page, x, y, w, h } — all fractions of the page, 0…1
    colour: COLOURS.black,
    loadGen: 0,           // bumped on every new file so stale async work bails out
  };
  const ui = {};          // sidebar controls, filled in by options()
  let dom = null;         // the workarea nodes, built once
  let shownPage = 0;      // which page the canvas currently holds

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF file',
    dropLabel: 'or drop a PDF here',
    actionLabel: 'Redact PDF',
    doneTitle: 'Your PDF has been redacted!',
    downloadLabel: 'Download redacted PDF',
    continueTo: ['compress-pdf', 'ocr-pdf'],
    note: 'Bank slips, ID cards and grade transcripts are the usual reasons to be here. A rebuilt page is an image, so it weighs more than the page it replaced — if the file has to go through an LMS upload box afterwards, run it through Compress PDF next.',

    // The workarea is the page itself with the marks on it. Anything less and
    // you are asking someone to trust coordinates they cannot see.
    workarea(host) { buildWorkarea(host); },

    async onFiles(ctx) {
      await loadFile(ctx.files[0] ?? null);
    },

    options(host) {
      const panel = optionPanel('Redact');

      ui.info = infoBox(
        'A black rectangle laid over words is not a redaction — the words are still in the file and anyone can select and copy them. UniLab rebuilds every marked page as a flat image at the sharpness you pick, with the boxes painted on, so there is nothing left underneath. Pages you did not mark are copied through untouched and stay selectable.',
      );
      ui.facts = fileFacts();

      ui.colour = segmented(
        [{ id: 'black', label: 'Black boxes' }, { id: 'white', label: 'White boxes' }],
        (m) => { state.colour = COLOURS[m.id]; paintBoxes(); update(); },
      );

      ui.burn = checkRow('Also remove the text under the box from the file', {
        checked: true,
        hint: 'This rebuilds each marked page as an image, so the hidden text is genuinely gone. Untick it only if you want a quick cover-up and know the text stays readable underneath.',
        onChange: () => { syncVisibility(); update(); },
      });

      ui.find = findField();

      ui.dpi = sliderField('Sharpness of the rebuilt pages', {
        value: 200, min: 150, max: 300, step: 50, suffix: ' DPI', onChange: update,
      });

      ui.explain = liveExplain();

      panel.add(ui.info, ui.facts, ui.colour, ui.burn, ui.find, ui.dpi, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (!state.boxes.length) {
        throw new Error('Nothing is marked yet. Drag a box across whatever has to disappear, or type the number into “Find and redact” and press Find.');
      }
      const bytes = await state.file.arrayBuffer();
      const blob = ui.burn.value ? await exportFlattened(ctx, bytes) : await exportCovered(ctx, bytes);
      const marked = new Set(state.boxes.map((b) => b.page)).size;

      return {
        outputs: [{ name: `${stem(state.file.name)}-redacted.pdf`, blob }],
        doneTitle: ui.burn.value
          ? `${state.boxes.length} mark${state.boxes.length === 1 ? '' : 's'} burned into ${marked} page${marked === 1 ? '' : 's'}.`
          : 'Your PDF has been covered up.',
      };
    },
  });

  // Leaving the tool releases the pdf.js worker document; the shell tears down
  // its own state on the same event.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    state.pdf?.destroy?.();
    state.pdf = null;
  });

  // ---------------------------------------------------------------------------
  // loading

  async function loadFile(file) {
    const gen = ++state.loadGen;
    state.pdf?.destroy?.();
    state.pdf = null;
    state.file = file;
    state.boxes = [];
    state.page = 1;
    shownPage = 0;

    if (!file) {
      state.pageCount = 0;
      ui.facts?.set([]);
      if (dom) dom.frame.innerHTML = '';
      update();
      return;
    }

    const pdf = await openPdf(file);
    if (gen !== state.loadGen) { pdf.destroy?.(); return; }   // a newer file won the race
    state.pdf = pdf;
    state.pageCount = pdf.numPages;
    ui.facts.set([
      ['Original size', formatBytes(file.size)],
      ['Total pages', String(state.pageCount)],
    ]);
    update();
    await showPage(1);
  }

  // ---------------------------------------------------------------------------
  // the workarea: one page, drawn big, with the marks on top of it

  function buildWorkarea(host) {
    if (dom) return;   // refresh() calls workarea() again on every change

    const root = el(`
      <div>
        <div class="actions" style="margin-top:0">
          <button class="icon-btn" data-prev type="button" title="Previous page">‹</button>
          <span class="ts__hint" style="margin:0;min-width:9em" data-label>—</span>
          <button class="icon-btn" data-next type="button" title="Next page">›</button>
          <span style="flex:1"></span>
          <button class="btn small secondary" data-clear-page type="button">Clear this page</button>
          <button class="btn small secondary" data-clear-all type="button">Clear all</button>
        </div>
        <div class="canvas-stage" style="min-height:200px">
          <div data-frame style="position:relative;max-width:100%;line-height:0;touch-action:none;cursor:crosshair"></div>
        </div>
        <p class="ts__hint">Drag across anything that has to go. Click a box to take it off again.</p>
      </div>
    `);

    dom = {
      root,
      label: root.querySelector('[data-label]'),
      prev: root.querySelector('[data-prev]'),
      next: root.querySelector('[data-next]'),
      frame: root.querySelector('[data-frame]'),
    };

    // A page that will not draw is worth one line of feedback rather than a
    // silent dead button and a rejected promise nobody sees.
    const go = (n) => { showPage(n).catch((err) => toast(`That page could not be drawn: ${err.message}`)); };
    dom.prev.addEventListener('click', () => go(state.page - 1));
    dom.next.addEventListener('click', () => go(state.page + 1));
    root.querySelector('[data-clear-page]').addEventListener('click', () => {
      const before = state.boxes.length;
      state.boxes = state.boxes.filter((b) => b.page !== state.page);
      if (before === state.boxes.length) toast('This page has no boxes on it.');
      paintBoxes();
      update();
    });
    root.querySelector('[data-clear-all]').addEventListener('click', () => {
      if (!state.boxes.length) { toast('There are no boxes to clear.'); return; }
      state.boxes = [];
      paintBoxes();
      update();
    });

    wireDrawing(dom.frame);
    host.innerHTML = '';
    host.appendChild(root);
    update();
  }

  /** Drag on the page to draw a box; the ghost follows the pointer live. */
  function wireDrawing(frame) {
    let drag = null;

    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !shownPage) return;
      frame.setPointerCapture(e.pointerId);
      drag = { start: pointAt(frame, e), rect: null };
      e.preventDefault();
    });

    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.rect = rectBetween(drag.start, pointAt(frame, e));
      paintGhost(drag.rect);
    });

    const finish = () => {
      if (!drag) return;
      const { rect } = drag;
      drag = null;
      paintGhost(null);
      if (!rect) return;                       // a plain click on empty page
      if (rect.w < MIN_BOX_W || rect.h < MIN_BOX_H) {
        toast('That box was too small to mean anything — drag a bit further.');
        return;
      }
      state.boxes.push({ page: state.page, ...rect });
      paintBoxes();
      update();
    };
    frame.addEventListener('pointerup', finish);
    frame.addEventListener('pointercancel', finish);
  }

  function pointAt(frame, e) {
    const r = frame.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / Math.max(1, r.width)),
      y: clamp01((e.clientY - r.top) / Math.max(1, r.height)),
    };
  }

  function rectBetween(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  async function showPage(n) {
    if (!state.pdf || !dom) return;
    const page = Math.min(state.pageCount, Math.max(1, n));
    state.page = page;
    const gen = state.loadGen;

    // Clear the old page and its marks first, or page 3's boxes hover over
    // page 4 for as long as the render takes.
    shownPage = 0;
    paintBoxes();
    dom.frame.querySelector('canvas')?.remove();
    dom.frame.querySelector('[data-loading]')?.remove();
    dom.frame.appendChild(el(`<p class="ts__hint" data-loading style="margin:0;padding:24px;line-height:1.5">Rendering page ${page}…</p>`));
    update();

    const doc = state.pdf;
    let canvas;
    try {
      const vp = (await doc.getPage(page)).getViewport({ scale: 1 });
      canvas = await renderPage(doc, page, Math.min(2, PREVIEW_MAX_W / vp.width));
    } catch (err) {
      // A newer file closed this document out from under the render. That is a
      // swap, not a failure — anything else is a real problem worth showing.
      if (gen !== state.loadGen) return;
      throw err;
    }
    if (gen !== state.loadGen || state.page !== page) return;   // navigated away mid-render

    dom.frame.querySelector('[data-loading]')?.remove();
    dom.frame.querySelector('canvas')?.remove();
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    dom.frame.prepend(canvas);
    shownPage = page;
    paintBoxes();
    update();
  }

  /** Repaints the marks for the visible page. They are fractions, so CSS % works. */
  function paintBoxes() {
    if (!dom) return;
    dom.frame.querySelectorAll('[data-box]').forEach((n) => n.remove());
    if (!shownPage) return;

    state.boxes.forEach((box, i) => {
      if (box.page !== shownPage) return;
      const node = el(`<div data-box role="button" tabindex="0" title="Click to remove this box"></div>`);
      Object.assign(node.style, {
        position: 'absolute',
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        background: state.colour,
        // A white box on a white page would be invisible in the preview, so every
        // mark carries a thin outline here. It is preview-only — the exported
        // page gets the flat fill and nothing else.
        boxShadow: '0 0 0 1.5px var(--cc, var(--accent))',
        cursor: 'pointer',
      });
      node.addEventListener('pointerdown', (e) => e.stopPropagation());
      node.addEventListener('click', () => {
        state.boxes.splice(i, 1);
        paintBoxes();
        update();
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); node.click(); }
      });
      dom.frame.appendChild(node);
    });
  }

  function paintGhost(rect) {
    dom.frame.querySelector('[data-ghost]')?.remove();
    if (!rect) return;
    const node = el(`<div data-ghost></div>`);
    Object.assign(node.style, {
      position: 'absolute',
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.w * 100}%`,
      height: `${rect.h * 100}%`,
      background: state.colour,
      opacity: '0.55',
      outline: '1.5px dashed var(--cc, var(--accent))',
      pointerEvents: 'none',
    });
    dom.frame.appendChild(node);
  }

  // ---------------------------------------------------------------------------
  // "find and redact all occurrences of…"

  function findField() {
    const root = el(`
      <div class="opt__field">
        <label class="opt__label">Find and redact all occurrences of…</label>
        <div class="opt__row">
          <div class="field" style="flex:1;min-width:0">
            <input type="text" spellcheck="false" placeholder="6531234567" style="width:100%;min-width:0">
          </div>
          <button class="btn small" type="button">Find</button>
        </div>
        <p class="opt__hint">Reads the real text of every page and drops a box on every match — the only bearable way to kill a student ID that sits in the header of all twelve pages. Scanned pages hold no text to search; draw those by hand.</p>
      </div>
    `);
    const input = root.querySelector('input');
    const btn = root.querySelector('button');

    async function go() {
      const needle = input.value.trim();
      if (!needle) { toast('Type the number or word you want gone first.'); input.focus(); return; }
      if (!state.pdf) return;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Searching…';
      try {
        await findAndMark(needle);
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    return { root, get value() { return input.value.trim(); } };
  }

  /**
   * Searches every page's text layer and adds a box over each hit.
   *
   * pdf.js hands back text in whatever chunks the PDF happened to store — a ten
   * digit ID commonly arrives as three separate items, and there are no spaces
   * between items even when the page shows one. So the haystack is built with
   * all whitespace stripped and a character-by-character map back to the item it
   * came from; searching the stripped needle in the stripped haystack finds both
   * "6531234567" and "Student ID" regardless of how the file chopped them up.
   */
  async function findAndMark(rawNeedle) {
    const needle = rawNeedle.replace(/\s+/g, '').toLowerCase();
    if (!needle) return;

    const gen = state.loadGen;
    const added = [];
    let rotatedPages = 0;

    for (let n = 1; n <= state.pageCount; n++) {
      if (gen !== state.loadGen) return;
      const page = await state.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      let hay = '';
      const owner = [];   // owner[i] = { item, at } for character i of `hay`
      for (const item of content.items) {
        const str = typeof item.str === 'string' ? item.str : '';
        for (let k = 0; k < str.length; k++) {
          if (/\s/.test(str[k])) continue;
          hay += str[k].toLowerCase();
          owner.push({ item, at: k });
        }
      }

      let from = 0;
      for (;;) {
        const hit = hay.indexOf(needle, from);
        if (hit < 0) break;
        from = hit + needle.length;

        // A rotated page swaps the text axes, and guessing the sign of that
        // rotation without a file to test against would place boxes over the
        // wrong words — a much worse failure than declining to place them.
        if (vp.rotation % 360 !== 0) { rotatedPages++; continue; }

        // Walk the matched characters, splitting them back into per-item runs so
        // a hit spanning three items becomes three boxes that sit exactly on it.
        let i = hit;
        while (i < from) {
          const { item } = owner[i];
          let j = i;
          while (j < from && owner[j].item === item) j++;
          const box = boxForRun(vp, item, owner[i].at, owner[j - 1].at + 1);
          if (box && !alreadyMarked(n, box)) added.push({ page: n, ...box });
          i = j;
        }
      }
      // Yield between pages: a 200-page thesis must not freeze the tab.
      await new Promise((r) => setTimeout(r, 0));
    }

    if (gen !== state.loadGen) return;
    state.boxes.push(...added);
    paintBoxes();
    update();

    if (!added.length) {
      toast(rotatedPages
        ? 'Found it only on rotated pages, where boxes cannot be placed automatically. Draw those by hand.'
        : `No page contains “${rawNeedle}”. If this is a scan there is no text to search — run OCR PDF first, or draw the box by hand.`);
      return;
    }
    const pages = new Set(added.map((b) => b.page));
    await showPage(Math.min(...pages));
    toast(`Marked ${added.length} match${added.length === 1 ? '' : 'es'} on ${pages.size} page${pages.size === 1 ? '' : 's'}.`);
  }

  /** One text item, characters [a, b) → a padded box in page fractions. */
  function boxForRun(vp, item, a, b) {
    const len = item.str.length || 1;
    const width = item.width ?? 0;
    const height = item.height || Math.abs(item.transform?.[3] ?? 0) || 10;
    if (!width || !height) return null;

    // transform[4], transform[5] is the start of the baseline in PDF user space.
    const [bx, by] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
    // Characters are assumed evenly spaced across the run. That is not true of
    // proportional type, but the error is a fraction of a letter and the padding
    // below swallows it.
    const x = bx + (width * a) / len;
    const w = (width * (b - a)) / len;
    const padX = height * 0.14;
    const padY = height * 0.22;

    return clampBox({
      x: (x - padX) / vp.width,
      y: (by - height - padY * 0.6) / vp.height,
      w: (w + padX * 2) / vp.width,
      h: (height + padY * 1.6) / vp.height,
    });
  }

  function alreadyMarked(page, box) {
    // Pressing Find twice should not stack ten identical boxes on one number.
    return state.boxes.some((b) => b.page === page
      && Math.abs(b.x - box.x) < 0.004 && Math.abs(b.y - box.y) < 0.004
      && Math.abs(b.w - box.w) < 0.006 && Math.abs(b.h - box.h) < 0.006);
  }

  // ---------------------------------------------------------------------------
  // export

  /**
   * The real redaction. Marked pages are re-rendered as images with the boxes
   * painted on; every other page is copied through so the file stays light and
   * its text stays selectable.
   */
  async function exportFlattened(ctx, bytes) {
    return redactPdf({ bytes, pdf: state.pdf, boxes: state.boxes, colour: state.colour,
      dpi: ui.dpi.value, renderPage, canvasToBlob, ctx });
  }

  /** The honest cover-up: real rectangles, real text still underneath. */
  async function exportCovered(ctx, bytes) {
    const out = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = [...new Set(state.boxes.map((b) => b.page))].sort((a, b) => a - b);
    const fill = state.colour === COLOURS.white ? rgb(1, 1, 1) : rgb(0, 0, 0);

    for (const [i, n] of pages.entries()) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(i / pages.length, `Covering page ${n}…`);
      // convertToPdfPoint is the exact inverse of what the preview drew, so a
      // page with a /Rotate entry lands right without any hand-rolled maths.
      const vp = (await state.pdf.getPage(n)).getViewport({ scale: 1 });
      const page = out.getPage(n - 1);
      for (const b of state.boxes) {
        if (b.page !== n) continue;
        const [x0, y0] = vp.convertToPdfPoint(b.x * vp.width, b.y * vp.height);
        const [x1, y1] = vp.convertToPdfPoint((b.x + b.w) * vp.width, (b.y + b.h) * vp.height);
        page.drawRectangle({
          x: Math.min(x0, x1), y: Math.min(y0, y1),
          width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
          color: fill,
        });
      }
      await tick();
    }

    ctx.setBusy(1, 'Saving…');
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  // ---------------------------------------------------------------------------

  /** Sharpness only decides anything when the pages are actually rebuilt. */
  function syncVisibility() {
    ui.dpi.root.hidden = !ui.burn.value;
  }

  function update() {
    if (!ui.explain) return;

    if (dom) {
      const here = countOn(state.page);
      dom.label.textContent = state.pageCount
        ? `Page ${state.page} of ${state.pageCount}${here ? ` · ${here} box${here === 1 ? '' : 'es'}` : ''}`
        : '—';
      dom.prev.disabled = state.page <= 1;
      dom.next.disabled = state.page >= state.pageCount;
    }

    if (!state.pageCount) { ui.explain.set(''); return; }

    const marks = state.boxes.length;
    const pages = new Set(state.boxes.map((b) => b.page)).size;
    if (!marks) {
      ui.explain.set('Nothing is marked yet — drag a box across anything on the page that has to go.');
      return;
    }
    const untouched = state.pageCount - pages;
    ui.explain.set(ui.burn.value
      ? `${marks} box${marks === 1 ? '' : 'es'} on ${pages} page${pages === 1 ? '' : 's'}. Those page${pages === 1 ? '' : 's'} will be rebuilt as ${ui.dpi.value} DPI images with the boxes burned in, so the text underneath is really gone. The other ${untouched} page${untouched === 1 ? '' : 's'} ${untouched === 1 ? 'is' : 'are'} copied through untouched.`
      : `${marks} box${marks === 1 ? '' : 'es'} will be drawn over ${pages} page${pages === 1 ? '' : 's'} — but the text underneath stays in the file and can still be selected and copied. Tick the box above if it has to actually be gone.`);
  }

  function countOn(page) { return state.boxes.filter((b) => b.page === page).length; }
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

function clampBox(b) {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  return { x, y, w: Math.min(1 - x, Math.max(0, b.w)), h: Math.min(1 - y, Math.max(0, b.h)) };
}

/** Hand the tab back to the browser between heavy items. */
function tick() { return new Promise((r) => setTimeout(r, 0)); }
