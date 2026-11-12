// stress-test.mjs —— 轻屏压力测试台（2026-11-11，第二版：按字节游标统计增量）
//
// 目标：在"高负载 / 长时间"下把只在边缘条件下才暴露的问题逼出来，并给出可判定的达标报告。
// 设计原则：
//   ① 只打**产品自己的 HTTP 接口**、读**日志增量**、采进程指标，不注入假数据、不改产品代码；
//   ② 每个场景都是"真实用户会做的事"（切画质、进出、接口轮询），不是压测 payload；
//   ③ 日志用**字节游标**逐次取增量（第一版把整个 tail 里所有 dropB 加起来，数字虚高且不可比）；
//   ④ 结束给表格 + JSON，便于"改完再跑一次"横向对比。
//
// 用法：
//   node release-tools/stress-test.mjs --scenario soak    --minutes 5
//   node release-tools/stress-test.mjs --scenario api     --minutes 3
//   node release-tools/stress-test.mjs --scenario quality --minutes 3
//   node release-tools/stress-test.mjs --scenario churn   --minutes 3
//   node release-tools/stress-test.mjs --scenario dual    --minutes 3
//   node release-tools/stress-test.mjs --scenario all     --minutes 20
//
// 退出码：0 = 达标；1 = 有指标不达标；2 = 异常。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.join(process.env.LOCALAPPDATA || '', 'PhoneAccess');
const LOG_SERVER = path.join(PROD, 'screen-server.log');
const LOG_SIDECAR = path.join(PROD, 'rtc-h264', 'sidecar.log');
const LOG_AUDIO = path.join(PROD, 'audio.log');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const KEY = arg('key', '43ed48b48f6f3d8665faddf9d33555b4');
const SCEN = arg('scenario', 'soak');
const MINUTES = Number(arg('minutes', '3'));
const BASE = arg('base', 'http://127.0.0.1:8660');
const CLIENT = arg('client', 'stress-' + Math.random().toString(36).slice(2, 8));
const REQUIRE_VIEWER = arg('requireViewer', '0') === '1';

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

async function getJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ac.signal, cache: 'no-store' }); return await r.json(); }
  catch (e) { return null; }
  finally { clearTimeout(t); }
}
async function postJson(url, body, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal, cache: 'no-store' });
    return await r.json();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
const K = (s) => s + (s.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY);

// 文件大小
function fileSize(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }

// 从字节偏移读到末尾（最多 maxBytes），返回 { lines, next }
function readFrom(f, offset, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(f);
    if (st.size <= offset) return { lines: [], next: st.size };
    const start = Math.max(offset, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return { lines: buf.toString('utf8').split('\n'), next: st.size };
  } catch (e) { return { lines: [], next: offset }; }
}

// ---------- 日志增量累加器 ----------
const cursor = { server: 0, audio: 0, sidecar: 0 };
function resetCursors() {
  cursor.server = fileSize(LOG_SERVER);
  cursor.audio = fileSize(LOG_AUDIO);
  cursor.sidecar = fileSize(LOG_SIDECAR);
}
const acc = {
  lag: 0, stopEvents: 0, ffmpegStart: 0, ffmpegExit: 0, qualityChange: 0,
  deferTeardown: 0, secondClose: 0, audioDropB: 0, audioWriteTimeout: 0,
  viewerConnected: 0, viewerClosed: 0, sessionClosed: 0, audioSnap: 0,
};
function pumpLogs() {
  const s = readFrom(LOG_SERVER, cursor.server); cursor.server = s.next;
  for (const l of s.lines) {
    if (l.includes('[lag]')) acc.lag++;
    if (l.includes('[rtc264-stop]')) acc.stopEvents++;
    if (l.includes('h264: start')) acc.ffmpegStart++;
    if (l.includes('ffmpeg exit')) acc.ffmpegExit++;
    if (l.includes('画质变更')) acc.qualityChange++;
    if (l.includes('先不拆')) acc.deferTeardown++;
    if (l.includes('[第二路] 关闭')) acc.secondClose++;
    if (l.includes('rtc: viewer connected')) acc.viewerConnected++;
    if (l.includes('rtc: viewer closed')) acc.viewerClosed++;
  }
  const a = readFrom(LOG_AUDIO, cursor.audio); cursor.audio = a.next;
  for (const l of a.lines) {
    const m = /dropB=(\d+)/.exec(l);
    if (m) acc.audioDropB += Number(m[1]);
    if (l.includes('write timeout')) acc.audioWriteTimeout++;
  }
  const sd = readFrom(LOG_SIDECAR, cursor.sidecar); cursor.sidecar = sd.next;
  for (const l of sd.lines) {
    if (l.includes('关闭（')) acc.sessionClosed++;
    if (l.includes('贴回真实时间')) acc.audioSnap++;
  }
}
const accSnap = () => JSON.parse(JSON.stringify(acc));

