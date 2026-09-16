// Canvas text drawing, shared by every tool that writes words onto a picture.
//
// This started life inside image-text.js. Photo Editor needs exactly the same
// three things — a font stack that survives Thai and Burmese, wrapping that
// breaks in the right places for those scripts, and the outline rule that keeps
// a caption readable on a photo nobody controls — so the logic lives here
// instead of being written twice and drifting apart.

// Every stack ends in the app's own font list rather than in a Latin-only face.
// Canvas falls back per character, so a caption that mixes English with Thai or
// Burmese still renders: the Latin letters come from Georgia (or Menlo, or the
// system UI font) and the rest come from whatever the device has for that
// script. Naming a single font here would give a page full of tofu boxes.
export const APP_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, "Noto Sans Thai", "Noto Sans Myanmar", "Myanmar Text"';

export const FONTS = {
  system: { label: 'System (sans)', stack: `${APP_FALLBACK}, sans-serif` },
  serif: { label: 'Serif', stack: `Georgia, "Times New Roman", "Noto Serif Thai", ${APP_FALLBACK}, serif` },
  mono: { label: 'Monospace', stack: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", ${APP_FALLBACK}, monospace` },
};

// Thai, Burmese, Lao and Khmer don't put spaces between words, so splitting on
// whitespace would leave one enormous "word" that runs straight off the edge.
// Intl.Segmenter knows where those scripts actually break (ICU does it by
// dictionary, whatever the locale); splitting on spaces is the fallback.
const wordSegmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;
const cellSegmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** Splits a line into the pieces it is allowed to wrap between. */
export function splitTokens(text) {
  if (!wordSegmenter) return text.split(/(\s+)/).filter(Boolean);
  const tokens = [];
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    const attachToPrevious = !isWordLike
      && !/^\s+$/.test(segment)
      && tokens.length
      && !/\s$/.test(tokens[tokens.length - 1]);
    // Punctuation belongs to the word in front of it — "Fig." must never wrap
    // between the "g" and the dot.
    if (attachToPrevious) tokens[tokens.length - 1] += segment;
    else tokens.push(segment);
  }
  return tokens;
}

/** Longest prefix of `text` that fits `maxWidth`, cut on grapheme boundaries. */
function headThatFits(ctx, text, maxWidth) {
  const cells = cellSegmenter ? [...cellSegmenter.segment(text)].map((s) => s.segment) : [...text];
  if (cells.length < 2) return null;
  // Binary search rather than walking back one character at a time: measureText
  // is the expensive part, and this runs on every keystroke.
  let lo = 1;
  let hi = cells.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(cells.slice(0, mid).join('')).width <= maxWidth) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return cells.slice(0, best).join('');
}

// A trailing space costs nothing at the end of a line, so it must never count
// towards the width — measuring it pushed perfectly good lines over the limit.
const visible = (s) => s.replace(/\s+$/, '');

/** Greedy word wrap for one source line. Always returns at least one entry. */
export function wrapLine(ctx, line, maxWidth) {
  const out = [];
  let current = '';
  const flush = () => { out.push(visible(current)); current = ''; };

  for (const token of splitTokens(line)) {
    const candidate = current + token;
    if (current && ctx.measureText(visible(candidate)).width > maxWidth) {
      flush();
      current = /^\s+$/.test(token) ? '' : token;
    } else {
      current = candidate;
    }
    // A single token can still be wider than the whole image — a long URL, or a
    // script this browser couldn't segment. Break it mid-word rather than let
    // it disappear off the side.
    while (ctx.measureText(visible(current)).width > maxWidth) {
      const head = headThatFits(ctx, visible(current), maxWidth);
      if (!head) break;
      out.push(head);
      current = current.slice(head.length);
    }
  }
  flush();
  return out;
}

/** Whole block of typed text → the lines that will actually be painted. */
export function wrapText(ctx, text, maxWidth) {
  return text.split(/\r?\n/).flatMap((line) => wrapLine(ctx, line, maxWidth));
}

/**
 * Black outline under light text, white under dark text. The point of the
 * outlined style is legibility on a photo you don't control, and a black stroke
 * around black text achieves nothing.
 */
export function outlineColour(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const luma = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  return luma > 0.55 ? '#000000' : '#ffffff';
}
