import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toolShell } from '../src/tool-shell.js';
import * as vault from '../src/vault.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
test('failed batch export permits retry without duplicate ZIP or false saved claim', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://unilab.ztvmm.live/#/split-pdf' });
  const win = dom.window; win.scrollTo = () => {};
  const globals = { window: win, document: win.document, location: win.location, localStorage: win.localStorage, sessionStorage: win.sessionStorage, navigator: win.navigator, __APP_VERSION__: '0.4.1', fetch: async () => ({ ok: true }) };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let calls = 0, rejectZip;
  try {
    const ctx = toolShell(document.querySelector('#app'), { id: 'split-pdf', name: 'Split PDF' }, {
      run: async () => ({ outputs: [1, 2].map(n => ({ name: `${n}.pdf`, blob: new Blob(['fixture']) })), zip: () => {
        calls++;
        return calls === 1 ? new Promise((resolve, reject) => { rejectZip = reject; }) : Promise.resolve();
      } })
    });
    ctx.files.push(new win.File(['fixture'], 'input.pdf')); ctx.refresh();
    document.querySelector('.ts__go').click(); await pause();
    const button = document.querySelector('.ts__download'), help = document.querySelector('.ts__download-help');
    assert.match(help.textContent, /does not save a copy automatically/);
    button.click(); button.click();
    assert.equal(calls, 1); assert.equal(button.disabled, true);
    rejectZip(new Error('fixture export failure')); await pause();
    assert.match(help.textContent, /Could not prepare the download/);
    assert.equal(button.disabled, false);
    button.click(); await pause();
    assert.equal(calls, 2); assert.equal(button.disabled, false);
    assert.match(help.textContent, /does not save a copy automatically/);
    assert.doesNotMatch(help.textContent, /successfully saved/i);
  } finally {
    vault.purge(); win.dispatchEvent(new win.Event('hashchange')); win.close();
    for (const [key, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
