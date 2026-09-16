// The operation catalogue behind Workflows.
//
// iLovePDF sells "Workflows" — chain your tools together, save the chain, reuse it —
// as a Premium feature, and it has to be paid because every hop in the chain costs
// them another upload, another store and another download. In a browser the file is
// already in memory, so a chain is not only free, it is *faster* than running the
// tools one at a time: nothing is written to disk between steps.
//
// An op is a small, honest unit of work with a declared input and output type, so a
// chain can be validated before it runs. Ops are deliberately thin wrappers over the
// same libraries the individual tools use — the tools stay the place where a job gets
// a rich, previewable UI, and ops are the place where it gets composable.

import imageCompression from 'browser-image-compression';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { MIME_EXT, canvasToBlob, loadImage, stem } from './ui.js';
import { openPdf, renderPage } from './pdf-utils.js';

/** Media types a step can consume or produce. */
export const KIND = { IMAGE: 'image', PDF: 'pdf', VIDEO: 'video', AUDIO: 'audio' };

export function kindOf(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) return KIND.IMAGE;
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return KIND.PDF;
  if (type.startsWith('video/')) return KIND.VIDEO;
  if (type.startsWith('audio/')) return KIND.AUDIO;
  return null;
}

const asBlobFile = (blob, name) => new File([blob], name, { type: blob.type });

// ---------------------------------------------------------------------------
// Image ops
// ---------------------------------------------------------------------------

const compressImage = {
  id: 'compress-image',
  label: 'Compress image',
  hint: 'Shrink photos to fit an upload limit',
  accepts: KIND.IMAGE,
  produces: KIND.IMAGE,
  params: [
    { id: 'maxMB', label: 'Must be under', type: 'select', value: '1.9',
      options: [['0.19', '200 KB'], ['0.48', '500 KB'], ['0.95', '1 MB'], ['1.9', '2 MB'], ['4.8', '5 MB'], ['9.5', '10 MB']] },
    { id: 'maxDim', label: 'Longest side (px)', type: 'number', value: 0, min: 0, max: 8000, step: 100,
      hint: '0 keeps the original size' },
  ],
  describe: (p) => `compressed to under ${({ '0.19': '200 KB', '0.48': '500 KB', '0.95': '1 MB', '1.9': '2 MB', '4.8': '5 MB', '9.5': '10 MB' })[p.maxMB]}`,
  async run(files, p) {
    const out = [];
    for (const f of files) {
      const blob = await imageCompression(f, {
        maxSizeMB: Number(p.maxMB),
        maxWidthOrHeight: Number(p.maxDim) || undefined,
        useWebWorker: true,
      });
      out.push(asBlobFile(blob, f.name));
    }
    return out;
  },
};

const resizeImage = {
  id: 'resize-image',
  label: 'Resize image',
  hint: 'Set an exact width, keeping the shape',
  accepts: KIND.IMAGE,
  produces: KIND.IMAGE,
  params: [
    { id: 'width', label: 'Width (px)', type: 'number', value: 1280, min: 16, max: 10000, step: 10 },
  ],
  describe: (p) => `resized to ${p.width} px wide`,
  async run(files, p) {
    const out = [];
    for (const f of files) {
      const img = await loadImage(f);
      const width = Math.min(Number(p.width), img.naturalWidth * 4);
      const height = Math.round((width / img.naturalWidth) * img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, width, height);
      const type = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
      out.push(asBlobFile(await canvasToBlob(canvas, type, 0.92), f.name));
    }
    return out;
  },
};

