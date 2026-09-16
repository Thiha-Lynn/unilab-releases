import {
  PDFBool, PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList,
  PDFRadioGroup, PDFSignature, PDFTextField,
} from 'pdf-lib';
import { el, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';
import { toolShell } from '../tool-shell.js';
import { checkRow, fileFacts, infoBox, liveExplain, optionPanel, selectField } from '../option-ui.js';

// A university form is rarely more than a few pages, and rendering every page of
// a 90-page handbook to find two signature boxes helps nobody.
const MAX_PREVIEW_PAGES = 12;
const PREVIEW_WIDTH = 780;   // css px the page canvas is rendered for

// pdf-lib draws flattened field text with the 14 built-in fonts, which are
// WinAnsi-encoded: anything above U+00FF has no glyph and throws rather than
// silently writing boxes. Everything at or below it is safe.
const encodableByBuiltInFont = (s) => ![...String(s)].some((c) => c.codePointAt(0) > 0xff);

// The two faces Edit PDF ships, fetched same-origin from public/fonts and only
// when an answer actually needs one. A Thai name in a form field is the normal
// case here, not the exception, so it has to come out right rather than as a
// row of boxes.
const SCRIPT_FONTS = {
  thai: { file: 'NotoSansThai-Regular.ttf', label: 'Thai' },
  myanmar: { file: 'NotoSansMyanmar-Regular.ttf', label: 'Burmese' },
};

export default function render(container, tool) {
  const state = {
    file: null,
    pageCount: 0,
    fields: [],        // the descriptors below, in reading order
    signatures: 0,     // signature fields, which this tool deliberately leaves alone
    isXfa: false,
    overlays: [],      // { field, node, valueNode, option }
    previewDoc: null,  // the pdf.js document the workarea is drawn from
    token: 0,          // bumped per load so a slow preview from the old file is dropped
  };
  const ui = {};
  let areaHost = null;
  let fieldsHost = null;
  let notice = null;

  toolShell(container, tool, {
    accept: 'application/pdf,.pdf',
    multiple: false,
    pickLabel: 'Select a PDF form',
    dropLabel: 'or drop the form here',
    actionLabel: 'Fill form',
    doneTitle: 'Your form is filled in!',
    downloadLabel: 'Download filled form',
    continueTo: ['sign-pdf', 'compress-pdf'],
    note: 'Leave requests, add/drop slips, internship consent forms — most of them are real PDF forms, so the boxes are already there. Fill them here, flatten, and what you email is exactly what the office sees.',

    // The workarea is the form itself with every field outlined and every answer
    // drawn where it will land, so typing in the sidebar visibly fills the page.
    workarea(host) { areaHost = host; },

    async onFiles(ctx) {
      state.file = ctx.files[0] ?? null;
      await loadFile();
    },

    options(host) {
      const panel = optionPanel('Fill in');
      ui.facts = fileFacts();
      ui.info = infoBox('');
      ui.info.root.hidden = true;

      // The per-field controls cannot exist before a file does, so the panel
      // keeps an empty shelf for them and fills it in on load.
      fieldsHost = el(`<div style="display:flex;flex-direction:column;gap:15px"></div>`);

      ui.flatten = checkRow('Flatten so the answers cannot be changed', {
        checked: true,
        hint: 'Flattening prints the answers onto the page. Nobody — including you — can edit them out afterwards.',
        onChange: update,
      });

      ui.warn = infoBox('');
      ui.warn.root.hidden = true;
      ui.explain = liveExplain();

      panel.add(ui.facts, ui.info, fieldsHost, ui.flatten, ui.warn, ui.explain);
      host.appendChild(panel.root);
      update();
      return {};
    },

    async run(ctx) {
      if (!state.fields.length) {
        throw new Error(state.isXfa
          ? 'This is an XFA form — the kind only Adobe Acrobat can fill in. Print it, fill it by hand and scan it, or type on top of it with Edit PDF.'
          : 'This PDF has no fillable fields, so there is nothing to fill in. Edit PDF lets you type straight onto the page instead.');
      }

      const flatten = ui.flatten.value;
      const risky = riskyFields();

      const doc = await PDFDocument.load(await state.file.arrayBuffer(), {
        ignoreEncryption: true, updateMetadata: false,
      });
      const form = doc.getForm();

      // A Thai or Burmese answer cannot be drawn with a built-in font, so a real
      // one is embedded before anything is drawn. Anything else non-Latin, we
      // have no font for and say so rather than writing boxes.
      let scriptFont = null;
      const scripts = scriptsNeeded(risky.map((f) => String(f.value ?? '')));
      if (risky.length) {
        ctx.setBusy(0.05, 'Embedding a font that can spell those answers…');
        scriptFont = await embedScriptFont(doc, drawnValues());
        if (!scriptFont && flatten) throw new Error(missingFontMessage(risky[0], scripts));
      }
      if (ctx.signal?.aborted) throw new Error('canceled');

      const changed = state.fields.filter((f) => f.dirty && !f.readOnly);
      for (let i = 0; i < changed.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        ctx.setBusy(i / (changed.length + 1), `Filling in ${i + 1} of ${changed.length}…`);
        applyValue(form, changed[i]);
        // Yield every few fields — a 200-field form should never freeze the tab.
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }

      ctx.setBusy(0.9, flatten ? 'Flattening…' : 'Saving…');
      // With an embedded font the appearances have to be generated here, using
      // it — pdf-lib's own pass would reach for Helvetica and fail again.
      if (scriptFont) form.updateFieldAppearances(scriptFont);
      if (flatten) {
        try {
          form.flatten(scriptFont ? { updateFieldAppearances: false } : undefined);
        } catch (err) {
          throw new Error(`This form could not be flattened (${err.message}). Untick “Flatten so the answers cannot be changed” — the answers will still be saved, they will just stay editable.`);
        }
      }

      // No font for this script and nothing flattened: leave the answers as live
      // form data and ask the reader to draw them, which is what NeedAppearances
      // is for. Not ideal, but it beats writing boxes.
      const readerDraws = !flatten && risky.length > 0 && !scriptFont;
      if (readerDraws) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);

      const bytes = await doc.save({ updateFieldAppearances: !readerDraws && !scriptFont });
      if (ctx.signal?.aborted) throw new Error('canceled');

      showNotice(
        readerDraws
          ? 'Those answers are stored in the form, but they are drawn by whichever app opens the PDF — check it in the reader the office uses before you send it.'
          : !flatten
            ? 'The answers are saved but still editable. Run this tool again with “Flatten” ticked before you submit the form.'
            : scriptFont
              ? `A ${SCRIPT_FONTS[[...scripts][0]]?.label ?? ''} font was embedded so the answers print the same everywhere — that is the extra few tens of KB in the file size.`
              : null,
      );

      return {
        outputs: [{ name: `${stem(state.file.name)}-filled.pdf`, blob: new Blob([bytes], { type: 'application/pdf' }) }],
        doneTitle: flatten ? 'Your form is filled in and flattened!' : 'Your form is filled in!',
      };
    },
  });

  // Leaving the tool releases the pdf.js document behind the preview; the shell
  // tears down its own state on the same event.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    closePreviewDoc(state.previewDoc);
  });

  // -------------------------------------------------------------------------

  async function loadFile() {
    const token = ++state.token;
    resetPreview();
    showNotice(null);
    Object.assign(state, { pageCount: 0, fields: [], signatures: 0, isXfa: false, overlays: [] });
    fieldsHost.innerHTML = '';
    if (!state.file) { closePreviewDoc(state.previewDoc); update(); return; }

    const doc = await PDFDocument.load(await state.file.arrayBuffer(), {
      ignoreEncryption: true, updateMetadata: false,
    });
    state.pageCount = doc.getPageCount();

    const form = doc.getForm();
    state.isXfa = form.acroForm.dict.has(PDFName.of('XFA'));
    const pageOf = widgetPageIndexer(doc);
    const boxes = doc.getPages().map((p) => pageBox(p));

    let raw = [];
    try {
      raw = form.getFields();
    } catch {
      /* a malformed AcroForm reads as "no fields", which is what the user sees anyway */
    }

    for (const field of raw) {
      const described = describe(field, pageOf, boxes);
      if (described === 'signature') { state.signatures++; continue; }
      if (described) state.fields.push(described);
    }
    // Reading order: down the first page, then the next — the order a person
    // would work through the paper version.
    state.fields.sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left);

    ui.facts.set([
      ['Original size', formatBytes(state.file.size)],
      ['Total pages', String(state.pageCount)],
      ['Form fields', `${state.fields.length} field${state.fields.length === 1 ? '' : 's'} found`],
    ]);
    buildControls();
    update();
    await renderPreview(token);
  }

  /** One descriptor per fillable field, or 'signature', or null for a push button. */
  function describe(field, pageOf, boxes) {
    let name;
    try { name = field.getName(); } catch { return null; }

    const base = {
      name,
      label: prettyName(name),
      readOnly: safe(() => field.isReadOnly(), false),
      field,
    };

    let d = null;
    if (field instanceof PDFTextField) {
      const text = safe(() => field.getText(), '') ?? '';
      d = { ...base, kind: 'text', value: text, multiline: safe(() => field.isMultiline(), false), maxLength: safe(() => field.getMaxLength(), undefined) };
    } else if (field instanceof PDFCheckBox) {
      d = { ...base, kind: 'check', value: safe(() => field.isChecked(), false) };
    } else if (field instanceof PDFRadioGroup) {
      d = { ...base, kind: 'radio', options: safe(() => field.getOptions(), []), value: safe(() => field.getSelected(), '') ?? '' };
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      d = { ...base, kind: 'choice', options: safe(() => field.getOptions(), []), value: safe(() => field.getSelected(), [])?.[0] ?? '' };
    } else if (field instanceof PDFSignature) {
      return 'signature';
    } else {
      return null;   // push buttons: nothing to fill in
    }

    // Where each widget sits, in the coordinates the preview canvas uses.
    d.widgets = safe(() => field.acroField.getWidgets(), []).map((w, i) => {
      const page = pageOf(w);
      const rect = normalizeRect(safe(() => w.getRectangle(), null));
      const box = boxes[page] ?? boxes[0];
      return rect && box
        ? { page, ...toDisplay(rect, box), option: d.options?.[i] }
        : null;
    }).filter(Boolean);

    d.initial = d.value;
    d.dirty = false;
    d.page = d.widgets[0]?.page ?? 0;
    d.top = d.widgets[0]?.top ?? 0;
    d.left = d.widgets[0]?.left ?? 0;
    return d;
  }

  // ---- the sidebar controls ------------------------------------------------

  function buildControls() {
    fieldsHost.innerHTML = '';
    if (!state.fields.length) {
      ui.info.set(state.isXfa
        ? 'This is an XFA form — the dynamic kind that only Adobe Acrobat can fill in. Edit PDF will let you type on top of it instead.'
        : 'This PDF has no fillable fields — the boxes on it are just drawn lines. Edit PDF lets you type straight onto the page.');
      ui.info.root.hidden = false;
      return;
    }
    ui.info.set(state.signatures
      ? `${state.signatures} signature field${state.signatures === 1 ? '' : 's'} on this form are left alone — add your signature with Sign PDF afterwards.`
      : '');
    ui.info.root.hidden = !state.signatures;

    let lastPage = -1;
    for (const f of state.fields) {
      if (f.page !== lastPage) {
        lastPage = f.page;
        const head = el(`<p class="opt__label" style="margin:8px 0 -6px"><span></span></p>`);
        head.querySelector('span').textContent = `Page ${f.page + 1}`;
        fieldsHost.appendChild(head);
      }
      fieldsHost.appendChild(controlFor(f));
    }
  }

  function controlFor(f) {
    if (f.kind === 'check') {
      const row = checkRow(f.label, {
        checked: f.value,
        onChange: (v) => setValue(f, v),
      });
      f.input = row.el;
      wireFocus(f);
      if (f.readOnly) row.el.disabled = true;
      return row.root;
    }

    if (f.kind === 'radio' || f.kind === 'choice') {
      // A blank first option is what "I have not answered this yet" looks like;
      // without it the first option would silently become the answer.
      const options = [{ id: '', label: '— not chosen —' }, ...(f.options ?? []).map((o) => ({ id: o, label: o || '(blank)' }))];
      const sel = selectField(f.label, options, {
        value: f.value,
        onChange: (v) => setValue(f, v),
      });
      if (f.readOnly) sel.el.disabled = true;
      f.input = sel.el;
      wireFocus(f);
      return sel.root;
    }

    // Text: option-ui has no text input, so this is the same .opt__select shell
    // the selects use, which is exactly how their sidebar text fields look.
    const wrap = el(`<div class="opt__field"><label class="opt__label"><span></span></label></div>`);
    wrap.querySelector('span').textContent = f.label;
    const input = el(f.multiline
      ? `<textarea class="opt__select" rows="3" spellcheck="false" style="resize:vertical"></textarea>`
      : `<input class="opt__select" type="text" spellcheck="false" />`);
    input.value = f.value ?? '';
    if (f.maxLength) input.maxLength = f.maxLength;
    if (f.readOnly) {
      input.disabled = true;
      wrap.querySelector('.opt__label').appendChild(el(`<span class="opt__counter">locked</span>`));
    }
    input.addEventListener('input', () => setValue(f, input.value));
    wrap.appendChild(input);
    f.input = input;
    wireFocus(f);
    return wrap;
  }

  /** Focusing a control lights up its box on the page, and vice versa. */
  function wireFocus(f) {
    f.input?.addEventListener('focus', () => highlight(f, true));
    f.input?.addEventListener('blur', () => highlight(f, false));
  }

  function setValue(f, value) {
    f.value = value;
    f.dirty = value !== f.initial;
    paintValues();
    update();
  }

  // ---- the page preview ----------------------------------------------------

  function resetPreview() {
    if (areaHost) areaHost.innerHTML = '';
    state.overlays = [];
  }

  function closePreviewDoc(doc) {
    if (!doc) return;
    if (state.previewDoc === doc) state.previewDoc = null;
    try { doc.destroy?.(); } catch { /* already gone */ }
  }

  async function renderPreview(token) {
    if (!areaHost || !state.file) return;
    areaHost.innerHTML = '';
    areaHost.appendChild(el(`<p class="ts__hint">Rendering the form…</p>`));

    const pdf = await openPdf(state.file);
    if (token !== state.token) { closePreviewDoc(pdf); return; }
    // Only one rendering document at a time: the previous form's pdf.js worker
    // and page cache go the moment this one is open.
    closePreviewDoc(state.previewDoc);
    state.previewDoc = pdf;
    areaHost.innerHTML = '';
    state.overlays = [];

    // Show the pages the fields are actually on. On a 40-page handbook with two
    // boxes on page 33, rendering pages 1–12 would show nothing at all.
    const withFields = [...new Set(state.fields.map((f) => f.page))].sort((a, b) => a - b);
    // With no fields to outline there is nothing to look at, so show just enough
    // of the document for the user to recognise it and move on to Edit PDF.
    const all = withFields.length ? withFields : [...Array(pdf.numPages).keys()];
    const cap = withFields.length ? MAX_PREVIEW_PAGES : 3;
    const list = all.filter((p) => p < pdf.numPages).slice(0, cap).map((p) => p + 1);

    for (const i of list) {
      let canvas;
      try {
        const page = await pdf.getPage(i);
        const unit = page.getViewport({ scale: 1 });
        canvas = await renderPage(pdf, i, Math.min(2, PREVIEW_WIDTH / unit.width));
      } catch (err) {
        // A newer form closed this document mid-render. That is a swap, not a
        // failure, and must not surface as an error over the new file.
        if (token !== state.token) return;
        throw err;
      }
      if (token !== state.token) return;   // the newer load already closed this one

      const group = el(`<div class="ts__group"><span class="ts__group__tag"></span></div>`);
      group.querySelector('.ts__group__tag').textContent = `Page ${i}`;
      // container-type lets the drawn answers scale with the page instead of
      // staying a fixed pixel size when the pane narrows on a phone.
      const stage = el(`<div style="position:relative;container-type:inline-size;max-width:100%"></div>`);
      canvas.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px';
      stage.appendChild(canvas);
      group.appendChild(stage);
      areaHost.appendChild(group);

      const aspect = canvas.height / canvas.width;
      for (const f of state.fields) {
        for (const w of f.widgets) {
          if (w.page !== i - 1) continue;
          stage.appendChild(makeOverlay(f, w, aspect));
        }
      }
      // Yield between pages so a long form never blocks typing.
      await new Promise((r) => setTimeout(r, 0));
    }

    const hidden = all.length - list.length;
    if (hidden > 0) {
      const more = el(`<p class="ts__hint"></p>`);
      more.textContent = state.fields.length
        ? `…and ${hidden} more page${hidden === 1 ? '' : 's'} with fields on, filled in exactly the same way.`
        : `…and ${hidden} more page${hidden === 1 ? '' : 's'} in this file.`;
      areaHost.appendChild(more);
    }
    if (!state.fields.length) {
      areaHost.appendChild(el(`<p class="ts__hint">No fillable fields to outline on this one.</p>`));
    }
    paintValues();
  }

  function makeOverlay(f, w, aspect) {
    const node = el(`<div><span></span></div>`);
    // A widget's height in page-width units is what the drawn answer should be
    // sized against — that is what keeps a signature box's text big and a tick
    // box's tick small.
    const fontCqw = Math.max(1.3, Math.min(6, w.height * aspect * 100 * 0.6));
    node.style.cssText = [
      'position:absolute',
      `left:${(w.left * 100).toFixed(3)}%`,
      `top:${(w.top * 100).toFixed(3)}%`,
      `width:${(w.width * 100).toFixed(3)}%`,
      `height:${(w.height * 100).toFixed(3)}%`,
      'display:flex', 'align-items:center', 'overflow:hidden',
      'border-radius:2px', 'line-height:1.1',
      `cursor:${f.kind === 'text' ? 'text' : 'pointer'}`,
      `font-size:${fontCqw.toFixed(2)}cqw`,
      'color:var(--ink)', 'font-weight:600',
    ].join(';');
    node.title = f.label;
    // Ticking the box on the page is what a person expects to be able to do, so
    // the click goes both ways: the page drives the sidebar as well.
    node.addEventListener('click', () => {
      if (!f.readOnly && f.input) {
        if (f.kind === 'check') {
          f.input.checked = !f.value;
          setValue(f, f.input.checked);
        } else if (f.kind === 'radio' && w.option !== undefined) {
          const next = f.value === w.option ? '' : w.option;
          f.input.value = next;
          setValue(f, next);
        }
      }
      f.input?.focus();
    });

    const value = node.querySelector('span');
    value.style.cssText = f.kind === 'text' || f.kind === 'choice'
      ? 'padding:0 2%;white-space:pre-wrap;overflow:hidden;width:100%'
      : 'margin:auto;color:var(--cc,var(--accent))';

    const overlay = { field: f, node, valueNode: value, option: w.option, kind: f.kind };
    state.overlays.push(overlay);
    paintOverlay(overlay);
    return node;
  }

  function paintOverlay(o) {
    const f = o.field;
    // Whichever control has the caret is the box that lights up — asking the
    // document keeps that true through every repaint while someone types.
    const focused = f.input && document.activeElement === f.input;
    const on = f.kind === 'check' ? f.value
      : f.kind === 'radio' ? (f.value !== '' && f.value === o.option)
        : String(f.value ?? '') !== '';

    o.valueNode.textContent =
      f.kind === 'check' ? (f.value ? '✓' : '')
        : f.kind === 'radio' ? (f.value === o.option && f.value !== '' ? '●' : '')
          : String(f.value ?? '');

    const accent = 'var(--cc, var(--accent))';
    o.node.style.outline = focused
      ? `2px solid ${accent}`
      : `1.5px ${on ? 'solid' : 'dashed'} color-mix(in srgb, ${accent} ${on ? 55 : 38}%, transparent)`;
    o.node.style.outlineOffset = '0px';
    o.node.style.background = focused
      ? `color-mix(in srgb, ${accent} 18%, transparent)`
      : `color-mix(in srgb, ${accent} ${on ? 9 : 6}%, transparent)`;
  }

  function paintValues() {
    for (const o of state.overlays) paintOverlay(o);
  }

  function highlight(f, focused) {
    for (const o of state.overlays) {
      if (o.field !== f) continue;
      paintOverlay(o);
      if (focused) o.node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  // ---- writing the answers back -------------------------------------------

  function applyValue(form, f) {
    try {
      const target = form.getField(f.name);
      if (f.kind === 'text') target.setText(String(f.value ?? ''));
      else if (f.kind === 'check') (f.value ? target.check() : target.uncheck());
      // Going back to "— not chosen —" has to actually clear the answer,
      // otherwise the old one quietly survives into the submitted form.
      else if (f.value === '') target.clear?.();
      else target.select(f.value);
    } catch (err) {
      throw new Error(`Could not fill in “${f.label}”: ${err.message}. Clear that one and try again.`);
    }
  }

  /**
   * Fields whose value would have to be *drawn* with a built-in font and cannot
   * be. Ticks and radio dots are shapes, not letters, so they are always safe —
   * and a value the form arrived with counts just as much as one typed here,
   * because flattening redraws every field on the page.
   */
  function riskyFields() {
    return state.fields.filter((f) => (f.kind === 'text' || f.kind === 'choice')
      && typeof f.value === 'string'
      && !encodableByBuiltInFont(f.value));
  }

  /**
   * Every answer one embedded font would have to spell. pdf-lib updates all
   * changed fields with a single face, so an English answer sitting next to a
   * Thai one has to be encodable by the same font.
   */
  function drawnValues() {
    return state.fields
      .filter((f) => (f.kind === 'text' || f.kind === 'choice') && (f.dirty || !encodableByBuiltInFont(String(f.value ?? ''))))
      .map((f) => String(f.value ?? ''))
      .filter(Boolean);
  }

  function missingFontMessage(field, scripts) {
    const known = scripts.size === 1 && SCRIPT_FONTS[[...scripts][0]];
    return known
      ? `The ${known.label} font could not be loaded, so “${field.label}” cannot be printed onto the page yet. Check your connection and press the button again — it is only fetched once — or untick “Flatten so the answers cannot be changed”.`
      : scripts.size > 1
        ? `The answers on this form mix more than one alphabet, and a printed answer can only carry one embedded font. Fill in and flatten the ${[...scripts].map((s) => SCRIPT_FONTS[s]?.label ?? 'other').join(' and ')} answers in separate runs, or untick “Flatten so the answers cannot be changed” to keep them as form data.`
        : `“${field.label}” uses letters UniLab has no font for. It ships English, Thai and Burmese; anything else would come out as empty boxes, so it is not written. Untick “Flatten so the answers cannot be changed” and the answer is still saved for your PDF reader to draw.`;
  }

  // ---- live explain --------------------------------------------------------

  function update() {
    if (!state.file || !ui.explain) return;
    const total = state.fields.length;
    if (!total) {
      ui.explain.set('');
      ui.warn.root.hidden = true;
      ui.flatten.root.hidden = true;
      return;
    }
    ui.flatten.root.hidden = false;

    const filled = state.fields.filter((f) => (f.kind === 'check' ? f.value : String(f.value ?? '') !== '')).length;
    const flatten = ui.flatten.value;
    ui.explain.set(
      `${filled} of ${total} field${total === 1 ? '' : 's'} filled in. ` +
      (flatten
        ? 'The answers will be printed onto the page, so nobody can edit them out.'
        : 'The answers will stay as editable form data.'),
    );

    const risky = riskyFields();
    const scripts = scriptsNeeded(risky.map((f) => String(f.value ?? '')));
    const known = scripts.size === 1 && SCRIPT_FONTS[[...scripts][0]];
    ui.warn.set(!risky.length ? ''
      : known
        ? `“${risky[0].label}” is in ${known.label}. A ${known.label} font gets embedded when you press the button, so it prints the same on every device — that adds roughly 40 KB to the file.`
        : scripts.size > 1
          ? 'These answers mix more than one alphabet, and a printed answer can only carry one embedded font. Fill them in over two runs, or untick “Flatten” to keep them as form data.'
          : `“${risky[0].label}” uses letters UniLab has no font for. It ships English, Thai and Burmese; anything else cannot be printed onto the page, so untick “Flatten” to keep that answer as form data instead.`);
    ui.warn.root.hidden = !risky.length;
  }

  /** A one-line explanation that survives the jump to the download screen. */
  function showNotice(text) {
    if (!text) { notice?.remove(); notice = null; return; }
    if (!notice) {
      notice = el(`<p class="note"></p>`);
      const tip = container.querySelector('.ts__note');
      container.insertBefore(notice, tip ?? null);
    }
    notice.textContent = text;
  }
}

// ---------------------------------------------------------------------------
// geometry + small helpers

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** Which non-Latin scripts appear in a string, in the terms our fonts speak. */
function scriptsIn(text) {
  const found = new Set();
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c <= 0xff) continue;   // a built-in font already handles these
    if (c >= 0x0e00 && c <= 0x0e7f) found.add('thai');
    else if ((c >= 0x1000 && c <= 0x109f) || (c >= 0xaa60 && c <= 0xaa7f)) found.add('myanmar');
    else found.add('other');
  }
  return found;
}

