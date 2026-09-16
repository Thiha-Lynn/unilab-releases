import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeManifests } from '../scripts/build-manifest.js';
test('offline budget excludes optional AI runtime and release hashes include service worker', () => {
  const dir=mkdtempSync(join(tmpdir(),'unilab-release-'));
  try {
    mkdirSync(join(dir,'assets'));
    writeFileSync(join(dir,'index.html'),'app');writeFileSync(join(dir,'sw.js'),'worker');
    writeFileSync(join(dir,'assets/ort-runtime.wasm'),Buffer.alloc(24_000_000));
    assert.equal(writeManifests(dir,'revision').bytes,3);
    const manifest=JSON.parse(readFileSync(join(dir,'precache.json')));
    assert.ok(!manifest.some(f=>f.includes('ort-runtime')));
    assert.ok(JSON.parse(readFileSync(join(dir,'release.json'))).files['sw.js']);
    writeFileSync(join(dir,'assets/core.js'),Buffer.alloc(8_000_000));
    assert.throws(()=>writeManifests(dir,'revision'),/exceeds/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
