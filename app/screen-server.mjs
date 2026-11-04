import { PAGE } from './page.mjs';
// Screen viewer for the phone/tablet: serves the JPEG frames written by capture.exe as a
// multipart MJPEG stream, bound ONLY to private interfaces (Tailscale / LAN), never 0.0.0.0.
//
// usage: node screen-server.mjs <hosts csv> <port> <frameFile> <keyFile> [viewersFile] [geometry]
//   node screen-server.mjs 100.x.y.z,192.168.1.10 8660 screen-latest.jpg screen.key viewers.count 2560x1600
//
// viewersFile: number of live /stream connections. capture.exe parks itself at 0, so an
// unwatched viewer costs no CPU/battery.
//
// geometry（第 6 个参数，可选，格式 "宽x高"）：实际抓屏尺寸。改动（P0-3）：以前宽度在本文件里写死
// 2560（encodeStream / publishViewers / /stream / /frame.jpg 四处），流畅模式宽度又写死在 decode.mjs、
// rtc.mjs 的 1280。换到非 2560 宽的机器后这几处判断集体偏掉，表现为清晰度错/莫名降档/RTC 比例怪且不报错。
// 现在由启动脚本按主显示器物理分辨率算好传进来；没传就读 product.config.json；都没有才用 2560×1600 兜底。

import http, { createServer } from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, statSync, unlinkSync, appendFileSync, renameSync, mkdirSync, readdirSync, createReadStream, createWriteStream } from 'node:fs';
import { randomBytes, createPublicKey, createVerify, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';

// 省流量模式下 /frame.jpg?w=&q= 的缩小副本缓存（同一帧只重编码一次）
const thumb = { cacheKey: '', buf: null };

const HERE = dirname(fileURLToPath(import.meta.url));

import { createRtc } from './rtc.mjs';
import { createInput } from './input.mjs';
import { startAudio } from './audio.mjs';
import { createDecoder } from './decode.mjs';

// ---- 改动（P0-3 分辨率链 / P0-4 端口）：启动参数与配置 ------------------------------
// 配置文件 product.config.json 是产品唯一配置源（.ps1 那边用 ConvertFrom-Json 读同一个文件）。
// 这里用 JSON.parse 读，只取三样：端口默认值、抓屏几何、流畅模式宽度。读不到/坏了就用内置默认值，不崩。
function readProductConfig() {
  try {
    const txt = readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch {
    return {};
  }
}
const productConfig = readProductConfig() || {};
const cfgPorts = productConfig.ports || {};
const cfgScreen = productConfig.screen || {};
// 可选组件（Sunshine 高性能模式）：单独下载后安装（GPL-3.0 独立程序）
const cfgComponents = productConfig.components || {};
const sunshineComp = cfgComponents.sunshine || {};
const cfgMaxW = Number(cfgScreen.maxCaptureWidth);

const [hostsArg = '127.0.0.1', portArg = String(Number(cfgPorts.screen) || 8660), frameFile = 'screen-latest.jpg',
  keyFile = 'screen.key', viewersFile = 'viewers.count', geometryArg = ''] = process.argv.slice(2);

const hostsArgRaw = hostsArg;
const port = Number(portArg);

// ---- 绑定地址白名单（独立审查 U3；2026-10-31 再收紧）--------------------------
// 只允许回环 + Tailscale 的 100.64.0.0/10。用户明确要求「不管是否同一 Wi-Fi 都必须走 Tailscale」，
// 所以这里**连 RFC1918 局域网地址也不再允许绑定**，杜绝以后有人把 LAN 加回监听。
// 拒绝一切 IPv6：防火墙规则只写了 IPv4 网段，绑 IPv6 等于绕过它。
const PRIVATE_V4 = [
  /^127\./,                                     // 回环
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./    // Tailscale / CGNAT（100.64.0.0/10）
];
const badHosts = [];
const hosts = hostsArg.split(',').map((h) => h.trim()).filter(Boolean).filter((h) => {
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  if (!isV4) { badHosts.push(h + '(非 IPv4)'); return false; }
  if (h === '0.0.0.0') { badHosts.push(h + '(通配全部网卡)'); return false; }
  if (!PRIVATE_V4.some((re) => re.test(h))) { badHosts.push(h + '(非回环/非 Tailscale)'); return false; }
  return true;
});
if (badHosts.length) {
  console.error('screen-server: [安全] 拒绝绑定这些地址：' + badHosts.join('、'));
  console.error('screen-server: 只允许回环 127.0.0.1 和 Tailscale 的 100.64.0.0/10 网段；局域网地址不再允许。');
}
if (hosts.length === 0) {
  console.error('screen-server: [安全] 没有可绑定的地址了（原始入参：' + hostsArgRaw + '），退出。');
  process.exit(1);
}

// "宽x高" 解析；非法就返回兜底值
function parseGeometry(spec, fallbackW, fallbackH) {
  const m = /^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/.exec(String(spec || '').trim());
  if (m) {
    const w = Number(m[1]), h = Number(m[2]);
    if (w >= 320 && h >= 200) return { width: w, height: h };
  }
  return { width: fallbackW, height: fallbackH };
}
const cfgW = Number(cfgScreen.captureWidth) || 0;
const cfgH = Number(cfgScreen.captureHeight) || 0;
const CAP = parseGeometry(
  geometryArg,
  cfgW >= 320 ? cfgW : 2560,
  cfgH >= 200 ? cfgH : (cfgW >= 320 ? Math.round(cfgW * 1600 / 2560) : 1600),
);
// ---- 抓屏宽度 与 发送宽度（2026-10-30 画质修复）-----------------------------------
// capture.exe 只按显示器原生宽度抓（上限 2560），**不再按画质档位缩**：
//   实测同一台机器（2560×1600）：原生抓屏 24.7fps（间隔 40ms）/ 29.7fps（间隔 33ms）；
//   让 capture.exe 缩到 1440 反而只有 18.6fps，而且 GDI+ Bilinear 缩放会让小字发虚。
// 所以画质档位改成「发送宽度」：CAP_W = 用户选的 1440/1920/2560，缩放在服务端用 sharp(Lanczos) 做。
// 好处：① 三档都不掉帧（抓屏永远原生）② 缩小后比抓屏侧缩放清晰 ③ CAP_W 是 let，切档立即生效、不用重启。
const CAPTURE_W = CAP.width;
const CAPTURE_H = CAP.height;
let CAP_W = (cfgMaxW > 0 && CAPTURE_W > cfgMaxW) ? cfgMaxW : CAPTURE_W;
let CAP_H = CAP_W === CAPTURE_W ? CAPTURE_H : Math.round(CAPTURE_H * CAP_W / CAPTURE_W);
function setDeliveryWidth(w) {
  const n = Math.round(Number(w));
  if (!Number.isFinite(n) || n < 320) return CAP_W;
  CAP_W = Math.min(CAPTURE_W, n);
  CAP_H = Math.round(CAPTURE_H * CAP_W / CAPTURE_W);
  return CAP_W;
}

// 流畅模式（WebRTC）输出宽度：默认取"发送宽度"的一半（2560→1280，与改动前完全一致）。
// RTC 轨道尺寸建连时锁定，所以取启动时的档位；之后切画质不影响流畅模式（避免黑屏）。
const evenDown = (n) => Math.max(2, n - (n % 2));
const cfgRtcW = Number(cfgScreen.rtcWidth) || 0;
const RTC_W = cfgRtcW >= 320 ? evenDown(cfgRtcW) : evenDown(Math.max(320, Math.round(CAP_W / 2)));
const RTC_H = evenDown(Math.max(180, Math.round(RTC_W * CAP_H / CAP_W)));

let rawStamp = 0;
// prime（预置帧）必须和实际喂帧同尺寸：libwebrtc 在建轨时锁尺寸，改动前 decode.mjs 与 rtc.mjs
// 各自写死 1280 / 1280×800，非 16:10 屏上两者会不一致。
const rtc = createRtc({ log: (m) => console.log('rtc: ' + m), rawStampFn: () => rawStamp, prime: { width: RTC_W, height: RTC_H } });
const input = createInput({ log: (m) => console.log('input: ' + m) });
const decoder = createDecoder({ onFrame: (i420, w, h) => rtc.video(i420, w, h), log: (m) => console.log(m), width: RTC_W });
let rtcMode = false;   // 流畅模式：MJPEG 帧解码后推给 WebRTC
let rtcActiveAt = 0;   // 最近一次有 RTC 观众/刚开启的时间（用于没人看时让抓屏休息）

// ---- 网页端 H.264（MSE 播放，2026-11-04）------------------------------------
// 为什么单独一条管线：MJPEG 带宽太大（2560 宽约 64–160 Mbps），手机解码也费电。
// 这里用 ffmpeg（bin\ffmpeg.exe，h264_mf 编码）产出 fragmented MP4，手机用 MSE 硬解，
// 同画质带宽降到 10–20 Mbps。ffmpeg 缺失或页面不支持 MSE 时自动回落到 MJPEG。
const cfgH264 = cfgScreen.h264 || {};
const FFMPEG_EXE = join(HERE, 'bin', 'ffmpeg.exe');
const H264_ENABLED = cfgH264.enabled !== false && fileExists(FFMPEG_EXE);
const H264_FPS = Math.max(10, Math.min(60, Number(cfgH264.fps) || 30));
const H264_KBPS = Math.max(2000, Math.min(40000, Number(cfgH264.kbps) || 12000));
const H264_W = evenDown(Math.max(640, Math.min(CAP_W, Number(cfgH264.width) || CAP_W)));
const H264_H = evenDown(Math.max(360, Math.round(H264_W * CAP_H / CAP_W)));
// 编码器：优先 NVENC（硬编，延迟低、CPU 几乎为 0），不可用时回退 h264_mf（软编）
let H264_ENCODER = 'mf';
try {
  if (H264_ENABLED) {
    execFileSync(FFMPEG_EXE, ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=black:s=64x64:r=1','-t','0.2','-c:v','h264_nvenc','-f','null','-'], { timeout: 8000, stdio: 'ignore' });
    H264_ENCODER = 'nvenc';
  }
} catch { H264_ENCODER = 'mf'; }

const h264 = {
  proc: null,
  init: null,
  pending: Buffer.alloc(0),
  clients: new Set(),
  bytes: 0,
  frames: 0,
  stopTimer: null,
  lastError: ''
};

function h264SendInit(ws) {
  if (!h264.initInfo || !ws) return;
  try {
    ws.send(JSON.stringify({
      type: 'h264-init',
      codec: h264.initInfo.codec,
      description: h264.initInfo.avcC ? h264.initInfo.avcC.toString('base64') : '',
      timescale: h264.initInfo.timescale,
      width: h264.initInfo.width,
      height: h264.initInfo.height
    }));
  } catch { }
}
// ---- fMP4 解析：取出 avcC 与每帧数据，直接发给 WebCodecs 解码（不用 MSE）----
function mp4Boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let header = 8;
    if (size === 1) { if (off + 16 > end) break; size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) { size = end - off; }
    if (size < header || off + size > end) break;
    out.push({ type, start: off, end: off + size, size, header });
    off += size;
  }
  return out;
}

function h264ParseMoov(buf) {
  // 找 moov → trak → mdia → minf → stbl → stsd → avc1 → avcC，以及 mdhd timescale
  let avcC = null, timescale = 1000, width = 0, height = 0;
  for (const moov of mp4Boxes(buf, 0, buf.length)) {
    if (moov.type !== 'moov') continue;
    for (const trak of mp4Boxes(buf, moov.start + moov.header, moov.end)) {
      if (trak.type !== 'trak') continue;
      for (const mdia of mp4Boxes(buf, trak.start + trak.header, trak.end)) {
        if (mdia.type !== 'mdia') continue;
        for (const child of mp4Boxes(buf, mdia.start + mdia.header, mdia.end)) {
          if (child.type === 'mdhd') {
            const p = child.start + child.header + 4;   // version/flags
            const ver = buf[child.start + child.header];
            timescale = ver === 1 ? buf.readUInt32BE(p + 16) : buf.readUInt32BE(p + 8);
          }
          if (child.type !== 'minf') continue;
          for (const minf of mp4Boxes(buf, child.start + child.header, child.end)) {
            if (minf.type !== 'stbl') continue;
            for (const stbl of mp4Boxes(buf, minf.start + minf.header, minf.end)) {
              if (stbl.type !== 'stsd') continue;
              for (const stsd of mp4Boxes(buf, stbl.start + stbl.header + 8, stbl.end)) {
                if (stsd.type !== 'avc1') continue;
                const w = buf.readUInt16BE(stsd.start + 32), h = buf.readUInt16BE(stsd.start + 34);
                if (w) width = w;
                if (h) height = h;
                for (const avc of mp4Boxes(buf, stsd.start + stsd.header + 78, stsd.end)) {
                  if (avc.type !== 'avcC') continue;
                  avcC = Buffer.from(buf.subarray(avc.start + avc.header, avc.end));
                }
              }
            }
          }
        }
      }
    }
  }
  return { avcC, timescale, width, height };
}

function h264CodecString(avcC) {
  if (!avcC || avcC.length < 4) return 'avc1.4D4032';
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return 'avc1.' + hex(avcC[1]) + hex(avcC[2]) + hex(avcC[3]);
}

function h264ExtractSamples(moof, mdat) {
  // 逐帧切 mdat（ffmpeg 单流样本是连续的；不依赖 base_data_offset）
  const out = [];
  for (const t of mp4Boxes(moof, 0, moof.length)) {
    if (t.type !== 'moof') continue;
    for (const traf of mp4Boxes(moof, t.start + t.header, t.end)) {
      if (traf.type !== 'traf') continue;
      let defSize = 0;
      const truns = [];
      for (const g of mp4Boxes(moof, traf.start + traf.header, traf.end)) {
        if (g.type === 'tfhd') {
          const flags = moof.readUInt32BE(g.start + 8) & 0xffffff;
          let q = g.start + 16;   // version/flags(4) + track_id(4)
          if (flags & 0x1) q += 8;
          if (flags & 0x2) q += 4;
          if (flags & 0x8) q += 4;
          if (flags & 0x10) { defSize = moof.readUInt32BE(q); }
        } else if (g.type === 'trun') {
          truns.push(g);
        }
      }
      const mdatPayload = mdat.subarray(8);
      let off = 0;
      for (const g of truns) {
        const flags = moof.readUInt32BE(g.start + 8) & 0xffffff;
        let q = g.start + 12;
        const count = moof.readUInt32BE(q); q += 4;
        if (flags & 0x1) q += 4;      // data_offset（这里不用）
        let firstFlags = 0;
        if (flags & 0x4) { firstFlags = moof.readUInt32BE(q); q += 4; }
        const hasDur = !!(flags & 0x100), hasSize = !!(flags & 0x200), hasFlags = !!(flags & 0x400), hasCto = !!(flags & 0x800);
        for (let i = 0; i < count; i++) {
          if (hasDur) q += 4;
          const size = hasSize ? (q += 4, moof.readUInt32BE(q - 4)) : defSize;
          let sflags = firstFlags;
          if (hasFlags) { sflags = moof.readUInt32BE(q); q += 4; }
          if (hasCto) q += 4;
          const data = mdatPayload.subarray(off, off + size);
          off += size;
          // 判断关键帧：sample flags 的 sync 位，或扫 NAL 里有没有 IDR(5)
          let key = !!(sflags & 0x10000);
          if (!key) {
            for (let k = 0; k + 4 <= data.length;) {
              const len = data.readUInt32BE(k);
              if (len <= 0 || k + 4 + len > data.length) break;
              const nalType = data[k + 4] & 0x1f;
              if (nalType === 5) { key = true; break; }
              k += 4 + len;
            }
          }
          out.push({ key, data });
        }
      }
    }
  }
  return out;
}
function h264SendFrame(ws, tsUs, key, data) {
  if (ws.bufferedAmount > 1024 * 1024) return;
  try {
    const head = Buffer.alloc(9);
    head.writeInt32BE(tsUs, 0);
    head[4] = key ? 1 : 0;
    head.writeUInt32BE(data.length, 5);
    ws.send(Buffer.concat([head, data]), { binary: true });
  } catch { }
}
function processH264Buffer() {
  for (;;) {
    if (!h264.pending || h264.pending.length < 8) return;
    const boxes = mp4Boxes(h264.pending, 0, h264.pending.length);
    if (!boxes.length) return;
    if (!h264.initInfo) {
      // 等 ftyp+moov 齐全
      let ftyp = null, moov = null;
      for (const b of boxes) { if (b.type === 'ftyp') ftyp = b; if (b.type === 'moov') moov = b; }
      if (!ftyp || !moov) {
        if (h264.pending.length > 2 * 1024 * 1024) h264.pending = Buffer.alloc(0);
        return;
      }
      const initBuf = h264.pending.subarray(0, moov.end);
      const info = h264ParseMoov(initBuf);
      h264.initInfo = {
        avcC: info.avcC,
        timescale: info.timescale || 1000,
        width: info.width || H264_W,
        height: info.height || H264_H,
        codec: h264CodecString(info.avcC)
      };
      console.log('h264: init ' + h264.initInfo.codec + ' ' + h264.initInfo.width + 'x' + h264.initInfo.height);
      for (const ws of h264.clients) h264SendInit(ws);
      h264.pending = h264.pending.subarray(moov.end);
      continue;
    }
    // 一段：moof + mdat
    const moof = boxes.find((b) => b.type === 'moof');
    if (!moof) {
      // 没有 moof 说明是残片/未知盒：丢掉到下一个 moof 之前
      const next = boxes.find((b) => b.type === 'moof');
      h264.pending = Buffer.alloc(0);
      return;
    }
    const moofEndIdx = boxes.indexOf(moof);
    const mdat = boxes.slice(moofEndIdx + 1).find((b) => b.type === 'mdat');
    if (!mdat) return;   // 等 mdat 到齐
    const moofBuf = h264.pending.subarray(moof.start, moof.end);
    const mdatBuf = h264.pending.subarray(mdat.start, mdat.end);
    let samples = [];
    try { samples = h264ExtractSamples(moofBuf, mdatBuf); } catch { samples = []; }
    for (const s of samples) {
      h264.tsUs = (h264.tsUs || 0) + Math.round(1e6 / H264_FPS);
      for (const ws of h264.clients) h264SendFrame(ws, h264.tsUs, s.key, s.data);
    }
    h264.frames += samples.length;
    h264.pending = h264.pending.subarray(mdat.end);
    continue;
  }
}
function h264Start() {
  if (!H264_ENABLED || h264.proc) return;
  if (h264.stopTimer) { clearTimeout(h264.stopTimer); h264.stopTimer = null; }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // 低延迟输入：不探测/不缓存
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'lavfi', '-i', `ddagrab=framerate=${H264_FPS}:draw_mouse=0`,
    '-filter_complex', `[0:v]hwdownload,format=bgra,scale=${H264_W}:-2,format=nv12[v]`,
    '-map', '[v]',
    // 远端桌面场景 + 低延迟码控：比默认 profile 少缓存好几帧
    // 编码器：NVENC（硬编，延迟低、CPU 几乎为 0）优先；不可用时回退 h264_mf（软编低延迟档）
    ...(H264_ENCODER === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr', '-rc-lookahead', '0', '-delay', '0', '-surfaces', '4', '-b:v', String(H264_KBPS) + 'K', '-g', String(H264_FPS), '-bf', '0']
      : ['-c:v', 'h264_mf', '-scenario', 'display_remoting', '-rate_control', 'ld_vbr', '-quality', '70', '-b:v', String(H264_KBPS) + 'K', '-g', String(H264_FPS), '-bf', '0']),
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+separate_moof',
    '-frag_duration', '5000', '-flush_packets', '1',
    'pipe:1'
  ];
  console.log('h264: start ' + H264_W + 'x' + H264_H + '@' + H264_FPS + ' ' + H264_KBPS + 'kbps');
  h264.initInfo = null;
  h264.pending = Buffer.alloc(0);
  h264.bytes = 0;
  h264.tsUs = 0;
  h264.frames = 0;
  try {
    h264.proc = spawn(FFMPEG_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    h264.lastError = String(e.message || e);
    console.log('h264: spawn failed ' + h264.lastError);
    h264.proc = null;
    return;
  }
  h264.proc.stdout.on('data', (d) => {
    h264.bytes += d.length;
    h264.pending = Buffer.concat([h264.pending, d]);
    processH264Buffer();
  });
  h264.proc.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) { h264.lastError = s.split('\n').slice(-1)[0]; }
  });
  h264.proc.on('exit', (code) => {
    console.log('h264: ffmpeg exit ' + code);
    h264.proc = null;
    h264.init = null;
    if (h264.clients.size > 0) setTimeout(() => { if (h264.clients.size > 0) h264Start(); }, 1500);
  });
  h264.proc.on('error', (e) => { h264.lastError = String(e.message || e); });
}

