import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { canvasToBlob, el, formatBytes, stem } from '../ui.js';
// Importing pdf-utils also registers the pdf.js worker — every call below goes
// through the same module instance, so the worker is configured exactly once.
import { renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import { checkRow, fileFacts, infoBox, liveExplain, optionPanel } from '../option-ui.js';

const MAX_PREVIEW_PAGES = 4;
const PREVIEW_WIDTH = 620;
const RASTER_DPI = 150;          // readable, printable, and not enormous
const RASTER_MAX_PX = 3400;      // a hard ceiling so an A0 poster cannot blow up memory
const CHECK_PASSWORD_AFTER = 450;
const KEEP_REBUILT_UNDER = 32 * 1024 * 1024;   // above this, rebuild again rather than hold a second copy

export default function render(container, tool) {
  const state = {
    file: null,
    bytes: null,
    pageCount: 0,
    status: 'idle',   // idle | plain | restricted | locked | broken
    pdf: null,        // the open pdf.js document, once we are allowed one
    password: '',
    passwordOk: false,
    checking: false,
    plan: 'unknown',  // unknown | checking | clean | raster — decided before the button is pressed
    fastBytes: null,  // the finished clean rebuild, when it was cheap to keep
    token: 0,
  };
  const ui = {};
  let areaHost = null;
  let notice = null;
  let checkTimer = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a locked PDF',
    dropLabel: 'or drop it here',
    actionLabel: 'Remove password',
    doneTitle: 'Your PDF is unlocked!',
    downloadLabel: 'Download unlocked PDF',
    continueTo: ['ocr-pdf', 'compress-pdf', 'merge-pdf'],
    note: 'Bank statements, e-tickets and payslips arrive locked to your ID number or birthday. Unlock a copy once and you stop retyping that password every time you open your own file.',

    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Unlock');
      ui.facts = fileFacts();

      // A password box, in the same shell the selects use.
      ui.pw = passwordField('Password that opens this PDF', {
        hint: 'Typed here, used here. It is never sent anywhere and is gone the moment you leave this page.',
        onInput: (v) => {
          state.password = v;
          state.passwordOk = false;
          clearTimeout(checkTimer);
          checkTimer = setTimeout(tryPassword, CHECK_PASSWORD_AFTER);
          update();
        },
      });
      ui.show = checkRow('Show the password', {
        onChange: (v) => { ui.pw.el.type = v ? 'text' : 'password'; },
      });

      ui.info = infoBox(
        'UniLab removes a password you already know. It does not try to guess one, and it never will — that is the line between opening your own file and opening someone else’s.',
      );
      ui.explain = liveExplain();

      panel.add(ui.facts, ui.pw, ui.show, ui.info, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      if (state.status === 'plain') {
        throw new Error('This PDF has no password on it — there is nothing to remove. You can send or print it exactly as it is.');
      }
      if (state.status === 'broken') {
        throw new Error('That file could not be read as a PDF. If it came from a chat app, try downloading it again — half-downloaded files look like this.');
      }
      if (state.status === 'idle' || !state.bytes) {
        throw new Error('Still reading that file. Give it a second and press the button again.');
      }
      if (state.status === 'locked' && !state.passwordOk) {
        if (!state.password) {
          throw new Error('Type the password that opens this PDF first. UniLab cannot work it out for you — it only removes a password you already know.');
        }
        // The background check runs a moment after typing stops. Pressing the
        // button before that must not read as "you did not type one", so the
        // password is checked here and now instead.
        clearTimeout(checkTimer);
        ctx.setBusy(0.02, 'Checking that password…');
        if (!(await adoptPassword(state.password))) {
          throw new Error('That password does not open this PDF. Check for capital letters — Thai bank statements often use your ID number, or a birthday written as DDMMYYYY.');
        }
      }

      ctx.setBusy(0.05, 'Opening the PDF…');
      // Normally the preview already holds an open copy; this is the safety net
      // for the case where it does not, and it is the one we have to close.
      const scratch = state.pdf ? null : await openWith(state.bytes, state.password);
      const source = state.pdf ?? scratch;
      const pageCount = source.numPages;

      // Fast path: rebuild the file without the /Encrypt entry. When the
      // protection was only an owner password over content that was never
      // really scrambled, this comes out whole — text, links and all. Which of
      // the two routes applies was normally settled while the file loaded, so
      // the sidebar could say so before the button was pressed.
      ctx.setBusy(0.15, 'Rebuilding without the password…');
      let bytes = null;
      let rasterised = false;
      try {
        if (state.plan !== 'raster') {
          bytes = state.fastBytes ?? await stripEncryptEntry(state.bytes);
          if (bytes && state.plan !== 'clean') {
            ctx.setBusy(0.35, 'Checking the rebuilt file…');
            const rebuilt = await tryOpen(bytes);
            const kept = rebuilt ? await keepsContent(source, rebuilt) : false;
            rebuilt?.destroy?.();
            if (!kept) bytes = null;
          }
        }
        if (ctx.signal?.aborted) throw new Error('canceled');

        // Fallback: the content really was encrypted, so the only way out is to
        // redraw each page as pdf.js decrypts it. Honest, and it costs the text.
        if (!bytes) {
          rasterised = true;
          bytes = await rasterRebuild(source, ctx);
        }
      } finally {
        scratch?.destroy?.();
      }

      showNotice(rasterised
        ? 'This one was properly encrypted, so every page had to be redrawn as a picture. The text is no longer selectable or searchable — run OCR PDF on the unlocked file to put a text layer back.'
        : null);

      return {
        outputs: [{
          name: `${stem(state.file.name)}-unlocked.pdf`,
          blob: new Blob([bytes], { type: 'application/pdf' }),
        }],
        doneTitle: rasterised
          ? `Unlocked — ${pageCount} page${pageCount === 1 ? '' : 's'} rebuilt as images`
          : 'Your PDF is unlocked!',
      };
    },
  });

  // -------------------------------------------------------------------------

  async function loadFile() {
    const token = ++state.token;
    clearTimeout(checkTimer);
    showNotice(null);
    closeDoc();
    Object.assign(state, {
      bytes: null, pageCount: 0, status: 'idle', password: '', passwordOk: false,
      plan: 'unknown', fastBytes: null,
    });
    if (ui.pw) ui.pw.el.value = '';
    if (areaHost) areaHost.innerHTML = '';
    if (!state.file) { syncVisibility(); update(); return; }

    state.bytes = new Uint8Array(await state.file.arrayBuffer());

    // pdf-lib is the quickest way to ask "is there an /Encrypt dictionary at
    // all", which is what separates "restricted" from "not protected".
    let encrypted = false;
    try {
      const doc = await PDFDocument.load(state.bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
      encrypted = doc.isEncrypted;
      state.pageCount = doc.getPageCount();
    } catch {
      /* pdf.js below is the authority on whether this file is readable */
    }

    try {
      const pdf = await openWith(state.bytes);
      if (token !== state.token) { pdf.destroy?.(); return; }
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      state.status = encrypted ? 'restricted' : 'plain';
    } catch (err) {
      if (err?.name === 'PasswordException') {
        state.status = 'locked';
      } else {
        state.status = 'broken';
      }
    }

    paintFacts();
    syncVisibility();
    update();
    await paintPreview(token);
    await assessPlan(token);
  }

  function paintFacts() {
    if (!ui.facts || !state.file) return;
    ui.facts.set([
      ['Original size', formatBytes(state.file.size)],
      ['Total pages', state.pageCount ? String(state.pageCount) : '—'],
      ['Protection', {
        plain: 'None',
        restricted: 'Restricted, opens without a password',
        locked: state.passwordOk ? 'Password required — yours works' : 'Password required',
        broken: 'Could not be read',
      }[state.status] ?? '—'],
    ]);
  }

  /**
   * Works out, before the button is ever pressed, which of the two routes this
   * file will take — because "the text stops being selectable" is something a
   * person deserves to know *before* they commit, not in the result screen.
   */
  async function assessPlan(token) {
    if (!state.pdf || state.status === 'plain') return;
    // On a very large file the trial rebuild costs more than the answer is
    // worth up front, so leave it to the run and say so plainly instead.
    if (state.bytes.length > KEEP_REBUILT_UNDER * 2) return;
    state.plan = 'checking';
    state.fastBytes = null;
    update();

    const bytes = await stripEncryptEntry(state.bytes);
    let kept = false;
    if (bytes) {
      const rebuilt = await tryOpen(bytes);
      kept = rebuilt ? await keepsContent(state.pdf, rebuilt) : false;
      rebuilt?.destroy?.();
    }
    if (token !== state.token) return;

    state.plan = kept ? 'clean' : 'raster';
    // Hold on to the finished rebuild unless the file is big enough that a
    // second copy in memory would cost more than simply redoing the work.
    state.fastBytes = kept && bytes.length <= KEEP_REBUILT_UNDER ? bytes : null;
    update();
  }

  /** Opens the file with this password and, if it works, keeps that document. */
  async function adoptPassword(password) {
    const token = state.token;
    state.checking = true;
    update();
    try {
      const pdf = await openWith(state.bytes, password);
      if (token !== state.token) { pdf.destroy?.(); return false; }
      closeDoc();
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      state.passwordOk = true;
      return true;
    } catch {
      state.passwordOk = false;
      return false;
    } finally {
      state.checking = false;
      paintFacts();
      update();
    }
  }

  /** Runs a little after typing stops: does this password actually open it? */
  async function tryPassword() {
    if (state.status !== 'locked' || !state.password) { update(); return; }
    const token = state.token;
    if (!(await adoptPassword(state.password))) return;
    if (token !== state.token) return;
    await paintPreview(token);
    await assessPlan(token);
  }

  // ---- the preview ---------------------------------------------------------

  async function paintPreview(token) {
    if (!areaHost) return;
    areaHost.innerHTML = '';

    if (!state.pdf) {
      const box = el(`<div class="ts__group"><span class="ts__group__tag"></span><p class="ts__hint"></p></div>`);
      box.querySelector('.ts__group__tag').textContent = state.status === 'broken' ? 'Unreadable' : 'Locked';
      box.querySelector('.ts__hint').textContent = state.status === 'broken'
        ? 'This file could not be opened as a PDF at all.'
        : 'Type the password in the sidebar and the pages appear here — that is how you know it is the right one.';
      areaHost.appendChild(box);
      return;
    }

    const pdf = state.pdf;
    const shown = Math.min(pdf.numPages, MAX_PREVIEW_PAGES);
    for (let i = 1; i <= shown; i++) {
      let canvas;
      try {
        const page = await pdf.getPage(i);
        const unit = page.getViewport({ scale: 1 });
        canvas = await renderPage(pdf, i, Math.min(1.6, PREVIEW_WIDTH / unit.width));
      } catch (err) {
        // Another file, or another password, closed this document mid-render.
        // That is a swap, not a failure the student needs to read about.
        if (token !== state.token || state.pdf !== pdf) return;
        throw err;
      }
      if (token !== state.token || state.pdf !== pdf) return;
      const group = el(`<div class="ts__group"><span class="ts__group__tag"></span></div>`);
      group.querySelector('.ts__group__tag').textContent = `Page ${i}`;
      canvas.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px';
      group.appendChild(canvas);
      areaHost.appendChild(group);
      // Yield between pages so the sidebar stays responsive while typing.
      await new Promise((r) => setTimeout(r, 0));
    }
    if (pdf.numPages > shown) {
      areaHost.appendChild(el(`<p class="ts__hint">…and ${pdf.numPages - shown} more pages, all unlocked the same way.</p>`));
    }
  }

  // ---- rebuilding ----------------------------------------------------------

  /**
   * Re-save the file with the /Encrypt entry dropped from the trailer. pdf-lib
   * does not decrypt anything, so this only produces a working PDF when the
   * content streams were never actually scrambled — which is exactly the
   * owner-password-only case. Whether it worked is checked, not assumed.
   */
  async function stripEncryptEntry(bytes) {
    try {
      const doc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
      doc.context.trailerInfo.Encrypt = undefined;
      return await doc.save();
    } catch {
      return null;
    }
  }

  /** Every page redrawn through pdf.js — the only route out of real encryption. */
  async function rasterRebuild(pdf, ctx) {
    const out = await PDFDocument.create();
    const total = pdf.numPages;
    for (let i = 1; i <= total; i++) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy(0.4 + (0.55 * (i - 1)) / total, `Redrawing page ${i} of ${total}…`);

      const page = await pdf.getPage(i);
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(RASTER_DPI / 72, RASTER_MAX_PX / Math.max(unit.width, unit.height));
      const canvas = await renderPage(pdf, i, scale);
      const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.85);
      const image = await out.embedJpg(await jpg.arrayBuffer());
      const sheet = out.addPage([unit.width, unit.height]);
      sheet.drawImage(image, { x: 0, y: 0, width: unit.width, height: unit.height });

      // Drop the bitmap before the next page, or a 200-page scan piles up
      // hundreds of megabytes of canvases.
      canvas.width = 0;
      canvas.height = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
    ctx.setBusy(0.97, 'Saving…');
    return out.save();
  }

  // ---- copy ----------------------------------------------------------------

  function syncVisibility() {
    const needsPassword = state.status === 'locked';
    ui.pw.root.hidden = !needsPassword;
    ui.show.root.hidden = !needsPassword;
  }

  function update() {
    if (!ui.explain) return;
    if (!state.file) { ui.explain.set(''); return; }
    const pages = state.pageCount;
    const many = `${pages} page${pages === 1 ? '' : 's'}`;

    // Once the route is known, the sentence says what the route costs.
    const outcome = state.plan === 'clean'
      ? `UniLab will save a copy of all ${many} with the password gone and the text left exactly as it is.`
      : state.plan === 'raster'
        ? `This one is properly encrypted, so all ${many} have to be redrawn as pictures: they will look the same, but the text stops being selectable. Run OCR PDF on the result to get it back.`
        : state.plan === 'checking'
          ? `Checking how much of these ${many} can be kept…`
          : `UniLab will save a copy of all ${many} with the password gone. If the pages turn out to be properly encrypted they have to be redrawn as pictures — the result will tell you either way.`;

    if (state.status === 'plain') {
      ui.explain.set('This PDF has no password on it. There is nothing for this tool to remove.');
    } else if (state.status === 'broken') {
      ui.explain.set('This file could not be read as a PDF, so there is nothing to unlock.');
    } else if (state.status === 'restricted') {
      ui.explain.set(`This PDF opens without a password but carries restrictions. ${outcome}`);
    } else if (state.passwordOk) {
      ui.explain.set(`That password is correct. ${outcome}`);
    } else if (state.checking) {
      ui.explain.set('Checking that password…');
    } else if (state.password) {
      ui.explain.set('That password does not open this file yet. Check for capital letters — Thai bank statements often use your ID number or your birthday as DDMMYYYY.');
    } else {
      ui.explain.set('This PDF needs a password. Type the one you already use to open it.');
    }
  }

  /** A line that survives the jump to the download screen. */
  function showNotice(text) {
    if (!text) { notice?.remove(); notice = null; return; }
    if (!notice) {
      notice = el(`<p class="note"></p>`);
      const tip = container.querySelector('.ts__note');
      container.insertBefore(notice, tip ?? null);
    }
    notice.textContent = text;
  }

  function closeDoc() {
    state.pdf?.destroy?.();
    state.pdf = null;
  }

  // Leaving the tool must not leave a decrypted document, or the password, alive.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    clearTimeout(checkTimer);
    closeDoc();
    state.bytes = null;
    state.fastBytes = null;
    state.password = '';
  });
}

