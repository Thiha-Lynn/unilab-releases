import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { prepareHtml, documentSource, localCss, pageSlices } from '../src/html-document.js';

const win = new JSDOM('').window;
test('lecture conversion retains every slide, text, styling and SVG diagram', () => {
  const source = '<html><head><title>Lecture</title><style>.slide{color:#123456}</style></head><body><section class="slide active"><h1>First</h1><svg><rect width="20" height="20"/></svg></section><section class="slide"><p>สวัสดี ရွဲ့</p></section></body></html>';
  const prepared = prepareHtml(source, win);
  assert.equal(prepared.slideCount, 2);
  assert.match(prepared.html, /สวัสดี ရွဲ့/);
  assert.match(prepared.html, /<svg>/);
  assert.match(prepared.html, /#123456/);
  assert.equal(prepared.title, 'Lecture');
});
test('lecture scripts, forms and external resources are removed', () => {
  const prepared = prepareHtml('<html><head><link rel="stylesheet" href="https://example.com/a.css"></head><body><script>document.title="changed"</script><form><input></form><img src="https://example.com/photo.png" alt="Photo"><a href="https://example.com/">Reference</a><p style="background:url(https://example.com/background.png)">Keep me</p></body></html>', win);
  const doc = new JSDOM(prepared.html).window.document;
  assert.equal(doc.querySelector('script,form,input,link'), null);
  assert.equal(doc.querySelector('img').getAttribute('src'), null);
  assert.equal(prepared.missing, 1);
  assert.match(doc.body.textContent, /Keep me/);
  assert.doesNotMatch(prepared.html, /https:\/\//);
  assert.ok(documentSource(prepared).indexOf('Content-Security-Policy') < documentSource(prepared).indexOf('<style>'));
});
test('CSS network references are removed while local SVG paint references remain', () => {
  const css = localCss('@import "https://example.com/a.css";a{fill:url(#gradient);background:url(https://example.com/bg.png)}');
  assert.doesNotMatch(css, /example.com|@import/);
  assert.match(css, /#gradient/);
});
test('pagination covers all content without gaps and prefers a block boundary', () => {
  const pages = pageSlices(2800, 1000, [950, 1890]);
  assert.deepEqual(pages, [{top:0,height:950},{top:950,height:940},{top:1890,height:910}]);
  assert.equal(pages.reduce((s,p)=>s+p.height,0),2800);
  assert.throws(()=>pageSlices(200000,1000),/exceeds/);
});

test('CSS theme variables and their fallback values survive sanitization', () => {
  const css = localCss(':root{--paper:#faf7f0;--ink:rgb(20,30,40);--space:1.5rem}.slide{background:var(--paper);color:var(--ink,#123)}');
  assert.match(css, /--paper:#faf7f0/);
  assert.match(css, /--ink:rgb\(20,30,40\)/);
  assert.match(css, /var\(--paper\)/);
});
