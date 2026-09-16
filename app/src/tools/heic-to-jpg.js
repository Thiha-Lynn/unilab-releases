import heic2any from 'heic2any';
import JSZip from 'jszip';
import { el, dropzone, fileListView, downloadBlob, progressBar, errorBox, formatBytes, stem } from '../ui.js';

export default function render(container) {
  const files = [];
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'image/heic,image/heif,.heic,.heif',
    label: 'Choose HEIC photos',
    hint: 'iPhone .heic / .heif — drop as many as you like',
    onFiles: (f) => { files.push(...f); list.render(); update(); },
  });
  // HEIC files won't render in an <img> thumb, so skip thumbs here.
  const list = fileListView(files, { thumbs: false, onChange: update });

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Convert to</label>
        <select data-format>
          <option value="image/jpeg">JPG</option>
          <option value="image/png">PNG</option>
        </select>
      </div>
      <div class="field" data-qwrap>
        <label>Quality — <span data-q>85</span>%</label>
        <input type="range" data-quality min="10" max="100" value="85" />
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

  const actions = el(`<div class="actions"><button class="btn" data-go disabled>Convert photos</button></div>`);
  const goBtn = actions.querySelector('[data-go]');
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  function update() { goBtn.disabled = files.length === 0; }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    progress.show('Converting…');
    const type = fmtSel.value;
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const quality = Number(qSlider.value) / 100;
    const outputs = [];
    const failures = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress.set(i / files.length, `Converting ${f.name} (${i + 1}/${files.length})`);
      try {
        const result = await heic2any({ blob: f, toType: type, quality });
        const blob = Array.isArray(result) ? result[0] : result;
        outputs.push({ name: `${stem(f.name)}.${ext}`, blob });
      } catch (err) {
        failures.push({ name: f.name, message: err?.message || 'Conversion failed' });
      }
    }
    progress.hide();
    goBtn.disabled = false;

    if (outputs.length === 0) {
      errorBox(panel, failures.length ? `Could not convert any file: ${failures[0].message}` : 'Nothing to convert.');
      return;
    }

    const box = el(`
      <div class="result">
        <h3>✅ Converted ${outputs.length} photo${outputs.length > 1 ? 's' : ''} to ${ext.toUpperCase()}</h3>
        <div class="actions"></div>
      </div>
    `);
    if (failures.length) {
      box.appendChild(el(`<p class="note">${failures.length} file${failures.length > 1 ? 's' : ''} failed: ${failures.map((x) => x.name).join(', ')}</p>`));
    }
    const acts = box.querySelector('.actions');
    if (outputs.length === 1) {
      const o = outputs[0];
      const b = el(`<button class="btn" data-dl></button>`);
      b.textContent = `⬇ Download ${o.name} (${formatBytes(o.blob.size)})`;
      b.addEventListener('click', () => downloadBlob(o.blob, o.name));
      acts.appendChild(b);
    } else {
      const zipBtn = el(`<button class="btn">⬇ Download all (.zip)</button>`);
      zipBtn.addEventListener('click', async () => {
        const zip = new JSZip();
        outputs.forEach((o) => zip.file(o.name, o.blob));
        downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-converted.zip');
      });
      acts.appendChild(zipBtn);
      for (const o of outputs) {
        const b = el(`<button class="btn secondary small"></button>`);
        b.textContent = `⬇ ${o.name} (${formatBytes(o.blob.size)})`;
        b.addEventListener('click', () => downloadBlob(o.blob, o.name));
        acts.appendChild(b);
      }
    }
    resultsHost.appendChild(box);
  });

  panel.append(zone, list.root, controls, actions, progress.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Only the first frame of a Live Photo / burst HEIC is converted. No email-to-yourself, no upload to a converter site — the file never leaves your device.</p>`));
}
