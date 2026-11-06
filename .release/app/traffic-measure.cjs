// 流量测量：headless Chrome 打开产品页，读 30 秒内实际收到的字节数，换算 Mbps / GB 每小时。
// 用法：node traffic-measure.cjs <url> <rtc|ws|raw> [--seconds=30]
//   rtc  清晰模式的 WebRTC264 通道（读 pc 的 inbound'bytesReceived'）
//   ws   清晰模式的旧 WebSocket 通道（页面自己统计的 __net.ws）
//   raw  流畅模式（WebRTC DataChannel，页面统计 __net.rtc）
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_OPEN = process.argv[2];
const COUNTER = (process.argv[3] || 'rtc').toLowerCase();
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '--seconds=30').split('=')[1]);
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p }, (resp) => {
      let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => res(d));
    });
    r.on('error', rej); r.end();
  });
}
const EXPR = {
  rtc: `(async () => { try { let br = 0; const st = await window.__pc264.getStats(); st.forEach(function(r){ if (r.type === 'inbound-rtp' && r.kind === 'video') br = r.bytesReceived || 0; }); return br; } catch (e) { return -1; } })()`,
  ws: `(window.__net && window.__net.ws) || 0`,
  raw: `(window.__net && window.__net.rtc) || 0`,
  rawpc: `(async () => { try { const pc = window.__pc || window.__pcRaw; if (!pc) return -1; let br = 0; const st = await pc.getStats(); st.forEach(function(r){ if (r.type === 'inbound-rtp' && r.kind === 'video') br = r.bytesReceived || 0; }); return br; } catch (e) { return -1; } })()`
};
const PROBE = `(() => { const v = document.getElementById('vid') || document.getElementById('v'); return v ? { vw: v.videoWidth || 0, rs: v.readyState } : null; })()`;

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; } if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); this.ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('cdp timeout ' + method)); } }, 15000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? null : (r.result && r.result.value); }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-traffic-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await req('GET', '/json/version'); break; } catch (e) { await sleep(250); } }
    const created = JSON.parse(await req('PUT', '/json/new?' + encodeURIComponent(URL_OPEN)));
    await sleep(300);
    const list = JSON.parse(await req('GET', '/json/list'));
    const t = list.find((x) => x.id === (created && created.id)) || list.find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');

    let vw = 0;
    // raw-ui：先点「流畅」按钮（会先 /rtc-on 再走 WebRTC DataChannel，URL 参数 ?rtc=1 少了 /rtc-on 会回落 WS）
    if (COUNTER === 'raw-ui') {
      await sleep(1500);
      await cdp.eval(`(function(){ try { var b = document.getElementById('mSmooth'); if (b) b.click(); return !!b; } catch(e) { return false; } })()`);
      for (let i = 0; i < 40; i++) {
        const n = await cdp.eval(`(window.__net && window.__net.rtc) || 0`).catch(() => 0);
        if (n > 0) break;
        await sleep(500);
      }
    }
    for (let i = 0; i < 80; i++) {
      const p = await cdp.eval(PROBE).catch(() => null);
      if (p && p.vw > 0) { vw = p.vw; break; }
      await sleep(500);
    }
    if (!vw) throw new Error('没等到画面');
    if (process.argv.includes('--dump')) {
      const d = await cdp.eval(`(function(){ var v=document.getElementById('vid'); var h=document.getElementById('hud'); return { net: window.__net || null, hasPc264: !!window.__pc264, hasPcRaw: !!window.__pcRaw, vw: v?v.videoWidth:0, hud: h?String(h.textContent||''):'', src: v&&v.srcObject?String(v.srcObject.constructor.name):'' }; })()`);
      console.error('DUMP ' + JSON.stringify(d));
    }
    await sleep(2500);                        // 让编码器/缓冲稳定
    const key = COUNTER === 'raw-ui' ? 'rawpc' : COUNTER;
    let expr = EXPR[key];
    if (!expr) throw new Error('counter 必须是 rtc / ws / raw / raw-ui');
    let b0 = await cdp.eval(expr);
    if (key === 'rawpc' && (!(b0 > 0))) { expr = EXPR.raw; b0 = await cdp.eval(expr); }
    await sleep(SECONDS * 1000);
    let b1 = await cdp.eval(expr);
    if (key === 'rawpc' && expr === EXPR.raw && b1 === b0) b1 = await cdp.eval(EXPR.rawpc);
    const bytes = (b1 || 0) - (b0 || 0);
    const mbps = bytes * 8 / SECONDS / 1e6;
    console.log(JSON.stringify({
      url: URL_OPEN, counter: COUNTER, videoWidth: vw, seconds: SECONDS,
      bytes, mbps: Number(mbps.toFixed(2)),
      gbPerHour: Number((mbps * 3600 / 8 / 1000).toFixed(2)),
      text: null
    }));
    try { await req('GET', '/json/close/' + t.id); } catch (e) { }
    try { ws.close(); } catch (e) { }
  } finally {
    try { chrome.kill(); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})().catch((e) => { console.error('TRAFFIC FAIL: ' + (e && e.message)); process.exit(1); });