function h264Stop() {
  if (h264.stopTimer) { clearTimeout(h264.stopTimer); h264.stopTimer = null; }
  if (h264.proc) { try { h264.proc.kill(); } catch { } h264.proc = null; }
  h264.initInfo = null;
  h264.pending = Buffer.alloc(0);
  console.log('h264: stopped');
}

const h264Wss = new WebSocketServer({ noServer: true });

function attachH264Ws(server, key) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { try { socket.destroy(); } catch { } return; }
    if (url.pathname !== '/ws-h264') return;
    if (!sourceAllowed(req)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    if (!authorized(req, url)) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    if (!H264_ENABLED) {
      try { socket.write('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    h264Wss.handleUpgrade(req, socket, head, (ws) => h264Wss.emit('connection', ws, req));
  });
  h264Wss.on('connection', (ws) => {
    h264.clients.add(ws);
    console.log('h264: viewer connected (' + h264.clients.size + ')');
    h264Start();
    h264SendInit(ws);
    ws.on('close', () => {
      h264.clients.delete(ws);
      console.log('h264: viewer closed (' + h264.clients.size + ')');
      if (h264.clients.size === 0) {
        h264.stopTimer = setTimeout(() => { if (h264.clients.size === 0) h264Stop(); }, 15000);
      }
    });
    ws.on('error', () => { });
  });
}


// ---- 注入被前台高权限窗口挡住（UIPI）时的自愈 ----
// input.exe 自己会先试 SwitchToThisWindow；在某些进程上下文里这招会被前台锁拒，所以再从
// PowerShell 侧补一枪（实测 PowerShell 调的 SwitchToThisWindow 能稳定把前台踢回桌面）。
let lastBlockedSeen = 0;
let lastUnblockAt = 0;
function shellUnblock() {
  if (Date.now() - lastUnblockAt < 3000) return;
  lastUnblockAt = Date.now();
  const ps = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class DshFg{',
    '[DllImport("user32.dll")] public static extern IntPtr GetShellWindow();',
    '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h,bool alt);',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);',
    'public static string Fg(){IntPtr h=GetForegroundWindow();var s=new System.Text.StringBuilder(160);GetWindowText(h,s,160);return s.ToString();}',
    '}',
    '"@',
    '$b=[DshFg]::Fg();',
    '[DshFg]::SwitchToThisWindow([DshFg]::GetShellWindow(),$true);',
    'Start-Sleep -Milliseconds 250;',
    '"unblock: [" + $b + "] -> [" + [DshFg]::Fg() + "]"',
  ].join('\n');
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore', detached: true });
    p.unref();
    console.log('unblock: powershell switch requested');
  } catch (e) {
    console.log('unblock: spawn failed ' + (e.code || e.message));
  }
}

// 自动自愈：有画面客户端在线、且 injector 报告的 blocked 数在涨，就自动抢前台
setInterval(() => {
  const st = input.status();
  if (!st.blocked) return;
  if (st.ageMs > 15000) return;          // 老数据，忽略
  if (st.blocked === lastBlockedSeen) return;
  lastBlockedSeen = st.blocked;
  if (wanted() > 0) shellUnblock();
}, 1000).unref?.();

// ---- 清晰(MJPEG)模式下的声音：PCM 直接走 WebSocket，浏览器用 AudioWorklet 播放 ----
// WebRTC 那条音频轨只在「流畅」模式存在，清晰模式没有 <video>，所以单独开一条路。
const audioClients = new Set();
const audioWss = new WebSocketServer({ noServer: true });

function audioPush(pcm) {
  if (!audioClients.size) return;
  for (const ws of audioClients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > 256 * 1024) continue;   // 客户端跟不上就丢，保证延迟不越攒越大
    try { ws.send(pcm, { binary: true }); } catch { }
  }
}

// ---- 可选组件下载（Sunshine MSI，GPL-3.0 独立程序）------------------------
let sunshineJob = { phase: 'idle', received: 0, total: 0, error: '', startedAt: 0 };

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const st = createReadStream(file);
    st.on('data', (d) => h.update(d));
    st.on('end', () => resolve(h.digest('hex')));
    st.on('error', reject);
  });
}

function saveStreamToFile(stream, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    let got = 0;
    stream.on('data', (d) => { got += d.length; try { onProgress(got); } catch { } });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve(got));
    stream.pipe(out);
  });
}

function fetchToFileOnce(url, dest, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if (u.protocol === 'file:') {
      // 本地文件（真机验证/离线安装用）
      try {
        const src = fileURLToPath(u);
        const total = statSync(src).size;
        resolve(saveStreamToFile(createReadStream(src), dest, (n) => onProgress(n, total)));
      } catch (e) { reject(e); }
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('不支持的下载协议：' + u.protocol)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    mod.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (redirects || 0) < 3) {
        r.resume();
        resolve(fetchToFileOnce(new URL(r.headers.location, u).toString(), dest, onProgress, (redirects || 0) + 1));
        return;
      }
      if (r.statusCode !== 200) { r.resume(); reject(new Error('下载失败 HTTP ' + r.statusCode)); return; }
      const total = Number(r.headers['content-length']) || 0;
      resolve(saveStreamToFile(r, dest, (n) => onProgress(n, total)));
    }).on('error', reject);
  });
}

async function downloadAndInstallSunshine() {
  const urls = Array.isArray(sunshineComp.urls) ? sunshineComp.urls.filter(Boolean) : [];
  const dest = join(HERE, 'sunshine-setup.msi');
  let lastErr = null;
  let got = 0;
  for (const u of urls) {
    try {
      sunshineJob.received = 0;
      sunshineJob.total = Number(sunshineComp.sizeBytes) || 0;
      got = await fetchToFileOnce(u, dest, (n, total) => {
        sunshineJob.received = n;
        if (total) sunshineJob.total = total;
      }, 0);
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  if (sunshineComp.sizeBytes && got !== Number(sunshineComp.sizeBytes)) throw new Error('组件大小不对：' + got + ' / ' + sunshineComp.sizeBytes);
  if (sunshineComp.sha256) {
    const h = await sha256File(dest);
    if (h.toLowerCase() !== String(sunshineComp.sha256).toLowerCase()) throw new Error('SHA256 校验失败');
  }
  sunshineJob.received = got;
  if (process.env.PA_COMPONENT_SKIP_INSTALL === '1') { sunshineJob.phase = 'ready'; return; }
  sunshineJob.phase = 'installing';
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const integ = join(HERE, 'sunshine-integration.ps1');
  if (!fileExists(integ)) throw new Error('缺少 sunshine-integration.ps1');
  const runner = join(HERE, 'sunshine-install-run.ps1');
  const lines = [
    '$ErrorActionPreference = "Continue"',
    'Start-Process powershell -Verb RunAs -ArgumentList @(',
    '  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ' + JSON.stringify(integ) + ',',
    '  "-Action", "install", "-MsiPath", ' + JSON.stringify(dest) + ',',
    '  "-AppDir", ' + JSON.stringify(HERE) + ', "-Quiet"',
    ') | Out-Null'
  ];
  writeFileSync(runner, lines.join('\r\n'), 'utf8');
  await new Promise((resolve) => {
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], { stdio: 'ignore', windowsHide: true });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  // 安装器是提权后异步跑的：这里最多等 3 分钟看 exe 出现
  for (let i = 0; i < 90; i++) {
    if (fileExists(SUNSHINE_EXE)) { sunshineJob.phase = 'done'; return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('安装没有完成（可能没点管理员授权，或安装器报错）');
}
function attachAudioWs(server, key) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    // 改动（第二轮 P4-4）：这里是**最后**一个 upgrade 处理器（rtc.mjs 先注册、只认 /rtc），
    // 所以不认识的路径必须销毁 socket。原来直接 return，连接会挂着占资源，直到对端超时。
    // 修复（2026-10-29，真实回归）：P4-4 把 /rtc 也一起销毁了——Node 的 upgrade 事件会派发给
    // 所有监听器：rtc.mjs 先升级成功（viewer connected 都打出来了），这里紧接着 destroy 同一个
    // socket，信令连接被掐死（code=1006），浏览器 offer 发出去永远等不到 answer，
    // 表现就是「流畅模式一直连不上、几秒后自动退回清晰」。
    // /rtc 的鉴权失败由 rtc.mjs 自己处理（写 401 + destroy），这里绝不能碰它。
    if (url.pathname !== '/ws-audio') {
      // /rtc 由 rtc.mjs 处理，/ws-h264 由 attachH264Ws 处理；其余路径在这里销毁。
      if (url.pathname !== '/rtc' && url.pathname !== '/ws-h264') { try { socket.destroy(); } catch { } }
      return;
    }
    if (!sourceAllowed(req)) {
      try { socket.write('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'); } catch { }
      socket.destroy();
      return;
    }
    if (url.searchParams.get('k') !== key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
  });
  audioWss.on('connection', (ws) => {
    audioClients.add(ws);
    console.log('screen-server: audio ws connected (' + audioClients.size + ')');
    try {
      ws.send(JSON.stringify({ type: 'audio', sampleRate: 48000, channels: 2, bits: 16, chunkMs: 20 }));
    } catch { }
    ws.on('close', () => {
      audioClients.delete(ws);
      console.log('screen-server: audio ws closed (' + audioClients.size + ')');
    });
    ws.on('error', () => { });
  });
}

// system sound (WASAPI loopback) -> WebRTC audio track + 清晰模式的 PCM WebSocket
startAudio({
  pipeName: 'dsh-audio',
  onChunk: (pcm) => { rtc.audio(pcm); audioPush(pcm); },
  log: (m) => console.log('audio: ' + m),
});

// 改动（P0-3）：启动参数解析已上移到文件顶部（createRtc/createDecoder 需要先知道 RTC 尺寸）。

function readKey() {
  // 改动（独立审查 L1）：原来只要"长度 ≥ 8"就当成合法密钥，
  // 而且读不到就**静默**生成一把新的并覆盖——结果就是某天所有手机地址突然失效，
  // 屏幕上没有任何提示，客户只会觉得"这软件坏了"。
  // 现在：只认 16 或 32 位十六进制；文件存在但内容不合法时大声报错，不再装作没看见。
  let raw = '';
  let exists = false;
  try { raw = readFileSync(keyFile, 'utf8').trim(); exists = true; } catch { exists = false; }

  if (exists && /^[0-9a-fA-F]{16}$|^[0-9a-fA-F]{32}$/.test(raw)) return raw;

  if (exists) {
    console.error('screen-server: [关键] screen.key 内容不合法（长度 ' + raw.length + '），已重新生成。'
      + ' 手机上所有旧地址会立即失效，需要重新扫码。原内容备份在 screen.key.bad');
    try { writeFileSync(join(HERE, 'screen.key.bad'), raw, 'utf8'); } catch { }
  } else {
    console.error('screen-server: [关键] 找不到 screen.key，已生成一把新的。'
      + ' 刚安装时属正常；如果运行中突然丢失，请检查杀毒软件是否删了文件。');
  }
  const key = randomBytes(16).toString('hex');
  try {
    writeFileSync(keyFile, key + '\n', 'utf8');
  } catch (e) {
    console.error('screen-server: [关键] 新密钥写不进 screen.key（' + e.message + '），本次用的是临时密钥，重启会变。');
  }
  return key;
}

const KEY = readKey();

// 图标版本号：取 icon-192.png 的修改时间（毫秒）。换图标后这个值变，浏览器就会重新取。
const ICON_V = (() => { try { return String(Math.round(statSync(join(HERE, 'icon-192.png')).mtimeMs)); } catch { return '1'; } })();

// ---- viewer accounting ------------------------------------------------------
// Two ways to watch: the MJPEG stream (live) or /frame.jpg polling (low bandwidth).
// capture.exe must run while either is active, and park when neither is.
let streams = 0;
let droppedTotal = 0;
const pushTimes = [];        // timestamps of frames actually written to a viewer
let lastPushStamp = 0;
// 一帧要推给每个观看者，所以不能按"推送次数"算帧率：同一帧只记一次。
function notePush(stamp) {
  if (stamp && stamp === lastPushStamp) return;
  lastPushStamp = stamp || 0;
  pushTimes.push(Date.now());
  if (pushTimes.length > 600) pushTimes.splice(0, pushTimes.length - 600);
}
let lastDropStamp = 0;
// 丢帧必须按会话分开统计：以前是全局一个计数器，手机链路差丢的帧会算到电脑/平板上，
// 结果好端端的设备被自动降档（"明明带宽够却越看越糊"就是这么来的）。
const dropTimes = [];              // 没带会话 id 的（脚本/老页面）走这里
const dropBySid = new Map();       // sid -> 最近跳过的帧时间戳
function bucketsFor(sid) {
  if (!sid) return dropTimes;
  let arr = dropBySid.get(sid);
  if (!arr) { arr = []; dropBySid.set(sid, arr); }
  return arr;
}
function noteDrop(stamp, sid) {
  if (stamp && stamp === lastDropStamp) return;
  lastDropStamp = stamp || 0;
  droppedTotal++;
  const arr = bucketsFor(sid);
  arr.push(Date.now());
  if (arr.length > 2000) arr.splice(0, arr.length - 2000);

  // 改动（独立审查 L4）：原来这里写 `if (v.length === 0) delete`，
  // 但数组只会被裁剪到 2000，**永远不会变成空数组** —— 所以条目一个都删不掉，
  // 页面每换一个会话 id 就往 Map 里多一条，长期运行无限增长。
  // 现在按"最后一条记录的时间"判断过期，并强制把总数压在上限内。
  const DROP_SID_MAX = 64;
  const DROP_SID_TTL_MS = 5 * 60 * 1000;
  if (dropBySid.size > DROP_SID_MAX) {
    const cut = Date.now() - DROP_SID_TTL_MS;
    for (const [k, v] of dropBySid) {
      const last = v.length ? v[v.length - 1] : 0;
      if (last < cut) dropBySid.delete(k);
    }
    if (dropBySid.size > DROP_SID_MAX) {
      // 还超上限：从最旧的开始删，保证不会无限增长
      const ordered = [...dropBySid.entries()]
        .sort((a, b) => ((a[1][a[1].length - 1] || 0) - (b[1][b[1].length - 1] || 0)));
      for (const [k] of ordered) {
        if (dropBySid.size <= DROP_SID_MAX) break;
        dropBySid.delete(k);
      }
    }
  }
}
// HUD 用：最近 10 秒还丢了几帧（自动清零，不是累计值）
function recentDrops(sec, sid) {
  const cut = Date.now() - (sec || 10) * 1000;
  const arr = sid && dropBySid.has(sid) ? dropBySid.get(sid) : dropTimes;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr.length;
}

// ---- 看清晰模式时的"带宽自适应"编码 -----------------------------------------
// 窄带时客户端会带 ?w=1280&q=62 来要缩小版；同一帧 + 同一参数只编码一次，多端共享。
// 不带参数（局域网全速）时直接透传抓屏原始 JPEG，零额外 CPU。
let lastLagFrames = 0;
const encCache = new Map();
function encodeStream(buf, stamp, w, q) {
  // 要的就是满宽（或更宽）：直接透传抓屏原图。再编码一遍等于二次 JPEG 压缩，肉眼可见掉细节。
  // 改动（P0-3）：满宽的判据从写死 2560 改成实际抓屏宽度 CAP_W（1920 的机器不再每次都白编码一遍）。
  if (!w || w >= (sourceState.width || CAPTURE_W)) return Promise.resolve(buf);
  const key = stamp + ':' + w + ':' + q;
  const hit = encCache.get(key);
  if (hit) return Promise.resolve(hit);
  return sharp(buf)
    .resize({ width: w || undefined, withoutEnlargement: true })
    .jpeg({ quality: q || 62 })
    .toBuffer()
    .then((out) => {
      if (encCache.size > 16) encCache.clear();   // 只服务最近一两帧
      encCache.set(key, out);
      return out;
    });
}
function currentOutFps() {
  const cut = Date.now() - 2000;
  while (pushTimes.length && pushTimes[0] < cut) pushTimes.shift();
  return (pushTimes.length / 2).toFixed(1);
}
// 抓屏侧帧率：管道里真正收到的帧（capture.exe 产出的速度），用来区分
// 「抓屏慢」和「送给手机时丢了」这两种完全不同的情况。
const inTimes = [];
function noteIn() {
  inTimes.push(Date.now());
  if (inTimes.length > 600) inTimes.splice(0, inTimes.length - 600);
}
function currentInFps() {
  const cut = Date.now() - 2000;
  while (inTimes.length && inTimes[0] < cut) inTimes.shift();
  return (inTimes.length / 2).toFixed(1);
}
let lastPoll = 0;
let published = -1;

function wanted() {
  if (sourceState.mode === "raw") return 1;   // raw frames must exist before the track is created
  if (rtcMode) {
    const rp = rtc.stats().peers || 0;
    if (rp > 0) rtcActiveAt = Date.now();
    // 流畅模式下始终让抓屏跑着：新观众一连上就能拿到视频轨。
    // （没人看超过 60 秒会自动把 rtcMode 关掉，见下面的 idle 定时器，避免一直烧 CPU。）
    return Math.max(1, rp);
  }
  if (streams > 0) return streams + (rtc.stats().peers || 0);
  if ((rtc.stats().peers || 0) > 0) return rtc.stats().peers;
  if (Date.now() - lastPoll < 3000) return 1;

  return 0;
}
function publishViewers() {
  const n = wanted();
  // Always rewrite: the gate file is also edited by humans/scripts, and a value that only
  // changes "on transition" can drift out of sync — capture.exe would then stay parked
  // while a viewer is actually connected. One 1-byte write every 700 ms is nothing.
  published = n;
  try { writeFileSync(viewersFile, String(n), 'utf8'); } catch {}
  // 改动（P0-3）：这里原来写死 2560。现在一律按实际抓屏宽度 CAP_W 抓：只要有人在看清晰模式（流或轮询），
  // 就必须按原始宽度抓，否则流畅模式把抓屏降到一半时，清晰那边会被悄悄降清晰度（以前就是这个行为）。
  // 流畅模式的降采样交给 decode.mjs（它本来就按 RTC_W 编码），这里不动抓屏。
  const w = CAPTURE_W;
  if (sourceState.width !== w) {
    sourceState.width = w;
    writeMode();
    console.log('screen-server: capture width -> ' + w + (w === 1280 ? ' (rtc only)' : ''));
  }
}

try { writeFileSync(viewersFile, '0', 'utf8'); published = 0; } catch {}
setInterval(publishViewers, 700);

// 流畅模式长时间没人看就关掉，让抓屏能真正停下来（否则会一直 25fps 编码）
setInterval(() => {
  if (!rtcMode) return;
  const p = rtc.stats().peers || 0;
  if (p > 0) { rtcActiveAt = Date.now(); return; }
  if (Date.now() - rtcActiveAt > 60000) {
    rtcMode = false;
    console.log('screen-server: rtc idle 60s -> rtcMode off');
  }
}, 15000).unref?.();

// ---- adaptive frame budget ------------------------------------------------
// When a viewer's socket is congested we drop frames (latency stays bounded), but the
// encoder still burns CPU producing frames nobody receives. So watch the drop rate and
// tell capture.exe to slow down; speed back up once the link is clean again.
const capFile = viewersFile.replace(/[^\\/]*$/, '') + 'capture.interval';
const modeCtlFile = viewersFile.replace(/[^\\/]*$/, '') + 'capture.mode';
const sourceState = { mode: 'mjpeg', monitor: -1, window: 0, width: 0 };
const sourcesCache = { out: '', at: 0 };   // /sources 的 600ms 缓存（页面每 2 秒轮询）
// capture.exe 抓不到被遮挡的窗口时，会写这个文件请求"把窗口提到前面"
const raiseReq = join(HERE, 'raise-window.txt');
let raising = false;

setInterval(() => {
  if (raising || !sourceState.window) return;
  let raw = '';
  try { raw = readFileSync(raiseReq, 'utf8').trim(); } catch { return; }
  const hwnd = parseInt(raw, 16);
  if (!hwnd) return;
  raising = true;
  try { unlinkSync(raiseReq); } catch {}
  input.send({ t: 'focus', hwnd });
  console.log('screen-server: (occluded) raise window 0x' + hwnd.toString(16));
  setTimeout(() => { raising = false; }, 3000);
}, 2000).unref();
function writeMode() {
  try {
    // 改动（第二轮 P4-5）：注意这个 width 是**会被 capture.exe 当成实际输出宽度的覆盖值**
    // （capture.cs 里 `wantW = ctlWidth > 0 ? ctlWidth : targetWidth`，读的就是这一行）。
    // 所以这里必须写真实抓屏宽（sourceState.width 在 publishViewers 里被设成 CAP_W），
    // 写小了画面就真的变小。这也是"capture.mode 里 width 长期是 1440"值得追的原因。
    writeFileSync(modeCtlFile,
      'mode=' + sourceState.mode + '\nmonitor=' + sourceState.monitor + '\nwindow=' + sourceState.window + '\nwidth=' + sourceState.width + '\n', 'utf8');
  } catch {}
}
writeMode();
const CAP_LEVELS = [33, 45, 60, 80, 110];
// 改动：默认从 45ms(22帧上限) 改成 33ms(30帧上限)。实测好链路上也被压到 22 帧，
// 画面明显不够顺（2560 全清晰实测能到 24 帧）。真拥塞时自适应会自己降速。
let capLevel = 0;
let lastDropped = 0;
let cleanTicks = 0;
let lastStreams = -1;
let lastWidth = -1;      // 记录抓屏宽度：切分辨率会重启管线，那期间的丢帧是自伤
let congestTicks = 0;    // 连续拥塞计数：单轮突刺不算，避免误降速   // 观看者数量变化（重开流/切模式）时用来识别"自伤丢帧"

function writeCap() {
  try { writeFileSync(capFile, String(CAP_LEVELS[capLevel]), 'utf8'); } catch {}
}
writeCap();

setInterval(() => {
    // 观看者数量变了（重开流 / 清晰流畅互切）：这一轮丢帧是我们自己造成的，
    // 不计入拥塞判断。以前正是这里形成了死循环：自动降档 -> 重开流 -> 丢帧
    // -> 判定拥塞 -> 再降速，实测把帧率一路压到 15 帧。
    if (streams !== lastStreams) {
      lastStreams = streams;
      lastDropped = droppedTotal;
      cleanTicks = 0;
      return;
    }
  // 抓屏宽度变了（切分辨率 / 切模式）：管线重启期间的丢帧是我们自己造成的，整轮跳过
  if (sourceState.width !== lastWidth) {
    lastWidth = sourceState.width;
    lastDropped = droppedTotal;
    cleanTicks = 0;
    congestTicks = 0;
    return;
  }
  const delta = droppedTotal - lastDropped;
  lastDropped = droppedTotal;
  if (streams === 0) { cleanTicks = 0; return; }        // nobody watching: leave it alone
  if (delta > 40) {
    // 改动：单轮丢帧不再立刻降速。切窗口 / 切分辨率 / 首帧都会造成一次突刺，
    // 以前一次突刺就能把上限打到 110ms（=9 帧），而且落下去很难爬回来。
    congestTicks++;
    if (congestTicks < 2) return;
    congestTicks = 0;
    cleanTicks = 0;
    if (capLevel < CAP_LEVELS.length - 1) {
      capLevel++;
      writeCap();
      console.log(`screen-server: link congested, frame cap -> ${CAP_LEVELS[capLevel]} ms`);
    }
  } else if (delta === 0) {
    cleanTicks++;
    if (cleanTicks >= 3 && capLevel > 0) {
      capLevel--;
      cleanTicks = 0;
      writeCap();
      console.log(`screen-server: link clean, frame cap -> ${CAP_LEVELS[capLevel]} ms`);
    }
  } else {
    cleanTicks = 0;
  }
}, 4000);

// ---- last good frame, kept in memory so a reader never sees a torn file -----
let frame = null;
let frameStamp = 0;

function loadFrame() {
  try {
    const st = statSync(frameFile);
    if (st.mtimeMs === frameStamp) return false;
    const buf = readFileSync(frameFile);
    // a JPEG must start with SOI and end with EOI; anything else is a partial write
    if (buf.length < 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
    if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
    frame = buf;
    frameStamp = st.mtimeMs;
    return true;
  } catch {
    return false;
  }
}

// ---- frames over a named pipe (preferred) or the JPEG file (fallback) ------
const PIPE_PATH = process.env.SCREEN_PIPE || '\\\\.\\pipe\\dsh-screen-frames';
let pipeOk = false;
let pipeBuf = Buffer.alloc(0);
const chunks = [];
let buffered = 0;
let head = Buffer.alloc(0);
let frameLen = 0;
let pipeSock = null;
let pipeReconnecting = false;

// frame = [type][payload]; type 0 = JPEG (MJPEG path), type 1 = I420 (WebRTC path)
function acceptFrame(buf) {
  if (buf.length < 2) return;
  const type = buf[0];
  if (type === 0) {
    const jpeg = buf.subarray(1);
    if (jpeg.length < 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
    if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return;
    frame = Buffer.from(jpeg);
    frameStamp = Date.now();
    noteIn();                          // 抓屏侧真实帧率（管道里收到的帧）
    if (rtcMode) decoder.push(jpeg);   // feed the source even before a peer arrives: the track needs a frame
    return;
  }
  if (type === 1 && buf.length > 5) {
    const w = buf.readUInt16LE(1), h = buf.readUInt16LE(3);
    if (w < 16 || h < 16) return;
    const need = w * h * 3 / 2;
    if (buf.length - 5 < need) return;
    rtc.video(Buffer.from(buf.subarray(5, 5 + need)), w, h);   // own ArrayBuffer: wrtc validates its byteLength
    rawStamp = Date.now();
  }
}

function connectPipe() {
  if (pipeReconnecting) return;
  const sock = net.connect(PIPE_PATH);
  pipeSock = sock;
  sock.on('connect', () => { pipeOk = true; pipeBuf = Buffer.alloc(0); });
  sock.on('data', (chunk) => {
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (frameLen === 0) {
        while (head.length < 4 && chunks.length) {
          const take = Math.min(4 - head.length, chunks[0].length);
          head = Buffer.concat([head, chunks[0].subarray(0, take)]);
          if (take === chunks[0].length) chunks.shift(); else chunks[0] = chunks[0].subarray(take);
          buffered -= take;
        }
        if (head.length < 4) return;
        const len = head.readUInt32LE(0);
        head = Buffer.alloc(0);
        if (len === 0) continue;                       // heartbeat
        if (len < 8 || len > 64 * 1024 * 1024) { chunks.length = 0; buffered = 0; return; }
        frameLen = len;
      }
      if (buffered < frameLen) return;
      const parts = [];
      let need = frameLen;
      while (need > 0 && chunks.length) {
        const c0 = chunks[0];
        if (c0.length <= need) { parts.push(c0); chunks.shift(); need -= c0.length; buffered -= c0.length; }
        else { parts.push(c0.subarray(0, need)); chunks[0] = c0.subarray(need); buffered -= need; need = 0; }
      }
      frameLen = 0;
      acceptFrame(parts.length === 1 ? parts[0] : Buffer.concat(parts, parts.reduce((a, b) => a + b.length, 0)));
    }
  });
  const retry = () => {
    pipeOk = false;
    // destroy the socket: a half-open handle keeps the single pipe instance occupied,
    // which would make every future reconnect block forever
    try { sock.destroy(); } catch {}
    if (pipeReconnecting) return;
    pipeReconnecting = true;
    setTimeout(() => { pipeReconnecting = false; connectPipe(); }, 1000);
  };
  sock.on('error', retry);
  sock.on('close', retry);
}

connectPipe();
loadFrame();
setInterval(() => {
  if (!pipeOk || wanted() === 0) return;
  if (Date.now() - frameStamp > 6000) { try { pipeSock.destroy(); } catch {} }
}, 2000);
setInterval(() => { if (!pipeOk) loadFrame(); }, 100);


function sourceAllowed(req) {
  const ra = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (ra === '127.0.0.1' || ra === '::1') return true;
  return /^100\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./.test(ra);
}

function authorized(req, url) {
  if (url.searchParams.get('k') === KEY) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `screen-key=${KEY}`);
}

// ---- manifest 的短时签名（改动：第二轮 P0-1 / H1-r1）----------------------------
// 为什么不能只靠 cookie：实测（2026-10-29，Chrome 156）浏览器取 <link rel="manifest">
// 时**不发 cookie**——服务端记到的是空 cookie + 浏览器 UA，于是把 /manifest.json 加进
// 严格集合会直接把"添加到主屏幕"打掉（页面内 fetch 会带 cookie，所以只测 fetch 发现不了）。
// 而清单本身又不能免密（原来它里面就带着完整访问密钥）。
// 折中：页面渲染时现签一个 1 小时有效的 token 塞进 href。裸 GET /manifest.json
// （不带 k、不带 cookie、不带有效 token）仍然 401；手机浏览器照常能取到清单。
// token 只放行这一份清单文档，过期即作废，不能当第二把钥匙用。
// （2026-10-30：清单 start_url 重新带上了密钥——token 只能从已鉴权的页面 HTML 里
//  拿到，而页面本身、入口二维码里本来就有完整密钥，所以没有新增暴露面。）
const MANIFEST_TTL_MS = 60 * 60 * 1000;
function manifestSig(exp) {
  return createHmac('sha256', KEY).update('manifest|' + exp).digest('hex');
}
function manifestHref() {
  const exp = Date.now() + MANIFEST_TTL_MS;
  // ?v=2 是为了把手机上缓存过的旧清单（里面带过密钥，且曾经 max-age=86400）换成新 URL
  return '/manifest.json?v=2&exp=' + exp + '&sig=' + manifestSig(exp);
}
function manifestTokenOk(url) {
  const exp = Number(url.searchParams.get('exp') || 0);
  const sig = String(url.searchParams.get('sig') || '');
  if (!Number.isFinite(exp) || exp <= 0 || exp < Date.now()) return false;
  const want = manifestSig(exp);
  if (sig.length !== want.length) return false;
  try { return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(want, 'utf8')); } catch { return false; }
}

// 猜密钥的失败计数：同一个来源 10 分钟错 8 次 → 锁 10 分钟，并写一行 screen-auth.log。
// 密钥 64 bit 本来就猜不中，这条是为了让"有人在敲"留下痕迹，而不是无限敲。
const authFails = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LIMIT = 8;

function noteAuthFail(ip, req, url) {
  // 2026-10-31：tailscale serve 会把所有请求的来源变成 127.0.0.1，按 IP 计数会把整个 tailnet
  // 一起锁死（一台拿旧书签的手机错 8 次，别人全被 429）。优先用 serve 带的身份头；
  // 拿不到身份且来源是回环时，只记日志、不锁定。
  const who = String(req.headers['tailscale-user-login'] || '').trim();
  const key = who || ip;
  const loopback = ip === '127.0.0.1' || ip === '::1';
  if (loopback && !who) {
    try {
      appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'screen-auth.log'),
        `${new Date().toISOString()} 401 serve path=${url.pathname} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}\n`);
    } catch { /* 日志失败不影响门 */ }
    return false;
  }
  const now = Date.now();
  let rec = authFails.get(key);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) { rec = { count: 0, first: now, until: 0 }; authFails.set(key, rec); }
  rec.count += 1;
  if (rec.count >= AUTH_LIMIT) rec.until = now + AUTH_WINDOW_MS;
  // 改动（独立审查 L3）：这张表原来只增不减，长期运行会被大量来源 IP 撑大。
  // 超过上限时清掉"窗口早已过期且不在锁定期"的条目。
  if (authFails.size > 256) {
    const staleCut = now - AUTH_WINDOW_MS * 2;
    for (const [k, v] of authFails) {
      if (v.until < now && v.first < staleCut) authFails.delete(k);
    }
  }
  try {
    appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'screen-auth.log'),
      `${new Date().toISOString()} 401 ip=${ip}${who ? ' user=' + who : ''} path=${url.pathname} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}\n`);
  } catch { /* 日志失败不影响门 */ }
  return rec.until > now;
}

