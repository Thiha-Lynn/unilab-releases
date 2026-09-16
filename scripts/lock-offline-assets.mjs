// Maintainer-only refresh: reviewed, versioned upstream program/model assets.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base='https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const response=await fetch(base+'resources.json');
if(!response.ok)throw Error('Cannot read versioned background metadata');
const metadata=await response.json();
const selected=Object.fromEntries(Object.entries(metadata).filter(([key])=>key.startsWith('/onnxruntime-web/')||key==='/models/isnet_quint8'));
writeFileSync('offline/background-resources.json',JSON.stringify(selected,null,2)+'\n');
const files=Object.values(selected).flatMap(entry=>entry.chunks.map(c=>({path:'background/'+c.name,url:base+c.name,sha256:c.hash,bytes:c.offsets[1]-c.offsets[0]})));
const langs=['tha','eng','mya','chi_sim','chi_tra','jpn','kor','lao','khm','vie','msa','ind','hin','ara','rus','fra','deu','spa','por'];
for(let i=0;i<langs.length;i+=3) {
 await Promise.all(langs.slice(i,i+3).map(async lang=>{
  const pkg=await (await fetch('https://registry.npmjs.org/@tesseract.js-data%2f'+lang+'/latest')).json();
  if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw Error('Invalid data package version');
  const url=`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@${pkg.version}/4.0.0_best_int/${lang}.traineddata.gz`;
  const response=await fetch(url);if(!response.ok)throw Error(url+': '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  files.push({path:`ocr/lang/${lang}.traineddata.gz`,url,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  console.log(lang,bytes.length);
 }));
}
files.sort((a,b)=>a.path.localeCompare(b.path));
writeFileSync('offline/assets.lock.json',JSON.stringify({version:1,files},null,2)+'\n');
console.log('Locked',files.length,'assets;',files.reduce((s,f)=>s+f.bytes,0),'bytes');
