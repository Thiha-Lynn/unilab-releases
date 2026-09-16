import { el, downloadBlob, toast } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import { optionPanel, infoBox, liveExplain, selectField, checkRow, sliderField } from '../option-ui.js';
import { OPS, OP_BY_ID, defaultParams, kindOf, runChain, validateChain } from '../ops.js';
import JSZip from 'jszip';

// Chains people actually want, ready to run. Each is the answer to a real evening:
// twelve photos of a whiteboard due as one PDF, a two-hour lecture that has to fit on
// a phone, a report that needs stamping before it goes to the group.
const PRESETS = [
  {
    id: 'notes-to-pdf',
    name: 'Photos of notes → one small PDF',
    steps: [
      { opId: 'compress-image', params: { maxMB: '1.9', maxDim: 2000 } },
      { opId: 'images-to-pdf', params: { name: 'notes' } },
      { opId: 'page-numbers', params: { position: 'bottom-center', start: 1 } },
    ],
  },
  {
    id: 'lecture-to-mp3',
    name: 'Lecture video → small MP3',
    steps: [
      { opId: 'extract-audio', params: { format: 'mp3', kbps: '64', mono: true } },
    ],
  },
  {
    id: 'draft-report',
    name: 'Report → stamped DRAFT and numbered',
    steps: [
      { opId: 'watermark-pdf', params: { text: 'DRAFT', opacity: 18 } },
      { opId: 'page-numbers', params: { position: 'bottom-right', start: 1 } },
    ],
  },
  {
    id: 'shrink-scan',
    name: 'Huge scan → under the LMS limit',
    steps: [
      { opId: 'compress-pdf', params: { quality: '0.5', scale: '1.5' } },
    ],
  },
  {
    id: 'video-for-line',
    name: 'Phone video → sendable clip',
    steps: [
      { opId: 'compress-video', params: { cap: '720', targetMB: '25' } },
    ],
  },
];

const STORE_KEY = 'unilab.workflows.v1';

