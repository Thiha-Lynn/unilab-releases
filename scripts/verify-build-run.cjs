const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const run = JSON.parse(fs.readFileSync('build-run.json'));
const jobs = JSON.parse(fs.readFileSync('build-jobs.json')).jobs;
const tag = process.env.VERSION_TAG;
const tagSha = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding:'utf8' }).trim();
if (run.head_sha !== tagSha || run.path !== '.github/workflows/release.yml') throw Error('Run does not belong to this tagged release workflow');
if (tag !== 'v'+require('../package.json').version) throw Error('Version differs from tag');
for (const name of ['Verify pinned web source', 'android package', ...['mac','win','linux'].flatMap(p=>['x64','arm64'].map(a=>`${p} ${a} package`))]) {
  if (!jobs.some(j => j.name === name && j.conclusion === 'success')) throw Error('Required build job did not pass: '+name);
}
console.log(`Verified seven platform builds and source gate at ${tagSha}, run ${run.id}`);
