import JSZip from 'jszip';
import { el, dropzone, fileListView, downloadBlob, progressBar, errorBox, loadImage, canvasToBlob, formatBytes, stem } from '../ui.js';

export default function render(container) {
  const files = [];
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp',
    label: 'Choose images',
    hint: 'JPG, PNG, WebP, GIF or BMP',
    onFiles: (f) => { files.push(...f); list.render(); update(); },
  });
  const list = fileListView(files, { thumbs: true, onChange: update });

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Convert to</label>
        <select data-format>
          <option value="image/jpeg">JPG</option>
          <option value="image/png">PNG</option>
          <option value="image/webp">WebP</option>
        </select>
      </div>
      <div class="field" data-qwrap>
        <label>Quality — <span data-q>90</span>%</label>
        <input type="range" data-quality min="10" max="100" value="90" />
      </div>
    </div>
  `);
  const fmtSel = controls.querySelector('[data-format]');
  const qSlider = controls.querySelector('[data-quality]');
  const qLabel = controls.querySelector('[data-q]');
  qSlider.addEventListener('input', () => (qLabel.textContent = qSlider.value));
  fmtSel.addEventListener('change', () => {
    controls.querySelector('[data-qwrap]').hidden = fmtSel.value === 'image/png';
  });

  const actions = el(`<div class="actions"><button class="btn" data-go disabled>Convert images</button></div>`);
  const goBtn = actions.querySelector('[data-go]');
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  function update() { goBtn.disabled = files.length === 0; }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    progress.show('Converting…');
    try {
      const type = fmtSel.value;
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const outputs = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress.set(i / files.length, `Converting ${f.name} (${i + 1}/${files.length})`);
        const img = await loadImage(f);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0);
        const blob = await canvasToBlob(canvas, type, Number(qSlider.value) / 100);
        outputs.push({ name: `${stem(f.name)}.${ext}`, blob });
      }
      progress.hide();
      const box = el(`
        <div class="result">
          <h3>✅ Converted ${outputs.length} image${outputs.length > 1 ? 's' : ''} to ${ext.toUpperCase()}</h3>
          <div class="actions"></div>
        </div>
      `);
      const acts = box.querySelector('.actions');
      for (const o of outputs) {
        const b = el(`<button class="btn secondary small"></button>`);
        b.textContent = `⬇ ${o.name} (${formatBytes(o.blob.size)})`;
        b.addEventListener('click', () => downloadBlob(o.blob, o.name));
        acts.appendChild(b);
      }
      if (outputs.length > 1) {
        const zipBtn = el(`<button class="btn small">⬇ Download all (.zip)</button>`);
        zipBtn.addEventListener('click', async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-converted.zip');
        });
        acts.appendChild(zipBtn);
      }
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
  container.appendChild(el(`<p class="note">Animated GIFs are converted using their first frame. iPhone HEIC photos aren’t supported yet — export them as JPG from Photos first.</p>`));
}
