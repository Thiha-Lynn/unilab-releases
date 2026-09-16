// Registers the UniLab service worker (public/sw.js), enabling offline /
// installable PWA support. Safe to import unconditionally — it no-ops in
// browsers without Service Worker support, and never throws.

import { isPackagedApp } from './native-save.js';
import { debug } from './log.js';

export function registerServiceWorker() {
  if (isPackagedApp() || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    try {
      // import.meta.env.BASE_URL respects the configured Vite `base` path
      // (this deploys to a GitHub Pages subpath, e.g. /unilab/, not domain
      // root), so the registration URL and the resulting scope stay correct
      // no matter where the app is hosted.
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`)
        .catch((err) => {
          debug('[register-sw] service worker registration failed:', err);
        });
    } catch (err) {
      debug('[register-sw] service worker registration failed:', err);
    }
  });
}

export default registerServiceWorker;
