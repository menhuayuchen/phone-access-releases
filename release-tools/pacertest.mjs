// pacertest.mjs —— 展示节奏调度器的离线验证（虚拟时钟，不依赖浏览器）
//
// 为什么这样测：真实的 rAF 在标签页 hidden 时会被浏览器挂起，没法在后台复现；
// 而调度算法的正确性只取决于"帧到达时刻"和"rAF 频率"，所以用虚拟时钟精确驱动即可，
// 而且能一次性覆盖 30/60/120/240 四个帧率，可复现、可回归。
//
// 用法: node pacertest.mjs [page.mjs 路径]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pagePath = process.argv[2] || path.join(__dirname, '..', 'app', 'page.mjs');
const src = fs.readFileSync(pagePath, 'utf8');

// —— 抽出 PQ 段（从 const PQ = { 到 fps 校准注释之前） ——
const start = src.indexOf('const PQ = {');
if (start < 0) { console.error('找不到 const PQ 定义'); process.exit(2); }
const endMark = '// 2026-11-11：worker 的合成时间戳步长';
const end = src.indexOf(endMark, start);
if (end < 0) { console.error('找不到 PQ 段结尾标记'); process.exit(2); }
const code = src.slice(start, end);

function runCase(fps, opts) {
  const periodMs = 1000 / fps;
  const rafHz = Number(process.env.RAF || 0) || opts.rafHz || 240;
  const seconds = opts.seconds || 4;
  const jitter = opts.jitter || 0.6;   // 成簇到达的强度

  // —— 虚拟时钟与事件队列 ——
  let now = 0;
  let rafId = 0;
  const events = [];
  const perf = { now: () => now };
  function push(t, fn, id) { events.push({ t, fn, id: id || 0 }); }
  function requestAnimationFrame(fn) { const id = ++rafId; push(now + 1000 / rafHz, fn, id); return id; }
  function cancelAnimationFrame(id) { const i = events.findIndex((e) => e.id === id); if (i >= 0) events.splice(i, 1); }

  // —— 假的 canvas / ctx / WC264 ——
  const draws = [];
  const canvas = { width: 0, height: 0 };
  const ctx = { drawImage() { draws.push(now); } };
  const wc = { on: true, canvas, ctx, frames: 0, lastFrameAt: 0, restarts: 0, gaveUp: false };

  // —— 载入被测代码 ——
  const factory = new Function(
    'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', '_rafHz',
    code + '\n; return { PQ: PQ, pqPush: pqPush, pqStop: pqStop };'
  );
  const api = factory({ __wc264: wc }, perf, requestAnimationFrame, cancelAnimationFrame, rafHz);

  // —— 按成簇模式投放帧（平均间隔 = periodMs，但一半挤在一半、一半拉开） ——
  // 成簇模式取自线上实测：p50 ≈ 0.6×period、p90 ≈ 1.9×period（120fps 下 5.2ms / 15.4ms）。
  let t = 0;
  let k = 0;
  const frames = [];
  while (t < seconds * 1000) {
    const sparse = (k % 2) === 1;
    const d = sparse ? periodMs * (1 + jitter * 0.75) : periodMs * (1 - jitter * 0.75);
    t += Math.max(0.5, d);
    k++;
    const f = { displayWidth: 1920, displayHeight: 1200, close() { } };
    frames.push(t);
    push(t, () => { api.pqPush(f, t * 1000); });
  }

  // —— 跑虚拟时间 ——
  let guard = 0;
  while (events.length && guard++ < 2_000_000) {
    events.sort((a, b) => a.t - b.t);
    const e = events.shift();
    if (e.t > seconds * 1000 + 500) break;
    now = e.t;
    try { e.fn(); } catch (err) { console.error('  !! 回调异常: ' + err.message); }
  }

  // —— 统计呈现间隔 ——
  if (process.env.DUMP === '1') {
    const head = [];
    for (let i = 1; i < Math.min(draws.length, 26); i++) head.push(+(draws[i] - draws[i - 1]).toFixed(2));
    console.log('    [前25个间隔] ' + head.join(' '));
  }
  const iv = [];
  for (let i = 1; i < draws.length; i++) iv.push(draws[i] - draws[i - 1]);
  iv.sort((a, b) => a - b);
  const n = iv.length;
  const sum = iv.reduce((a, b) => a + b, 0);
  const pct = (p) => iv[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];
  const within = iv.filter((v) => Math.abs(v - periodMs) < periodMs * 0.35).length;
  return {
    fps, periodMs: +periodMs.toFixed(2),
    framesSent: frames.length,
    draws: draws.length,
    drawRate: +(draws.length / seconds).toFixed(1),
    avg: +(sum / n).toFixed(2),
    p50: +pct(0.5).toFixed(2), p90: +pct(0.9).toFixed(2), p99: +pct(0.99).toFixed(2),
    max: +iv[n - 1].toFixed(2),
    within: pct(0) === undefined ? 0 : +(within / n * 100).toFixed(0),
    over15: iv.filter((v) => v > periodMs * 1.5).length,
    under05: iv.filter((v) => v < periodMs * 0.5).length,
    pqOver: api.PQ.over, pqUnder: api.PQ.under, boost: api.PQ.boost, periodUs: Math.round(api.PQ.periodUs),
  };
}

console.log('=== 调度器离线验证（成簇到达 p50≈0.6×period / p90≈1.9×period，rAF ' + (process.env.RAF||240) + 'Hz）===');
for (const fps of [30, 60, 90, 120, 240]) {
  const r = runCase(fps, { seconds: 4 });
  console.log(
    String(fps).padStart(4) + 'fps | 发送 ' + String(r.framesSent).padStart(4) +
    ' 画出 ' + String(r.draws).padStart(4) + ' (' + r.drawRate + '/s)' +
    ' | 间隔 p50=' + r.p50 + ' p90=' + r.p90 + ' p99=' + r.p99 + ' max=' + r.max + ' (期望 ' + r.periodMs + ')' +
    ' | 容差内 ' + r.within + '%' +
    ' | 超长 ' + r.over15 + ' 过挤 ' + r.under05 +
    ' | 丢弃 ' + r.pqOver + ' 欠载 ' + r.pqUnder + ' boost=' + r.boost + ' periodUs=' + r.periodUs
  );
}