function scriptsNeeded(values) {
  const all = new Set();
  for (const v of values) for (const s of scriptsIn(v)) all.add(s);
  return all;
}

/**
 * Embeds the one face that can spell every answer on this form, or returns null
 * if no single shipped font can. Subsetted, so only the glyphs actually used
 * travel with the file.
 */
async function embedScriptFont(doc, values) {
  const scripts = scriptsNeeded(values);
  if (scripts.size !== 1) return null;
  const choice = SCRIPT_FONTS[[...scripts][0]];
  if (!choice) return null;
  try {
    // fontkit is a 700 KB module; an English-only form should never pay for it.
    const { default: fontkit } = await import('@pdf-lib/fontkit');
    doc.registerFontkit(fontkit);
    const url = new URL(`${import.meta.env.BASE_URL}fonts/${choice.file}`, document.baseURI);
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const font = await doc.embedFont(await res.arrayBuffer(), { subset: true });
    // Proof rather than hope: the face has to spell every answer it will draw,
    // including the Latin ones sitting beside the Thai.
    for (const v of values) font.encodeText(v);
    return font;
  } catch {
    return null;
  }
}

/** "student.name.first" and "Text1" both read badly in a sidebar. */
function prettyName(name) {
  const leaf = String(name).split('.').pop();
  const spaced = leaf.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Some forms store /Rect corners the other way round; both mean one box. */
function normalizeRect(rect) {
  if (!rect) return null;
  const x = Math.min(rect.x, rect.x + rect.width);
  const y = Math.min(rect.y, rect.y + rect.height);
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

/** The page's visible box and rotation, as pdf.js will render it. */
function pageBox(page) {
  // pdf.js renders the crop box, so field positions must be measured against it
  // — on a scan cropped down from A3 the media box is the wrong ruler.
  const raw = safe(() => page.getCropBox(), null) ?? safe(() => page.getMediaBox(), null);
  const box = normalizeRect(raw);
  if (!box || !box.width || !box.height) return null;
  const angle = safe(() => page.getRotation().angle, 0);
  return { ...box, rotation: (((Math.round(angle / 90) * 90) % 360) + 360) % 360 };
}

/**
 * PDF space (origin bottom-left, y up) → the rendered image (origin top-left,
 * y down), as fractions of the rendered width and height. pdf.js bakes /Rotate
 * into its viewport, so the same rotation has to be applied here or every field
 * on a landscape scan lands in the wrong place.
 */
function toDisplay(rect, box) {
  const u1 = (rect.x - box.x) / box.width;
  const u2 = (rect.x + rect.width - box.x) / box.width;
  const v1 = (rect.y - box.y) / box.height;
  const v2 = (rect.y + rect.height - box.y) / box.height;
  const [ax, ay] = rotatePoint(u1, v1, box.rotation);
  const [bx, by] = rotatePoint(u2, v2, box.rotation);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

function rotatePoint(u, v, rotation) {
  if (rotation === 90) return [v, u];
  if (rotation === 180) return [1 - u, v];
  if (rotation === 270) return [1 - v, 1 - u];
  return [u, 1 - v];
}

/**
 * Which page each widget lives on. /P is the direct answer, but plenty of forms
 * built by older software leave it out, so fall back to the page that actually
 * lists the annotation.
 */
function widgetPageIndexer(doc) {
  const pages = doc.getPages();
  const byRef = new Map();
  const byDict = new Map();
  pages.forEach((page, i) => {
    byRef.set(String(page.ref), i);
    const annots = safe(() => page.node.Annots(), null);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const dict = safe(() => annots.lookup(k), null);
      if (dict) byDict.set(dict, i);
    }
  });
  // pdf-lib's annotation class has no accessor for /P, so the entry is read
  // straight off the dictionary. It is a reference to the page object, which is
  // exactly what byRef is keyed on.
  const P = PDFName.of('P');
  return (widget) => {
    const ref = safe(() => widget.dict.get(P), undefined);
    const viaRef = ref ? byRef.get(String(ref)) : undefined;
    if (viaRef !== undefined) return viaRef;
    return byDict.get(widget.dict) ?? 0;
  };
}