function rejectAuth(req, res, url, ra) {
  const locked = noteAuthFail(ra || 'unknown', req, url);
  if (locked) {
    res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '600' });
    res.end('<meta charset="utf-8"><body style="background:#0b0b0d;color:#c9ccd1;font:15px system-ui;padding:32px">'
      + '尝试次数太多，已锁定 10 分钟。</body>');
    return;
  }
  // 客户看到这一页时，绝大多数不是"忘了带密钥"，而是**地址已经过期**：
  // 电脑重装过 / 换过密钥 / 换了入口地址，手机上存的旧书签就失效了。
  // 所以必须告诉他"回电脑上拿新的地址"，而不是只说"请用带 ?k= 的地址"——他明明带了。
  const hasK = !!(url.searchParams.get('k'));
  const title = hasK ? '这个地址已经失效了' : '这个地址缺了钥匙';
  const lead = hasK
    ? '地址里带的密钥和这台电脑现在的不一致。通常是电脑重装过、换过密钥，或者你打开的是旧书签。'
    : '这个地址里没有访问密钥，所以打不开。';
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<body style="margin:0;background:#0b0b0d;color:#e8eaee;font:15px/1.7 system-ui,-apple-system,\'Microsoft YaHei\',sans-serif">'
    + '<div style="max-width:520px;margin:0 auto;padding:28px 20px 40px">'
    + '<div style="font-size:20px;font-weight:600;color:#ffb454;margin:8px 0 10px">' + title + '</div>'
    + '<div style="color:#aeb3bb">' + lead + '</div>'
    + '<div style="margin:22px 0 8px;font-weight:600">怎么办</div>'
    + '<ol style="margin:0;padding-left:22px;color:#c9ccd1">'
    + '<li>回到那台电脑，打开桌面上的「手机远程」文件夹；</li>'
    + '<li>双击「手机入口」，屏幕会显示<b>当前可用的地址和二维码</b>；</li>'
    + '<li>用手机扫新的二维码，或把新地址复制到浏览器打开。</li>'
    + '</ol>'
    + '<div style="margin:22px 0 8px;font-weight:600">小提示</div>'
    + '<ul style="margin:0;padding-left:22px;color:#8b9098;font-size:14px">'
    + '<li>手机上加个书签或“添加到主屏幕”，以后就不用输网址了。</li>'
    + '<li>找不到「手机入口」，可能是程序没在跑——双击同文件夹里的「启动」。</li>'
    + '<li>还是不行：双击「自查」，把生成的报告发给卖家。</li>'
    + '</ul></div></body>');
}

// ---- 许可证（软停）----------------------------------------------------------
// 密码学校验在 PowerShell 侧（licence.ps1：RSA 验签 + 机器码比对 + 有效期），
// 它把结果写到 licence.state.json；这里只读结果，不在 Node 里重复实现一遍。
//
// 软停策略（客户体验优先）：
//   · 页面本身照常打开 —— 客户必须能看到"为什么不能用、机器码是多少、怎么买"
//   · 画面和输入全部拒绝（HTTP 402）
//   · /health 必须放行，否则 supervisor 会以为服务死了，无限重启
const LICENCE_STATE_FILE = join(HERE, 'licence.state.json');
const LICENCE_FILE = join(HERE, 'licence.json');
let licenceCache = { stamp: null, data: null };

// 机器码只能由 PowerShell 算（Node 拿不到 CPU/主板序列号），
// 它写在 state 文件里。单独取出来，避免和 readLicence 互相递归。
// 读 JSON 文件并容忍 UTF-8 BOM。
// 改动（独立审查 U2）：licence.state.json 当前由 licence-state.ps1 用
// UTF8Encoding($false) 写出，实测**不带 BOM**（首字节 7B）。
// 但只要有人把那段改成 -Encoding UTF8（PS 5.1 会加 BOM），JSON.parse 立刻抛错，
// 许可证闸门就会永久判为"未授权"。所以这里主动剥 BOM —— 不依赖"当前恰好没有 BOM"这个巧合。
function readJsonLoose(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
}

function readMachineCode() {
  const j = readJsonLoose(LICENCE_STATE_FILE);
  return j ? String(j.machineCode || '') : '';
}
// 旧算法机械码（v1，2026-11-03 T2）：老许可证是按它签的，验签时要一起比对。
function readMachineCodeAlt() {
  const j = readJsonLoose(LICENCE_STATE_FILE);
  return j ? String(j.machineCodeAlt || '') : '';
}

// ---- Tailscale 体检 / 连接诊断（2026-11-03，下一版候选 A1+A3）------------------
// 背景（竞品分析）：客户最大的门槛是"要装 Tailscale、要登录、要在线"，ToDesk 那种输入识别码
// 就能连的体验我们给不了；但可以做到"一眼看到卡在哪，并能一键拉起安装包"。
//
// 安全边界：
//   · 只调用 `tailscale status --json`（纯只读查询，本机实测 92ms），不联网、不改任何配置；
//   · 返回给页面的只是**摘要**：安装/启动/登录/在线、本机 tailnet 地址、节点列表（主机名/系统/
//     直连还是中继）、健康告警。不透传原始 JSON（里面有节点公钥、账号 UserID 等没必要给页面的东西）；
//   · /tailscale-install 只能拉起**安装目录里固定的** bin\tailscale-setup.exe，不接受任何参数。
const TAILSCALE_CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
];
function fileExists(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function resolveTailscaleExe() {
  try {
    const cfg = readProductConfig();
    const p = String((cfg.runtime && cfg.runtime.tailscalePath) || '').trim();
    if (p && fileExists(p)) return p;
  } catch { }
  const local = join(HERE, 'tailscale.exe');
  if (fileExists(local)) return local;
  for (const p of TAILSCALE_CANDIDATES) { if (fileExists(p)) return p; }
  // PATH 里找（winget / scoop / 手动装到别处的情况）
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const p = join(dir, 'tailscale.exe');
    if (fileExists(p)) return p;
  }
  return '';
}
function tailscaleStatusRaw() {
  return new Promise((resolve) => {
    const exe = resolveTailscaleExe();
    if (!exe) return resolve({ installed: false, exe: '' });
    execFile(exe, ['status', '--json'], { timeout: 6000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // 服务没起来时 tailscale.exe 会 exit 1 且没有 stdout —— 这是"没运行"，不是崩了
      if (!stdout) {
        return resolve({ installed: true, exe, error: String((err && err.message) || '读取 Tailscale 状态失败') });
      }
      let j = null;
      try { j = JSON.parse(String(stdout)); } catch { }
      if (!j) return resolve({ installed: true, exe, error: '读取 Tailscale 状态失败（返回的不是 JSON）' });
      resolve({ installed: true, exe, json: j });
    });
  });
}
async function tailscaleSummary() {
  const t = await tailscaleStatusRaw();
  const out = {
    installed: !!t.installed,
    ok: !!(t.json),
    backendState: '',
    running: false,       // 服务在跑且已登录
    online: false,        // 能连上 tailnet 控制面
    version: '',
    tun: false,
    dnsName: '',
    ips: [],
    onlinePeers: 0,
    peerTotal: 0,
    peers: [],
    health: [],
    hint: '',
    error: String(t.error || '')
  };
  if (!t.installed) {
    out.hint = '这台电脑还没装 Tailscale。点下面的「安装 Tailscale」，装完用手机同一个账号登录。';
    return out;
  }
  if (!t.json) {
    out.backendState = 'NoService';
    out.hint = 'Tailscale 服务没在运行。打开开始菜单里的 Tailscale（或重启电脑），登录后状态会变成「已连接」。';
    return out;
  }
  const j = t.json || {};
  out.backendState = String(j.BackendState || '');
  out.version = String(j.Version || '').split('-')[0];
  out.tun = !!j.TUN;
  const self = j.Self || {};
  out.dnsName = String(self.DNSName || '').replace(/\.$/, '');
  out.ips = (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).map(String).filter((x) => x && x.indexOf(':') < 0);
  out.online = !!self.Online;
  out.running = out.backendState === 'Running';
  const peersObj = (j.Peer && typeof j.Peer === 'object') ? j.Peer : {};
  const peers = [];
  for (const k of Object.keys(peersObj)) {
    const p = peersObj[k] || {};
    peers.push({
      host: String(p.HostName || p.DNSName || '未命名'),
      os: String(p.OS || ''),
      online: !!p.Online,
      direct: !!String(p.CurAddr || '').trim(),      // 有 CurAddr = 走直连；没有 = 走 DERP 中继
      relay: String(p.Relay || ''),
      tunnel: !!p.ExitNode
    });
  }
  peers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  out.peerTotal = peers.length;
  out.onlinePeers = peers.filter((p) => p.online).length;
  out.peers = peers.slice(0, 8);
  out.health = (Array.isArray(j.Health) ? j.Health : []).map(String).filter(Boolean).slice(0, 3);
  if (out.backendState === 'NeedsLogin') out.hint = 'Tailscale 已安装但还没登录。打开 Tailscale 点「Log in」，用手机同一个账号。';
  else if (out.backendState === 'Stopped') out.hint = 'Tailscale 服务已停止。打开 Tailscale 让它恢复运行。';
  else if (!out.running) out.hint = 'Tailscale 状态异常（' + (out.backendState || '未知') + '）。打开 Tailscale 看看，或重启一次。';
  else if (!out.online) out.hint = 'Tailscale 在运行但没连上 tailnet：先检查网络；如果开着代理/VPN，先关掉再试。';
  return out;
}