export default function render(container, tool) {
  let steps = structuredClone(PRESETS[0].steps);
  let selected = 0;
  let pipeHost = null;
  const ui = {};

  toolShell(container, tool, {
    accept: 'image/*,application/pdf,.pdf,video/*,audio/*',
    multiple: true,
    minFiles: 1,
    sortable: true,
    pickLabel: 'Select the files to run through',
    dropLabel: 'or drop them here — photos, PDFs, video or audio',
    actionLabel: 'Run workflow',
    doneTitle: 'Your workflow has finished!',
    downloadLabel: 'Download the result',
    continueTo: ['compress-pdf', 'merge-pdf', 'compress-image'],
    ttlMinutes: 30,
    note: 'A saved workflow is the difference between twelve clicks every week and one. Because nothing is uploaded between steps, a chain here is faster than running the same tools one at a time — the file never leaves memory.',

    workarea(host) { pipeHost = host; paintPipeline(); },

    onFiles() { paintPipeline(); update(); },

    options(host) {
      const panel = optionPanel('Workflow');

      ui.saved = selectField('Saved workflows', savedOptions(), {
        onChange: (id) => loadSaved(id),
      });

      const savedRow = el(`<div class="opt__row"></div>`);
      const saveBtn = el(`<button class="opt__add" type="button">Save this workflow…</button>`);
      const delBtn = el(`<button class="opt__add" type="button" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 50%,transparent)">Delete</button>`);
      saveBtn.addEventListener('click', saveCurrent);
      delBtn.addEventListener('click', deleteCurrent);
      savedRow.append(saveBtn, delBtn);

      // Sharing. Their Workflows are locked to one Premium account; ours are a
      // JSON file you can AirDrop to a groupmate.
      const shareRow = el(`<div class="opt__row"></div>`);
      const exportBtn = el(`<button class="opt__add" type="button">Export file…</button>`);
      const importBtn = el(`<button class="opt__add" type="button">Import file…</button>`);
      const importInput = el(`<input type="file" accept=".json,application/json" hidden />`);
      exportBtn.addEventListener('click', exportCurrent);
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (file) await importFile(file);
      });
      shareRow.append(exportBtn, importBtn, importInput);

      ui.addStep = selectField('Add a step', [{ id: '', label: 'Choose a step…' }, ...OPS.map((o) => ({ id: o.id, label: o.label }))], {
        onChange: (id) => {
          if (!id) return;
          steps.push({ opId: id, params: defaultParams(OP_BY_ID[id]) });
          selected = steps.length - 1;
          ui.addStep.value = '';
          paintPipeline();
          paintParams();
          update();
        },
      });

      ui.paramsHost = el(`<div class="opt__field"></div>`);
      ui.explain = liveExplain();
      ui.problems = infoBox('');
      ui.problems.root.classList.add('opt__info--bad');
      ui.problems.hide(true);

      panel.add(ui.saved, savedRow, shareRow, ui.addStep, ui.paramsHost, ui.problems, ui.explain);
      host.appendChild(panel.root);
      paintParams();
      update();
      return {};
    },

    async run(ctx) {
      const inputKind = kindOf(ctx.files[0]);
      const check = validateChain(steps, inputKind);
      if (!check.ok) throw new Error(check.problems[0].message);
      if (!steps.length) throw new Error('This workflow has no steps yet. Add at least one from the sidebar.');

      const { files, trail } = await runChain(steps, [...ctx.files], {
        signal: ctx.signal,
        onProgress: (frac, label) => ctx.setBusy(frac, label),
      });

      const outputs = files.map((f) => ({ name: f.name, blob: f }));
      return {
        outputs,
        showSavings: true,
        doneTitle: `Your workflow finished — ${outputs.length} file${outputs.length === 1 ? '' : 's'}`,
        downloadLabel: outputs.length === 1 ? `Download ${outputs[0].name}` : `Download ${outputs.length} files`,
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-workflow.zip');
        },
        trail,
      };
    },
  });

  // -------------------------------------------------------------------------
  // The pipeline, drawn in the workarea
  // -------------------------------------------------------------------------

  function paintPipeline() {
    if (!pipeHost) return;
    pipeHost.innerHTML = '';
    const wrap = el(`<div class="wf"></div>`);

    wrap.appendChild(chip('Your files', 'in'));
    steps.forEach((step, i) => {
      const op = OP_BY_ID[step.opId];
      wrap.appendChild(el(`<div class="wf__link"></div>`));
      const card = el(`
        <div class="wf__step" tabindex="0" role="button">
          <span class="wf__step__n"></span>
          <div class="wf__step__body">
            <b></b>
            <span></span>
          </div>
          <div class="wf__step__acts">
            <button data-up type="button" title="Move up">↑</button>
            <button data-down type="button" title="Move down">↓</button>
            <button data-rm type="button" title="Remove">✕</button>
          </div>
        </div>
      `);
      card.classList.toggle('is-selected', i === selected);
      card.querySelector('.wf__step__n').textContent = String(i + 1);
      card.querySelector('b').textContent = op?.label ?? step.opId;
      card.querySelector('.wf__step__body span').textContent = op ? op.describe(step.params) : '';
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selected = i;
        paintPipeline();
        paintParams();
      });
      const up = card.querySelector('[data-up]');
      const down = card.querySelector('[data-down]');
      up.disabled = i === 0;
      down.disabled = i === steps.length - 1;
      up.addEventListener('click', () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; selected = i - 1; paintPipeline(); paintParams(); update(); });
      down.addEventListener('click', () => { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; selected = i + 1; paintPipeline(); paintParams(); update(); });
      card.querySelector('[data-rm]').addEventListener('click', () => {
        steps.splice(i, 1);
        selected = Math.max(0, Math.min(selected, steps.length - 1));
        paintPipeline();
        paintParams();
        update();
      });
      wrap.appendChild(card);
    });

    wrap.appendChild(el(`<div class="wf__link"></div>`));
    const last = steps.length ? OP_BY_ID[steps.at(-1)?.opId]?.produces : null;
    wrap.appendChild(chip(last ? `A ${last} file to download` : 'Nothing yet — add a step', 'out'));

    if (!steps.length) {
      wrap.appendChild(el(`<p class="ts__hint">Start from a ready-made workflow below, or add a step in the sidebar.</p>`));
    }

    const presetRow = el(`<div class="wf__presets"></div>`);
    presetRow.appendChild(el(`<span class="wf__presets__label">Start from</span>`));
    for (const preset of PRESETS) {
      const b = el(`<button class="chip" type="button"></button>`);
      b.textContent = preset.name;
      b.addEventListener('click', () => {
        steps = structuredClone(preset.steps);
        selected = 0;
        paintPipeline();
        paintParams();
        update();
        toast(`Loaded “${preset.name}”`);
      });
      presetRow.appendChild(b);
    }
    wrap.appendChild(presetRow);

    pipeHost.appendChild(wrap);
  }

  function chip(text, dir) {
    const node = el(`<div class="wf__end wf__end--${dir}"><span></span></div>`);
    node.querySelector('span').textContent = text;
    return node;
  }

  // -------------------------------------------------------------------------
  // The selected step's parameters, in the sidebar
  // -------------------------------------------------------------------------

  function paintParams() {
    if (!ui.paramsHost) return;
    ui.paramsHost.innerHTML = '';
    const step = steps[selected];
    if (!step) return;
    const op = OP_BY_ID[step.opId];
    if (!op) return;

    const head = el(`<p class="opt__label" style="margin-bottom:2px"></p>`);
    head.textContent = `Step ${selected + 1} · ${op.label}`;
    ui.paramsHost.appendChild(head);
    if (op.hint) {
      const hint = el(`<p class="opt__hint"></p>`);
      hint.textContent = op.hint;
      ui.paramsHost.appendChild(hint);
    }

    for (const p of op.params) {
      const value = step.params[p.id] ?? p.value;
      let control;
      if (p.type === 'select') {
        control = selectField(p.label, p.options.map(([id, label]) => ({ id, label })), {
          value, hint: p.hint, onChange: (v) => set(p.id, v),
        });
      } else if (p.type === 'check') {
        control = checkRow(p.label, { checked: !!value, hint: p.hint, onChange: (v) => set(p.id, v) });
      } else if (p.type === 'range') {
        control = sliderField(p.label, { value: Number(value), min: p.min, max: p.max, suffix: p.suffix ?? '', onChange: (v) => set(p.id, v) });
      } else if (p.type === 'number') {
        control = { root: numberRow(p, value, (v) => set(p.id, v)) };
      } else {
        control = { root: textRow(p, value, (v) => set(p.id, v)) };
      }
      ui.paramsHost.appendChild(control.root);
    }

    function set(key, value) {
      step.params[key] = value;
      paintPipeline();
      update();
    }
  }

  function textRow(p, value, onChange) {
    const wrap = el(`<div class="opt__field"><label class="opt__label"></label><input type="text" class="opt__color__hex" style="font-family:inherit" /></div>`);
    wrap.querySelector('label').textContent = p.label;
    const input = wrap.querySelector('input');
    input.value = value ?? '';
    input.addEventListener('input', () => onChange(input.value));
    return wrap;
  }

  function numberRow(p, value, onChange) {
    const wrap = el(`<div class="opt__field"><label class="opt__label"></label><input type="number" class="opt__color__hex" style="font-family:inherit" /></div>`);
    wrap.querySelector('label').textContent = p.label;
    const input = wrap.querySelector('input');
    Object.assign(input, { value: String(value ?? 0), min: String(p.min ?? 0), max: String(p.max ?? 99999), step: String(p.step ?? 1) });
    input.addEventListener('input', () => onChange(Number(input.value)));
    if (p.hint) {
      const hint = el(`<p class="opt__hint"></p>`);
      hint.textContent = p.hint;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------

  function update() {
    if (!ui.explain) return;
    if (!steps.length) {
      ui.explain.set('');
      ui.problems.hide(true);
      return;
    }
    // The real input kind is only known once files are dropped, so validate the
    // step-to-step joins now and check the first step against the actual file at
    // run time. That way a chain can be built and saved before choosing files.
    const check = validateChain(steps, null);
    if (!check.ok) {
      ui.problems.set(check.problems[0].message);
      ui.problems.hide(false);
    } else {
      ui.problems.hide(true);
    }
    const parts = steps.map((s) => OP_BY_ID[s.opId]?.describe(s.params)).filter(Boolean);
    ui.explain.set(parts.length ? `Your files will be ${parts.join(', then ')}.` : '');
  }

  // -------------------------------------------------------------------------
  // Saved workflows — localStorage only, like every other preference in this app
  // -------------------------------------------------------------------------

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'); } catch { return []; }
  }
  function writeStore(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { toast('This browser will not let UniLab save workflows'); }
  }
  function savedOptions() {
    return [{ id: '', label: 'Not saved yet' }, ...readStore().map((w) => ({ id: w.id, label: w.name }))];
  }
  function refreshSavedList(selectedId = '') {
    const sel = ui.saved.el;
    sel.innerHTML = '';
    for (const o of savedOptions()) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = selectedId;
  }
  function loadSaved(id) {
    const found = readStore().find((w) => w.id === id);
    if (!found) return;
    steps = structuredClone(found.steps);
    selected = 0;
    paintPipeline();
    paintParams();
    update();
    toast(`Loaded “${found.name}”`);
  }
  function saveCurrent() {
    if (!steps.length) { toast('Add a step first'); return; }
    const name = prompt('Name this workflow', 'My workflow');
    if (!name) return;
    const list = readStore();
    const id = `wf-${Date.now()}`;
    list.push({ id, name, steps: structuredClone(steps) });
    writeStore(list);
    refreshSavedList(id);
    toast('Workflow saved on this device');
  }
  function deleteCurrent() {
    const id = ui.saved.value;
    if (!id) { toast('Pick a saved workflow first'); return; }
    writeStore(readStore().filter((w) => w.id !== id));
    refreshSavedList('');
    toast('Workflow deleted');
  }

  // -------------------------------------------------------------------------
  // Sharing — a workflow as a plain JSON file:
  //   { format: 'unilab-workflow', version: 1, name, steps }
  // Import is JSON.parse plus validation, never anything executable.
  // -------------------------------------------------------------------------

  function exportCurrent() {
    if (!steps.length) { toast('Add a step first'); return; }
    const saved = readStore().find((w) => w.id === ui.saved.value);
    const name = saved?.name?.trim() || prompt('Name this workflow', 'My workflow');
    if (!name) return;
    const payload = { format: 'unilab-workflow', version: 1, name, steps };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${fileSafe(name)}.unilab-workflow.json`);
    toast('Workflow exported — send the file to anyone');
  }

  async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a UniLab workflow'); return; }
    if (!data || typeof data !== 'object' || data.format !== 'unilab-workflow'
        || !Array.isArray(data.steps) || !data.steps.length) {
      toast('That file isn’t a UniLab workflow');
      return;
    }
    const clean = [];
    for (const step of data.steps) {
      const opId = typeof step?.opId === 'string' ? step.opId : '';
      const op = OP_BY_ID[opId];
      if (!op) {
        toast(`This workflow uses a step this version doesn’t have: ${opId || '(unnamed)'}`);
        return;
      }
      // Only the op's declared params survive: unknown keys are dropped, missing
      // ones come from the defaults, and values must be plain JSON primitives.
      const params = defaultParams(op);
      const given = step.params && typeof step.params === 'object' ? step.params : {};
      for (const p of op.params) {
        const v = given[p.id];
        if (v !== undefined && ['string', 'number', 'boolean'].includes(typeof v)) params[p.id] = v;
      }
      clean.push({ opId, params });
    }
    steps = clean;
    selected = 0;
    refreshSavedList('');   // it's not saved on THIS device yet
    paintPipeline();
    paintParams();
    update();
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : 'workflow';
    toast(`Imported “${name}” — press “Save this workflow…” to keep it`);
  }

  function fileSafe(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 60) || 'workflow';
  }
}
