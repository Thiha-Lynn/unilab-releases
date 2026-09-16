// NFR7 — "Text counting must be correct for Thai and Burmese, not only Latin."
//
// Threshold: 0 miscounts across a fixture of ≥ 20 strings whose grapheme count
// differs from a code-point count.
//
// The defect this guards against is invisible in English and lands hardest on
// the students most likely to hit it. `"ก".length` is 1, but `"กำ".length` is 2
// while that is one written character; `"ကျွန်တော်"` — Burmese for "I" — is nine
// code points. A counter tested only in Latin script reports numbers that are
// simply wrong for Thai and Burmese, and a character limit enforced on that
// count rejects work that was actually within it.
//
// **What this asserts, precisely:** a base character and its *non-spacing*
// combining marks — tone marks, vowel signs written above or below, the Burmese
// asat, ZWJ joins and skin-tone modifiers — count as one. It does **not** assert
// that a cluster equals a syllable a reader would point at: Unicode UAX #29 puts
// a *spacing* vowel like Thai เ or Burmese ာ in its own cluster, so "สวัสดี" is 4
// clusters and not 5. Every expected value below was derived from that rule, not
// from what looked right.
//
// The fixture is asserted to be adversarial: for every string, a code-point
// count gives a different answer. A fixture where both agree would pass against
// a broken implementation and prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemes } from '../src/tools/word-counter.js';

/** [string, expected grapheme clusters, what it is] */
const FIXTURES = [
  // ---- Thai: tone marks and above/below vowels are non-spacing ----
  ['กำ',        1, 'ko kai + sara am'],
  ['ก่',        1, 'ko kai + mai ek (tone)'],
  ['กิ',        1, 'ko kai + sara i (above)'],
  ['กี่',       1, 'base + vowel + tone, 3 code points'],
  ['น้ำ',       1, '"water" — base + tone + sara am'],
  ['ที่',       1, '"at" — base + vowel + tone'],
  ['ผู้',       1, '"person" — base + vowel below + tone'],
  ['ปั่น',      2, '"to blend"'],
  ['เก้า',      3, '"nine" — leading เ is spacing, so its own cluster'],
  ['สวัสดี',    4, 'the greeting — 6 code points, 4 clusters'],

  // ---- Burmese: medials, stacked consonants, asat ----
  ['ကို',       1, 'ka + medial + vowel'],
  ['မြန်',      2, 'medial ra + asat'],
  ['မြန်မာ',    4, '"Myanmar" — 6 code points'],
  ['ကျွန်တော်', 4, '"I" (male speaker) — 9 code points'],
  ['နိုင်ငံ',   3, '"country" — 7 code points'],
  ['သို့',      1, '"to" — 4 code points, one cluster'],

  // ---- Combining marks and emoji sequences ----
  ['é',   1, 'e + combining acute (decomposed)'],
  ['á̀', 1, 'a + two stacked combining marks'],
  ['👍🏽',        1, 'thumbs up + skin-tone modifier'],
  ['👨‍👩‍👧‍👦',  1, 'family — three ZWJ joins, 7 code points'],
  ['🇹🇭',        1, 'Thailand flag — regional indicator pair'],
  ['🧑🏻‍🎓',      1, 'student — skin tone + ZWJ'],
  ['👩🏾‍🚒',      1, 'firefighter — skin tone + ZWJ'],
];

test('the fixture is adversarial — a code-point count is wrong for every string', () => {
  const useless = FIXTURES
    .filter(([s, expected]) => [...s].length === expected)
    .map(([s, , what]) => `${what}: ${JSON.stringify(s)}`);
  assert.deepEqual(useless, [], 'a fixture both methods agree on would prove nothing');
  assert.ok(FIXTURES.length >= 20, `NFR7 requires ≥ 20 fixtures, have ${FIXTURES.length}`);
});

test('graphemes() counts combining marks as part of their base character', () => {
  const wrong = FIXTURES
    .filter(([s, expected]) => graphemes(s).length !== expected)
    .map(([s, expected, what]) => `${what}: ${JSON.stringify(s)} → ${graphemes(s).length}, expected ${expected}`);
  assert.deepEqual(wrong, [], 'NFR7 threshold is 0 miscounts');
});

test('String.length would fail this fixture — the requirement is not vacuous', () => {
  const miscounted = FIXTURES.filter(([s, expected]) => s.length !== expected).length;
  assert.equal(miscounted, FIXTURES.length,
    'every fixture must be one that a naive .length gets wrong');
});
