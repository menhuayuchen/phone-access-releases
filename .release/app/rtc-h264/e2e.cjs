// rtc-h264 侧车的本地端到端验证：无头 Chrome + CDP。
// 用法：node e2e.cjs <url> [--seconds=20] [--reload] [--debug-port=9333]
//   url 例如 http://127.0.0.1:9802/test?relay=1
// 输出一行 JSON：{ ok, url, vw, vh, text, ice, seconds }
// 判定 ok：videoWidth>0 且 video.currentTime 在前进（真的在播，而不是一张卡住的黑帧）。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
}
const URL_TO_OPEN = process.argv[2];
if (!URL_TO_OPEN) { console.error('用法：node e2e.cjs <url> [--seconds=20] [--reload]'); process.exit(2); }
const SECONDS = Number(arg('seconds', '20'));
const SOAK = Number(arg('soak', '0'));
const RELOAD = process.argv.includes('--reload');
const PORT = Number(arg('debug-port', '9333'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p }, (resp) => {
      let d = '';
      resp.on('data', (c) => { d += c; });
      resp.on('end', () => res(d));
    });
    r.on('error', rej);
    r.end();
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        try {
          const txt = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
          this.logs.push({ t: Date.now(), type: m.params.type, txt });
        } catch (e) { }
      }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('cdp timeout ' + method)); } }, 8000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return null;
    return r.result && r.result.value;
  }
}

const PROBE = `(() => {
  const v = document.getElementById('vid') || document.getElementById('v');
  const s = document.getElementById('stat') || document.getElementById('s');
  const pc = window.__pc264 || window.__pc;
  return {
    text: s ? String(s.textContent || '') : '',
    vw: v ? (v.videoWidth || 0) : 0,
    vh: v ? (v.videoHeight || 0) : 0,
    rs: v ? v.readyState : -1,
    ct: v ? Number(v.currentTime || 0) : -1,
    ice: pc ? String(pc.iceConnectionState || '') : '',
    param: (() => { try { return new URLSearchParams(location.search).get('rtc264'); } catch (e) { return null; } })()
  };
})()`;

let chrome = null;
let profileDir = null;

async function openTarget(url) {
  const enc = encodeURIComponent(url);
  let created;
  try { created = JSON.parse(await req('PUT', '/json/new?' + enc)); } catch (e) { created = JSON.parse(await req('GET', '/json/new?' + enc)); }
  await sleep(300);
  const list = JSON.parse(await req('GET', '/json/list'));
  const t = list.find((x) => x.id === (created && created.id)) || list.find((x) => x.type === 'page' && x.url.startsWith('http'));
  if (!t || !t.webSocketDebuggerUrl) throw new Error('拿不到 target ws');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
  const cdp = new CDP(ws);
  try { await cdp.send('Runtime.enable'); } catch (e) { }
  return { id: t.id, cdp, ws };
}

async function main() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rtc264-e2e-'));
  chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank'
  ], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await req('GET', '/json/version'); ready = true; break; } catch (e) { await sleep(250); }
  }
  if (!ready) throw new Error('Chrome 调试端口没起来');

  const target = await openTarget(URL_TO_OPEN);
  await sleep(500);
  const t0 = Date.now();
  let last = null, firstVideoAt = 0, ctAt = 0, ct0 = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    last = await target.cdp.eval(PROBE).catch(() => null);
    if (last && last.vw > 0 && !firstVideoAt) { firstVideoAt = Date.now() - t0; ct0 = last.ct; }
    if (firstVideoAt && last && last.ct > ct0 + 0.15 && !ctAt) ctAt = Date.now() - t0;
    if (ctAt) break;
    await sleep(400);
  }
  const firstOk = !!(ctAt);
  let soakOk = null, soakBad = 0, soakSamples = 0, soakCt0 = 0;
  let stallLongest = 0, recoverMs = 0;
  if (SOAK > 0 && last) {
    // 稳定性浸泡：持续观察画面是否还在走（videoWidth 不归零、currentTime 继续前进）
    soakCt0 = last.ct;
    let prevCt = last.ct, stallStart = 0;
    const t2 = Date.now();
    while (Date.now() - t2 < SOAK * 1000) {
      await sleep(2000);
      const p = await target.cdp.eval(PROBE).catch(() => null);
      soakSamples++;
      const ct = p ? p.ct : -1;
      if (!p || !p.vw || !(ct > prevCt + 0.02)) {
        soakBad++;
        if (!stallStart) stallStart = Date.now();
        const d = Date.now() - stallStart;
        if (d > stallLongest) stallLongest = d;
      } else {
        if (stallStart) { recoverMs = Date.now() - stallStart; stallStart = 0; }
        prevCt = ct;
      }
      if (p) last = p;
    }
    const p2 = await target.cdp.eval(PROBE).catch(() => null);
    if (p2) last = p2;
    soakOk = soakSamples > 0 && soakBad === 0;
  }
  const firstReport = {
    ok: firstOk, url: URL_TO_OPEN, vw: last && last.vw, vh: last && last.vh,
    text: last && last.text, ice: last && last.ice, param: last && last.param,
    firstVideoMs: firstVideoAt, playingMs: ctAt,
    soakOk: soakOk, soakBad: soakBad, soakSamples: soakSamples,
    stallLongestMs: stallLongest, recoverMs: recoverMs,
    consoleLogs: (target.cdp.logs || []).filter((l) => /rtc264|WebRTC|h264|fallback|等待|重连/i.test(l.txt)).slice(-40).map((l) => Math.round(l.t - t0) + 'ms ' + l.txt),
    reloadOk: null, seconds: Number(((Date.now() - t0) / 1000).toFixed(1))
  };

  if (RELOAD) {
    // 刷新页面：旧版侧车复用同一条 PC，刷新后永远协商不上；新版每次 /offer 新建 PC。
    await target.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(800);
    const t1 = Date.now();
    let last2 = null, vw2 = 0, ct2 = 0, ctBase = 0;
    while (Date.now() - t1 < SECONDS * 1000) {
      last2 = await target.cdp.eval(PROBE).catch(() => null);
      if (last2 && last2.vw > 0 && !vw2) { vw2 = last2.vw; ctBase = last2.ct; }
      if (vw2 && last2 && last2.ct > ctBase + 0.15) { ct2 = Date.now() - t1; break; }
      await sleep(400);
    }
    firstReport.reloadOk = !!ct2;
    firstReport.reloadMs = ct2;
    firstReport.reloadText = last2 && last2.text;
  }

  // 收起
  try { await req('GET', '/json/close/' + target.id); } catch (e) { }
  try { target.ws.close(); } catch (e) { }
  console.log(JSON.stringify(firstReport));
}

main().then(() => { try { chrome.kill(); } catch (e) { } try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { } process.exit(0); })
  .catch((e) => { console.error('E2E FAIL: ' + (e && e.message)); try { chrome.kill(); } catch (x) { } process.exit(1); });
