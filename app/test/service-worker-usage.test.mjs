import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
test('online dashboard and explicit no-store requests bypass the offline cache', async () => {
 const handlers={};let cached=0;const cachedResponse={ok:true};
 const context=vm.createContext({URL,console,self:{location:{origin:'https://unilab.ztvmm.live'},addEventListener:(event,fn)=>handlers[event]=fn},caches:{match:async()=>{cached++;return cachedResponse}}});
 vm.runInContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
 for(const [path,cache] of [['/usage/','default'],['/usage/data.json','default'],['/usage/daily.csv','default'],['/release.json','no-store']]) {
  let intercepted=false;handlers.fetch({request:{method:'GET',url:'https://unilab.ztvmm.live'+path,cache},respondWith:()=>intercepted=true});assert.equal(intercepted,false,path);
 }
 let response;handlers.fetch({request:{method:'GET',url:'https://unilab.ztvmm.live/assets/example.js',cache:'default'},respondWith:p=>response=p});assert.equal(await response,cachedResponse);assert.equal(cached,1);
});
