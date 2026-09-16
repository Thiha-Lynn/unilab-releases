import { PDFDocument } from 'pdf-lib';
import { toCanvas } from 'html-to-image';
import { el, stem, formatBytes } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import { optionPanel, infoBox, fileFacts, selectField } from '../option-ui.js';
import { prepareHtml, documentSource, pageSlices, HTML_MAX_BYTES, HTML_MAX_PAGES } from '../html-document.js';

export default function render(container, tool) {
  let file, prepared, frame, preview, counter, viewport, current = 0, pages = [], generation = 0;
  let disposed = false;
  const ui = {};
  let fontsPromise;
  const resize = new ResizeObserver(fit);

  toolShell(container, tool, {
    accept: '.html,.htm,text/html', maxBytes: HTML_MAX_BYTES,
    pickLabel: 'Select a lecture HTML file', dropLabel: 'or drop an .html or .htm file here',
    actionLabel: 'Convert to PDF', downloadLabel: 'Download lecture PDF',
    doneTitle: 'Your lecture PDF is ready!', continueTo: ['compress-pdf', 'split-pdf', 'merge-pdf'],
    note: 'Open the downloaded PDF in any PDF reader, including on a phone. Embedded text, styles and diagrams are preserved as sharp page images. Interactive exercises, animations and content created only by scripts cannot be converted. External images and styles must already be embedded in the HTML.',
    workarea(host) {
      if (preview) return;
      preview = el('<div class="html-preview"><div class="actions"><button class="btn small secondary" data-prev>Previous page</button><span data-count aria-live="polite">Choose a file</span><button class="btn small secondary" data-next>Next page</button></div><div class="html-preview__viewport"></div></div>');
      counter = preview.querySelector('[data-count]');
      viewport = preview.querySelector('.html-preview__viewport');
      preview.querySelector('[data-prev]').onclick = () => { current = Math.max(0, current - 1); show(); };
      preview.querySelector('[data-next]').onclick = () => { current = Math.min(pages.length - 1, current + 1); show(); };
      host.append(preview); resize.observe(viewport);
    },
    options(host) {
      const panel = optionPanel('Lecture HTML → PDF');
      ui.facts = fileFacts();
      ui.layout = selectField('Layout', [{ id: 'slides', label: 'Original slides / layout' }, { id: 'reading', label: 'Reading copy — A4 portrait' }], { value: 'slides', onChange: rebuildSafe });
      ui.quality = selectField('PDF sharpness', [{ id: '1.5', label: 'Standard — smaller file' }, { id: '2', label: 'High — recommended' }], { value: '2' });
      ui.warning = infoBox(''); ui.warning.hide();
      const about = infoBox('Every slide is included, even if the original file shows only one at a time. Review the pages before converting. Direct download preserves the visual layout as images; use Print / Save PDF for selectable text where your browser supports it.');
      const print = el('<button class="btn secondary" type="button">Print / Save PDF with text</button>');
      print.onclick = () => {
        if (!frame?.contentWindow || !pages.length) return;
        const printFrame = frame;
        printFrame.contentDocument.querySelectorAll('[data-unilab-slide]').forEach(n => n.style.setProperty('display', n.dataset.unilabDisplay || 'block', 'important'));
        printFrame.contentWindow.addEventListener('afterprint', show, {once:true});
        printFrame.contentWindow.print();
      };
      panel.add(ui.facts, ui.layout, ui.quality, about, ui.warning, print); host.append(panel.root);
    },
    async onFiles(ctx) {
      file = ctx.files[0]; prepared = null; pages = []; current = 0;
      if (!file) return;
      const source = await file.text();
      prepared = prepareHtml(source);
      if (!prepared.text.trim()) throw new Error('No readable content was found. This may be an app that needs scripts to create its content. Choose a saved, self-contained lecture HTML file.');
      if (prepared.slideCount > HTML_MAX_PAGES) throw new Error(`Choose a lecture with at most ${HTML_MAX_PAGES} slides.`);
      await rebuild();
    },
    async run(ctx) {
      if (!frame || !pages.length) throw new Error('Choose an HTML file and wait for its preview.');
      const pdf = await PDFDocument.create();
      pdf.setTitle(prepared.title); pdf.setCreator('UniLab — on-device HTML to PDF');
      const original = current;
      const width = ui.layout.value === 'reading' ? 794 : 1280;
      const scale = Number(ui.quality.value);
      try {
        for (let i = 0; i < pages.length; i++) {
          ctx.signal?.throwIfAborted();
          ctx.setBusy(i / pages.length, `Rendering page ${i + 1} of ${pages.length}…`);
          current = i; show();
          const pageInfo = pages[i];
          const doc = frame.contentDocument;
          const node = pageInfo.node ?? doc.body;
          const captureHeight = pageInfo.height;
          const canvas = await toCanvas(node, {
            width, height: captureHeight, pixelRatio: Math.min(scale, 4096 / Math.max(width, captureHeight)),
            backgroundColor: '#ffffff', fontEmbedCSS: await fontCss(),
            style: { transform: `translateY(-${pageInfo.top}px)`, margin: '0', height: `${pageInfo.fullHeight || captureHeight}px` },
            skipAutoScale: false,
          });
          ctx.signal?.throwIfAborted();
          const jpg = await pdf.embedJpg(canvas.toDataURL('image/jpeg', 0.94));
          const pageHeight = ui.layout.value === 'reading' ? 1123 : captureHeight;
          const p = pdf.addPage([width * 0.75, pageHeight * 0.75]);
          p.drawImage(jpg, { x: 0, y: (pageHeight - captureHeight) * 0.75, width: width * 0.75, height: captureHeight * 0.75 });
          canvas.width = canvas.height = 0;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        ctx.setBusy(0.99, 'Saving your PDF…');
        return { outputs: [{ name: `${stem(file.name)}${ui.layout.value === 'reading' ? '-reading' : ''}.pdf`, blob: new Blob([await pdf.save()], { type: 'application/pdf' }) }], doneTitle: `Your ${pages.length}-page lecture PDF is ready!` };
      } finally { current = original; show(); }
    },
  });

  async function fontCss() {
    if (!fontsPromise) fontsPromise = Promise.all([
      ['UniLabThai', 'NotoSansThai-Regular.ttf'], ['UniLabMyanmar', 'NotoSansMyanmar-Regular.ttf'],
    ].map(async ([family, name]) => {
      const response = await fetch(`${import.meta.env.BASE_URL}fonts/${name}`);
      if (!response.ok) throw new Error('The bundled lecture fonts could not load. Reconnect and try again.');
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; response.blob().then(b => r.readAsDataURL(b), reject);
      });
      return `@font-face{font-family:${family};src:url(${data}) format('truetype');}`;
    })).then(s => s.join('\n'));
    return fontsPromise;
  }

  function rebuildSafe() { rebuild().catch(e => { ui.warning.set(e.message); ui.warning.hide(false); }); }
  async function rebuild() {
    if (!prepared || !viewport) return;
    const gen = ++generation;
    pages = []; counter.textContent = 'Preparing pages…';
    frame?.remove();
    const next = document.createElement('iframe');
    next.title = 'Lecture preview — scripts and network disabled';
    next.setAttribute('sandbox', 'allow-same-origin allow-modals');
    next.setAttribute('referrerpolicy', 'no-referrer');
    next.style.cssText = `border:0;width:${ui.layout.value === 'reading' ? 794 : 1280}px;height:720px;transform-origin:top left;background:white;`;
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The lecture preview took too long. Try a smaller file.')), 15000);
      next.onload = () => { clearTimeout(timeout); resolve(); };
    });
    const fonts = await fontCss();
    if (disposed || gen !== generation) return;
    next.srcdoc = documentSource(prepared, { reading: ui.layout.value === 'reading', fonts });
    viewport.replaceChildren(next); frame = next;
    await loaded;
    await next.contentDocument.fonts.ready;
    if (disposed || gen !== generation) return;
    const doc = next.contentDocument;
    const slides = [...doc.querySelectorAll('[data-unilab-slide]')];
    if (slides.length) {
      pages = slides.flatMap(node => {
        const height = Math.ceil(node.scrollHeight);
        const display = next.contentWindow.getComputedStyle(node).display;
        node.dataset.unilabDisplay = display === 'none' ? 'block' : display;
        if (ui.layout.value !== 'reading') return [{node, top:0, height:Math.max(720,height)}];
        const origin = node.getBoundingClientRect().top;
        const boundaries = [...node.querySelectorAll('p,li,tr,pre,figure')]
          .map(n => Math.ceil(n.getBoundingClientRect().bottom - origin));
        return pageSlices(height,1123,boundaries).map(p => ({...p,node,fullHeight:height}));
      });
    } else {
      const height = Math.ceil(doc.body.scrollHeight);
      const boundaries = [...doc.body.querySelectorAll('p,li,tr,section,pre,figure')]
        .map(n => Math.ceil(n.getBoundingClientRect().bottom));
      pages = pageSlices(height, ui.layout.value === 'reading' ? 1123 : 900, boundaries)
        .map(p => ({...p,fullHeight:height}));
    }
    if (pages.length > HTML_MAX_PAGES) throw new Error(`Choose a document with at most ${HTML_MAX_PAGES} pages.`);
    current = 0;
    ui.facts.set([['File', file.name], ['Source size', formatBytes(file.size)], ['Slides detected', String(slides.length)], ['PDF pages', String(pages.length)]]);
    const warnings = [];
    if (prepared.missing) warnings.push(`${prepared.missing} external or missing image(s) were not loaded. Use HTML with embedded images for a complete copy.`);
    if (prepared.hasScripts) warnings.push('Scripts are not run. Slide navigation is replaced by PDF pages; script-generated charts or exercises may be absent.');
    ui.warning.set(warnings.join(' ')); ui.warning.hide(!warnings.length);
    show();
  }

  function show() {
    if (!frame || !pages.length || disposed) return;
    const p = pages[current];
    const slides = frame.contentDocument.querySelectorAll('[data-unilab-slide]');
    if (p.node) slides.forEach(n => { n.style.setProperty('display', n === p.node ? n.dataset.unilabDisplay : 'none', 'important'); });
    frame.style.height = `${p.height}px`;
    frame.contentWindow.scrollTo(0, p.top);
    counter.textContent = `Page ${current + 1} of ${pages.length}`;
    preview.querySelector('[data-prev]').disabled = current === 0;
    preview.querySelector('[data-next]').disabled = current === pages.length - 1;
    fit();
  }

  function fit() {
    if (!frame || !viewport) return;
    const width = parseFloat(frame.style.width);
    const scale = Math.min(1, viewport.clientWidth / width);
    frame.style.transform = `scale(${scale})`;
    viewport.style.height = `${parseFloat(frame.style.height) * scale}px`;
  }

  window.addEventListener('hashchange', function leave() {
    disposed = true; generation++; resize.disconnect(); frame?.remove(); prepared = file = null; pages = [];
    window.removeEventListener('hashchange', leave);
  });
}
