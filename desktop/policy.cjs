const path = require('node:path');
const ORIGIN = 'app://unilab';
function isAppURL(value) {
  try { const u = new URL(value); return u.protocol === 'app:' && u.hostname === 'unilab' && !u.port && !u.username && !u.password; }
  catch { return false; }
}
function assetPath(root, value, method = 'GET') {
  if (!isAppURL(value) || !['GET', 'HEAD'].includes(method)) return null;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) return null;
    const candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? candidate : null;
  } catch { return null; }
}
function externalURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && ['github.com', 'unilab.ztvmm.live'].includes(u.hostname); }
  catch { return false; }
}
module.exports = { ORIGIN, isAppURL, assetPath, externalURL };