// 进程内存（MB）
function procs() {
  const out = { node: 0, ffmpeg: 0, sidecar: 0, audio: 0 };
  try {
    const csv = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    for (const line of csv.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","\s*([\d,]+) K"/.exec(line);
      if (!m) continue;
      const img = m[1].toLowerCase();
      const mb = Number(m[3].replace(/,/g, '')) / 1024;
      if (!Number.isFinite(mb)) continue;
      if (img === 'ffmpeg.exe') out.ffmpeg += mb;
      else if (img === 'rtc-h264.exe') out.sidecar += mb;
      else if (img === 'audio.exe') out.audio += mb;
      else if (img === 'node.exe') out.node += mb;
    }
  } catch (e) { }
  return out;
}

// ---------- 采样 ----------
const samples = [];
let maxSessions = 0, maxFps = 0, minFps = 1e9;
async function sample(label) {
  pumpLogs();
  const [health, status, streams] = await Promise.all([
    getJson('http://127.0.0.1:9801/health', 5000),
    getJson(K(BASE + '/h264-status'), 8000),
    getJson(K(BASE + '/h264-streams'), 8000),
  ]);
  const s = {
    t: now(), label,
    sessions: health ? health.sessions : null,
    framesIn: health ? health.framesIn : null,
    dropped: health ? health.dropped : null,
    fps: status ? status.fps : null,
    cad: status && status.feedCad ? status.feedCad : null,
    secondOn: streams && streams.second ? streams.second.on : null,
    primarySessions: streams && streams.primary ? streams.primary.sessions : null,
    secondSessions: streams && streams.second ? streams.second.sessions : null,
    mem: procs(),
    acc: accSnap(),
  };
  if (typeof s.sessions === 'number' && s.sessions > maxSessions) maxSessions = s.sessions;
  if (typeof s.fps === 'number' && s.sessions > 0) { maxFps = Math.max(maxFps, s.fps); minFps = Math.min(minFps, s.fps); }
  samples.push(s);
  return s;
}

// ---------- 场景动作 ----------
const actions = [];
function every(ms, fn) {
  const a = { ms, fn, timer: null };
  actions.push(a);
  return a;
}
function startActions() { for (const a of actions) a.timer = setInterval(() => { try { a.fn(); } catch (e) { } }, a.ms); }
function stopActions() { for (const a of actions) { if (a.timer) clearInterval(a.timer); a.timer = null; } }

const QC = { fps: 120, width: 1920, kbps: 50000 };
async function setQuality(patch) {
  Object.assign(QC, patch || {});
  // 先认领线路，拿到**实际分到的 stream** 再改档位。
  // 关键：手机占着主路时，我们作为第二台设备会分到 stream=2；若仍按 stream=1 提交，
  // 服务端当成"共享主路的访客"直接拒绝（shared:true），压测就变成空转。
  const pick = await postJson(K(BASE + '/h264-stream-pick'), { client: CLIENT, width: QC.width, fps: QC.fps, kbps: QC.kbps });
  const stream = pick && pick.stream ? pick.stream : 1;
  const r = await postJson(K(BASE + '/h264-quality'), { width: QC.width, fps: QC.fps, kbps: QC.kbps, client: CLIENT, stream: stream });
  return { pick, stream, r };
}

