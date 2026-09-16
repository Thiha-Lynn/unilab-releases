import test from 'node:test';
import assert from 'node:assert/strict';
import {streamExport, EXPORT_CHUNK} from '../src/stream-export.js';
test('Android save transfers exact binary bytes in bounded chunks', async () => {
  const source = Uint8Array.from({length: EXPORT_CHUNK * 2 + 57}, (_,i)=>i%256);
  const parts = []; let finished = false;
  await streamExport({
    async begin({size,name}) { assert.equal(size,source.length); assert.equal(name,'notes.pdf'); return {id:'one'}; },
    async append({id,data}) { assert.equal(id,'one'); const part=Buffer.from(data,'base64'); assert.ok(part.length<=EXPORT_CHUNK); parts.push(part); },
    async finish({id}) { assert.equal(id,'one'); finished=true; },
    async cancel() { assert.fail('Successful save must not be cancelled'); },
  },new Blob([source]),'notes.pdf');
  assert.deepEqual(Buffer.concat(parts),Buffer.from(source)); assert.equal(finished,true);
});
test('failed native write aborts the incomplete export and never reports success', async () => {
  let cancelled=false;
  await assert.rejects(streamExport({async begin(){return{id:'one'};},async append(){throw Error('disk full');},async finish(){assert.fail();},async cancel({id}){cancelled=id==='one';}},new Blob(['notes']),'notes.txt'),/disk full/);
  assert.equal(cancelled,true);
});
test('cancelling the system picker does not create an export', async () => {
  await assert.rejects(streamExport({async begin(){throw Error('cancelled');},async append(){assert.fail();},async cancel(){assert.fail();}},new Blob(['notes']),'notes.txt'),/cancelled/);
});
