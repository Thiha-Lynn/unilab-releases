export const EXPORT_CHUNK = 192 * 1024;
export async function streamExport(native, blob, filename) {
  if (!(blob instanceof Blob)) throw new Error('This result has expired. Convert the file again.');
  let id;
  try {
    ({ id } = await native.begin({ name: filename, mime: blob.type || 'application/octet-stream', size: blob.size }));
    for (let start = 0; start < blob.size; start += EXPORT_CHUNK) {
      const bytes = new Uint8Array(await blob.slice(start, start + EXPORT_CHUNK).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await native.append({ id, data: btoa(text) });
    }
    await native.finish({ id });
  } catch (error) {
    if (id) await native.cancel({ id }).catch(() => {});
    throw error;
  }
}