const watermarkImage = {
  id: 'watermark-image',
  label: 'Watermark image',
  hint: 'Stamp text across the picture',
  accepts: KIND.IMAGE,
  produces: KIND.IMAGE,
  params: [
    { id: 'text', label: 'Text', type: 'text', value: 'UniLab' },
    { id: 'opacity', label: 'Opacity', type: 'range', value: 35, min: 5, max: 90, suffix: '%' },
    { id: 'tile', label: 'Repeat across the whole image', type: 'check', value: true },
  ],
  describe: (p) => `watermarked “${p.text}”`,
  async run(files, p) {
    const out = [];
    for (const f of files) {
      const img = await loadImage(f);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d');
      g.drawImage(img, 0, 0);
      const size = Math.max(14, canvas.width * 0.045);
      g.font = `600 ${size}px -apple-system, "Segoe UI", system-ui, "Noto Sans Thai", sans-serif`;
      g.fillStyle = `rgba(255,255,255,${Number(p.opacity) / 100})`;
      g.strokeStyle = `rgba(0,0,0,${(Number(p.opacity) / 100) * 0.5})`;
      g.lineWidth = Math.max(1, size / 14);
      g.textBaseline = 'middle';
      const w = g.measureText(p.text).width;
      if (p.tile) {
        g.save();
        g.rotate(-Math.PI / 9);
        const stepX = w * 1.7;
        const stepY = size * 4;
        for (let y = -canvas.height; y < canvas.height * 1.6; y += stepY) {
          for (let x = -canvas.width; x < canvas.width * 1.6; x += stepX) {
            g.strokeText(p.text, x, y);
            g.fillText(p.text, x, y);
          }
        }
        g.restore();
      } else {
        const x = canvas.width - w - size;
        const y = canvas.height - size;
        g.strokeText(p.text, x, y);
        g.fillText(p.text, x, y);
      }
      out.push(asBlobFile(await canvasToBlob(canvas, 'image/jpeg', 0.92), f.name));
    }
    return out;
  },
};

const convertImage = {
  id: 'convert-image',
  label: 'Convert image',
  hint: 'Re-save as JPG, PNG or WebP',
  accepts: KIND.IMAGE,
  produces: KIND.IMAGE,
  params: [
    { id: 'format', label: 'Save as', type: 'select', value: 'webp',
      options: [['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']] },
    { id: 'quality', label: 'Quality', type: 'range', value: 85, min: 40, max: 100, suffix: '%',
      hint: 'PNG is lossless, so quality only applies to JPG and WebP' },
  ],
  describe: (p) => {
    const label = ({ jpg: 'JPG', png: 'PNG', webp: 'WebP' })[p.format] ?? p.format;
    return p.format === 'png' ? `converted to ${label}` : `converted to ${label} at ${p.quality}%`;
  },
  async run(files, p, onProgress) {
    const mime = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[p.format] ?? 'image/jpeg';
    const out = [];
    for (const [i, f] of files.entries()) {
      const img = await loadImage(f);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d');
      // JPG has no alpha channel — flatten transparency onto white, not black.
      if (mime === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height); }
      g.drawImage(img, 0, 0);
      const blob = await canvasToBlob(canvas, mime, Number(p.quality) / 100);
      // A browser that can't encode the asked-for type silently hands back PNG —
      // name the file by what the blob actually is, never by what was hoped for.
      const ext = MIME_EXT[blob.type] ?? 'png';
      out.push(asBlobFile(blob, `${stem(f.name)}.${ext}`));
      onProgress?.((i + 1) / files.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  },
};

const imagesToPdf = {
  id: 'images-to-pdf',
  label: 'Images → PDF',
  hint: 'Bind the photos into one PDF, one per page',
  accepts: KIND.IMAGE,
  produces: KIND.PDF,
  params: [
    { id: 'name', label: 'File name', type: 'text', value: 'photos' },
  ],
  describe: () => 'bound into a single PDF',
  async run(files, p) {
    const doc = await PDFDocument.create();
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let embedded;
      if (f.type === 'image/png') {
        embedded = await doc.embedPng(bytes);
      } else if (f.type === 'image/jpeg') {
        embedded = await doc.embedJpg(bytes);
      } else {
        // WebP and friends have no direct embed — re-encode through a canvas.
        const img = await loadImage(f);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
        embedded = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      }
      const page = doc.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    const blob = new Blob([await doc.save()], { type: 'application/pdf' });
    return [asBlobFile(blob, `${p.name || 'photos'}.pdf`)];
  },
};

// ---------------------------------------------------------------------------
// PDF ops
// ---------------------------------------------------------------------------

const mergePdf = {
  id: 'merge-pdf',
  label: 'Merge PDFs',
  hint: 'Join every PDF in the chain into one',
  accepts: KIND.PDF,
  produces: KIND.PDF,
  params: [{ id: 'name', label: 'File name', type: 'text', value: 'merged' }],
  describe: () => 'merged into one PDF',
  async run(files, p) {
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((page) => out.addPage(page));
    }
    const blob = new Blob([await out.save()], { type: 'application/pdf' });
    return [asBlobFile(blob, `${p.name || 'merged'}.pdf`)];
  },
};

