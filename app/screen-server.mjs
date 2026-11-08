import { PAGE, PAGE_VER } from './page.mjs';
import os from 'node:os';
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

// 网络抖动（客户端强退/断网）会触发 Socket 'error'（ECONNRESET/EPIPE）。
// 以前没有护栏会直接抛到进程级 → 整个画面服务退出（表现为手机长时间黑屏、随后掉省流量）。
process.on('uncaughtException', (e) => {
  const code = e && e.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') {
    console.log('net: ignored ' + code);
    return;
  }
  console.error('uncaught: ' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection: ' + ((e && e.message) || e));
});
import http, { createServer } from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, statSync, unlinkSync, appendFileSync, renameSync, mkdirSync, readdirSync, createReadStream, createWriteStream, openSync, closeSync, ftruncateSync, existsSync, rmSync, statfsSync } from 'node:fs';
import { randomBytes, createPublicKey, createVerify, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));

import { createRtc } from './rtc.mjs';
import wrtcNs from '@roamhq/wrtc';
const RTCPeerConnection = wrtcNs.RTCPeerConnection;
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
// 离线模式（product.config.json → screen.offline）：没有互联网/Tailscale 时允许绑 RFC1918 局域网/热点地址
const OFFLINE_MODE = !!(cfgScreen && cfgScreen.offline === true);
// 2026-11-07：screen.lan=true 时允许直接监听局域网（不用开整个离线模式）；发布版默认 false
const ALLOW_LAN = OFFLINE_MODE || !!(cfgScreen && cfgScreen.lan === true);
// 2026-11-07 18:2x（安全收紧后的统一口径）：
//   screen.lan=true 只额外开 **8662 的 HTTPS 监听**（局域网专用；密钥仍然必填），
//   8660 永远只给「回环 + Tailscale」—— **不碰** 那条「拒绝局域网 8660」的防火墙规则。
//   这样"局域网直连"不会把 tailnet 入口的姿态一起放宽。
//   screen.offline=true 是旧路子（额外把 8660/8661/8662 绑到所有网卡、需要停用防火墙拦截），保留兼容。
const LAN_ONLY = !OFFLINE_MODE && !!(cfgScreen && cfgScreen.lan === true);
const LAN_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
const badHosts = [];
const hosts = hostsArg.split(',').map((h) => h.trim()).filter(Boolean).filter((h) => {
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  if (!isV4) { badHosts.push(h + '(非 IPv4)'); return false; }
  if (h === '0.0.0.0') { badHosts.push(h + '(通配全部网卡)'); return false; }
  if (!PRIVATE_V4.some((re) => re.test(h)) && !(ALLOW_LAN && LAN_V4.test(h))) { badHosts.push(h + '(非回环/非 Tailscale/局域网未允许)'); return false; }
  return true;
});
if (badHosts.length) {
  console.error('screen-server: [安全] 拒绝绑定这些地址：' + badHosts.join('、'));
  console.error('screen-server: 只允许回环 127.0.0.1 和 Tailscale 的 100.64.0.0/10；局域网地址需要先开启「离线模式」（screen.offline=true）。');
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
const RTC_W = cfgRtcW >= 320 ? evenDown(cfgRtcW) : evenDown(Math.max(320, Math.round(CAP_W * 0.625)));   // 流畅模式默认 1600 宽（原 1280）
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
let H264_FPS = Math.max(10, Math.min(60, Number(cfgH264.fps) || 30));
let H264_KBPS = Math.max(2000, Math.min(40000, Number(cfgH264.kbps) || 12000));
let H264_RECT = null;
// 画质优先（可选，默认关）：p4+hq、VBR+CQ，静态更清晰，流量会波动
let H264_QF = cfgH264.qualityFirst === true;
// 2026-11-06 已移除 GPU 侧缩放实验（ddagrab video_size 是裁剪、scale_d3d11 在本机创建 NV12 纹理失败）。
// 单窗口采集（实验）：>0 时用 win-capture.exe 抓这个窗口，0 = 普通全屏 ddagrab
let H264_WIN = 0;
// 采集的显示器序号（ddagrab output_idx）：0=主屏；副屏必须切到对应 output_idx，
// 否则抓的是主屏、只把副屏的坐标当裁剪区 → 画面和操控对不上（2026-11-05 用户报的副屏 bug）
let H264_MON = 0;
let wtSrv = null;
// B 方案：Pion 侧车（可选，默认关闭；开启后把帧转 Annex-B 通过 TCP 喂侧车）
const CFG264 = (cfgH264.rtc264 || {});
let side264 = null, conn264 = null, conn264Retry = 0;

let H264_W = evenDown(Math.max(640, Math.min(CAP_W, Number(cfgH264.width) || CAP_W)));
let H264_H = evenDown(Math.max(360, Math.round(H264_W * CAP_H / CAP_W)));
// 原生分辨率：ddagrab 直喂 NVENC（零拷贝，不经过滤器）。2026-11-07 实测踩坑：
// 这台机器（RTX 5070 + 当前 ffmpeg）做不了 d3d11→nv12 的自动转换，零拷贝路径直接
// `-40 Function not implemented`，ffmpeg 秒退重试，画面全黑（2560 宽时必现，1920 走过滤器所以正常）。
// 所以这里不再按宽度猜，改成**启动时探测**：探测失败就永远走 hwdownload+scale 的过滤器路径。
let H264_NATIVE = false;
let H264_ZEROCOPY = false;
// 编码器：优先 NVENC（硬编，延迟低、CPU 几乎为 0），不可用时回退 h264_mf（软编）
// 注意（2026-11-05 修）：这里的探测帧原来用 64x64，比 NVENC 的最小尺寸还小，
// 于是「探测永远失败」→ 所有机器都退回 h264_mf 软编（1920x1200@60 吃满 CPU，延迟也高）。
// 用 640x480 探测才测得出真实可用性；h264_mf 只在真的没有 N 卡/驱动时兜底。
let H264_ENCODER = 'mf';
try {
  if (H264_ENABLED) {
    execFileSync(FFMPEG_EXE, ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=black:s=640x480:r=1','-t','0.2','-c:v','h264_nvenc','-f','null','-'], { timeout: 8000, stdio: 'ignore' });
    H264_ENCODER = 'nvenc';
  }
} catch { H264_ENCODER = 'mf'; }
// 零拷贝（ddagrab d3d11 直喂 nvenc nv12）能力探测：1 帧就够，失败就禁用。
if (H264_ENABLED && H264_ENCODER === 'nvenc') {
  try {
    execFileSync(FFMPEG_EXE, ['-hide_banner','-loglevel','error','-nostdin',
      '-f','lavfi','-i','ddagrab=framerate=30:draw_mouse=0:output_idx=0',
      '-frames:v','1','-pix_fmt','nv12','-c:v','h264_nvenc','-f','null','-'], { timeout: 10000, stdio: 'ignore' });
    H264_ZEROCOPY = true;
  } catch (e) { H264_ZEROCOPY = false; }
}
H264_NATIVE = H264_ZEROCOPY && H264_W >= CAP_W && H264_W >= 2560;
console.log('h264: encoder=' + H264_ENCODER + (H264_ENABLED ? '' : '（h264 未启用）') + ' 零拷贝=' + (H264_ZEROCOPY ? '可用' : '不可用（走过滤器）'));

const h264 = {
  proc: null,
  init: null,
  pending: Buffer.alloc(0),
  clients: new Set(),
  bytes: 0,
  frames: 0,
  stopTimer: null,
  lastError: '',
  startedAt: 0,
  killPending: false,
  startQueued: false
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
  // 安全阀（2026-11-05）：fMP4 分片很小，正常不会堆到几 MB；一旦解析卡住，
  // Buffer.concat 会让内存 O(n²) 涨上去（实测把 node 吃到 1.5GB 后接口全超时）。
  if (h264.pending && h264.pending.length > 8 * 1024 * 1024) {
    h264.pending = Buffer.alloc(0);
    h264.initInfo = null;
    console.log('h264: 解析缓冲异常堆积（>8MB），已重置');
  }
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
      h264RtcSendFrame({ ts: h264.tsUs, key: s.key, data: s.data });
      if (wtSrv) { try { h264.frameSeq = (h264.frameSeq || 0) + 1; wtSrv.broadcast({ id: h264.frameSeq, key: s.key, data: s.data }); } catch { } }
      feed264(s.key, s.data);
      // 送达侧帧率：MJPEG 流退役后，帧只通过「WebCodecs 客户端」或「B 方案侧车」交给手机，
      // 这里按"这一帧确实有人要"记一次（同一帧推给多路只算一帧，靠 tsUs 去重）。
      if (h264.clients.size || rtc264Status.sessions > 0) notePush(h264.tsUs);
    }
    h264.frames += samples.length;
    h264.pending = h264.pending.subarray(mdat.end);
    continue;
  }
}
// ---- WebRTC DataChannel 传输（UDP 语义：无序、不重传）--------------------
const h264RtcChannels = new Set();

function h264RtcSendFrame(frame) {
  if (h264RtcChannels.size === 0) return;
  const CHUNK = 8000;
  const total = frame.data.length;
  let off = 0;
  while (off < total) {
    const part = frame.data.subarray(off, Math.min(off + CHUNK, total));
    const head = Buffer.alloc(14);
    head[0] = off === 0 ? (part.length === total ? 0 : 1) : (off + part.length >= total ? 3 : 2);
    head.writeInt32BE(frame.ts, 1);
    head[5] = frame.key ? 1 : 0;
    head.writeUInt32BE(total, 6);
    head.writeUInt32BE(off, 10);
    const msg = Buffer.concat([head, part]);
    for (const ch of h264RtcChannels) {
      try { if (ch.readyState === 'open' && ch.bufferedAmount < 256 * 1024) ch.send(msg); } catch { }
    }
    off += part.length;
  }
}
function attachH264Rtc(server, key) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { try { socket.destroy(); } catch { } return; }
    if (url.pathname !== '/h264-rtc') return;
    if (!sourceAllowed(req) || !authorized(req, url)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    try { socket.setNoDelay(true); } catch { }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    let pc = null;
    let channels = [];
    const cleanup = () => {
      for (const ch of channels) { try { h264RtcChannels.delete(ch); } catch { } }
      channels = [];
      try { if (pc) pc.close(); } catch { }
      pc = null;
    };
    ws.on('close', cleanup);
    ws.on('message', async (raw) => {
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || msg.type !== 'offer' || !msg.sdp) return;
      try {
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          if (ch.label !== 'frames') return;
          ch.binaryType = 'arraybuffer';
          ch.onopen = () => { h264RtcChannels.add(ch); h264Start(); };
          ch.onclose = () => { h264RtcChannels.delete(ch); };
          channels.push(ch);
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        try { ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp })); } catch { }
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'answer-error', error: String(e.message || e) })); } catch { }
        cleanup();
      }
    });
    ws.on('error', () => { });
  });
}
function h264Filter() {
  let vf = '[0:v]hwdownload,format=bgra';
  if (H264_RECT && H264_RECT.w >= 16 && H264_RECT.h >= 16) {
    const x = Math.max(0, Math.round(H264_RECT.x / 2) * 2);
    const y = Math.max(0, Math.round(H264_RECT.y / 2) * 2);
    const w = Math.max(16, Math.round(H264_RECT.w / 2) * 2);
    const h = Math.max(16, Math.round(H264_RECT.h / 2) * 2);
    vf += ',crop=' + w + ':' + h + ':' + x + ':' + y;
  }
  // 2026-11-06：不再显式接 format=nv12 —— 交给编码器声明 -pix_fmt nv12，
  // swscale 在缩放的同一次 pass 里就把 BGRA 转成 NV12（实测 1920×1200@60 少约 25% CPU，输出完全一致）。
  vf += ',scale=' + H264_W + ':-2:flags=lanczos+accurate_rnd[v]';
  return vf;
}

// 编码参数（ddagrab 全屏采集和单窗口采集共用）
function h264EncArgs() {
  return [
    // 编码器：NVENC（硬编，延迟低、CPU 几乎为 0）优先；不可用时回退 h264_mf（软编低延迟档）
    ...(H264_ENCODER === 'nvenc'
      ? (H264_QF
        // 画质优先：p4 + hq（编码延迟多 1 帧左右），VBR+CQ 让静态桌面吃满质量、动态时封顶 maxrate。
        // 代价：码率不再恒定（流量会波动），所以做成设置里的可选开关。
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '22',
           '-b:v', String(H264_KBPS) + 'K', '-maxrate', String(H264_KBPS) + 'K', '-bufsize', String(H264_KBPS * 2) + 'K',
           '-g', String(Math.round(H264_FPS)), '-bf', '0', ...(H264_NATIVE ? ['-profile:v', 'high', '-level', '5.2'] : [])]
        : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr_ld_hq', '-rc-lookahead', '0', '-delay', '0', '-surfaces', '2', ...(H264_NATIVE ? ['-profile:v', 'high', '-level', '5.2'] : []), '-b:v', String(H264_KBPS) + 'K', '-g', String(Math.round(H264_FPS)), '-bf', '0'])
      : ['-c:v', 'h264_mf', '-scenario', 'display_remoting', '-rate_control', 'ld_vbr', '-quality', H264_QF ? '90' : '70', '-b:v', String(H264_KBPS) + 'K', '-g', String(Math.round(H264_FPS)), '-bf', '0']),
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+separate_moof',
    '-frag_duration', '5000', '-flush_packets', '1',
    'pipe:1'
  ];
}

function h264ResetCounters() {
  h264.initInfo = null;
  h264.pending = Buffer.alloc(0);
  h264.bytes = 0;
  h264.tsUs = 0;
  h264.frames = 0;
}

// ffmpeg 输出/退出都走这里：旧进程（被 h264Stop 脱钩的）一律忽略，避免把解析器搅烂
function h264AttachEncoder(proc) {
  const isCurrent = () => h264.proc === proc;
  proc.stdout.on('data', (d) => {
    if (!isCurrent()) return;
    h264.bytes += d.length;
    h264.pending = Buffer.concat([h264.pending, d]);
    processH264Buffer();
  });
  proc.stderr.on('data', (d) => {
    if (!isCurrent()) return;
    const s = String(d).trim();
    if (s) { h264.lastError = s.split('\n').slice(-1)[0]; }
  });
  proc.on('exit', (code) => {
    const wasCurrent = isCurrent();
    if (wasCurrent) { h264.proc = null; h264.killPending = false; }
    console.log('h264: ffmpeg exit ' + code + (wasCurrent ? '' : '（旧进程，忽略）'));
    if (!wasCurrent) return;
    // 2026-11-07：秒退保护。零拷贝路径在个别机器上会立刻失败（-40 Function not implemented），
    // 以前会无限重试、画面永远黑。这里连续 2 次在 2 秒内退出就判定该路径不可用，
    // 永久退回过滤器路径再重启，保证用户至少能看到画面。
    try {
      const alive = Date.now() - (h264.startedAt || 0);
      if (alive < 2000) {
        h264.quickFails = (h264.quickFails || 0) + 1;
        if (h264.quickFails >= 2 && H264_NATIVE) {
          H264_ZEROCOPY = false;
          H264_NATIVE = false;
          h264.quickFails = 0;
          h264.lastError = 'zero-copy 连续秒退，已回退过滤器路径';
          console.log('h264: ' + h264.lastError);
        }
      } else {
        h264.quickFails = 0;
      }
    } catch (e) { }
    // 单窗口模式下编码器死了，采集端也要一起收掉，否则 h264Start 会被 h264.cap 挡住
    if (h264.cap) { const c = h264.cap; h264.cap = null; try { c.kill(); } catch { } }
    if (h264.clients.size > 0 || rtc264Alive()) {
      setTimeout(() => { if (rtc264Alive() || h264.clients.size > 0) h264Start(); }, 1500);
    }
  });
  proc.on('error', (e) => { if (isCurrent()) h264.lastError = String(e.message || e); });
}

function h264Start() {
  // killPending：上一只 ffmpeg 还没退干净。**这时绝不能再 spawn**，
  // 否则会同时跑多只编码器、共用一个解析缓冲（2026-11-05 晚就是这样卡死 node 的）。
  // h264.cap：单窗口采集端正在启动（还没起 ffmpeg），也不能重复 spawn。
  if (!H264_ENABLED || h264.proc || h264.killPending || h264.cap) return;
  if (h264.stopTimer) { clearTimeout(h264.stopTimer); h264.stopTimer = null; }
  if (H264_WIN > 0) return h264StartWindow();
  // 2026-11-06 结论（记录一下，别再试错）：GPU 侧缩放这条路在这台机器上不通 ——
  //   · ddagrab 的 video_size 是「裁剪采集区域」不是缩放，用它会让手机只看到画面左上角；
  //   · scale_d3d11 在这块 RTX 5070 + 驱动 32.0.15.9201 上创建 NV12 纹理直接 E_INVALIDARG。
  // 所以全屏缩小仍走 CPU（hwdownload → swscale lanczos），但把「缩放 + 转 NV12」合成一次 pass：
  // 由编码器声明 -pix_fmt nv12，filter 里不再接 format=nv12（实测少约 25% CPU，输出保持一致）。
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // 低延迟输入：不探测/不缓存
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'lavfi', '-i', `ddagrab=framerate=${H264_FPS}:draw_mouse=0:output_idx=${H264_MON}`,
    ...(H264_NATIVE ? [] : ['-filter_complex', h264Filter(), '-map', '[v]']),
    '-pix_fmt', 'nv12',
    ...h264EncArgs()
  ];
  console.log('h264: start ' + H264_W + 'x' + H264_H + '@' + H264_FPS + ' ' + H264_KBPS + 'kbps');
  h264ResetCounters();
  let proc = null;
  try {
    proc = spawn(FFMPEG_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    h264.lastError = String(e.message || e);
    console.log('h264: spawn failed ' + h264.lastError);
    h264.proc = null;
    return;
  }
  h264.proc = proc;
    h264.startedAt = Date.now();
  h264AttachEncoder(proc);
}

