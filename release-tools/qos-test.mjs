// qos-test.mjs —— 轻屏画质/音画质量压测（2026-11-12）
//
// 和 stress-test.mjs 的分工：
//   stress-test.mjs  测**稳定性**（卡顿、内存、编码器重建、接口阻塞）
//   qos-test.mjs     测**质量**（缓冲深度、画面连贯性、音画延迟、高压下的表现）
//
// 数据来源（全部是产品自己已经在报的，不注入假数据）：
//   ① /health             侧车的音频队列、丢帧、编码错误
//   ② /h264-status        编码器档位、fps、feedCad（服务端产帧节奏）
//   ③ /h264-streams       两路状态
//   ④ 屏幕日志 [wc264-diag] 手机端每 30 秒上报一次：
//        raf=屏幕刷新率 解=解码fps 画=画布fps buf=缓冲ms
//        cad=到达帧统计 avg/p90/max  over/under=调度器丢帧/欠载  stalls=呈现停摆自愈次数
//      这是"用户体验"的直接证据，比任何间接指标都准。
//   ⑤ audio.log           音频丢字节 / 写超时 / 采样率漂移
//
// 用法：
//   node release-tools/qos-test.mjs --minutes 10
//   node release-tools/qos-test.mjs --minutes 3 --ramp 60,120,240   （自定义档位阶梯）
//
// 退出码：0 达标 / 1 有不达标项 / 2 异常。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.join(process.env.LOCALAPPDATA || '', 'PhoneAccess');
const LOG_SERVER = path.join(PROD, 'screen-server.log');
const LOG_AUDIO = path.join(PROD, 'audio.log');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEY = arg('key', '43ed48b48f6f3d8665faddf9d33555b4');
const BASE = arg('base', 'http://127.0.0.1:8660');
const MINUTES = Number(arg('minutes', '10'));
const RAMP = arg('ramp', '60,120,240').split(',').map((x) => Number(x.trim())).filter((x) => x >= 30);
const CLIENT = arg('client', 'qos-' + Math.random().toString(36).slice(2, 8));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const K = (s) => s + (s.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-');

async function getJson(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, cache: 'no-store' }); return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}
async function postJson(url, body, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal, cache: 'no-store' });
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function fileSize(f) { try { return fs.statSync(f).size; } catch { return 0; } }
function readFrom(f, off, max = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(f);
    if (st.size <= off) return { text: '', next: st.size };
    const start = Math.max(off, st.size - max);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), next: st.size };
  } catch { return { text: '', next: off }; }
}

// ---------- 手机端诊断解析（一行一条） ----------
function parseDiag(line) {
  const num = (re) => { const m = re.exec(line); return m ? Number(m[1]) : NaN; };
  if (!/; wv\)/.test(line) && !/Android/.test(line)) return null;   // 只看手机端（含 APK WebView）
  const o = {
    raf: num(/raf=(\d+)/), dec: num(/解=([\d.]+)/), draw: num(/画=([\d.]+)/),
    buf: num(/buf=(\d+)ms/), cadAvg: num(/avg=([\d.]+)/), cadP90: num(/p90=([\d.]+)/),
    cadMax: num(/max=([\d.]+)/), over: num(/over=(\d+)/), under: num(/under=(\d+)/),
    stalls: num(/stalls=(\d+)/), lost: num(/lost=(\d+)/), pli: num(/pli=(\d+)/),
    wc: /wc=1/.test(line) ? 1 : 0, vid: num(/vid=([\d.]+)/),
  };
  return Number.isFinite(o.dec) ? o : null;
}

// ---------- 音频 ----------
const AUDIO_BLOCK_MS = 10;   // 100 块/秒
async function audioState() {
  const al = readFrom(LOG_AUDIO, fileSize(LOG_AUDIO) - 256 * 1024).text.split('\n');
  let dropB = 0, timeout = 0, rate = 0, step = 0;
  for (const l of al) {
    const d = /dropB=(\d+)/.exec(l); if (d) dropB += Number(d[1]);
    if (/write timeout/.test(l)) timeout++;
    const r = /rate=([\d.]+)/.exec(l); if (r) rate = Number(r[1]);
    const s = /step=([\d.]+)/.exec(l); if (s) step = Number(s[1]);
  }
  return { dropB, timeout, rate, step };
}

