// One disposable worker per job: document bytes and passwords stay on this device.
export function validatePassword(password, confirmation) {
  if (password !== confirmation) throw new Error('The two passwords do not match.');
  if (password.length < 12 || password.length > 64 || !/^[\x20-\x7e]+$/.test(password)) {
    throw new Error('Use 12–64 letters, numbers or symbols (English keyboard) for the password.');
  }
}
export function protectPdf(bytes, password, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('canceled'));
    const worker = new Worker(new URL('./pdf-protection-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); error ? reject(error) : resolve(value); };
    const cancel = () => finish(new Error('canceled'));
    const timer = setTimeout(() => finish(new Error('Password protection took too long. Try a smaller PDF.')), 120000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = () => finish(new Error('Password protection could not start. Reload the app and try again.'));
    worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, new Uint8Array(data.bytes));
    worker.postMessage({ bytes, password, wasmUrl: new URL(`${import.meta.env.BASE_URL}runtime/qpdf.bin`, document.baseURI).href }, [bytes.buffer]);
  });
}
