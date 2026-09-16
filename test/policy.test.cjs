const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isAppURL, assetPath, externalURL } = require('../desktop/policy.cjs');
test('local app assets have a distinct origin and are read-only', () => {
  const root = path.resolve('web');
  assert.equal(assetPath(root, 'app://unilab/'), path.join(root, 'index.html'));
  assert.equal(assetPath(root, 'app://unilab/assets/tool.js'), path.join(root, 'assets/tool.js'));
  assert.equal(assetPath(root, 'https://unilab.ztvmm.live/'), null);
  assert.equal(assetPath(root, 'app://other/index.html'), null);
  assert.equal(assetPath(root, 'app://unilab/', 'POST'), null);
  assert.equal(isAppURL('app://unilab/#/html-to-pdf'), true);
  assert.equal(isAppURL('file:///tmp/index.html'), false);
});
test('external navigation is limited to project and release HTTPS links', () => {
  assert.equal(externalURL('https://github.com/Thiha-Lynn/unilab-releases'), true);
  assert.equal(externalURL('https://unilab.ztvmm.live/'), true);
  assert.equal(externalURL('https://example.com/'), false);
  assert.equal(externalURL('file:///tmp/result.pdf'), false);
  assert.equal(externalURL('http://github.com/'), false);
});
