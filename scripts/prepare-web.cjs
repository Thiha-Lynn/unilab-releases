const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const provenance = require('../source-provenance.json');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
for (const directory of ['app','mobile']) if (require('../'+directory+'/package.json').version !== pkg.version) throw Error('Version mismatch: '+directory);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v'+pkg.version) throw Error('Tag/version mismatch');
const dist = path.resolve('app/dist');
const release = JSON.parse(fs.readFileSync(path.join(dist,'release.json')));
if (release.revision !== revision) throw Error('Built web revision differs from checked-out product source');
for (const [file,hash] of Object.entries(release.files)) {
 if (crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,file))).digest('hex') !== hash) throw Error('Asset hash mismatch: '+file);
}
fs.rmSync('web',{recursive:true,force:true});
fs.cpSync(dist,'web',{recursive:true});
fs.copyFileSync('LICENSE','web/LICENSE');
fs.copyFileSync('LICENSE-MIT','web/LICENSE-MIT');
fs.writeFileSync('web/source-lock.json',JSON.stringify({...provenance,revision,version:pkg.version},null,2)+'\n');
console.log(`Prepared ${Object.keys(release.files).length} verified product assets from ${revision}`);