// 单窗口采集：win-capture.exe 把窗口客户区以 BGRA 原始帧写到 stdout，
// 直接喂 ffmpeg 的 rawvideo（PrintWindow 即使窗口被挡也能拿到它自己的画面）。
// 帧率封顶 30：PrintWindow 每帧约 20–60ms，再高也跑不满。
function h264StartWindow() {
  const helper = join(HERE, 'bin', 'win-capture.exe');
  if (!fileExists(helper)) { console.log('h264: 缺 win-capture.exe，回退全屏采集'); H264_WIN = 0; return h264Start(); }
  const capFps = Math.max(5, Math.min(30, H264_FPS));
  h264ResetCounters();
  let cap = null;
  try {
    cap = spawn(helper, [String(H264_WIN), String(capFps)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    h264.lastError = String(e.message || e);
    H264_WIN = 0;
    return h264Start();
  }
  h264.cap = cap;
  h264.startedAt = Date.now();
  console.log('h264: window capture hwnd=' + H264_WIN + ' @' + capFps + 'fps');
  let started = false, errBuf = '';
  const startEncoder = (w, h) => {
    if (started || h264.cap !== cap) return;
    started = true;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', w + 'x' + h, '-r', String(capFps), '-i', 'pipe:0',
      // 窗口尺寸可能是奇数（NVENC 要求偶数），且过大的窗口缩到 1920 宽再编码
      // 2026-11-06：format=nv12 去掉，改成 -pix_fmt nv12，让 swscale 一次 pass 完成缩放+转换
      '-vf', 'scale=min(iw\\,1920):-2:flags=lanczos+accurate_rnd',
      '-pix_fmt', 'nv12',
      ...h264EncArgs()
    ];
    let ff = null;
    try {
      ff = spawn(FFMPEG_EXE, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      h264.lastError = String(e.message || e);
      H264_WIN = 0;
      try { cap.kill(); } catch { }
      return;
    }
    h264.proc = ff;
    try { cap.stdout.pipe(ff.stdin); } catch (e) { }
    h264AttachEncoder(ff);
    console.log('h264: window encoder ' + w + 'x' + h);
  };
  cap.stderr.on('data', (d) => {
    if (h264.cap !== cap) return;
    errBuf += String(d);
    // 客户区在屏幕上的物理矩形：页面用它做输入坐标换算（单窗口采集比窗口边框精确）
    const rm = errBuf.match(/RECT (-?\d+) (-?\d+) (\d+) (\d+)/);
    if (rm) {
      h264.winRect = { x: Number(rm[1]), y: Number(rm[2]), w: Number(rm[3]), h: Number(rm[4]) };
      errBuf = errBuf.replace(rm[0], '');
    }
    if (!started) {
      const m = errBuf.match(/SIZE (\d+) (\d+)/);
      if (m) { errBuf = errBuf.replace(m[0], ''); startEncoder(Number(m[1]), Number(m[2])); }
    } else {
      const s = errBuf.trim();
      if (s) h264.lastError = s.split('\n').slice(-1)[0];
    }
    if (errBuf.length > 4096) errBuf = errBuf.slice(-1024);
  });
  cap.on('exit', (code) => {
    if (h264.cap !== cap) return;
    h264.cap = null;
    console.log('h264: window capture exit ' + code);
    if (code === 2) {            // 客户区尺寸变了：重启整条管线
      h264.startQueued = true;
      h264Stop();
      setTimeout(() => { if ((rtc264Alive() || h264.clients.size > 0) && !h264.proc && !h264.killPending) h264Start(); }, 1200);
    } else if (code === 3) {     // 窗口关了：回退全屏采集
      H264_WIN = 0;
      h264.startQueued = true;
      h264Stop();
      setTimeout(() => { if ((rtc264Alive() || h264.clients.size > 0) && !h264.proc && !h264.killPending) h264Start(); }, 1200);
    } else {
      if (h264.proc) { try { h264.proc.kill(); } catch { } }
      // 采集端起来就挂了（没等到 SIZE）：稍后重试一次，别让画面一直黑着
      if (rtc264Alive() || h264.clients.size > 0) {
        setTimeout(() => { if ((rtc264Alive() || h264.clients.size > 0) && !h264.proc && !h264.cap && !h264.killPending) h264Start(); }, 1500);
      }
    }
  });
}

function h264Stop() {
  if (h264.stopTimer) { clearTimeout(h264.stopTimer); h264.stopTimer = null; }
  // 单窗口模式：采集端必须一起收掉，否则 h264Start 会被 h264.cap 挡住
  if (h264.cap) { const c = h264.cap; h264.cap = null; try { c.kill(); } catch { } }
  h264.winRect = null;   // 停止采集后旧的客户区矩形不再可信
  const proc = h264.proc;
  if (proc) {
    // 先脱钩：这只进程的输出/退出都不再影响状态；等它真退出了才允许再 spawn
    h264.proc = null;
    h264.killPending = true;
    try { proc.kill(); } catch { }
    const t = setTimeout(() => {
      if (!h264.killPending) return;
      try { proc.kill('SIGKILL'); } catch { }
      h264.killPending = false;
      if (h264.startQueued && (rtc264Alive() || h264.clients.size > 0)) { h264.startQueued = false; h264Start(); }
    }, 2500);
    proc.once('exit', () => {
      clearTimeout(t);
      h264.killPending = false;
      // 只有"确实有观众在等"才兑现排队的那次启动；否则会出现
      // stop→exit→start→stop 每 5 秒空转一轮（2026-11-05 晚踩过）
      if (h264.startQueued && (rtc264Alive() || h264.clients.size > 0)) { h264.startQueued = false; h264Start(); }
    });
  }
  h264.initInfo = null;
  h264.pending = Buffer.alloc(0);
  console.log('h264: stopped' + (proc ? '（等进程退出）' : ''));
}

// 需要"保证在编码"时统一走这里：上一只还没退干净就排队，等它退完立刻起，
// 不要盲目 spawn（多只 ffmpeg 同时喂一个解析器 = 2026-11-05 晚的卡死）。
function h264Ensure() {
  if (!H264_ENABLED) return;
  if (h264.proc) return;
  if (h264.killPending) { h264.startQueued = true; return; }
  h264Start();
}

const h264Wss = new WebSocketServer({ noServer: true });

// ---- B 方案：把帧转 Annex-B 并喂给 Pion 侧车 -------------------------------
function annxB(avcc) {
  const parts = [];
  let o = 0;
  while (o + 4 <= avcc.length) {
    const n = avcc.readUInt32BE(o);
    o += 4;
    if (n <= 0 || o + n > avcc.length) break;
    parts.push(Buffer.from([0, 0, 0, 1]));
    parts.push(avcc.subarray(o, o + n));
    o += n;
  }
  return Buffer.concat(parts);
}
function spsPpsPrefix() {
  const b = h264.initInfo && h264.initInfo.avcC;
  if (!b || b.length < 8) return Buffer.alloc(0);
  const out = [];
  let o = 5;
  const ns = b[o] & 0x1f; o += 1;
  for (let i = 0; i < ns; i++) {
    const l = b.readUInt16BE(o); o += 2;
    out.push(Buffer.from([0, 0, 0, 1])); out.push(b.subarray(o, o + l)); o += l;
  }
  const np = b[o]; o += 1;
  for (let i = 0; i < np; i++) {
    const l = b.readUInt16BE(o); o += 2;
    out.push(Buffer.from([0, 0, 0, 1])); out.push(b.subarray(o, o + l)); o += l;
  }
  return Buffer.concat(out);
}
function feed264(key, data) {
  if (!conn264 || conn264.destroyed || !conn264.writable) return;
  // 侧车写不动（进程卡住/系统卡）时丢帧，绝不让 Node 的内存无限涨
  if (conn264.writableLength > 4 * 1024 * 1024) { rtc264FeedDrops++; noteDrop(Date.now()); return; }
  try {
    const payload = key ? Buffer.concat([spsPpsPrefix(), annxB(data)]) : annxB(data);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length, 0);
    head[4] = key ? 1 : 0;
    conn264.write(Buffer.concat([head, payload]));
    rtc264Frames++;
  } catch { }
}

// ---- B 方案侧车进程管理（2026-11-05 稳定性改造）-----------------------------
// 旧版问题：Node 被 supervisor 重启时子进程不会跟着退，新进程再去 bind 同一个端口失败，
// 留下一个"旧版本、旧 TURN 凭据"的侧车在服侍新页面。现在先请残留进程自己退出，再拉起。
const RTC264_PORT = Number(CFG264.port) || 9800;
const RTC264_FEED_PORT = Number(CFG264.feedPort) || 9900;
const RTC264_EXE = join(HERE, 'rtc-h264', 'rtc-h264.exe');
const RTC264_TURN_PORT = CFG264.turn === false ? 0 : (Number(CFG264.turnPort) || 3478);
let rtc264Spawning = false;
let rtc264FeedDrops = 0;
let rtc264Frames = 0;
let rtc264IdleSince = 0;
let rtc264RestartAt = 0;
const rtc264Status = { at: 0, ok: false, sessions: 0, pending: 0, lastFrameMs: -1, framesIn: 0, turnOk: false, version: '' };

function rtc264Alive() {
  return rtc264Status.ok && rtc264Status.sessions > 0 && Date.now() - rtc264Status.at < 15000;
}

function http264(reqPath, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: RTC264_PORT, path: reqPath, method: method || 'GET',
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > 65536) { try { req.destroy(); } catch { } } });
      res.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 3000, () => { try { req.destroy(); } catch { } reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function shutdownStale264() {
  try {
    const j = await http264('/health', 'GET', null, 1200);
    if (!j || !j.ok) return;
    try { await http264('/shutdown', 'POST', '{}', 1200); } catch { }
    await new Promise((r) => setTimeout(r, 600));
  } catch { }
}

function start264() {
  if (!CFG264.enabled || side264 || rtc264Spawning) return;
  if (!fileExists(RTC264_EXE)) { console.log('rtc264: 侧车 exe 不存在，已停用'); return; }
  rtc264Spawning = true;
  shutdownStale264().finally(() => {
    rtc264Spawning = false;
    if (side264) return;
    const args = ['-port', String(RTC264_PORT), '-tcp', '127.0.0.1:' + RTC264_FEED_PORT];
    if (RTC264_TURN_PORT > 0) args.push('-turn-port', String(RTC264_TURN_PORT));
    const logPath = join(HERE, 'rtc-h264', 'sidecar.log');
    try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, logPath + '.1'); } catch { }
    let outFd = -1;
    try { outFd = openSync(logPath, 'a'); } catch { outFd = -1; }
    try {
      side264 = spawn(RTC264_EXE, args, { stdio: ['ignore', outFd >= 0 ? outFd : 'ignore', outFd >= 0 ? outFd : 'ignore'], windowsHide: true });
      console.log('rtc264: 侧车已拉起 pid=' + side264.pid + ' port=' + RTC264_PORT + ' turn=' + RTC264_TURN_PORT);
    } catch (e) {
      console.log('rtc264: 拉起失败 ' + e.message);
      try { if (outFd >= 0) closeSync(outFd); } catch { }
      return;
    }
    const child = side264;
    child.on('exit', (code) => {
      console.log('rtc264: 侧车退出 code=' + code + '，2 秒后重启');
      try { if (outFd >= 0) closeSync(outFd); } catch { }
      if (side264 === child) side264 = null;
      if (conn264) { try { conn264.destroy(); } catch { } conn264 = null; }
      rtc264Status.ok = false;
      if (CFG264.enabled) setTimeout(start264, 2000);
    });
    connect264Feed();
  });
}

function connect264Feed() {
  if (!side264 || conn264) return;
  const c = net.connect(RTC264_FEED_PORT, '127.0.0.1');
  conn264 = c;
  try { c.setNoDelay(true); } catch { }
  c.on('connect', () => { conn264Retry = 0; console.log('rtc264: 帧输入已连接'); });
  c.on('error', () => { });
  c.on('close', () => {
    if (conn264 === c) conn264 = null;
    if (side264 && conn264Retry < 600) {
      conn264Retry++;
      setTimeout(connect264Feed, Math.min(400 * conn264Retry, 5000));
    }
  });
}

// 侧车 /health 轮询：按会话数启停编码器，并在"有会话但长时间没帧"时重启编码器。
function poll264() {
  if (!CFG264.enabled) return;
  http264('/health', 'GET', null, 2500).then((j) => {
    if (!j || !j.ok) { rtc264Status.ok = false; return; }
    rtc264Status.ok = true;
    rtc264Status.at = Date.now();
    rtc264Status.sessions = Number(j.sessions) || 0;
    rtc264Status.pending = Number(j.pending) || 0;
    rtc264Status.lastFrameMs = typeof j.lastFrameMs === 'number' ? j.lastFrameMs : -1;
    rtc264Status.framesIn = Number(j.framesIn) || 0;
    rtc264Status.turnOk = !!j.turnOk;
    rtc264Status.version = String(j.version || '');
    onHealth264();
  }).catch(() => { rtc264Status.ok = false; });
}

function onHealth264() {
  const now = Date.now();
  if (rtc264Status.sessions > 0) {
    rtc264IdleSince = 0;
    h264Ensure();                     // 有会话就必须有编码器（上一只在退就排队）
    // 帧输入断了先补帧输入：重启 ffmpeg 也喂不进侧车，只会白折腾
    if ((!conn264 || conn264.destroyed) && side264) connect264Feed();
    const feedOk = !!conn264 && !conn264.destroyed && conn264.writable;
    const ranFor = h264.startedAt ? now - h264.startedAt : 0;
    if (feedOk && h264.proc && ranFor > 15000 && rtc264Status.lastFrameMs > 8000 && now - rtc264RestartAt > 30000) {
      rtc264RestartAt = now;
      console.log('rtc264: ' + rtc264Status.sessions + ' 路会话但 ' + rtc264Status.lastFrameMs + 'ms 没帧（编码器已跑 ' + Math.round(ranFor / 1000) + 's），重启编码器');
      h264Stop();
      setTimeout(() => { if (rtc264Alive() || h264.clients.size > 0) h264Ensure(); }, 1200);
      setTimeout(() => { if (rtc264Alive() || h264.clients.size > 0) h264Ensure(); }, 4000);
    }
    return;
  }
  if (!rtc264IdleSince) rtc264IdleSince = now;
  // 空闲 45 秒才停编码器（原来 15 秒）：再打开页面/刷新时首帧更快，不用等 ffmpeg 重新拉起 
  if (now - rtc264IdleSince > 45000 && h264.clients.size === 0 && h264.proc) {
    console.log('rtc264: 没有 WebRTC 会话也没有 WS 观众，停编码器');
    h264Stop();
    rtc264IdleSince = now;      // 重置：避免每 5 秒重复 kill（也让排队启动的条件失效）
  }
}
if (CFG264.enabled) setInterval(poll264, 5000);

// ---- 防窥屏（privacy mode，2026-11-05）--------------------------------------
// 原理：在被控电脑每块屏幕最上层盖一个全屏窗口，并用 WDA_EXCLUDEFROMCAPTURE 让它
// **不出现在屏幕捕获里**（本机实测 ddagrab 抓不到它）。所以：
//   电脑前的人 → 只看到黑屏/自定义锁屏图，鼠标点在覆盖窗上，看不到也操作不了；
//   手机端     → 捕获到的还是真实桌面，画面和控制完全不受影响。
// 安全兜底（防止把客户锁在电脑外）：lock-screen.ps1 会自己检查"服务端进程还在、心跳文件
// 还在更新、没超最长时长"，任何一条不满足就撤窗口；服务端崩溃/被杀也会在几秒内自动解锁。
const PRIVACY_STOP = join(HERE, 'privacy.stop');
const PRIVACY_BEAT = join(HERE, 'privacy.beat');
const privacy = { proc: null, owner: '', image: '', startedAt: 0, lastBeat: 0, lockInput: true };
// 启动时清掉上一代残留（崩溃/被杀可能留下 stop/beat/hook 文件；留着会让新遮罩立刻退出或误报）
for (const f of ['privacy.stop', 'privacy.beat', 'privacy.hook']) { try { unlinkSync(join(HERE, f)); } catch { } }