// ---- 文本剪贴板（2026-11-03，A5 第一步）-------------------------------------
// 手机 ↔ 电脑之间传一段文字（验证码、链接、命令）。走系统剪贴板，所以电脑上的 Ctrl+V 直接可用。
// 安全/稳定：
//   · 只走鉴权后的接口（默认就是"必须密钥"），文本长度上限 64KB；
//   · 写剪贴板时**文本不进命令行**：先落临时文件，PowerShell 从文件读，避免引号/转义/注入；
//   · PowerShell 超时 5 秒，失败如实返回，不影响画面。
const CLIP_MAX_BYTES = 64 * 1024;
function readSystemClipboard() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw'],
      { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: String((err && err.message) || err) });
        resolve({ ok: true, text: String(stdout || '') });
      });
  });
}
function writeSystemClipboard(text) {
  return new Promise((resolve) => {
    const tmp = join(process.env.TEMP || '.', 'pa-clip-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt');
    try { writeFileSync(tmp, text, 'utf8'); } catch (e) { return resolve({ ok: false, error: '写临时文件失败：' + ((e && e.message) || e) }); }
    const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + '$t=Get-Content -LiteralPath \'' + tmp.replace(/'/g, "''") + '\' -Raw -Encoding UTF8; Set-Clipboard -Value $t';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 5000, windowsHide: true }, (err) => {
        try { unlinkSync(tmp); } catch { }
        if (err) return resolve({ ok: false, error: String((err && err.message) || err) });
        resolve({ ok: true });
      });
  });
}

// ---- 小文件传输（2026-11-03，A5 第二步）--------------------------------------
// 手机 → 电脑：POST /file?name=<文件名>（原始字节流，≤32MB），存到 用户\Downloads\PhoneAccess\。
// 查看/回传：GET /files 列表、GET /file?name= 下载。
// 安全边界：
//   · **只开放这个固定目录**，不能读电脑上任意文件（不接受路径、只接受相对文件名）；
//   · 文件名做白名单清洗（去目录/控制字符/保留名/结尾点和空格），长度上限 120；
//   · 上传大小上限 32MB，超过直接断开；文件名重名自动加 (1)(2)…
//   · 走默认鉴权（必须密钥/cookie），和画面接口同一套。
const UPLOAD_DIR = join(process.env.USERPROFILE || HERE, 'Downloads', 'PhoneAccess');
const UPLOAD_MAX = 32 * 1024 * 1024;
function safeUploadName(raw) {
  let n = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) return '';
  if (n.length > 120) {
    const ext = (n.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
    n = n.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n;
  return n;
}
function uniqueUploadPath(name) {
  let candidate = join(UPLOAD_DIR, name);
  let n = 1;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  while (true) {
    try { statSync(candidate); } catch { return candidate; }
    if (n > 99) return join(UPLOAD_DIR, stem + '-' + Date.now() + ext);
    candidate = join(UPLOAD_DIR, stem + '(' + n + ')' + ext);
    n++;
  }
}
function listUploads() {
  const out = [];
  try {
    for (const name of readdirSync(UPLOAD_DIR)) {
      let st = null;
      try { st = statSync(join(UPLOAD_DIR, name)); } catch { continue; }
      if (!st || !st.isFile()) continue;
      out.push({ name: name, size: st.size, at: Math.round(st.mtimeMs) });
    }
  } catch { }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, 50);
}

// ---- 高性能模式（Sunshine/Moonlight）服务端代理（2026-11-03，S3）--------------------
// 客户电脑上由 sunshine-integration.ps1 装好 Sunshine 并生成随机凭据（sunshine-credentials.json）。
// 手机页只需要「看状态 / 看等待配对的设备 / 提交 PIN」三件事，这里把 Sunshine 的本地 API
// （https://127.0.0.1:47990，自签证书 + Basic Auth）包一层，凭据只在服务端，不下发到页面。
//
// 安全：这三个接口都在默认鉴权之后；凭据文件只允许本进程读；PIN 只转发给本机 Sunshine。
const SUNSHINE_EXE = 'C:\\Program Files\\Sunshine\\sunshine.exe';
const SUNSHINE_CONF = 'C:\\Program Files\\Sunshine\\config\\sunshine.conf';
const SUNSHINE_CRED_FILE = join(HERE, 'sunshine-credentials.json');
// Sunshine 绑 tailnet IP 时**不监听回环**，本地代理必须跟着 conf 的 bind_address 走；
// 否则 /sunshine-status 永远「未运行」、配对接口全部连不上（2026-11-03 真机踩到）。
let sunshineHostCache = { stamp: '', host: '' };
function sunshineHost() {
  try {
    const st = statSync(SUNSHINE_CONF);
    const stamp = String(st.mtimeMs);
    if (stamp !== sunshineHostCache.stamp) {
      let h = '';
      try {
        const txt = readFileSync(SUNSHINE_CONF, 'utf8');
        const m = txt.match(/^\s*bind_address\s*=\s*(\S+)\s*$/m);
        if (m) h = String(m[1]).trim();
      } catch { }
      const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h);
      if (!(tailnet || h === '127.0.0.1' || h === 'localhost')) h = '127.0.0.1';
      sunshineHostCache = { stamp: stamp, host: h };
    }
    return sunshineHostCache.host || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}
function readSunshineCreds() {
  const j = readJsonLoose(SUNSHINE_CRED_FILE);
  if (j && j.username && j.password) return { username: String(j.username), password: String(j.password) };
  return null;
}
function sunshineApi(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const creds = readSunshineCreds();
    if (!creds) return resolve({ ok: false, httpStatus: 0, error: 'no-credentials', body: '' });
    let data = '';
    let settled = false;
    const done = (obj) => { if (!settled) { settled = true; resolve(obj); } };
    let req;
    try {
      req = https.request({
        host: sunshineHost(),
        port: 47990,
        path: apiPath,
        method: method,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          authorization: 'Basic ' + Buffer.from(creds.username + ':' + creds.password).toString('base64'),
          'content-type': 'application/json',
          'user-agent': 'PhoneAccess-Sunshine-Proxy'
        }
      }, (res) => {
        res.on('data', (c) => { data += c; if (data.length > 256 * 1024) { try { res.destroy(); } catch { } } });
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, httpStatus: res.statusCode, body: data }));
        res.on('error', (e) => done({ ok: false, httpStatus: res.statusCode || 0, error: String((e && e.message) || e), body: data }));
      });
    } catch (e) {
      return done({ ok: false, httpStatus: 0, error: String((e && e.message) || e), body: '' });
    }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { } });
    req.on('error', (e) => done({ ok: false, httpStatus: 0, error: String((e && e.message) || e), body: data }));
    if (body) { try { req.write(JSON.stringify(body)); } catch { } }
    req.end();
  });
}
function sunshineWebUp() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let sock;
    try { sock = net.connect(47990, sunshineHost()); } catch { return done(false); }
    sock.setTimeout(900);
    sock.once('connect', () => { try { sock.destroy(); } catch { } done(true); });
    sock.once('timeout', () => { try { sock.destroy(); } catch { } done(false); });
    sock.once('error', () => { try { sock.destroy(); } catch { } done(false); });
  });
}

// 读"是否授权"。
//
// 改动（独立审查 H3）：原来这里直接把 licence.state.json 里的 usable 字段当作结论。
// 但那是本机一个普通 JSON 文件——客户（或任何恶意程序）随手写一个
//   {"usable": true}
// 就能白嫖整个产品。等于许可证形同虚设。
//
// 现在的权威判定：**由本进程自己验 licence.json 的 RSA 签名**（checkLicenceObject），
// 猜不出来的东西才叫授权。licence.state.json 降级为"只提供展示信息"
// （机器码、客户名、branding、support），它的 usable 字段一律忽略。
//
// 残留风险（诚实记录）：机器码来自 state 文件，仍是可写的。理论上可以把一台机器的
// 许可证连同一个伪造的 machineCode 一起搬过来。但那需要同时伪造机器码字段，
// 比"翻一个 true"要麻烦得多；而纯客户端授权在原理上就挡不住有决心的破解者。
// 这里的目标是"防随手转发/防随手解锁"，不是"防逆向"。
function readLicence() {
  let stateMtime = -1;
  let liveMtime = -1;
  try { stateMtime = statSync(LICENCE_STATE_FILE).mtimeMs; } catch { }
  try { liveMtime = statSync(LICENCE_FILE).mtimeMs; } catch { }
  // 缓存键必须把**两个文件各自的时间**都带上，而且不能取最大值。
  // 踩过的坑：写成 Math.max(状态文件时间, 许可证时间) 时，因为守护进程每 8 秒重写
  // 状态文件、它的时间几乎总是更新，于是"删掉 licence.json"不会改变这个最大值，
  // 缓存命中 → 继续返回旧的"已授权" → 画面在软停状态下照样能看。
  // 用复合键就不存在这个问题：任何一个文件被删/被改，键都变。
  const stamp = String(stateMtime) + '|' + String(liveMtime);

  if (stamp === licenceCache.stamp && licenceCache.data) return licenceCache.data;

  // 展示信息（不可信，仅用于显示）
  let disp = {};
  disp = readJsonLoose(LICENCE_STATE_FILE) || {};

  // 权威判定
  let doc = null;
  doc = readJsonLoose(LICENCE_FILE);
  const machine = readMachineCode();
  const machineAlt = readMachineCodeAlt();
  let chk;
  if (!doc) {
    chk = { ok: false, state: 'missing', message: '这台电脑还没有许可证。' };
  } else {
    chk = checkLicenceObject(doc, machine, machineAlt);
  }

  const data = {
    usable: !!chk.ok,
    state: chk.state || (chk.ok ? 'ok' : 'error'),
    message: chk.message || '',
    // 页面「本机机器码」一律显示**当前算法**的机器码（v2，含 SMBIOS UUID）。
    // 2026-11-03 T2 之前这里是优先显示许可证里的 machine——老客户升级后会看到旧码，
    // 续费时把旧码发回来，又绑回 v1，撞码问题白修了。
    machineCode: machine || (chk.payload && chk.payload.machine) || String(disp.machineCode || ''),

    name: (chk.payload && chk.payload.name) || '',
    issued: (chk.payload && chk.payload.issued) || '',
    // 永久许可证在 payload 里存空字符串，对外统一显示成 never（页面和报告都用这个值）
    expires: chk.ok ? ((chk.payload && chk.payload.expires) || 'never') : '',
    edition: (chk.payload && chk.payload.edition) || '',
    // 展示用：购买/捐赠入口由 PowerShell 扫 branding 目录得出，与授权无关
    support: disp.support || null,
    branding: disp.branding || null,
    // 7 天全功能试用（2026-10-30）：trial 块由 trial.ps1 算出、licence-state.ps1 写进状态文件。
    // 试用期内按"全功能"对待（超清不限时 + 个性化解锁），到期自动回落免费档。
    // effectiveUsable 是页面/发帧/并发上限**统一**要读的那个字段；usable 仍然只表示"有正式许可证"。
    trial: disp.trial || null,
    effectiveUsable: !!(chk.ok || (disp.trial && disp.trial.active))
  };
  licenceCache = { stamp: stamp, data: data };
  return data;
}

// 便宜的全功能判断：许可证有效 或 试用期内。画面发帧、并发上限、页面解锁都用它。
function isFullFunction() {
  try {
    const l = readLicence();
    return !!(l && l.effectiveUsable);
  } catch { return false; }
}

// ---- 许可证验签（Node 侧）----------------------------------------------------
// 为什么要在 Node 里再实现一遍：客户现在可以直接在手机上把许可证"粘贴"进来，
// 服务端接到内容后必须先验签再落盘，不能把客户递来的任意内容写进 licence.json。
// 规范化和 licence.ps1 的 Get-LicencePayloadString 必须逐字节一致：
//   name \n machine \n issued \n expires(空=>never) \n edition \n ver
// 公钥对应 seller-keys\private.xml，换私钥时这里和 licence.ps1 都要同步改。
const LICENCE_PUBLIC_N = '0fXt+uBcg+IKmrycblhXiD5L9nNXF1CoXxfPc9opkNGgzji3FvJL9RyDAipG+lbgugLCkZSSftkOve/HhTzoW9QfEixV4VPwHz5aOMo5+r6H39i1htpRbZnE54Z4d+lftsOjZKO9C5g9QH7TaNNrrmUFlinnPe+5ilebgDsJ013Bc1c5R0/kg3abA8GhLtBMGnUyZ75u3wAddyhTHBa+soGtGOQoL39BrY9vBjAa8DXHxU+EskhdcFViBvOvoDcJlG1y59eInUqO26qpHemc3xpMy1C8y3xED5p18cORRt1uLr83D5ZRJXTiF77Fjg+pU77GnXKkGmMrXccm/ZuMEQ==';
const LICENCE_PUBLIC_E = 'AQAB';

function licencePayloadText(p) {
  const exp = (p.expires == null || p.expires === '') ? 'never' : String(p.expires);
  return [p.name, p.machine, p.issued, exp, p.edition, p.ver]
    .map((x) => String(x == null ? '' : x)).join('\n');
}

function checkLicenceObject(doc, machineOverride, altOverride) {
  // 返回 { ok, state, message, payload }
  // machineOverride 由调用方提供（避免和 readLicence 互相递归）；
  // 不传时才回落到 readMachineCode()。
  if (!doc || typeof doc !== 'object') return { ok: false, state: 'bad-format', message: '内容不是许可证格式' };
  const p = doc.payload;
  const sig = doc.sig;
  if (!p || typeof p !== 'object') return { ok: false, state: 'bad-format', message: '许可证缺少 payload' };
  if (!sig || typeof sig !== 'string') return { ok: false, state: 'bad-format', message: '许可证缺少签名' };
  if (!p.machine || !p.name || !p.ver) return { ok: false, state: 'bad-format', message: '许可证字段不全' };

  // 改动（独立审查 M2）：强制六个字段都是**字符串**。
  // 原来 Node 用 String(x) 规范化、PowerShell 用 [string]$x，两者在布尔值上结果不同
  // （"true" vs "True"），数字/数组/null 也有各自的差异。而签名覆盖的正是这个字符串，
  // 所以只要字段类型不确定，就有"一边验过、一边验不过"的可能。
  // 我们的签发工具本来只写字符串，所以这里直接拒绝非字符串即可彻底消除这一类问题，
  // 不需要让两边都去模拟对方的类型转换语义。
  for (const f of ['name', 'machine', 'issued', 'expires', 'edition', 'ver']) {
    if (typeof p[f] !== 'string') {
      return { ok: false, state: 'bad-format', message: '许可证字段 ' + f + ' 类型不对（应为文本）' };
    }
  }

  // 改动（第二轮 P2-2 / H3-c）：六个字段里禁止 \r / \n。
  // 签名覆盖的 payload 是用 '\n' 把六个字段拼起来的，某个字段自身含换行时，
  // 同一段签名可以被重新切成另一种 payload（machine/expires 有校验兜底改不动，
  // 实际影响是 name/edition 的显示值可以被挪移）。两端一起拒绝最便宜，也不影响
  // 已签发的正常许可证（正常字段里不会有换行）。
  for (const f of ['name', 'machine', 'issued', 'expires', 'edition', 'ver']) {
    if (/[\r\n]/.test(p[f])) {
      return { ok: false, state: 'bad-format', message: '许可证字段 ' + f + ' 里不能有换行' };
    }
  }

  // 改动（第二轮 P2-3 / H3-d）：expires 是**全空白**（不是空字符串）要判格式错。
  // 空字符串表示永久（卖家工具签永久许可证就写 ""）；全空白是畸形数据，PowerShell 侧
  // 一直按 bad-format 拒，Node 原来 trim 后当永久放行了——两端必须一致。
  if (p.expires !== '' && String(p.expires).trim() === '') {
    return { ok: false, state: 'bad-format', message: '许可证的有效期字段只有空格（应为空或 YYYY-MM-DD）' };
  }

  let good = false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: LICENCE_PUBLIC_N, e: LICENCE_PUBLIC_E }, format: 'jwk' });
    const v = createVerify('RSA-SHA256');
    v.update(Buffer.from(licencePayloadText(p), 'utf8'));
    good = v.verify(key, Buffer.from(sig, 'base64'));
  } catch (e) {
    return { ok: false, state: 'bad-signature', message: '签名校验出错：' + e.message };
  }
  if (!good) return { ok: false, state: 'bad-signature', message: '签名不对（可能被改过，或者不是我们发的）' };

  // 改动（第二轮 P1-2 / H3-b）：本机机器码读不到时**直接判不可用**（fail-closed）。
  // 原来写的是 `if (mine && ...)` —— licence.state.json 缺失/损坏时 mine='' 就把整个
  // 机器码比对跳过了，于是任何一张泄漏出去的已签名许可证都能在这台机器上落地；
  // 而且只要守护进程没写过 state 文件（例如没跑守护），这个状态可以一直维持。
  // PowerShell 侧的 Test-Licence 在同样情况下返回 error（不可用），两边必须一致。
  const mine = String(machineOverride == null ? readMachineCode() : machineOverride || '').toUpperCase();
  const altCode = String(altOverride == null ? readMachineCodeAlt() : altOverride || '').toUpperCase();
  if (!mine) {
    return { ok: false, state: 'no-machine-code', message: '还没读到这台电脑的机器码。请等几秒（程序定期重算）或重启一次「手机远程」后再试。' };
  }
  // 改动（第二轮 P2-3 / H3-d）：机器码比较前 trim —— PowerShell 侧一直是 trim 的，
  // Node 侧原来不 trim，导致"末尾多个空格的许可证"一边过一边不过。方向上是往宽松统一，
  // 但机器码本身就是十六进制+连字符，trim 不会放过错误的机器。
  // 2026-11-03 T2：双算法兼容——v2（含 SMBIOS UUID）不匹配时再比 v1（老许可证）。
  const pm = String(p.machine).trim().toUpperCase();
  const okMachine = (pm === mine.trim()) || (!!altCode && pm === altCode.trim());
  if (!okMachine) {
    return { ok: false, state: 'machine-mismatch', message: '这是发给另一台电脑的许可证（本机机器码 ' + mine + '）' };
  }

  // 有效期：严格解析，解析不出来就**当作无效**（fail-closed）。
  // 改动（独立审查 L2）：原来是 `if (!isNaN(...) && ...)` —— 日期写成
  // "2026/12/31" 或 "abc" 时 isNaN 为真，整个过期检查被跳过，等于永久有效。
  // 现在只接受 YYYY-MM-DD，其余一律判为格式错误。
  const expStr = (p.expires == null) ? '' : String(p.expires).trim();
  if (expStr && expStr !== 'never') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expStr);
    if (!m) return { ok: false, state: 'bad-format', message: '许可证的有效期格式不对（应为 YYYY-MM-DD）' };
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    // 改动（第二轮 P2-3 / H3-d）：到期判定改成**本地时区**的当天 23:59:59，
    // 与 PowerShell 侧（`$exp.Date -lt (Get-Date).Date`，本地日期）口径一致。
    // 原来用 Date.UTC 比本地日期晚约 8 小时，同一张到期许可证两端会得出不同结论。
    const exp = new Date(y, mo - 1, d, 23, 59, 59);
    // 反向校验：防止 2026-02-31 这种被 Date 自动进位的假日期（用本地方法读回，和上面构造一致）
    if (exp.getFullYear() !== y || (exp.getMonth() + 1) !== mo || exp.getDate() !== d) {
      return { ok: false, state: 'bad-format', message: '许可证的有效期不是真实日期' };
    }
    if (exp.getTime() < Date.now()) {
      return { ok: false, state: 'expired', message: '这张许可证已于 ' + expStr + ' 到期' };
    }
  }
  return { ok: true, state: 'ok', message: '许可证有效', payload: p };
}