const pageNumbers = {
  id: 'page-numbers',
  label: 'Add page numbers',
  hint: 'Number every page, thesis-style',
  accepts: KIND.PDF,
  produces: KIND.PDF,
  params: [
    { id: 'position', label: 'Position', type: 'select', value: 'bottom-center',
      options: [['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['top-right', 'Top right']] },
    { id: 'start', label: 'Start at', type: 'number', value: 1, min: 1, max: 9999 },
  ],
  describe: (p) => `numbered from ${p.start}`,
  async run(files, p) {
    const out = [];
    for (const f of files) {
      const doc = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.getPages().forEach((page, i) => {
        const label = String(Number(p.start) + i);
        const size = 11;
        const width = font.widthOfTextAtSize(label, size);
        const { width: pw, height: ph } = page.getSize();
        const pos = {
          'bottom-center': { x: pw / 2 - width / 2, y: 24 },
          'bottom-right': { x: pw - width - 36, y: 24 },
          'top-right': { x: pw - width - 36, y: ph - 32 },
        }[p.position];
        page.drawText(label, { ...pos, size, font, color: rgb(0.25, 0.25, 0.3) });
      });
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      out.push(asBlobFile(blob, f.name));
    }
    return out;
  },
};

const watermarkPdf = {
  id: 'watermark-pdf',
  label: 'Watermark PDF',
  hint: 'Stamp DRAFT or your name diagonally',
  accepts: KIND.PDF,
  produces: KIND.PDF,
  params: [
    { id: 'text', label: 'Text', type: 'text', value: 'DRAFT' },
    { id: 'opacity', label: 'Opacity', type: 'range', value: 18, min: 5, max: 60, suffix: '%' },
  ],
  describe: (p) => `stamped “${p.text}”`,
  async run(files, p) {
    const out = [];
    for (const f of files) {
      const doc = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        const size = Math.min(width, height) * 0.16;
        const textWidth = font.widthOfTextAtSize(p.text, size);
        page.drawText(p.text, {
          x: width / 2 - (textWidth / 2) * Math.cos(Math.PI / 6),
          y: height / 2 - (textWidth / 2) * Math.sin(Math.PI / 6),
          size,
          font,
          color: rgb(0.5, 0.5, 0.55),
          opacity: Number(p.opacity) / 100,
          rotate: degrees(30),
        });
      }
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      out.push(asBlobFile(blob, f.name));
    }
    return out;
  },
};

const compressPdf = {
  id: 'compress-pdf',
  label: 'Compress PDF',
  hint: 'Rasterize pages to get under a size cap',
  accepts: KIND.PDF,
  produces: KIND.PDF,
  params: [
    { id: 'quality', label: 'Quality', type: 'select', value: '0.7',
      options: [['0.85', 'High — barely smaller'], ['0.7', 'Balanced'], ['0.5', 'Small'], ['0.35', 'Smallest']] },
    { id: 'scale', label: 'Page scale', type: 'select', value: '1.5',
      options: [['2', 'Sharp (2×)'], ['1.5', 'Normal (1.5×)'], ['1', 'Small (1×)']] },
  ],
  // Stated plainly because it is a real trade: this path turns text into pixels.
  describe: () => 'compressed (pages become images — text is no longer selectable)',
  async run(files, p, onProgress) {
    const out = [];
    for (const f of files) {
      const pdf = await openPdf(f);
      const doc = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPage(pdf, i, Number(p.scale));
        const jpg = await canvasToBlob(canvas, 'image/jpeg', Number(p.quality));
        const embedded = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        const page = doc.addPage([embedded.width, embedded.height]);
        page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
        onProgress?.(i / pdf.numPages);
        await new Promise((r) => setTimeout(r, 0));
      }
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      out.push(asBlobFile(blob, f.name));
    }
    return out;
  },
};

const rotatePdf = {
  id: 'rotate-pdf',
  label: 'Rotate PDF',
  hint: 'Turn every page — lossless, nothing is re-rendered',
  accepts: KIND.PDF,
  produces: KIND.PDF,
  params: [
    { id: 'direction', label: 'Turn', type: 'select', value: 'right',
      options: [['left', 'Left 90°'], ['right', 'Right 90°'], ['180', 'Upside down']] },
  ],
  describe: (p) => ({
    left: 'turned a quarter-turn left',
    right: 'turned a quarter-turn right',
    180: 'turned upside down',
  })[p.direction] ?? 'rotated',
  async run(files, p, onProgress) {
    const delta = ({ left: -90, right: 90, 180: 180 })[p.direction] ?? 90;
    const out = [];
    for (const [i, f] of files.entries()) {
      const doc = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      for (const page of doc.getPages()) {
        // Add to whatever rotation the page already carries, kept in 0–270.
        const existing = page.getRotation().angle;
        page.setRotation(degrees((((existing + delta) % 360) + 360) % 360));
      }
      const blob = new Blob([await doc.save()], { type: 'application/pdf' });
      out.push(asBlobFile(blob, f.name));
      onProgress?.((i + 1) / files.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  },
};

const pdfToImages = {
  id: 'pdf-to-images',
  label: 'PDF → images',
  hint: 'Every page becomes a JPG',
  accepts: KIND.PDF,
  produces: KIND.IMAGE,
  params: [
    { id: 'scale', label: 'Resolution', type: 'select', value: '2',
      options: [['3', 'High (3×)'], ['2', 'Normal (2×)'], ['1', 'Screen (1×)']] },
  ],
  describe: () => 'exported as one image per page',
  async run(files, p, onProgress) {
    const out = [];
    for (const f of files) {
      const pdf = await openPdf(f);
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPage(pdf, i, Number(p.scale));
        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
        out.push(asBlobFile(blob, `${stem(f.name)}-${String(i).padStart(3, '0')}.jpg`));
        onProgress?.(i / pdf.numPages);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Media ops — loaded lazily so a chain with no media in it never pays for the
// WebCodecs engine.
// ---------------------------------------------------------------------------

const extractAudio = {
  id: 'extract-audio',
  label: 'Extract audio',
  hint: 'Pull the sound out of a video',
  accepts: KIND.VIDEO,
  produces: KIND.AUDIO,
  params: [
    { id: 'format', label: 'Save as', type: 'select', value: 'mp3', options: [['mp3', 'MP3'], ['m4a', 'M4A'], ['ogg', 'OGG']] },
    { id: 'kbps', label: 'Bitrate', type: 'select', value: '128', options: [['192', '192 kbps'], ['128', '128 kbps'], ['96', '96 kbps'], ['64', '64 kbps · speech']] },
    { id: 'mono', label: 'Mono', type: 'check', value: true },
  ],
  describe: (p) => `audio pulled out as ${p.format.toUpperCase()}`,
  async run(files, p, onProgress) {
    const { convertMedia, pickAudioCodec, quality } = await import('./media-utils.js');
    const out = [];
    for (const [i, f] of files.entries()) {
      const codec = await pickAudioCodec(p.format);
      const { blob, ext } = await convertMedia({
        file: f,
        container: p.format,
        video: { discard: true },
        audio: { codec, quality: quality(Number(p.kbps) * 1000), ...(p.mono ? { numberOfChannels: 1 } : {}) },
        onProgress: (frac) => onProgress?.((i + frac) / files.length),
      });
      out.push(asBlobFile(blob, `${stem(f.name)}.${ext}`));
    }
    return out;
  },
};

const compressVideo = {
  id: 'compress-video',
  label: 'Compress video',
  hint: 'Shrink a clip to fit a size limit',
  accepts: KIND.VIDEO,
  produces: KIND.VIDEO,
  params: [
    { id: 'cap', label: 'Resolution', type: 'select', value: '720', options: [['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']] },
    { id: 'targetMB', label: 'Aim for', type: 'select', value: '25', options: [['10', '10 MB'], ['25', '25 MB'], ['50', '50 MB'], ['100', '100 MB']] },
  ],
  describe: (p) => `compressed to ${p.cap}p under about ${p.targetMB} MB`,
  async run(files, p, onProgress) {
    const { convertMedia, probeMedia, pickVideoCodec, bitrateForTargetSize, evenSize, quality } = await import('./media-utils.js');
    const out = [];
    for (const [i, f] of files.entries()) {
      const probe = await probeMedia(f);
      const cap = Number(p.cap);
      const { width: w, height: h } = probe.video;
      const scale = Math.min(w, h) > cap ? cap / Math.min(w, h) : 1;
      const width = evenSize(w * scale);
      const height = evenSize(h * scale);
      const bitrate = bitrateForTargetSize({
        targetBytes: Number(p.targetMB) * 1024 ** 2,
        durationSeconds: probe.duration,
        audioBitrate: probe.hasAudio ? 128_000 : 0,
      });
      const codec = await pickVideoCodec('mp4', { width, height, bitrate });
      const { blob, ext } = await convertMedia({
        file: f,
        container: 'mp4',
        video: { width, height, fit: 'contain', codec, quality: quality(bitrate), forceTranscode: true },
        onProgress: (frac) => onProgress?.((i + frac) / files.length),
      });
      out.push(asBlobFile(blob, `${stem(f.name)}.${ext}`));
    }
    return out;
  },
};

export const OPS = [
  compressImage, resizeImage, convertImage, watermarkImage, imagesToPdf,
  mergePdf, rotatePdf, pageNumbers, watermarkPdf, compressPdf, pdfToImages,
  extractAudio, compressVideo,
];

export const OP_BY_ID = Object.fromEntries(OPS.map((o) => [o.id, o]));

/** Default parameter values for a step, so a newly added step is immediately runnable. */
export function defaultParams(op) {
  return Object.fromEntries(op.params.map((p) => [p.id, p.value]));
}

/**
 * Checks a chain end to end. Returns `{ ok, problems: [{ index, message }] }`.
 * A chain is only valid if each step can eat what the previous one produced.
 */
export function validateChain(steps, inputKind) {
  const problems = [];
  let kind = inputKind;
  steps.forEach((step, i) => {
    const op = OP_BY_ID[step.opId];
    if (!op) { problems.push({ index: i, message: 'Unknown step.' }); return; }
    if (kind && op.accepts !== kind) {
      problems.push({
        index: i,
        message: `“${op.label}” needs ${article(op.accepts)} ${op.accepts} file, but the step before it produces ${article(kind)} ${kind} file.`,
      });
    }
    kind = op.produces;
  });
  return { ok: problems.length === 0, problems, outputKind: kind };
}

function article(word) {
  return /^[aeiou]/i.test(word ?? '') ? 'an' : 'a';
}

/** Runs a chain over a set of files, reporting progress across all steps. */
export async function runChain(steps, files, { onProgress, signal } = {}) {
  let current = files;
  const trail = [];
  for (const [i, step] of steps.entries()) {
    if (signal?.aborted) throw new Error('canceled');
    const op = OP_BY_ID[step.opId];
    onProgress?.(i / steps.length, `Step ${i + 1} of ${steps.length}: ${op.label}…`);
    current = await op.run(current, step.params, (frac) => {
      onProgress?.((i + frac) / steps.length, `Step ${i + 1} of ${steps.length}: ${op.label}…`);
    });
    trail.push({ op: op.label, count: current.length, bytes: current.reduce((s, f) => s + f.size, 0) });
    await new Promise((r) => setTimeout(r, 0));
  }
  return { files: current, trail };
}
