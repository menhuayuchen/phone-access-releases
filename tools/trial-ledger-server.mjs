#!/usr/bin/env node
// trial-ledger-server.mjs — 试用台账服务（**卖方侧工具，不随产品发布**）
//
// 干什么：记录「每台机器第一次领 7 天试用」的时间。客户机上 trial.ps1 在本地锚点被清掉
// （重装系统、手动删记录）时会来问一次；拿到原来的起点后，试用不会重新开始。
//
// 隐私：只收机械码（SHA256 哈希，形如 5FE5-CFE7-7B27-370B），不收集任何客户信息。
//
// 用法：
//   <node.exe> tools\trial-ledger-server.mjs [--port 18700] [--data <json文件>] [--token <密钥>] [--bind 0.0.0.0]
//   环境变量 TRIAL_LEDGER_TOKEN 也可以给 token。
//
// 接口：
//   POST /trial   { "machine": "XXXX-XXXX-XXXX-XXXX", "v": 1 }
//                → { ok:true, start:"yyyy-MM-dd HH:mm:ss", first:true|false }
//   GET  /health  → { ok:true, machines:<台数>, at:"..." }
//
// 部署建议：放在一台一直开着的机器/小服务器上（国内轻量服务器最省事），前面套一个
// HTTPS（Caddy/Nginx + 证书，或用云厂商的 HTTPS 网关）。product.config.json 里
// freemium.trialLedgerUrl 填 https://<域名>/trial。

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = args.indexOf('--' + name);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : def;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(arg('port', '18700'));
const BIND = arg('bind', '127.0.0.1');
const DATA = arg('data', join(HERE, 'trial-ledger-data.json'));
const TOKEN = arg('token', process.env.TRIAL_LEDGER_TOKEN || '');

let db = { machines: {} };
try { db = JSON.parse(readFileSync(DATA, 'utf8')); } catch { }
if (!db || typeof db !== 'object' || !db.machines || typeof db.machines !== 'object') db = { machines: {} };

function save() {
  try { writeFileSync(DATA, JSON.stringify(db, null, 2), 'utf8'); }
  catch (e) { console.error('trial-ledger: 写数据文件失败：' + (e && e.message)); }
}

const pad = (n) => String(n).padStart(2, '0');
function nowStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// 简单限流：每 IP 每分钟 30 次（客户机平时只在首次/清记录后问一次，够用）
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { at: now, n: 0 };
  if (now - rec.at > 60000) { rec.at = now; rec.n = 0; }
  rec.n++;
  hits.set(ip, rec);
  return rec.n > 30;
}
const MACHINE_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;

let totalRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const json = (code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    } catch { }
  };

  if (url.pathname === '/health') {
    return json(200, { ok: true, machines: Object.keys(db.machines).length, requests: totalRequests, at: nowStr(), token: !!TOKEN });
  }

  if (url.pathname === '/trial' && req.method === 'POST') {
    totalRequests++;
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (limited(ip)) return json(429, { ok: false, error: '太频繁' });
    if (TOKEN && String(req.headers['x-ledger-token'] || '') !== TOKEN) return json(401, { ok: false, error: 'token 不对' });

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let machine = '';
      try { machine = String((JSON.parse(body || '{}') || {}).machine || '').trim().toUpperCase(); } catch { }
      if (!MACHINE_RE.test(machine)) return json(400, { ok: false, error: 'machine 格式不对' });
      const rec = db.machines[machine];
      if (rec && rec.start) {
        rec.seen = nowStr();
        rec.n = (rec.n || 1) + 1;
        save();
        return json(200, { ok: true, start: rec.start, first: false });
      }
      const start = nowStr();
      db.machines[machine] = { start: start, seen: start, n: 1 };
      save();
      console.log('trial-ledger: 新机器入库（总数 ' + Object.keys(db.machines).length + '）');
      return json(200, { ok: true, start: start, first: true });
    });
    return;
  }

  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, BIND, () => {
  console.log('trial-ledger: http://' + BIND + ':' + PORT + '/trial');
  console.log('  data  = ' + DATA + '（' + Object.keys(db.machines).length + ' 台）');
  console.log('  token = ' + (TOKEN ? '已启用（请求头 x-ledger-token）' : '未启用'));
});
