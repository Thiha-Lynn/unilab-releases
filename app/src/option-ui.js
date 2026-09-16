// The option-panel component vocabulary.
//
// iLovePDF and iLoveIMG build the sidebar of all 44 of their tools out of about
// eight repeating pieces — a titled panel, an info box, icon tab cards, a
// segmented mode switch, number fields with steppers, unit toggles, token
// multi-selects, repeatable row groups, and a live sentence explaining what the
// current settings will do. Defining the same set once means every UniLab tool
// after this one is assembly rather than design, and every tool's options look
// like they belong to the same product.
//
// Every builder here returns a plain object with a `root` element and a small
// API, so tools compose them without a framework.

import { el } from './ui.js';

const ICON_INFO = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-5h1.5v5zM8 5.4a.9.9 0 110-1.8.9.9 0 010 1.8z"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M6.2 12.1L2.4 8.3l1.2-1.2 2.6 2.6 6.2-6.2 1.2 1.2z"/></svg>`;

/** The sidebar panel wrapper: a title and a body everything else goes into. */
export function optionPanel(title) {
  const root = el(`
    <div class="opt">
      <h2 class="opt__title"></h2>
      <div class="opt__body"></div>
    </div>
  `);
  root.querySelector('.opt__title').textContent = title;
  const body = root.querySelector('.opt__body');
  return {
    root,
    body,
    add(...nodes) { body.append(...nodes.map((n) => (n?.root ?? n))); return this; },
    setTitle(next) { root.querySelector('.opt__title').textContent = next; },
  };
}

/** The pale blue ⓘ box. Static text unless you keep the handle and call set(). */
export function infoBox(text) {
  const root = el(`<div class="opt__info"><span class="opt__info__icon">${ICON_INFO}</span><p></p></div>`);
  const p = root.querySelector('p');
  p.textContent = text;
  return { root, set(next) { p.textContent = next; }, hide(v = true) { root.hidden = v; } };
}

/**
 * A sentence that restates what the current settings will do, in plain English —
 * "This PDF will be split into files no larger than 1 MB each." It is the single
 * most reassuring element in their whole UI, because it tells the user what is
 * about to happen before they commit to it.
 */
export function liveExplain(initial = '') {
  const box = infoBox(initial);
  box.root.classList.add('opt__info--live');
  box.root.hidden = !initial;
  return {
    root: box.root,
    set(text) { box.set(text); box.root.hidden = !text; },
  };
}

/** Bare facts about the loaded file: "Original size: 2.1 MB · Total pages: 6". */
export function fileFacts(pairs = []) {
  const root = el(`<dl class="opt__facts"></dl>`);
  function render(next) {
    root.innerHTML = '';
    for (const [k, v] of next) {
      const dt = el(`<dt></dt>`); dt.textContent = k;
      const dd = el(`<dd></dd>`); dd.textContent = v;
      root.append(dt, dd);
    }
    root.hidden = next.length === 0;
  }
  render(pairs);
  return { root, set: render };
}

/**
 * The row of icon cards at the top of a sidebar — Range / Pages / Size. The
 * active card carries a green check badge; a `premium` card carries a crown in
 * their version. UniLab has no premium tier, so the same badge slot is used to
 * mark the option that needs a capable browser, which is the only thing that
 * can actually be unavailable here.
 */
export function tabCards(tabs, onPick, { active = 0 } = {}) {
  const root = el(`<div class="opt__tabs" role="tablist"></div>`);
  const nodes = tabs.map((tab, i) => {
    const card = el(`
      <button class="opt__tab" role="tab" type="button">
        <span class="opt__tab__badge">${ICON_CHECK}</span>
        <span class="opt__tab__icon">${tab.icon ?? ''}</span>
        <span class="opt__tab__label"></span>
      </button>
    `);
    card.querySelector('.opt__tab__label').textContent = tab.label;
    if (tab.note) card.title = tab.note;
    card.setAttribute('aria-selected', String(i === active));
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
      n.setAttribute('aria-selected', String(j === i));
    });
    onPick?.(tabs[i], i);
  }
  return { root, select, get value() { return tabs[current]?.id ?? null; }, get index() { return current; } };
}

/** The Custom / Fixed / Smart pill switch. */
export function segmented(items, onPick, { active = 0 } = {}) {
  const root = el(`<div class="opt__seg" role="group"></div>`);
  const nodes = items.map((item, i) => {
    const b = el(`<button class="opt__seg__btn" type="button"></button>`);
    b.textContent = item.label;
    if (item.note) b.title = item.note;
    b.disabled = !!item.disabled;
    if (i === active) b.classList.add('is-active');
    b.addEventListener('click', () => select(i));
    root.appendChild(b);
    return b;
  });
  let current = active;
  function select(i) {
    if (items[i]?.disabled) return;
    current = i;
    nodes.forEach((n, j) => n.classList.toggle('is-active', j === i));
    onPick?.(items[i], i);
  }
  return { root, select, get value() { return items[current]?.id ?? null; } };
}

/** A labelled field wrapper — every control below sits in one of these. */
function fieldWrap(label, control, { hint } = {}) {
  const root = el(`<div class="opt__field"><label class="opt__label"></label></div>`);
  const lab = root.querySelector('.opt__label');
  lab.textContent = label;
  if (!label) lab.remove();
  root.appendChild(control);
  if (hint) {
    const h = el(`<p class="opt__hint"></p>`);
    h.textContent = hint;
    root.appendChild(h);
  }
  return root;
}

/** Number input with the little up/down steppers theirs have. */
export function numberField(label, { value = 1, min = 1, max = 9999, step = 1, suffix, hint, onChange } = {}) {
  const wrap = el(`
    <div class="opt__num">
      <input type="number" inputmode="numeric" />
      <span class="opt__num__suffix" hidden></span>
      <span class="opt__num__steps">
        <button type="button" data-up aria-label="Increase">▲</button>
        <button type="button" data-down aria-label="Decrease">▼</button>
      </span>
    </div>
  `);
  const input = wrap.querySelector('input');
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  if (suffix) {
    const s = wrap.querySelector('.opt__num__suffix');
    s.hidden = false;
    s.textContent = suffix;
  }
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const emit = () => onChange?.(Number(input.value));
  wrap.querySelector('[data-up]').addEventListener('click', () => { input.value = String(clamp(Number(input.value) + step)); emit(); });
  wrap.querySelector('[data-down]').addEventListener('click', () => { input.value = String(clamp(Number(input.value) - step)); emit(); });
  input.addEventListener('input', emit);
  input.addEventListener('blur', () => { input.value = String(clamp(Number(input.value) || min)); emit(); });
  return {
    root: fieldWrap(label, wrap, { hint }),
    get value() { return clamp(Number(input.value) || min); },
    set value(v) { input.value = String(clamp(v)); },
    setMax(v) { max = v; input.max = String(v); },
  };
}

/** Single-line text input — labels, names, watermark wording. */
export function textField(label, { value = '', placeholder = '', hint, maxLength, onChange } = {}) {
  const input = el(`<input type="text" class="opt__text" spellcheck="false" />`);
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  input.addEventListener('input', () => onChange?.(input.value));
  return {
    root: fieldWrap(label, input, { hint }),
    get value() { return input.value; },
    set value(v) { input.value = v; },
    el: input,
  };
}

/** Plain select in the house style. */
export function selectField(label, options, { value, hint, onChange } = {}) {
  const sel = el(`<select class="opt__select"></select>`);
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o.id ?? o.value);
    opt.textContent = o.label;
    if (o.note) opt.title = o.note;
    sel.appendChild(opt);
  }
  if (value !== undefined) sel.value = String(value);
  sel.addEventListener('change', () => onChange?.(sel.value));
  return { root: fieldWrap(label, sel, { hint }), get value() { return sel.value; }, set value(v) { sel.value = String(v); }, el: sel };
}

/** The KB / MB style unit switch that sits beside a number field. */
export function unitToggle(units, onPick, { active = 0 } = {}) {
  const root = el(`<div class="opt__units" role="group"></div>`);
  const nodes = units.map((u, i) => {
    const b = el(`<button class="opt__units__btn" type="button"></button>`);
    b.textContent = u.label ?? u;
    if (i === active) b.classList.add('is-active');
    b.addEventListener('click', () => {
      nodes.forEach((n) => n.classList.remove('is-active'));
      b.classList.add('is-active');
      current = i;
      onPick?.(units[i], i);
    });
    root.appendChild(b);
    return b;
  });
  let current = active;
  return { root, get value() { return units[current]?.id ?? units[current]; } };
}

/** Number field and unit toggle on one line, e.g. "Maximum size per file". */
export function measureField(label, { value, min, max, step, units, unitActive = 0, hint, onChange } = {}) {
  const row = el(`<div class="opt__row"></div>`);
  const num = numberField('', { value, min, max, step, onChange: () => onChange?.() });
  const toggle = unitToggle(units, () => onChange?.(), { active: unitActive });
  row.append(num.root, toggle.root);
  return { root: fieldWrap(label, row, { hint }), get value() { return num.value; }, get unit() { return toggle.value; } };
}

/** Checkbox row with the green tick. */
export function checkRow(label, { checked = false, hint, onChange } = {}) {
  const root = el(`
    <label class="opt__check">
      <input type="checkbox" />
      <span class="opt__check__box">${ICON_CHECK}</span>
      <span class="opt__check__label"></span>
    </label>
  `);
  const input = root.querySelector('input');
  input.checked = checked;
  root.querySelector('.opt__check__label').textContent = label;
  input.addEventListener('change', () => onChange?.(input.checked));
  const wrap = el(`<div class="opt__field opt__field--check"></div>`);
  wrap.appendChild(root);
  if (hint) { const h = el(`<p class="opt__hint"></p>`); h.textContent = hint; wrap.appendChild(h); }
  return { root: wrap, get value() { return input.checked; }, set value(v) { input.checked = v; }, el: input };
}

/** Colour swatch + hex, for the text and watermark tools. */
export function colorField(label, { value = '#000000', onChange } = {}) {
  const row = el(`
    <div class="opt__color">
      <input type="color" />
      <input type="text" class="opt__color__hex" spellcheck="false" />
    </div>
  `);
  const [picker, hex] = row.querySelectorAll('input');
  picker.value = value;
  hex.value = value;
  picker.addEventListener('input', () => { hex.value = picker.value; onChange?.(picker.value); });
  hex.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/i.test(hex.value)) { picker.value = hex.value; onChange?.(hex.value); }
  });
  return { root: fieldWrap(label, row), get value() { return picker.value; } };
}

/** Slider with a live readout, for quality and size percentages. */
export function sliderField(label, { value = 50, min = 0, max = 100, step = 1, suffix = '', onChange } = {}) {
  const row = el(`
    <div class="opt__slider">
      <input type="range" />
      <output class="opt__slider__out"></output>
    </div>
  `);
  const input = row.querySelector('input');
  const out = row.querySelector('output');
  Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
  const paint = () => { out.textContent = `${input.value}${suffix}`; };
  paint();
  input.addEventListener('input', () => { paint(); onChange?.(Number(input.value)); });
  return { root: fieldWrap(label, row), get value() { return Number(input.value); }, set value(v) { input.value = String(v); paint(); } };
}

/**
 * Multi-select chips with an "n/max" counter — how they let you pick up to three
 * OCR languages. Their list runs to a hundred languages, so the picker has to
 * stay searchable rather than becoming a wall of checkboxes.
 */
export function tokenSelect(label, options, { max = 3, selected = [], onChange } = {}) {
  const chosen = [...selected];
  const wrap = el(`
    <div class="opt__tokens">
      <div class="opt__tokens__chips"></div>
      <select class="opt__select opt__tokens__add"><option value="">Add…</option></select>
    </div>
  `);
  const chips = wrap.querySelector('.opt__tokens__chips');
  const add = wrap.querySelector('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o.id ?? o.value);
    opt.textContent = o.label;
    add.appendChild(opt);
  }
  const counter = el(`<span class="opt__counter"></span>`);

  function paint() {
    chips.innerHTML = '';
    for (const id of chosen) {
      const meta = options.find((o) => String(o.id ?? o.value) === String(id));
      const chip = el(`<span class="opt__chip"><span></span><button type="button" aria-label="Remove">✕</button></span>`);
      chip.querySelector('span').textContent = meta?.label ?? id;
      chip.querySelector('button').addEventListener('click', () => {
        chosen.splice(chosen.indexOf(id), 1);
        paint();
        onChange?.([...chosen]);
      });
      chips.appendChild(chip);
    }
    counter.textContent = `${chosen.length}/${max}`;
    add.disabled = chosen.length >= max;
    add.value = '';
  }
  add.addEventListener('change', () => {
    const v = add.value;
    if (v && !chosen.includes(v) && chosen.length < max) { chosen.push(v); paint(); onChange?.([...chosen]); }
    add.value = '';
  });
  paint();

  const root = fieldWrap(label, wrap);
  root.querySelector('.opt__label')?.appendChild(counter);
  return { root, get value() { return [...chosen]; } };
}

/**
 * Repeating row groups — "Range 1", "Range 2", each with its own fields and a
 * remove button, plus a dashed "+ Add range" button underneath.
 */
export function repeatRows({ label = 'Range', addLabel = '+ Add range', make, min = 1, max = 20, onChange } = {}) {
  const root = el(`<div class="opt__repeat"></div>`);
  const list = el(`<div class="opt__repeat__list"></div>`);
  const addBtn = el(`<button class="opt__add" type="button"></button>`);
  addBtn.textContent = addLabel;
  root.append(list, addBtn);
  const rows = [];

  function paint() {
    list.innerHTML = '';
    rows.forEach((row, i) => {
      const box = el(`
        <div class="opt__repeat__row">
          <div class="opt__repeat__head">
            <span class="opt__repeat__title"></span>
            <span class="opt__repeat__n"></span>
            <button class="opt__repeat__rm" type="button" aria-label="Remove">✕</button>
          </div>
        </div>
      `);
      box.querySelector('.opt__repeat__title').textContent = label;
      box.querySelector('.opt__repeat__n').textContent = String(i + 1);
      const rm = box.querySelector('.opt__repeat__rm');
      rm.disabled = rows.length <= min;
      rm.addEventListener('click', () => { rows.splice(i, 1); paint(); onChange?.(); });
      box.appendChild(row.root);
      list.appendChild(box);
    });
    addBtn.disabled = rows.length >= max;
  }
  function addRow() {
    rows.push(make(rows.length));
    paint();
    onChange?.();
  }
  addBtn.addEventListener('click', addRow);
  for (let i = 0; i < min; i++) rows.push(make(i));
  paint();

  return { root, get rows() { return rows; }, get values() { return rows.map((r) => r.value); }, add: addRow };
}

/** Small SVG glyphs for the tab cards — deliberately simple line diagrams. */
export const TAB_ICONS = {
  range: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="3" width="11" height="18" rx="1.5"/><rect x="22" y="3" width="11" height="18" rx="1.5"/><path d="M15 12h4" stroke-dasharray="2 2"/></g></svg>`,
  pages: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="3" width="9" height="18" rx="1.5"/><rect x="12.5" y="3" width="9" height="18" rx="1.5"/><rect x="24" y="3" width="9" height="18" rx="1.5"/></g></svg>`,
  size: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="6" width="13" height="12" rx="1.5"/><rect x="20" y="3" width="13" height="18" rx="1.5"/></g></svg>`,
  pixels: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="3" width="24" height="18" rx="1.5"/><path d="M5 12h24M17 3v18" stroke-dasharray="2 2"/></g></svg>`,
  percent: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3"/><circle cx="23" cy="16" r="3"/><path d="M24 6L11 18"/></g></svg>`,
  draw: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 18c6-12 10 4 14-4s6 2 14-6"/></g></svg>`,
  type: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5h18M17 5v14M12 19h10"/></g></svg>`,
  upload: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17 18V6M12 11l5-5 5 5M6 20h22"/></g></svg>`,
  camera: `<svg viewBox="0 0 34 24" width="34" height="24"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="6" width="26" height="14" rx="2"/><circle cx="17" cy="13" r="4"/><path d="M12 6l2-3h6l2 3"/></g></svg>`,
};
