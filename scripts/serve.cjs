// Optional local serving of the unpacked web distribution. Node 22+.
// Binds only to the loopback interface, serves GET/HEAD assets, no upload endpoint.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.wasm':'application/wasm', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.ttf':'font/ttf'};
http.createServer((req,res) => {
  if (req.headers.host !== '127.0.0.1:4173' || !['GET','HEAD'].includes(req.method)) { res.writeHead(400); return res.end(); }
  try {
    const name = decodeURIComponent(new URL(req.url,'http://127.0.0.1:4173').pathname);
    const file = path.resolve(__dirname, '.'+(name==='/'?'/index.html':name));
    const relative = path.relative(__dirname,file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\') || !fs.statSync(file).isFile()) throw Error();
    res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});
    if (req.method==='HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173,'127.0.0.1',()=>console.log('UniLab: http://127.0.0.1:4173 — keep this window open; Ctrl+C stops it.'));
