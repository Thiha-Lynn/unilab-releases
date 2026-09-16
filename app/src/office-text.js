// Shared text machinery for the two Office → PDF tools (Word → PDF, Excel → PDF).
//
// Both of them do the same three things: measure text with the exact font the
// PDF will carry, break it into lines, and then paint the same list of drawing
// operations twice — once into an HTML preview and once into a real PDF. Doing
// it from one place is what makes the preview trustworthy: the page count and
// the line breaks a student sees on screen are produced by the same code that
// writes the file, not by a second, approximate implementation.
//
// The drawing operations are deliberately dumb. Coordinates are PDF points with
// the origin at the TOP-LEFT of the page (browsers count down, PDFs count up,
// and doing the flip once at the end is far less error-prone than doing it in
// every layout function):
//
//   { kind:'text',  x, base, size, text, script, bold, italic, color }
//   { kind:'rect',  x, top, w, h, fill }
//   { kind:'line',  x1, y1, x2, y2, thickness, color }
//   { kind:'image', x, top, w, h, src, img }
//
// `base` is the text baseline, because that is the one line every renderer
// agrees on.

import { rgb, StandardFonts } from 'pdf-lib';
import { el } from './ui.js';

// The two scripts UniLab ships a font for. Everything else that Helvetica
// cannot spell — Chinese, Japanese, Korean, Arabic — is replaced with a
// question mark and reported, rather than silently vanishing off the page.
const THAI = /[\u0E00-\u0E7F]/;
const MYANMAR = /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/;

// Unmodified Google Fonts releases under the SIL Open Font License 1.1; the
// licence sits beside them in public/fonts/OFL.txt. They are fetched from this
// site, same-origin, and only when the document actually contains that script —
// an English-only essay downloads nothing extra.
const FONT_FILES = {
  thai: { regular: 'NotoSansThai-Regular.ttf', bold: 'NotoSansThai-Bold.ttf' },
  myanmar: { regular: 'NotoSansMyanmar-Regular.ttf', bold: 'NotoSansMyanmar-Bold.ttf' },
};

// Font bytes are cached across documents: the preview builds one throwaway
// PDFDocument to measure with and the export builds another, and neither should
// re-download 47 KB of Noto Sans Thai.
const fontBytes = new Map();

/** Page boxes in points, the two a Thai university will ever ask for. */
export const PAGE_SIZES = {
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
  letter: { label: 'Letter (8.5 × 11 in)', w: 612, h: 792 },
};

/** Margin presets in points — 72 pt is one inch. */
export const MARGIN_PRESETS = {
  narrow: { label: 'Narrow (1.3 cm)', v: 36 },
  normal: { label: 'Normal (2.5 cm)', v: 72 },
  wide: { label: 'Wide (3.8 cm)', v: 108 },
};

// Where a browser puts the baseline inside a line box of `line-height: 1` for
// the Helvetica/Arial stack: ascender 1854/2048 of an em, minus the negative
// half-leading. Only the preview uses it; the PDF positions by baseline
// directly, so a tenth of a point of drift here never reaches the file.
const PREVIEW_BASELINE = 0.85;

// Latin first so the common case matches the Helvetica the PDF really carries,
// with the Noto faces behind it to catch Thai and Burmese. Naming only a Latin
// font would show a row of tofu boxes in the preview to exactly the students
// this tool exists for.
export const PREVIEW_STACK =
  '"Helvetica Neue", Helvetica, Arial, "Noto Sans Thai", "Leelawadee UI", "Noto Sans Myanmar", "Myanmar Text", Padauk, sans-serif';

/** Which shipped font family can spell this character. */
export function scriptOfChar(ch) {
  if (THAI.test(ch)) return 'thai';
  if (MYANMAR.test(ch)) return 'myanmar';
  return null;   // null means "neutral" — spaces, digits, punctuation
}

/**
 * Splits a string into runs of one script each, so a sentence that mixes a Thai
 * name with an English course code is drawn with two fonts instead of one that
 * cannot spell half of it. Neutral characters stay with the run they follow,
 * which keeps "รหัส 6431234" as two runs rather than five.
 */
