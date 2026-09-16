import { PDFDocument, degrees } from 'pdf-lib';
import { el, dropzone, downloadBlob, progressBar, errorBox, formatBytes, stem } from '../ui.js';
import { openPdf, renderPage } from '../pdf-utils.js';

export default function render(container) {
  let file = null;
  // Working state: one entry per original page, in current display order.
  let pages = []; // { srcIndex, rotation (extra degrees), deleted, thumbDataUrl }
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'application/pdf',
    multiple: false,
    label: 'Choose a PDF',
    hint: 'You’ll see every page as a thumbnail',
    onFiles: ([f]) => load(f),
  });

  const progress = progressBar();
  const grid = el(`<div class="thumb-grid"></div>`);
  const actions = el(`
    <div class="actions" hidden>
      <button class="btn" data-apply>Apply changes &amp; download</button>
      <button class="btn secondary" data-restart>Start over</button>
    </div>
  `);
  const resultsHost = el(`<div></div>`);

  async function load(f) {
    errorBox(panel, null);
    file = f;
    pages = [];
    grid.innerHTML = '';
    progress.show('Rendering thumbnails…');
    try {
      const pdf = await openPdf(f);
      for (let i = 1; i <= pdf.numPages; i++) {
        progress.set(i / pdf.numPages, `Page ${i}/${pdf.numPages}`);
        const canvas = await renderPage(pdf, i, 0.4);
        pages.push({ srcIndex: i - 1, rotation: 0, deleted: false, thumbDataUrl: canvas.toDataURL('image/jpeg', 0.7) });
      }
      progress.hide();
      zone.hidden = true;
      actions.hidden = false;
      renderGrid();
    } catch (err) {
      progress.hide();
      errorBox(panel, `Could not read PDF: ${err.message}`);
    }
  }

  function renderGrid() {
    grid.innerHTML = '';
    pages.forEach((p, i) => {
      const cell = el(`
        <div class="page-thumb${p.deleted ? ' deleted' : ''}">
          <img src="${p.thumbDataUrl}" style="transform:rotate(${p.rotation}deg)" alt="Page ${p.srcIndex + 1}" />
          <div class="num">Page ${p.srcIndex + 1}</div>
          <div class="ops">
            <button class="icon-btn" data-left title="Move earlier">←</button>
            <button class="icon-btn" data-rot title="Rotate 90°">⟳</button>
            <button class="icon-btn danger" data-del title="${p.deleted ? 'Restore' : 'Delete'}">${p.deleted ? '↩' : '✕'}</button>
            <button class="icon-btn" data-right title="Move later">→</button>
          </div>
        </div>
      `);
      cell.querySelector('[data-left]').disabled = i === 0;
      cell.querySelector('[data-right]').disabled = i === pages.length - 1;
      cell.querySelector('[data-left]').addEventListener('click', () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; renderGrid(); });
      cell.querySelector('[data-right]').addEventListener('click', () => { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; renderGrid(); });
      cell.querySelector('[data-rot]').addEventListener('click', () => { p.rotation = (p.rotation + 90) % 360; renderGrid(); });
      cell.querySelector('[data-del]').addEventListener('click', () => { p.deleted = !p.deleted; renderGrid(); });
      grid.appendChild(cell);
    });
  }

  actions.querySelector('[data-restart]').addEventListener('click', () => {
    pages = [];
    grid.innerHTML = '';
    actions.hidden = true;
    zone.hidden = false;
    resultsHost.innerHTML = '';
  });

  actions.querySelector('[data-apply]').addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    const keep = pages.filter((p) => !p.deleted);
    if (!keep.length) { errorBox(panel, 'All pages are deleted — restore at least one.'); return; }
    progress.show('Rebuilding PDF…');
    try {
      const src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, keep.map((p) => p.srcIndex));
      copied.forEach((page, i) => {
        const extra = keep[i].rotation;
        if (extra) page.setRotation(degrees(((page.getRotation().angle + extra) % 360 + 360) % 360));
        out.addPage(page);
      });
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      progress.hide();
      const removed = pages.length - keep.length;
      const box = el(`
        <div class="result">
          <h3>✅ Done — ${keep.length} pages${removed ? `, ${removed} removed` : ''} (${formatBytes(blob.size)})</h3>
          <div class="actions"><button class="btn" data-dl>⬇ Download PDF</button></div>
        </div>
      `);
      box.querySelector('[data-dl]').addEventListener('click', () => downloadBlob(blob, `${stem(file.name)}-organized.pdf`));
      resultsHost.appendChild(box);
    } catch (err) {
      progress.hide();
      errorBox(panel, err.message);
    }
  });

  panel.append(zone, progress.root, grid, actions);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Fix upside-down scans, drop blank pages, and put chapters back in order — no desktop software needed.</p>`));
}
