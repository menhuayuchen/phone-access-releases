// serve-test.mjs —— 给编码 A/B 用的极简静态服务器（只在回环上，别当生产用）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8137;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(__dirname, path.basename(decodeURIComponent(u.pathname)));
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serve-test on http://127.0.0.1:' + PORT));