// 客户可能粘过来三种形态，都接受：
//   1) 完整 JSON（含 payload / sig）
//   2) 只有 payload 和 sig 的紧凑 JSON（单行）
//   3) 卖家工具输出的"许可证代码"：base64(JSON)，聊天软件里转发不会串格式
function parseLicenceText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  // 去掉空白和换行后按 base64 解
  const compact = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  try {
    const dec = Buffer.from(compact, 'base64').toString('utf8');
    if (dec.trim().startsWith('{')) return JSON.parse(dec);
  } catch { }
  return null;
}

// ---- 半免费（freemium，2026-10-29 起）：超清每日配额 --------------------------
// 商业形态：基本功能全免费（看画面、触控、声音、流畅模式、高清/标准画质都不需要许可证）。
// 许可证只解锁两样：
//   1) 超清画质（抓屏宽 > ULTRA_LIMIT 的档位，即 2560 档）不限时长 —— 未授权每天免费 1 小时
//   2) 个性化（主题 / 光标大小颜色 / 自定义导入）—— 页面按 /licence 的 usable 锁定
//
// 强制点选在**发帧处**而不是设置处：配额用完后把发出去 frames 缩到 1920 宽（= 高清档）。
// 这样不用重启抓屏、不用改配置、客户不用做任何操作，画面立刻降一档；第二天 0 点自动恢复。
// 计时口径 = "真的在看超清"：只有 MJPEG 流/轮询按 >1920 宽发帧时才累计秒数。
// 流畅模式（WebRTC，1280 宽）和高清/标准档不计时 —— 它们本来就免费不限时。
// 未授权用户仍可以把 maxCaptureWidth 设成 2560（/set-quality 不拦），只是超额后按高清出图。
//
// 持久化：ultra-usage.json（{date:'YYYY-MM-DD', seconds:N}，本地时区日历日）。
// 重启服务不会把当日已用时长清零；换天自动归零。
const ULTRA_LIMIT = 1920;   // 抓屏宽超过它 = 超清档
const cfgFreemium = productConfig.freemium || {};
const ULTRA_FREE_SEC = (Number(cfgFreemium.ultraFreeSecPerDay) > 0) ? Math.round(Number(cfgFreemium.ultraFreeSecPerDay)) : 3600;
// 免费版并发观看上限（2026-10-30 用户拍板：最多 3 台设备同时看）。许可证/试用期内不限。
// 只限制"看画面"的连接数（清晰模式 /stream + 流畅模式 RTC），不影响同一台设备重连。
const FREE_MAX_VIEWERS = (Number(cfgFreemium.freeMaxViewers) > 0) ? Math.round(Number(cfgFreemium.freeMaxViewers)) : 3;
const ULTRA_USAGE_FILE = join(HERE, 'ultra-usage.json');
let ultraUsage = { date: '', seconds: 0 };
try {
  const uj = readJsonLoose(ULTRA_USAGE_FILE);
  if (uj && Number.isFinite(Number(uj.seconds))) {
    ultraUsage = { date: String(uj.date || ''), seconds: Math.max(0, Math.round(Number(uj.seconds))) };
  }
} catch { }
function localDateStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function ultraRollDay() {
  const today = localDateStr();
  if (ultraUsage.date !== today) ultraUsage = { date: today, seconds: 0 };
}
let ultraServeAt = 0;    // 最近一次"按超清宽度发帧"的时刻（3 秒窗口内视为正在看）
let ultraDirty = false;
function ultraNoteServe() { ultraServeAt = Date.now(); }
function ultraFlush() {
  if (!ultraDirty) return;
  ultraDirty = false;
  try { writeFileSync(ULTRA_USAGE_FILE, JSON.stringify(ultraUsage), 'utf8'); } catch { }
}
setInterval(() => {
  ultraRollDay();
  // 抓屏是超清档 + 未授权 + 最近 3 秒内真的按超清发过帧 → 计 1 秒
  if (CAP_W > ULTRA_LIMIT && Date.now() - ultraServeAt < 3000) {
    let lic = null;
    try { lic = readLicence(); } catch { lic = null; }
    // 2026-10-30：试用期内算全功能，不扣每日免费额度
    if (!lic || !lic.effectiveUsable) { ultraUsage.seconds += 1; ultraDirty = true; }
  }
}, 1000);
setInterval(ultraFlush, 10000);
process.on('exit', ultraFlush);
function ultraStatus() {
  ultraRollDay();
  let lic = null;
  try { lic = readLicence(); } catch { lic = null; }
  // 2026-10-30：许可证 或 试用期内 = 全功能（超清不限时）
  const licensed = !!(lic && lic.effectiveUsable);
  const ultra = CAP_W > ULTRA_LIMIT;
  const remaining = Math.max(0, ULTRA_FREE_SEC - ultraUsage.seconds);
  const exhausted = ultra && !licensed && remaining <= 0;
  return {
    ultra, licensed, limitSec: ULTRA_FREE_SEC,
    usedSec: ultraUsage.seconds, remainingSec: remaining,
    exhausted, clamped: exhausted,
    captureWidth: CAP_W, deliverWidth: exhausted ? Math.min(CAP_W, ULTRA_LIMIT) : CAP_W,
    // 试用信息透给页面（设置面板显示"试用还剩 X 天"）
    trial: (lic && lic.trial) || null,
    freeMaxViewers: FREE_MAX_VIEWERS
  };
}
// 实际允许发出去的帧宽上限：未授权 + 当日超清时长用完 → 压到 1920（高清档）
function deliverCapW() {
  return CAP_W > ULTRA_LIMIT && ultraStatus().exhausted ? ULTRA_LIMIT : CAP_W;
}

