import { el, downloadBlob, errorBox } from '../ui.js';
import { compileBook, webBook, epubBook, bookBody, bookCSS, BOOK_LIMIT, escape } from '../book.js';
import { PDFDocument } from 'pdf-lib';
import { toCanvas } from 'html-to-image';
import { pageSlices } from '../html-document.js';
import { track, processedFiles } from '../usage.js';

const SAMPLE = '# Welcome to your book\n\nTurn your notes into something worth reading. **Markdown** keeps your writing simple.\n\n## မြန်မာစာ / Burmese\n\nမင်္ဂလာပါ။ သင်၏စာအုပ်ကို အင်တာနက်မလိုဘဲ ဖတ်ရှုနိုင်ပါသည်။\n\n## A little code\n\n```javascript\nconst message = "Hello, reader!";\nconsole.log(message);\n```\n\n## Terminal\n\n```bash\nnpm install\nnpm run build\n```\n\n## Next steps\n\n- Write your first chapter\n- Preview the book\n- Export PDF, EPUB or a web book\n';
let cachedFonts;
async function fonts() {
  cachedFonts ||= Promise.all([['UniLabMyanmar','NotoSansMyanmar-Regular.ttf'],['UniLabThai','NotoSansThai-Regular.ttf']].map(async ([family,name])=>{
    const r=await fetch(`${import.meta.env.BASE_URL}fonts/${name}`);
    if(!r.ok)throw Error('The bundled fonts could not load. Reload the app and try again.');
    const blob=await r.blob(), bytes=await blob.arrayBuffer();
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)});
    return {family,bytes,css:`@font-face{font-family:${family};src:url(${data}) format('truetype')}`};
  })).catch(e=>{cachedFonts=null;throw e});
  return cachedFonts;
}
export default function render(container) {
  let disposed=false, revision=0, fileSource=false;
  const panel=el(`<div class="panel"><div class="form-grid"><label>Book title<input class="input" data-title value="My first book" maxlength="200"></label><label>Author (optional)<input class="input" data-author maxlength="200"></label></div><p><label class="btn secondary">Open Markdown <input type="file" data-file accept=".md,.markdown,text/markdown,text/plain" style="max-width:220px"></label> <button class="btn secondary" data-example>Load example</button></p><label>Manuscript<textarea class="input" data-source rows="12" spellcheck="false" placeholder="# Chapter one"></textarea></label><p class="hint">Up to 512 KB. Burmese and Thai fonts travel with your exports. HTML is shown as text; image references become captions and are never fetched. PDF download preserves appearance as page images; Print / PDF in the web book offers selectable text.</p><div class="actions"><button class="btn" data-preview>Preview book</button><button class="btn secondary" data-pdf>Download PDF</button><button class="btn secondary" data-epub>Download EPUB</button><button class="btn secondary" data-web>Download web book</button></div><p data-status role="status" aria-live="polite">Paste your Markdown, open a file, or load the example.</p><div data-error></div><iframe data-reader title="Book preview" sandbox="allow-scripts allow-modals" referrerpolicy="no-referrer" style="width:100%;height:680px;border:1px solid #cfc7b6;border-radius:12px" hidden></iframe></div>`);
  container.append(panel);
  const $=s=>panel.querySelector(s),status=$('[data-status]'),reader=$('[data-reader]');
  const name=()=>($('[data-title]').value.trim()||'my-book').replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,100);
  const book=()=>compileBook($('[data-source]').value,$('[data-title]').value,$('[data-author]').value);
  async function run(kind) {
    $('[data-error]').replaceChildren();const gen=++revision;
    panel.querySelectorAll('button').forEach(b=>b.disabled=true);
    status.textContent='Preparing your book…';track('job_started');
    try {
      const b=book(), ff=await fonts(), css=ff.map(f=>f.css).join('');
      if(disposed||gen!==revision)return;
      if(kind==='preview'){reader.srcdoc=webBook(b,css);reader.hidden=false;}
      if(kind==='web')downloadBlob(new Blob([webBook(b,css)],{type:'text/html'}),`${name()}.html`);
      if(kind==='epub'){const bytes=await epubBook(b,ff);if(!disposed)downloadBlob(new Blob([bytes],{type:'application/epub+zip'}),`${name()}.epub`);}
      if(kind==='pdf')await pdf(b,css);
      if(disposed)return;
      status.textContent=`${kind==='preview'?'Preview ready.':'Export prepared.'} ${b.headings.length} headings.${b.images?' Image references are captions in this text edition.':''}`;
      if(kind!=='preview'){track('job_completed');if(fileSource)processedFiles(1,'markdown-book');}
    }catch(e){if(!disposed){errorBox($('[data-error]'),e.message);status.textContent='Please check the message and try again.';track('job_failed');}}
    finally{if(!disposed)panel.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  for(const kind of ['preview','pdf','epub','web'])$(`[data-${kind}]`).onclick=()=>run(kind);
  $('[data-example]').onclick=()=>{fileSource=false;$('[data-source]').value=SAMPLE;run('preview')};
  $('[data-file]').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>BOOK_LIMIT)throw Error('Choose Markdown up to 512 KB.');fileSource=true;$('[data-source]').value=await f.text();track('files_selected',{count:1});await run('preview')}catch(err){errorBox($('[data-error]'),err.message)}finally{e.target.value=''}};
  async function pdf(b,css) {
    const frame=document.createElement('iframe');frame.title='PDF rendering surface';frame.setAttribute('sandbox','allow-same-origin');frame.style.cssText='position:fixed;left:-10000px;top:0;width:680px;height:900px;border:0';
    const loaded=new Promise(resolve=>frame.onload=resolve);
    frame.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><style>${css}${bookCSS}body{background:#fff;width:680px;padding:32px;font-size:18px}</style><title>${escape(b.title)}</title></head><body>${bookBody(b)}</body></html>`;
    document.body.append(frame);
    try {
      await loaded;await frame.contentDocument.fonts.ready;
      const node=frame.contentDocument.body;
      const boundaries=[...node.querySelectorAll('p,li,pre,h1,h2,h3,tr')].map(n=>Math.ceil(n.getBoundingClientRect().bottom));
      const pages=pageSlices(node.scrollHeight,900,boundaries),doc=await PDFDocument.create();doc.setTitle(b.title);doc.setAuthor(b.author);doc.setCreator('UniLab Markdown Book');
      for(let i=0;i<pages.length;i++){
        if(disposed)throw Error('Export canceled.');status.textContent=`Rendering PDF page ${i+1} of ${pages.length}…`;
        const p=pages[i],canvas=await toCanvas(node,{width:680,height:p.height,pixelRatio:1.5,fontEmbedCSS:css,backgroundColor:'#fff',style:{transform:`translateY(-${p.top}px)`,height:node.scrollHeight+'px'}});
        const jpg=await doc.embedJpg(canvas.toDataURL('image/jpeg',.94)),page=doc.addPage([419.53,595.28]);
        page.drawImage(jpg,{x:18,y:595.28-18-p.height*383.53/680,width:383.53,height:p.height*383.53/680});canvas.width=canvas.height=0;
      }
      if(!disposed)downloadBlob(new Blob([await doc.save()],{type:'application/pdf'}),`${name()}.pdf`);
    }finally{frame.remove();}
  }
  window.addEventListener('hashchange',()=>{disposed=true;revision++;reader.srcdoc='';$('[data-source]').value='';},{once:true});
}
