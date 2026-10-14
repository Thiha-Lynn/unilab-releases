import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {JSDOM} from 'jsdom';
import {compileBook,webBook,epubBook,BOOK_LIMIT} from '../src/book.js';
test('book escapes hostile content and never fetches image references',()=>{
 const b=compileBook('# မြန်မာစာ\n<script>alert(1)</script>\n\n![x](https://example.com/private.png)\n\n[bad](javascript:alert(1))','</title><script>evil</script>');
 const d=new JSDOM(webBook(b)).window.document;
 assert.equal(d.querySelectorAll('script').length,1);assert.equal(d.querySelectorAll('img').length,0);assert.equal(d.querySelectorAll('[href^="javascript:"]').length,0);
 assert.ok(d.querySelector('article').textContent.includes('<script>alert(1)</script>'));assert.equal(b.images,1);assert.equal(b.headings[0].title,'မြန်မာစာ');
});
test('EPUB has stored first mimetype, valid XML, navigation and embedded font',async()=>{
 const b=compileBook('# One\n\nHello & goodbye.\n\n```js\nconsole.log("x")\n```\n\n## Two','A & B','Author');
 const bytes=await epubBook(b,[{family:'UniLabMyanmar',bytes:new Uint8Array([1,2,3])}]);
 const zip=await JSZip.loadAsync(bytes);assert.equal(await zip.file('mimetype').async('string'),'application/epub+zip');assert.equal(new DataView(bytes.buffer).getUint16(8,true),0);
 for(const path of ['META-INF/container.xml','OEBPS/package.opf','OEBPS/nav.xhtml','OEBPS/book.xhtml']){const xml=await zip.file(path).async('string');const doc=new JSDOM(xml,{contentType:'application/xml'}).window.document;assert.ok(doc.documentElement);}
 assert.ok(zip.file('OEBPS/font-0.ttf'));assert.match(await zip.file('OEBPS/book.xhtml').async('string'),/token/);
});
test('empty and oversized books receive clear limits',()=>{assert.throws(()=>compileBook(' '),/Paste/);assert.throws(()=>compileBook('a'.repeat(BOOK_LIMIT+1)),/512 KB/)});
