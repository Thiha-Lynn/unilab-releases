// Central pdf.js setup — the worker must be registered once, Vite-style.
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export async function openPdf(file) {
  const data = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data }).promise;
}

// Render one page to a canvas at the given scale.
export async function renderPage(pdf, pageNum, scale = 2) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // intent:'print' avoids requestAnimationFrame scheduling, so rendering keeps
  // going even when the tab is backgrounded mid-way through a long job.
  await page.render({ canvasContext: ctx, viewport, canvas, intent: 'print' }).promise;
  return canvas;
}

// Parse a page-range string like "1-3, 5, 8-10" into a sorted list of page numbers (1-based).
export function parsePageRanges(text, pageCount) {
  const pages = new Set();
  for (const part of text.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a < 1 || b < a) throw new Error(`Invalid range "${p}"`);
      for (let i = a; i <= Math.min(b, pageCount); i++) pages.add(i);
    } else if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n >= 1 && n <= pageCount) pages.add(n);
    } else {
      throw new Error(`Could not understand "${p}" — use formats like 1-3, 5, 8-10`);
    }
  }
  if (!pages.size) throw new Error('No valid pages selected');
  return [...pages].sort((x, y) => x - y);
}
