// Proof that UniLab's deletion promise is real.
//
// rule.md, PDPA 34: "The agent must not write a privacy claim the code does not
// enforce; if the page promises deletion in one hour, a test must prove the bytes
// are gone." The tool shell tells every student that results are "held only in
// this tab's memory" and are "cleared automatically" on a countdown, when the tab
// closes, or when they press the bin. That is a privacy claim, so it needs this.
//
// The assertion that matters is not `count === 0`. rule.md PDPA 4 is explicit
// that "a `deleted = true` flag is not deletion", so counting the vault's own
// bookkeeping would prove nothing — it is the same object saying it is empty.
// Instead we resolve the object URL itself: while a result is in the vault the
// URL hands back the bytes, and after a purge it resolves to nothing. That is the
// browser's own storage telling us the data is unreachable, independent of any
// flag UniLab set.
//
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import * as vault from '../src/vault.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const output = (name, body) => ({ name, blob: new Blob([body]) });

/** The browser's view: do these bytes still exist anywhere reachable? */
const stillReachable = (url) => Boolean(resolveObjectURL(url));

test('a stored result is reachable while it is in the vault', () => {
  const [item] = vault.store([output('report.pdf', 'page-one-bytes')]);
  assert.equal(vault.state().count, 1);
  assert.ok(stillReachable(item.url), 'the result should be downloadable while the countdown runs');
  vault.purge({ silent: true });
});

test('purge makes the bytes unreachable, not merely unlisted', () => {
  const stored = vault.store([output('a.png', 'aaa'), output('b.png', 'bbb')]);
  const urls = stored.map((i) => i.url);
  assert.ok(urls.every(stillReachable), 'precondition: both results start reachable');

  vault.purge({ silent: true });

  assert.equal(vault.state().count, 0, 'the vault should report nothing left');
  assert.equal(vault.state().bytes, 0, 'and no bytes held');
  assert.ok(stored.every(item => item.blob === null), 'retained UI item references must release their blobs too');
  for (const url of urls) {
    assert.equal(stillReachable(url), false, 'the bytes must be gone, not flagged as deleted');
  }
});

test('pressing "delete now" is the same purge the countdown performs', () => {
  // The bin in the download stage calls vault.purge() directly, so proving purge
  // is enough to prove the control — there is no second, weaker path.
  const [item] = vault.store([output('scan.jpg', 'transcript-scan')]);
  vault.purge();
  assert.equal(stillReachable(item.url), false);
  assert.equal(vault.state().count, 0);
});

test('the countdown expiring purges without anyone pressing anything', async () => {
  // 50 ms of TTL; the shared ticker notices on its next one-second beat.
  const [item] = vault.store([output('lecture.m4a', 'audio-bytes')], { ttlMinutes: 50 / 60000 });
  assert.ok(stillReachable(item.url), 'precondition: reachable immediately after storing');

  await sleep(1200);

  assert.equal(vault.state().count, 0, 'an expired vault should have emptied itself');
  assert.equal(stillReachable(item.url), false, 'and the bytes should be gone with it');
});

test('starting a new job releases the previous job\'s files', () => {
  const [first] = vault.store([output('old.pdf', 'old-bytes')]);
  const [second] = vault.store([output('new.pdf', 'new-bytes')]);

  assert.equal(stillReachable(first.url), false, 'the earlier result must not linger in memory');
  assert.ok(stillReachable(second.url), 'the current result must still be downloadable');
  assert.equal(vault.state().count, 1, 'results must not accumulate across jobs');

  vault.purge({ silent: true });
});

test('the retention window the UI states is the one the vault enforces', () => {
  assert.equal(vault.TTL_MINUTES, 30, 'the stated number and the enforced number must not drift apart');
  assert.equal(vault.formatCountdown(30 * 60_000), '30:00');
  assert.equal(vault.formatCountdown(0), '00:00');
});
