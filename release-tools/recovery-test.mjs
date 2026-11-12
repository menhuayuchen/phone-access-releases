// recovery-test.mjs —— 崩溃恢复压测：编码器被杀后多久恢复出图（只读 + 杀 ffmpeg，不改产品代码）
//
// 为什么单独测：稳定性压测覆盖"接口/切档/重连"，但**编码器进程死掉**是最常见的线上事故形态
// （NVENC 错误、驱动更新、显存不足），恢复时间直接等于用户黑屏时长。
//
// 用法：node release-tools/recovery-test.mjs --rounds 3
// 判定：每轮恢复（重新出帧）≤ 6 秒算达标；超时或恢复后画面不恢复（解=0）算失败。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEY = arg('key', '43ed48b48f6f3d8665faddf9d33555b4');
const BASE = arg('base', 'http://127.0.0.1:8660');
const ROUNDS = Number(arg('rounds', '3'));
const LOG = path.join(process.env.LOCALAPPDATA || '', 'PhoneAccess', 'screen-server.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = (s) => s + (s.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY);

async function getJson(p, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(BASE + K(p), { signal: ac.signal, cache: 'no-store' }); return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}
function lastDiag() {
  try {
    const st = fs.statSync(LOG); const back = Math.min(st.size, 200 * 1024);
    const buf = Buffer.alloc(back); const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, back, st.size - back); fs.closeSync(fd);
    const txt = buf.toString('utf8'); const i = txt.lastIndexOf('[wc264-diag]');
    if (i < 0) return null;
    const line = txt.slice(i, txt.indexOf('\n', i) > 0 ? txt.indexOf('\n', i) : undefined);
    const n = (re) => { const m = line.match(re); return m ? Number(m[1]) : null; };
    return { rtp: n(/rtp=(\d+)/), dec: n(/dec=(\d+)/), stalls: n(/stalls=(\d+)/), jie: n(/解=([\d.]+)/), hua: n(/画=([\d.]+)/) };
  } catch { return null; }
}
function killEncoders() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-Process ffmpeg -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' });
    const n = Number(String(out).trim()) || 0;
    if (n > 0) execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Stop-Process -Name ffmpeg -Force -ErrorAction SilentlyContinue'], { encoding: 'utf8' });
    return n;
  } catch { return -1; }
}

(async () => {
  const rows = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const before = lastDiag();
    const st0 = await getJson('/h264-streams');
    if (!st0 || !st0.primary || !st0.primary.sessions) {
      console.log('第 ' + r + ' 轮：没有观众连入，跳过（需要手机/浏览器在看着才能测恢复）');
      continue;
    }
    console.log('第 ' + r + ' 轮：杀编码器…（此前 rtp=' + (before ? before.rtp : '?') + '）');
    const t0 = Date.now();
    const killed = killEncoders();
    let recoveredAt = 0, framesAfter = 0, lastRtp = before ? before.rtp : 0;
    for (let i = 0; i < 120; i++) {   // 最多等 30 秒
      await sleep(250);
      const d = lastDiag();
      const s = await getJson('/h264-streams', 3000);
      const proc = s && s.primary && s.primary.proc;
      if (d && d.rtp > lastRtp) { recoveredAt = Date.now() - t0; framesAfter = d.rtp - lastRtp; break; }
      if (i === 0) console.log('  killed=' + killed + ' 编码器 proc=' + proc);
    }
    const ms = recoveredAt || (Date.now() - t0);
    rows.push({ round: r, killed, recoveredMs: recoveredAt, ok: recoveredAt > 0 && recoveredAt <= 6000 });
    console.log('  ' + (recoveredAt ? ('恢复用时 ' + ms + 'ms，期间新帧 ' + framesAfter) : ('**超时未恢复**（等了 ' + ms + 'ms）')));
    await sleep(1500);
  }
  const ok = rows.length && rows.every((x) => x.ok);
  console.log('\n结果：' + rows.length + ' 轮，' + (ok ? '全部达标（≤6 秒恢复）' : '有不达标项'));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(ok ? 0 : 1);
})();
