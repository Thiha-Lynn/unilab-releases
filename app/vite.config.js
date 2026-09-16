import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeManifests } from './scripts/build-manifest.js';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const revision = process.env.GITHUB_SHA || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();

// Tiny build plugin: after the bundle is written (and public/ has been copied
// into the output directory), walk that directory and write precache.json —
// a flat JSON array of every deployable file as a relative URL
// ("./index.html", "./assets/….js", "./fonts/…", icons, manifest) plus "./"
// for the root navigation. The service worker fetches this list when the user
// clicks "Make UniLab work offline" (see PRECACHE_ALL in public/sw.js) and
// caches every entry, so tools the user has never opened still work offline.
// Excluded: sw.js (the browser manages the worker script itself) and
// precache.json (must always be fetched fresh, never from cache).
function precacheManifest() {
  let outDir;
  return {
    name: 'unilab-precache-manifest',
    apply: 'build',
    configResolved(config) {
      // resolve(), not join() — --outDir on the CLI may be an absolute path.
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const worker = resolve(outDir, 'sw.js');
      writeFileSync(worker, readFileSync(worker, 'utf8').replace('unilab-v4', `unilab-${revision.slice(0,12)}`));
      const result = writeManifests(outDir, revision);
      console.log(`[precache] ${result.count} files, ${(result.bytes / 1e6).toFixed(2)} MB core (8 MB budget)`);
    },
  };
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version), __RELEASE_ID__: JSON.stringify(revision.slice(0,12)) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  plugins: [precacheManifest()],
});
