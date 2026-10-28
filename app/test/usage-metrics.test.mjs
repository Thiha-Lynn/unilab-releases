import test from 'node:test';import assert from 'node:assert/strict';
import {dailyVisitor,processingChunks,VISITOR_KEY} from '../src/usage-metrics.js';
import {payload} from '../src/usage.js';
const env={tool:'merge-pdf',platform:'web',version:'0.4.1',session:'a'.repeat(32)};
test('daily visitor is shared across tabs, rotates at UTC midnight and fails closed without storage',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 const a=dailyVisitor(storage,Date.parse('2026-10-28T10:00Z'));
 assert.match(a,/^[a-f0-9]{32}$/);assert.equal(dailyVisitor(storage,Date.parse('2026-10-28T23:59Z')),a);
 assert.notEqual(dailyVisitor(storage,Date.parse('2026-10-29T00:00Z')),a);
 assert.equal(map.size,1);assert.ok(map.has(VISITOR_KEY));
 assert.equal(dailyVisitor({getItem(){throw Error('blocked')},setItem(){} }),null);
});
test('successful file payload contains only bounded numeric counts and a receipt',()=>{
 const details={count:3,eventId:'b'.repeat(32),filename:'SECRET.pdf',contents:'PRIVATE'};
 assert.deepEqual(payload('files_processed',details,env),{event:'files_processed',...env,count:3,eventId:details.eventId});
 assert.equal(payload('files_processed',{count:0,eventId:details.eventId},env),null);
 assert.equal(payload('files_processed',{count:3},env),null);
 assert.deepEqual(processingChunks(2003),[1000,1000,3]);assert.deepEqual(processingChunks(0),[]);
});
