// ui-test-server.mjs — 本地页面渲染测试台（卖家/开发侧工具，不随产品包发给客户）
//
// 干什么：用**产品自己的** app\page.mjs 渲染页面，只把 /licence、/health、/frame.jpg 等接口打桩，
//   这样不用装产品、不用动正在跑的服务，就能在浏览器里逐个状态看「设置」面板怎么显示。
//   典型用途：改完许可证/试用相关文案后，确认"免费版 · 试用还剩几天 / 专业版 · 永久"没写错。
//
// 用法：
//   <产品目录>\runtime\node.exe tools\ui-test-server.mjs
//   然后浏览器打开：http://127.0.0.1:8899/?k=TESTKEY&case=trial
//
// case 可选：trial（免费版·试用中） / pro（专业版·永久） / expired（试用已结束） / mismatch（许可证换机）
//
// 注意：只读 app\page.mjs，不改产品文件；打桩数据都在本文件里，跟真实授权逻辑无关。
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PAGE_MJS = fileURLToPath(new URL('../app/page.mjs', import.meta.url));
const PORT = Number(process.env.PA_UI_TEST_PORT || 8899);
const { PAGE } = await import(new URL('../app/page.mjs', import.meta.url).href);

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const base = (over = {}) => Object.assign({
  usable: true, licensed: true, trial: null, state: 'ok',
  machineCode: '5FE5-CFE7-7B27-370B', name: '本人自用（永久）',
  expires: 'never', message: '许可证有效。', version: '1.0.7',
  captureWidth: 2560,
  support: { enabled: true, title: '支持 / 购买许可证', note: '纯支持也行，谢谢！', showMachineCode: true },
  branding: { alipay: '', wechat: '', contact: '购买许可证 / 技术支持\n邮箱：ccc475235@gmail.com' },
  plans: { enabled: true, title: '套餐与价格', items: [] },
  share: {
    enabled: true,
    title: '分享给朋友（对方装好就能用）',
    link: 'https://example.com/pa-demo',
    text: '我在用「手机远程」：手机就能看电脑屏幕，还能点、能打字。\n下载试用：{link}'
  },
  ultraQuota: { ultra: true, remainingSec: 3600, limitSec: 3600, exhausted: false }
}, over);

const TRIAL = { active: true, state: 'trial', start: '2026-10-24 21:00:00', ends: '2026-10-31 21:00:00', daysLeft: 2, days: 7, machine: '5FE5-CFE7-7B27-370B' };
const EXPIRED = { active: false, state: 'expired', start: '2026-10-15 21:00:00', ends: '2026-10-22 21:00:00', daysLeft: 0, days: 7, machine: '5FE5-CFE7-7B27-370B' };

const CASES = {
  // 已购买：永久许可证
  pro: base({ trial: EXPIRED }),
  // 新装未付款：7 天全功能试用中（最容易和"已授权/永久"搞混的状态）
  trial: base({
    usable: true, licensed: false, name: '', expires: '', state: 'missing',
    message: '这台电脑还没有许可证。', trial: TRIAL,
    ultraQuota: { ultra: true, remainingSec: 3120, limitSec: 3600, exhausted: false }
  }),
  // 试用结束：免费版（带"今天超清已用完"）
  expired: base({
    usable: false, licensed: false, name: '', expires: '', state: 'missing',
    message: '这台电脑还没有许可证。', trial: EXPIRED,
    ultraQuota: { ultra: true, remainingSec: 0, limitSec: 3600, exhausted: true }
  }),
  // 许可证换了机器：免费版 + 原因
  mismatch: base({
    usable: false, licensed: false, name: '', expires: '',
    state: 'machine-mismatch', message: '这个许可证是发给另一台电脑的。',
    trial: null, ultraQuota: { ultra: true, remainingSec: 3600, limitSec: 3600, exhausted: false }
  })
};

const HEALTH = (c) => {
  const uq = (c.ultraQuota && c.ultraQuota.exhausted) ? '0:x' : String((c.ultraQuota && c.ultraQuota.remainingSec) || 0);
  return 'ok viewers=1 source=file age=0.4 dropped=0 cap=1920 in=8 out=8 drop10= lag=0 mode=420 raw=0 blk=0 blkage=0 uq=' + uq + ' rtc={"peers":0} input={"x":0,"y":0}';
};

