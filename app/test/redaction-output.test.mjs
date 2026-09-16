import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { redactPdf } from '../src/redaction.js';

async function renderPage(pdf, n, scale) {
  const page = await pdf.getPage(n), viewport = page.getViewport({scale});
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,intent:'print'}).promise;
  return canvas;
}
test('redaction removes marked-page text and annotations, preserves untouched text, and paints the output', async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  source.setTitle('SECRET-12345');
  source.addPage([400,300]).drawText('SECRET-12345', {x:40,y:220,font,size:20});
  source.addPage([400,300]).drawText('Keep this paragraph', {x:40,y:220,font,size:20});
  const bytes = await source.save();
  const sourceTask = getDocument({data:bytes.slice(),useSystemFonts:true});
  const pdf = await sourceTask.promise;
  try {
    const blob = await redactPdf({bytes,pdf,boxes:[{page:1,x:0.075,y:0.15,w:0.8,h:0.2}],colour:'#000000',dpi:144,renderPage,
      canvasToBlob: async c => new Blob([await c.encode('jpeg',92)]),ctx:{setBusy(){}}});
    const outputBytes = new Uint8Array(await blob.arrayBuffer());
    const resultTask = getDocument({data:outputBytes.slice(),useSystemFonts:true});
    const result = await resultTask.promise;
    try {
      assert.equal(result.numPages,2);
      assert.deepEqual((await (await result.getPage(1)).getTextContent()).items,[]);
      assert.equal((await (await result.getPage(2)).getTextContent()).items.map(i=>i.str).join(''),'Keep this paragraph');
      assert.deepEqual(await (await result.getPage(1)).getAnnotations(),[]);
      const canvas = await renderPage(result,1,1);
      const pixel = canvas.getContext('2d').getImageData(80,70,1,1).data;
      assert.ok(pixel[0]<8 && pixel[1]<8 && pixel[2]<8,'redaction must be black in the actual exported PDF');
      assert.notEqual((await PDFDocument.load(outputBytes)).getTitle(),'SECRET-12345');
    } finally { await resultTask.destroy(); }
  } finally { await sourceTask.destroy(); }
});
