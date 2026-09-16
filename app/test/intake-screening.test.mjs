// Proof that a file this app will not process is refused, and not retained.
//
// rule.md, PDPA 12: "The system must reject uploads above a stated size and of
// types we do not edit, and must not silently retain a file it refused to
// process."
//
// The bug this guards against is specific. `<input accept="image/jpeg">` filters
// the operating system's file picker and nothing else — a file dragged onto the
// page never goes near it. Before `intake.js` existed, dropping a 4 GB disk image
// onto Compress Image handed it straight to the decoder. These tests are written
// against the drag path's rules, because that is the path that had no check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFiles, matchesAccept, describeLimit, rejectionMessage, MAX_FILE_BYTES } from '../src/intake.js';

/** A stand-in for a File — screening only ever reads name, type and size. */
const file = (name, type, size) => ({ name, type, size });

test('accept matching handles the three shapes the tools actually use', () => {
  const jpg = file('photo.jpg', 'image/jpeg', 10);
  assert.ok(matchesAccept(jpg, 'image/jpeg,image/png'), 'explicit mime list');
  assert.ok(matchesAccept(jpg, 'image/*'), 'wildcard mime');
  assert.ok(matchesAccept(jpg, '.jpg,.png'), 'extension list');
  assert.ok(matchesAccept(jpg, '*'), 'the permissive default');
  assert.equal(matchesAccept(jpg, 'application/pdf'), false, 'a type the tool cannot open');
});

test('an extension is matched whatever case the phone wrote it in', () => {
  // Phones write .JPG as often as .jpg; a case-sensitive check would refuse a
  // photo the tool can open perfectly well.
  assert.ok(matchesAccept(file('IMG_0042.JPG', '', 10), '.jpg'));
  assert.ok(matchesAccept(file('scan.PDF', '', 10), '.pdf'));
});

test('a file the tool cannot open is refused and not passed on', () => {
  const { accepted, rejected } = screenFiles(
    [file('notes.pdf', 'application/pdf', 1000)],
    { accept: 'image/jpeg,image/png' },
  );
  assert.equal(accepted.length, 0, 'nothing is handed to the tool');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /not a file type this tool can open/);
});

test('a file above the stated size is refused', () => {
  const huge = file('lecture.mp4', 'video/mp4', 3 * 1024 * 1024 * 1024);
  const { accepted, rejected } = screenFiles([huge], { accept: '*' });
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /larger than the 2 GB limit/);
});

test('a mixed drop keeps what it can and refuses the rest', () => {
  // The behaviour that matters for a student: dropping eight photos and one
  // stray video should yield eight photos and one message, not a dead end.
  const files = [
    file('a.jpg', 'image/jpeg', 100),
    file('b.jpg', 'image/jpeg', 100),
    file('clip.mov', 'video/quicktime', 100),
    file('c.jpg', 'image/jpeg', 5 * 1024 * 1024 * 1024),
  ];
  const { accepted, rejected } = screenFiles(files, { accept: 'image/jpeg' });
  assert.deepEqual(accepted.map((f) => f.name), ['a.jpg', 'b.jpg']);
  assert.equal(rejected.length, 2, 'the wrong type and the oversized one');
});

test('the refusal names the file and the reason, so nothing fails silently', () => {
  const { rejected } = screenFiles([file('secret.iso', 'application/octet-stream', 10)], { accept: 'image/*' });
  const msg = rejectionMessage(rejected);
  assert.match(msg, /secret\.iso/);
  assert.match(msg, /was not opened/);
});

test('screening returns only plain arrays, holding no reference to a refused file', () => {
  // "must not silently retain a file it refused to process" — the refused file
  // must not survive in the returned value. We keep its name and reason for the
  // message; the object itself is not carried.
  const refused = file('huge.bin', 'application/octet-stream', MAX_FILE_BYTES + 1);
  const { accepted, rejected } = screenFiles([refused], { accept: '*' });
  assert.equal(accepted.length, 0);
  assert.deepEqual(Object.keys(rejected[0]).sort(), ['name', 'reason']);
  assert.equal(rejected.includes(refused), false, 'the refused file object is not retained');
});

test('the stated limit reads the way it is written in the UI', () => {
  assert.equal(describeLimit(2 * 1024 * 1024 * 1024), '2 GB');
  assert.equal(describeLimit(200 * 1024 * 1024), '200 MB');
});