// ---------- 主循环 ----------
async function main() {
  console.log('轻屏 画质/音画 质量压测');
  console.log('  服务 ' + BASE + '    client=' + CLIENT);
  console.log('  档位阶梯 ' + RAMP.join(' → ') + ' fps，每档 ' + MINUTES + ' 分钟');

  let diagOff = fileSize(LOG_SERVER);
  let srvOff = fileSize(LOG_SERVER);
  const phases = [];

  for (const fps of RAMP) {
    const phase = { fps, diag: [], lag: 0, restarts: 0, mem: [], health: [], drops: [], bufs: [] };
    console.log('\n======== 档位 ' + fps + 'fps ========');
    await postJson(K(BASE + '/h264-quality'), { client: CLIENT, width: 1920, fps, kbps: fps >= 240 ? 80000 : 50000, stream: 1 });
    await sleep(2500);

    const audio0 = await audioState();   // 基线：音频计数是累计值，必须算增量
    const t0 = now();
    const until = t0 + MINUTES * 60 * 1000;
    let n = 0;
    while (now() < until) {
      await sleep(2000);
      n++;
      // 服务端新增日志
      const s = readFrom(LOG_SERVER, srvOff); srvOff = s.next;
      for (const l of s.text.split('\n')) {
        if (l.includes('[lag]')) phase.lag++;
        if (l.includes('h264: start')) phase.restarts++;
      }
      // 手机端诊断
      const d = readFrom(LOG_SERVER, diagOff); diagOff = d.next;
      for (const l of d.text.split('\n')) {
        const p = parseDiag(l);
        if (p) phase.diag.push(p);
      }
      const h = await getJson('http://127.0.0.1:9801/health', 5000);
      if (h) { phase.health.push(h); phase.drops.push(Number(h.dropped) || 0); }
      const dg = phase.diag[phase.diag.length - 1];
      if (dg) phase.bufs.push(dg.buf);
      if (n % 5 === 0) {
        console.log('  [' + String(Math.round((now() - t0) / 1000)).padStart(4) + 's] '
          + (dg ? ('解=' + f1(dg.dec) + ' 画=' + f1(dg.draw) + ' raf=' + dg.raf + ' 缓=' + dg.buf + 'ms 卡顿=' + (dg.stalls || 0)) : '（还没收到手机端诊断）')
          + ' 编码器重启=' + phase.restarts + ' [lag]=' + phase.lag);
      }
    }
    const a = await audioState();
    phases.push({ ...phase, audio: a, audio0 });
    console.log('  小结：样本 ' + phase.diag.length + ' 条手机诊断，编码器重启 ' + phase.restarts + ' 次，[lag] ' + phase.lag + ' 次');
  }

  // ---------- 汇总 ----------
  console.log('\n================ 质量汇总 ================');
  const fails = [];
  for (const p of phases) {
    const d = p.diag;
    const dec = d.map((x) => x.dec).filter(Number.isFinite);
    const draw = d.map((x) => x.draw).filter(Number.isFinite);
    const raf = d.map((x) => x.raf).filter(Number.isFinite);
    const buf = d.map((x) => x.buf).filter(Number.isFinite);
    const cadP90 = d.map((x) => x.cadP90).filter(Number.isFinite);
    const cadMax = d.map((x) => x.cadMax).filter(Number.isFinite);
    const stalls = d.map((x) => x.stalls).filter(Number.isFinite);
    // 这些都是页面里的**累计计数**（stalls/over/under 自页面加载起），必须取增量
    const stallsDelta = (stalls.length >= 2) ? (stalls[stalls.length - 1] - stalls[0]) : 0;
    const audioDrop = (p.audio.dropB || 0) - ((p.audio0 && p.audio0.dropB) || 0);
    const audioTo = (p.audio.timeout || 0) - ((p.audio0 && p.audio0.timeout) || 0);
    const ratio = avg(raf) > 0 ? avg(draw) / avg(raf) : 0;

    console.log('\n【' + p.fps + 'fps】 手机诊断 ' + d.length + ' 条');
    console.log('  解码 fps      : ' + f1(avg(dec)) + '   (目标 ' + p.fps + ')');
    console.log('  画出 fps      : ' + f1(avg(draw)) + '   屏幕 ' + f1(avg(raf)) + 'Hz → 画出/屏幕 ' + (ratio * 100).toFixed(0) + '%');
    console.log('  缓冲 ms       : 中位 ' + f1(pct(buf, 50)) + ' / p90 ' + f1(pct(buf, 90)) + ' / 最大 ' + f1(Math.max(0, ...buf)));
    console.log('  到达间隔 ms   : p90 ' + f1(avg(cadP90)) + ' / max ' + f1(Math.max(0, ...cadMax)) + '  (理想 ' + f1(1000 / p.fps) + ')');
    console.log('  呈现停摆次数  : ' + Math.max(0, stallsDelta) + '（本档增量）   编码器重启 ' + p.restarts + '   [lag] ' + p.lag);
    console.log('  音频          : 丢 ' + Math.max(0, audioDrop) + ' B / 写超时 ' + Math.max(0, audioTo) + ' 次（本档增量）  采样率 ' + f1(p.audio.rate) + 'Hz');
    console.log('  侧车丢帧累计  : ' + (p.drops.length ? p.drops[p.drops.length - 1] : '-'));

    if (ratio < 0.9) fails.push(p.fps + 'fps: 画出/屏幕 ' + (ratio * 100).toFixed(0) + '% < 90%');
    if (pct(buf, 90) > 80) fails.push(p.fps + 'fps: 缓冲 p90 ' + f1(pct(buf, 90)) + 'ms > 80ms');
    if (stallsDelta > 0) fails.push(p.fps + 'fps: 呈现停摆 ' + stallsDelta + ' 次');
    if (p.lag > 0) fails.push(p.fps + 'fps: 事件循环卡顿 ' + p.lag + ' 次');
    if (audioDrop > 0) fails.push(p.fps + 'fps: 音频丢 ' + audioDrop + 'B');
    if (d.length === 0) fails.push(p.fps + 'fps: 没收到手机端诊断（页面没在跑？）');
  }

  console.log('\n================ 达标判定 ================');
  if (!fails.length) console.log('  ✅ 全部达标');
  else { console.log('  ❌ 不达标项：'); fails.forEach((f) => console.log('    - ' + f)); }

  const outDir = path.join(__dirname, '..', 'stress-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(outDir, 'qos-' + stamp + '.json');
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(), base: BASE, client: CLIENT, minutes: MINUTES,
    phases: phases.map((p) => ({ fps: p.fps, diag: p.diag, audio: p.audio, lag: p.lag, restarts: p.restarts })),
    fails,
  }, null, 1), 'utf8');
  console.log('\n明细: ' + out);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('异常: ' + ((e && e.stack) || e)); process.exit(2); });
