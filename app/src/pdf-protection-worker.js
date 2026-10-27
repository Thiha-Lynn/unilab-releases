import createQpdf from '@neslinesli93/qpdf-wasm';
self.onmessage = async ({ data: { bytes, password, wasmUrl } }) => {
  let qpdf; let engineUrl;
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error('engine unavailable');
    const wasmBinary = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    engineUrl = URL.createObjectURL(new Blob([wasmBinary], { type: 'application/wasm' }));
    qpdf = await createQpdf({ locateFile: () => engineUrl });
    qpdf.FS.writeFile('/input.pdf', bytes);
    const owner = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    const status = qpdf.callMain(['/input.pdf', '--encrypt', password, owner, '256', '--', '/protected.pdf']);
    if (status !== 0 && status !== 3) throw new Error('encryption failed');
    const output = qpdf.FS.readFile('/protected.pdf');
    self.postMessage({ bytes: output.buffer }, [output.buffer]);
  } catch {
    self.postMessage({ error: 'Could not protect this PDF. Make sure the offline download is complete or connect once to load the protection engine.' });
  } finally {
    if (engineUrl) URL.revokeObjectURL(engineUrl);
    bytes.fill(0);
    for (const path of ['/input.pdf', '/protected.pdf']) { try { qpdf?.FS.unlink(path); } catch {} }
    self.close();
  }
};
