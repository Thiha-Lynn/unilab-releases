import { el } from '../ui.js';

// Space-less scripts (Thai, Burmese, Khmer…) can't be counted by splitting on
// spaces, and stacked clusters like ရွဲ့ (1 visible character, 4 code points)
// can't be counted with .length — Intl.Segmenter handles both correctly.
const wordSeg = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;
const graphemeSeg = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

// Whitespace plus the invisible separators common in Myanmar/Khmer typing:
// zero-width space, zero-width (non-)joiner, BOM. A standalone ZWJ only ever
// matches here outside an emoji cluster — inside one it's part of the grapheme.
const SPACE_LIKE = /^[\s\u200B\u200C\u200D\uFEFF]+$/;

function countWords(text) {
  if (!text.trim()) return 0;
  if (wordSeg) {
    let n = 0;
    for (const seg of wordSeg.segment(text)) if (seg.isWordLike) n++;
    return n;
  }
  return text.trim().split(/\s+/).length;
}

// Exported so NFR7 can be tested directly. Thai sara am (ำ) and Burmese stacked
// consonants are single characters to a reader and several code points to
// String.length, which is the miscount this exists to prevent.
export function graphemes(text) {
  if (graphemeSeg) return [...graphemeSeg.segment(text)].map((s) => s.segment);
  return Array.from(text);
}

function countSentences(text) {
  // Latin enders need a following space/end; Myanmar ။ and Khmer ។ are
  // sentence marks on their own, with or without a trailing space.
  return (text.match(/[.!?…]+(?=\s|$)|[။។]/g) || []).length;
}

export default function render(container) {
  const panel = el(`
    <div class="panel">
      <textarea class="input" rows="12" placeholder="Paste or type your essay, report or post here… รองรับภาษาไทย / မြန်မာစာလည်းရပါတယ်" aria-label="Text to analyze"></textarea>
      <div class="big-stats">
        <div class="big-stat"><div class="v" data-words>0</div><div class="k">Words</div></div>
        <div class="big-stat"><div class="v" data-chars>0</div><div class="k">Characters</div></div>
        <div class="big-stat"><div class="v" data-nospace>0</div><div class="k">No spaces</div></div>
        <div class="big-stat"><div class="v" data-codepoints>0</div><div class="k">Code points</div></div>
        <div class="big-stat"><div class="v" data-sentences>0</div><div class="k">Sentences</div></div>
        <div class="big-stat"><div class="v" data-paragraphs>0</div><div class="k">Paragraphs</div></div>
        <div class="big-stat"><div class="v" data-reading>0 min</div><div class="k">Reading time</div></div>
        <div class="big-stat"><div class="v" data-speaking>0 min</div><div class="k">Speaking time</div></div>
      </div>
      <div data-combos hidden style="margin-top:16px">
        <h3 style="margin:0 0 8px;font-size:15px">🔎 Stacked character combos</h3>
        <p class="note" style="margin-top:0">These render as one character but are built from several code points — portals that count code points will "see" more characters than you do.</p>
        <div data-combolist style="display:flex;flex-wrap:wrap;gap:8px"></div>
      </div>
    </div>
  `);
  const ta = panel.querySelector('textarea');
  const set = (sel, v) => (panel.querySelector(sel).textContent = v);
  const mins = (words, wpm) => {
    if (!words) return '0 min';
    const m = words / wpm;
    return m < 1 ? '< 1 min' : `${Math.round(m)} min`;
  };

  function renderCombos(gs) {
    const combosHost = panel.querySelector('[data-combos]');
    const list = panel.querySelector('[data-combolist]');
    const seen = new Map();
    for (const g of gs) {
      const cps = [...g];
      if (cps.length > 1 && !SPACE_LIKE.test(g)) seen.set(g, cps);
    }
    combosHost.hidden = seen.size === 0;
    list.innerHTML = '';
    for (const [g, cps] of [...seen].slice(0, 24)) {
      const chip = el(`
        <span class="tagline" style="display:inline-flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:6px 12px;font-size:14px">
          <b style="font-size:20px"></b>
          <span style="color:var(--muted);font-size:12.5px"></span>
        </span>
      `);
      chip.querySelector('b').textContent = g;
      chip.querySelector('span').textContent = cps.join(' + ') + ` (${cps.length} code points)`;
      chip.title = cps.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
      list.appendChild(chip);
    }
    if (seen.size > 24) list.appendChild(el(`<span class="note">…and ${seen.size - 24} more</span>`));
  }

  function update() {
    const text = ta.value;
    const words = countWords(text);
    const gs = graphemes(text);
    set('[data-words]', words.toLocaleString());
    set('[data-chars]', gs.length.toLocaleString());
    set('[data-nospace]', gs.filter((g) => !SPACE_LIKE.test(g)).length.toLocaleString());
    set('[data-codepoints]', [...text].length.toLocaleString());
    set('[data-sentences]', countSentences(text).toLocaleString());
    set('[data-paragraphs]', text.trim() ? text.trim().split(/\n\s*\n+/).length : 0);
    set('[data-reading]', mins(words, 200));
    set('[data-speaking]', mins(words, 130));
    renderCombos(gs);
  }
  ta.addEventListener('input', update);

  container.appendChild(panel);
  container.appendChild(el(`<p class="note">“Characters” counts what you see: Burmese ရွဲ့ counts as 1 (not 4), Thai สวัสดี as 4 (not 6), 👨‍👩‍👧‍👦 as 1 (not 7). Zero-width spaces used in Myanmar text are treated as spaces, and ။ / ។ count as sentence ends. Everything stays in your browser — nothing is sent anywhere.</p>`));
}
