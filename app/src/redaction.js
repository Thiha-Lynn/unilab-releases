import { PDFDocument } from 'pdf-lib';

// Same export used by the UI and the real-PDF regression test.
export async function redactPdf({ bytes, pdf, boxes, colour, dpi, renderPage, canvasToBlob, ctx, yieldTask = () => new Promise(r => setTimeout(r, 0)) }) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const marked = new Set(boxes.map((b) => b.page));

    // Copy all the untouched pages in one call — pdf-lib shares their resources
    // that way instead of duplicating fonts once per page.
    const passIdx = [];
    for (let n = 1; n <= pdf.numPages; n++) if (!marked.has(n)) passIdx.push(n - 1);
    const copied = passIdx.length ? await out.copyPages(src, passIdx) : [];
    const copiedBy = new Map(passIdx.map((idx, i) => [idx, copied[i]]));

    for (let n = 1; n <= pdf.numPages; n++) {
      if (ctx.signal?.aborted) throw new Error('canceled');
      ctx.setBusy((n - 1) / pdf.numPages, marked.has(n)
        ? `Rebuilding page ${n} of ${pdf.numPages}…`
        : `Copying page ${n} of ${pdf.numPages}…`);

      const passThrough = copiedBy.get(n - 1);
      if (passThrough) { out.addPage(passThrough); await yieldTask(); continue; }

      const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, 5000 / Math.max(vp.width, vp.height));
      const canvas = await renderPage(pdf, n, scale);
      const c = canvas.getContext('2d');
      c.fillStyle = colour;
      for (const b of boxes) {
        if (b.page !== n) continue;
        c.fillRect(
          Math.floor(b.x * canvas.width), Math.floor(b.y * canvas.height),
          Math.ceil((b.x + b.w) * canvas.width) - Math.floor(b.x * canvas.width),
          Math.ceil((b.y + b.h) * canvas.height) - Math.floor(b.y * canvas.height),
        );
      }
      // JPEG rather than PNG: at 200 DPI a rebuilt A4 page is around 2 MP, and a
      // lossless copy of it would make a two-page redaction bigger than the
      // thesis it came from.
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      const image = await out.embedJpg(await jpeg.arrayBuffer());
      const page = out.addPage([vp.width, vp.height]);
      page.drawImage(image, { x: 0, y: 0, width: vp.width, height: vp.height });

      // Free the backing store immediately — a 300 DPI A3 canvas is ~50 MB and
      // holding twelve of them is how a phone tab gets killed mid-export.
      canvas.width = 0;
      canvas.height = 0;
      await yieldTask();
    }

    ctx.setBusy(1, 'Saving…');
    return new Blob([await out.save()], { type: 'application/pdf' });
}
