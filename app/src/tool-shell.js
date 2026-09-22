// The tool shell — the three-stage, two-pane frame every heavy UniLab tool runs in.
//
// Modelled directly on how iLovePDF and iLoveIMG structure all 44 of their tools:
// an uploader screen, then a work screen where a live preview of the operation
// sits on the left and the options sit in a fixed right sidebar with the action
// button pinned to its bottom, then a download screen. The reasons that shape is
// worth copying are not cosmetic:
//
//   * the options never scroll away from the file they apply to;
//   * the primary action is always in the same place, so a returning user never
//     hunts for it;
//   * the download screen is a real destination, which is where the countdown,
//     the "delete now" control and the next-tool suggestions can live.
//
// What we do differently: their countdown is their servers promising to delete
// your upload in two hours. Ours is this tab promising to drop the finished
// files from memory — see vault.js.

import { el, formatBytes, downloadBlob, toast, errorBox } from './ui.js';
import { TOOLS, CATEGORIES } from './registry.js';
import * as vault from './vault.js';
import { screenFiles, rejectionMessage, describeLimit, MAX_FILE_BYTES } from './intake.js';

const ICON_ARROW = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 12h8m-3.5-3.5L16 12l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_QR = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h7"/></g></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13h10l1-13"/></g></svg>`;
const ICON_ROTATE = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M13.5 3.6V1.2h-1.3v1.2A6 6 0 102 8h1.3a4.7 4.7 0 118 3.4l.9.9A6 6 0 0013.5 3.6z"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const ICON_SORT = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 4v16m0 0l-3-3m3 3l3-3"/><path d="M13 6h7M13 11h5M13 16h3"/></g></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 30" width="26" height="32" aria-hidden="true"><path d="M4 1h11l5 5v23H4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M15 1v5h5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;

/**
 * Mounts a tool.
 *
 * spec:
 *   accept, multiple, minFiles, maxBytes, pickLabel, dropLabel, sortable, reorderable
 *   thumbnail(file)          → optional; a canvas/img/URL for the file card
 *   onFiles(ctx)             → optional; async, after files are added/removed
 *   options(panel, ctx)      → build the sidebar; return an object of getters
 *   workarea(host, ctx)      → optional; custom live preview instead of file cards
 *   actionLabel              → text of the primary button
 *   run(ctx, job)            → async; return { outputs:[{name, blob}], stats, … }
 *   doneTitle, downloadLabel, continueTo:[toolId], ttlMinutes, note
 */
export function toolShell(container, tool, spec) {
  const {
    accept = '*', multiple = false, minFiles = 1, maxBytes = MAX_FILE_BYTES,
    pickLabel = multiple ? 'Select files' : 'Select a file',
    dropLabel = multiple ? 'or drop them here' : 'or drop it here',
    sortable = false, reorderable = false,
    thumbnail, onFiles, options, workarea,
    actionLabel = 'Start', run,
    doneTitle = 'Your file is ready', downloadLabel = 'Download file',
    continueTo = [], ttlMinutes, note,
  } = spec;

  const files = [];
  let optionApi = null;
  let unwatch = null;
  let disposed = false;
  const thumbUrls = new Set();

  const root = el(`<div class="ts" data-stage="upload"></div>`);

  // ---- stage 1: uploader -------------------------------------------------
  const uploader = el(`
    <div class="ts__uploader">
      <button class="ts__pick" type="button"></button>
      <p class="ts__drop"></p>
      <p class="ts__privacy">Nothing is uploaded — the file is opened by this page, on this device.</p>
      <p class="ts__retention"></p>
    </div>
  `);
  uploader.querySelector('.ts__pick').textContent = pickLabel;
  uploader.querySelector('.ts__drop').textContent = dropLabel;
  // rule.md PDPA 7 wants the retention window stated as a number beside the
  // control, not just implied by a countdown the user only meets afterwards.
  uploader.querySelector('.ts__retention').textContent =
    `Results stay in this tab for ${ttlMinutes ?? vault.TTL_MINUTES} minutes, then are cleared. 
     ${multiple ? 'Multiple files supported, each' : 'One file at a time,'} up to ${describeLimit(maxBytes)}.`;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.hidden = true;
  input.addEventListener('change', () => {
    if (input.files.length) addFiles([...input.files]);
    input.value = '';
  });
  uploader.appendChild(input);
  uploader.querySelector('.ts__pick').addEventListener('click', () => input.click());

  // Dropping works anywhere in the tool, not only on the uploader — once files
  // are loaded the uploader is gone, but dragging another file in should still
  // add it.
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('is-drag'); });
  root.addEventListener('dragleave', (e) => { if (e.target === root) root.classList.remove('is-drag'); });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('is-drag');
    const dropped = [...e.dataTransfer.files];
    if (dropped.length) addFiles(multiple ? dropped : dropped.slice(0, 1));
  });

  // ---- stage 2: workarea + sidebar --------------------------------------
  const work = el(`
    <div class="ts__work">
      <div class="ts__area">
        <div class="ts__fabs">
          <button class="ts__fab" data-add type="button" title="Add more files">${ICON_PLUS}<span class="ts__fab__count">0</span></button>
          <button class="ts__fab ts__fab--sm" data-sort type="button" title="Sort by name">${ICON_SORT}</button>
        </div>
        <div class="ts__cards"></div>
        <div class="ts__custom"></div>
      </div>
      <aside class="ts__side">
        <div class="ts__side__scroll"></div>
        <div class="ts__side__foot">
          <button class="ts__go" type="button"><span></span>${ICON_ARROW}</button>
        </div>
      </aside>
    </div>
  `);
  const cardsHost = work.querySelector('.ts__cards');
  const customHost = work.querySelector('.ts__custom');
  const sideScroll = work.querySelector('.ts__side__scroll');
  const goBtn = work.querySelector('.ts__go');
  const fabAdd = work.querySelector('[data-add]');
  const fabSort = work.querySelector('[data-sort]');
  const fabCount = work.querySelector('.ts__fab__count');
  goBtn.querySelector('span').textContent = actionLabel;
  fabAdd.hidden = !multiple;
  fabSort.hidden = !sortable;
  fabAdd.addEventListener('click', () => input.click());
  fabSort.addEventListener('click', () => {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    renderCards();
    ctx.refresh();
    toast('Sorted by name');
  });

  // ---- processing overlay ------------------------------------------------
  const busy = el(`
    <div class="ts__busy" hidden>
      <div class="ts__busy__spin" aria-hidden="true"></div>
      <p class="ts__busy__text"></p>
      <div class="ts__busy__bar"><div></div></div>
      <button class="ts__busy__cancel" type="button">Cancel</button>
    </div>
  `);
  const busyText = busy.querySelector('.ts__busy__text');
  const busyFill = busy.querySelector('.ts__busy__bar > div');
  const busyCancel = busy.querySelector('.ts__busy__cancel');

  // ---- stage 3: downloader ----------------------------------------------
  const done = el(`
    <div class="ts__done">
      <h2 class="ts__done__title"></h2>
      <div class="ts__done__row">
        <button class="ts__icon-btn" data-back type="button" title="Back">${ICON_BACK}</button>
        <button class="ts__download" type="button">${ICON_DOWNLOAD}<span></span></button>
        <div class="ts__done__extra">
          <button class="ts__icon-btn" data-qr type="button" title="Open this tool on your phone">${ICON_QR}</button>
          <button class="ts__icon-btn" data-purge type="button" title="Clear these files from memory now">${ICON_TRASH}</button>
        </div>
      </div>
      <div class="ts__saved" hidden></div>
      <div class="ts__files"></div>
      <div class="ts__ttl">
        <p>These files are held only in this tab's memory. They are cleared automatically in <b data-count>—</b>, when you close the tab, or the moment you press the bin.</p>
      </div>
      <div class="ts__continue" hidden>
        <h3>Continue to…</h3>
        <div class="ts__continue__grid"></div>
      </div>
    </div>
  `);
  const doneTitleEl = done.querySelector('.ts__done__title');
  const downloadBtn = done.querySelector('.ts__download');
  const savedBox = done.querySelector('.ts__saved');
  const filesBox = done.querySelector('.ts__files');
  const countEl = done.querySelector('[data-count]');

  done.querySelector('[data-back]').addEventListener('click', () => setStage('work'));
  done.querySelector('[data-purge]').addEventListener('click', () => {
    vault.purge();
    toast('Cleared from memory');
    setStage('work');
  });
  done.querySelector('[data-qr]').addEventListener('click', showQr);

  root.append(uploader, work, busy, done);
  container.appendChild(root);
  if (note) container.appendChild(el(`<p class="note ts__note">${note}</p>`));

  // ---- context handed to the tool ---------------------------------------
  const ctx = {
    tool,
    files,
    get options() { return optionApi ?? {}; },
    /** Re-runs the tool's own preview and validity check. */
    refresh() {
      fabCount.textContent = String(files.length);
      goBtn.disabled = files.length < minFiles;
      spec.onChange?.(ctx);
      if (workarea) workarea(customHost, ctx);
    },
    setBusy(fraction, text) {
      if (typeof fraction === 'number') busyFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      if (text) busyText.textContent = text;
    },
    error(message) { errorBox(container, message); },
    stage: setStage,
  };

  // ---- files -------------------------------------------------------------
  async function addFiles(next) {
    errorBox(container, null);

    // `input.accept` only filters the operating system's picker, and a dragged
    // file never goes near it — so the type and size rules are enforced here,
    // which is the one place every path in passes through. (rule.md PDPA 12)
    const { accepted, rejected } = screenFiles(next, { accept, maxBytes });
    if (rejected.length) errorBox(container, rejectionMessage(rejected));
    // A refused file is simply never held: not read, not listed, not referenced
    // once this function returns — the second half of PDPA 12.
    if (!accepted.length) return;

    if (!multiple) files.length = 0;
    files.push(...accepted);
    renderCards();
    setStage('work');
    try {
      await onFiles?.(ctx);
    } catch (err) {
      errorBox(container, err.message);
    }
    ctx.refresh();
  }

  function removeFile(i) {
    files.splice(i, 1);
    renderCards();
    if (!files.length) setStage('upload');
    onFiles?.(ctx)?.catch?.((err) => errorBox(container, err.message));
    ctx.refresh();
  }

  function renderCards() {
    cardsHost.innerHTML = '';
    cardsHost.hidden = !!workarea;
    if (workarea) return;
    files.forEach((file, i) => {
      const card = el(`
        <figure class="ts__card" tabindex="0">
          <div class="ts__card__acts">
            <button class="ts__card__btn" data-rot type="button" title="Rotate">${ICON_ROTATE}</button>
            <button class="ts__card__btn" data-rm type="button" title="Remove">✕</button>
          </div>
          <div class="ts__card__thumb">${ICON_FILE}</div>
          <figcaption></figcaption>
          <span class="ts__card__tip"></span>
        </figure>
      `);
      card.querySelector('figcaption').textContent = file.name;
      card.querySelector('.ts__card__tip').textContent = formatBytes(file.size);
      card.querySelector('[data-rm]').addEventListener('click', () => removeFile(i));
      const rot = card.querySelector('[data-rot]');
      if (spec.rotatable) {
        rot.addEventListener('click', () => {
          file.__rotation = ((file.__rotation ?? 0) + 90) % 360;
          card.querySelector('.ts__card__thumb').style.transform = `rotate(${file.__rotation}deg)`;
          ctx.refresh();
        });
      } else {
        rot.remove();
      }
      cardsHost.appendChild(card);
      paintThumb(card, file);
    });
    fabCount.textContent = String(files.length);
  }

  async function paintThumb(card, file) {
    const host = card.querySelector('.ts__card__thumb');
    try {
      const made = thumbnail ? await thumbnail(file) : defaultThumb(file);
      if (!made) return;
      host.innerHTML = '';
      if (typeof made === 'string') {
        const img = new Image();
        img.src = made;
        img.alt = '';
        thumbUrls.add(made);
        host.appendChild(img);
      } else {
        host.appendChild(made);
      }
      const tip = card.querySelector('.ts__card__tip');
      const w = made.width, h = made.height;
      if (w && h) tip.textContent = `${formatBytes(file.size)} · ${w}×${h}`;
    } catch {
      /* a thumbnail is a nicety; a file with no preview still works */
    }
  }

  function defaultThumb(file) {
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      thumbUrls.add(url);
      return url;
    }
    return null;
  }

  // ---- stages ------------------------------------------------------------
  function setStage(name) {
    root.dataset.stage = name;
    busy.hidden = name !== 'busy';
    if (name !== 'busy') { busyCancel.disabled = false; busyCancel.textContent = 'Cancel'; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- run ---------------------------------------------------------------
  let controller = null;
  busyCancel.addEventListener('click', () => {
    controller?.abort();
    busyCancel.disabled = true;
    busyCancel.textContent = 'Canceling…';
  });

  goBtn.addEventListener('click', async () => {
    errorBox(container, null);
    controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.setBusy(0, `${actionLabel}…`);
    setStage('busy');
    const started = performance.now();
    try {
      const result = await run(ctx, { signal: controller.signal });
      if (disposed || controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      if (!result?.outputs?.length) throw new Error('Nothing came back from that job. Try different settings.');
      showDone(result, performance.now() - started);
    } catch (err) {
      if (disposed) return;
      setStage('work');
      if (err?.name === 'AbortError' || /cancel/i.test(err?.message ?? '')) toast('Canceled');
      else errorBox(container, err.message);
    } finally {
      controller = null;
    }
  });

  function showDone(result, elapsedMs) {
    const outputs = result.outputs;
    const stored = vault.store(outputs, ttlMinutes ? { ttlMinutes } : undefined);

    doneTitleEl.textContent = result.doneTitle ?? doneTitle;
    downloadBtn.querySelector('span').textContent =
      result.downloadLabel ?? (outputs.length > 1 ? `Download ${outputs.length} files` : downloadLabel);
    downloadBtn.onclick = () => {
      // A ZIP for a batch, the file itself for one — the same choice they make.
      if (outputs.length === 1) downloadBlob(outputs[0].blob, outputs[0].name);
      else result.zip?.() ?? outputs.forEach((o) => downloadBlob(o.blob, o.name));
    };

    // savings gauge — only when the job actually has a before and an after
    const before = result.bytesBefore ?? files.reduce((s, f) => s + f.size, 0);
    const after = outputs.reduce((s, o) => s + o.blob.size, 0);
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    if (result.showSavings && pct > 0) {
      savedBox.hidden = false;
      savedBox.innerHTML = '';
      savedBox.append(savingsDonut(pct), el(`
        <div class="ts__saved__text">
          <p><b>Your files are now ${pct}% smaller.</b></p>
          <p class="ts__saved__sub">${formatBytes(before)} → ${formatBytes(after)} · took ${(elapsedMs / 1000).toFixed(1)}s</p>
        </div>
      `));
    } else {
      savedBox.hidden = true;
    }

    filesBox.innerHTML = '';
    for (const item of stored) {
      const row = el(`<button class="ts__file" type="button"><span class="ts__file__name"></span><span class="ts__file__size"></span></button>`);
      row.querySelector('.ts__file__name').textContent = item.name;
      row.querySelector('.ts__file__size').textContent = formatBytes(item.blob.size);
      row.addEventListener('click', () => downloadBlob(item.blob, item.name));
      filesBox.appendChild(row);
    }
    filesBox.hidden = outputs.length < 2;

    renderContinue();
    unwatch?.();
    unwatch = vault.watch((s) => {
      countEl.textContent = vault.formatCountdown(s.msLeft);
      if (!s.count) {
        downloadBtn.onclick = null;
        filesBox.replaceChildren();
        outputs.forEach(o => { o.blob = null; });
        result.zip = null;
      }
      if (!s.count && root.dataset.stage === 'done') {
        toast('Files cleared from memory');
        setStage('work');
      }
    });
    setStage('done');
  }

  function savingsDonut(pct) {
    const R = 34;
    const circumference = 2 * Math.PI * R;
    const node = el(`
      <div class="ts__donut">
        <svg viewBox="0 0 84 84" aria-hidden="true">
          <circle cx="42" cy="42" r="${R}" class="ts__donut__track"></circle>
          <circle cx="42" cy="42" r="${R}" class="ts__donut__fill"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"></circle>
        </svg>
        <div class="ts__donut__label"><b>0%</b><span>saved</span></div>
      </div>
    `);
    const fill = node.querySelector('.ts__donut__fill');
    const label = node.querySelector('b');
    // Count the number up as the ring fills — their gauge does the same, and it
    // is the one moment in the flow worth animating.
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      fill.style.strokeDashoffset = String(circumference * (1 - pct / 100));
      label.textContent = `${pct}%`;
    } else {
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / 900);
        const eased = 1 - (1 - t) ** 3;
        fill.style.strokeDashoffset = String(circumference * (1 - (pct / 100) * eased));
        label.textContent = `${Math.round(pct * eased)}%`;
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    return node;
  }

  function renderContinue() {
    const box = done.querySelector('.ts__continue');
    const grid = done.querySelector('.ts__continue__grid');
    const next = continueTo.map((id) => TOOLS.find((t) => t.id === id)).filter(Boolean);
    if (!next.length) { box.hidden = true; return; }
    box.hidden = false;
    grid.innerHTML = '';
    for (const t of next) {
      const link = el(`
        <a class="ts__next" href="#/${t.id}">
          <span class="ts__next__icon" style="--cc:${CATEGORIES[t.category].color}">${t.icon}</span>
          <span class="ts__next__name"></span>
          <span class="ts__next__chev">›</span>
        </a>
      `);
      link.querySelector('.ts__next__name').textContent = t.name;
      grid.appendChild(link);
    }
  }

  async function showQr() {
    // Their share button hands you a link to a file sitting on their server.
    // There is no such link here, so ours hands you the *tool* instead: scan it
    // and carry on with the same tool on your phone, where the photo already is.
    const { default: QRCode } = await import('qrcode');
    const url = `https://unilab.ztvmm.live/#/${encodeURIComponent(tool.id)}`;
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, url, { width: 232, margin: 1 });
    const dialog = el(`
      <div class="ts__modal" role="dialog" aria-modal="true" aria-label="Open on your phone">
        <div class="ts__modal__box">
          <button class="ts__modal__x" type="button" aria-label="Close">✕</button>
          <h3>Open this tool on your phone</h3>
          <p>There is no download link to share — the file never left this device.
             This code opens <b></b> on another device instead.</p>
          <div class="ts__modal__qr"></div>
          <code class="ts__modal__url"></code>
        </div>
      </div>
    `);
    dialog.querySelector('b').textContent = tool.name;
    dialog.querySelector('.ts__modal__qr').appendChild(canvas);
    dialog.querySelector('.ts__modal__url').textContent = url;
    const close = () => dialog.remove();
    dialog.querySelector('.ts__modal__x').addEventListener('click', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(dialog);
  }

  // ---- build the sidebar -------------------------------------------------
  if (options) {
    const built = options(sideScroll, ctx);
    optionApi = built ?? {};
  }
  ctx.refresh();

  // Leaving the tool tears everything down: object URLs, the vault, the ticker.
  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    disposed = true; controller?.abort();
    vault.purge();
    unwatch?.();
    files.length = 0;
    for (const url of thumbUrls) { try { URL.revokeObjectURL(url); } catch { /* gone */ } }
    thumbUrls.clear();
    vault.purge({ silent: true });
  });

  return ctx;
}
