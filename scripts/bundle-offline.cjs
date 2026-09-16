const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lock = require('../offline/assets.lock.json');
async function main() {
  const root = path.resolve('web/offline');
  fs.mkdirSync(root, {recursive:true});
  for (let i=0;i<lock.files.length;i+=4) await Promise.all(lock.files.slice(i,i+4).map(async item=>{
    if (!/^[a-zA-Z0-9_./-]+$/.test(item.path) || item.path.split('/').includes('..')) throw Error('Invalid asset path');
    const dest=path.join(root,item.path);
    const good=bytes=>bytes.length===item.bytes && crypto.createHash('sha256').update(bytes).digest('hex')===item.sha256;
    if(fs.existsSync(dest)&&good(fs.readFileSync(dest)))return;
    const res=await fetch(item.url,{signal:AbortSignal.timeout(120000)});
    if(!res.ok)throw Error('Offline asset request failed: '+res.status);
    const bytes=Buffer.from(await res.arrayBuffer());
    if(!good(bytes))throw Error('Offline asset integrity failure: '+item.path);
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);
  }));
  fs.copyFileSync('offline/background-resources.json',path.join(root,'background/resources.json'));
  fs.mkdirSync(path.join(root,'ocr/core'),{recursive:true});
  fs.copyFileSync('app/node_modules/tesseract.js/dist/worker.min.js',path.join(root,'ocr/worker.min.js'));
  // Six embedded-WASM variants cover SIMD and auto-rotation on supported devices.
  for(const file of fs.readdirSync('app/node_modules/tesseract.js-core').filter(f=>f.endsWith('.wasm.js')))
    fs.copyFileSync('app/node_modules/tesseract.js-core/'+file,path.join(root,'ocr/core',file));
  fs.writeFileSync('web/offline-config.js','globalThis.__UNILAB_OFFLINE__ = true;\n');
  fs.copyFileSync('offline/assets.lock.json','web/offline/assets.lock.json');
  require('./licenses.cjs');
  const {writeManifests}=await import('../app/scripts/build-manifest.js');
  const release=JSON.parse(fs.readFileSync('web/release.json'));
  writeManifests('web',release.revision);
  console.log(`Bundled and verified ${lock.files.length} pinned model/language assets plus OCR worker and WASM cores.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
