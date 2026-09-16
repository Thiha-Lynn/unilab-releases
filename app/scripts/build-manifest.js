import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const OFFLINE_BUDGET = 8_000_000;
export const optionalAsset = (name) => /^(?:offline\/|licenses\/|assets\/(?:ort[.-]|remove-background-))/.test(name);
export function writeManifests(dir, revision) {
  const walk = (base, prefix='') => readdirSync(base,{withFileTypes:true}).flatMap(d => d.isDirectory() ? walk(join(base,d.name),`${prefix}${d.name}/`) : [`${prefix}${d.name}`]);
  const files = walk(dir).filter(f => !['precache.json','release.json','offline-info.json'].includes(f) && !f.endsWith('.DS_Store')).sort();
  const core = files.filter(f => f !== 'sw.js' && !optionalAsset(f));
  const bytes = core.reduce((n,f)=>n+statSync(join(dir,f)).size,0);
  if (bytes > OFFLINE_BUDGET) throw new Error(`Offline core ${bytes} bytes exceeds ${OFFLINE_BUDGET}-byte budget.`);
  writeFileSync(join(dir,'precache.json'),JSON.stringify(['./',...core.map(f=>'./'+f)],null,2));
  writeFileSync(join(dir,'offline-info.json'),JSON.stringify({bytes,budget:OFFLINE_BUDGET,optional:['Background removal engine/model','OCR engine/language packs']},null,2));
  const hashes = Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(dir,f))).digest('hex')]));
  writeFileSync(join(dir,'release.json'),JSON.stringify({revision,builtAt:new Date().toISOString(),offlineBytes:bytes,files:hashes},null,2));
  return {bytes,count:core.length};
}
