// recovery-test.mjs —— 崩溃恢复压测：编码器被杀后多久恢复出图。
//
// 为什么单独测：稳定性压测覆盖"接口/切档/重连"，但**编码器进程死掉**是最常见的线上事故形态
// （NVENC 错误、驱动更新、显存不足），恢复时间直接等于用户黑屏时长。
//
// 判定口径（服务端信号，不依赖手机 30 秒一次的上报）：
//   ① t_encoder：杀掉后编码器进程重新拉起的时间（/h264-streams 的 proc）
//   ② t_frames ：重新开始产帧的时间（/h264-status 的 kf.n > 0，5 秒统计窗口）
//
// 用法：node release-tools/recovery-test.mjs --rounds 3
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEY = arg('key', '43ed48b48f6f3d8665faddf9d33555b4');
const BASE = arg('base', 'http://127.0.0.1:8660');
const ROUNDS = Number(arg('rounds', '3'));
const K = (s) => s + (s.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(p, ms = 4000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(BASE + K(p), { signal: ac.signal, cache: 'no-store' }); return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}
function killEncoders() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '(Get-Process ffmpeg -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8' });
    const n = Number(String(out).trim()) || 0;
    if (n > 0) execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Stop-Process -Name ffmpeg -Force -ErrorAction SilentlyContinue'], { encoding: 'utf8' });
    return n;
  } catch { return -1; }
}

(async () => {
  const rows = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const st0 = await getJson('/h264-streams');
    if (!st0 || !st0.primary || !st0.primary.sessions) {
      console.log('第 ' + r + ' 轮：没有观众连入，跳过（恢复要靠真实会话触发）');
      continue;
    }
    const n0 = killEncoders();
    const t0 = Date.now();
    let tEnc = 0, tFrames = 0;
    for (let i = 0; i < 100; i++) {          // 最多等 25 秒
      await sleep(250);
      const s = await getJson('/h264-streams', 2500);
      const proc = !!(s && s.primary && s.primary.proc);
      if (proc && !tEnc) tEnc = Date.now() - t0;
      const st = await getJson('/h264-status', 2500);
      const n = st && st.kf ? st.kf.n : 0;
      if (tEnc && n > 0) { tFrames = Date.now() - t0; break; }
    }
    const ok = tFrames > 0 && tFrames <= 8000;
    rows.push({ round: r, killed: n0, tEncMs: tEnc, tFramesMs: tFrames, ok });
    console.log('第 ' + r + ' 轮：杀掉 ' + n0 + ' 个编码器 → 进程拉起 ' + (tEnc || '超时') + 'ms，重新产帧 ' + (tFrames || '超时') + 'ms '
      + (tFrames && tFrames <= 8000 ? '✅' : '❌'));
    await sleep(2500);
  }
  const ok = rows.length > 0 && rows.every((x) => x.ok);
  console.log('\n结果：' + rows.length + ' 轮有效，' + (ok ? '全部在 8 秒内恢复' : '有不达标项'));
  console.log(JSON.stringify(rows));
  process.exit(ok ? 0 : 1);
})();
