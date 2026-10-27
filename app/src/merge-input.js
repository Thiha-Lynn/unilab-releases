import { PDFDocument } from 'pdf-lib';
import { loadImage, canvasToBlob } from './ui.js';
export async function readMergeInput(file) {
  if (!/\.(jpe?g|png)$/i.test(file.name) && !/^image\/(jpeg|png)$/.test(file.type)) {
    return { doc: await PDFDocument.load(await file.arrayBuffer()) };
  }
  const image = await loadImage(file);
  const max = 3400;
  const ratio = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  thumb.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const ctx = thumb.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, thumb.width, thumb.height); ctx.drawImage(image, 0, 0, thumb.width, thumb.height);
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(await (await canvasToBlob(thumb, 'image/jpeg', 0.92)).arrayBuffer());
  const page = doc.addPage(thumb.width > thumb.height ? [841.89, 595.28] : [595.28, 841.89]);
  const scale = Math.min((page.getWidth() - 40) / thumb.width, (page.getHeight() - 40) / thumb.height);
  const width = thumb.width * scale, height = thumb.height * scale;
  page.drawImage(jpg, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
  return { doc, thumb };
}
