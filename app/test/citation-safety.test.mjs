import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildCitation } from '../src/tools/citation-generator.js';
test('citation fields remain literal text in generated and saved references',()=>{
  for (const type of ['website','book','journal']) for(const style of ['apa','mla']) {
    const attack='<img src=x onerror="alert(1)"><script>bad()</script>&';
    const fields=Object.fromEntries(['authors','year','title','site','url','publisher','journal','volume','issue','pages','doi'].map(k=>[k,attack]));
    const html=buildCitation(type,style,fields);
    const dom=new JSDOM('<div>'+html+'</div>');
    assert.equal(dom.window.document.querySelectorAll('img,script,[onerror]').length,0);
    assert.ok(dom.window.document.body.textContent.includes('<script>bad()</script>'));
  }
});
test('citation formatting keeps only intentional italic markup',()=>{
 const dom=new JSDOM(buildCitation('book','apa',{authors:'Example, Ada',year:'2026',title:'A & B',publisher:'Press'}));
 assert.equal(dom.window.document.querySelector('i').textContent,'A & B');
 assert.match(dom.window.document.body.textContent,/Example, A\./);
});