// ---- 应用内更新的下载进度（2026-10-30 加）-----------------------------------
// 以前 /update-install 只有"全部下载完"或"10 分钟超时"两种结局：国内不翻墙时
// 连 objects.githubusercontent.com 会一直挂着，页面永远"下载中…"，电脑端也不报错。
// 现在改成流式下载 + 20 秒无数据看门狗 + 页面轮询进度，失败能立刻说清楚原因。
let updateState = {
  at: 0,                 // 最近一次状态变化
  phase: 'idle',         // idle | connecting | downloading | done | error
  bytes: 0, total: 0,
  startedAt: 0, lastByteAt: 0,
  error: '', url: ''
};
function updatePublicState() {
  const now = Date.now();
  const secs = updateState.startedAt ? Math.max(0.2, (now - updateState.startedAt) / 1000) : 0;
  return {
    active: updateState.phase === 'connecting' || updateState.phase === 'downloading',
    phase: updateState.phase,
    bytes: updateState.bytes,
    total: updateState.total,
    pct: updateState.total > 0 ? Math.min(100, Math.round(updateState.bytes * 100 / updateState.total)) : 0,
    speedKB: (updateState.bytes > 0 && secs > 0) ? Math.round(updateState.bytes / 1024 / secs) : 0,
    idleSec: updateState.lastByteAt ? Math.max(0, Math.round((now - updateState.lastByteAt) / 1000)) : 0,
    elapsedSec: Math.round(secs),
    error: updateState.error || '',
    at: updateState.at
  };
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // ---- 统一鉴权（2026-10-31 重写：默认必须密钥 + 显式公开白名单）--------------
  // 旧模型是「本机自连就免鉴权 + 危险路径黑名单」。问题：
  //   tailscale serve 把请求转成 127.0.0.1，任何 tailnet 设备都成了「本机自连」，
  //   黑名单每加一条新路由都可能漏（/licence、/frame.jpg、/stream 都曾漏掉）。
  // 新模型：除了下面明确列出的公开资源，所有请求都必须带密钥（?k= 或 cookie）。
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // 2026-10-31 安全收紧（用户要求）：只接受 Tailscale 网络内的访问。
  // 允许来源：本机 127.0.0.1 / ::1（tailscale serve 的转发也走这里），或 tailnet 100.64.0.0/10。
  // 这样即使以后误把局域网地址加回监听，同一 Wi-Fi 的其它设备也进不来；同一 Wi-Fi 下想更快，
  // 由 Tailscale 自己选直连路径，而不是绕过 Tailscale。
  const fromTailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ra);
  if (ra !== '127.0.0.1' && ra !== '::1' && !fromTailnet) {
    try {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('只接受 Tailscale 访问：请先在手机上打开 Tailscale 并连接，再用电脑上显示的地址打开。');
    } catch { }
    return;
  }

  // 收款码等品牌图片：未授权客户要靠它找到购买方式，必须公开
  const isBrandingAsset = url.pathname.startsWith('/branding/') && /\.(png|jpe?g)$/i.test(url.pathname);
  // 明确公开的少量资源（不含任何画面/控制/许可证数据）
  const PUBLIC_PATHS = new Set(['/health', '/sw.js', '/icon-192.png', '/icon-512.png']);
  // 浏览器取 manifest 时不发 cookie，页面里现签一个短时 token 例外
  const manifestOk = url.pathname === '/manifest.json' && manifestTokenOk(url);
  if (!PUBLIC_PATHS.has(url.pathname) && !isBrandingAsset && !manifestOk && !authorized(req, url)) {
    rejectAuth(req, res, url, ra);
    return;
  }

  // 跨站写请求一律拒绝（Origin 与 Host 不一致）。读请求不强制，兼容命令行/本地脚本。
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const originHdr = String(req.headers.origin || '');
    if (originHdr) {
      let sameHost = false;
      try {
        const oh = new URL(originHdr).host;
        sameHost = (oh && oh === String(req.headers.host || ''));
      } catch { sameHost = false; }
      if (!sameHost) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'cross-origin' }));
        return;
      }
    }
  }

  // ---- 半免费：不再整站拦未授权（原 402 软停闸门已拆除，2026-10-29）----------
  // 原行为：没许可证 → 除白名单外全部 402，画面和操作全停。
  // 现行为：基本功能全免费，密钥（第一/第二道鉴权）照旧把陌生人挡在外面；
  // 许可证只影响两件事：
  //   · 超清画质配额（见上面 ultraStatus/deliverCapW，强制点在 /frame.jpg 与 /stream 发帧处）
  //   · 个性化功能（页面按 /licence 的 usable 锁定，属外观类功能，客户端强制即可）
  // /branding/ 下的收款码图片仍然无条件放行：未授权客户要靠它找到购买方式（前面已判定并放行）。

  // 收款码等品牌图片（客户自己放进 branding\ 目录）
  if (isBrandingAsset) {
    // 中文文件名在 URL 里是百分号编码的，必须解码后才能对上磁盘上的文件名
    let name = url.pathname.slice('/branding/'.length);
    try { name = decodeURIComponent(name); } catch { }
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad-path');
      return;
    }
    try {
      const buf = readFileSync(join(HERE, 'branding', name));
      const type = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=300', 'content-length': buf.length });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not-found');
    }
    return;
  }

  // 客户把许可证"粘贴"上来（POST）。这是最重要的一步简化：
  // 以前客户要拿文件、改名、找 %LOCALAPPDATA% 目录、拖进去——对非技术用户基本无法自助完成。
  // 现在他在"未授权"页面上直接粘贴，服务端验签后落盘，几秒内生效。
  if (url.pathname === '/licence' && req.method === 'POST') {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      let text = '';
      try {
        const m = JSON.parse(body || '{}');
        text = String(m.text || m.licence || '');
      } catch {
        text = body;   // 客户也可能直接把 JSON 原文当 body 发上来
      }
      const doc = parseLicenceText(text);
      if (!doc) return reply(400, { ok: false, message: '看不懂这段内容。请把卖家发你的整段文字原样复制过来。' });

      const chk = checkLicenceObject(doc);
      if (!chk.ok) return reply(400, { ok: false, state: chk.state, message: chk.message });

      const target = join(HERE, 'licence.json');
      try {
        writeFileSync(target, JSON.stringify(doc, null, 2), 'utf8');
      } catch (e) {
        return reply(500, { ok: false, message: '写入许可证失败：' + e.message });
      }
      // 立刻让本进程的状态缓存失效，随后守护进程会在几秒内重写 licence.state.json
      licenceCache = { stamp: null, data: null };
      console.log('screen-server: licence installed for ' + (chk.payload && chk.payload.machine));
      reply(200, { ok: true, message: '许可证已装好，几秒后自动生效', name: chk.payload.name });
    });
    return;
  }

  // 许可证状态 + 机器码 + 购买/捐赠入口信息（页面未授权时靠它显示提示）
  if (url.pathname === '/licence') {
    const lic = readLicence();
    let support = null;
    try {
      const cfgPath = join(HERE, 'product.config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.support) support = cfg.support;
    } catch { }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      // usable = 全功能（许可证 或 7 天试用期内）——页面用它解锁超清/个性化，语义保持向后兼容
      usable: !!lic.effectiveUsable,
      // licensed = 真的装了许可证（不含试用）；页面用它区分"试用中"和"已购买"
      licensed: !!lic.usable,
      trial: lic.trial || null,
      state: lic.state || 'missing',
      machineCode: lic.machineCode || '',
      name: lic.name || '',
      expires: lic.expires || '',
      // edition：许可证里写 'trial'（或 'month'）= 体验版（1 个月），其它视为专业版；
      // 页面据此显示不同徽章（2026-10-31 加）
      edition: lic.edition || '',
      message: lic.message || '',
      support: support,
      // 当前抓屏宽度上限（手机「设置」里高亮当前画质档位用）
      captureWidth: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\\uFEFF/, '')); return Number((c.screen && c.screen.maxCaptureWidth) || 0) || 0; } catch { return 0; } })(),
      // 版本号给手机「设置」显示；来源是 product.config.json 的 version
      version: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\\uFEFF/, '')); return String(c.version || ''); } catch { return ''; } })(),
      // 安装备选（2026-11-02）：设置面板里**常驻**显示「国内网盘 / Gitee / GitHub」三个手动下载入口。
      // 不依赖 /update-check —— 客户不点检查更新、或 GitHub 那边连不上时，也能自己拿到安装包。
      download: (function () {
        try {
          const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, ''));
          const u = c.update || {};
          const g = u.gitee || {};
          const h = u.github || {};
          const mp = String(u.mirrorPage || '').trim();
          return {
            version: String(c.version || ''),
            mirrorPage: /^https:\/\/\S+/i.test(mp) ? mp : '',
            mirrorPageNote: String(u.mirrorPageNote || '').slice(0, 80),
            giteePage: (g.owner && g.repo) ? ('https://gitee.com/' + String(g.owner) + '/' + String(g.repo) + '/releases') : '',
            githubPage: (h.owner && h.repo) ? ('https://github.com/' + String(h.owner) + '/' + String(h.repo) + '/releases/latest') : ''
          };
        } catch { return null; }
      })(),
      // branding 由 licence-state.ps1 扫描 branding\ 目录得出（收款码、联系方式），
      // 必须一起返回，否则页面拿不到二维码和联系方式的路径。
      branding: lic.branding || null,
      // 套餐页（2026-10-30）：价格与文案全在 product.config.json 的 plans 里，
      // 卖家改价/改档位不用改代码、不用重新发版（重启服务即生效）。
      plans: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); return c.plans || null; } catch { return null; } })(),
      // 分享文案（2026-10-30）：产品推广用，内容在 product.config.json 的 share 里改，不用改代码
      share: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); return c.share || null; } catch { return null; } })(),
      // 半免费：超清每日配额状态（设置面板显示"今天还剩几分钟超清"、个性化锁定用）
      ultraQuota: (function () { try { return ultraStatus(); } catch { return null; } })()
    }));
    return;
  }

  if (url.pathname === '/health') {
    const st = input.status();
    const healthSid = String(url.searchParams.get('s') || '').slice(0, 24);   // 只报这条会话自己的丢帧
    // 改动（独立审查 + 实测确认的信息泄露）：
    // /health 是**许可证豁免**路径，而 Tailscale serve 转发进来时源地址是 127.0.0.1，
    // 会命中 isLocalConn 豁免 —— 于是同一 tailnet 里任何人都能不带密钥读 /health，
    // 而 /health 里带着 fg=<前台窗口标题>。实测：不带密钥就拿到了
    // fg="Select Workspace Directory"。窗口标题会暴露客户正在用什么软件、在处理什么文档。
    //
    // 修法：前台窗口标题只发给**真正带密钥**的请求（页面自己有 cookie，照常显示 UIPI 提示）；
    // 没密钥的请求只拿到计数类字段，够守护进程判断存活，不泄露内容。
    const authorizedReq = authorized(req, url);
    const fgField = authorizedReq ? (' fg=' + JSON.stringify(st.foreground)) : '';
    // input= 里也带着 foreground（前台窗口标题），同样只给带密钥的请求
    const inStats = input.stats();
    const inForOut = authorizedReq ? inStats : Object.assign({}, inStats, { foreground: '' });
    // uq= 超清配额（半免费）：uq=na 不适用（已授权或抓屏本来就不是超清档）；
    // uq=<剩余秒数> 未授权今日还剩多少超清秒数；uq=0:x 今日已用完、正在按高清出图。
    // 页面每 2 秒轮询 /health，靠它做"配额用完"的即时提示，不用另开轮询。
    const uqField = (function () {
      try {
        const us = ultraStatus();
        if (!us.ultra || us.licensed) return 'na';
        return us.exhausted ? '0:x' : String(us.remainingSec);
      } catch { return 'na'; }
    })();
    res.writeHead(frame ? 200 : 503, { 'content-type': 'text/plain' });
    res.end((frame ? 'ok' : 'no-frame') + ' viewers=' + wanted() + ' source=' + (pipeOk ? 'pipe' : 'file')
        + ' age=' + (frameStamp ? ((Date.now() - frameStamp) / 1000).toFixed(1) : -1)
        + ' dropped=' + droppedTotal + ' cap=' + CAP_LEVELS[capLevel] + ' in=' + currentInFps() + ' out=' + currentOutFps() + ' drop10=' + recentDrops(10, healthSid) + ' lag=' + lastLagFrames
        + ' mode=' + sourceState.mode + ' raw=' + (rawStamp ? ((Date.now() - rawStamp) / 1000).toFixed(1) : -1)
        + ' blk=' + st.blocked + ' blkage=' + st.ageMs + ' uq=' + uqField + fgField
        + ' rtc=' + JSON.stringify(rtc.stats()) + ' input=' + JSON.stringify(inForOut));
    return;
  }

  // ---- Tailscale 体检（2026-11-03，A1/A3）------------------------------------
  // 只读查询；页面「设置 → 连接体检」用它显示"卡在哪"和节点是直连还是中继。
  if (url.pathname === '/tailscale-status') {
    (async () => {
      let sum = null;
      try { sum = await tailscaleSummary(); } catch (e) {
        sum = { installed: false, ok: false, error: String((e && e.message) || e), hint: '体检失败：' + String((e && e.message) || e) };
      }
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(sum));
      } catch { }
    })();
    return;
  }
  // 一键拉起 Tailscale 安装包：只认安装目录里固定的 bin\tailscale-setup.exe，不接受任何参数。
  // 安装程序会自己请求管理员授权（用户点「是」），服务进程本身不提权。
  if (url.pathname === '/tailscale-install' && req.method === 'POST') {
    const reply = (code, obj) => {
      try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { }
    };
    if (resolveTailscaleExe()) return reply(200, { ok: true, already: true, message: '已经装了 Tailscale，不用重复安装。登录后点「重新检测」。' });
    const setup = join(HERE, 'bin', 'tailscale-setup.exe');
    if (!fileExists(setup)) return reply(200, { ok: false, message: '这个安装包里没带 Tailscale 安装程序，请到 tailscale.com/download 下载。' });
    try {
      const p = spawn('cmd.exe', ['/c', 'start', '', '"' + setup + '"'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.unref();
    } catch (e) {
      return reply(200, { ok: false, message: '没能打开安装程序：' + String((e && e.message) || e) });
    }
    console.log('screen-server: 已拉起 Tailscale 安装程序');
    return reply(200, { ok: true, message: '已打开 Tailscale 安装程序（可能会弹管理员授权，点「是」）。装完登录，再点「重新检测」。' });
  }

  // ---- 文本剪贴板（2026-11-03，A5）--------------------------------------------
  // GET  /clipboard -> { ok, text }        读电脑剪贴板
  // POST /clipboard { text } -> { ok }     写电脑剪贴板（≤64KB，文本落临时文件后由 PowerShell 读）
  if (url.pathname === '/clipboard') {
    const creply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    if (req.method === 'GET') {
      (async () => {
        const r = await readSystemClipboard();
        if (!r.ok) return creply(500, { ok: false, message: '读取剪贴板失败：' + r.error });
        // 只发前 64KB（极端情况下有人在剪贴板里放了一本小说）
        let text = r.text || '';
        if (Buffer.byteLength(text, 'utf8') > CLIP_MAX_BYTES) text = text.slice(0, CLIP_MAX_BYTES);
        creply(200, { ok: true, text: text, length: text.length });
      })();
      return;
    }
    if (req.method === 'POST') {
      let cbody = '';
      req.on('data', (c) => { cbody += c; if (cbody.length > 512 * 1024) req.destroy(); });
      req.on('end', () => {
        let text = '';
        try { text = String((JSON.parse(cbody || '{}') || {}).text || ''); } catch { }
        if (Buffer.byteLength(text, 'utf8') > CLIP_MAX_BYTES) {
          return creply(400, { ok: false, message: '文本太长（上限 64KB）' });
        }
        (async () => {
          const r = await writeSystemClipboard(text);
          if (!r.ok) return creply(500, { ok: false, message: '写入剪贴板失败：' + r.error });
          creply(200, { ok: true, message: '已写入电脑剪贴板（长度 ' + text.length + '）', length: text.length });
        })();
      });
      return;
    }
    return creply(405, { ok: false, message: 'method not allowed' });
  }

  // ---- 小文件传输（2026-11-03，A5 第二步）--------------------------------------
  // GET  /files             -> { ok, files:[{name,size,at}] }（最近 50 个）
  // POST /file?name=<文件名> -> 原始字节流，≤32MB，存到 Downloads\PhoneAccess\
  // GET  /file?name=<文件名> -> 下载（只用相对文件名，不接受路径）
  if (url.pathname === '/files' && req.method === 'GET') {
    const freply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    return freply(200, { ok: true, dir: UPLOAD_DIR, maxBytes: UPLOAD_MAX, files: listUploads() });
  }
  if (url.pathname === '/file' && req.method === 'POST') {
    const freply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    const name = safeUploadName(url.searchParams.get('name'));
    if (!name) return freply(400, { ok: false, message: '文件名不合法（不支持路径，只传文件名）' });
    try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {
      return freply(500, { ok: false, message: '建下载目录失败：' + ((e && e.message) || e) });
    }
    const dest = uniqueUploadPath(name);
    const chunks = [];
    let got = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      got += c.length;
      if (got > UPLOAD_MAX) {
        aborted = true;
        return freply(413, { ok: false, message: '文件太大（上限 32MB）' });
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      if (!got) return freply(400, { ok: false, message: '空文件' });
      try {
        writeFileSync(dest, Buffer.concat(chunks));
      } catch (e) {
        return freply(500, { ok: false, message: '保存失败：' + ((e && e.message) || e) });
      }
      const saved = dest.slice(dest.lastIndexOf('\\') + 1);
      console.log('screen-server: 收到文件 ' + saved + '（' + got + ' B）');
      freply(200, { ok: true, name: saved, size: got, message: '已收到：' + saved + '（已存到电脑的「下载」文件夹）' });
    });
    return;
  }
  if (url.pathname === '/file' && req.method === 'GET') {
    const name = safeUploadName(url.searchParams.get('name'));
    const target = name ? join(UPLOAD_DIR, name) : '';
    let st = null;
    try { st = statSync(target); } catch { }
    if (!name || !st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('文件不存在');
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(st.size),
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'cache-control': 'no-store'
      });
      createReadStream(target).pipe(res);
    } catch (e) {
      try { res.end(); } catch { }
    }
    return;
  }

  // ---- 高性能模式（Sunshine/Moonlight）--------------------------------------
  // GET  /sunshine-status    -> 安装/服务/凭据/授权/配置摘要
  // GET  /sunshine-pairings  -> 等待 PIN 的 Moonlight 设备（需要许可证或试用中）
  // POST /sunshine-pin       -> { pairing_id, pin, name } 提交 PIN（需要许可证或试用中）
  if (url.pathname === '/sunshine-status') {
    (async () => {
      const installed = fileExists(SUNSHINE_EXE);
      const webUp = installed ? await sunshineWebUp() : false;
      const creds = !!readSunshineCreds();
      let cfg = null;
      if (webUp && creds) {
        const r = await sunshineApi('GET', '/api/config');
        if (r.ok) {
          try {
            const j = JSON.parse(r.body);
            cfg = {
              name: String(j.sunshine_name || ''),
              version: String(j.version || ''),
              port: String(j.port || ''),
              bind: String(j.bind_address || '')
            };
          } catch { }
        }
      }
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          installed: installed,
          webUp: webUp,
          credentialsSet: creds,
          licensed: isFullFunction(),
          component: {
            configured: (Array.isArray(sunshineComp.urls) && sunshineComp.urls.length > 0 && !!sunshineComp.sha256),
            job: sunshineJob
          },
          sunshine: cfg
        }));
      } catch { }
    })();
    return;
  }
  if (url.pathname === '/sunshine-pairings') {
    const sreply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    if (!isFullFunction()) {
      return sreply(200, { ok: false, error: '高性能模式需要许可证或处于试用期内。可以先继续用网页模式。' });
    }
    if (!readSunshineCreds()) {
      return sreply(200, { ok: false, error: '高性能模式还没初始化（缺凭据文件）。重启一次「手机远程」或重新运行安装包。' });
    }
    (async () => {
      const r = await sunshineApi('GET', '/api/pin');
      if (!r.ok) return sreply(200, { ok: false, error: '连不上 Sunshine（HTTP ' + (r.httpStatus || 0) + '）' });
      let j = null;
      try { j = JSON.parse(r.body); } catch { }
      const list = (j && Array.isArray(j.pairings)) ? j.pairings : [];
      const pairings = list.slice(0, 8).map((p) => ({
        id: String((p && p.id) || ''),
        name: String((p && p.name) || ''),
        address: String((p && p.address) || '')
      })).filter((p) => p.id);
      sreply(200, { ok: true, pairings: pairings });
    })();
    return;
  }
  if (url.pathname === '/sunshine-pin' && req.method === 'POST') {
    const sreply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    if (!isFullFunction()) {
      return sreply(200, { ok: false, error: '高性能模式需要许可证或处于试用期内。' });
    }
    let pbody = '';
    req.on('data', (c) => { pbody += c; if (pbody.length > 8192) req.destroy(); });
    req.on('end', () => {
      let pairingId = '';
      let pin = '';
      let name = '';
      try {
        const m = JSON.parse(pbody || '{}') || {};
        pairingId = String(m.pairing_id || '').trim().toLowerCase();
        pin = String(m.pin || '').trim();
        name = String(m.name || '').trim().slice(0, 40);
      } catch { }
      if (!/^[0-9a-f]{32}$/.test(pairingId)) return sreply(400, { ok: false, message: '配对请求 id 不对（应由页面自动带过来）' });
      if (!/^\d{4}$/.test(pin)) return sreply(400, { ok: false, message: 'PIN 是 Moonlight 上显示的 4 位数字' });
      (async () => {
        const tryPin = async (pid) => {
          const r = await sunshineApi('POST', '/api/pin', {
            pairing_id: pid,
            pin: pin,
            name: name || '手机'
          }, 20000);
          let j = null;
          try { j = JSON.parse(r.body || ''); } catch { }
          const good = !!(r.ok && j && (j.status === true || j.status === 'true'));
          return { r, j, good };
        };
        let out = await tryPin(pairingId);
        // 兜底：Moonlight 重新发起配对时 pairing_id 会变，页面带的是旧的 → 自动用最新的重试一次。
        // （PIN 是客户端自己生成并校验的，换 id 重试不会把不相干的设备配进来。）
        if (!out.good) {
          const refresh = await sunshineApi('GET', '/api/pin', null, 8000);
          let list = [];
          try {
            const lj = JSON.parse(refresh.body || '{}');
            list = Array.isArray(lj && lj.pairings) ? lj.pairings : [];
          } catch { }
          const newest = list.length ? String(list[list.length - 1].id || '').toLowerCase() : '';
          if (newest && newest !== pairingId) out = await tryPin(newest);
        }
        const { r, j, good } = out;
        if (!r.ok) return sreply(200, { ok: false, message: 'Sunshine 拒绝了配对（HTTP ' + (r.httpStatus || 0) + '）' });
        sreply(200, {
          ok: good,
          status: j ? j.status : null,
          message: good ? '配对成功：回 Moonlight 里选「Desktop」就能开始串流。' : 'PIN 不对或配对超时：在 Moonlight 里重新点一次配对，拿到新的 4 位 PIN 后立刻回来输。'
        });
      })();
    });
    return;
  }
  // POST /sunshine-unpair —— 清空已配对设备（Sunshine 的 unpair-all）。
  // 为什么要它：真机实测反复配对会堆出多条同名记录，之后重连报证书身份错误，
  // 客户在页面上点一下"清空配对"就能重新配对，不用重装。
  if (url.pathname === '/sunshine-unpair' && req.method === 'POST') {
    const sreply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch { }
    };
    if (!isFullFunction()) return sreply(200, { ok: false, message: '高性能模式需要许可证或处于试用期内。' });
    if (!readSunshineCreds()) return sreply(200, { ok: false, message: '高性能模式还没初始化（缺凭据文件）。' });
    (async () => {
      const r = await sunshineApi('POST', '/api/clients/unpair-all', null, 15000);
      if (!r.ok) return sreply(200, { ok: false, message: 'Sunshine 没同意清空配对（HTTP ' + (r.httpStatus || 0) + '）' });
      sreply(200, { ok: true, message: '已清空配对：在 Moonlight 里删除电脑再加一次，重新输入 PIN。' });
    })();
    return;
  }

  // ---- 画质档位（改"发送宽度"，立即生效，不再需要重启）-------------------------
  // 2026-10-30 画质修复：抓屏永远按显示器原生宽度（见顶部 CAPTURE_W 的注释），
  // 画质档位只改服务端 sharp 降采样的目标宽度。CAP_W 是活变量，/stream 每帧按它重算，
  // 所以这里写配置 + 改 CAP_W 就生效了 —— 以前要整机重启，用户实测"点哪个都一样糊"。
  // 安全性：只接受 800..3840 的整数，写进我们自己配置里的一个数字，不接受任意内容。
  if (url.pathname === '/set-quality' && req.method === 'POST') {
    let qbody = '';
    req.on('data', (c) => { qbody += c; if (qbody.length > 4096) req.destroy(); });
    req.on('end', () => {
      const qreply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      let w = 0;
      try { w = Math.round(Number((JSON.parse(qbody || '{}') || {}).captureWidth)); } catch { }
      if (!Number.isFinite(w) || w < 800 || w > 3840) {
        return qreply(400, { ok: false, message: '宽度必须在 800 到 3840 之间' });
      }
      const qcfgPath = join(HERE, 'product.config.json');
      let qcfg = null;
      try { qcfg = JSON.parse(readFileSync(qcfgPath, 'utf8').replace(/^\uFEFF/, '')); } catch { }
      if (!qcfg) return qreply(500, { ok: false, message: '读不到配置文件，无法修改' });
      if (!qcfg.screen) qcfg.screen = {};
      qcfg.screen.maxCaptureWidth = w;
      try {
        writeFileSync(qcfgPath, JSON.stringify(qcfg, null, 2), 'utf8');
      } catch (e) {
        return qreply(500, { ok: false, message: '写配置文件失败：' + e.message });
      }
      const prevW = CAP_W;
      const applied = setDeliveryWidth(w);
      console.log('screen-server: delivery width ' + prevW + ' -> ' + applied
        + '（抓屏仍按原生 ' + CAPTURE_W + '，立即生效）');
      // 半免费：未授权机器设到超清档时，把"每天免费额度/今天还剩多少"讲清楚。
      // 不拦截——配额用完后发帧处自动按高清出图（见 deliverCapW），设置本身永远允许。
      let quotaNote = '';
      let quota = null;
      try {
        quota = ultraStatus();
        if (applied > ULTRA_LIMIT && !quota.licensed) {
          quotaNote = quota.exhausted
            ? '（提醒：今天的超清免费时长已用完，现在会先按高清出图，明天 0 点自动恢复；安装许可证不限时长）'
            : '（未授权机器超清每天免费 ' + Math.round(quota.limitSec / 60) + ' 分钟，今天还剩约 ' + Math.round(quota.remainingSec / 60) + ' 分钟）';
        }
      } catch { }
      // 立即生效：不需要重启。抓屏宽度本来就是原生的，画质档位只是服务端的发送宽度。
      qreply(200, {
        ok: true,
        captureWidth: applied,
        requested: w,
        previous: prevW,
        captureNative: CAPTURE_W,
        restarting: false,
        needFullRestart: false,
        ultraQuota: quota,
        message: '已生效：发送宽度 ' + applied
          + (applied < CAPTURE_W ? '（抓屏仍按原分辨率 ' + CAPTURE_W + '，所以字更清楚、帧率不掉）' : '（原分辨率，最清晰）')
          + '，不用重启。' + quotaNote
      });
    });
    return;
  }


  // ---- 更新下载进度（页面每 1 秒轮询一次，用来显示"已下载 x/50MB"和卡住提示）----
  if (url.pathname === '/update-progress') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(updatePublicState()));
    return;
  }

  // ---- 检查更新（客户主动点才会执行）------------------------------------------
  // 设计原则（和"不给卖家留远程入口"一致）：**只有客户点这个按钮，本机才去联网**。
  // 产品平时不做任何出站请求、不后台轮询、不回连。
  // 更新源地址来自 product.config.json（服务端配置），**不接受客户端传 url**，
  // 所以这里不存在被拿来当 SSRF 跳板的问题。
  if (url.pathname === '/update-check') {
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    let cfgNow = {};
    try { cfgNow = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { }
    const current = String((cfgNow && cfgNow.version) || '');
    const upd = (cfgNow && cfgNow.update) || {};
    const src = String(upd.url || '').trim();
    // 国内镜像（2026-10-30）：GitHub 直连不稳时，卖家在 update.mirror 填一个能直连的 exe 地址
    // （例如国内 OSS/COS 直链）。只认 https + .exe；页面把它当首选、GitHub 当备选。
    const mirror = String(upd.mirror || '').trim();
    let mirrorOk = /^https:\/\/\S+\.exe(\?\S*)?$/i.test(mirror);
    // 手动下载页（2026-10-31）：蓝奏云/网盘这类没有稳定直链的，只能给一个"页面"，让客户自己点下载
    const mirrorPageRaw = String(upd.mirrorPage || '').trim();
    const mirrorPage = /^https:\/\/\S+/i.test(mirrorPageRaw) ? mirrorPageRaw : '';
    // 手动下载页的说明（蓝奏云密码等）：纯文本、限长，页面按文本渲染
    const mirrorPageNote = mirrorPage ? String(upd.mirrorPageNote || '').slice(0, 60) : '';
    // GitHub Releases（2026-10-30）：老客户点「检查更新」直接从这个 release 拿新版。
    // 配置写法 update.github = { "owner": "...", "repo": "..." }，公开仓库不需要 token。
    // 只做一次 GET，不轮询、不后台检查——和"产品平时不联网"的既有承诺一致。
    const gh = (upd.github && upd.github.owner && upd.github.repo)
      ? (String(upd.github.owner).replace(/[^A-Za-z0-9_.-]/g, '') + '/' + String(upd.github.repo).replace(/[^A-Za-z0-9_.-]/g, ''))
      : '';
    // 国内主源（2026-11-02 用户要求）：**默认走 Gitee，GitHub 只做备选**。
    // 客户大多在国内，直连 GitHub 实测有时只有 ~25KB/s 甚至打不开。
    //
    // 为什么不直接用 Gitee 的 /releases/latest：那个接口返回"最近创建的发行版"，
    // 我们补传旧版归档（v1.0.12）之后它就指向旧版了；所以改成拉发行版列表，
    // 在 tag 形如 vX.Y.Z 的里面挑版本号最大的一个（排除 tailscale-android-* 之类的镜像 tag）。
    const gt = (upd.gitee && upd.gitee.owner && upd.gitee.repo)
      ? {
        owner: String(upd.gitee.owner).replace(/[^A-Za-z0-9_.-]/g, ''),
        repo: String(upd.gitee.repo).replace(/[^A-Za-z0-9_.-]/g, '')
      }
      : null;
    const giteePage = gt ? ('https://gitee.com/' + gt.owner + '/' + gt.repo + '/releases') : '';
    const githubPage = gh ? ('https://github.com/' + gh + '/releases/latest') : '';
    if (!src && !gh && !gt) {
      // 没配更新源也不装作能更新：老实说清楚当前版本，让客户联系卖家
      reply(200, { configured: false, current: current, hasUpdate: false });
      return;
    }
    if (src && !/^https?:\/\//i.test(src)) {
      reply(200, { configured: false, current: current, hasUpdate: false, error: '更新地址格式不对（要 http/https）' });
      return;
    }
    const timeoutMs = Math.max(2000, Math.min(20000, Number(upd.timeoutMs) || 8000));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // 版本比较：按数字段逐段比，非数字按字符串兜底（够用，不引第三方库）
    const cmp = (a, b) => {
      const pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || '0', y = pb[i] || '0';
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
        else { if (x !== y) return x < y ? -1 : 1; }
      }
      return 0;
    };
    // 从一组发行版附件里挑"安装包"：优先看起来像 setup/install 的 exe，其次任意 exe
    const pickExeAsset = (assets) => {
      const list = Array.isArray(assets) ? assets : [];
      return list.find((a) => /\.exe$/i.test(String((a && a.name) || '')) && /setup|install|安装|手机远程/i.test(String((a && a.name) || '')))
        || list.find((a) => /\.exe$/i.test(String((a && a.name) || '')))
        || null;
    };
    (async () => {
      try {
        let j = null;
        let srcTag = '';
        let giteeErr = '';
        if (gt) {
          // Gitee 发行版列表：一次 GET（最多 100 条），挑产品版本里最高的那个
          try {
            const gApi = 'https://gitee.com/api/v5/repos/' + gt.owner + '/' + gt.repo + '/releases?per_page=100';
            const gr = await fetch(gApi, {
              signal: ac.signal,
              headers: { 'user-agent': 'PhoneAccess-UpdateCheck', 'cache-control': 'no-cache' }
            });
            if (!gr.ok) throw new Error('返回 ' + gr.status);
            const gList = await gr.json();
            let best = null;
            (Array.isArray(gList) ? gList : []).forEach((rel) => {
              const v = String((rel && rel.tag_name) || '').replace(/^v/i, '').trim();
              if (!/^\d+\.\d+(\.\d+)?$/.test(v)) return;          // 排除 tailscale-android-* 之类的非产品 tag
              if (!best || cmp(v, best.version) > 0) best = { version: v, rel: rel };
            });
            if (!best) throw new Error('没有产品发行版');
            const gExe = pickExeAsset(best.rel && best.rel.assets);
            if (!gExe) throw new Error('最新发行版里没有安装包');
            const gBody = String((best.rel && best.rel.body) || '');
            // 发版约定：发行版正文里写 SHA256：xxxx；有它就能在下载后校验（Gitee API 不给 asset digest）
            const gSha = (gBody.match(/SHA256[^\r\n]{0,12}?([0-9a-fA-F]{64})/i) || [])[1] || '';
            j = {
              version: best.version,
              notes: gBody.length > 900 ? (gBody.slice(0, 900) + '…') : gBody,
              url: String((gExe && gExe.browser_download_url) || ''),
              sha256: gSha.toLowerCase(),
              page: 'https://gitee.com/' + gt.owner + '/' + gt.repo + '/releases/tag/v' + best.version
            };
            srcTag = 'gitee';
          } catch (e) {
            giteeErr = 'Gitee：' + ((e && e.message) || '检查失败');
          }
        }
        if (!j && gh) {
          // GitHub 的 tag 通常带 v 前缀（v1.0.6），配置里的 version 不带（1.0.6），比较前先剥掉
          const api = 'https://api.github.com/repos/' + gh + '/releases/latest';
          const r = await fetch(api, {
            signal: ac.signal,
            headers: {
              'accept': 'application/vnd.github+json',
              'user-agent': 'PhoneAccess-UpdateCheck',
              'cache-control': 'no-cache'
            }
          });
          if (!r.ok) { reply(200, { configured: true, current: current, hasUpdate: false, error: 'GitHub 返回 ' + r.status }); return; }
          const rel = await r.json();
          const assets = Array.isArray(rel && rel.assets) ? rel.assets : [];
          // 优先挑"看起来是安装包"的 exe；没有就退回 release 页面
          const exe = assets.find((a) => /\.exe$/i.test(String((a && a.name) || '')) && /setup|install|安装|手机远程/i.test(String((a && a.name) || '')))
            || assets.find((a) => /\.exe$/i.test(String((a && a.name) || '')));
          const body = String((rel && rel.body) || '');
          j = {
            version: String((rel && rel.tag_name) || '').replace(/^v/i, ''),
            notes: body.length > 900 ? (body.slice(0, 900) + '…') : body,
            url: String((exe && exe.browser_download_url) || ''),
            // GitHub 现在会给 asset 带 sha256 digest；有它就能在下载后校验，防止镜像给错版本
            sha256: String((exe && exe.digest) || '').replace(/^sha256:/i, '').toLowerCase(),
            page: String((rel && rel.html_url) || '')
          };
        } else if (!j && src) {
          const r = await fetch(src, { signal: ac.signal, headers: { 'cache-control': 'no-cache' } });
          if (!r.ok) { reply(200, { configured: true, current: current, hasUpdate: false, error: '更新服务返回 ' + r.status }); return; }
          j = await r.json();
          srcTag = 'url';
        }
        if (!j) {
          // 一个源都没拿到版本：把原因说清楚（Gitee 的错因放在最前面，客户大多在国内）
          reply(200, {
            configured: true,
            current: current,
            hasUpdate: false,
            error: (giteeErr ? (giteeErr + '；') : '') + '检查更新失败：更新源没有返回版本信息',
            mirrorPage: mirrorPage,
            mirrorPageNote: mirrorPageNote,
            giteePage: giteePage,
            githubPage: githubPage
          });
          return;
        }
        const latest = String((j && j.version) || '');
        const hasUpdate = !!(latest && current && cmp(latest, current) > 0);
        // 镜像里如果写死了版本号，必须和 latest 一致；否则会「提示新版本、却下到旧包」
        const mirrorVer = (mirror.match(/v?(\d+\.\d+\.\d+)/i) || [])[1] || '';
        const mirrorStale = !!(mirrorVer && latest && mirrorVer !== latest);
        if (mirrorStale) mirrorOk = false;

        // 下载源优先级（2026-11-02 用户要求：国内默认 Gitee，GitHub 只做备选）：
        //   ① Gitee 发行版里「最新版本」的 exe 直链。
        //      注意不能用本地配置里的 update.mirror：那是**打包时**的版本，老客户机器上永远指向老版本，
        //      一有新版本就被下面的 stale 判定丢掉，结果所有人都被迫走 GitHub（国内基本下不动）。
        //   ② 配置里的国内镜像 update.mirror（版本号与本机配置一致时才用；老客户/旧配置兜底）
        //   ③ GitHub asset
        const jUrl = String((j && j.url) || '');
        let downloadUrl = jUrl;
        let fallbackUrl = '';
        let sourceTag = srcTag || (jUrl ? 'github' : '');
        if (srcTag === 'gitee' && jUrl) {
          downloadUrl = jUrl;
          // GitHub 只做备选：按 release 约定拼资产直链（不额外请求 GitHub API，国内那个接口又慢又常被墙）
          fallbackUrl = (gh && latest)
            ? ('https://github.com/' + gh + '/releases/download/v' + latest + '/PhoneAccess-Setup-v' + latest + '.exe')
            : '';
        } else if (mirrorOk) {
          downloadUrl = mirror;
          sourceTag = 'mirror';
          fallbackUrl = jUrl;
        } else if (jUrl) {
          downloadUrl = jUrl;
          sourceTag = 'github';
          fallbackUrl = mirrorOk ? mirror : '';
        }
        const downloadLabel = (sourceTag === 'gitee') ? '国内下载（Gitee）'
          : (sourceTag === 'mirror' ? '国内镜像下载' : '下载并安装');
        const fallbackLabel = (sourceTag === 'gitee' || sourceTag === 'github') ? '改用 GitHub 下载'
          : (mirrorOk ? '改用国内镜像下载' : '改用 GitHub 下载');
        // 下载后校验用：Gitee 的 SHA256 来自发行版正文的发版约定；拿不到就空着（不瞎填配置里的 hash，
        // 那是**当前版本**的 hash，拿它校验新版本必然失败）
        let sha256 = String((j && j.sha256) || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) sha256 = '';
        reply(200, {
          configured: true,
          current: current,
          latest: latest,
          hasUpdate: hasUpdate,
          notes: String((j && j.notes) || ''),
          downloadUrl: downloadUrl,
          downloadLabel: downloadLabel,
          fallbackUrl: fallbackUrl,
          fallbackLabel: fallbackLabel,
          // source: gitee=国内主源；mirror=配置里的国内镜像；github=只有 GitHub 能用；url=自定义 JSON 源
          source: sourceTag,
          mirror: mirrorOk ? mirror : '',
          mirrorPage: mirrorPage,
          mirrorPageNote: mirrorPageNote,
          sha256: sha256,
          pageUrl: String((j && j.page) || giteePage || githubPage),
          giteePage: giteePage,
          githubPage: githubPage,
          error: ''
        });
      } catch (e) {
        const msg = (e && e.name === 'AbortError') ? '检查超时' : ('检查失败：' + ((e && e.message) || '未知错误'));
        reply(200, { configured: true, current: current, hasUpdate: false, error: msg });
      } finally {
        clearTimeout(timer);
      }
    })();
    return;
  }

  // ---- 下载并启动新版安装包（客户在「检查更新」里点「下载并安装」才会执行）------
  // 安全边界：只接受 GitHub 的下载域名 / 配置里的国内镜像域名 + https + .exe。
  // 页面不能指定任意 URL，否则这个接口就成了本机上的通用下载器 / SSRF 跳板。
  // 2026-10-30：改成流式下载 + 看门狗 + 进度。原来只是一次 arrayBuffer() 等 10 分钟，
  // 国内不翻墙时连 GitHub 会一直挂着，页面永远"下载中…"，电脑端也不报错。
  if (url.pathname === '/update-install' && req.method === 'POST') {
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let reqObj = {};
      try { reqObj = JSON.parse(body || '{}') || {}; } catch { }
      let target = String(reqObj.url || '').trim();
      // 页面在 /update-check 时拿到 GitHub asset 的 sha256；下载完必须校验，防止镜像给旧包
      let expectedSha = String(reqObj.sha256 || '').trim().replace(/^sha256:/i, '').toLowerCase();
      if (!/^https:\/\//i.test(target)) return reply(400, { ok: false, message: '下载地址必须是 https' });
      if (!/\.exe(\?|$)/i.test(target)) return reply(400, { ok: false, message: '下载地址不是 exe 安装包' });
      // 允许的域名 = GitHub 下载域名 + 配置里的国内镜像域名（只由卖家在配置里指定）
      let mirror = '';
      try {
        const mcfg = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, ''));
        mirror = String((mcfg.update && mcfg.update.mirror) || '').trim();
        if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
          expectedSha = String((mcfg.update && mcfg.update.sha256) || '').trim().replace(/^sha256:/i, '').toLowerCase();
        }
      } catch { }
      // 允许的域名 = GitHub 下载域名 + Gitee（国内主源）+ 配置里的国内镜像域名（只由卖家在配置里指定）
      const allowedHosts = ['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'release-assets.githubusercontent.com', 'gitee.com', 'gitee.io'];
      try {
        if (/^https:\/\//i.test(mirror)) {
          const mh = new URL(mirror).hostname.toLowerCase();
          if (mh) allowedHosts.push(mh);
        }
      } catch { }
      let host = '';
      try { host = new URL(target).hostname.toLowerCase(); } catch { }
      if (!allowedHosts.includes(host)) return reply(400, { ok: false, message: '下载地址不在允许的域名内：' + host });

      const tmpDir = process.env.TEMP || process.env.TMP || '.';
      const fileName = 'PhoneAccess-Update-' + Date.now() + '.exe';
      const dest = join(tmpDir, fileName);
      const part = dest + '.part';
      console.log('screen-server: 开始下载新版 -> ' + dest + ' (' + target + ')');

      updateState = { at: Date.now(), phase: 'connecting', bytes: 0, total: 0, startedAt: Date.now(), lastByteAt: Date.now(), error: '', url: target };
      const ac = new AbortController();
      let aborted = false;
      const abortWith = (reason) => {
        if (aborted) return;
        aborted = true;
        updateState.phase = 'error';
        updateState.error = reason;
        updateState.at = Date.now();
        try { ac.abort(); } catch { }
      };
      // 看门狗：连接 20 秒无响应 / 下载中 20 秒没新数据 / 总时长 8 分钟 → 立即判失败
      const watchdog = setInterval(() => {
        const idle = Date.now() - updateState.lastByteAt;
        if (updateState.phase === 'connecting' && Date.now() - updateState.startedAt > 20000) {
          abortWith('连接下载服务器超时（20 秒没响应）。国内直连 GitHub 经常这样：请开代理重试，或让卖家发国内网盘链接。');
        } else if (updateState.phase === 'downloading' && idle > 20000) {
          abortWith('下载卡住了（20 秒没新数据）。网络不稳或被中断：可以重试，或让卖家发国内网盘链接。');
        } else if (updateState.phase === 'downloading' && updateState.total > 0 && Date.now() - updateState.startedAt > 45000) {
          // 慢速看门狗（2026-10-30 实测）：国内直连 GitHub 的 asset CDN 实测只有 ~25 KB/s，
          // 52MB 要下 35 分钟——不拦的话用户会以为"点了没反应"。低于 60KB/s 且预计还要 >10 分钟就直接判失败。
          const secs = (Date.now() - updateState.startedAt) / 1000;
          const speed = updateState.bytes / Math.max(1, secs);                 // B/s
          const remainSec = speed > 0 ? (updateState.total - updateState.bytes) / speed : Infinity;
          if (speed < 60 * 1024 && remainSec > 600) {
            abortWith('下载太慢：平均只有 ' + Math.max(1, Math.round(speed / 1024)) + ' KB/s，按这个速度还要约 '
              + Math.round(remainSec / 60) + ' 分钟，已停止。国内直连 GitHub 常见这种情况：请开代理重试，或让卖家发国内网盘链接。');
          }
        } else if (Date.now() - updateState.startedAt > 8 * 60 * 1000) {
          abortWith('下载超时（超过 8 分钟）。');
        }
      }, 1000);
      (async () => {
        try {
          const r = await fetch(target, {
            signal: ac.signal,
            headers: { 'user-agent': 'PhoneAccess-UpdateCheck', 'cache-control': 'no-cache' }
          });
          if (!r.ok) throw new Error('下载失败：HTTP ' + r.status);
          const total = Number(r.headers.get('content-length') || 0);
          if (total > 400 * 1024 * 1024) throw new Error('安装包超过 400MB，已拒绝');
          updateState.phase = 'downloading';
          updateState.total = total;
          updateState.at = Date.now();
          const reader = (r.body && typeof r.body.getReader === 'function') ? r.body.getReader() : null;
          const parts = [];
          let got = 0;
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (aborted) throw new Error(updateState.error || '已中止');
              const chunk = Buffer.from(value);
              got += chunk.length;
              if (got > 400 * 1024 * 1024) throw new Error('安装包超过 400MB，已拒绝');
              parts.push(chunk);
              updateState.bytes = got;
              updateState.lastByteAt = Date.now();
            }
          } else {
            const buf = Buffer.from(await r.arrayBuffer());
            got = buf.length; parts.push(buf);
            updateState.bytes = got; updateState.lastByteAt = Date.now();
          }
          if (aborted) throw new Error(updateState.error || '已中止');
          const buf = Buffer.concat(parts);
          if (!buf.length) throw new Error('下载到的文件是空的');
          if (/^[0-9a-f]{64}$/.test(expectedSha)) {
            const actualSha = createHash('sha256').update(buf).digest('hex');
            if (actualSha !== expectedSha) {
              throw new Error('安装包校验失败：SHA256 不一致（可能下到了旧版本或文件损坏），已停止，没有运行安装程序。');
            }
          }
          writeFileSync(part, buf);
          try { renameSync(part, dest); } catch { writeFileSync(dest, buf); try { unlinkSync(part); } catch { } }
          updateState.phase = 'done';
          updateState.at = Date.now();
          console.log('screen-server: 下载完成 ' + Math.round(buf.length / 1024 / 1024) + 'MB，准备启动安装程序');
          // detached：页面请求结束时安装包继续跑，不用等它结束
          const p = spawn('cmd.exe', ['/c', 'start', '', dest], { detached: true, stdio: 'ignore', windowsHide: true });
          p.unref();
          reply(200, { ok: true, path: dest, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), message: '已下载完（' + Math.round(buf.length / 1024 / 1024) + ' MB），正在打开安装程序。如果弹出管理员授权请点「是」。' });
        } catch (e) {
          // 网络层错误（DNS/TCP 被挡、连接被重置）对客户来说就是"连不上 GitHub"，
          // 不要直接把 undici 的 "fetch failed" 抛给用户，要给出下一步怎么办。
          const rawMsg = String((e && e.message) || '');
          const netErr = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|other side closed/i.test(rawMsg);
          const reason = aborted
            ? (updateState.error || '下载已中止')
            : ((e && e.name === 'AbortError')
              ? '下载已中止'
              : (netErr
                ? '连不上下载服务器（网络到 GitHub 不通）。请开代理重试，或让卖家发国内网盘链接。'
                : ('下载失败：' + (rawMsg || '未知错误'))));
          if (!aborted) { updateState.phase = 'error'; updateState.error = reason; updateState.at = Date.now(); }
          try { unlinkSync(part); } catch { }
          reply(200, { ok: false, message: reason });
        } finally {
          clearInterval(watchdog);
        }
      })();
    });
    return;
  }

  // 注入被前台的高权限窗口挡住时用：让 injector 抢回前台，再不行就让 PowerShell 侧再抢一次
  if (url.pathname === '/unblock') {
    input.unblock();
    shellUnblock();                        // 页面点了按钮：PowerShell 侧也补一枪
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...input.status() }));
    return;
  }

  // 「桌面」按钮：不管前面对着多少窗口，一次性全部最小化、露出桌面。
  // 用 Shell 的 MinimizeAll（就是任务栏那个"显示桌面"），而不是 Win+D：
  // 全屏远程桌面 / 全屏游戏会把 Win 组合键截走，Win+D 会送进被控的那台机器里；
  // MinimizeAll 是直接操作本机窗口，键盘被谁抓走都不影响。实测 67ms。
  if (url.pathname === '/showdesktop' && req.method === 'POST') {
    const before = String(input.status().foreground || '');
    const answer = (payload) => {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {}
    };
    if (sourceState.window) {
      // 抓的是单个窗口时，最小化等于把抓屏内容一起收走，画面会直接变黑
      answer({ ok: false, before, err: '当前抓的是单个窗口，最小化会让画面变黑；先切回「全部屏幕」' });
      return;
    }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '(New-Object -ComObject Shell.Application).MinimizeAll()'],
      { timeout: 12000, windowsHide: true },
      (err) => {
        if (!err) { answer({ ok: true, via: 'minimizeall', before }); return; }
        // Shell 调用失败（极少见）再退回 Win+D
        console.log('showdesktop: MinimizeAll failed: ' + (err.message || err) + ', fallback to Win+D');
        if (!input.stats().connected) { answer({ ok: false, before, err: String(err.message || err) }); return; }
        input.send({ t: 'key', vk: 0x5B, down: 1 });
        setTimeout(() => input.send({ t: 'key', vk: 0x44, down: 1 }), 35);
        setTimeout(() => input.send({ t: 'key', vk: 0x44, down: 0 }), 80);
        setTimeout(() => input.send({ t: 'key', vk: 0x5B, down: 0 }), 130);
        setTimeout(() => answer({ ok: true, via: 'win+d', before }), 500);
      });
    return;
  }

  // ---- 可选组件：高性能模式（Sunshine MSI）下载与安装 -------------------------
  if (url.pathname === '/sunshine-component') {
    const urls = Array.isArray(sunshineComp.urls) ? sunshineComp.urls.filter(Boolean) : [];
    const configured = urls.length > 0 && !!sunshineComp.sha256;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        installed: fileExists(SUNSHINE_EXE),
        configured: configured,
        name: String(sunshineComp.name || '高性能模式组件（Moonlight）'),
        sizeBytes: Number(sunshineComp.sizeBytes) || 0,
        sha256: String(sunshineComp.sha256 || ''),
        notice: String(sunshineComp.notice || ''),
        job: sunshineJob
      }));
      return;
    }
    if (req.method === 'POST') {
      const sreply = (code, obj) => {
        try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { }
      };
      if (!isFullFunction()) return sreply(200, { ok: false, message: '高性能模式需要许可证或试用中。' });
      if (!configured) return sreply(200, { ok: false, message: '组件下载地址还没配置（product.config.json → components.sunshine.urls）。' });
      if (sunshineJob.phase === 'downloading') return sreply(200, { ok: true, job: sunshineJob });
      sunshineJob = { phase: 'downloading', received: 0, total: Number(sunshineComp.sizeBytes) || 0, error: '', startedAt: Date.now() };
      downloadAndInstallSunshine().catch((e) => {
        sunshineJob = { phase: 'error', received: sunshineJob.received || 0, total: sunshineJob.total || 0, error: String(e.message || e), startedAt: Date.now() };
      });
      return sreply(200, { ok: true, job: sunshineJob });
    }
    res.writeHead(405); res.end('method not allowed');
    return;
  }

  if (url.pathname === '/h264-status') {
    // 页面用它决定「清晰模式走 H.264 还是回落 MJPEG」
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      enabled: H264_ENABLED,
      width: H264_W,
      height: H264_H,
      fps: H264_FPS,
      kbps: H264_KBPS,
      viewers: h264.clients.size,
      lastError: h264.lastError
    }));
    return;
  }

  if (url.pathname === '/rtc-on' && req.method === 'POST') {
    rtcMode = true;
    rtcActiveAt = Date.now();   // 给抓屏 60 秒预热，新观众连上就能立刻有画面
    sourceState.mode = 'mjpeg';
    // 宽度不在这里定：publishViewers() 会按有没有人看清晰模式决定，混用时不降清晰度
    writeMode();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rtcMode, ...sourceState }));
    return;
  }

  if (url.pathname === '/rtc-off' && req.method === 'POST') {
    rtcMode = false;
    // 改动（P0-3）：这里原来把宽度写回 2560，会触发一次抓屏管线重启（画面卡 1~2 秒）。
    // 现在写回实际抓屏宽度 CAPTURE_W（与 publishViewers() 一致），非 2560 的机器不会再白抖一下。
    sourceState.width = CAPTURE_W;
    writeMode();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rtcMode, ...sourceState }));
    return;
  }

  // 页面按自己测到的往返延迟调流畅模式的码率：走 DERP 中继（200ms+）时 3Mbps 只会一直丢包，
  // 压到 1Mbps/10fps 反而更顺。
  if (url.pathname === '/rtc-quality' && req.method === 'POST') {
    const q = rtc.setQuality(Number(url.searchParams.get('kbps') || 0), Number(url.searchParams.get('fps') || 0));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...q }));
    return;
  }
      // 手机端「命令」面板：直接在这台电脑上跑一条 PowerShell 并回显结果。
  // VMware 控制台这类拒绝合成输入的窗口没法用触摸操作，但命令可以走这里；
  // 也方便在外面临时查状态、重启服务。访问权限与页面一致（凭 key，且只监听私有网卡）。
  if (url.pathname === '/exec' && req.method === 'POST') {
    // 这条比其他路由更危险（等于任意代码执行），所以不吃"本机自连"的豁免：
    // 必须带 key，而且必须 application/json —— 网页表单只能发 text/plain / urlencoded，
    // 拦住 CSRF：恶意网页光靠 <form> 是打不进来的。
    const ct = String(req.headers['content-type'] || '');
    if (url.searchParams.get('k') !== KEY || ct.indexOf('application/json') < 0) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, out: '', err: 'forbidden' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      let cmd = '';
      try { cmd = String((JSON.parse(body || '{}') || {}).cmd || ''); } catch (e) {}
      if (!cmd.trim()) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, out: '', err: '命令为空' }));
        return;
      }
      const t0 = Date.now();
      // 先切 UTF-8 再跑：powershell.exe 默认按控制台代码页（中文系统 GBK）往管道写，
      // 直接用编码 utf8 读会得到乱码。这两行只影响本进程的输出编码，不改用户命令的语义。
      const wrapped = '$ProgressPreference="SilentlyContinue";'
        + '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
        + '$OutputEncoding=[System.Text.Encoding]::UTF8;'
        + cmd;
      // 兜底：execFile 的 timeout 只保证"结束子进程"，如果命令拉起了孙进程占住管道，
      // 回调可能迟迟不来，页面就会一直转"执行中…"。这里硬等 62 秒后自己回一次。
      let replied = false;
      const reply = (payload) => {
        if (replied) return;
        replied = true;
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        } catch (e) {}
      };
      const guard = setTimeout(() => {
        console.log('exec: guard timeout ' + JSON.stringify(cmd.slice(0, 100)));
        reply({ ok: false, code: -1, out: '', err: '超过 60 秒没有返回（命令可能还在跑，或被它拉起的子进程占住了输出）', ms: Date.now() - t0 });
      }, 62000);
      guard.unref?.();
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
        { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          clearTimeout(guard);
          const ms = Date.now() - t0;
          console.log('exec: ' + JSON.stringify(cmd.slice(0, 100)) + ' -> ' + (err ? ('err ' + (err.code || '')) : 'ok') + ' ' + ms + 'ms');
          // 超时被杀时 stderr 是空的，只报「失败(1)」用户看不懂，这里补一句人话
          let errText = String(stderr || '').slice(-8000);
          if (!errText && err) {
            if (err.killed || err.signal) errText = '命令超过 60 秒被终止（可能还在跑，或需要交互输入）';
            else if (err.code === 'ENOENT') errText = '找不到 powershell.exe';
            else if (typeof err.message === 'string' && err.message) errText = err.message;
          }
          reply({
            ok: !err,
            code: err ? (err.code || 1) : 0,
            out: String(stdout || '').slice(-20000),
            err: errText,
            ms,
          });
        });
    });
    return;
  }

      if (url.pathname === '/cursor') {
        const t = Date.now();
        let c = input.cursor();
        if (c.x < 0) { input.send({ t: 'cursor' }); c = input.cursor(); }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ x: c.x, y: c.y, t }));
        return;
      }

  if (url.pathname === '/sources') {
    try {
      // 页面每 2 秒轮询一次，这里缓存 600ms，避免每次都真的去枚举一遍窗口
      const nowTs = Date.now();
      if (!sourcesCache.out || nowTs - sourcesCache.at > 600) {
        sourcesCache.out = execFileSync(join(HERE, 'sources.exe'), { encoding: 'utf8', timeout: 8000 });
        sourcesCache.at = nowTs;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(sourcesCache.out);
    } catch (e) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('sources failed: ' + e.message); }
    return;
  }

  if (url.pathname === '/mode' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body || '{}');
        const before = JSON.stringify(sourceState);
        if (m.mode === 'mjpeg' || m.mode === 'raw') sourceState.mode = m.mode;
        if (Number.isInteger(m.monitor)) sourceState.monitor = m.monitor;
        const prevWindow = sourceState.window;
        if (Number.isInteger(m.window)) sourceState.window = m.window;
        // 改动（独立审查 M3）：宽度必须钳制在 [0, CAP_W]。
        // 原来原样收下客户端给的值，前端又另外硬编码着 2560/1280，
        // 于是 P0-3 "按实际抓屏宽度自适应"的修复在 /mode 这条路上被架空了：
        // 传一个 99999 就会让抓屏进程去申请一张巨大的图（内存/CPU 白烧）。
        if (Number.isInteger(m.width)) {
          sourceState.width = Math.max(0, Math.min(CAPTURE_W, Math.round(m.width)));
        }
        const unchanged = JSON.stringify(sourceState) === before;
        // 值没变就别重写控制文件：capture 看到文件变化会重启抓屏循环（画面会卡一下）。
        // 页面每次打开都会 postMode({})，重复点同一个来源也是同样的情况。
        if (!unchanged) writeMode();
        // 切到某个窗口时把它提到最前面：否则它在别的窗口后面时，截到的会被遮住，
        // 而且注入的点击也会落到挡在前面的窗口上。
        if (sourceState.window && sourceState.window !== prevWindow) {
          input.send({ t: 'focus', hwnd: sourceState.window });
          console.log('screen-server: raise window 0x' + sourceState.window.toString(16));
        }
        if (!unchanged) console.log('screen-server: source -> ' + JSON.stringify(sourceState));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sourceState));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (url.pathname === '/input' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body || '{}');
        const evs = Array.isArray(m.events) ? m.events : (m.t ? [m] : []);
        for (const ev of evs) input.send(ev);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sent: evs.length, ...input.stats() }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  // ---- Service Worker（让手机能"安装到桌面"）--------------------------------
  // 为什么必须有一个：安卓 Chrome 判断"能不能装成 App"时要求存在带 fetch 事件的
  // service worker。没有它，manifest 再完整也不会弹安装提示。
  //
  // 但这里**故意不做任何缓存**：fetch 处理器什么都不拦截，让浏览器照常走网络。
  // 理由：页面是 server 端渲染的，一旦缓存住，改了 page.mjs 客户会一直看到旧页面——
  // 这类"更新不生效"的问题排查成本极高。安装能力靠 SW 存在，性能靠网络，两不耽误。
  if (url.pathname === '/sw.js') {
    const sw = [
      "// 只为了让手机能安装到桌面。不做任何缓存（避免旧页面卡住）。",
      "self.addEventListener('install', (e) => { self.skipWaiting(); });",
      "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });",
      "self.addEventListener('fetch', (e) => { /* 不拦截：走默认网络行为 */ });",
      ""
    ].join('\n');
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/'
    });
    res.end(sw);
    return;
  }

  if (url.pathname === '/manifest.json') {
    const base = `http://${req.headers.host}/`;
    // 改动（第二轮 P0-1 / H1-r1）：
    //   1) start_url 不再拼 ?k=<KEY> —— 装出来的 App 打开 / 时，服务端会下发
    //      screen-key cookie（见下面 '/' 路由），下次进页面靠 cookie 认证，不靠 URL 里的密钥。
    //      原来那行等于把完整访问密钥写进响应体，谁 GET 一次清单谁就拿到钥匙。
    //   2) cache-control 从 max-age=86400 改成 no-store。
    // 改动（2026-10-30，真机 PWA 回归修复）：上面第 1 条的 cookie 方案在真机上走不通——
    //   安卓手机（2026-10-30 用户实机，小米 HyperOS）把页面装成 App 后，App 打开
    //   start_url '/' 时**既不带 cookie 也不带 ?k**，服务端直接 401「这个地址缺了钥匙」
    //   （浏览器里正常，是因为浏览器地址栏 URL 里本来就带着 k=）。安装出来的 web 应用
    //   不共享浏览器 cookie 存储（Safari 添加到主屏幕从不共享，安卓此机同样没共享），
    //   "下次靠 cookie 认证"这条假设不成立。
    //   所以 start_url 重新带上密钥。这次是安全的：/manifest.json 自 P0-1 起就在
    //   STRICT_AUTH_PATHS 里，裸 GET（不带 k / 不带 cookie / 不带有效短时 token）仍然 401；
    //   能读到这份清单的，只有已经拿着密钥的客户端，或渲染过页面的浏览器（页面 HTML 与
    //   入口二维码里本就含完整密钥）——清单带密钥没有新增任何暴露面。装出来的 App 打开
    //   start_url='/?k=<密钥>' 直接过鉴权，不依赖任何 cookie。
    //   代价：轮换了密钥后，旧 App 图标会失效（和旧书签一样），需要重新「添加到主屏幕」
    //   ——这与「我的远程入口」文档 §四 的既有口径一致。
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      name: '电脑画面', short_name: '电脑画面', start_url: '/?k=' + encodeURIComponent(KEY),
      display: 'standalone', orientation: 'landscape', background_color: '#0b0b0d', theme_color: '#15161a',
      icons: [
        { src: '/icon-192.png?v=' + ICON_V, sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png?v=' + ICON_V, sizes: '512x512', type: 'image/png' },
      ],
    }));
    return;
  }

  if (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png') {
    try {
      const png = readFileSync(join(HERE, url.pathname.slice(1)));
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400', 'content-length': png.length });
      res.end(png);
    } catch { res.writeHead(404); res.end('no icon'); }
    return;
  }


  if (!authorized(req, url)) {
    rejectAuth(req, res, url, ra);
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `screen-key=${KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    });
    res.end(PAGE(KEY, manifestHref()));
    return;
  }

  if (url.pathname === '/frame.jpg') {
    lastPoll = Date.now();   // polling counts as watching (low-bandwidth mode)
    if (!frame) { res.writeHead(503); res.end('no frame yet'); return; }
    // 省流量模式可以要求缩小的副本：?w=1280&q=45 会缩放+重编码，同一帧只算一次，
    // 结果缓存到下一帧到来。不带参数时行为不变（原图）。
    const wRaw = Number(url.searchParams.get('w') || 0);
    const qRaw = Number(url.searchParams.get('q') || 0);
    // 上限 = 当前画质档位（deliverCapW：再叠加"未授权且当日超清用完 → ≤1920"的钳制）
    const capW = deliverCapW();
    let w = Number.isFinite(wRaw) ? Math.max(0, Math.min(capW, Math.round(wRaw))) : 0;
    let q = Number.isFinite(qRaw) && qRaw > 0 ? Math.max(20, Math.min(95, Math.round(qRaw))) : 0;
    // 画质档位低于抓屏宽时，即使页面没带参数也要缩（否则 2560 原图照发，流量和档位都对不上）
    if (!w && capW < CAPTURE_W) { w = capW; if (!q) q = 70; }
    // 计时：这次真的按 >1920 宽出图，才算"正在看超清"
    if ((w || CAPTURE_W) > ULTRA_LIMIT) ultraNoteServe();
    if (!w && !q) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' });
      res.end(frame);
      return;
    }
    const cacheKey = frameStamp + ':' + w + ':' + q;
    if (thumb.cacheKey === cacheKey && thumb.buf) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': thumb.buf.length, 'cache-control': 'no-store' });
      res.end(thumb.buf);
      return;
    }
    sharp(frame)
      .resize({ width: w || undefined, withoutEnlargement: true })
      .jpeg({ quality: q || 62 })
      .toBuffer()
      .then((buf) => {
        thumb.buf = buf; thumb.cacheKey = cacheKey;
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' });
        res.end(frame);
      });
    return;
  }

  if (url.pathname === '/stream') {
    // 带宽自适应：?w=&q= 让服务端直接发缩小/低质量的副本。
    // 2560×1600 q62 一帧 ~190KB，24fps ≈ 36Mbps；手机 4G / Tailscale 中继（DERP）
    // 根本推不动，只会越排越多 → 延迟从 100ms 涨到几秒。降到 1280 宽一帧 ~40KB 就能跑满帧率。
    const wRaw = Number(url.searchParams.get('w') || 0);
    const qRaw = Number(url.searchParams.get('q') || 0);
    // 上限 = 当前画质档位（deliverCapW，含"超清配额用完 → ≤1920"的钳制）。流是长连接，
    // 画质可能在连接中途被切，所以 baseW/baseQ 只记"建连时页面自己的意图"，
    // 实际发送宽度每帧在 push() 里按**当前**档位重算。
    const capW = deliverCapW();
    const baseW = Number.isFinite(wRaw) ? Math.max(0, Math.min(capW, Math.round(wRaw))) : 0;
    const baseQ = Number.isFinite(qRaw) && qRaw > 0 ? Math.max(20, Math.min(95, Math.round(qRaw))) : 0;
    let reqW = baseW, reqQ = baseQ;
    if (!reqW && capW < CAPTURE_W) { reqW = capW; if (!reqQ) reqQ = 70; }
    const sid = String(url.searchParams.get('s') || '').slice(0, 24);   // 丢帧按会话统计

    // ---- 免费版并发上限（2026-10-30）：最多 3 台设备同时看 ----
    // 只数"正在看画面"的连接：清晰模式本连接 + 流畅模式 RTC 的对端。
    // 许可证 / 7 天试用期内不限。超限直接回 429 + 一句人话，不占抓屏、不占带宽。
    if (!isFullFunction()) {
      const liveViewers = streams + ((function () { try { return rtc.stats().peers || 0; } catch { return 0; } })());
      if (liveViewers >= FREE_MAX_VIEWERS) {
        console.log('screen-server: /stream 被并发上限拦下 viewers=' + liveViewers + ' limit=' + FREE_MAX_VIEWERS);
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('免费版最多 ' + FREE_MAX_VIEWERS + ' 台设备同时观看，现在已经有 ' + liveViewers + ' 台在看了。\n'
          + '请先关掉其他设备上的页面，或安装许可证解锁多设备同时观看。\n');
        return;
      }
    }

    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frameboundary',
      'cache-control': 'no-store',
      connection: 'close',
      'x-accel-buffering': 'no',
    });
    try { res.socket.setNoDelay(true); } catch (e) {}
    const BOUND = '--frameboundary\r\n';
    let sent = -1;
    let dropped = 0;
    let busy = false;
    let released = false;
    let lastBytes = 0;      // 上一帧实际发出去的字节数（编码后），用来算排队阈值
    const connAt = Date.now();

    // NOTE: res.write() on a 300 KB frame ALWAYS returns false — Node's default
    // high-water mark is 16 KB, so "false" only means "buffer is filling", not
    // "the link is congested". Real backlog is res.writableLength: allow about
    // two frames in flight and skip beyond that, so latency stays bounded.
    // 刚连上的 1.5 秒内不算丢帧：那时 socket 还在灌第一帧，属于正常的追赶期。
    const push = () => {
      if (!frame || frameStamp === sent || busy || released) return;
      const stamp = frameStamp;
      const src = frame;
      // 每帧按"当前"画质档位重算发送宽度：这样在手机上切换画质立即生效，
      // 不用重连、不用重启服务（以前改完必须整机重启才会换分辨率）。
      // 配额（免费版超清 1 小时）也在这里复查：中途用完就地降到 1920，跨天恢复自动回去。
      const capNow = deliverCapW();
      const wantW = baseW > 0 ? Math.min(baseW, capNow) : (capNow < CAPTURE_W ? capNow : 0);
      const wantQ = baseQ > 0 ? baseQ : (wantW ? 70 : 0);
      reqW = wantW; reqQ = wantQ;
      if ((reqW || CAPTURE_W) > ULTRA_LIMIT) ultraNoteServe();
      // 排队阈值按"编码后"的帧大小算（以前用原始 290KB 当阈值，窄带降档后实际帧只有
      // 98KB，要排到 580KB 才开始丢，延迟一路涨到 1 秒多）。但也不能太紧：Chrome 解码
      // multipart 时会短暂停一下，1.2 帧的阈值会把正常抖动误判成拥塞，于是"一直掉帧"。
      const cap = Math.max(120 * 1024, (lastBytes || src.length) * 2.2);
      if (res.writableLength > cap) {
        dropped++;
        if (Date.now() - connAt > 1500) noteDrop(stamp, sid);
        return;
      }
      sent = stamp;
      busy = true;
      encodeStream(src, stamp, reqW, reqQ).then((buf) => {
        if (released || res.destroyed || !buf) return;
        const head = BOUND + 'Content-Type: image/jpeg\r\n' + `Content-Length: ${buf.length}\r\n`
          + `X-Frame-Ts: ${stamp}\r\n\r\n`;
        res.write(head);
        res.write(buf);
        res.write('\r\n');
        notePush(stamp);
        lastBytes = buf.length;
        lastLagFrames = Math.max(0, Math.round(res.writableLength / Math.max(1, buf.length)));
      }).catch(() => {}).then(() => {
        busy = false;
        // 编码刚结束：如果已经有更新的帧，立刻推上去，不要白等下一个 25ms tick。
        // （以前固定 25ms 轮询 + 30ms 编码 → 实际每 80ms 才出一帧，降档后反而只有 12fps）
        if (!released && !res.destroyed && frameStamp !== sent) push();
      });
    };

    push();

    streams++;
    publishViewers();

    const timer = setInterval(push, 25);
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      streams = Math.max(0, streams - 1);
      publishViewers();
    };
    req.on('close', release);
    res.on('close', release);
    res.on('error', release);
    return;
  }

  res.writeHead(404); res.end('not found');
}

let started = 0;
for (const host of hosts) {
  const s = createServer(handler);
  rtc.attach(s, (req, url) => {
    if (!sourceAllowed(req)) return false;
    if (!authorized(req, url)) return false;
    // 免费版并发上限同样管流畅模式（RTC）：超限返回一句状态行，页面会提示"设备数已满"。
    if (!isFullFunction()) {
      let peers = 0;
      try { peers = rtc.stats().peers || 0; } catch { }
      if (streams + peers >= FREE_MAX_VIEWERS) {
        console.log('rtc: 被并发上限拦下 viewers=' + (streams + peers) + ' limit=' + FREE_MAX_VIEWERS);
        return '429 Too Many Viewers';
      }
    }
    return true;
  });
  attachH264Ws(s, KEY);
  attachAudioWs(s, KEY);
  s.on('error', (e) => console.error(`screen-server: cannot bind ${host}:${port} — ${e.code || e.message}`));
  s.listen(port, host, () => {
    started++;
    console.log(`screen-server: http://${host}:${port}/`);
  });
}

if (hosts.length === 0) {
  console.error('screen-server: no hosts given');
  process.exitCode = 1;
}
