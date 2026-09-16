import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { el, dropzone, downloadBlob, progressBar, errorBox, formatBytes, stem } from '../ui.js';

export default function render(container) {
  let file = null;
  const panel = el(`<div class="panel"></div>`);
  const zone = dropzone({
    accept: 'application/pdf',
    multiple: false,
    label: 'Choose a PDF',
    hint: 'Then set your options',
    onFiles: ([f]) => {
      file = f;
      info.textContent = `${f.name} (${formatBytes(f.size)})`;
      options.hidden = false;
    },
  });
  const info = el(`<p class="note"></p>`);
  const options = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Position</label>
          <select data-pos>
            <option value="bottom-center" selected>Bottom center</option>
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="top-center">Top center</option>
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
          </select>
        </div>
        <div class="field">
          <label>Format</label>
          <select data-format>
            <option value="plain" selected>1, 2, 3</option>
            <option value="pageof">Page 1 of 12</option>
            <option value="dash">- 1 -</option>
          </select>
        </div>
        <div class="field">
          <label>Start numbering at</label>
          <input type="number" data-start value="1" min="1" />
        </div>
        <div class="field">
          <label>Skip first N pages</label>
          <input type="number" data-skip value="0" min="0" />
        </div>
        <div class="field">
          <label>Font size</label>
          <input type="number" data-size value="11" min="6" max="72" />
        </div>
      </div>
      <div class="actions"><button class="btn" data-go>Add page numbers</button></div>
    </div>
  `);
  const progress = progressBar();
  const resultsHost = el(`<div></div>`);

  options.querySelector('[data-go]').addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    progress.show('Adding page numbers…');
    try {
      const pos = options.querySelector('[data-pos]').value;
      const format = options.querySelector('[data-format]').value;
      const startAt = parseInt(options.querySelector('[data-start]').value, 10) || 1;
      const skip = Math.max(0, parseInt(options.querySelector('[data-skip]').value, 10) || 0);
      const size = parseFloat(options.querySelector('[data-size]').value) || 11;
      const margin = 28;

      const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      const numberedCount = Math.max(pages.length - skip, 0);

      for (let i = 0; i < pages.length; i++) {
        progress.set(i / pages.length, `Page ${i + 1}/${pages.length}`);
        if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));

        if (i < skip) continue;
        const num = startAt + (i - skip);
        const text = format === 'pageof' ? `Page ${num} of ${numberedCount}`
          : format === 'dash' ? `- ${num} -`
          : `${num}`;

        const page = pages[i];
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(text, size);
        const y = pos.startsWith('bottom') ? margin : height - margin;
        const x = pos.endsWith('center') ? (width - textWidth) / 2
          : pos.endsWith('right') ? width - margin - textWidth
          : margin;
        page.drawText(text, { x, y, size, font, color: rgb(0.15, 0.15, 0.15) });
      }

      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      progress.hide();
      const box = el(`
        <div class="result">
          <h3>✅ Numbered ${pages.length} pages (${formatBytes(blob.size)})</h3>
          <div class="actions"><button class="btn" data-dl>⬇ Download PDF</button></div>
        </div>
      `);
      box.querySelector('[data-dl]').addEventListener('click', () => downloadBlob(blob, `${stem(file.name)}-numbered.pdf`));
      resultsHost.appendChild(box);
    } catch (err) {
      progress.hide();
      errorBox(panel, `Could not add page numbers: ${err.message}. Password-protected PDFs are not supported.`);
    }
  });

  panel.append(zone, info, options, progress.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`<p class="note">Example: faculty rules say every page of Chapter 1 onward needs a number, but the cover and approval page must stay blank — skip 2 pages and start counting at 1.</p>`));
}
