import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { resolve4 } from 'node:dns';
const base=process.argv[2], local=JSON.parse(readFileSync('dist/release.json'));
if (!base?.startsWith('https://')) throw new Error('Pass the HTTPS deployment URL');
// Query current DNS records directly; OS negative caches can outlive a new record.
// HTTPS still validates the URL hostname and the full certificate chain.
const lookup = (host, options, callback) => resolve4(host, (error, addresses) => {
  if (error) return callback(error);
  const records = addresses.map(address => ({address,family:4}));
  callback(null, options.all ? records : records[0].address, 4);
});
const readOnce = path => new Promise((resolve,reject) => {
  const request = get(`${base.replace(/\/$/,'')}/${path}`, {lookup,headers:{'Cache-Control':'no-cache'}}, response => {
    if(response.statusCode !== 200){response.resume();return reject(new Error(`${path}: HTTP ${response.statusCode}`));}
    const chunks=[];
    response.on('data',chunk=>chunks.push(chunk));
    response.on('error',reject);
    response.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({
      headers:{get:name=>response.headers[name.toLowerCase()]||null},
      arrayBuffer:async()=>bytes, json:async()=>JSON.parse(bytes.toString()),
    });});
  });
  request.setTimeout(30000,()=>request.destroy(new Error(`${path}: timeout`)));
  request.on('error',reject);
});
const read = async path => {
  for (let attempt=1; attempt<=3; attempt++) {
    try { return await readOnce(path); }
    catch (error) {
      const transient = ['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(error.code) || /timeout|HTTP 50[234]/.test(error.message);
      if (!transient || attempt===3) throw new Error(`${path}: ${error.message}`, {cause:error});
      await new Promise(resolve=>setTimeout(resolve,attempt*500));
    }
  }
};
const live=await (await read('release.json')).json();
if (live.revision!==local.revision) throw new Error('Live revision differs from the release being deployed');
const files=Object.entries(local.files);
for(let i=0;i<files.length;i+=6) await Promise.all(files.slice(i,i+6).map(async ([file,hash])=>{
  const response=await read(file),type=response.headers.get('content-type')||'';
  if (/\.m?js$/.test(file)&&!type.includes('javascript')) throw new Error(`${file}: incorrect MIME ${type}`);
  if (/\.wasm$/.test(file)&&!type.includes('wasm')) throw new Error(`${file}: incorrect MIME ${type}`);
  const actual=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if(actual!==hash) throw new Error(`${file}: live bytes differ from build`);
}));
const headers=await read('');
if(!/microphone=\(self\)/.test(headers.headers.get('permissions-policy')||'')) throw new Error('Microphone permissions policy is incorrect');
if(!/camera=\(self\)/.test(headers.headers.get('permissions-policy')||'')) throw new Error('Camera permissions policy is incorrect');
console.log(`Verified ${files.length} files, MIME types, permissions and release ${live.revision}`);