// ---------------------------------------------------------------------------

/** option-ui has no password control, so this is its select shell with an input. */
function passwordField(label, { hint, onInput } = {}) {
  const root = el(`<div class="opt__field"><label class="opt__label"><span></span></label></div>`);
  root.querySelector('span').textContent = label;
  const input = el(`<input class="opt__select" type="password" autocomplete="off" spellcheck="false" />`);
  input.addEventListener('input', () => onInput?.(input.value));
  root.appendChild(input);
  if (hint) {
    const h = el(`<p class="opt__hint"></p>`);
    h.textContent = hint;
    root.appendChild(h);
  }
  return { root, el: input, get value() { return input.value; } };
}

/** pdf.js takes ownership of the buffer it is handed, so it always gets a copy. */
function openWith(bytes, password) {
  return pdfjsLib.getDocument({ data: bytes.slice(), password, isEvalSupported: false }).promise;
}

async function tryOpen(bytes) {
  try {
    return await openWith(bytes);
  } catch {
    return null;
  }
}

/** Did the rebuilt file keep what the original had on its pages? */
async function keepsContent(source, rebuilt) {
  if (rebuilt.numPages !== source.numPages) return false;
  const probe = await firstMeaningfulPage(source);
  if (probe.kind === 'none') return true;   // a blank document survives either route
  if (probe.kind === 'text') {
    const before = await pageText(source, probe.page);
    const after = await pageText(rebuilt, probe.page);
    return after.slice(0, 60) === before.slice(0, 60);
  }
  const before = await inkRatio(source, probe.page);
  const after = await inkRatio(rebuilt, probe.page);
  return after >= before * 0.5;
}

async function firstMeaningfulPage(pdf) {
  const limit = Math.min(3, pdf.numPages);
  for (let i = 1; i <= limit; i++) {
    if ((await pageText(pdf, i)).length >= 20) return { page: i, kind: 'text' };
  }
  for (let i = 1; i <= limit; i++) {
    if ((await inkRatio(pdf, i)) > 0.004) return { page: i, kind: 'ink' };
  }
  return { page: 1, kind: 'none' };
}

async function pageText(pdf, n) {
  try {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    return content.items.map((i) => i.str ?? '').join('').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** How much of the page is not blank — the only check a scan can answer. */
async function inkRatio(pdf, n) {
  try {
    const canvas = await renderPage(pdf, n, 0.35);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    let seen = 0;
    for (let i = 0; i < data.length; i += 16) {
      seen++;
      if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 235) dark++;
    }
    canvas.width = 0;
    canvas.height = 0;
    return seen ? dark / seen : 0;
  } catch {
    return 0;
  }
}
