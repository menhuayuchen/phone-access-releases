// live-sample.mjs —— 线上"关键帧突发 / 呈现连贯性"采样器（只读）
//
// 用途：改编码参数（intra-refresh 开关）时，用同一台机器连续采样，事后按时间分段对比：
//   · 服务端：/h264-status 的 kf（关键帧体积、单帧峰值、>300KB 帧数）、feedCad（产帧节奏）
//   · 手机端：screen-server.log 里的 [wc264-diag] 一行（解/画/cad/under/over/stalls/lost/pli）
//
// 用法：node release-tools/live-sample.mjs --seconds 300 --out .encab/live.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG = path.join(process.env.LOCALAPPDATA || '', 'PhoneAccess', 'screen-server.log');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEY = arg('key', '43ed48b48f6f3d8665faddf9d33555b4');
const BASE = arg('base', 'http://127.0.0.1:8660');
const SECONDS = Number(arg('seconds', '300'));
const OUT = path.join(ROOT, arg('out', '.encab/live.jsonl'));
const EVERY = Number(arg('every', '10'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastDiag() {
  try {
    const st = fs.statSync(LOG);
    const back = Math.min(st.size, 400 * 1024);
    const buf = Buffer.alloc(back);
    const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, back, st.size - back);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const i = txt.lastIndexOf('[wc264-diag]');
    if (i < 0) return null;
    const line = txt.slice(i, txt.indexOf('\n', i) > 0 ? txt.indexOf('\n', i) : undefined);
    const num = (re) => { const m = line.match(re); return m ? Number(m[1]) : null; };
    return {
      on: num(/on=(\d)/), rtp: num(/rtp=(\d+)/), dec: num(/dec=(\d+)/), drop: num(/drop=(\d+)/),
      cfg: num(/cfg=(\d+)/), sps: num(/sps=(\d+)/), gaps: num(/gaps=(\d+)/), ts: num(/ts=(\d+)/),
      cadN: num(/cad=(\d+)/), cadAvg: num(/cad=\d+ avg=([\d.]+)/), cadP90: num(/p90=([\d.]+)/), cadMax: num(/max=([\d.]+)/),
      over: num(/over=(\d+)/), under: num(/under=(\d+)/), lost: num(/lost=(\d+)/), pli: num(/pli=(\d+)/),
      buf: num(/buf=(\d+)ms/), raf: num(/raf=(\d+)Hz/), jie: num(/解=([\d.]+)/), hua: num(/画=([\d.]+)/),
      stalls: num(/stalls=(\d+)/), avalanche: num(/雪崩=(\d+)/), q: num(/q=(\d+)/),
    };
  } catch { return null; }
}

async function status() {
  try {
    const r = await fetch(BASE + '/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' });
    const j = await r.json();
    return { ir: j.ir, fps: j.fps, kbps: j.kbps, w: j.width, h: j.height, viewers: j.viewers, kf: j.kf, feedCad: j.feedCad, lastError: j.lastError };
  } catch (e) { return { err: String(e.message || e) }; }
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const fd = fs.openSync(OUT, 'w');
  const t0 = Date.now();
  console.log('采样 → ' + OUT + '（' + SECONDS + 's，每 ' + EVERY + 's 一次）');
  let prevDiag = null;
  while ((Date.now() - t0) / 1000 < SECONDS) {
    const rec = { t: new Date().toISOString(), at: Date.now() - t0, s: await status(), d: lastDiag() };
    // 顺手算"这一段的增量"，事后不用手算
    if (prevDiag && rec.d) {
      rec.dd = {
        rtp: rec.d.rtp - prevDiag.rtp, dec: rec.d.dec - prevDiag.dec, drops: rec.d.drop - prevDiag.drop,
        over: rec.d.over - prevDiag.over, under: rec.d.under - prevDiag.under,
        stalls: rec.d.stalls - prevDiag.stalls, lost: rec.d.lost - prevDiag.lost, pli: rec.d.pli - prevDiag.pli,
        gaps: rec.d.gaps - prevDiag.gaps,
      };
    }
    if (rec.d) prevDiag = rec.d;
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    const kf = rec.s && rec.s.kf ? rec.s.kf : null;
    const d = rec.d || {};
    console.log(new Date().toLocaleTimeString() + ' ir=' + (rec.s && rec.s.ir) + ' kbps=' + (rec.s && rec.s.kbps)
      + ' kf[n=' + (kf ? kf.n : '-') + ' key=' + (kf ? kf.keyN : '-') + ' keyMax=' + (kf ? kf.keyMaxKB : '-') + 'KB max=' + (kf ? kf.maxKB : '-') + 'KB >300=' + (kf ? kf.over300 : '-') + ']'
      + ' 解=' + (d.jie ?? '-') + ' 画=' + (d.hua ?? '-') + ' cad p90=' + (d.cadP90 ?? '-') + ' max=' + (d.cadMax ?? '-')
      + ' over=' + (d.over ?? '-') + ' under=' + (d.under ?? '-') + ' stalls=' + (d.stalls ?? '-') + ' lost=' + (d.lost ?? '-') + ' pli=' + (d.pli ?? '-')
      + (rec.dd ? (' |Δ over=' + rec.dd.over + ' under=' + rec.dd.under + ' stalls=' + rec.dd.stalls) : ''));
    await sleep(EVERY * 1000);
  }
  fs.closeSync(fd);
  console.log('完成：' + OUT);
})();
