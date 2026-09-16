import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
test('social crawlers receive a public image and matching dimensions without JavaScript', () => {
  const doc = new JSDOM(readFileSync('index.html','utf8')).window.document;
  const meta = property => doc.querySelector(`meta[property="${property}"]`)?.content;
  assert.equal(meta('og:url'), 'https://unilab.ztvmm.live/');
  assert.equal(doc.querySelector('link[rel=canonical]').href, meta('og:url'));
  const image = new URL(meta('og:image'));
  assert.equal(image.origin, 'https://unilab.ztvmm.live');
  assert.equal(doc.querySelector('meta[name="twitter:image"]').content, image.href);
  const png = readFileSync('public' + image.pathname);
  assert.equal(png.subarray(1,4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), Number(meta('og:image:width')));
  assert.equal(png.readUInt32BE(20), Number(meta('og:image:height')));
  assert.ok(png.length < 300_000);
  assert.ok(meta('og:image:alt').length > 20);
});