function buildScenario(name) {
  if (name === 'soak') return { desc: '纯浸泡：不做任何动作，只观测（长时间稳定性 / 内存泄漏）' };
  if (name === 'api') {
    every(2000, () => { fetch(K(BASE + '/sources'), { cache: 'no-store' }).catch(() => { }); });
    every(1000, () => { fetch(K(BASE + '/h264-status'), { cache: 'no-store' }).catch(() => { }); });
    every(1000, () => { fetch('http://127.0.0.1:9801/health').catch(() => { }); });
    return { desc: '接口轰炸：/sources 每 2s、/h264-status 每 1s、/health 每 1s（测事件循环卡顿）' };
  }
  if (name === 'quality') {
    let i = 0;
    const plan = [
      { fps: 120, width: 1920, kbps: 50000 },
      { fps: 60, width: 1920, kbps: 30000 },
      { fps: 240, width: 1920, kbps: 80000 },
      { fps: 120, width: 2560, kbps: 60000 },
    ];
    every(6000, () => { setQuality(plan[i++ % plan.length]); });
    return { desc: '画质横跳：帧率/分辨率/码率每 6 秒换一次（测编码器重建次数与恢复）' };
  }
  if (name === 'churn') {
    let on = false;
    every(10000, async () => {
      on = !on;
      await postJson(K(BASE + '/h264-stream-pick'), {
        client: on ? CLIENT : ('other-' + Math.random().toString(36).slice(2, 8)),
        width: 1280, fps: 60, kbps: 12000,
      });
    });
    return { desc: '观众进出：每 10 秒换一次客户端身份（模拟第二路反复进出）' };
  }
  if (name === 'dual') {
    (async () => { await sleep(3000); await postJson(K(BASE + '/h264-stream-pick'), { client: 'dual-B', width: 1280, fps: 60, kbps: 12000 }); })();
    return { desc: '两路：拉一个假第二路占位并保持（观察两路建立/保持/空闲回收）' };
  }
  return { desc: '未知场景，按纯浸泡处理' };
}

// ---------- 单场景 ----------
function diffAcc(a, b) {
  const d = {};
  for (const k of Object.keys(b)) d[k] = (b[k] || 0) - (a[k] || 0);
  return d;
}
async function runScenario(name) {
  actions.length = 0;
  const info = buildScenario(name);
  console.log('\n================ 场景 ' + name + ' ================');
  console.log('  ' + info.desc);
  console.log('  时长 ' + MINUTES + ' 分钟，每 2 秒采样；client=' + CLIENT);

  resetCursors();
  acc && Object.keys(acc).forEach((k) => { acc[k] = 0; });
  if (name !== 'soak') await setQuality({ fps: 120, width: 1920, kbps: 50000 });

  const s0 = await sample(name + ':start');
  startActions();
  const t0 = now();
  const until = t0 + MINUTES * 60 * 1000;
  let n = 0;
  while (now() < until) {
    await sleep(2000);
    const s = await sample(name);
    n++;
    if (n % 5 === 0) {
      const cad = s.cad ? (' cad p50=' + s.cad.p50 + '/p90=' + s.cad.p90) : '';
      console.log('  [' + String(Math.round((now() - t0) / 1000)).padStart(4) + 's] 会话=' + String(s.sessions)
        + ' 帧率=' + String(s.fps) + ' dropped=' + String(s.dropped) + ' 第二路=' + (s.secondOn ? 'on' : 'off') + cad
        + ' | node=' + fmt(s.mem.node, 0) + ' ffmpeg=' + fmt(s.mem.ffmpeg, 0) + ' sidecar=' + fmt(s.mem.sidecar, 0) + 'MB');
    }
  }
  stopActions();
  await sleep(1500);
  const s1 = await sample(name + ':end');
  return { name, s0, s1 };
}

