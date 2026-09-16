import imageCompression from 'browser-image-compression';
import { stripImageMetadata, mayCarryMetadata } from '../intake.js';
import JSZip from 'jszip';
import { el, dropzone, fileListView, formatBytes, downloadBlob, progressBar, errorBox, toast, stem } from '../ui.js';

export default function render(container) {
  const files = [];
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'image/jpeg,image/png,image/webp',
    label: 'Choose images',
    hint: 'JPG, PNG or WebP — drop as many as you like',
    onFiles: (f) => { files.push(...f); list.render(); update(); },
  });
  const list = fileListView(files, { thumbs: true, onChange: update });

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Mode</label>
        <select data-mode>
          <option value="target">Target file size</option>
          <option value="quality">Quality level</option>
        </select>
      </div>
      <div class="field" data-targetwrap>
        <label>Must be under</label>
        <select data-target>
          <option value="0.19">200 KB (portal photo)</option>
          <option value="0.48">500 KB</option>
          <option value="0.95">1 MB (application form)</option>
          <option value="1.9" selected>2 MB (typical form cap)</option>
          <option value="4.8">5 MB</option>
          <option value="9.5">10 MB (typical LMS cap)</option>
        </select>
      </div>
      <div class="field" data-qwrap hidden>
        <label>Quality — <span data-q>70</span>%</label>
        <input type="range" min="10" max="95" value="70" data-quality />
      </div>
      <div class="field">
        <label>Max width/height (px)</label>
        <input type="number" data-maxdim placeholder="keep original" min="100" step="100" />
      </div>
    </div>
  `);
  const qSlider = controls.querySelector('[data-quality]');
  const qLabel = controls.querySelector('[data-q]');
  qSlider.addEventListener('input', () => (qLabel.textContent = qSlider.value));
  const modeSel = controls.querySelector('[data-mode]');
  modeSel.addEventListener('change', () => {
    controls.querySelector('[data-targetwrap]').hidden = modeSel.value !== 'target';
    controls.querySelector('[data-qwrap]').hidden = modeSel.value !== 'quality';
  });

  const actions = el(`
    <div class="actions">
      <button class="btn" data-go disabled>Compress images</button>
    </div>
  `);
  const goBtn = actions.querySelector('[data-go]');
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  function update() { goBtn.disabled = files.length === 0; }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    goBtn.disabled = true;
    progress.show('Compressing…');
    const outputs = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress.set(i / files.length, `Compressing ${f.name} (${i + 1}/${files.length})`);
        const maxDim = Number(container.querySelector('[data-maxdim]').value) || undefined;
        const targetMode = modeSel.value === 'target';
        let blob = await imageCompression(f, {
          // Target mode binary-searches quality until the file fits the cap —
          // "must be under X" is what portals and LMS limits actually ask for.
          maxSizeMB: targetMode ? Number(controls.querySelector('[data-target]').value) : 50,
          initialQuality: targetMode ? 0.85 : Number(qSlider.value) / 100,
          maxWidthOrHeight: maxDim,
          useWebWorker: true,
          // Stated rather than left to the library's default, because rule.md
          // PDPA 16 forbids carrying EXIF — and therefore GPS coordinates and a
          // device serial — out the other side of a tool. A default we did not
          // write is a default that can change under us in a minor release.
          preserveExif: false,
        });

        // Belt and braces. The library re-encodes through a canvas, which cannot
        // carry EXIF at all — but it can also hand back the original file
        // untouched when compressing would not help, and that file still has the
        // photo's GPS in it. Same bytes and same type means we cannot tell those
        // two cases apart, so re-encode rather than assume.
        if (mayCarryMetadata(blob) && blob.size === f.size && blob.type === f.type) {
          blob = await stripImageMetadata(blob);
        }
        const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
        outputs.push({ name: `${stem(f.name)}-compressed.${ext}`, blob, before: f.size, after: blob.size });
      }
      progress.hide();
      showResults(outputs);
    } catch (err) {
      progress.hide();
      errorBox(panel, err.message);
    } finally {
      goBtn.disabled = false;
    }
  });

  function showResults(outputs) {
    const before = outputs.reduce((s, o) => s + o.before, 0);
    const after = outputs.reduce((s, o) => s + o.after, 0);
    const saved = before ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;
    const box = el(`
      <div class="result">
        <h3>✅ Done — ${saved}% smaller</h3>
        <div class="stat-row">
          <div class="stat"><span class="v">${formatBytes(before)}</span><span class="k">Before</span></div>
          <div class="stat"><span class="v">${formatBytes(after)}</span><span class="k">After</span></div>
          <div class="stat"><span class="v">${saved}%</span><span class="k">Saved</span></div>
        </div>
        <div class="actions"></div>
      </div>
    `);
    const acts = box.querySelector('.actions');
    for (const o of outputs) {
      const b = el(`<button class="btn secondary small"></button>`);
      b.textContent = `⬇ ${o.name} (${formatBytes(o.after)})`;
      b.addEventListener('click', () => downloadBlob(o.blob, o.name));
      acts.appendChild(b);
    }
    if (outputs.length > 1) {
      const zipBtn = el(`<button class="btn small">⬇ Download all (.zip)</button>`);
      zipBtn.addEventListener('click', async () => {
        const zip = new JSZip();
        outputs.forEach((o) => zip.file(o.name, o.blob));
        downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-compressed.zip');
        toast('ZIP downloaded');
      });
      acts.appendChild(zipBtn);
    }
    resultsHost.appendChild(box);
  }

  panel.append(zone, list.root, controls, actions, progress.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Tip: 70% quality is usually invisible to the eye but cuts photos by 60–90% — perfect for LMS upload limits and email attachments.</p>`));
}