export function splitByScript(text) {
  const out = [];
  let current = null;
  for (const ch of text) {
    const s = scriptOfChar(ch) ?? current?.script ?? 'std';
    if (current && current.script === s) current.text += ch;
    else { current = { script: s, text: ch }; out.push(current); }
  }
  return out;
}

/** Every non-Latin script present in a string, for deciding what to preload. */
export function scriptsUsed(text, into = new Set()) {
  if (THAI.test(text)) into.add('thai');
  if (MYANMAR.test(text)) into.add('myanmar');
  return into;
}

/**
 * Embeds the fonts a document needs and answers width questions about them.
 *
 * One bank belongs to one PDFDocument. `prepare()` is the only async part, so
 * every layout pass afterwards is synchronous and can run on every keystroke in
 * the sidebar without ever showing a spinner.
 */
export class FontBank {
  constructor(doc) {
    this.doc = doc;
    this.faces = new Map();
    this.missing = new Set();   // characters no shipped font can write
    this.ready = false;
  }

  async prepare(scripts = []) {
    const std = {
      'std::': StandardFonts.Helvetica,
      'std:b:': StandardFonts.HelveticaBold,
      'std::i': StandardFonts.HelveticaOblique,
      'std:b:i': StandardFonts.HelveticaBoldOblique,
    };
    for (const [key, name] of Object.entries(std)) {
      if (!this.faces.has(key)) this.faces.set(key, await this.doc.embedFont(name));
    }

    for (const script of scripts) {
      if (script === 'std' || !FONT_FILES[script]) continue;
      for (const bold of [false, true]) {
        const key = `${script}:${bold ? 'b' : ''}:`;
        if (this.faces.has(key)) continue;
        this.faces.set(key, await this.embedShipped(script, bold));
      }
    }
    this.ready = true;
  }

  async embedShipped(script, bold) {
    const file = FONT_FILES[script][bold ? 'bold' : 'regular'];
    if (!fontBytes.has(file)) {
      const url = new URL(`${import.meta.env.BASE_URL}fonts/${file}`, document.baseURI);
      let bytes;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw new Error(`The ${script === 'thai' ? 'Thai' : 'Burmese'} font could not be loaded from this site (${err.message}). It comes from this page, not from anywhere else, so check your connection and try again — it is only needed once.`);
      }
      fontBytes.set(file, bytes);
    }
    // fontkit is a big module, so it is imported only once a document really
    // turns out to contain one of these scripts.
    if (!this.fontkitReady) {
      const { default: fontkit } = await import('@pdf-lib/fontkit');
      this.doc.registerFontkit(fontkit);
      this.fontkitReady = true;
    }
    // subset:true means the finished PDF carries the handful of glyphs that
    // were really used, not the whole 180 KB family.
    return this.doc.embedFont(fontBytes.get(file), { subset: true });
  }

  /** The embedded font for a script/weight, falling back to Helvetica. */
  face(script = 'std', bold = false, italic = false) {
    // Noto Sans Thai and Noto Sans Myanmar have no italic cut, and neither
    // script uses one typographically, so an italic run in Thai stays upright
    // rather than being skewed until the vowel marks tear off.
    const key = script === 'std'
      ? `std:${bold ? 'b' : ''}:${italic ? 'i' : ''}`
      : `${script}:${bold ? 'b' : ''}:`;
    return this.faces.get(key) ?? this.faces.get('std::');
  }

  /** Width of a string in points, at the exact font the PDF will use. */
  width(text, script, bold, italic, size) {
    if (!text) return 0;
    const font = this.face(script, bold, italic);
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      return font.widthOfTextAtSize(this.safe(text, script, bold, italic), size);
    }
  }

  /**
   * The same string with every character this font cannot write swapped for a
   * question mark. Called during layout, not during export, so the preview
   * shows exactly the same substitution the PDF will contain — and `missing`
   * lets the tool say out loud which characters it had to drop.
   */
  safe(text, script, bold, italic) {
    if (!text) return text;
    const font = this.face(script, bold, italic);
    try { font.encodeText(text); return text; } catch { /* has an odd character */ }
    let out = '';
    for (const ch of text) {
      try { font.encodeText(ch); out += ch; }
      catch { this.missing.add(ch); out += '?'; }
    }
    return out;
  }
}

