import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { el, dropzone, downloadBlob, errorBox, canvasToBlob, stem } from '../ui.js';

const PRESETS = [
  ['Free', NaN],
  ['1:1 profile', 1],
  ['4:3', 4 / 3],
  ['16:9 slide', 16 / 9],
  ['3:4 ID photo', 3 / 4],
];

export default function render(container) {
  const panel = el(`<div class="panel"></div>`);
  let cropper = null;
  let currentFile = null;

  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp',
    multiple: false,
    label: 'Choose an image',
    hint: 'JPG, PNG or WebP',
    onFiles: ([f]) => start(f),
  });

  const editor = el(`
    <div hidden>
      <div style="max-height:60vh"><img data-stage style="max-width:100%;display:block" alt="Crop preview" /></div>
      <div class="controls">
        <div class="field">
          <label>Aspect ratio</label>
          <select data-aspect></select>
        </div>
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="image/jpeg">JPG</option>
            <option value="image/png">PNG</option>
            <option value="image/webp">WebP</option>
          </select>
        </div>
        <button class="icon-btn" data-rotate title="Rotate 90°" style="width:auto;padding:0 12px;height:38px">⟳ Rotate</button>
      </div>
      <div class="actions">
        <button class="btn" data-save>Crop &amp; download</button>
        <button class="btn secondary" data-reset>Choose another image</button>
      </div>
    </div>
  `);
  const aspectSel = editor.querySelector('[data-aspect]');
  PRESETS.forEach(([label], i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = label;
    aspectSel.appendChild(o);
  });

  function start(file) {
    currentFile = file;
    zone.hidden = true;
    editor.hidden = false;
    const img = editor.querySelector('[data-stage]');
    img.src = URL.createObjectURL(file);
    cropper?.destroy();
    cropper = new Cropper(img, { viewMode: 1, autoCropArea: 0.9, background: false });
  }

  aspectSel.addEventListener('change', () => {
    cropper?.setAspectRatio(PRESETS[Number(aspectSel.value)][1]);
  });
  editor.querySelector('[data-rotate]').addEventListener('click', () => cropper?.rotate(90));
  editor.querySelector('[data-reset]').addEventListener('click', () => {
    cropper?.destroy();
    cropper = null;
    editor.hidden = true;
    zone.hidden = false;
  });
  editor.querySelector('[data-save]').addEventListener('click', async () => {
    errorBox(panel, null);
    try {
      const type = editor.querySelector('[data-format]').value;
      const canvas = cropper.getCroppedCanvas({ imageSmoothingQuality: 'high' });
      const blob = await canvasToBlob(canvas, type, 0.92);
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      downloadBlob(blob, `${stem(currentFile.name)}-cropped.${ext}`);
    } catch (err) {
      errorBox(panel, err.message);
    }
  });

  panel.append(zone, editor);
  container.appendChild(panel);
  container.appendChild(el(`<p class="note">Use “3:4 ID photo” for university forms and job applications, or “1:1 profile” for LINE / IG avatars.</p>`));
}