// 更新流程打桩：用来在浏览器里看「检查更新 → 下载进度 → 失败提示」的界面
let mockUpd = { phase: 'idle', bytes: 0, total: 52400000, startedAt: 0, lastByteAt: 0, error: '' };
function mockProgress() {
  const now = Date.now();
  const secs = mockUpd.startedAt ? Math.max(0.2, (now - mockUpd.startedAt) / 1000) : 0;
  return {
    active: mockUpd.phase === 'connecting' || mockUpd.phase === 'downloading',
    phase: mockUpd.phase,
    bytes: mockUpd.bytes,
    total: mockUpd.total,
    pct: mockUpd.total ? Math.round(mockUpd.bytes * 100 / mockUpd.total) : 0,
    speedKB: (mockUpd.bytes > 0 && secs > 0) ? Math.round(mockUpd.bytes / 1024 / secs) : 0,
    idleSec: mockUpd.lastByteAt ? Math.max(0, Math.round((now - mockUpd.lastByteAt) / 1000)) : 0,
    error: mockUpd.error || ''
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const which = url.searchParams.get('case') || 'trial';
  const c = CASES[which] || CASES.trial;
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/licence' && req.method === 'POST') return json({ ok: false, message: '（测试台不落盘）' });
  if (url.pathname === '/licence') return json(c);
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(HEALTH(c)); }
  if (url.pathname === '/sources') return json({ monitors: [{ i: 0, x: 0, y: 0, w: 1920, h: 1080 }], windows: [] });
  if (url.pathname === '/frame.jpg') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG_1x1); }
  if (url.pathname === '/manifest.json') return json({ name: '手机远程', short_name: '手机远程', start_url: '/?k=TESTKEY', display: 'standalone' });
  if (url.pathname === '/update-check') {
    return json({
      configured: true, current: '1.0.7', latest: '1.0.8', hasUpdate: true,
      notes: '测试台：模拟一个 1.0.8 更新，用来检查进度/失败提示。',
      downloadUrl: 'https://example.com/PhoneAccess-Setup-v1.0.8.exe',
      fallbackUrl: '', mirror: '', pageUrl: 'https://example.com/releases'
    });
  }
  if (url.pathname === '/update-progress') return json(mockProgress());
  if (url.pathname === '/update-install' && req.method === 'POST') {
    // 模拟：连接 1 秒 → 下载到 ~10MB → 6 秒时"太慢"失败，页面应显示进度和红色错误
    mockUpd = { phase: 'connecting', bytes: 0, total: 52400000, startedAt: Date.now(), lastByteAt: Date.now(), error: '' };
    setTimeout(() => { mockUpd.phase = 'downloading'; }, 1000);
    const tick = setInterval(() => {
      if (mockUpd.phase !== 'downloading') return;
      mockUpd.bytes = Math.min(mockUpd.total, mockUpd.bytes + 2.5 * 1024 * 1024);
      mockUpd.lastByteAt = Date.now();
    }, 500);
    setTimeout(() => {
      clearInterval(tick);
      mockUpd.phase = 'error';
      mockUpd.error = '下载太慢：平均只有 25 KB/s，按这个速度还要约 35 分钟，已停止。';
      json({ ok: false, message: mockUpd.error });
    }, 6000);
    return;
  }
  if (url.pathname === '/set-quality' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let w = 0;
      try { w = Math.round(Number((JSON.parse(body || '{}') || {}).captureWidth)) || 0; } catch { }
      c.captureWidth = w;   // 重新打开设置时高亮应停在新档位
      json({ ok: true, captureWidth: w, requested: w, captureNative: 2560, needFullRestart: false, message: '已生效（测试台）：发送宽度 ' + w + '，不用重启。' });
    });
    return;
  }
  if (['/mode', '/rtc-on', '/rtc-off', '/unblock', '/showdesktop', '/update-check'].includes(url.pathname)) {
    return json({ ok: true, configured: false, current: '1.0.7' });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE('TESTKEY', '/manifest.json'));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('ui-test on http://127.0.0.1:' + PORT + '/?k=TESTKEY&case=trial');
  console.log('page.mjs: ' + PAGE_MJS);
});
