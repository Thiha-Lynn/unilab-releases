const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const lock = require('../source-lock.json');
const pkg = require('../package.json');
const source = path.resolve(process.argv[2] || 'source');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== lock.revision || require(path.join(source, 'package.json')).version !== pkg.version) throw new Error('Source revision/version differs from source-lock.json');
const dist = path.join(source, 'dist');
const release = JSON.parse(fs.readFileSync(path.join(dist, 'release.json')));
if (release.revision !== revision) throw new Error('Built web revision differs from checked out source');
for (const [file, hash] of Object.entries(release.files)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex') !== hash) throw new Error('Asset hash mismatch: ' + file);
}
fs.rmSync('web', { recursive: true, force: true });
fs.cpSync(dist, 'web', { recursive: true });
fs.copyFileSync(path.join(source, 'LICENSE'), 'web/LICENSE');
console.log(`Packaged ${Object.keys(release.files).length} verified assets from ${revision}`);