// Intl.Segmenter instances are expensive to build and are reused constantly.
const segmenters = new Map();
function segmenter(locale, granularity) {
  const key = `${locale}/${granularity}`;
  if (!segmenters.has(key)) {
    let made = null;
    try { made = new Intl.Segmenter(locale, { granularity }); } catch { made = null; }
    segmenters.set(key, made);
  }
  return segmenters.get(key);
}

/**
 * Splits a string into the smallest pieces a line may break between.
 *
 * English breaks at spaces. Thai and Burmese are written without spaces between
 * words, so a naive wrap would either never break a paragraph or break it in
 * the middle of a syllable. Intl.Segmenter knows where Thai words end and every
 * current browser ships it; where it is missing we fall back to breaking
 * between characters, which is ugly but readable.
 */
function tokenize(text, script) {
  if (script === 'std') return text.match(/\S+\s*|\s+/g) ?? [];
  const seg = segmenter(script === 'thai' ? 'th' : 'my', 'word');
  if (seg) return [...seg.segment(text)].map((s) => s.segment);
  return graphemes(text);
}

/** Characters, but never splitting a Thai vowel mark off its consonant. */
function graphemes(text) {
  const seg = segmenter('en', 'grapheme');
  if (seg) return [...seg.segment(text)].map((s) => s.segment);
  return [...text];
}

/**
 * Greedy line breaking over styled runs.
 *
 * runs:    [{ text, size, bold, italic, color, … }] — any extra keys ride along
 * measure: (piece) => width in points, given { text, script, size, bold, italic }
 * returns: [[piece, …], …] — one array of pieces per line, each with `.width`
 */
export function wrapRuns(runs, maxWidth, measure) {
  const tokens = [];
  for (const run of runs) {
    if (!run.text) continue;
    for (const part of splitByScript(run.text)) {
      for (const tok of tokenize(part.text, part.script)) {
        tokens.push({ ...run, text: tok, script: part.script });
      }
    }
  }

  const lines = [];
  let line = [];
  let width = 0;
  const flush = () => {
    // A line never ends with the space that pushed it over the edge.
    while (line.length && !line.at(-1).text.trim()) line.pop();
    if (line.length) lines.push(merge(line, measure));
    line = [];
    width = 0;
  };

  for (const tok of tokens) {
    const w = measure(tok);
    if (!line.length || width + w <= maxWidth) {
      if (w > maxWidth && !line.length) {
        // One unbreakable token wider than the whole column — a long URL, or a
        // Thai passage on a browser with no Segmenter. Break it by character.
        for (const ch of graphemes(tok.text)) {
          const cw = measure({ ...tok, text: ch });
          if (line.length && width + cw > maxWidth) flush();
          line.push({ ...tok, text: ch, width: cw });
          width += cw;
        }
        continue;
      }
      line.push({ ...tok, width: w });
      width += w;
      continue;
    }
    flush();
    line.push({ ...tok, width: w });
    width = w;
  }
  flush();
  return lines;
}

/** Re-joins adjacent pieces of a line that share a style, so one word is one op. */
function merge(pieces, measure) {
  const out = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.script === p.script && last.bold === p.bold
        && last.italic === p.italic && last.size === p.size && last.color === p.color) {
      last.text += p.text;
    } else {
      out.push({ ...p });
    }
  }
  for (const p of out) p.width = measure(p);
  return out;
}

