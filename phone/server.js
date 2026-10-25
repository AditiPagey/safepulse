// Tiny dev server: serves the phone app and forwards /api/... to Dev B's server.
// No npm install needed. Run:  node server.js
// To use Dev B's real server:  set REAL_SERVER below AND set FAKE = false in src/config.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_SERVER = process.env.REAL_SERVER || 'https://tax-negotiation-ate-below.trycloudflare.com'; // <-- Dev B's URL goes here
const PORT = Number(process.env.PORT || 5173);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function proxy(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = {};
  for (const h of ['content-type', 'authorization', 'x-dept-key', 'x-sim-key']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  try {
    const r = await fetch(REAL_SERVER + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = {};
    for (const h of ['content-type', 'x-server-time']) {
      const v = r.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
    console.log(`[proxy] ${req.method} ${req.url} -> ${r.status}`);
  } catch (e) {
    console.log(`[proxy] ${req.method} ${req.url} FAILED: ${e.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_gateway', message: 'Cannot reach ' + REAL_SERVER } }));
  }
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store', // phone always gets your latest code
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`SafePulse phone app: http://localhost:${PORT}/?demo=1`);
  console.log(`/api/... is forwarded to ${REAL_SERVER} (only used when FAKE = false)`);
});
