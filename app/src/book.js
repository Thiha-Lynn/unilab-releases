// Browser-native implementation. Markdown is content, never executable HTML.
import MarkdownIt from 'markdown-it';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-python.js';
import JSZip from 'jszip';
import fontLicense from './book-font-license.js';

export const BOOK_LIMIT = 512 * 1024;
export const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const md = new MarkdownIt({html:false, xhtmlOut:true, linkify:false, highlight(code, language) {
  const aliases = {js:'javascript',ts:'javascript',sh:'bash',shell:'bash',terminal:'bash',html:'markup',xml:'markup',py:'python'};
  const lang = aliases[language] || language;
  return Prism.languages[lang] ? Prism.highlight(code, Prism.languages[lang], lang) : escape(code);
}});
// Local text editions deliberately do not fetch remote or filesystem images.
md.renderer.rules.image = (tokens, idx) => `<span class="image-note">[Image: ${escape(tokens[idx].content || 'not embedded')}]</span>`;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('rel','noreferrer noopener');
  return self.renderToken(tokens, idx, options);
};
export function compileBook(source, title = 'My book', author = '') {
  if (!source.trim()) throw new Error('Paste Markdown or select a .md file first.');
  if (new TextEncoder().encode(source).length > BOOK_LIMIT) throw new Error('Choose Markdown up to 512 KB. Split longer manuscripts into volumes.');
  const tokens = md.parse(source, {}), headings = [];
  for (let i=0; i<tokens.length; i++) {
    if (tokens[i].type === 'heading_open') {
      const id = `section-${headings.length+1}`;
      tokens[i].attrSet('id',id);
      headings.push({id, title:tokens[i+1].content, level:Number(tokens[i].tag.slice(1))});
    }
  }
  return {title:title.trim().slice(0,200)||'My book', author:author.trim().slice(0,200), html:md.renderer.render(tokens,md.options,{}), headings, images:tokens.reduce((n,t)=>n+(t.children||[]).filter(c=>c.type==='image').length,0)};
}
export const bookCSS = `
*{box-sizing:border-box}body{margin:0;color:#27251f;background:#faf7ee;font-family:Georgia,UniLabMyanmar,UniLabThai,serif;line-height:1.75;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4;break-after:avoid}h1{font-size:2em}h2{font-size:1.5em}p,li{orphans:3;widows:3}a{color:#245f5a}pre{background:#22262b;color:#f3f3ec;padding:16px;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 monospace,UniLabMyanmar;break-inside:avoid}pre::before{content:'● ● ●';display:block;color:#bcaa79;margin-bottom:8px;font-size:10px}code{font-family:monospace,UniLabMyanmar}blockquote{border-left:3px solid #ad9971;margin-left:0;padding-left:20px;color:#655e50}table{border-collapse:collapse;width:100%;font-size:.9em}td,th{border:1px solid #cfc7b6;padding:7px}img{max-width:100%}.image-note{color:#725b48;font-style:italic}.token.comment{color:#a4b1b4}.token.keyword,.token.boolean{color:#e9a7cb}.token.string{color:#b6db98}.token.function{color:#97c8f0}.token.number{color:#f3c27e}.cover{text-align:center;padding:70px 0;border-bottom:1px solid #cfc7b6;margin-bottom:40px}.cover small{letter-spacing:.15em}nav ol{padding-left:25px}mark{background:#ffe49a}
`;
export function bookBody(book) {
  return `<header class="cover"><small>PERSONAL EDITION</small><h1>${escape(book.title)}</h1><p>${escape(book.author)}</p></header><nav aria-label="Contents"><h2>Contents</h2><ol>${book.headings.map(h=>`<li><a href="#${h.id}">${escape(h.title)}</a></li>`).join('')}</ol></nav><article>${book.html}</article>`;
}
export function webBook(book, fonts='') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(book.title)}</title><style>${fonts}${bookCSS}
body{background:#d9d2c5}#controls{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;padding:12px;background:#272c2a;color:#fff;font:14px system-ui}button,input,select{font:inherit;padding:8px;border:1px solid #aaa;border-radius:5px}button{cursor:pointer}button:disabled{opacity:.4}#book{margin:24px auto;background:#faf7ee;box-shadow:0 12px 40px #302c2940;max-width:1100px;padding:32px;position:relative}#window{overflow:hidden}#pages{height:65vh;min-height:350px;column-count:2;column-gap:64px;column-fill:auto;transition:transform .25s}#pages>*{margin-top:0}#position{min-width:100px;text-align:center}#help{font:13px system-ui;text-align:center;padding:0 12px 20px}#book:after{content:'';pointer-events:none;position:absolute;top:0;bottom:0;left:50%;width:1px;background:#a79b7755;box-shadow:0 0 20px 5px #65523820}#found{font:13px system-ui}body.reading #pages{height:auto;min-height:0;columns:1;transform:none!important}body.reading #book:after{display:none}@media(max-width:700px){#book{margin:12px;padding:24px}#pages{column-count:1;column-gap:48px}#book:after{display:none}}@media(prefers-reduced-motion:reduce){#pages{transition:none}}@media print{body{background:white}#controls,#help{display:none}#book{box-shadow:none;margin:0;padding:0;max-width:none}#book:after{display:none}#pages{height:auto;columns:1;transform:none!important}#window{overflow:visible}@page{size:A5;margin:16mm}}
</style></head><body><template id="font-license">${escape(fontLicense)}</template><div id="controls"><button id="prev" aria-label="Previous pages">← Previous</button><span id="position" aria-live="polite"></span><button id="next">Next →</button><label>Text <select id="size"><option value="16">Normal</option><option value="19">Large</option><option value="22">Extra large</option></select></label><button id="mode">Continuous reading</button><label>Find <input id="search" type="search" size="12" maxlength="100"></label><span id="found" aria-live="polite"></span><button id="print">Print / PDF</button></div><main id="book"><div id="window"><div id="pages">${bookBody(book)}</div></div></main><p id="help">Use the arrow keys to turn pages. Contents links jump to a section. No internet connection is needed. Print / PDF offers selectable text.</p>
<script>
const pages=document.getElementById('pages'),viewport=document.getElementById('window');let page=0,total=1,continuous=false;
function layout(){pages.style.transform='none';const gap=parseFloat(getComputedStyle(pages).columnGap)||0;total=Math.max(1,Math.ceil((pages.scrollWidth+gap)/(viewport.clientWidth+gap)));page=Math.max(0,Math.min(page,total-1));pages.style.transform=continuous?'none':'translateX(-'+page*(viewport.clientWidth+gap)+'px)';document.getElementById('position').textContent=continuous?'Reading':(page+1)+' / '+total;document.getElementById('prev').disabled=continuous||page===0;document.getElementById('next').disabled=continuous||page===total-1}
document.getElementById('prev').onclick=()=>{page--;layout()};document.getElementById('next').onclick=()=>{page++;layout()};document.getElementById('size').onchange=e=>{pages.style.fontSize=e.target.value+'px';page=0;layout()};document.getElementById('mode').onclick=e=>{continuous=!continuous;document.body.classList.toggle('reading',continuous);e.target.textContent=continuous?'Book pages':'Continuous reading';page=0;layout()};document.getElementById('print').onclick=()=>print();
function reveal(target){if(continuous){target.scrollIntoView({block:'center'});return}pages.style.transform='none';const offset=target.getBoundingClientRect().left-pages.getBoundingClientRect().left;page=Math.floor(offset/(viewport.clientWidth+(parseFloat(getComputedStyle(pages).columnGap)||0)));layout()}
pages.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&a.getAttribute('href').startsWith('#')){const target=document.getElementById(a.getAttribute('href').slice(1));if(target){e.preventDefault();reveal(target)}}});
document.getElementById('search').oninput=e=>{const q=e.target.value.trim().toLocaleLowerCase();const matches=q?[...pages.querySelectorAll('article p,article li,article h1,article h2,article h3,article pre')].filter(n=>n.textContent.toLocaleLowerCase().includes(q)):[];document.getElementById('found').textContent=q?(matches.length+' matching blocks'):'';if(matches[0])reveal(matches[0])};
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key==='ArrowRight'){page++;layout()}if(e.key==='ArrowLeft'){page--;layout()}});new ResizeObserver(layout).observe(viewport);document.fonts.ready.then(layout);
</script></body></html>`;
}
export async function epubBook(book, fontFiles=[]) {
  const zip=new JSZip();
  zip.file('mimetype','application/epub+zip',{compression:'STORE'});
  zip.file('META-INF/font-license.txt',fontLicense);
  zip.file('META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const fonts=fontFiles.map((f,i)=>{zip.file(`OEBPS/font-${i}.ttf`,f.bytes);return `@font-face{font-family:${f.family};src:url(font-${i}.ttf)}`}).join('');
  zip.file('OEBPS/book.css',fonts+bookCSS);
  const xhtml=body=>`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><title>${escape(book.title)}</title><link rel="stylesheet" type="text/css" href="book.css"/></head><body>${body}</body></html>`;
  zip.file('OEBPS/book.xhtml',xhtml(bookBody(book)));
  zip.file('OEBPS/nav.xhtml',xhtml(`<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="book.xhtml">${escape(book.title)}</a></li>${book.headings.map(h=>`<li><a href="book.xhtml#${h.id}">${escape(h.title)}</a></li>`).join('')}</ol></nav>`));
  const id=crypto.randomUUID(),modified=new Date().toISOString().replace(/\.\d+Z$/,'Z');
  zip.file('OEBPS/package.opf',`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${id}</dc:identifier><dc:title>${escape(book.title)}</dc:title><dc:creator>${escape(book.author)}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="book.css" media-type="text/css"/>${fontFiles.map((_,i)=>`<item id="font${i}" href="font-${i}.ttf" media-type="font/ttf"/>`).join('')}</manifest><spine><itemref idref="book"/></spine></package>`);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',mimeType:'application/epub+zip'});
}
