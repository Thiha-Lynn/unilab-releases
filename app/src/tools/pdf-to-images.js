import JSZip from 'jszip';
import { el, dropzone, downloadBlob, progressBar, errorBox, formatBytes, canvasToBlob, stem } from '../ui.js';
import { openPdf, renderPage, parsePageRanges } from '../pdf-utils.js';

export default function render(container) {
  let file = null;
  let pageCount = 0;
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'application/pdf',
    multiple: false,
    label: 'Choose a PDF',
    hint: 'Slides become shareable images',
    onFiles: async ([f]) => {
      errorBox(panel, null);
      try {
        const pdf = await openPdf(f);
        file = f;
        pageCount = pdf.numPages;
        info.textContent = `${f.name} — ${pageCount} pages (${formatBytes(f.size)})`;
        options.hidden = false;
      } catch (err) {
        errorBox(panel, `Could not read PDF: ${err.message}`);
      }
    },
  });

  const info = el(`<p class="note"></p>`);
  const options = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Format</label>
          <select data-format>
            <option value="image/jpeg">JPG</option>
            <option value="image/png">PNG</option>
          </select>
        </div>
        <div class="field">
          <label>Resolution</label>
          <select data-scale>
            <option value="1.5">Standard</option>
            <option value="2.5">High</option>
            <option value="1">Small</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:200px">
          <label>Pages (blank = all)</label>
          <input type="text" data-range placeholder="all" />
        </div>
      </div>
      <div class="actions"><button class="btn" data-go>Convert to images</button></div>
    </div>
  `);

  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  options.querySelector('[data-go]').addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    progress.show('Rendering…');
    try {
      const type = options.querySelector('[data-format]').value;
      const scale = Number(options.querySelector('[data-scale]').value);
      const rangeText = options.querySelector('[data-range]').value.trim();
      const pages = rangeText ? parsePageRanges(rangeText, pageCount) : Array.from({ length: pageCount }, (_, i) => i + 1);
      const ext = type === 'image/png' ? 'png' : 'jpg';

      const pdf = await openPdf(file);
      const outputs = [];
      for (let i = 0; i < pages.length; i++) {
        progress.set(i / pages.length, `Page ${pages[i]} (${i + 1}/${pages.length})`);
        const canvas = await renderPage(pdf, pages[i], scale);
        const blob = await canvasToBlob(canvas, type, 0.9);
        outputs.push({ name: `${stem(file.name)}-p${String(pages[i]).padStart(2, '0')}.${ext}`, blob });
      }
      progress.hide();

      const box = el(`
        <div class="result">
          <h3>✅ ${outputs.length} image${outputs.length > 1 ? 's' : ''} ready</h3>
          <div class="actions"></div>
        </div>
      `);
      const acts = box.querySelector('.actions');
      if (outputs.length === 1) {
        const b = el(`<button class="btn" >⬇ Download image</button>`);
        b.addEventListener('click', () => downloadBlob(outputs[0].blob, outputs[0].name));
        acts.appendChild(b);
      } else {
        const zipBtn = el(`<button class="btn">⬇ Download all (.zip)</button>`);
        zipBtn.addEventListener('click', async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), `${stem(file.name)}-images.zip`);
        });
        acts.appendChild(zipBtn);
        for (const o of outputs.slice(0, 8)) {
          const b = el(`<button class="btn secondary small"></button>`);
          b.textContent = `⬇ ${o.name}`;
          b.addEventListener('click', () => downloadBlob(o.blob, o.name));
          acts.appendChild(b);
        }
      }
      resultsHost.appendChild(box);
    } catch (err) {
      progress.hide();
      errorBox(panel, err.message);
    }
  });

  panel.append(zone, info, options, progress.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Great for dropping one slide into your notes app, or posting a schedule page to the group chat.</p>`));
}
