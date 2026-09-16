import { Capacitor, registerPlugin } from '@capacitor/core';
import { streamExport } from './stream-export.js';
const native = registerPlugin('UniLabSave');
export const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const isPackagedApp = () => isAndroidApp() || location.protocol === 'app:';
let pending = Promise.resolve();
export function saveAndroidBlob(blob, filename) {
  // Batch exports must present one system picker at a time.
  const next = pending.then(() => streamExport(native, blob, filename));
  pending = next.catch(() => {});
  return next;
}
