// خادم تطوير/اختبار محلي: يقدّم الواجهة والـ API بدون Next.js. في الإنتاج يحل محله Next.js على Vercel.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatch } from '../src/server/index';
import { readUpload } from '../src/server/storage';

const root = path.resolve(import.meta.dirname, '../public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const port = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await dispatch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : body }));
      const out: Record<string, string | string[]> = {}; r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const sc = r.headers.getSetCookie?.(); if (sc?.length) out['set-cookie'] = sc;
      res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (url.pathname.startsWith('/uploads/')) {
      const f = await readUpload(url.pathname.slice(9));
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }); res.end(f.data); return;
    }
    const clean = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(root, clean);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    let data: Buffer;
    try { data = await fs.readFile(file); } catch { file = path.join(root, 'index.html'); data = await fs.readFile(file); }   // SPA fallback
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
    res.end(data);
  } catch (e) { console.error(e); res.writeHead(500); res.end('server error'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
