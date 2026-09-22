import { icon } from './icons.js';
import { screenFiles, rejectionMessage, describeLimit, MAX_FILE_BYTES } from './intake.js';
import { isAndroidApp, saveAndroidBlob } from './native-save.js';
// Shared UI + file helpers used by every tool.

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

export function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el(`<div class="toast"></div>`);
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

export function downloadBlob(blob, filename) {
  if (isAndroidApp()) {
    return saveAndroidBlob(blob, filename).then(() => toast('Saved to your chosen location.')).catch(error => {
      if (error.code !== 'USER_CANCELLED') toast(error.message || 'Could not save this file. Try again.');
    });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stem(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

// Drag & drop file picker. onFiles(File[]) is called for every add.
export function dropzone({ accept = '*', multiple = true, label = 'Choose files', hint = 'or drag & drop here', maxBytes = MAX_FILE_BYTES, onFiles }) {
  const zone = el(`
    <div class="dropzone" role="button" tabindex="0" aria-label="${label}">
      <div class="big">${icon("upload")}</div>
      <div class="label">${label}</div>
      <div class="hint">${hint} · stays on your device · up to ${describeLimit(maxBytes)} per file</div>
    </div>
  `);

  // Both ways in are screened, because `input.accept` filters only the operating
  // system's picker and a dragged file bypasses it entirely. (rule.md PDPA 12)
  function admit(list) {
    const { accepted, rejected } = screenFiles(list, { accept, maxBytes });
    if (rejected.length) toast(rejectionMessage(rejected));
    // Nothing is kept for a refused file — it is never passed on to the tool.
    if (accepted.length) onFiles(multiple ? accepted : accepted.slice(0, 1));
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (input.files.length) admit([...input.files]);
    input.value = '';
  });
  zone.appendChild(input);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    const files = [...e.dataTransfer.files];
    if (files.length) admit(files);
  });
  return zone;
}

// Reorderable file list. Returns {root, render} and mutates `files` in place via callbacks.
export function fileListView(files, { onChange, thumbs = false, removable = true, reorderable = false } = {}) {
  const root = el(`<div class="file-list"></div>`);
  function render() {
    root.innerHTML = '';
    files.forEach((f, i) => {
      const row = el(`
        <div class="file-row">
          ${thumbs ? `<img class="thumb" alt="">` : `<span>${icon("pdf")}</span>`}
          <span class="name"></span>
          <span class="size">${formatBytes(f.size)}</span>
        </div>
      `);
      row.querySelector('.name').textContent = f.name;
      if (thumbs) {
        const img = row.querySelector('.thumb');
        const url = URL.createObjectURL(f);
        img.src = url;
        img.onload = () => URL.revokeObjectURL(url);
      }
      if (reorderable) {
        const up = el(`<button class="icon-btn" title="Move up">↑</button>`);
        const down = el(`<button class="icon-btn" title="Move down">↓</button>`);
        up.disabled = i === 0;
        down.disabled = i === files.length - 1;
        up.addEventListener('click', () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; render(); onChange?.(); });
        down.addEventListener('click', () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; render(); onChange?.(); });
        row.append(up, down);
      }
      if (removable) {
        const rm = el(`<button class="icon-btn danger" title="Remove">✕</button>`);
        rm.addEventListener('click', () => { files.splice(i, 1); render(); onChange?.(); });
        row.append(rm);
      }
      root.appendChild(row);
    });
  }
  render();
  return { root, render };
}

export function progressBar() {
  const root = el(`
    <div class="progress-wrap" hidden>
      <div class="progress-bar"><div></div></div>
      <div class="progress-label"></div>
    </div>
  `);
  const fill = root.querySelector('.progress-bar > div');
  const label = root.querySelector('.progress-label');
  return {
    root,
    show(text = 'Working…') { root.hidden = false; fill.style.width = '0%'; label.textContent = text; },
    set(frac, text) { fill.style.width = `${Math.round(frac * 100)}%`; if (text) label.textContent = text; },
    hide() { root.hidden = true; },
  };
}

export function errorBox(container, message) {
  container.querySelectorAll('.error-box').forEach((e) => e.remove());
  if (message) container.appendChild(el(`<div class="error-box"></div>`)).textContent = message;
}

// ---- image helpers ----

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name} as an image`)); };
    img.src = url;
  });
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality);
  });
}

export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
