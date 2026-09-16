import JSZip from 'jszip';
import { el, dropzone, fileListView, downloadBlob, progressBar, errorBox, loadImage, canvasToBlob, formatBytes, stem, MIME_EXT } from '../ui.js';

export default function render(container) {
  const files = [];
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp',
    label: 'Choose images',
    hint: 'JPG, PNG or WebP',
    onFiles: (f) => { files.push(...f); list.render(); update(); },
  });
  const list = fileListView(files, { thumbs: true, onChange: update });

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Mode</label>
        <select data-mode>
          <option value="pixels">Exact pixels</option>
          <option value="percent">Percentage</option>
        </select>
      </div>
      <div class="field" data-px>
        <label>Width (px)</label>
        <input type="number" data-w placeholder="auto" min="1" />
      </div>
      <div class="field" data-px>
        <label>Height (px)</label>
        <input type="number" data-h placeholder="auto" min="1" />
      </div>
      <div class="field" data-pc hidden>
        <label>Scale — <span data-pclabel>50</span>%</label>
        <input type="range" data-percent min="5" max="200" value="50" />
      </div>
      <label class="checkbox" data-lock-wrap><input type="checkbox" data-lock checked /> Keep aspect ratio</label>
    </div>
  `);
  const modeSel = controls.querySelector('[data-mode]');
  const pcSlider = controls.querySelector('[data-percent]');
  const pcLabel = controls.querySelector('[data-pclabel]');
  pcSlider.addEventListener('input', () => (pcLabel.textContent = pcSlider.value));
  modeSel.addEventListener('change', () => {
    const pixels = modeSel.value === 'pixels';
    controls.querySelectorAll('[data-px]').forEach((n) => (n.hidden = !pixels));
    controls.querySelector('[data-pc]').hidden = pixels;
    controls.querySelector('[data-lock-wrap]').hidden = !pixels;
  });

  const actions = el(`<div class="actions"><button class="btn" data-go disabled>Resize images</button></div>`);
  const goBtn = actions.querySelector('[data-go]');
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  function update() { goBtn.disabled = files.length === 0; }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    progress.show('Resizing…');
    try {
      const outputs = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress.set(i / files.length, `Resizing ${f.name} (${i + 1}/${files.length})`);
        const img = await loadImage(f);
        let w;
        let h;
        if (modeSel.value === 'percent') {
          const s = Number(pcSlider.value) / 100;
          w = Math.max(1, Math.round(img.naturalWidth * s));
          h = Math.max(1, Math.round(img.naturalHeight * s));
        } else {
          const wIn = Number(controls.querySelector('[data-w]').value) || null;
          const hIn = Number(controls.querySelector('[data-h]').value) || null;
          const lock = controls.querySelector('[data-lock]').checked;
          if (!wIn && !hIn) throw new Error('Enter a width and/or height');
          const ratio = img.naturalWidth / img.naturalHeight;
          if (lock || !wIn || !hIn) {
            if (wIn) { w = wIn; h = Math.max(1, Math.round(wIn / ratio)); }
            if (hIn && !wIn) { h = hIn; w = Math.max(1, Math.round(hIn * ratio)); }
            if (wIn && hIn && lock) { w = wIn; h = Math.max(1, Math.round(wIn / ratio)); }
          } else { w = wIn; h = hIn; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const type = MIME_EXT[f.type] ? f.type : 'image/png';
        const blob = await canvasToBlob(canvas, type, 0.92);
        outputs.push({ name: `${stem(f.name)}-${w}x${h}.${MIME_EXT[type]}`, blob, dims: `${w}×${h}` });
      }
      progress.hide();
      const box = el(`
        <div class="result">
          <h3>✅ Resized ${outputs.length} image${outputs.length > 1 ? 's' : ''}</h3>
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
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-resized.zip');
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
}
