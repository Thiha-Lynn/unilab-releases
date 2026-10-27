import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import createQpdf from '@neslinesli93/qpdf-wasm';
import { readFileSync } from 'node:fs';
import { validatePassword } from '../src/pdf-protection.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

test('password policy rejects mismatch, empty and unsupported input', () => {
  assert.throws(() => validatePassword('', ''), /12–64/);
  assert.throws(() => validatePassword('UniLabSecure2026', 'wrong'), /match/);
  assert.throws(() => validatePassword('မြန်မာစကား123456789', 'မြန်မာစကား123456789'), /English/);
  validatePassword('UniLabSecure2026', 'UniLabSecure2026');
});
test('AES-256 output requires correct password and preserves text', async () => {
  const doc = await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('SYNTHETIC PETITION - QA ONLY', {font});
  const wasmBinary=readFileSync(new URL('../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm',import.meta.url));
  const q = await createQpdf({wasmBinary,print:()=>{},printErr:()=>{}});
  q.FS.writeFile('/input.pdf',await doc.save());
  assert.ok([0,3].includes(q.callMain(['/input.pdf','--encrypt','UniLabSecure2026','random-owner-for-test-only','256','--','/output.pdf'])));
  const bytes=q.FS.readFile('/output.pdf');
  for(const password of [undefined,'wrong']) {
    const task=pdfjs.getDocument({data:bytes.slice(),password});
    try {await assert.rejects(task.promise,e=>e.name==='PasswordException');}finally{await task.destroy();}
  }
  const task=pdfjs.getDocument({data:bytes.slice(),password:'UniLabSecure2026'});
  try {const opened=await task.promise;assert.equal(opened.numPages,1);assert.match((await (await opened.getPage(1)).getTextContent()).items.map(x=>x.str).join(' '),/SYNTHETIC PETITION/);}finally{await task.destroy();}
  q.FS.unlink('/input.pdf');q.FS.unlink('/output.pdf');
});
