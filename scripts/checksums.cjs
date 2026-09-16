const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');
const names = readdirSync('distribution').filter(n => !n.endsWith('.txt')).sort();
const expected = [`UniLab-${version}-web.zip`];
for (const arch of ['x64', 'arm64']) {
  for (const ext of ['dmg', 'zip']) expected.push(`UniLab-${version}-mac-${arch}.${ext}`);
  expected.push(`UniLab-${version}-win-${arch}.exe`);
  for (const ext of ['AppImage', 'deb']) expected.push(`UniLab-${version}-linux-${arch}.${ext}`);
}
for (const file of expected) if (!names.includes(file)) throw Error('Missing package: '+file);
if (names.length !== expected.length) throw Error('Unexpected package set');
writeFileSync('distribution/SHA256SUMS.txt', names.map(name => `${createHash('sha256').update(readFileSync('distribution/'+name)).digest('hex')}  ${name}`).join('\n')+'\n');
console.log(`Verified ${names.length} expected packages; checksums written.`);
