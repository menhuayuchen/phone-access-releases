// psnr-y.mjs —— 比较两个 yuv420p raw 文件的 Y 平面 PSNR（逐帧 + 平均）
//
// 为什么自己算：精简版 ffmpeg 没有 psnr 滤镜。Y 平面 PSNR 足以比较"文字/UI 清晰度"，
// 而且输入是我们**同一段抓屏**编出来的两路码流，参考帧完全一致。
// 用法：node release-tools/psnr-y.mjs <ref.yuv> <test.yuv> [--w 1920] [--h 1200] [--frames 90]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REF = argv[0], TEST = argv[1];
const W = Number(arg('w', '1920')), H = Number(arg('h', '1200'));
const FRAMES = Number(arg('frames', '0'));
if (!REF || !TEST) { console.error('用法: node psnr-y.mjs ref.yuv test.yuv [--w 1920] [--h 1200] [--frames N]'); process.exit(2); }

const Y = W * H, UV = (W / 2) * (H / 2) * 2, FRAME = Y + UV;
const sr = fs.statSync(REF).size, st = fs.statSync(TEST).size;
const n = Math.min(FRAMES > 0 ? FRAMES : Infinity, Math.floor(sr / FRAME), Math.floor(st / FRAME));
const fdA = fs.openSync(REF, 'r'), fdB = fs.openSync(TEST, 'r');
const a = Buffer.alloc(Y), b = Buffer.alloc(Y);
let sumMse = 0, worst = 999, best = 0, sumLog = 0;
const per = [];
for (let i = 0; i < n; i++) {
  fs.readSync(fdA, a, 0, Y, i * FRAME);
  fs.readSync(fdB, b, 0, Y, i * FRAME);
  let se = 0;
  for (let k = 0; k < Y; k++) { const d = a[k] - b[k]; se += d * d; }
  const mse = se / Y;
  const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
  sumMse += mse; sumLog += psnr;
  if (psnr < worst) worst = psnr;
  if (psnr > best) best = psnr;
  if (i % 10 === 0) per.push(Math.round(psnr * 10) / 10);
}
fs.closeSync(fdA); fs.closeSync(fdB);
const avgMse = sumMse / Math.max(1, n);
const avgPsnr = avgMse === 0 ? 99 : 10 * Math.log10((255 * 255) / avgMse);
console.log(JSON.stringify({
  frames: n, avgPsnr: Math.round(avgPsnr * 100) / 100,
  avgOfPerFrame: Math.round((sumLog / Math.max(1, n)) * 100) / 100,
  worst: Math.round(worst * 100) / 100, best: Math.round(best * 100) / 100,
  samples: per,
}, null, 1));
