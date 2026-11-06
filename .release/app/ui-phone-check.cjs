// 手机竖屏 UI 检查：用 Chrome 的移动仿真打开产品页，量顶栏按钮有没有超出屏幕，并截图。
// 用法：node narrow-ui-check.cjs <url> <width> <height> [dpr] [outPng] [--landscape]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_OPEN = process.argv[2];
const W = Number(process.argv[3] || 393);
const H = Number(process.argv[4] || 856);
const DPR = Number(process.argv[5] || 2.75);
const OUT = process.argv[6] || path.join(os.tmpdir(), 'ui-check.png');
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9334);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: DEBUG_PORT, method, path: p }, (resp) => {
      let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => res(d));
    });
    r.on('error', rej); r.end();
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; } if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); this.ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('cdp timeout ' + method)); } }, 20000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; }
}

const MEASURE = `(() => {
  const hdr = document.querySelector('header');
  if (!hdr) return { err: 'no header' };
  const kids = [...hdr.children].filter(el => getComputedStyle(el).display !== 'none');
  const vw = window.innerWidth, vh = window.innerHeight;
  const items = kids.map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.tagName, text: (el.textContent || '').trim().slice(0, 6), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; });
  const clipped = items.filter(i => i.right > vw + 1 || i.left < -1).map(i => i.id);
  const rows = [...new Set(items.map(i => i.top))].length;
  return { vw, vh, headerH: Math.round(hdr.getBoundingClientRect().height), rows, items, clipped };
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ui-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { try { await req('GET', '/json/version'); up = true; break; } catch (e) { await sleep(250); } }
    if (!up) throw new Error('chrome debug port 没起来');
    let created = JSON.parse(await req('PUT', '/json/new?' + encodeURIComponent(URL_OPEN)));
    await sleep(300);
    const list = JSON.parse(await req('GET', '/json/list'));
    const t = list.find((x) => x.id === (created && created.id)) || list.find((x) => x.type === 'page' && x.url.startsWith('http'));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
    const cdp = new CDP(ws);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true, screenWidth: W, screenHeight: H });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(7000);                    // 等页面加载 + WebRTC 出画面
    const m = await cdp.eval(MEASURE);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ url: URL_OPEN, w: W, h: H, dpr: DPR, out: OUT, ...m }));
    try { await req('GET', '/json/close/' + t.id); } catch (e) { }
    webSocketClose(ws);
  } finally {
    try { chrome.kill(); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})().catch((e) => { console.error('UI CHECK FAIL: ' + (e && e.message)); process.exit(1); });

function webSocketClose(ws) { try { ws.close(); } catch (e) { } }
