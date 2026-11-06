// Local reverse proxy in front of the loopback-bound web console.
// The console's browser-trust fence only accepts loopback / its own bind address, and it
// signs the browser cookie against the authority it sees. So every external path
// (LAN proxy, tailnet serve, tunnel) funnels through here and we rewrite
// Host/Origin/Referer to the console bind authority — a constant, so the login cookie
// survives IP changes. Streaming and WebSocket upgrades pass through untouched.
//
// 2026-10-25 加固（起因：手机端看到"崩了"，其实是 token 轮换后的死胡同页面）：
//   1. /go 发 token 之前先**探一下这个 token 到底能不能用**（GET /?token=… 看是不是 401）。
//      候选来自 web-lan.log / phone-url.txt / lan-url.txt / tailip-url.txt，
//      按新鲜度依次试，第一个能用的才发出去。以前是"信日志"，日志被清空就把死 token 发出去。
//   2. 页面级 401（有人拿旧 token / cookie 丢了 / 在另一个域名打开）不再显示那句英文，
//      而是给一个可点的页面：从 /go 进来过的（带 pawk cookie）自动跳回 /go 重新登录。
//   3. /go 成功时种一个 pawk cookie（存 key 的 sha256，不是 key 本身），1 年，
//      用来判断"这台设备本来就持有密钥"，所以自动跳转不会把密钥门槛抹掉。
//
// Usage: node tunnel-proxy.mjs [listenHost] [listenPort] [targetHost] [targetPort]
import http from 'node:http';
import net from 'node:net';
import { readFileSync, statSync, renameSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(HERE, 'screen.key');
const URL_FILE = path.join(HERE, 'phone-url.txt');
const WEB_LOG = path.join(HERE, 'web-lan.log');
const DOOR_LOG = path.join(HERE, 'door.log');

// 只在"值得看"的时候写一行：/go 登录、4xx/5xx。正常页面/资源不记，免得刷盘。
function doorLog(status, req) {
  try {
    if (status < 400 && !/^\/+go\/?$/.test((req.url || '').split('?')[0])) return;
    if (statSync(DOOR_LOG, { throwIfNoEntry: false })?.size > 2 * 1024 * 1024) {
      renameSync(DOOR_LOG, DOOR_LOG + '.old');
    }
    const ua = String(req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 90);
    const line = `${new Date().toISOString()} ${status} ${req.method} ${String(req.url).slice(0, 120)} h=${req.headers.host || '-'} ua=${ua}\n`;
    appendFileSync(DOOR_LOG, line);
  } catch { /* logging must never break the door */ }
}

// 越靠前越新鲜
const TOKEN_SOURCES = ['web-lan.log', 'phone-url.txt', 'lan-url.txt', 'tailip-url.txt'];

function readOnce(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function proxyPath(file) {
  return file === 'web-lan.log' ? WEB_LOG : path.join(HERE, file);
}

function candidateTokens() {
  const seen = new Set();
  const out = [];
  for (const file of TOKEN_SOURCES) {
    const text = readOnce(proxyPath(file));
    const hits = [...text.matchAll(/token=([A-Za-z0-9_\-]{16,})/g)];
    for (let i = hits.length - 1; i >= 0; i -= 1) {   // 同一文件里，后出现的更新
      const t = hits[i][1];
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function accessKey() {
  const key = readOnce(KEY_FILE).trim();
  return key.length >= 8 ? key : null;
}

function keyDigest(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// 改动（P0-4）：下面两行原来把默认端口写死成 8650 / 8642。现在改读 product.config.json（唯一配置源），
// 读不到才用同样的 8650/8642 兜底。说明：方案甲（enableWebConsole=false）下本文件根本不会被启动——网页控制台属可选模块；
// 保留这层配置只是为了"手动起一扇门调试"时不会连到错端口。
function configPort(key, fallback) {
  try {
    const raw = JSON.parse(readFileSync(path.join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const n = Number(raw && raw.ports && raw.ports[key]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch { /* 配置缺失/损坏：用兜底值，不崩 */ }
  return fallback;
}

const [, , a1, a2, a3, a4] = process.argv;
const LISTEN_HOST = a1 || process.env.PROXY_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(a2 || process.env.PROXY_LISTEN_PORT || configPort('door', 8650));
const TARGET_HOST = a3 || process.env.PROXY_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(a4 || process.env.PROXY_TARGET_PORT || configPort('web', 8642));
const AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`;

// ---------------------------------------------------------------- token 校验

let tokenCache = { token: null, at: 0 };

function probeToken(token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: 'GET', path: '/?token=' + encodeURIComponent(token), headers: { host: AUTHORITY, accept: 'text/html' } },
      (res) => {
        const code = res.statusCode ?? 0;
        res.resume();
        resolve(code !== 401 && code !== 403);
      },
    );
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function resolveToken() {
  // 5 秒内复用，避免每次刷新都多打一次上游
  if (tokenCache.token && Date.now() - tokenCache.at < 5000) return tokenCache.token;
  for (const t of candidateTokens()) {
    if (await probeToken(t)) {
      tokenCache = { token: t, at: Date.now() };
      return t;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 页面

function page(title, body, extraHead = '') {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title>${extraHead}`
    + '<body style="margin:0;background:#0b0b0d;color:#c9ccd1;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif">'
    + '<div style="max-width:560px;margin:0 auto;padding:44px 24px">'
    + `<h1 style="font-size:19px;color:#e8eaed;margin:0 0 10px">${title}</h1>${body}</div></body>`;
}

function loginPage(reason, autoGo) {
  const key = accessKey();
  const btn = key
    ? `<a href="/go?k=${encodeURIComponent(key)}" style="display:block;margin:22px 0 10px;padding:14px;text-align:center;border-radius:10px;background:#2b6cf6;color:#fff;text-decoration:none;font-weight:600">重新登录</a>`
    : '<p style="color:#e0a33e">这台电脑上还没配置访问密钥（screen.key），请到电脑端重新生成入口。</p>';
  return page(
    '需要重新登录',
    `<p>${reason}</p><p style="color:#8b9098">控制台每次重启都会换一个登录令牌，旧链接就失效了。点下面这个按钮会拿到当前的令牌，不用重新扫码。</p>${btn}`
      + (key ? `<p style="color:#8b9098;font-size:13px">也可以直接收藏这个长期有效的入口：<code style="word-break:break-all;color:#a8b0ba">/go?k=${key.slice(0, 4)}…</code></p>` : ''),
    autoGo ? `<meta http-equiv="refresh" content="0;url=/go?k=${encodeURIComponent(key)}">` : '',
  );
}

// 暴力破解防护：同一个 IP 10 分钟内猜错 8 次就锁 10 分钟。
// 密钥是 64 bit，本来猜不出来；这条是为了让"有人在敲"这件事留下痕迹并且别无限敲。
const keyFailures = new Map();   // ip -> { count, first, until }
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 8;

function failState(ip) {
  const now = Date.now();
  const rec = keyFailures.get(ip);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) {
    const fresh = { count: 0, first: now, until: 0 };
    keyFailures.set(ip, fresh);
    return fresh;
  }
  return rec;
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function hasKeyCookie(req) {
  const key = accessKey();
  if (!key) return false;
  const raw = req.headers.cookie || '';
  const want = keyDigest(key);
  return raw.split(';').some((part) => {
    const [name, value] = part.trim().split('=');
    return name === 'pawk' && value === want;
  });
}

function rewriteHeaders(headers) {
  const h = { ...headers };
  h.host = AUTHORITY;
  for (const key of ['origin', 'referer']) {
    const value = h[key];
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      url.protocol = 'http:';
      url.host = AUTHORITY;
      h[key] = key === 'origin' ? url.origin : url.href;
    } catch {
      delete h[key];
    }
  }
  delete h['x-forwarded-for'];
  delete h['x-forwarded-proto'];
  delete h['x-forwarded-host'];
  delete h['forwarded'];
  return h;
}

const server = http.createServer((req, res) => {
  // GET /go?k=<screen.key>  ->  302 to a *verified working* console token URL.
  // The console mints a fresh one-time token on every start, so the QR/URL keeps changing;
  // this stable bookmark re-logs in without scanning anything (30-day cookie renews).
  let url = null;
  try { url = new URL(req.url, 'http://placeholder'); } catch { /* ignore */ }

  if (url && /^\/+go\/?$/.test(url.pathname)) {
    const key = accessKey();
    const given = url.searchParams.get('k') || '';
    const ip = clientIp(req);
    const st = failState(ip);
    if (st.until > Date.now()) {
      doorLog(429, req);
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '600' });
      res.end(page('尝试次数太多', '<p>同一个设备 10 分钟内猜错密钥 8 次，已锁定 10 分钟。</p><p style="color:#8b9098">如果这是你自己的设备，直接用电脑端重新打印的链接打开即可。</p>'));
      return;
    }
    if (!key) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('还没有配置访问密钥', '<p>电脑上还没生成 <code>screen.key</code>，先跑一次电脑端的启动脚本。</p>'));
      return;
    }
    // 2026-10-26：手机上出现过 "k=…"（省略号）这种链接 —— 是从聊天/文档里复制时把
    // 占位符一起抄走了。这不算猜密钥（不该计入锁定），单独给一页说明怎么拿真链接。
    const looksPlaceholder = /[…\.\*<>×]/.test(given) || given.length < 8 || /^(key|your_?key|密钥)$/i.test(given);
    // 改动（P0-1 同类）：下面两行提示文字原来写死一个固定的 tailnet 地址（http://<固定IP>:8642/），
    // 客户机上会显示别人的地址。改成中性占位 + 实际控制台端口（targetPort 来自启动参数/配置），不再有固定 IP。
    // 方案甲（enableWebConsole=false）下本文件不会启动，这里是方案乙才会渲染到的页面提示。
    const webHint = 'http://<这台电脑的 tailnet 地址>:' + TARGET_PORT + '/';
    if (given && looksPlaceholder) {
      doorLog(400, req);
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('这个链接不完整',
        '<p>链接里 <code>k=</code> 后面是省略号或占位符，不是真实密钥。真实密钥是 16 位字母数字。</p>'
        + '<p style="color:#8b9098">拿法一：电脑上双击 <code>phone-access\\show-qr.cmd</code> 出二维码，手机扫一下。<br>'
        + '拿法二：只输 <code>' + webHint + '</code>（不带 k），这台设备 7 天内登录过就会自动跳登录。</p>'));
      return;
    }
    if (given !== key) {
      st.count += 1;
      if (st.count >= FAIL_LIMIT) st.until = Date.now() + FAIL_WINDOW_MS;
      doorLog(401, req);
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('访问密钥不对', '<p>入口链接里的 <code>k=</code> 不是这台电脑当前的密钥。请用电脑端打印/二维码里的那个链接。</p>'
        + '<p style="color:#8b9098">小技巧：只打开 <code>' + webHint + '</code>（不带 <code>k=</code>），'
        + '这台设备 7 天内登录过就会自己跳进登录页，不用输密钥。</p>'));
      return;
    }
    resolveToken().then((token) => {
      if (res.headersSent) return;
      if (!token) {
        doorLog(503, req);
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page('控制台正在重启', '<p>手上的令牌都不能用了，说明手机端控制台正在启动或刚重启。等 10 秒刷新一下就好。</p>',
          '<meta http-equiv="refresh" content="10">'));
        return;
      }
      doorLog(302, req);
      res.writeHead(302, {
        location: '/?token=' + token,
        'cache-control': 'no-store',
        'set-cookie': `pawk=${keyDigest(key)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
      });
      res.end();
    }).catch(() => {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token resolve failed\n'); }
    });
    return;
  }

  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: rewriteHeaders(req.headers) },
    (upRes) => {
      const status = upRes.statusCode ?? 502;
      const accept = String(req.headers.accept || '');
      const isPage = req.method === 'GET' && accept.includes('text/html');

      // 页面级的"未登录/令牌失效"：不再把那句英文原样丢给手机
      if (status === 401 && isPage) {
        upRes.resume();
        doorLog(401, req);
        if (hasKeyCookie(req)) {
          const key = accessKey();
          res.writeHead(302, { location: '/go?k=' + encodeURIComponent(key), 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loginPage('这个链接的登录令牌已经失效了（控制台重启过一次就会这样）。'));
        return;
      }

      doorLog(status, req);
      res.writeHead(status, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('控制台没有在运行', '<p>手机端控制台进程没起来，电脑上的 supervisor 会在 1 分钟内把它拉起来，稍等再刷新。</p>'
        + '<meta http-equiv="refresh" content="15">'));
      return;
    }
    res.end();
  });
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const headers = rewriteHeaders(req.headers);
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else lines.push(`${name}: ${value}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.on('clientError', (_err, socket) => socket.destroy());

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`tunnel-proxy: ${LISTEN_HOST}:${LISTEN_PORT} -> http://${AUTHORITY}`);
});