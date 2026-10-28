import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {toolShell} from '../src/tool-shell.js';import {setUsageEnabled,track} from '../src/usage.js';
import {VISITOR_KEY} from '../src/usage-metrics.js';
const pause=()=>new Promise(r=>setTimeout(r,15));
test('processing counts successful input occurrences once, excludes failures and respects opt-out',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'https://unilab.ztvmm.live/#/merge-pdf'}),win=dom.window,events=[];
 const globals={window:win,document:win.document,location:win.location,localStorage:win.localStorage,sessionStorage:win.sessionStorage,navigator:win.navigator,__APP_VERSION__:'0.4.1',fetch:async(url,options)=>{events.push(JSON.parse(options.body));return {ok:true}}};
 const descriptors=new Map(Object.keys(globals).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const [k,v] of Object.entries(globals))Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
 win.scrollTo=()=>{};
 let fail=false;
 try {
  const ctx=toolShell(document.querySelector('#app'),{id:'merge-pdf',name:'Merge PDF'},{multiple:true,run:async()=>{if(fail)throw Error('fixture failure');return {outputs:[{name:'result.pdf',blob:new Blob(['fixture'])}]}}});
  ctx.files.push(new win.File(['1'],'one.pdf'),new win.File(['2'],'two.pdf'),new win.File(['3'],'three.pdf'));ctx.refresh();
  document.querySelector('.ts__go').click();await pause();
  assert.deepEqual(events.filter(e=>e.event==='files_processed').map(e=>e.count),[3]);
  assert.match(events.find(e=>e.event==='files_processed').visitor,/^[a-f0-9]{32}$/);
  await pause();assert.equal(events.filter(e=>e.event==='files_processed').length,1);
  ctx.stage('work');fail=true;document.querySelector('.ts__go').click();await pause();assert.equal(events.filter(e=>e.event==='files_processed').length,1);
  fail=false;document.querySelector('.ts__go').click();await pause();assert.deepEqual(events.filter(e=>e.event==='files_processed').map(e=>e.count),[3,3]);
  assert.notEqual(events[0].eventId,events[1].eventId);
  setUsageEnabled(false);assert.equal(localStorage.getItem(VISITOR_KEY),null);const before=events.length;await track('tool_open');assert.equal(events.length,before);
 }finally{
  win.dispatchEvent(new win.Event('hashchange'));win.close();
  for(const [k,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];
 }
});