// ---------- 主流程 ----------
async function main() {
  console.log('轻屏压力测试台');
  console.log('  服务 ' + BASE + '   client=' + CLIENT);
  console.log('  日志 ' + LOG_SERVER);
  const plans = SCEN === 'all' ? ['soak', 'api', 'quality', 'churn', 'dual'] : [SCEN];
  const results = {};
  for (const p of plans) {
    const r = await runScenario(p);
    const d = diffAcc(r.s0.acc, r.s1.acc);
    results[p] = {
      desc: '', samples: samples.filter((s) => s.label === p).length,
      lag: d.lag, stopEvents: d.stopEvents, ffmpegStart: d.ffmpegStart, ffmpegExit: d.ffmpegExit,
      qualityChange: d.qualityChange, deferTeardown: d.deferTeardown, secondClose: d.secondClose,
      audioDropB: d.audioDropB, audioWriteTimeout: d.audioWriteTimeout, audioSnap: d.audioSnap,
      viewerConnected: d.viewerConnected, viewerClosed: d.viewerClosed, sessionClosed: d.sessionClosed,
      memNode: r.s1.mem.node - r.s0.mem.node,
      memFfmpeg: r.s1.mem.ffmpeg - r.s0.mem.ffmpeg,
      memSidecar: r.s1.mem.sidecar - r.s0.mem.sidecar,
      cad: r.s1.cad,
    };
  }

  console.log('\n==================== 结果汇总 ====================');
  for (const p of plans) {
    const r = results[p];
    console.log('\n【' + p + '】 采样 ' + r.samples + ' 次');
    console.log('  事件循环卡顿 [lag]        : ' + r.lag + (r.lag > 0 ? '   ← 应为 0' : ''));
    console.log('  连接重建 [rtc264-stop]    : ' + r.stopEvents + '   （观众连上/断开 ' + r.viewerConnected + '/' + r.viewerClosed + '）');
    console.log('  编码器 h264:start / exit  : ' + r.ffmpegStart + ' / ' + r.ffmpegExit);
    console.log('  画质变更                  : ' + r.qualityChange);
    console.log('  「先不拆」/ 第二路关闭    : ' + r.deferTeardown + ' / ' + r.secondClose);
    console.log('  音频丢字节 / 管道写超时   : ' + r.audioDropB + ' / ' + r.audioWriteTimeout + '   （时间戳贴回 ' + r.audioSnap + ' 次）');
    console.log('  feedCad p50/p90/max       : ' + (r.cad ? (r.cad.p50 + ' / ' + r.cad.p90 + ' / ' + r.cad.max + ' ms') : '-'));
    console.log('  内存增量 node/ffmpeg/sidecar : ' + fmt(r.memNode, 1) + ' / ' + fmt(r.memFfmpeg, 1) + ' / ' + fmt(r.memSidecar, 1) + ' MB');
  }

  console.log('\n==================== 达标判定 ====================');
  const fails = [];
  for (const p of plans) {
    const r = results[p];
    if (r.lag > 0) fails.push(p + ': 事件循环卡顿 ' + r.lag + ' 次');
    if (r.audioWriteTimeout > 0) fails.push(p + ': 音频管道写超时 ' + r.audioWriteTimeout + ' 次');
    if (r.memNode > 200) fails.push(p + ': node 内存增长 ' + fmt(r.memNode, 0) + 'MB');
    if (r.ffmpegStart > 60) fails.push(p + ': 编码器启动 ' + r.ffmpegStart + ' 次（过频）');
  }
  if (maxSessions === 0) console.log('  ⚠ 本次全程没有观众连入：**视频/音频链路没被压到**，只用来看接口与内存。');
  else console.log('  观众峰值会话数 ' + maxSessions + '，帧率区间 ' + (Number.isFinite(minFps) ? minFps : '-') + '~' + maxFps + ' fps');
  if (!fails.length) console.log('  ✅ 全部达标');
  else { console.log('  ❌ 不达标项：'); fails.forEach((f) => console.log('    - ' + f)); }

  const outDir = path.join(__dirname, '..', 'stress-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, 'stress-' + plans.join('-') + '-' + stamp + '.json');
  fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), base: BASE, client: CLIENT, minutes: MINUTES, plans, results, maxSessions, samples }, null, 1), 'utf8');
  console.log('\n明细: ' + outFile);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('压测异常: ' + ((e && e.stack) || e)); process.exit(2); });
