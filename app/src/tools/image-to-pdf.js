import { PDFDocument } from 'pdf-lib';
import { el, dropzone, fileListView, downloadBlob, progressBar, errorBox, loadImage, canvasToBlob, formatBytes } from '../ui.js';

const A4 = { w: 595.28, h: 841.89 }; // points

export default function render(container) {
  const files = [];
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp',
    label: 'Choose images',
    hint: 'They become PDF pages in this order — reorder below',
    onFiles: (f) => { files.push(...f); list.render(); update(); },
  });
  const list = fileListView(files, { thumbs: true, reorderable: true, onChange: update });

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Page size</label>
        <select data-pagesize>
          <option value="a4p">A4 portrait</option>
          <option value="a4l">A4 landscape</option>
          <option value="fit">Fit each image</option>
        </select>
      </div>
      <div class="field">
        <label>Margin</label>
        <select data-margin>
          <option value="24">Small</option>
          <option value="0">None</option>
          <option value="48">Large</option>
        </select>
      </div>
    </div>
  `);

  const actions = el(`<div class="actions"><button class="btn" data-go disabled>Create PDF</button></div>`);
  const goBtn = actions.querySelector('[data-go]');
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  function update() { goBtn.disabled = files.length === 0; }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    progress.show('Building PDF…');
    try {
      const pageMode = controls.querySelector('[data-pagesize]').value;
      const margin = Number(controls.querySelector('[data-margin]').value);
      const doc = await PDFDocument.create();

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress.set(i / files.length, `Adding ${f.name} (${i + 1}/${files.length})`);
        let bytes = new Uint8Array(await f.arrayBuffer());
        let embedded;
        if (f.type === 'image/jpeg') embedded = await doc.embedJpg(bytes);
        else if (f.type === 'image/png') embedded = await doc.embedPng(bytes);
        else {
          // WebP etc. — re-encode to JPEG via canvas first.
          const img = await loadImage(f);
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
          bytes = new Uint8Array(await blob.arrayBuffer());
          embedded = await doc.embedJpg(bytes);
        }

        let pw;
        let ph;
        if (pageMode === 'fit') { pw = embedded.width + margin * 2; ph = embedded.height + margin * 2; }
        else if (pageMode === 'a4l') { pw = A4.h; ph = A4.w; }
        else { pw = A4.w; ph = A4.h; }

        const page = doc.addPage([pw, ph]);
        const availW = pw - margin * 2;
        const availH = ph - margin * 2;
        const scale = Math.min(availW / embedded.width, availH / embedded.height, 1);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }

      const pdfBytes = await doc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      progress.hide();
      const box = el(`
        <div class="result">
          <h3>✅ PDF ready — ${files.length} page${files.length > 1 ? 's' : ''}, ${formatBytes(blob.size)}</h3>
          <div class="actions"><button class="btn" data-dl>⬇ Download PDF</button></div>
        </div>
      `);
      box.querySelector('[data-dl]').addEventListener('click', () => downloadBlob(blob, 'unilab-images.pdf'));
      resultsHost.appendChild(box);
    } catch (err) {
      progress.hide();
      errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  panel.append(zone, list.root, controls, actions, progress.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Perfect for submitting photographed homework: snap pages with your phone, reorder them here, download one clean PDF.</p>`));
}
