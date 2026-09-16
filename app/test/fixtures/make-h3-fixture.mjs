/**
 * H3 measurement fixture — a deterministic 10 MB PDF.
 *
 * H3 ("on campus Wi-Fi the upload round trip is itself part of the wait") is the one driver in
 * the spec marked *unvalidated and unmeasured*. No number of interviews settles it; someone has
 * to time it. A timing comparison is only meaningful if both sides move the **same bytes**, so
 * this script builds one file, byte-identical on every machine, rather than everyone grabbing
 * "some 10 MB PDF" off their laptop.
 *
 *   node test/fixtures/make-h3-fixture.mjs
 *   -> test/fixtures/h3-10mb.pdf   (~10 MB, same SHA-256 everywhere)
 *
 * The output is gitignored on purpose: a 10 MB binary does not belong in the history when a
 * 3 KB generator reproduces it exactly.
 *
 * Why incompressible noise rather than a photo: H3 is about **transfer**, not about how clever a
 * compressor is. Noise pins the payload size through the whole round trip, so the number you
 * record is network time and not the competitor's compression ratio.
 */

import { PDFDocument } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'h3-10mb.pdf');
const TARGET = 10 * 1024 * 1024;      // 10 MB, the size the interview guide names
const PAGES = 8;
const W = 1240, H = 1754;             // A4 at 150 dpi — a plausible scanned page

/* mulberry32: a 32-bit PRNG, seeded, so every run on every machine emits identical bytes. */
function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A minimal PNG encoder: IHDR + IDAT + IEND. Enough for pdf-lib's embedPng. */
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rand) {
  // one filter byte (0 = None) per scanline, then RGB triples
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width * 3; x++) raw[p++] = (rand() * 256) | 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),   // level 1: noise will not compress anyway
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rand = rng(1305493);            // the course code, so the seed is not arbitrary
const doc = await PDFDocument.create();
doc.setTitle('UniLab H3 measurement fixture');
doc.setSubject('Deterministic 10 MB payload for timing an upload round trip. Not user data.');
doc.setCreationDate(new Date(Date.UTC(2026, 8, 8)));   // fixed, or the bytes differ per run
doc.setModificationDate(new Date(Date.UTC(2026, 8, 8)));

// aim slightly under, then pad up to exactly TARGET — overshooting cannot be undone
const perPage = Math.floor((TARGET * 0.98) / PAGES);
for (let i = 0; i < PAGES; i++) {
  // width chosen so this page's PNG lands near perPage bytes
  const w = Math.max(64, Math.min(W, Math.round(Math.sqrt(perPage / 3 * (W / H)))));
  const h = Math.round(w * (H / W));
  const img = await doc.embedPng(png(w, h, rand));
  const page = doc.addPage([595.28, 841.89]);         // A4 in points
  page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
}

let bytes = Buffer.from(await doc.save({ useObjectStreams: false }));

// Pad to exactly TARGET with a PDF comment, so the payload size is a round number to report.
if (bytes.length < TARGET) {
  const pad = Buffer.alloc(TARGET - bytes.length, 0x20);
  pad[0] = 0x0A; pad[1] = 0x25;                        // newline, '%' -> a trailing comment
  bytes = Buffer.concat([bytes, pad]);
} else if (bytes.length > TARGET) {
  console.warn(`! generated ${bytes.length} bytes, larger than the ${TARGET} target — lower PAGES`);
}

mkdirSync(HERE, { recursive: true });
writeFileSync(OUT, bytes);

const sha = createHash('sha256').update(bytes).digest('hex');
console.log(`wrote   ${OUT}`);
console.log(`size    ${bytes.length} bytes (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`sha256  ${sha}`);
console.log(`\nEveryone measuring H3 must see this same sha256. If yours differs, you are timing a`);
console.log(`different file and the two numbers cannot be compared.`);
