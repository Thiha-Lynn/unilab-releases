import { PDFDocument, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import { downloadBlob, el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import { fileFacts, liveExplain, optionPanel, segmented } from '../option-ui.js';

// Rotate PDF — the standalone quarter-turn, in batch.
//
// Organize PDF can already turn single pages, but the everyday job is blunter:
// a whole scanned bundle came out sideways, or three PDFs from three group
// mates all need the same turn. iLovePDF gives that its own top-level tool
// ("you can even rotate multiple PDFs at once"), and so does UniLab.
//
// The turn is LOSSLESS. A PDF page carries a /Rotate flag, and pdf-lib's
// page.setRotation(degrees(existing + delta)) only rewrites that flag — no
// page is re-rendered, so there is no quality loss and the file size barely
// moves. That is the whole reason to rotate here instead of round-tripping
// through PDF → Images → PDF.

const TURNS = [
  { id: 'left', label: 'Left 90°' },
  { id: 'right', label: 'Right 90°' },
  { id: 'flip', label: '180°' },
];
// Clockwise degrees, matching what the /Rotate flag means to a viewer.
const TURN_DEGREES = { left: -90, right: 90, flip: 180 };
const TURN_PHRASE = {
  left: 'turn a quarter-turn left',
  right: 'turn a quarter-turn right',
  flip: 'turn upside down (180°)',
};

// A scanned bundle is usually mixed — the certificate pages are landscape, the
// forms are portrait — and only one of the two kinds is wrong. These filters
// let the student fix that kind without disturbing the other.
const SCOPES = [
  { id: 'all', label: 'All pages' },
  { id: 'landscape', label: 'Only landscape' },
  { id: 'portrait', label: 'Only portrait' },
];

const MAX_PREVIEW_PAGES = 40;   // thumbnails across the whole batch

const normalize = (deg) => ((deg % 360) + 360) % 360;

/**
 * The orientation the page *displays* at, not the orientation of its media
 * box: a portrait page whose /Rotate flag is already 90 shows up landscape,
 * and it is the shown orientation the student is judging. In other words,
 * effective landscape = (width > height) XOR (rotation is 90/270).
 */
function effOf(width, height, rot) {
  const sideways = rot === 90 || rot === 270;
  const w = sideways ? height : width;
  const h = sideways ? width : height;
  return w > h ? 'landscape' : w < h ? 'portrait' : 'square';
}

export default function render(container, tool) {
  const meta = new Map();     // File → { count, eff: ['portrait', …] } | null (unreadable)
  const thumbs = new Map();   // File → [canvas, …] rendered so far
  const ui = {};
  let groupsHost = null;
  let loadToken = 0;
  // The shell's ctx, captured when it builds the sidebar. update() runs while
  // toolShell() is still executing, so the function's own return value would
  // not be assigned yet.
  let shellCtx = null;
  const fileList = () => shellCtx?.files ?? [];

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: true,
    sortable: true,
    pickLabel: 'Select PDF files',
    dropLabel: 'or drop them here — a whole batch turns at once',
    actionLabel: 'Rotate PDF',
    doneTitle: 'Your PDF is the right way up!',
    downloadLabel: 'Download rotated PDF',
    continueTo: ['organize-pdf', 'merge-pdf', 'compress-pdf'],
    note: 'The turn is written into each page as a flag (the PDF’s own /Rotate entry) — nothing is re-drawn, so there is zero quality loss and the file size barely changes. That is the reason to rotate here rather than exporting to images and rebuilding the PDF, which re-renders every page. A scan that is crooked by a few degrees is the other kind of job — that one does need re-drawing, and Scan to PDF is the tool for it.',

    // The workarea is the pages themselves, already turned the way the export
    // will turn them, so the outcome is visible before committing to it.
    workarea(host) {
      groupsHost = host;
      paintGroups();
    },

    async onFiles(ctx) {
      shellCtx = ctx;
      await loadMeta(ctx);
    },

    onChange() { update(); },

    options(host, ctx) {
      shellCtx = ctx;
      const panel = optionPanel('Rotate');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.turn = segmented(TURNS, () => update(), { active: 1 });
      const turnField = el(`<div class="opt__field"><label class="opt__label">Direction</label></div>`);
      turnField.appendChild(ui.turn.root);

      ui.scope = segmented(SCOPES, () => update(), { active: 0 });
      const scopeField = el(`<div class="opt__field"><label class="opt__label">Which pages</label></div>`);
      scopeField.appendChild(ui.scope.root);
      scopeField.appendChild(el(`<p class="opt__hint">"Landscape" and "portrait" mean how the page currently shows on screen — a page already stored with a turn counts the way you see it.</p>`));

      panel.add(turnField, ui.facts, scopeField, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      const files = ctx.files;
      if (!files.length) throw new Error('Add at least one PDF first.');
      const delta = TURN_DEGREES[ui.turn.value];
      const scope = ui.scope.value;

      const outputs = [];
      const naming = uniqueNames();
      let turned = 0;
      let total = 0;
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const file = files[i];
        ctx.setBusy(i / files.length, `Rotating ${file.name} — ${i + 1} of ${files.length}…`);
        let doc;
        try {
          doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
        } catch {
          throw new Error(`Could not open ${file.name}. If it is password-protected, run it through Unlock PDF first.`);
        }
        const pages = doc.getPages();
        for (let p = 0; p < pages.length; p++) {
          if (p % 50 === 0 && ctx.signal?.aborted) throw new Error('canceled');
          const page = pages[p];
          const rot = normalize(Math.round(page.getRotation().angle / 90) * 90);
          const { width, height } = page.getSize();
          total++;
          if (scope !== 'all' && effOf(width, height, rot) !== scope) continue;
          // The lossless bit: only the page's /Rotate flag changes.
          page.setRotation(degrees(normalize(rot + delta)));
          turned++;
        }
        outputs.push({
          name: naming(`${stem(file.name)}-rotated.pdf`),
          blob: new Blob([await doc.save()], { type: 'application/pdf' }),
        });
        // Yield between files so the cancel button keeps its turn on a big batch.
        await new Promise((r) => setTimeout(r, 0));
      }

      if (!turned) {
        throw new Error(
          scope === 'all'
            ? 'These files have no pages to turn.'
            : `No ${scope} pages found in ${files.length === 1 ? 'this file' : 'these files'} — nothing would change. Switch "Which pages" and try again.`,
        );
      }

      return {
        outputs,
        doneTitle: turned === total
          ? `All ${turned} page${turned === 1 ? '' : 's'} turned — no quality lost!`
          : `${turned} of ${total} pages turned — no quality lost!`,
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-rotated-pdfs.zip');
        },
      };
    },
  });

  // -------------------------------------------------------------------------

  /**
   * Two PDFs picked from two different folders can share a filename, and a ZIP
   * is keyed by name — the second entry would quietly replace the first. The
   * repeats get a -2, -3 suffix instead.
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

  /** Reads page sizes + existing /Rotate flags for every new file, then thumbnails. */
  async function loadMeta(ctx) {
    const token = ++loadToken;
    for (const key of [...meta.keys()]) {
      if (!ctx.files.includes(key)) { meta.delete(key); thumbs.delete(key); }
    }
    for (const file of ctx.files) {
      if (meta.has(file)) continue;
      try {
        const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
        if (token !== loadToken) return;
        const eff = doc.getPages().map((p) => {
          const rot = normalize(Math.round(p.getRotation().angle / 90) * 90);
          const { width, height } = p.getSize();
          return effOf(width, height, rot);
        });
        meta.set(file, { count: eff.length, eff });
      } catch {
        if (token !== loadToken) return;
        // An unreadable file still gets a row; run() names it when it fails.
        meta.set(file, null);
      }
      update();
      // Parsing several scanned PDFs is real work — yield so the sidebar keeps
      // filling in while the rest of the batch is measured.
      await new Promise((r) => setTimeout(r, 0));
    }
    await renderThumbs(ctx, token);
  }

  /** Renders up to MAX_PREVIEW_PAGES thumbnails across the whole batch. */
  async function renderThumbs(ctx, token) {
    let budget = MAX_PREVIEW_PAGES;
    for (const file of ctx.files) {
      const m = meta.get(file);
      if (!m || budget <= 0) continue;
      const take = Math.min(m.count, budget);
      budget -= take;
      let list = thumbs.get(file);
      if (!list) { list = []; thumbs.set(file, list); }
      if (list.length >= take) continue;
      let pdf;
      try {
        pdf = await openPdf(file);
      } catch {
        continue;   // the meta pass already flagged anything truly unreadable
      }
      if (token !== loadToken) return;
      for (let p = list.length + 1; p <= take; p++) {
        try {
          const canvas = await renderPage(pdf, p, 0.35);
          if (token !== loadToken) return;
          list.push(canvas);
        } catch {
          break;   // a page that will not render still rotates fine at export
        }
        paintGroups();
        // Yield between renders so a long document never freezes the tab.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    paintGroups();
  }

  /** Does the batch turn apply to this page's effective orientation? */
  function applies(eff) {
    const scope = ui.scope?.value ?? 'all';
    return scope === 'all' || eff === scope;
  }

  function counts() {
    let total = 0;
    let landscape = 0;
    let portrait = 0;
    let willTurn = 0;
    let pendingFiles = 0;
    let badFiles = 0;
    for (const file of fileList()) {
      const m = meta.get(file);
      if (m === undefined) { pendingFiles++; continue; }
      if (m === null) { badFiles++; continue; }
      total += m.count;
      for (const eff of m.eff) {
        if (eff === 'landscape') landscape++;
        else if (eff === 'portrait') portrait++;
        if (applies(eff)) willTurn++;
      }
    }
    return { total, landscape, portrait, willTurn, pendingFiles, badFiles };
  }

  function update() {
    if (!ui.explain) return;
    paintFacts();
    paintGroups();

    const n = fileList().length;
    if (!n) { ui.explain.set(''); return; }
    const c = counts();
    if (c.pendingFiles) { ui.explain.set('Reading pages…'); return; }

    const phrase = TURN_PHRASE[ui.turn.value];
    const scope = ui.scope.value;
    const across = n > 1 ? ` across ${n} PDFs` : '';
    if (scope === 'all') {
      ui.explain.set(c.total
        ? `All ${c.total} page${c.total === 1 ? '' : 's'}${across} will ${phrase}.`
        : 'These files have no pages to turn.');
    } else if (c.willTurn) {
      ui.explain.set(`Only the ${c.willTurn} ${scope} page${c.willTurn === 1 ? '' : 's'}${across} will ${phrase}. The other ${c.total - c.willTurn} stay as they are.`);
    } else {
      ui.explain.set(`No ${scope} pages found${across} — nothing would turn. Switch "Which pages", or check the preview.`);
    }
  }

  function paintFacts() {
    if (!ui.facts) return;
    const n = fileList().length;
    if (!n) { ui.facts.set([]); return; }
    const c = counts();
    const rows = [
      ['Files', String(n)],
      ['Total size', formatBytes(fileList().reduce((s, f) => s + f.size, 0))],
    ];
    if (c.total) {
      rows.push(['Total pages', String(c.total)]);
      if (c.landscape) rows.push(['Landscape pages', String(c.landscape)]);
      if (c.portrait) rows.push(['Portrait pages', String(c.portrait)]);
      rows.push(['Will turn', `${c.willTurn} of ${c.total}`]);
    }
    if (c.pendingFiles) rows.push(['Still reading', String(c.pendingFiles)]);
    if (c.badFiles) rows.push(['Could not open', String(c.badFiles)]);
    ui.facts.set(rows);
  }

  /**
   * One dashed group per PDF, its pages as thumbnails with the pending turn
   * already applied as a CSS transform — the export writes the same degrees
   * into /Rotate, so what the student sees here is what comes out.
   */
  function paintGroups() {
    if (!groupsHost) return;
    groupsHost.innerHTML = '';
    if (!fileList().length) return;
    const delta = TURN_DEGREES[ui.turn?.value ?? 'right'];

    let shownTotal = 0;
    for (const file of fileList()) {
      const m = meta.get(file);
      const box = el(`<div class="ts__group"><span class="ts__group__tag"></span><div class="ts__group__pages"></div></div>`);
      const tag = box.querySelector('.ts__group__tag');
      tag.textContent = m
        ? `${file.name} · ${m.count} page${m.count === 1 ? '' : 's'}`
        : m === null ? `${file.name} — could not open` : `${file.name} — reading…`;
      const rm = el(`<button class="ts__card__btn" type="button" title="Remove this PDF" style="margin-left:6px;width:18px;height:18px;vertical-align:-5px">✕</button>`);
      rm.addEventListener('click', () => removeFile(file));
      tag.appendChild(rm);

      // In the DOM before the thumbnails go in: fitScale reads layout sizes,
      // and a detached node measures 0×0.
      groupsHost.appendChild(box);

      const pagesHost = box.querySelector('.ts__group__pages');
      const list = thumbs.get(file) ?? [];
      list.forEach((canvas, i) => {
        const cell = el(`<div class="ts__page"><span class="ts__page__n"></span></div>`);
        cell.querySelector('.ts__page__n').textContent = String(i + 1);
        cell.prepend(canvas);
        pagesHost.appendChild(cell);
        const turning = m && applies(m.eff[i]);
        canvas.style.transformOrigin = 'center';
        canvas.style.transition = 'transform .18s ease';
        canvas.style.transform = turning ? `rotate(${delta}deg) scale(${fitScale(canvas, delta)})` : 'none';
      });
      if (m && m.count > list.length) {
        pagesHost.appendChild(el(`<span class="ts__group__more">…</span>`));
      }
      shownTotal += list.length;
    }
    const totalPages = counts().total;
    if (totalPages > shownTotal && shownTotal >= MAX_PREVIEW_PAGES) {
      groupsHost.appendChild(el(`<p class="ts__hint">Thumbnails stop at ${MAX_PREVIEW_PAGES} pages — every page still turns.</p>`));
    }
  }

  /**
   * A portrait thumbnail turned on its side is wider than the slot it sits in.
   * Shrinking it by exactly the overflow keeps the whole page visible, which
   * is the entire point of looking at it. (Layout sizes are read after the
   * cell is in the DOM, so they are the sizes before any transform.)
   */
  function fitScale(media, deg) {
    const dw = media.clientWidth;
    const dh = media.clientHeight;
    if (!dw || !dh) return 1;
    const rad = (deg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    return Math.min(1, dw / (dw * c + dh * s), dh / (dw * s + dh * c));
  }

  /**
   * Defining workarea() hides the shell's own file cards, so removing a file
   * happens here: splice the shell's array and refresh, exactly what its own
   * ✕ button does. An empty list goes back to the uploader.
   */
  function removeFile(file) {
    const i = fileList().indexOf(file);
    if (i >= 0) fileList().splice(i, 1);
    meta.delete(file);
    thumbs.delete(file);
    shellCtx.refresh();
    if (!fileList().length) shellCtx.stage('upload');
  }
}
