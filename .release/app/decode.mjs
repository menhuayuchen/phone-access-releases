// JPEG -> I420 for the WebRTC video track.
// Using the proven JPEG pipeline instead of pushing 1.4 MB I420 frames through
// the named pipe: the pipe is fine with ~300 KB frames but stalls on multi-MB writes.
import sharp from 'sharp';

// 改动（P0-3）：RTC 输出宽度不再写死 1280。由 screen-server.mjs 按实际抓屏宽度算好后传进来
// （默认取抓屏宽的一半：2560→1280，与本文件改动前完全一致；1920 的机器就是 960）。
// 单独跑本模块（不传 width）时仍退回 1280，保持向后兼容。
// 原来那行是：const RTC_WIDTH = 1280;   // 流畅模式的输出宽度（2560×1600 → 1280×800）
const DEFAULT_RTC_WIDTH = 1280;
let busy = false;
let decoded = 0, dropped = 0, lastMs = 0;

function rgbaToI420(rgba, w, h) {
  const ySize = w * h;
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const uvSize = cw * ch;
  const out = Buffer.allocUnsafe(ySize + uvSize * 2);
  const yP = 0, uP = ySize, vP = ySize + uvSize;

  for (let y = 0; y < h; y++) {
    let src = y * w * 4;
    let dst = y * w;
    for (let x = 0; x < w; x++) {
      const r = rgba[src], g = rgba[src + 1], b = rgba[src + 2];
      out[dst + x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
      src += 4;
    }
  }

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let dy = 0; dy < 2 && y + dy < h; dy++) {
        let src = ((y + dy) * w + x) * 4;
        for (let dx = 0; dx < 2 && x + dx < w; dx++) {
          bs += rgba[src + 2]; gs += rgba[src + 1]; rs += rgba[src];
          src += 4; n++;
        }
      }
      const r = (rs / n) | 0, g = (gs / n) | 0, b = (bs / n) | 0;
      const idx = (y >> 1) * cw + (x >> 1);
      out[uP + idx] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
      out[vP + idx] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }
  }
  return out;
}

export function createDecoder({ onFrame, log = () => {}, width = DEFAULT_RTC_WIDTH }) {
  // 改动（P0-3）：width 由调用方给（screen-server.mjs 传实际抓屏宽的一半），非法值退回 1280
  const numW = Number(width);
  const rtcWidth = (Number.isFinite(numW) && numW >= 320) ? Math.round(numW) : DEFAULT_RTC_WIDTH;
  async function push(jpeg) {
    if (busy) { dropped++; return; }
    busy = true;
    const t0 = Date.now();
    try {
      // 流畅模式的画面上限是 rtcWidth 宽：VP8 在这个码率（1.5~3Mbps）下铺满 2560×1600 只会糊成一片，
      // 大约一半宽度才是它该有的分辨率。sharp 走 JPEG 的 shrink-on-load，缩放开销很小。
      const { data, info } = await sharp(jpeg, { failOn: 'none' })
        .resize({ width: rtcWidth, withoutEnlargement: true })
        .removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const i420 = rgbaToI420(data, info.width, info.height);
      onFrame(i420, info.width, info.height);
      decoded++;
      lastMs = Date.now() - t0;
      if (decoded % 240 === 0) log(`decoder: ${decoded} frames, ${lastMs} ms each, dropped ${dropped}`);
    } catch (e) {
      log('decoder error: ' + e.message);
    } finally {
      busy = false;
    }
  }
  return { push, stats: () => ({ decoded, dropped, lastMs }) };
}