/** '#1a1a1a' → the pdf-lib colour object. */
export function hexRgb(hex = '#1a1a1a') {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0x1a1a1a;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Paints one page's operations into a real PDF page. */
export function drawOps(page, ops, bank) {
  const H = page.getHeight();
  for (const op of ops) {
    if (op.kind === 'text') {
      if (!op.text) continue;
      page.drawText(op.text, {
        x: op.x,
        y: H - op.base,
        size: op.size,
        font: bank.face(op.script, op.bold, op.italic),
        color: hexRgb(op.color),
      });
    } else if (op.kind === 'rect') {
      page.drawRectangle({ x: op.x, y: H - op.top - op.h, width: op.w, height: op.h, color: hexRgb(op.fill) });
    } else if (op.kind === 'line') {
      page.drawLine({
        start: { x: op.x1, y: H - op.y1 },
        end: { x: op.x2, y: H - op.y2 },
        thickness: op.thickness ?? 0.5,
        color: hexRgb(op.color ?? '#c9ced6'),
      });
    } else if (op.kind === 'image' && op.img) {
      page.drawImage(op.img, { x: op.x, y: H - op.top - op.h, width: op.w, height: op.h });
    }
  }
}

/**
 * Paints the same operations into an HTML page for the workarea.
 *
 * Real positioned text rather than a canvas snapshot, so the preview stays
 * crisp at any zoom and a student can check a Thai name by selecting it.
 */
export function previewPage(ops, { w, h, scale = 0.55 }) {
  const page = el(`<div class="ts__page" style="padding:0;overflow:hidden;background:#fff;position:relative;"></div>`);
  page.style.width = `${(w * scale).toFixed(1)}px`;
  page.style.height = `${(h * scale).toFixed(1)}px`;

  for (const op of ops) {
    const node = document.createElement(op.kind === 'image' ? 'img' : 'div');
    node.style.position = 'absolute';
    if (op.kind === 'text') {
      if (!op.text) continue;
      node.style.left = `${(op.x * scale).toFixed(2)}px`;
      node.style.top = `${((op.base - op.size * PREVIEW_BASELINE) * scale).toFixed(2)}px`;
      node.style.fontSize = `${(op.size * scale).toFixed(2)}px`;
      node.style.lineHeight = '1';
      node.style.whiteSpace = 'pre';
      node.style.fontFamily = PREVIEW_STACK;
      node.style.fontWeight = op.bold ? '700' : '400';
      node.style.fontStyle = op.italic ? 'italic' : 'normal';
      node.style.color = op.color ?? '#1a1a1a';
      node.textContent = op.text;
    } else if (op.kind === 'rect') {
      node.style.left = `${(op.x * scale).toFixed(2)}px`;
      node.style.top = `${(op.top * scale).toFixed(2)}px`;
      node.style.width = `${(op.w * scale).toFixed(2)}px`;
      node.style.height = `${(op.h * scale).toFixed(2)}px`;
      node.style.background = op.fill;
    } else if (op.kind === 'line') {
      // Hairlines would round to nothing at preview scale, so they are drawn at
      // a visible minimum — the PDF still gets the real thickness.
      const vertical = Math.abs(op.x2 - op.x1) < 0.01;
      node.style.left = `${(Math.min(op.x1, op.x2) * scale).toFixed(2)}px`;
      node.style.top = `${(Math.min(op.y1, op.y2) * scale).toFixed(2)}px`;
      node.style.width = `${vertical ? 1 : Math.abs(op.x2 - op.x1) * scale}px`;
      node.style.height = `${vertical ? Math.abs(op.y2 - op.y1) * scale : 1}px`;
      node.style.background = op.color ?? '#c9ced6';
    } else if (op.kind === 'image') {
      node.src = op.src;
      node.alt = '';
      node.style.left = `${(op.x * scale).toFixed(2)}px`;
      node.style.top = `${(op.top * scale).toFixed(2)}px`;
      node.style.width = `${(op.w * scale).toFixed(2)}px`;
      node.style.height = `${(op.h * scale).toFixed(2)}px`;
    }
    page.appendChild(node);
  }
  return page;
}

/** The workarea shell both tools drop their preview pages into. */
export function previewStrip() {
  const root = el(`<div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start;"></div>`);
  const hint = el(`<p class="ts__hint" style="margin:0;"></p>`);
  const pages = el(`<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;max-height:620px;overflow:auto;padding:2px 2px 6px;"></div>`);
  root.append(hint, pages);
  return { root, hint, pages };
}

/** A page with its "Page 3" caption under it, matching the split-pdf thumbnails. */
export function captionedPage(node, caption) {
  const wrap = el(`<div style="display:flex;flex-direction:column;align-items:center;gap:4px;"></div>`);
  const label = el(`<span class="ts__page__n" style="margin:0;"></span>`);
  label.textContent = caption;
  wrap.append(node, label);
  return wrap;
}