function privacyPicPath() {
  for (const ext of ['png', 'jpg', 'webp']) {
    const p = join(HERE, 'privacy-lock.' + ext);
    if (fileExists(p)) return p;
  }
  return '';
}
function privacyJson() {
  let hot = false;
  try { hot = readFileSync(join(HERE, 'privacy.hook'), 'utf8').trim() === 'ok'; } catch { hot = false; }
  return {
    active: !!privacy.proc,
    owner: privacy.owner || '',
    since: privacy.startedAt || 0,
    hasImage: !!privacyPicPath(),
    hotkeys: !!privacy.proc && hot,
    lockInput: !!privacy.lockInput,
    imageUrl: '/privacy/image'
  };
}
function privacyStop(reason) {
  const proc = privacy.proc;
  privacy.proc = null;
  privacy.owner = '';
  privacy.startedAt = 0;
  privacy.lastBeat = 0;
  try { writeFileSync(PRIVACY_STOP, '1'); } catch { }
  try { unlinkSync(join(HERE, 'privacy.hook')); } catch { }
  setTimeout(() => {
    try { if (proc) proc.kill(); } catch { }
    try { unlinkSync(PRIVACY_STOP); } catch { }
    try { unlinkSync(PRIVACY_BEAT); } catch { }
  }, 1000);
  console.log('privacy: 关闭（' + reason + '）');
}
function privacyStart(sid, lockInput) {
  if (privacy.proc) {
    return { ok: true, active: true, owner: privacy.owner === sid, note: '另一台设备已开启防窥屏（以先开的为准）' };
  }
  const script = join(HERE, 'lock-screen.ps1');
  if (!fileExists(script)) return { ok: false, error: 'lock-screen.ps1 缺失' };
  privacy.image = privacyPicPath();
  privacy.lockInput = lockInput !== false;      // 默认锁键盘鼠标；设置里可关
  try { unlinkSync(PRIVACY_STOP); } catch { }
  try { writeFileSync(PRIVACY_BEAT, String(Date.now())); } catch { }
  const hookFile = join(HERE, 'privacy.hook');
  try { unlinkSync(hookFile); } catch { }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-StopFile', PRIVACY_STOP, '-BeatFile', PRIVACY_BEAT, '-ParentPid', String(process.pid), '-MaxMinutes', '480',
    '-BlockHotkeys', '-HookFile', hookFile];
  if (privacy.lockInput) args.push('-LockInput');
  if (privacy.image) args.push('-ImagePath', privacy.image);
  let child = null;
  try {
    child = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  privacy.proc = child;
  privacy.owner = sid;
  privacy.startedAt = Date.now();
  privacy.lastBeat = Date.now();
  child.on('exit', (code) => {
    if (privacy.proc === child) {
      privacy.proc = null; privacy.owner = ''; privacy.startedAt = 0; privacy.lastBeat = 0;
      console.log('privacy: 锁屏窗口退出 code=' + code);
    }
    try { unlinkSync(PRIVACY_STOP); } catch { }
    try { unlinkSync(PRIVACY_BEAT); } catch { }
    try { unlinkSync(join(HERE, 'privacy.hook')); } catch { }
  });
  console.log('privacy: 开启（owner=' + sid + '，图=' + (privacy.image || '纯黑') + '，快捷键拦截）');
  return { ok: true, active: true, owner: true };
}
// 心跳：3 秒刷一次 beat 文件（窗口靠它判断服务端还活着）；owner 120 秒没心跳自动关
setInterval(() => {
  if (!privacy.proc) return;
  try { writeFileSync(PRIVACY_BEAT, String(Date.now())); } catch { }
  if (privacy.lastBeat && Date.now() - privacy.lastBeat > 120000) privacyStop('控制端已断开');
}, 3000).unref();

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0, done = false;
    req.on('data', (c) => { n += c.length; if (n > limit) { done = true; try { req.destroy(); } catch { } resolve(Buffer.alloc(0)); return; } chunks.push(c); });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!done) resolve(Buffer.alloc(0)); });
  });
}
function privacyDetectImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

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
    try { socket.setNoDelay(true); } catch { }
    h264Wss.handleUpgrade(req, socket, head, (ws) => { try { ws._socket.setNoDelay(true); } catch { } h264Wss.emit('connection', ws, req); });
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
        h264.stopTimer = setTimeout(() => { if (h264.clients.size === 0 && !rtc264Alive()) h264Stop(); }, 15000);
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
// ---- 高性能模式初始化/修复（已装 Sunshine 但没凭据时用；会弹 UAC）----------------
let sunshineInitJob = { phase: 'idle', error: '', startedAt: 0 };
async function runSunshineInit() {
  if (sunshineInitJob.phase === 'running') return sunshineInitJob;
  sunshineInitJob = { phase: 'running', error: '', startedAt: Date.now() };
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const integ = join(HERE, 'sunshine-integration.ps1');
  if (!fileExists(integ)) { sunshineInitJob = { phase: 'error', error: '缺少 sunshine-integration.ps1', startedAt: Date.now() }; return sunshineInitJob; }
  const wrap = join(HERE, 'sunshine-init-wrap.ps1');
  const runner = join(HERE, 'sunshine-init-run.ps1');
  const log = join(HERE, 'sunshine-init.log');
  const tailLog = () => { try { const s = readFileSync(log, 'utf8'); return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-4).join(' | '); } catch { return ''; } };
  try { unlinkSync(log); } catch { }
  try {
    writeFileSync(wrap, [
      '$ErrorActionPreference = "Continue"',
      '& \'' + integ + '\' -Action install -AppDir \'' + HERE + '\' *> \'' + log + '\'',
      'exit $LASTEXITCODE'
    ].join('\r\n'), 'utf8');
    writeFileSync(runner, [
      '$ErrorActionPreference = "Continue"',
      'Start-Process powershell -Verb RunAs -Wait -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",\'' + wrap + '\') | Out-Null'
    ].join('\r\n'), 'utf8');
  } catch (e) {
    sunshineInitJob = { phase: 'error', error: String(e.message || e), startedAt: Date.now() };
    return sunshineInitJob;
  }
  await new Promise((resolve) => {
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], { stdio: 'ignore', windowsHide: true });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  // 凭据文件出现就算完成（配置/重启那步失败不影响配对）
  for (let i = 0; i < 45; i++) {
    if (fileExists(SUNSHINE_CRED_FILE)) { sunshineInitJob = { phase: 'done', error: '', startedAt: sunshineInitJob.startedAt }; return sunshineInitJob; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const t = tailLog();
  sunshineInitJob = { phase: 'error', error: '初始化没完成' + (t ? ('：' + t) : '（可能没点管理员授权）'), log: t, startedAt: sunshineInitJob.startedAt };
  return sunshineInitJob;
}
// ---- 实验版 E1（2026-11-07）：/ws-exp -------------------------------------
// 只推"电脑上真实光标的位置和形状"，给手机端本地画一个光标用。
// 为什么需要它：采集是 ddagrab=draw_mouse=0，光标从视频里被剥掉了；手机端本来
// 只有一个跟着手指走的黄点，所以"电脑上现在光标在哪、是什么形状"完全看不到。
//
// 独立通道是刻意的：不碰 /ws-h264、/rtc、/ws-audio 里任何一行，出问题只会
// 让光标不显示，画面和输入照常。
const EXP_TICK_MS = 20;          // 2026-11-07: 30Hz -> 50Hz，光标推送更密，跟手性更好
          // 30Hz：光标本体也就 125Hz 更新，30Hz + 客户端平滑已经看不出台阶
const EXP_OCR_PORT = 8777;       // 常驻 Python OCR 服务（app/exp/ocr/ocr_server.py）

// E2：OCR 服务按需自动拉起 —— 用户不需要手动开一个黑窗口。
// 先探测端口；不通就 detached spawn（本进程重启也不会带走它，下次探测到已就绪直接复用）。
let ocrProc = null;
let ocrPending = null;
let ocrFailedAt = 0;

async function ocrPing(ms = 800) {
  try {
    const r = await fetch('http://127.0.0.1:' + EXP_OCR_PORT + '/health', { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

function findPython() {
  // 1) product.config.json 的 runtime.pythonPath 明确写了就用它
  try {
    const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const p = c && c.runtime && c.runtime.pythonPath;
    if (p && existsSync(p)) return [p];
  } catch { }
  // 2) 默认用 py 启动器锁 3.12 —— 3.14 的 onnxruntime wheel 支持不稳，别用
  return ['py', '-3.12'];
}

async function ensureOcr() {
  if (await ocrPing()) return true;
  if (Date.now() - ocrFailedAt < 20000) return false;    // 刚失败过，别每次请求都重试
  if (ocrPending) { try { await ocrPending; } catch { } return ocrPing(); }
  ocrPending = (async () => {
    const script = join(HERE, 'exp', 'ocr', 'ocr_server.py');
    if (!existsSync(script)) throw new Error('找不到 ' + script);
    const cmd = findPython();
    const logPath = join(HERE, 'exp-ocr.log');
    let fd = -1;
    try {
      fd = openSync(logPath, 'a');
      ocrProc = spawn(cmd[0], cmd.slice(1).concat([script, String(EXP_OCR_PORT)]), {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        cwd: HERE,
      });
      ocrProc.unref();
    } catch (e) {
      throw new Error('拉起 OCR 失败: ' + (e && e.message || e));
    } finally {
      if (fd >= 0) { try { closeSync(fd); } catch { } }
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await ocrPing()) { console.log('exp: OCR 服务已就绪'); return true; }
    }
    throw new Error('等了 20 秒还没就绪，看 exp-ocr.log');
  })();
  try { return await ocrPending; }
  catch (e) { ocrFailedAt = Date.now(); console.log('exp: ' + (e && e.message || e)); return false; }
  finally { ocrPending = null; }
}

// ---- 产品配置 / 双轨（profile）------------------------------------------
// 现读现用（启动时的 productConfig 是快照，改配置不会刷新）：改完下一次握手/请求就生效。
function liveConfig() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch { return {}; }
}

// 双轨：selfuse = 我的自用版（可带实验/半成品）；release = 发布给客户的版本（不挂实验层）。
// 缺省按自用处理，保证换版本、配置残缺时不崩。
function isSelfUse() {
  const c = liveConfig();
  return !c.profile || c.profile === 'selfuse';
}

// 正式功能开关（features.*）。realCursor 缺省开，只有显式 false 才关。
function featureOn(name) {
  const f = (liveConfig().features) || {};
  if (name === 'realCursor') return f.realCursor !== false;
  return f[name] === true;
}

// 实验开关（experiments.*）。发布版一律当空：半成品不许跟客户。
function expConfig() {
  if (!isSelfUse()) return {};
  return (liveConfig().experiments) || {};
}

function attachExpWs(server, key) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  let timer = null;
  let lastSent = '';

  const tick = () => {
    if (!clients.size) return;
    let c;
    try { if (input.requestCursorImage) input.requestCursorImage(); c = input.cursor(); } catch { return; }
    if (!c || !(c.x >= 0)) return;
    // injector 断了/没回过：别把上一个位置一直画在那里
    if (!c.at || Date.now() - c.at > 1500) return;
    const msg = JSON.stringify({ t: 'cur', x: c.x, y: c.y, s: c.s || 'arrow', v: c.v === 0 ? 0 : 1, cw: c.cw || 0, ch: c.ch || 0, chx: c.chx || 0, chy: c.chy || 0, img: c.img || '' });
    if (msg === lastSent) return;                 // 屏幕没动：不占带宽
    lastSent = msg;
    for (const ws of clients) { try { if (ws.readyState === 1) ws.send(msg); } catch { } }
  };

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { try { socket.destroy(); } catch { } return; }
    if (url.pathname !== '/ws-exp') return;
    // 真光标是**正式功能**（features.realCursor，默认开），不再跟 experiments 绑在一起：
    // 发布版（profile=release）关掉实验层之后，客户的真实光标照样能用。
    if (!featureOn('realCursor')) {
      try { socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    if (!sourceAllowed(req) || !authorized(req, url)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    try { socket.setNoDelay(true); } catch { }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    lastSent = '';                                // 新连接的客户端要能立刻拿到当前状态
    if (!timer) { timer = setInterval(tick, EXP_TICK_MS); if (timer.unref) timer.unref(); tick(); }
    ws.on('close', () => {
      clients.delete(ws);
      if (!clients.size && timer) { clearInterval(timer); timer = null; lastSent = ''; }
    });
    ws.on('error', () => { });
  });
}

function attachAudioWs(server, key) {  server.on('upgrade', (req, socket, head) => {
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
      // /rtc 由 rtc.mjs 处理，/ws-h264 由 attachH264Ws 处理，/ws-exp 由 attachExpWs 处理；
      // 其余路径在这里销毁。
      if (url.pathname !== '/rtc' && url.pathname !== '/ws-h264' && url.pathname !== '/ws-exp') { try { socket.destroy(); } catch { } }
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
      ws.send(JSON.stringify({ type: 'audio', sampleRate: 48000, channels: 2, bits: 16, chunkMs: 10 }));
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
  // 2026-11-07 修（用户报"一直转圈"）：清晰模式的两种观众以前**没算进 viewers**——
  //   · MSE/H.264 流（/h264-stream → h264.clients）
  //   · Pion 侧车的会话（RTC264 → rtc264Status.sessions）
  // 后果有两层：①capture.exe 以为没人看，自己停抓，侧车/管道就没帧；
  // ②监督进程的"10 秒没帧"看门狗只在 viewers>0 时才判，所以卡死永远不自愈。
  const crisp = (h264.clients ? h264.clients.size : 0) + (rtc264Status.sessions || 0);
  // 2026-11-07：清晰模式的音频走"纯音频"的那条 rtc 连接，它是同一位观众的伴生通道，
  // 不能再算一个观众（否则 /health 显示 viewers=2，排查时看着像幽灵连接）。
  const rst = rtc.stats();
  const rpVideo = Math.max(0, (rst.peers || 0) - (rst.audioOnly || 0));
  if (crisp > 0) return crisp + rpVideo;
  if (streams > 0) return streams + rpVideo;
  if (rpVideo > 0) return rpVideo;
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
  const ra = String((req.socket && req.socket.remoteAddress) || ').replace(/^::ffff:/, ');
  if (ra === '127.0.0.1' || ra === '::1') return true;
  // 离线模式：允许同一局域网/电脑热点里的设备（仍需带访问密钥）
  if (ALLOW_LAN && LAN_V4.test(ra)) return true;
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ra);
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
    + '<li>回到那台电脑，打开桌面上的「轻屏」文件夹；</li>'
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
// 读 tailscale serve 里 443 -> 本机画面端口 的映射（用于"远程 HTTPS 入口"状态展示）
let _httpsServeCache = { at: 0, url: '' };
async function tailscaleHttpsServeUrl(port) {
  if (Date.now() - _httpsServeCache.at < 10000) return _httpsServeCache.url;
  let url = '';
  try {
    const exe = resolveTailscaleExe();
    if (exe) {
      const r = await new Promise((resolve) => {
        const child = spawn(exe, ['serve', 'status'], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.on('exit', () => resolve(out));
        child.on('error', () => resolve(''));
        setTimeout(() => { try { child.kill(); } catch { } resolve(out); }, 6000);
      });
      // serve status 的格式是两行：https://<机器名> 下面再缩进写 "|-- / proxy http://127.0.0.1:8660"
      const lines = String(r || '').split(/\r?\n/);
      let pending = '';
      for (const ln of lines) {
        const m = ln.match(/https:\/\/[^\s]+/);
        if (m) { pending = m[0]; continue; }
        if (pending && ln.indexOf('127.0.0.1:' + port) >= 0) { url = pending; break; }
      }
    }
  } catch { }
  _httpsServeCache = { at: Date.now(), url };
  return url;
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
const STAGING_DIR = join(UPLOAD_DIR, '.staging');   // 并行分片上传的暂存区（用完即删）
// 启动时清理超过 7 天的残留分片会话（20GB 级上传中断会占很大空间）
try {
  for (const d of readdirSync(STAGING_DIR)) {
    const dir = join(STAGING_DIR, d);
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { }
    const age = Date.now() - Number((meta && meta.created) || 0);
    if (!meta || age > 7 * 86400000) { try { rmSync(dir, { recursive: true, force: true }); } catch { } }
  }
} catch { }
const UPLOAD_MAX = 20 * 1024 * 1024 * 1024;   // 大文件：上限 20GB（局域网直传，速度就是 Wi-Fi 上限）
// USB 网络共享（RNDIS）的网卡 IP：手机 USB 连电脑后通常会出现一个新网卡，速度远高于 Wi-Fi/热点。
// 用 Get-NetAdapter 的 InterfaceDescription 判断（os.networkInterfaces 只给"以太网 N"这种别名），缓存 60 秒。
let _usbIpsCache = { at: 0, ips: [] };
let _usbRefreshing = false;
// 异步刷新（execFile 不阻塞事件循环）：HTTP 请求只读缓存，避免 PowerShell 冷启动卡住整台服务
function refreshUsbLanIps(cb) {
  if (_usbRefreshing) { if (cb) cb(); return; }
  _usbRefreshing = true;
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cmd = "Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'RNDIS|Remote NDIS|USB' } | ForEach-Object { Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress } }";
  execFile(psExe, ['-NoProfile', '-Command', cmd], { timeout: 8000, windowsHide: true }, (err, out) => {
    _usbRefreshing = false;
    let ips = [];
    if (!err) ips = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    _usbIpsCache = { at: Date.now(), ips: ips };
    if (cb) cb();
  });
}
function usbLanIps() {
  const now = Date.now();
  if (now - _usbIpsCache.at > 60000) refreshUsbLanIps();
  return _usbIpsCache.ips;
}
// 哪些局域网端口被"产品相关的 Block 规则"挡住（只读查询，不需要管理员）：
// 旧安装器留下的 "DSH phone access : block lan 8660" 会让 8660 超时，页面要自动优先用没被挡的端口。
let _blockedPorts = { at: 0, ports: [] };
let _blockedRefreshing = false;
function refreshBlockedPorts(cb) {
  if (_blockedRefreshing) { if (cb) cb(); return; }
  _blockedRefreshing = true;
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cmd = "Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.DisplayName -match 'phone ?access|轻屏' } | ForEach-Object { $pf = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue; if ($pf) { ($pf.LocalPort -join ',') } }";
  execFile(psExe, ['-NoProfile', '-Command', cmd], { timeout: 8000, windowsHide: true }, (err, out) => {
    _blockedRefreshing = false;
    let ports = [];
    if (!err) {
      ports = String(out || '').split(/[\s,]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
      ports = [...new Set(ports)];
    }
    _blockedPorts = { at: Date.now(), ports: ports };
    if (cb) cb();
  });
}
function blockedPortsNow() {
  if (Date.now() - _blockedPorts.at > 60000) refreshBlockedPorts();
  return _blockedPorts.ports;
}
setTimeout(() => { try { refreshBlockedPorts(); } catch { } }, 5000);

// 真实可用的局域网 IPv4：只认"网卡 Up"的接口（Windows 在网卡断开后仍会保留 IP 配置，
// os.networkInterfaces() 也可能继续返回旧地址——实测拔掉 Wi-Fi/关掉 USB 共享后仍显示旧 IP，
// 面板就会给客户一个连不上的死地址）。用 Get-NetIPAddress + Get-NetAdapter 状态过滤，缓存 5 秒。
let _lanIps = { at: 0, ips: [] };
let _lanRefreshing = false;
function refreshLanIps(cb) {
  if (_lanRefreshing) { if (cb) cb(); return; }
  _lanRefreshing = true;
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cmd = "Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'VMware|VirtualBox|Hyper-V|Loopback|Tailscale|WSL|Bluetooth' } | ForEach-Object { Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.)' } | ForEach-Object { $_.IPAddress } }";
  execFile(psExe, ['-NoProfile', '-Command', cmd], { timeout: 8000, windowsHide: true }, (err, out) => {
    _lanRefreshing = false;
    let ips = [];
    if (!err) ips = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    _lanIps = { at: Date.now(), ips: [...new Set(ips)] };
    if (cb) cb();
  });
}
function lanIpsNow() {
  if (Date.now() - _lanIps.at > 5000) refreshLanIps();
  return _lanIps.ips;
}

// 启动时预热一次（手机 USB 共享一出现，下一次 /offline-info 就能带上）
setTimeout(() => { try { refreshUsbLanIps(); } catch { } }, 4000);

// 允许浏览/下载的根目录（桌面/下载/文档/图片）：不开放整个用户目录，避免密钥泄露时被读走 .ssh 等敏感文件
function fileRoots() {
  const home = process.env.USERPROFILE || '';
  const list = [desktopDir(), join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Pictures')];
  return list.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}
function pathUnderRoots(real) {
  const rl = String(real).toLowerCase();
  return fileRoots().some((r) => {
    const a = resolve(r).toLowerCase();
    return rl === a || rl.startsWith(a + '\\');
  });
}

// 真实桌面路径（可能被重定向到 D:\...）；reg.exe 输出是系统代码页，中文机按 GBK 解
let _deskCache = null;
function desktopDir() {
  if (_deskCache) return _deskCache;
  const home = process.env.USERPROFILE || '';
  let desk = join(home, 'Desktop');
  try {
    const raw = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'], { timeout: 3000, windowsHide: true });
    let txt = '';
    try { txt = new TextDecoder('gbk').decode(raw); } catch { txt = Buffer.from(raw).toString('utf8'); }
    const m = txt.match(/Desktop\s+REG_\w+\s+(.+)/);
    if (m && m[1]) desk = String(m[1]).trim().replace(/%USERPROFILE%/i, home);
  } catch { }
  _deskCache = desk;
  return desk;
}   // 大文件：上限 20GB（局域网直传，速度就是 Wi-Fi 上限）
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
    // 2026-11-07 修：调用方可能传对象，也可能传已序列化的 JSON 字符串；
    // 原来一律 JSON.stringify，字符串会被二次转义 → Sunshine 收到非法 JSON（400）。
    if (body) { try { req.write(typeof body === 'string' ? body : JSON.stringify(body)); } catch { } }
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
    return { ok: false, state: 'no-machine-code', message: '还没读到这台电脑的机器码。请等几秒（程序定期重算）或重启一次「轻屏」后再试。' };
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
// 2026-11-06 免费化：并发观看不再限制（填 0 或留空 = 不限台数）
const FREE_MAX_VIEWERS = (Number(cfgFreemium.freeMaxViewers) > 0) ? Math.round(Number(cfgFreemium.freeMaxViewers)) : 0;
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

async function handler(req, res) {
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
  // 离线模式：允许同一局域网/电脑热点里的设备（仍需带访问密钥）
  const fromLanOffline = ALLOW_LAN && LAN_V4.test(ra);
  if (ra !== '127.0.0.1' && ra !== '::1' && !fromTailnet && !fromLanOffline) {
    try {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('只接受 Tailscale 访问：请先在手机上打开 Tailscale 并连接，再用电脑上显示的地址打开；没有网络时打开设置里的「离线模式」。');
    } catch { }
    return;
  }

  // 收款码等品牌图片：未授权客户要靠它找到购买方式，必须公开
  const isBrandingAsset = url.pathname.startsWith('/branding/') && /\.(png|jpe?g)$/i.test(url.pathname);
  // 明确公开的少量资源（不含任何画面/控制/许可证数据）
  const PUBLIC_PATHS = new Set(['/health', '/sw.js', '/ca.crt', '/icon-192.png', '/icon-512.png']);
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
    res.end((frame ? 'ok' : 'no-frame') + ' viewers=' + wanted() + ' s264=' + (rtc264Status.sessions || 0) + ' source=' + (pipeOk ? 'pipe' : 'file')
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
        try {
          const cfgNow = (() => { try { return JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
          const screenPort = Number(cfgNow.ports && cfgNow.ports.screen) || 8660;
          sum.httpsUrl = await tailscaleHttpsServeUrl(screenPort);
          sum.httpsHint = sum.httpsUrl ? '' : '还没有开启远程 HTTPS 入口。点下面「一键开启远程 HTTPS」；如果提示没启用证书，去 Tailscale 后台 → DNS → HTTPS Certificates 点启用，再回来点一次。';
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(sum));
        } catch { }
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

  // 一键开启 tailscale serve 的 https 入口（复用 https-setup.ps1 的探测与超时保护）
  if (url.pathname === '/tailscale-https' && req.method === 'POST') {
    const reply = (code, obj) => {
      try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { }
    };
    const exe = resolveTailscaleExe();
    if (!exe) return reply(200, { ok: false, note: '这台电脑没装 Tailscale（或没在运行）。先装好、登录后再点。' });
    const script = join(HERE, 'https-setup.ps1');
    if (!fileExists(script)) return reply(200, { ok: false, note: '安装目录缺 https-setup.ps1' });
    const cfgNow = (() => { try { return JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
    const screenPort = Number(cfgNow.ports && cfgNow.ports.screen) || 8660;
    const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const psCmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; . "' + script + '"; $r = Enable-HttpsServeForScreen -TailscaleExe "' + exe + '" -ScreenPort ' + screenPort + ' -TimeoutSec 40; $r | ConvertTo-Json -Compress';
    try {
      const out = execFileSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { encoding: 'utf8', timeout: 70000, windowsHide: true });
      let j = null;
      try { j = JSON.parse(String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch { }
      _httpsServeCache = { at: 0, url: '' };
      return reply(200, { ok: !!(j && j.Ok), note: (j && j.Note) || '', url: (j && j.Url) || '' });
    } catch (e) {
      return reply(200, { ok: false, note: '开启失败：' + ((e && e.message) || e) });
    }
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
    const __all = listUploads().slice().sort((x, y) => (y.at || 0) - (x.at || 0));
     return freply(200, { ok: true, dir: UPLOAD_DIR, maxBytes: UPLOAD_MAX, files: __all.slice(0, 5), total: __all.length });
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
    const part = dest + '.part';
    let ws = null;
    try { ws = createWriteStream(part); } catch (e) {
      return freply(500, { ok: false, message: '建文件失败：' + ((e && e.message) || e) });
    }
    let got = 0;
    let done = false;
    const fail = (code, message) => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch { }
      try { unlinkSync(part); } catch { }
      freply(code, { ok: false, message: message });
    };
    ws.on('error', (e) => fail(500, '写文件失败：' + ((e && e.message) || e)));
    req.on('data', (c) => {
      got += c.length;
      if (got > UPLOAD_MAX) { fail(413, '文件太大（上限 20GB）'); try { req.destroy(); } catch { } }
    });
    req.on('aborted', () => fail(400, '上传被中断（网络断了？）'));
    req.on('error', () => fail(500, '上传出错'));
    req.pipe(ws);
    ws.on('finish', () => {
      if (done) return;
      if (!got) { done = true; try { unlinkSync(part); } catch { } return freply(400, { ok: false, message: '空文件' }); }
      try { renameSync(part, dest); } catch (e) {
        done = true;
        try { unlinkSync(part); } catch { }
        return freply(500, { ok: false, message: '保存失败：' + ((e && e.message) || e) });
      }
      done = true;
      const saved = dest.slice(dest.lastIndexOf('\\') + 1);
      console.log('screen-server: 收到文件 ' + saved + '（' + got + ' B）');
      freply(200, { ok: true, name: saved, size: got, dir: UPLOAD_DIR, message: '已收到：' + saved + '（' + (got / 1048576).toFixed(1) + ' MB）' });
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

  // ---- 并行分片上传（2026-11-06）：100GB 级大文件，多连接并发吃满 Wi-Fi -------------
  // POST /upload/init   {name,size}          -> {id, chunkSize, parts}（预分配文件，写盘按偏移）
  // POST /upload/part?id=&index=              -> 分片原始字节（按 index*chunkSize 偏移写入）
  // POST /upload/done   {id}                  -> 校验分片齐全 -> 改名到「下载\PhoneAccess」
  // GET  /upload/status?id=                   -> {done:[indexes], parts, chunkSize}（断点续传用）
  // POST /upload/abort  {id}                  -> 清理暂存
  const STAGING_DIR = join(UPLOAD_DIR, '.staging');
  const UP_CHUNK = 32 * 1024 * 1024;
  if (url.pathname === '/upload/init' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { }
      const name = safeUploadName(j.name);
      const size = Number(j.size);
      if (!name) return jr(400, { ok: false, message: '文件名不合法' });
      if (!Number.isFinite(size) || size <= 0) return jr(400, { ok: false, message: '文件大小不合法' });
      if (size > UPLOAD_MAX) return jr(413, { ok: false, message: '文件太大（上限 20GB）' });
      try { mkdirSync(STAGING_DIR, { recursive: true }); } catch { }
      try {
        const sf = statfsSync(UPLOAD_DIR);
        const free = Number(sf.bavail) * Number(sf.bsize);
        if (free > 0 && free < size + 512 * 1024 * 1024) return jr(507, { ok: false, message: '电脑硬盘空间不够（需要 ' + (size / 1073741824).toFixed(1) + 'GB）' });
      } catch { }
      const id = randomBytes(8).toString('hex');
      const dir = join(STAGING_DIR, id);
      try {
        mkdirSync(dir, { recursive: true });
        const fd = openSync(join(dir, 'data'), 'w');
        closeSync(fd);
        const fd2 = openSync(join(dir, 'data'), 'r+');
        ftruncateSync(fd2, size);
        closeSync(fd2);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: name, size: size, chunkSize: UP_CHUNK, created: Date.now() }));
      } catch (e) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
        return jr(500, { ok: false, message: '建暂存失败：' + ((e && e.message) || e) });
      }
      const parts = Math.ceil(size / UP_CHUNK);
      console.log('upload: init ' + name + ' ' + size + 'B parts=' + parts + ' id=' + id);
      jr(200, { ok: true, id: id, name: name, size: size, chunkSize: UP_CHUNK, parts: parts });
    });
    return;
  }
  if (url.pathname === '/upload/part' && req.method === 'POST') {
    const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
    const id = String(url.searchParams.get('id') || '');
    const index = Number(url.searchParams.get('index'));
    if (!/^[a-f0-9]{16}$/.test(id) || !Number.isInteger(index) || index < 0) return jr(400, { ok: false, message: '参数不合法' });
    const dir = join(STAGING_DIR, id);
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { }
    if (!meta) return jr(404, { ok: false, message: '上传会话不存在（重新开始）' });
    const offset = index * meta.chunkSize;
    if (offset >= meta.size) return jr(400, { ok: false, message: '分片越界' });
    const maxLen = Math.min(meta.chunkSize, meta.size - offset);
    let ws = null;
    try { ws = createWriteStream(join(dir, 'data'), { flags: 'r+', start: offset }); } catch (e) { return jr(500, { ok: false, message: '打开暂存失败' }); }
    let got = 0;
    let done = false;
    const fail = (code, message) => {
      if (done) return; done = true;
      try { ws.destroy(); } catch { }
      jr(code, { ok: false, message: message });
    };
    req.on('data', (c) => { got += c.length; if (got > maxLen + 1024) { fail(413, '分片太大'); try { req.destroy(); } catch { } } });
    req.on('error', () => fail(500, '分片传输出错'));
    ws.on('error', () => fail(500, '写分片失败'));
    req.pipe(ws);
    ws.on('finish', () => {
      if (done) return;
      if (got !== maxLen) return fail(400, '分片大小不对（' + got + '/' + maxLen + '）');
      done = true;
      try { writeFileSync(join(dir, 'done-' + index), '1'); } catch { }
      jr(200, { ok: true, index: index, size: got });
    });
    return;
  }
  if (url.pathname === '/upload/status' && req.method === 'GET') {
    const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
    const id = String(url.searchParams.get('id') || '');
    if (!/^[a-f0-9]{16}$/.test(id)) return jr(400, { ok: false, message: '参数不合法' });
    const dir = join(STAGING_DIR, id);
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { }
    if (!meta) return jr(404, { ok: false, message: '没有这个上传会话' });
    const parts = Math.ceil(meta.size / meta.chunkSize);
    const doneIdx = [];
    for (let i = 0; i < parts; i++) { try { if (statSync(join(dir, 'done-' + i)).isFile()) doneIdx.push(i); } catch { } }
    return jr(200, { ok: true, id: id, name: meta.name, size: meta.size, chunkSize: meta.chunkSize, parts: parts, done: doneIdx });
  }
  if (url.pathname === '/upload/done' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { }
      const id = String(j.id || '');
      if (!/^[a-f0-9]{16}$/.test(id)) return jr(400, { ok: false, message: '参数不合法' });
      const dir = join(STAGING_DIR, id);
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { }
      if (!meta) return jr(404, { ok: false, message: '上传会话不存在' });
      const parts = Math.ceil(meta.size / meta.chunkSize);
      for (let i = 0; i < parts; i++) {
        try { if (!statSync(join(dir, 'done-' + i)).isFile()) return jr(400, { ok: false, message: '还缺分片 ' + i + '（刷新页面可断点续传）' }); } catch { return jr(400, { ok: false, message: '还缺分片 ' + i }); }
      }
      let finalPath = '';
      try { finalPath = uniqueUploadPath(meta.name); renameSync(join(dir, 'data'), finalPath); } catch (e) {
        return jr(500, { ok: false, message: '合并失败：' + ((e && e.message) || e) });
      }
      let sz = 0;
      try { sz = statSync(finalPath).size; } catch { }
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
      console.log('upload: done ' + basename(finalPath) + ' ' + sz + 'B');
      jr(200, { ok: true, name: basename(finalPath), size: sz, dir: UPLOAD_DIR, message: '已收到：' + basename(finalPath) + '（' + (sz / 1048576).toFixed(1) + ' MB）' });
    });
    return;
  }
  if (url.pathname === '/upload/abort' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { }
      const id = String(j.id || '');
      if (!/^[a-f0-9]{16}$/.test(id)) return jr(400, { ok: false, message: '参数不合法' });
      try { rmSync(join(STAGING_DIR, id), { recursive: true, force: true }); } catch { }
      return jr(200, { ok: true });
    });
    return;
  }
  // GET /upload/pending -> 未完成的分片上传清单（断点续传提示用）；顺带清掉 3 天前的残留暂存
  if (url.pathname === '/upload/pending' && req.method === 'GET') {
    const jr = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
    const TTL = 3 * 24 * 3600 * 1000;
    const items = [];
    let ids = [];
    try { ids = readdirSync(STAGING_DIR); } catch { ids = []; }
    for (const id of ids) {
      if (!/^[a-f0-9]{16}$/.test(id)) continue;
      const dir = join(STAGING_DIR, id);
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { continue; }
      const size = Number(meta.size) || 0;
      const cs = Number(meta.chunkSize) || UP_CHUNK;
      if (size <= 0) continue;
      const created = Number(meta.created) || 0;
      let age = created ? Date.now() - created : 0;
      if (!Number.isFinite(age) || age < 0) age = 0;
      if (created && age > TTL) {
        try { rmSync(dir, { recursive: true, force: true }); console.log('upload: 清理过期暂存 ' + id); } catch { }
        continue;
      }
      const parts = Math.ceil(size / cs);
      let doneCount = 0;
      for (let i = 0; i < parts; i++) { try { if (statSync(join(dir, 'done-' + i)).isFile()) doneCount++; } catch { } }
      if (!doneCount) {
        // 一片都没传成 → 没有可续的内容；超过 1 小时就清掉（取消/断网留下的空壳会预占文件大小）
        if (!created || age > 3600 * 1000) {
          try { rmSync(dir, { recursive: true, force: true }); console.log('upload: 清理空壳暂存 ' + id); } catch { }
        }
        continue;
      }
      items.push({
        id: id, name: String(meta.name || '未命名'), size: size, chunkSize: cs, parts: parts,
        doneCount: doneCount, pct: Math.min(100, Math.floor(doneCount * 100 / parts)),
        created: created, ageMs: age
      });
    }
    items.sort((a, b) => b.created - a.created);
    return jr(200, { ok: true, items: items.slice(0, 8), maxBytes: UPLOAD_MAX });
  }

  // ---- 大文件传输（2026-11-06）：浏览电脑文件、下载到手机 ---------------------
  // GET /browse?dir=<绝对路径>：只在用户主目录（USERPROFILE）以下浏览；不给 dir 时列常用目录
  // GET /download?path=<绝对路径>：流式下载（同样只允许用户主目录以下）
  if (url.pathname === '/browse' && req.method === 'GET') {
    const jr = (code, obj) => {
      try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { }
    };
    const home = process.env.USERPROFILE || '';
    const desk = desktopDir();
    const rootNames = [desk, join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Pictures')];
    const roots = rootNames.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
    const dir = String(url.searchParams.get('dir') || '').trim();
    if (!dir) {
      return jr(200, { ok: true, dir: '', home: home, items: roots.map((p) => ({ name: basename(p), path: p, dir: true })) });
    }
    let real = '';
    try { real = resolve(dir); } catch { return jr(400, { ok: false, message: '路径不合法' }); }
    if (!pathUnderRoots(real)) return jr(403, { ok: false, message: '只能浏览「桌面/下载/文档/图片」里的文件' });
    let ents = [];
    try { ents = readdirSync(real, { withFileTypes: true }); } catch (e) { return jr(404, { ok: false, message: '打不开这个文件夹' }); }
    const items = [];
    for (const ent of ents) {
      if (items.length >= 500) break;
      const p = join(real, ent.name);
      if (ent.isDirectory()) { items.push({ name: ent.name, path: p, dir: true }); continue; }
      let st = null;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      items.push({ name: ent.name, path: p, dir: false, size: st.size, at: Math.round(st.mtimeMs) });
    }
    items.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
    const isRoot = roots.some((r) => resolve(r).toLowerCase() === real.toLowerCase());
    return jr(200, { ok: true, dir: real, parent: (isRoot ? null : dirname(real)), items: items });
  }
  if (url.pathname === '/download' && req.method === 'GET') {
    const raw = String(url.searchParams.get('path') || '');
    let real = '';
    try { real = resolve(raw); } catch { real = ''; }
    if (!real || !pathUnderRoots(real)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('只能下载「桌面/下载/文档/图片」里的文件'); return;
    }
    let st = null;
    try { st = statSync(real); } catch { }
    if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('文件不存在'); return; }
    const nm = basename(real);
    try {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(st.size),
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(nm),
        'cache-control': 'no-store'
      });
      createReadStream(real).pipe(res);
    } catch (e) { try { res.end(); } catch { } }
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
          lanIps: privateIps(),
          tailnetIp: (() => { try { const ifs = os.networkInterfaces(); for (const n of Object.keys(ifs)) { if (!/tailscale/i.test(n)) continue; for (const it of (ifs[n] || [])) { if (it && it.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(it.address)) return it.address; } } } catch (e) { } return ''; })(),
          webPort: 47990,
          init: sunshineInitJob,
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
  // 高性能模式：管理页账号（只给已通过鉴权的页面；用于在手机上打开 Sunshine 管理页加游戏）
  // 高性能模式：一键初始化/修复（已安装但没凭据时；会弹 UAC）
  if (url.pathname === '/sunshine-init' && req.method === 'POST') {
    runSunshineInit().catch(() => { });
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, job: sunshineInitJob }));
    } catch { }
    return;
  }
  if (url.pathname === '/sunshine-creds') {
    const c = readSunshineCreds();
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: !!c, username: c ? c.username : '', password: c ? c.password : '', host: sunshineHost() }));
    } catch { }
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
      return sreply(200, { ok: false, error: '高性能模式还没初始化（缺凭据文件）。重启一次「轻屏」或重新运行安装包。' });
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
      return list.find((a) => /\.exe$/i.test(String((a && a.name) || '')) && /setup|install|安装|轻屏/i.test(String((a && a.name) || '')))
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
            const gAssets = (best.rel && best.rel.assets) || [];
            const gParts = gAssets.filter((a) => /\.part\d+$/i.test(String((a && a.name) || '')));
            if (!gExe && !gParts.length) throw new Error('最新发行版里没有安装包');
            const gBody = String((best.rel && best.rel.body) || '');
            // 发版约定：发行版正文里写 SHA256：xxxx；有它就能在下载后校验（Gitee API 不给 asset digest）
            const gSha = (gBody.match(/SHA256[^\r\n]{0,12}?([0-9a-fA-F]{64})/i) || [])[1] || '';
            j = {
              version: best.version,
              notes: gBody.length > 900 ? (gBody.slice(0, 900) + '…') : gBody,
              url: String((gExe && gExe.browser_download_url) || ''),
              sha256: gSha.toLowerCase(),
              page: 'https://gitee.com/' + gt.owner + '/' + gt.repo + '/releases/tag/v' + best.version,
              split: !gExe && gParts.length > 0,
              splitParts: (!gExe && gParts.length) ? gParts.map((a) => ({ name: a.name, url: a.browser_download_url })) : []
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
          const exe = assets.find((a) => /\.exe$/i.test(String((a && a.name) || '')) && /setup|install|安装|轻屏/i.test(String((a && a.name) || '')))
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
          // 2026-11-06 修正：资产名不能写死（改成 LightScreen-Setup 后，原来的 PhoneAccess-Setup 备用链接直接 404）。
          // 做法：把 Gitee 资产名里的版本号换成最新版本号，其余后缀（-release.exe 等）原样保留：
          //   LightScreen-Setup-v1.0.16-release.exe  --(latest=1.0.17)-->  LightScreen-Setup-v1.0.17-release.exe
          const giteeAsset = (jUrl.split('/').pop() || '').split('?')[0];
          const ghAssetName = giteeAsset
            ? giteeAsset.replace(/(^|[^0-9])v?\d+\.\d+\.\d+/i, function (m0, p1) { return p1 + 'v' + latest; })
            : ('LightScreen-Setup-v' + latest + '.exe');
          fallbackUrl = (gh && latest && ghAssetName)
            ? ('https://github.com/' + gh + '/releases/download/v' + latest + '/' + ghAssetName)
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

  if (url.pathname === '/wt-video') {
    const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="margin:0;background:#000;color:#eee;font:14px system-ui">'
      + '<video id="v" autoplay muted playsinline style="width:100vw;height:auto;display:block"></video>'
      + '<div id="s" style="position:fixed;left:8px;bottom:8px;background:rgba(0,0,0,.5);padding:4px 8px;border-radius:6px"></div>'
      + '<script>'
      + 'const H="' + 'ftYqxxytlicCFp4MsLIlWuNaGOWxXsXZbyxsc/fwxEw=' + '";'
      + 'const s=document.getElementById("s");let fps=0,fc=0,last=Date.now();'
      + 'function hb(){const b=atob(H);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}'
      + 'let dec=null,metaBuf="",metaTotal=0;const parts=new Map();'
      + 'let dg=0,out=0;const canvas=document.createElement("canvas");const ctx=canvas.getContext("2d");canvas.style.cssText="width:100vw;height:auto;display:block";document.body.appendChild(canvas);'
      + 'function startDec(m){metaTotal=m.length;metaBuf+=m;try{const j=JSON.parse(metaBuf);'
      + 'dec=new VideoDecoder({output:(f)=>{out++;if(canvas.width!==f.displayWidth){canvas.width=f.displayWidth;canvas.height=f.displayHeight;}'
      + 'ctx.drawImage(f,0,0);f.close();fc++;const n=Date.now();if(n-last>=1000){fps=fc*1000/(n-last);fc=0;last=n;s.textContent=(j.width||canvas.width)+"x"+(j.height||canvas.height)+" · "+fps.toFixed(1)+" fps";}},'
      + 'error:(e)=>{s.textContent="decode err "+e.message;}});'
      + 'const d=Uint8Array.from(atob(j.description),c=>c.charCodeAt(0));'
      + 'dec.configure({codec:j.codec,description:d,optimizeForLatency:true});s.textContent="decoder ok dg="+dg+" out="+out;}catch(e){}}'
      + '(async()=>{try{const wt=new WebTransport("https://"+location.hostname+":8444/video",{serverCertificateHashes:[{algorithm:"sha-256",value:hb()}]});'
      + 'await wt.ready;s.textContent="wt ready";const rd=wt.datagrams.readable.getReader();'
      + 'while(true){const r=await rd.read();dg++;if(r.done)break;const b=new Uint8Array(r.value);if(b.length<4)continue;'
      + 'const magic=(b[0]<<8)|b[1];'
      + 'if(magic===0xFFFF){const off=(b[2]<<8)|b[3];const txt=new TextDecoder().decode(b.subarray(4));'
      + 'if(off===0){metaBuf="";}startDec(txt);continue;}'
      + 'const id=(b[0]<<24|b[1]<<16|b[2]<<8|b[3])>>>0;const idx=(b[4]<<8)|b[5];const tot=(b[6]<<8)|b[7];const key=b[8]===1;const totalLen=(b[9]<<24|b[10]<<16|b[11]<<8|b[12])>>>0;'
      + 'let e=parts.get(id);if(!e){e={total:tot,got:0,buf:new Uint8Array(totalLen),key};parts.set(id,e);}'
      + 'const pay=b.subarray(14);if(idx*1100+pay.length>e.buf.length)continue;e.buf.set(pay,idx*1100);e.got++;'
      + 'if(e.got>=e.total){parts.delete(id);if(parts.size>30)parts.clear();'
      + 'if(dec){try{dec.decode(new EncodedVideoChunk({type:e.key?"key":"delta",timestamp:id*20,data:e.buf}));}catch(err){}}}}'
      + '}catch(e){s.textContent="wt fail "+e.message;}})();'
      + '</scr'+'ipt></body>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  if (url.pathname === '/wt-test') {
    const html = '<!doctype html><meta charset="utf-8"><body style="background:#111;color:#eee;font:16px system-ui;padding:20px">'
      + '<h3>WebTransport 测试</h3><div id="o">连接中…</div><div id="o2" style="opacity:.7;margin-top:12px"></div>'
      + '<script>'
      + 'const H="' + 'ftYqxxytlicCFp4MsLIlWuNaGOWxXsXZbyxsc/fwxEw=' + '";'
      + 'function hb(){const b=atob(H);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}'
      + '(async()=>{const o=document.getElementById("o");const url="https://"+location.hostname+":8444/wt";'
      + 'try{const wt=new WebTransport(url,{serverCertificateHashes:[{algorithm:"sha-256",value:hb()}]});await wt.ready;'
      + 'const w=wt.datagrams.writable.getWriter();await w.write(new TextEncoder().encode("hi"));'
      + 'const r=await wt.datagrams.readable.getReader().read();o.textContent="PASS 证书固定模式，回显 "+r.value.length+" 字节";'
      + '}catch(e){o.textContent="FAIL 证书固定模式: "+e.message;'
      + 'try{const wt2=new WebTransport(url);await wt2.ready;o.textContent+=" / 普通模式 OK";}catch(e2){document.getElementById("o2").textContent="普通模式也失败: "+e2.message;}}'
      + '})();'
      + '</scr'+'ipt></body>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  // ---- B 方案：Pion 侧车信令代理（同源，避免混合内容）----------------------
  // 侧车只监听 127.0.0.1；页面 /rtc264/{offer,answer,close} 一律经这里转发。
  // offer 走 POST（每条会话一个新 sid），answer/close 带 JSON body 原样透传。
  if (url.pathname === '/rtc264/offer' || url.pathname === '/rtc264/answer' || url.pathname === '/rtc264/close') {
    const targetPath = url.pathname === '/rtc264/offer' ? '/offer' : (url.pathname === '/rtc264/answer' ? '/answer' : '/close');
    if (targetPath === '/offer') {
      try { start264(); } catch { }     // 侧车没起来/挂掉时顺便拉一把
      try { h264Ensure(); } catch { }   // 页面只走 WebRTC 时也要启动编码器
      // 2026-11-07 诊断：页面会把自身版本（PA_PAGE_VER）带上来。查到 old / 空 就说明
      // 手机在用缓存里的旧页面——旧页面的信令/通道逻辑和新服务端不匹配，表现就是
      // 「流畅能用、清晰黑屏」。这里落一条日志，排障时先看它。
      try {
        const pv = String(url.searchParams.get('pv') || '');
        const ua = String(req.headers['user-agent'] || '').slice(0, 60);
        if (!pv || pv !== PAGE_VER) console.log('rtc264: 页面版本=' + (pv || '(空/旧页面)') + ' ua=' + ua + (pv && pv !== PAGE_VER ? '（与本机 ' + PAGE_VER + ' 不一致）' : ''));
      } catch { }
    }
    const chunks = [];
    let bodyLen = 0;
    req.on('data', (c) => { chunks.push(c); bodyLen += c.length; if (bodyLen > 1 << 20) req.destroy(); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const r = http.request({
        host: '127.0.0.1', port: RTC264_PORT, path: targetPath,
        method: targetPath === '/offer' ? 'POST' : (req.method || 'POST'),
        headers: { 'content-type': 'application/json', 'content-length': body.length }
      }, (resp) => {
        res.writeHead(resp.statusCode || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        resp.pipe(res);
      });
      r.on('error', () => { try { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"error":"sidecar unavailable"}'); } catch { } });
      r.setTimeout(8000, () => { try { r.destroy(); } catch { } });
      if (body.length) r.write(body);
      r.end();
    });
    return;
  }
  // ---- 防窥屏（privacy mode）------------------------------------------------
  // 规则：哪台设备先开就以它为准；别的设备再开也不会抢（只回状态）。
  // 控制端断开（120 秒没心跳）或它自己关掉 → 自动撤掉锁屏，不会把电脑锁死。
  if (url.pathname === '/privacy/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(privacyJson()));
    return;
  }
  if (url.pathname === '/privacy/on' && req.method === 'POST') {
    readBody(req, 4096).then((b) => {
      let m = {}; try { m = JSON.parse(String(b) || '{}'); } catch { }
      const sid = String(m.sid || '').slice(0, 40);
      if (!sid) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"ok":false,"error":"missing sid"}'); return; }
      const r = privacyStart(sid, m.lock !== false);
      res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(Object.assign({}, r, privacyJson())));
    });
    return;
  }
  if (url.pathname === '/privacy/off' && req.method === 'POST') {
    readBody(req, 4096).then((b) => {
      let m = {}; try { m = JSON.parse(String(b) || '{}'); } catch { }
      const sid = String(m.sid || '').slice(0, 40);
      if (privacy.proc && sid && privacy.owner && sid !== privacy.owner) {
        // 不是第一个开的那台：不能关，回状态说明
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(Object.assign({ ok: true, owner: false, note: '另一台设备开启的，以先开的为准' }, privacyJson())));
        return;
      }
      privacyStop(sid ? '控制端关闭' : '控制端关闭');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(Object.assign({ ok: true, owner: true }, privacyJson())));
    });
    return;
  }
  if (url.pathname === '/privacy/beat' && req.method === 'POST') {
    readBody(req, 4096).then((b) => {
      let m = {}; try { m = JSON.parse(String(b) || '{}'); } catch { }
      const sid = String(m.sid || '').slice(0, 40);
      if (privacy.proc && sid === privacy.owner) privacy.lastBeat = Date.now();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(privacyJson()));
    });
    return;
  }
  if (url.pathname === '/privacy/image') {
    if (req.method === 'GET') {
      const p = privacyPicPath();
      if (!p) { res.writeHead(404); res.end('no image'); return; }
      const ext = p.slice(p.lastIndexOf('.') + 1);
      const type = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
      try {
        const buf = readFileSync(p);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length });
        res.end(buf);
      } catch { try { res.writeHead(500); res.end('read fail'); } catch { } }
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 6 * 1024 * 1024).then((buf) => {
        const ext = privacyDetectImage(buf);
        if (!ext || buf.length < 64) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":false,"error":"只支持 png/jpg/webp 图片"}');
          return;
        }
        try {
          for (const e of ['png', 'jpg', 'webp']) { try { unlinkSync(join(HERE, 'privacy-lock.' + e)); } catch { } }
          writeFileSync(join(HERE, 'privacy-lock.' + ext), buf);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
          return;
        }
        privacy.image = privacyPicPath();
        // 正在显示时换图：关掉旧窗口再拉起（同一个 owner）
        const owner = privacy.owner;
        if (privacy.proc && owner) {
          privacyStop('换锁屏图');
          const lockKeep = privacy.lockInput !== false;
          setTimeout(() => { try { privacyStart(owner, lockKeep); } catch { } }, 1500);
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(Object.assign({ ok: true, bytes: buf.length }, privacyJson())));
      });
      return;
    }
    if (req.method === 'DELETE') {
      for (const e of ['png', 'jpg', 'webp']) { try { unlinkSync(join(HERE, 'privacy-lock.' + e)); } catch { } }
      privacy.image = '';
      const owner = privacy.owner;
      if (privacy.proc && owner) { privacyStop('恢复纯黑'); const lockKeep = privacy.lockInput !== false; setTimeout(() => { try { privacyStart(owner, lockKeep); } catch { } }, 1500); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(Object.assign({ ok: true }, privacyJson())));
      return;
    }
  }
  // ---- 离线模式（没有互联网/Tailscale）：局域网访问 + 电脑热点 + USB 网络共享 ---------
  // 网页走 https://<电脑局域网IP>:<port>/?k=KEY（自签证书；https 才有 WebRTC 低延迟）。
  function privateIps() {
    const out = [];
    const usb = (() => { try { return usbLanIps(); } catch { return []; } })();
    // 只列真实 Up 的网卡：Windows 在网卡断开后仍保留 IP 配置，os.networkInterfaces() 也常返回旧地址，
    // 面板会因此给出一个连不上的死地址（实测拔 Wi-Fi/关 USB 共享后仍显示旧 IP）。
    try {
      const list = lanIpsNow();
      for (const ip of list) out.push({ name: '局域网', ip: ip, usb: usb.indexOf(ip) >= 0 });
    } catch { }
    if (!out.length) {
      // 兜底：PowerShell 还没刷新完时退回 Node 的枚举（可能含旧地址，但至少不是空列表）
      try {
        const ifs = os.networkInterfaces();
        for (const name of Object.keys(ifs)) {
          if (/vmware|virtualbox|vEthernet|loopback|tailscale/i.test(name)) continue;
          for (const a of (ifs[name] || [])) {
            if (!a || a.family !== 'IPv4' || a.internal) continue;
            const ip = a.address;
            if (/^100\./.test(ip)) continue;
            if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip)) out.push({ name, ip, usb: usb.indexOf(ip) >= 0 });
          }
        }
      } catch { }
    }
    // USB 网络共享排最前（最快），手机端直接选第一个地址
    out.sort((x, y) => (y.usb ? 1 : 0) - (x.usb ? 1 : 0));
    return out;
  }
  function runHotspot(args) {
    return new Promise((resolve) => {
      const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const script = join(HERE, 'hotspot-ctl.ps1');
      if (!fileExists(script)) return resolve({ ok: false, error: '缺少 hotspot-ctl.ps1' });
      let out = '', done = false;
      const finish = (obj) => { if (!done) { done = true; resolve(obj); } };
      const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.stdout.on('data', (d) => { out += String(d); });
      child.on('exit', () => {
        try { finish(JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')); } catch { finish({ ok: false, error: out.trim().slice(0, 200) || 'no output' }); }
      });
      child.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
      setTimeout(() => { try { child.kill(); } catch { } finish({ ok: false, error: 'timeout' }); }, 45000);
    });
  }
  // 二维码：离线模式的手机直连地址（用随包的 qrlib + python 生成；没有 python 就 404，页面自动隐藏）
  let pyCmdCache = null, pyCmdTried = false;
  function pythonCmd() {
    if (pyCmdTried) return pyCmdCache;
    pyCmdTried = true;
    const cands = [['python', []], ['py', ['-3']]];
    for (const c of cands) {
      try { execFileSync(c[0], c[1].concat(['--version']), { timeout: 4000, windowsHide: true, stdio: 'ignore' }); pyCmdCache = c; return pyCmdCache; } catch { }
    }
    return null;
  }
  if (url.pathname === '/qr') {
    const d = String(url.searchParams.get('d') || '');
    if (!d || d.length > 2048) { try { res.writeHead(400); res.end(); } catch { } return; }
    const h = createHash('md5').update(d).digest('hex');
    const outFile = join(HERE, 'qr-cache-' + h + '.png');
    if (!fileExists(outFile)) {
      const py = pythonCmd();
      const script = join(HERE, 'make-qr.py');
      if (!py || !fileExists(script)) { try { res.writeHead(404); res.end('no-python'); } catch { } return; }
      try { execFileSync(py[0], py[1].concat([script, d, outFile]), { timeout: 20000, windowsHide: true, stdio: 'ignore' }); }
      catch (e) { try { res.writeHead(500); res.end('qr-failed'); } catch { } return; }
    }
    try {
      const png = readFileSync(outFile);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' });
      res.end(png);
    } catch { try { res.writeHead(500); res.end('qr-missing'); } catch { } }
    return;
  }
  if (url.pathname === '/offline-info') {
    const cfgNow = (() => { try { return JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
    const hs = await runHotspot(['-Action', 'status']);
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        offline: !!(cfgNow.screen && cfgNow.screen.offline),
        port: Number(cfgNow.ports && cfgNow.ports.screen) || 8660,
        ips: privateIps(),
        https: LAN_HTTPS,
        fallbackPort: (Number(cfgNow.ports && cfgNow.ports.screen) || 8660) + 1,
        httpsPort2: (Number(cfgNow.ports && cfgNow.ports.screen) || 8660) + 2,
        blockedPorts: (() => { try { return blockedPortsNow(); } catch { return []; } })(),
        hotspot: hs
      }));
    } catch { }
    return;
  }
  // 局域网自检：手机打不开时用（在电脑上看：端口有没有监听、防火墙有没有放行、证书在不在）
  if (url.pathname === '/lan-check') {
    const cfgNow = (() => { try { return JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
    const port = Number(cfgNow.ports && cfgNow.ports.screen) || 8660;
    const out = { ok: true, offline: !!(cfgNow.screen && cfgNow.screen.offline), lan: LAN_ONLY, lanHttps: !!(LAN_ONLY && LAN_HTTPS), lanPort: port + 2, https: LAN_HTTPS, port: port, fallbackPort: port + 1, ips: privateIps(), listening: [], firewall: {}, cert: {}, checks: [] };
    try {
      const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const cmd = "$c=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(" + port + "," + (port + 1) + "," + (port + 2) + ") } | Select-Object -ExpandProperty LocalAddress; $c -join ','";
      const lo = String(execFileSync(psExe, ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 6000, windowsHide: true }) || '');
      out.listening = lo.split(',').map((s) => s.trim()).filter(Boolean);
    } catch { }
    try {
      const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const tag = 'PhoneAccess 轻屏';
      const cmd = "$b=Get-NetFirewallRule -DisplayName ('" + tag + " : 拒绝局域网 " + port + "') -ErrorAction SilentlyContinue | Select-Object -First 1; $a=Get-NetFirewallRule -DisplayName ('" + tag + " : 离线模式允许局域网 " + port + "') -ErrorAction SilentlyContinue | Select-Object -First 1; $w=Get-NetFirewallRule -DisplayName ('" + tag + " : 离线模式允许局域网 WebRTC') -ErrorAction SilentlyContinue | Select-Object -First 1; $l1=Get-NetFirewallRule -DisplayName 'PA-LAN-SCREEN-8662' -ErrorAction SilentlyContinue | Select-Object -First 1; $l2=Get-NetFirewallRule -DisplayName 'PA-LAN-RTC-UDP' -ErrorAction SilentlyContinue | Select-Object -First 1; ($(if($b){[string]$b.Enabled}else{'none'}))+','+($(if($a){[string]$a.Enabled}else{'none'}))+','+($(if($w){[string]$w.Enabled}else{'none'}))+','+($(if($l1){[string]$l1.Enabled}else{'none'}))+','+($(if($l2){[string]$l2.Enabled}else{'none'}))";
      const fw = String(execFileSync(psExe, ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 6000, windowsHide: true }) || '').trim();
      const parts = fw.split(',');
      out.firewall = { blockLan: parts[0] || 'none', allowLan: parts[1] || 'none', allowWebrtc: parts[2] || 'none', lanScreen: parts[3] || 'none', lanRtc: parts[4] || 'none' };
    } catch { }
    try {
      const st = statSync(join(HERE, 'lan-cert.pfx'));
      out.cert = { exists: true, size: st.size, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
    } catch { out.cert = { exists: false }; }
    out.checks.push({ name: '局域网开关', ok: !!(out.offline || out.lan), text: out.offline ? '离线模式（旧路子：绑 8660/8661/8662）' : (out.lan ? '局域网直连（只开 8662 HTTPS，8660 仍只给 Tailscale）' : '未开启（手机只能用 Tailscale 进来）') });
    out.checks.push({ name: '局域网端口', ok: !out.lan || out.listening.some((x) => x === '0.0.0.0' || x === '::'), text: out.lan ? ((out.lanHttps ? 'https://' : 'http://') + '<电脑IP>:' + (port + 2) + '（' + (out.lanHttps ? 'https 已就绪' : '证书异常，退回了 http') + '）') : '（未开启，不适用）' });
    out.checks.push({ name: '监听端口', ok: out.listening.length > 0, text: out.listening.length ? ('正在监听：' + out.listening.join('、') + '（' + port + '/' + (port + 1) + '/' + (port + 2) + '）') : '没有任何地址在监听' });
    try {
      const psExe2 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const cmd2 = "Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceDescription";
      const ad = String(execFileSync(psExe2, ['-NoProfile', '-Command', cmd2], { encoding: 'utf8', timeout: 6000, windowsHide: true }) || '').trim();
      const names = ad.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const usbAd = names.find((n) => /RNDIS|Remote NDIS|USB/i.test(n));
      out.adapters = names;
      out.checks.push({ name: 'USB 网络共享', ok: !!usbAd, text: usbAd ? ('已识别：' + usbAd) : '未识别到 USB 共享网卡（手机没开 USB 网络共享，或手机没信号时系统把它关了）' });
    } catch (e) {
      out.checks.push({ name: 'USB 网络共享', ok: false, text: '检测失败：' + ((e && e.message) || e) });
    }
    const lanFwOk = (out.firewall.allowLan === 'True') || (out.firewall.lanScreen === 'True');
    out.checks.push({ name: '防火墙', ok: lanFwOk, text: lanFwOk ? ('已按来源放行' + (out.firewall.lanScreen === 'True' ? '（PA-LAN-SCREEN-8662 / PA-LAN-RTC-UDP，仅私有网段）' : '（离线模式规则）')) : '未放行（手机连不上：开一次局域网，并在弹窗里点「是」）' });
    out.checks.push({ name: '证书', ok: !!out.cert.exists, text: out.cert.exists ? ('自签证书已生成（' + Math.round((out.cert.ageSec || 0) / 60) + ' 分钟前）') : '缺失（https 会退回 http）' });
    const ip0 = (out.ips[0] && out.ips[0].ip) || '电脑IP';
    out.hint = out.lan
      ? ('手机连同一个 Wi-Fi 后打开 https://' + ip0 + ':' + (port + 2) + '/?k=…（第一次提示"不安全"点「高级 → 继续前往」）。如果一直转圈：1) 公司/酒店 Wi-Fi 常禁止设备互访，改用电脑热点；2) 用 USB 网络共享；3) 防火墙需要 PA-LAN-SCREEN-8662 那条规则（仅私有网段放行）。')
      : ('手机连同一个 Wi-Fi 后打开地址；第一次提示"不安全"点「高级 → 继续前往」。如果一直转圈：1) 公司/酒店 Wi-Fi 可能禁止设备互访，改用电脑热点；2) 用 USB 网络共享（最快）；3) 试试备用地址 http://' + ip0 + ':' + (port + 1) + '/?k=…');
    try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(out)); } catch { }
    return;
  }
  // 2026-11-07：只重启服务、不碰任何配置（以前图省事用 /offline/on 重启，副作用是把离线模式打开了）
  if (url.pathname === '/restart-service' && req.method === 'POST') {
    try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end('{"ok":true,"restarting":true}'); } catch (e) { }
    setTimeout(() => { try { process.exit(0); } catch (e) { } }, 300);
    return;
  }
  if (url.pathname === '/offline/on' || url.pathname === '/offline/off') {
    const on = url.pathname === '/offline/on';
    // 防抖：3 秒内重复切换直接忽略（避免来回点把 UAC 和重启刷爆）
    globalThis.__paOfflineLast = globalThis.__paOfflineLast || 0;
    if (Date.now() - globalThis.__paOfflineLast < 3000) {
      try { res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '操作太快，等几秒再试' })); } catch { }
      return;
    }
    globalThis.__paOfflineLast = Date.now();
    try {
      const p = join(HERE, 'product.config.json');
      const c = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (!c.screen) c.screen = {};
      c.screen.offline = on;
      writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, offline: on, restarting: true }));
    } catch (e) {
      try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); } catch { }
      return;
    }
    // 防火墙：默认安装时"拒绝局域网私有网段"会挡住手机，开/关离线模式时用管理员权限放行/恢复。
    // 会弹一次 UAC（页面/入口脚本都要提示用户点"是"）。
    try {
      const fw = join(HERE, 'offline-firewall.ps1');
      if (fileExists(fw)) {
        const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        const argLine = "-NoProfile -ExecutionPolicy Bypass -File \"" + fw + "\" -Action " + (on ? 'on' : 'off');
        spawn(psExe, ['-NoProfile', '-Command', "Start-Process -FilePath '" + psExe + "' -ArgumentList '" + argLine.replace(/'/g, "''") + "' -Verb RunAs -WindowStyle Hidden"], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch { }
    // 监听地址要跟着变：让守护进程重启服务（约 10 秒）
    setTimeout(() => { try { process.exit(0); } catch { } }, 800);
    return;
  }
  // 2026-11-08：只重跑离线模式的防火墙放行，**不改配置、不重启服务**。
  // 之前页面上的「修复」按钮走 /offline/on，会顺带把离线模式打开（改绑所有网卡 + 明文 HTTP），
  // 用户只是想修一条防火墙规则，结果整个姿态变了。
  if (url.pathname === '/offline/repair' && req.method === 'POST') {
    globalThis.__paRepairLast = globalThis.__paRepairLast || 0;
    if (Date.now() - globalThis.__paRepairLast < 3000) {
      try { res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '操作太快，等 3 秒再试' })); } catch { }
      return;
    }
    globalThis.__paRepairLast = Date.now();
    try {
      const fwR = join(HERE, 'offline-firewall.ps1');
      if (fileExists(fwR)) {
        const psR = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        const argR = "-NoProfile -ExecutionPolicy Bypass -File \"" + fwR + "\" -Action on";
        spawn(psR, ['-NoProfile', '-Command', "Start-Process -FilePath '" + psR + "' -ArgumentList '" + argR.replace(/'/g, "''") + "' -Verb RunAs -WindowStyle Hidden"],
          { windowsHide: true, stdio: 'ignore' }).unref();
      }
      try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, repairing: true, note: '请在电脑上点「是」：只修复防火墙放行，不改任何开关' })); } catch { }
    } catch (e) {
      try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); } catch { }
    }
    return;
  }  // ---- 同一 Wi-Fi 串流开关（2026-11-08）---------------------------------------
  // 只放行 Sunshine 自己的端口（程序限定 Sunshine.exe、来源仅私有网段、不含 47990）。
  // 和 screen.lan / screen.offline 完全独立：不动 8660/8661/8662 的监听与规则。
  if (url.pathname === '/stream/lan/on' || url.pathname === '/stream/lan/off' || url.pathname === '/stream/status') {
    const isStatus = url.pathname === '/stream/status';
    const on = url.pathname === '/stream/lan/on';
    const cfgPathS = join(HERE, 'product.config.json');
    const readCfgS = () => { try { return JSON.parse(readFileSync(cfgPathS, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
    if (isStatus) {
      let rules = 0;
      try {
        const psS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        const outS = String(execFileSync(psS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "(Get-NetFirewallRule -DisplayName 'PA-STREAM-LAN-*' -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8', timeout: 6000, windowsHide: true }) || '').trim();
        rules = Number(outS) || 0;
      } catch { }
      const cS = readCfgS();
      try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, enabled: !!(cS.screen && cS.screen.lanStream), rules })); } catch { }
      return;
    }
    // 防抖：3 秒内重复切换忽略（UAC 很吵）
    globalThis.__paStreamLast = globalThis.__paStreamLast || 0;
    if (Date.now() - globalThis.__paStreamLast < 3000) {
      try { res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '操作太快，等 3 秒再试' })); } catch { }
      return;
    }
    globalThis.__paStreamLast = Date.now();
    try {
      const cS = readCfgS();
      if (!cS.screen) cS.screen = {};
      cS.screen.lanStream = on;
      writeFileSync(cfgPathS, JSON.stringify(cS, null, 2), 'utf8');
    } catch (e) {
      try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写配置失败' })); } catch { }
      return;
    }
    // 提权跑 firewall 脚本（UAC）；不需要重启服务（Sunshine 本来就监听 0.0.0.0）
    try {
      const fwS = join(HERE, 'stream-firewall.ps1');
      if (fileExists(fwS)) {
        const psExeS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        const argS = "-NoProfile -ExecutionPolicy Bypass -File \"" + fwS + "\" -Action " + (on ? 'on' : 'off');
        spawn(psExeS, ['-NoProfile', '-Command', "Start-Process -FilePath '" + psExeS + "' -ArgumentList '" + argS.replace(/'/g, "''") + "' -Verb RunAs -WindowStyle Hidden"],
          { windowsHide: true, stdio: 'ignore' }).unref();
      }
    } catch { }
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, enabled: on, note: on ? '正在放行：请在电脑上点「是」（管理员授权）' : '正在关闭并恢复：请在电脑上点「是」' }));
    } catch { }
    return;
  }  if (url.pathname === '/hotspot/on' || url.pathname === '/hotspot/off') {
    const on = url.pathname === '/hotspot/on';
    const body = await new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => { b += d; if (b.length > 2048) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
      setTimeout(() => resolve({}), 1500);
    });
    const ssid = String(body.ssid || 'PhoneAccess-Offline').slice(0, 32);
    const pass = String(body.pass || 'phoneaccess').slice(0, 63);
    const job = await runHotspot(on ? ['-Action', 'start', '-Ssid', ssid, '-Pass', pass] : ['-Action', 'stop']);
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(Object.assign({ ok: !!job.ok, job: job, ips: privateIps() }, job)));
    } catch { }
    // 热点刚起来时 192.168.137.1 还不在监听列表里：让守护重启一次服务，把新网卡地址绑上。
    if (on && job && job.ok && OFFLINE_MODE) {
      setTimeout(() => { try { process.exit(0); } catch { } }, 1500);
    }
    return;
  }
  // ---- 诊断导出：把状态和最近日志打包成一份 txt（密钥已打码），给卖家排查 ----
  if (url.pathname === '/diagnose') {
    const scrub = (s) => String(s || '').split(KEY).join('***');
    const tail = (p, n) => {
      try { const lines = readFileSync(p, 'utf8').split(/\r?\n/); return scrub(lines.slice(-n).join('\n')); } catch (e) { return '(无法读取: ' + (e && e.message) + ')'; }
    };
    let beat = '';
    try { beat = readFileSync(join(HERE, 'supervisor.heartbeat'), 'utf8').trim(); } catch (e) { beat = '(无)'; }
    const out = [
      '== 轻屏 · 诊断报告 ==',
      '时间: ' + new Date().toISOString(),
      '',
      '== 编码/画面 ==',
      JSON.stringify({
        enabled: H264_ENABLED, encoder: H264_ENCODER, width: H264_W, height: H264_H, fps: H264_FPS, kbps: H264_KBPS,
        viewers: h264.clients.size, lastError: h264.lastError, native: H264_NATIVE, rect: H264_RECT
      }),
      '',
      '== WebRTC264 ==',
      JSON.stringify({ enabled: !!(CFG264.enabled && fileExists(RTC264_EXE)), port: RTC264_PORT, feedPort: RTC264_FEED_PORT, turnPort: RTC264_TURN_PORT }),
      'status=' + JSON.stringify(rtc264Status),
      '',
      '== 防窥屏 ==',
      JSON.stringify(privacyJson()),
      '',
      '== 守护 ==',
      'heartbeat=' + beat,
      '',
      '== screen-server.log 末尾 40 行 ==',
      tail(join(HERE, 'screen-server.log'), 40),
      '',
      '== rtc-h264/sidecar.log 末尾 30 行 ==',
      tail(join(HERE, 'rtc-h264', 'sidecar.log'), 30),
      ''
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="phoneaccess-diagnose.txt"' });
    res.end(out);
    return;
  }
  if (url.pathname === '/h264-init') {
    const info = h264.initInfo;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: !!info,
      codec: info ? info.codec : '',
      description: info && info.avcC ? info.avcC.toString('base64') : '',
      width: info ? info.width : H264_W,
      height: info ? info.height : H264_H,
      timescale: info ? info.timescale : 1000
    }));
    return;
  }
  // 画质优先开关写回 product.config.json（重启后仍生效）
  function saveH264QualityFirst(on) {
    try {
      const p = join(HERE, 'product.config.json');
      const c = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (!c.screen) c.screen = {};
      if (!c.screen.h264) c.screen.h264 = {};
      c.screen.h264.qualityFirst = !!on;
      writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) { console.log('h264: 保存画质优先设置失败 ' + e.message); }
  }
  // 单窗口采集（实验）：{ hwnd: 1234 } 开启，{ hwnd: 0 } 回全屏
  if (url.pathname === '/h264-window' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2048) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(b || '{}'); } catch { }
      const hw = Number(m.hwnd) || 0;
      H264_WIN = hw > 0 ? Math.round(hw) : 0;
      console.log('h264: window mode -> ' + (H264_WIN ? ('hwnd ' + H264_WIN) : 'full screen'));
      if (h264.proc || h264.cap) h264Stop();
      h264.startQueued = true;
      setTimeout(() => { if ((rtc264Alive() || h264.clients.size > 0) && !h264.proc && !h264.killPending) h264Start(); }, 600);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, win: H264_WIN }));
    });
    return;
  }
  if (url.pathname === '/h264-quality') {
    const qreply = (obj) => { try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch { } };
    if (req.method === 'GET') return qreply({ ok: true, width: H264_W, height: H264_H, fps: H264_FPS, kbps: H264_KBPS, qf: H264_QF, mon: H264_MON, maxCapture: CAP_W });
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(b || '{}'); } catch { }
      const f = Number(m.fps), k = Number(m.kbps), w = Number(m.width), mon = Number(m.mon);
      // 显示器切换：ddagrab output_idx 要跟着换（裁剪矩形由页面换算成"相对该显示器"的坐标）
      if (Number.isFinite(mon) && mon >= 0 && mon <= 7 && Math.round(mon) !== H264_MON) {
        H264_MON = Math.round(mon);
        H264_NATIVE = false;   // 副屏几何/分辨率不一定和主屏一样，先走缩放路径
      }
      if (m.rect && Number(m.rect.w) > 0) {
        const rr = { x: Number(m.rect.x) || 0, y: Number(m.rect.y) || 0, w: Number(m.rect.w), h: Number(m.rect.h) };
        // 主屏整屏的裁剪等于不裁剪：清掉 rect，保留原生零拷贝/60fps 路径
        if (H264_MON === 0 && rr.x <= 0 && rr.y <= 0 && rr.w >= CAP_W && rr.h >= CAP_H) H264_RECT = null;
        else H264_RECT = rr;
      } else if (m.rect === null) H264_RECT = null;
      if (typeof m.qf === 'boolean' && m.qf !== H264_QF) { H264_QF = m.qf; saveH264QualityFirst(H264_QF); }
      if (Number.isFinite(f)) H264_FPS = Math.max(10, Math.min(60, Math.round(f)));
      if (Number.isFinite(k)) H264_KBPS = Math.max(2000, Math.min(40000, Math.round(k)));
      if (Number.isFinite(w) && w >= 640) {
        H264_W = evenDown(Math.min(CAP_W, Math.round(w)));
        H264_H = evenDown(Math.max(360, Math.round(H264_W * CAP_H / CAP_W)));
      }
      // 宽屏高分辨率下 60fps 容易超出解码器等级/带宽能力：>1920 宽时自动降到 30fps
      // （按**即将生效的**宽度判断原生路径，否则从 1920 调到 2560 会被误降成 30fps）
      const willNative = H264_W >= CAP_W && H264_W >= 2560 && H264_MON === 0 && !H264_RECT;
      if (!willNative && H264_W > 1920 && H264_FPS > 30) H264_FPS = 30;   // 原生零拷贝路径允许 2560@60
      H264_NATIVE = H264_W >= CAP_W && H264_W >= 2560 && H264_MON === 0;    // 原生路径只对主屏生效
      if (H264_RECT) H264_NATIVE = false;   // 选了窗口/局部区域时必须走裁剪滤镜
      // 重启编码器让新参数生效。RTC264 会话没有 WS 观众，也必须重启，
      // 否则调码率后编码器停着不回来（以前只在有 WS 观众时重启）。
      if (h264.proc) { try { h264.proc.kill(); } catch { } h264.proc = null; }
      h264.initInfo = null; h264.pending = Buffer.alloc(0); h264.tsUs = 0;
      if (h264.clients.size > 0 || rtc264Alive()) setTimeout(() => { if (!h264.proc) h264Ensure(); }, 300);
      qreply({ ok: true, width: H264_W, height: H264_H, fps: H264_FPS, kbps: H264_KBPS, qf: H264_QF, mon: H264_MON });
    });
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
      // 单窗口采集（实验）：非 0 表示正在抓这个窗口
      win: H264_WIN,
      // 单窗口采集时，被采集窗口客户区在屏幕上的物理矩形（页面输入坐标用）
      winRect: h264.winRect || null,
      mon: H264_MON,
      qf: H264_QF,
      // B 方案（Pion WebRTC H.264）默认通道：页面默认走它，?rtc264=0 可强制旧 WS 通道
      rtc: { enabled: !!(CFG264.enabled && fileExists(RTC264_EXE)), port: RTC264_PORT, turn: RTC264_TURN_PORT },
      wt: cfgH264.wt ? { enabled: cfgH264.wt.enabled !== false, port: Number(cfgH264.wt.port) || 8444, hash: String(cfgH264.wt.hash || '') } : null,
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

  // ---- 实验版 E2b：高清裁剪（比 OCR 重画可靠得多）---------------------------
  // 视频是 1920x1200 有损压缩的缩略图，放大 1.7 倍就是糊的；服务端手里有
  // 2560x1600 的原始帧。放大停手时把这块按原始像素切回来（JPEG q86），
  // 客户端直接贴上去盖住视频层 —— 真像素，没有字体差异、没有重画错位。
  // 实测 1000x700 区域：126KB / 106ms（OCR 重画要 1700ms）。
  if (url.pathname === '/exp/hidpi' && req.method === 'POST') {
    const cfg = expConfig();
    if (cfg.enabled !== true) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"experiments disabled"}'); return; }
    let body = '';
    req.on('data', (c2) => { body += c2; if (body.length > 8 * 1024) req.destroy(); });
    req.on('end', async () => {
      const t0 = Date.now();
      try {
        const up = await ensureOcr();
        if (!up) throw new Error('高清抓帧服务起不来');
        const r = await fetch('http://127.0.0.1:' + EXP_OCR_PORT + '/hidpi', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body,
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error('hidpi ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': buf.length,
          'x-rect': r.headers.get('x-rect') || '',
          'x-ms': String(Date.now() - t0),
          'cache-control': 'no-store',
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e), ms: Date.now() - t0 }));
      }
    });
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

  // ---- 实验版 E2：矢量文字层 -------------------------------------------------
  // 把请求转发给常驻的 Python OCR 服务（默认 127.0.0.1:8777）。这个服务由本进程
  // **按需自动拉起**（ensureOcr），不需要用户手动开窗口。
  // 为什么不在 Node 里做 OCR：RapidOCR 是 Python 生态，模型加载一次 ~640ms，
  // 必须常驻；Node 这边只负责鉴权、转发和拉起，挂了也只影响文字层，不影响画面。
  if (url.pathname === '/exp/ocr' && req.method === 'POST') {
    const cfg = expConfig();
    if (cfg.enabled !== true) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"experiments disabled"}'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
    req.on('end', async () => {
      const t0 = Date.now();
      try {
        const up = await ensureOcr();
        if (!up) throw new Error('OCR 服务起不来（没找到 Python？见 ocr.log）');
        const r = await fetch('http://127.0.0.1:' + EXP_OCR_PORT + '/ocr', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body,
          signal: AbortSignal.timeout(15000),
        });
        const txt = await r.text();
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(txt);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          error: 'OCR 服务没响应',
          detail: String(e && e.message || e),
          ms: Date.now() - t0,
        }));
      }
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
  // 本地 CA 公钥（供手机下载安装，安装后 https 受信任、可安装成 App）
  if (url.pathname === '/ca.crt') {
    try {
      const caBytes = readFileSync(join(HERE, 'lan-ca.crt'));
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': "attachment; filename*=UTF-8''PhoneAccess-CA.crt",
        'cache-control': 'no-store'
      });
      res.end(caBytes);
    } catch (e) {
      try { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('CA 还没生成（先在电脑上开一次离线模式）'); } catch { }
    }
    return;
  }
  // ---- 游戏列表 / 添加游戏（2026-11-07）------------------------------------
  // 目的：让用户不用进 Sunshine 的英文后台就能把游戏加进 Moonlight。
  // 安全与防 bug 的几条底线：
  //   · 只接受「Steam 库里真实存在」的 appid，或「真实存在的绝对路径 exe」——不接受任意命令字符串
  //   · 加之前先查 Sunshine 现有应用，同 cmd 就返回 duplicate，不重复添加
  //   · Sunshine 不可用时返回 ok:false + 原因，页面显示红字，不抛异常
  function steamLibDirs() {
    const roots = new Set();
    try {
      const reg = require('node:child_process').execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const m = String(reg || '').match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) roots.add(String(m[1]).trim());
    } catch (e) { }
    for (const d of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam']) {
      try { if (existsSync(d)) roots.add(d); } catch (e) { }
    }
    const libs = new Set();
    for (const r of roots) {
      const rr = String(r).replace(/\//g, '\\');
      libs.add(rr);
      try {
        const vdf = readFileSync(join(rr, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        for (const mm of String(vdf).matchAll(/"path"\s+"([^"]+)"/g)) libs.add(String(mm[1]).replace(/\//g, '\\'));
      } catch (e) { }
    }
    const out = [];
    for (const d of libs) { try { if (existsSync(join(d, 'steamapps'))) out.push(d); } catch (e) { } }
    return out;
  }
  function steamGames() {
    const list = [];
    const seen = new Set();
    for (const lib of steamLibDirs()) {
      const appsDir = join(lib, 'steamapps');
      let files = [];
      try { files = readdirSync(appsDir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch (e) { continue; }
      for (const f of files) {
        try {
          const t = readFileSync(join(appsDir, f), 'utf8');
          const appid = (String(t).match(/"appid"\s+"(\d+)"/) || [])[1] || '';
          const name = (String(t).match(/"name"\s+"([^"]*)"/) || [])[1] || '';
          const dir = (String(t).match(/"installdir"\s+"([^"]*)"/) || [])[1] || '';
          if (!appid || !name || seen.has(appid)) continue;
          if (/^(Steamworks|Proton|Steam Linux Runtime|SteamVR|Steam Client|Steam Console)/i.test(name)) continue;
          const full = dir ? join(appsDir, 'common', dir) : '';
          seen.add(appid);
          list.push({ appid: appid, name: name, dir: full, installed: !!(full && existsSync(full)) });
        } catch (e) { }
      }
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    return list;
  }
  function sunshineAppList(cb) {
    sunshineApi('GET', '/api/apps?unique_id=1', null, 6000).then((r) => {
      if (!r || !r.ok) { try { cb(new Error('sunshine-offline'), []); } catch (e) { } return; }
      let apps = [];
      try { const j = JSON.parse(r.body); apps = Array.isArray(j.apps) ? j.apps : []; } catch (e) { }
      cb(null, apps);
    });
  }
  if (url.pathname === '/game-list') {
    const games = steamGames();
    sunshineAppList((err, apps) => {
      const added = new Set();
      for (const a of apps) {
        const m = String((a && a.cmd) || '').match(/steam:\/\/rungameid\/(\d+)/i);
        if (m) added.add(m[1]);
      }
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, sunshine: !err, games: games.map((g) => Object.assign({}, g, { added: added.has(g.appid) })) }));
      } catch (e) { }
    });
    return;
  }
  // ---- 移除游戏（2026-11-07）--------------------------------------------
  // 只允许删除「cmd 精确等于 steam://rungameid/<appid>」的条目，避免误删 Desktop / Steam Big Picture。
  // Sunshine 的 DELETE 按下标删，删除后下标会变，所以每次现查现删。
  if (url.pathname === '/game-remove' && req.method === 'POST') {
    const rreply = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch (e) { } };
    readBody(req, 4096).then((b) => {
      let m = {};
      try { m = JSON.parse(String(b || '{}')); } catch (e) { rreply(400, { ok: false, error: '请求格式不对' }); return; }
      const id = String(m.appid || '').replace(/[^0-9]/g, '').slice(0, 10);
      if (!id) { rreply(400, { ok: false, error: '缺少 appid' }); return; }
      const want = ('steam://rungameid/' + id).toLowerCase();
      sunshineAppList((err, apps) => {
        if (err) { rreply(503, { ok: false, error: 'Sunshine 面板没连上' }); return; }
        let idx = -1;
        for (let i2 = 0; i2 < apps.length; i2++) {
          if (String((apps[i2] && apps[i2].cmd) || '').trim().toLowerCase() === want) { idx = i2; break; }
        }
        if (idx < 0) { rreply(404, { ok: false, error: '列表里没有这个游戏（可能已经删掉了）' }); return; }
        sunshineApi('DELETE', '/api/apps/' + idx, null, 8000).then((r) => {
          let ok = false;
          try { const j = JSON.parse(r.body); ok = !!(j && j.status); } catch (e) { ok = false; }
          if (ok) rreply(200, { ok: true, removed: true });
          else rreply(500, { ok: false, error: 'Sunshine 拒绝删除' });
        });
      });
    });
    return;
  }
  if (url.pathname === '/game-add' && req.method === 'POST') {
    const greply = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch (e) { } };
    readBody(req, 8192).then((b) => {
      let m = {};
      try { m = JSON.parse(String(b || '{}')); } catch (e) { greply(400, { ok: false, error: '请求格式不对' }); return; }
      let name = '';
      let cmd = '';
      let workDir = '';
      if (m.appid) {
        const id = String(m.appid).replace(/[^0-9]/g, '').slice(0, 10);
        if (!id) { greply(400, { ok: false, error: '游戏 ID 不合法' }); return; }
        const g = steamGames().find((x) => x.appid === id);
        if (!g) { greply(404, { ok: false, error: 'Steam 库里没找到这个游戏（先确认已安装）' }); return; }
        name = g.name;
        cmd = 'steam://rungameid/' + g.appid;
        workDir = g.dir || '';
      } else if (m.exePath) {
        const raw = String(m.exePath).trim().replace(/^"|"$/g, '');
        if (!/^[A-Za-z]:\\/.test(raw)) { greply(400, { ok: false, error: '请填完整的 exe 路径（例如 D:\\Games\\游戏\\game.exe）' }); return; }
        if (!/\.exe$/i.test(raw)) { greply(400, { ok: false, error: '只能添加 .exe 文件' }); return; }
        try { if (!existsSync(raw)) { greply(404, { ok: false, error: '这个路径不存在' }); return; } } catch (e) { greply(400, { ok: false, error: '路径检查失败' }); return; }
        name = String(m.name || '').trim().slice(0, 80) || raw.split('\\').pop().replace(/\.exe$/i, '');
        cmd = raw;
        workDir = raw.replace(/\\[^\\]+$/, '');
      } else {
        greply(400, { ok: false, error: '缺少 appid 或 exePath' });
        return;
      }
      sunshineAppList((err, apps) => {
        if (err) { greply(503, { ok: false, error: 'Sunshine 面板没连上（先确认串流组件在运行）' }); return; }
        const dup = apps.find((a) => String((a && a.cmd) || '').trim().toLowerCase() === cmd.toLowerCase());
        if (dup) { greply(200, { ok: true, duplicate: true, name: dup.name || name }); return; }
        const body = { name: name, cmd: cmd, 'auto-detach': true, 'wait-all': true, index: -1 };
        if (workDir) body['working-dir'] = workDir;
        sunshineApi('POST', '/api/apps', body, 10000).then((r) => {
          let ok = false; let msg = '';
          try { const j = JSON.parse(r.body); ok = !!(j && j.status); msg = (j && j.error) || ''; } catch (e) { ok = false; }
          if (ok) greply(200, { ok: true, added: true, name: name });
          else greply(500, { ok: false, error: 'Sunshine 拒绝添加：' + (msg || ('HTTP ' + (r.httpStatus || '?'))) });
        });
      });
    });
    return;
  }
  // ---- 定时开关机（2026-11-07）：规则存 power-schedule.json，引擎是 power-apply.ps1 ----
  // 设计要点（第一版踩过坑）：
  //   · 查询任务状态不要跑 PowerShell（在服务进程里会卡住、接口超时）——用原生 schtasks /query /fo csv 很快；
  //   · 应用规则才需要 PowerShell（ScheduledTasks 模块建 WakeToRun 任务），**异步执行**，立刻返回；
  //     页面随后轮询 /power/status 看结果。
  const sendJson = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); } catch (e) { } };
  if (url.pathname === '/power/status' || url.pathname === '/power/apply') {
    const pjson = join(HERE, 'power-schedule.json');
    const plast = join(HERE, 'power-last.json');
    const toolPs = join(HERE, 'power-apply.ps1');
    const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; } };
    const docS = readJson(pjson, { enabled: false, rules: [] });
    const last = readJson(plast, null);

    // 规则校验（页面先校验一次，这里是最后一道，防止绕过页面直接打接口）
    const bad = [];
    const normRules = (arr) => {
      const out = [];
      const seen = {};
      const list = Array.isArray(arr) ? arr.slice(0, 20) : [];
      list.forEach((r, i) => {
        const n = i + 1;
        let id = String((r && r.id) || ('r' + n)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || ('r' + n);
        const mode = (r && r.mode) === 'shutdown' ? 'shutdown' : 'hibernate';
        const repeat = (r && (r.repeat === 'weekdays' || r.repeat === 'once')) ? r.repeat : 'daily';
        const offTime = String((r && r.offTime) || '').slice(0, 5);
        const wakeTime = String((r && r.wakeTime) || '').slice(0, 5);
        const date = String((r && r.date) || '').replace(/[^0-9-]/g, '').slice(0, 10);
        const okTime = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
        if (seen[id]) { bad.push('第 ' + n + ' 条：编号重复'); return; }
        seen[id] = 1;
        if (!okTime(offTime)) { bad.push('第 ' + n + ' 条：关机/休眠时间格式不对'); return; }
        if (wakeTime && !okTime(wakeTime)) { bad.push('第 ' + n + ' 条：唤醒时间格式不对'); return; }
        if (repeat === 'once') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad.push('第 ' + n + ' 条：选「仅一次」要选日期'); return; }
          const when = new Date(date + 'T' + (offTime.length === 4 ? '0' + offTime : offTime) + ':00');
          if (isNaN(when.getTime())) { bad.push('第 ' + n + ' 条：日期不合法'); return; }
          if (when.getTime() <= Date.now()) { bad.push('第 ' + n + ' 条：日期时间已经过去了'); return; }
        } else if (wakeTime && wakeTime === offTime) {
          bad.push('第 ' + n + ' 条：唤醒时间和关机时间一样');
          return;
        }
        out.push({ id, mode, repeat, date: repeat === 'once' ? date : '', offTime, wakeTime });
      });
      return out;
    };

    if (url.pathname === '/power/status') {
      // 引擎写完 power-last.json（at 时间晚于提交时刻）就解除 busy，页面不用干等
      if (globalThis.__paPowerBusy && globalThis.__paPowerAppliedAt && last && last.at) {
        try {
          const lastMs = new Date(String(last.at).replace(' ', 'T')).getTime();
          if (lastMs >= Number(globalThis.__paPowerAppliedAt) - 2000) { globalThis.__paPowerBusy = false; }
        } catch (e) { }
      }
      const finish = (tasks) => {
        try {
          sendJson(200, {
            ok: true,
            enabled: !!docS.enabled,
            rules: Array.isArray(docS.rules) ? docS.rules : [],
            updatedAt: docS.updatedAt || '',
            tasks: tasks || [],
            busy: !!globalThis.__paPowerBusy,
            // 2026-11-07：自用版「唤醒后不要求登录」的开关状态（页面显示用）
            unlockOnWake: !!(readJson(join(HERE, 'product.config.json'), {}).security || {}).unlockOnWake,
  // 2026-11-08：页面按 profile 决定是否显示「唤醒后不要求登录」（发布版隐藏）
  profile: String((readJson(join(HERE, 'product.config.json'), {}).profile) || 'selfuse'),
            last: last || null
          });
        } catch (e) { }
      };
      // 没有引擎结果（或超过 15 分钟）时，后台补一次 StatusOnly：页面就能显示"是否支持休眠/唤醒定时器状态"
      try {
        const stale = !last || !last.at || (Date.now() - new Date(String(last.at).replace(' ', 'T')).getTime() > 15 * 60 * 1000);
        if (stale && !globalThis.__paPowerDiag) {
          globalThis.__paPowerDiag = true;
          const dd = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toolPs, '-JsonPath', pjson, '-StatusOnly', '-OutPath', plast], { windowsHide: true, stdio: 'ignore' });
          dd.on('error', () => { globalThis.__paPowerDiag = false; });
          dd.on('close', () => { globalThis.__paPowerDiag = false; });
          const clear = setTimeout(() => { globalThis.__paPowerDiag = false; }, 20000);
          clear.unref?.();
        }
      } catch (e) { }
      const guard = setTimeout(() => finish([]), 3000);
      guard.unref?.();
      try {
        const ch = spawn('cmd.exe', ['/c', 'chcp 65001 >nul && schtasks /query /fo csv /nh'], { windowsHide: true });
        let out = '';
        ch.stdout.on('data', (d) => { out += d; });
        ch.on('close', () => {
          clearTimeout(guard);
          const tasks = [];
          for (const line of String(out || '').split(/\r?\n/)) {
            if (line.indexOf('轻屏-电源-') < 0) continue;
            const cols = line.split('","').map((x) => x.replace(/^"|"$/g, ''));
            if (cols.length < 3) continue;
            const nm = cols[0].replace(/^\\+/, '');   // schtasks 的反斜杠前缀（\轻屏-电源-…）
            tasks.push({ name: nm, next: cols[1], state: cols[2], wake: /-唤醒$/.test(nm) });
          }
          finish(tasks);
        });
        ch.on('error', () => { clearTimeout(guard); finish([]); });
      } catch (e) { clearTimeout(guard); finish([]); }
      return;
    }

    // /power/apply
    readBody(req, 64 * 1024).then((body) => {
      let m = {};
      try { m = JSON.parse(String(body || '{}')); } catch { sendJson(400, { ok: false, error: '请求格式不对' }); return; }
      const rules = normRules(m.rules);
      if (bad.length) { sendJson(400, { ok: false, error: bad[0], errors: bad }); return; }
      if (globalThis.__paPowerBusy) { sendJson(429, { ok: false, busy: true, error: '上一次应用还没完成，请等几秒再试' }); return; }
      const doc = { enabled: m.enabled !== false, rules, updatedAt: new Date().toISOString() };
      try { writeFileSync(pjson, JSON.stringify(doc, null, 2), 'utf8'); }
      catch (e) { sendJson(500, { ok: false, error: '写配置失败：' + String((e && e.message) || e) }); return; }
      // 2026-11-07：可选携带 unlockOnWake（自用版「唤醒后不要求登录」开关）。
      // 写进 product.config.json，真正的落地由提权运行的 power-apply.ps1 调 unlock-on-wake.ps1 完成。
      if (typeof m.unlockOnWake === 'boolean') {
        try {
          const cfgPath = join(HERE, 'product.config.json');
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
          cfg.security = cfg.security || {};
          // 2026-11-08：发布版禁止开启「唤醒后不要求登录」——自用便利模式会让走到电脑前的人直接用。
          const profNow = String(cfg.profile || 'selfuse');
          cfg.security.unlockOnWake = (profNow === 'release') ? false : !!m.unlockOnWake;
          writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        } catch (eCfg) { }
      }
      try {
        globalThis.__paPowerBusy = true;
        globalThis.__paPowerAppliedAt = Date.now();
        const logPath = join(HERE, 'power-engine.log');
        // 兜底：UAC 被拒绝 / 引擎没跑起来时，别让 busy 永远卡住（页面会一直显示"正在应用"）
        const busyGuard = setTimeout(() => {
          if (globalThis.__paPowerAppliedAt === appliedAtSnapshot) globalThis.__paPowerBusy = false;
        }, 70000);
        busyGuard.unref?.();
        const appliedAtSnapshot = globalThis.__paPowerAppliedAt;

        const hasWake = rules.some((r) => !!r.wakeTime);
        if (hasWake) {
          // 2026-11-07 实测（联想 83LT）：唤醒任务必须以 **SYSTEM 身份** 注册，固件才兑现 RTC 闹钟；
          // 用普通用户身份注册时 powercfg /waketimers 也能看到闹钟，但到点不醒。建 SYSTEM 任务要管理员，
          // 所以这里弹一次 UAC，让提权进程跑同一个引擎脚本；引擎自己把结果写进 power-last.json 与日志。
          const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
          const inner = "Start-Process -FilePath '" + psExe + "' -ArgumentList '" +
            ('-NoProfile -ExecutionPolicy Bypass -File "' + toolPs + '" -JsonPath "' + pjson + '" -OutPath "' + plast + '"').replace(/'/g, "''") +
            "' -Verb RunAs -WindowStyle Hidden";
          const ch = spawn(psExe, ['-NoProfile', '-Command', inner], { windowsHide: true, stdio: 'ignore' });
          ch.on('error', (e3) => {
            globalThis.__paPowerBusy = false;
            try { appendFileSync(logPath, '[' + new Date().toISOString() + '] elevated spawn error: ' + ((e3 && e3.message) || e3) + '\n', 'utf8'); } catch (e4) { }
          });
          ch.unref?.();
          sendJson(200, {
            ok: true, queued: true, busy: true, elevated: true, enabled: doc.enabled, rules: doc.rules,
            note: '已请求管理员授权：请在电脑上点「是」（定时唤醒必须以系统身份注册计划任务），之后约 5-15 秒完成'
          });
          return;
        }

        // 2026-11-07 改：不再 detached+ignore（那样失败时看不到任何线索），改成抓管道写日志，
        // 出了问题能在 power-engine.log 里直接看到 PowerShell 的报错。
        const ch = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toolPs, '-JsonPath', pjson, '-OutPath', plast],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '', e2 = '';
        ch.stdout.on('data', (d) => { o += d; });
        ch.stderr.on('data', (d) => { e2 += d; });
        ch.on('error', (e3) => {
          globalThis.__paPowerBusy = false;
          try { appendFileSync(logPath, '[' + new Date().toISOString() + '] spawn error: ' + ((e3 && e3.message) || e3) + '\n', 'utf8'); } catch (e4) { }
        });
        ch.on('close', (code) => {
          globalThis.__paPowerBusy = false;
          try {
            appendFileSync(logPath, '[' + new Date().toISOString() + '] exit=' + code + '\n--- stdout ---\n' + String(o).slice(-4000) + '\n--- stderr ---\n' + String(e2).slice(-4000) + '\n', 'utf8');
          } catch (e4) { }
        });
        sendJson(200, { ok: true, queued: true, busy: true, enabled: doc.enabled, rules: doc.rules, note: '正在应用到系统（约 5-15 秒），稍后会自动刷新' });
      } catch (e) {
        globalThis.__paPowerBusy = false;
        sendJson(500, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  // 2026-11-07：一键锁屏（远程用完随手锁上）。LockWorkStation 不需要管理员。
  if (url.pathname === '/lock') {
    if (req.method !== 'POST') { sendJson(405, { ok: false, error: 'POST only' }); return; }
    try {
      spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, stdio: 'ignore' }).unref();
      sendJson(200, { ok: true });
    } catch (e) { sendJson(500, { ok: false, error: String((e && e.message) || e) }); }
    return;
  }  if (url.pathname === '/sw.js') {
    // 缓存"页面外壳"：手机装成 App 后，即使 Android 认为当前网络没互联网（无网 Wi-Fi/热点），
    // 从主屏幕打开也不会出现 Chrome 的恐龙离线页——先出缓存页面，再去连局域网。
    // 只接管页面导航（navigate），其余请求（接口/画面/文件）完全不拦。
    const sw = [
      // 2026-11-07：v2 → v3。v2 从不清理旧缓存，切网/断网时 SW 回落到缓存外壳，
      // 用户看到的就是**修复前的旧页面**（同样的 bug"又出现了"）。现在：
      //   1) 版本号变化会让浏览器重新 install；
      //   2) activate 时删掉所有非当前版本的 cache；
      //   3) 页面里带了 PA_PAGE_VER，设置→关于 能一眼看出是不是旧缓存。
      "const CACHE = 'pa-shell-v3';",
      "self.addEventListener('install', (e) => {",
      "  self.skipWaiting();",
      "  e.waitUntil((async () => {",
      "    // 2026-11-08：先把新外壳缓存成功，**再**删旧缓存。以前不管成功与否都删，",
      "    // 更新那一刻正好断网时会把唯一能用的离线外壳删掉，手机「添加到主屏幕」后打开白屏。",
      "    let ok = false;",
      "    try {",
      "      const c = await caches.open(CACHE);",
      "      await c.add(new Request('/', { cache: 'reload' }));",
      "      ok = true;",
      "    } catch (x) {}",
      "    if (ok) {",
      "      try { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))); } catch (x) {}",
      "    }",
      "  })());",
      "});",
      "self.addEventListener('activate', (e) => {",
      "  // 只接管页面；清旧缓存放在 install 且仅在成功缓存新外壳后做（见上）。",
      "  e.waitUntil((async () => { try { await self.clients.claim(); } catch (x) {} })());",
      "});",
      "self.addEventListener('fetch', (e) => {",
      "  const req = e.request;",
      "  if (req.mode !== 'navigate') return;   // 只接管页面本身",
      "  e.respondWith((async () => {",
      "    try {",
      "      const fresh = await fetch(req, { cache: 'no-store' });",
      "      if (fresh && fresh.ok) { try { const c = await caches.open(CACHE); await c.put('/', fresh.clone()); } catch (e2) {} }",
      "      // 装出来的 App 打开 / 时可能没带 k、也没 cookie（服务端 401）：用缓存的外壳兜底，",
      "      // 外壳 HTML 里内嵌了密钥，页面自己能完成鉴权。",
      "      if (fresh && (fresh.status === 401 || fresh.status === 403)) { const cached = await caches.match(req, { ignoreSearch: true }); if (cached) return cached; }",
      "      return fresh;",
      "    } catch (err) {",
      "      const cached = await caches.match(req, { ignoreSearch: true });",
      "      if (cached) return cached;",
      "      throw err;",
      "    }",
      "  })());",
      "});",
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
      display: 'fullscreen', orientation: 'landscape', background_color: '#0b0b0d', theme_color: '#15161a',
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
    notePush(frameStamp);    // 低频画面送达一帧（同一帧被轮询两次只算一帧）
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
    // 统一走 encodeStream：不带参数/已经够宽时它直接透传原图；带参数时按「帧+参数」缓存，
    // 多台手机看同一帧只编码一次。（原来这里复制了一份 sharp 逻辑和一个单槽缓存 thumb，
    // 与 encodeStream 完全重复，2026-11-06 体检时合并。）
    encodeStream(frame, frameStamp, w, q)
      .then((buf) => {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' });
        res.end(frame);
      });
    return;
  }

  

  res.writeHead(404); res.end('not found');
}

let started = 0;
// 离线模式（局域网/热点）：https 才能拿到安全上下文，WebRTC 才可用（http 下 RTCPeerConnection 被禁）。
// 证书优先用本地 CA（make-lan-ca.ps1）：手机装一次 CA 后永久受信任，可安装成 App、没有证书警告。
function ensureLanCert() {
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const caScript = join(HERE, 'make-lan-ca.ps1');
  const legacyScript = join(HERE, 'make-lan-cert.ps1');
  const script = fileExists(caScript) ? caScript : legacyScript;
  if (!fileExists(script)) { console.log('lan https: 缺证书脚本，退回 http（WebRTC 不可用）'); return null; }
  try {
    execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', HERE], { timeout: 90000, windowsHide: true });
  } catch (e) { console.log('lan https: 生成证书失败 ' + (e && e.message)); }
  // 本地 CA 方案：PFX 带密码（make-lan-ca.ps1 生成 lan-cert.pass），必须一起读，否则 mac verify failure
  try { LAN_PASS = readFileSync(join(HERE, 'lan-cert.pass'), 'utf8').trim(); } catch { LAN_PASS = ''; }
  if (fileExists(caScript)) {
    try { return readFileSync(join(HERE, 'lan-server.pfx')); } catch { }
  }
  try { return readFileSync(join(HERE, 'lan-cert.pfx')); } catch { return null; }
}
let lanPfx = null, lanPfxTried = false, LAN_PASS = '';
let LAN_HTTPS = false;   // 局域网是否真的起来了 https（证书生成失败时退回 http，页面要跟着换成 http 地址）
// 给一个 http(s) server 挂上所有路由/长连接（主监听和局域网 http 备用都要用）
function wireServer(s) {
  rtc.attach(s, (req, url) => {
    if (!sourceAllowed(req)) return false;
    if (!authorized(req, url)) return false;
    // 免费版并发上限同样管流畅模式（RTC）：超限返回一句状态行，页面会提示"设备数已满"。
    if (!isFullFunction()) {
      let peers = 0;
      try { peers = rtc.stats().peers || 0; } catch { }
      if (FREE_MAX_VIEWERS > 0 && streams + peers >= FREE_MAX_VIEWERS) {
        console.log('rtc: 被并发上限拦下 viewers=' + (streams + peers) + ' limit=' + FREE_MAX_VIEWERS);
        return '429 Too Many Viewers';
      }
    }
    return true;
  });
  start264();
  attachH264Ws(s, KEY);
  attachH264Rtc(s, KEY);
  // 实验版 E1：必须在 attachAudioWs **之前**注册 —— 它的 upgrade 处理器会销毁
  // 不在白名单里的 socket，注册晚了光标通道会被自己人掐掉。
  try { attachExpWs(s, KEY); } catch (e) { console.log('exp: /ws-exp 挂载失败（不影响主线）：' + (e && e.message)); }
  attachAudioWs(s, KEY);
  s.on('error', (e) => console.error('screen-server: bind error — ' + (e.code || e.message)));
  return s;
}
for (const host of hosts) {
  const isLanHost = LAN_V4.test(host);
  let proto = 'http';
  let s = null;
  if (isLanHost) {
    if (!lanPfxTried) { lanPfxTried = true; lanPfx = ensureLanCert(); }
    if (lanPfx) {
      try { s = https.createServer({ pfx: lanPfx, passphrase: LAN_PASS }, handler); proto = 'https'; LAN_HTTPS = true; }
      catch (e) { console.log('lan https 启动失败，退回 http：' + (e && e.message)); s = null; }
    }
  }
  if (!s) s = createServer(handler);
  wireServer(s);   // 路由/长连接统一由 wireServer 挂（主监听 + 局域网 http 备用共用）
  s.listen(port, host, () => {
    started++;
    console.log(`screen-server: ${proto}://${host}:${port}/`);
  });
}

// 离线模式：备用监听绑 0.0.0.0（所有网卡）——电脑换网络/开热点/USB 共享后新 IP 立刻能用，
// 不用等守护重启。只绑 8661/8662 这种备用端口：8660 必须保持"回环+tailnet 走 http、局域网 IP 走 https"，
// 否则 tailscale serve 和守护的 /health 会连不上（实测会把服务判死、反复重启 → 502）。
// 局域网监听（两种来路共用 8662 的 HTTPS；8660 永远不动）：
//   OFFLINE_MODE：旧路子，额外绑 8661 明文 http（历史兼容，安全上不推荐）
//   LAN_ONLY    ：新路子，只开 8662 https，密钥仍然必填
if (OFFLINE_MODE || LAN_ONLY) {
  if (OFFLINE_MODE) {
    try {
      const s2 = wireServer(createServer(handler));
      s2.listen(port + 1, '0.0.0.0', () => {
        started++;
        console.log('screen-server: http://0.0.0.0:' + (port + 1) + '/ （备用，不加密；https 打不开时用）');
      });
    } catch (e) { console.log('lan http fallback 失败：' + (e && e.message)); }
  }
  if (!lanPfxTried) { lanPfxTried = true; lanPfx = ensureLanCert(); }
  if (lanPfx) {
    try {
      const s3 = wireServer(https.createServer({ pfx: lanPfx, passphrase: LAN_PASS }, handler));
      s3.listen(port + 2, '0.0.0.0', () => {
        started++;
        LAN_HTTPS = true;                 // 8662 确实在用 https 跑（/lan-check 靠它判断）
        console.log('screen-server: https://0.0.0.0:' + (port + 2) + '/ （局域网直连，仍需要访问密钥）');
      });
    } catch (e) { console.log('lan https 备用端口失败：' + (e && e.message)); }
  } else {
    console.log('screen-server: [w] 局域网证书不可用 → 8662 没起来，局域网直连不可用');
  }
}

// 局域网（离线模式 或 screen.lan）：地址变了（换网络/开热点/USB 共享）就重启一次，
// 让守护按新地址重新绑定。用 Get-NetIPAddress + 网卡 Up 状态判断（os.networkInterfaces 会残留断开网卡的旧地址）。
if (OFFLINE_MODE || LAN_ONLY) {
  let base = lanIpsNow().join(',');
  setInterval(() => {
    try { refreshLanIps(); } catch { }
    const now = lanIpsNow().join(',');
    if (!now) return;                       // 没有可用的局域网地址：不重启（否则会死循环）
    if (!base) { base = now; return; }      // 首次拿到基线
    if (now !== base) {
      console.log('screen-server: 局域网地址变化（' + (base || '无') + ' -> ' + now + '），退出让守护按新地址重新绑定');
      setTimeout(() => { try { process.exit(0); } catch { } }, 300);
    }
  }, 5000).unref?.();
}
