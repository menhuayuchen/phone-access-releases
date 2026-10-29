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

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { randomBytes, createPublicKey, createVerify } from 'node:crypto';
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
const cfgMaxW = Number(cfgScreen.maxCaptureWidth);

const [hostsArg = '127.0.0.1', portArg = String(Number(cfgPorts.screen) || 8660), frameFile = 'screen-latest.jpg',
  keyFile = 'screen.key', viewersFile = 'viewers.count', geometryArg = ''] = process.argv.slice(2);

const hostsArgRaw = hostsArg;
const port = Number(portArg);

// ---- 绑定地址白名单（独立审查 U3）--------------------------------------------
// 加这一层的理由：hosts 是启动脚本按"网卡枚举"生成的，而枚举只排除了 127/169.254/几个
// 虚拟网卡，**没有排除公网地址**。如果某台机器的网卡上直接带公网 IPv4（云主机、某些 VPN），
// 或者将来有人手改成 0.0.0.0，这个服务就会挂到公网上——防火墙只是第二层保险，
// 不该是唯一一层。同理拒绝一切 IPv6：防火墙规则只写了 IPv4 网段，绑 IPv6 等于绕过它。
const PRIVATE_V4 = [
  /^127\./,                                     // 回环
  /^10\./,                                      // RFC1918
  /^192\.168\./,                                // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,                 // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./    // Tailscale / CGNAT（100.64.0.0/10）
];
const badHosts = [];
const hosts = hostsArg.split(',').map((h) => h.trim()).filter(Boolean).filter((h) => {
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  if (!isV4) { badHosts.push(h + '(非 IPv4)'); return false; }
  if (h === '0.0.0.0') { badHosts.push(h + '(通配全部网卡)'); return false; }
  if (!PRIVATE_V4.some((re) => re.test(h))) { badHosts.push(h + '(公网/非私有)'); return false; }
  return true;
});
if (badHosts.length) {
  console.error('screen-server: [安全] 拒绝绑定这些地址：' + badHosts.join('、'));
  console.error('screen-server: 只允许回环、RFC1918、和 Tailscale 的 100.64.0.0/10 网段。');
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
// 宽度上限（与 .ps1 侧 Get-CaptureGeometry 的 maxCaptureWidth 同义）；0 或未配置 = 不额外限制
const CAP_W = (cfgMaxW > 0 && CAP.width > cfgMaxW) ? cfgMaxW : CAP.width;
const CAP_H = CAP_W === CAP.width ? CAP.height : Math.round(CAP.height * CAP_W / CAP.width);

// 流畅模式（WebRTC）输出宽度：默认取抓屏宽的一半（2560→1280，与改动前完全一致）。
// 高度按抓屏宽高比推，并向下取偶数（I420 色度 2x2 抽样要求偶数尺寸）。
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

function attachAudioWs(server, key) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws-audio') return;       // /rtc 由 rtc.mjs 自己处理
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
  if (!w || w >= (sourceState.width || CAP_W)) return Promise.resolve(buf);
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
  const w = CAP_W;
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


function authorized(req, url) {
  if (url.searchParams.get('k') === KEY) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `screen-key=${KEY}`);
}

// 猜密钥的失败计数：同一个来源 10 分钟错 8 次 → 锁 10 分钟，并写一行 screen-auth.log。
// 密钥 64 bit 本来就猜不中，这条是为了让"有人在敲"留下痕迹，而不是无限敲。
const authFails = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LIMIT = 8;

function noteAuthFail(ip, req, url) {
  const now = Date.now();
  let rec = authFails.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) { rec = { count: 0, first: now, until: 0 }; authFails.set(ip, rec); }
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
      `${new Date().toISOString()} 401 ip=${ip} path=${url.pathname} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}\n`);
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
  let chk;
  if (!doc) {
    chk = { ok: false, state: 'missing', message: '这台电脑还没有许可证。' };
  } else {
    chk = checkLicenceObject(doc, machine);
  }

  const data = {
    usable: !!chk.ok,
    state: chk.state || (chk.ok ? 'ok' : 'error'),
    message: chk.message || '',
    machineCode: (chk.payload && chk.payload.machine) || machine || String(disp.machineCode || ''),
    name: (chk.payload && chk.payload.name) || '',
    issued: (chk.payload && chk.payload.issued) || '',
    // 永久许可证在 payload 里存空字符串，对外统一显示成 never（页面和报告都用这个值）
    expires: chk.ok ? ((chk.payload && chk.payload.expires) || 'never') : '',
    edition: (chk.payload && chk.payload.edition) || '',
    // 展示用：购买/捐赠入口由 PowerShell 扫 branding 目录得出，与授权无关
    support: disp.support || null,
    branding: disp.branding || null
  };
  licenceCache = { stamp: stamp, data: data };
  return data;
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

function checkLicenceObject(doc, machineOverride) {
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

  const mine = String(machineOverride == null ? readMachineCode() : machineOverride || '').toUpperCase();
  if (mine && String(p.machine).toUpperCase() !== mine) {
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
    const exp = new Date(Date.UTC(y, mo - 1, d, 23, 59, 59));
    // 反向校验：防止 2026-02-31 这种被 Date 自动进位的假日期
    if (exp.getUTCFullYear() !== y || (exp.getUTCMonth() + 1) !== mo || exp.getUTCDate() !== d) {
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

// 未授权时仍然可以访问的路径：页面、清单、健康检查、图标、许可证信息
// （/licence 的 POST 也在这个集合里：客户正是要在未授权状态下把许可证交上来）
const LICENCE_OPEN_PATHS = new Set([
  '/', '/licence', '/manifest.json', '/health', '/icon-192.png', '/icon-512.png'
]);

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // ---- 统一鉴权闸门 --------------------------------------------------------
  // 以前 /input、/mode、/unblock、/rtc-*、/sources、/cursor、/manifest.json、/health
  // 都写在 authorized() 检查**之前**，等于局域网里任何一台设备不拿密钥就能控制这台电脑
  // （/manifest.json 还会把密钥本身发出去）。现在除了"本机自连"（本机脚本读 /health）
  // 之外，所有路由都先过这道门。
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const la = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
  const isLocalConn = ra === '127.0.0.1' || ra === '::1' || (ra && ra === la);
  if (!isLocalConn && !authorized(req, url)) {
    rejectAuth(req, res, url, ra);
    return;
  }

  // ---- 第二道鉴权：危险接口不吃"本机自连"豁免 --------------------------------
  // 事故背景（独立审查 H1 + 本机实测确认）：
  //   Tailscale serve 把 https://<机器名>.ts.net/ 转发到 127.0.0.1:8660，
  //   于是**从手机/外网来的请求，在服务端看起来就是本机连接**（remoteAddress=127.0.0.1），
  //   上面那道 isLocalConn 豁免直接把闸门让开了。
  //   实测不带任何密钥就能：列窗口（/sources）、读光标（/cursor）、
  //   **注入鼠标键盘（/input）**、切换抓屏源（/mode）——等于盲控这台电脑。
  //   （/exec 当初单独加了防护，所以它反而是安全的；/frame.jpg 与 / 走下面的第二道
  //     严格鉴权，所以看不到屏幕。攻击者能"盲打"，不能"看"。）
  //
  //   修法：下面这些接口一律要求密钥，与来源地址无关。
  //   /health 仍然享受豁免——守护进程每 8 秒用它探活，改掉会引发重启风暴；
  //   它只读、不改状态（后续再单独收紧）。
  const STRICT_AUTH_PATHS = new Set([
    '/input', '/mode', '/unblock', '/showdesktop',
    '/rtc-on', '/rtc-off', '/rtc-quality', '/sources', '/cursor'
  ]);
  if (STRICT_AUTH_PATHS.has(url.pathname)) {
    if (!authorized(req, url)) {
      rejectAuth(req, res, url, ra);
      return;
    }
    // 第二层（独立审查 M4）：跨站请求一律拒绝。
    // 密钥本身已经挡住了恶意网页的 <form>（表单带不了查询参数/自定义头），
    // 这里再加一道同源校验，防止有人用 fetch 的 no-cors 之类绕过预期路径。
    // 只校验"带了 Origin 且与 Host 不一致"的情况：命令行工具通常不发 Origin，
    // 那样的情况继续允许（它们已经带了密钥）。
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

  // ---- 许可证闸门（软停）--------------------------------------------------
  // 放在鉴权之后：没密钥的人先被拒，有密钥但没授权的才走到这里看到 402。
  // 用 402 Payment Required 而不是 401，是为了让前端能区分"没钥匙"和"没买"。
  // /branding/ 下的图片（收款码）必须放行：未授权客户正要靠它找到购买方式。
  const isBrandingAsset = url.pathname.startsWith('/branding/') && /\.(png|jpe?g)$/i.test(url.pathname);
  if (!LICENCE_OPEN_PATHS.has(url.pathname) && !isBrandingAsset) {
    const lic = readLicence();
    if (!lic.usable) {
      res.writeHead(402, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('licence-required');
      return;
    }
  }

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
      usable: !!lic.usable,
      state: lic.state || 'missing',
      machineCode: lic.machineCode || '',
      name: lic.name || '',
      expires: lic.expires || '',
      message: lic.message || '',
      support: support,
      // 当前抓屏宽度上限（手机「设置」里高亮当前画质档位用）
      captureWidth: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\\uFEFF/, '')); return Number((c.screen && c.screen.maxCaptureWidth) || 0) || 0; } catch { return 0; } })(),
      // 版本号给手机「设置」显示；来源是 product.config.json 的 version
      version: (function () { try { const c = JSON.parse(readFileSync(join(HERE, 'product.config.json'), 'utf8').replace(/^\\uFEFF/, '')); return String(c.version || ''); } catch { return ''; } })(),
      // branding 由 licence-state.ps1 扫描 branding\ 目录得出（收款码、联系方式），
      // 必须一起返回，否则页面拿不到二维码和联系方式的路径。
      branding: lic.branding || null
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
    res.writeHead(frame ? 200 : 503, { 'content-type': 'text/plain' });
    res.end((frame ? 'ok' : 'no-frame') + ' viewers=' + wanted() + ' source=' + (pipeOk ? 'pipe' : 'file')
        + ' age=' + (frameStamp ? ((Date.now() - frameStamp) / 1000).toFixed(1) : -1)
        + ' dropped=' + droppedTotal + ' cap=' + CAP_LEVELS[capLevel] + ' in=' + currentInFps() + ' out=' + currentOutFps() + ' drop10=' + recentDrops(10, healthSid) + ' lag=' + lastLagFrames
        + ' mode=' + sourceState.mode + ' raw=' + (rawStamp ? ((Date.now() - rawStamp) / 1000).toFixed(1) : -1)
        + ' blk=' + st.blocked + ' blkage=' + st.ageMs + fgField
        + ' rtc=' + JSON.stringify(rtc.stats()) + ' input=' + JSON.stringify(inForOut));
    return;
  }

  // ---- 画质档位（改抓屏宽度，直接影响帧率/延迟/流量）--------------------------
  // 为什么必须重启：抓屏宽度是 capture.exe 的启动参数，CAP_W 在服务启动时算好就固定了。
  // 所以只能"写配置 -> 主动退出 -> 守护进程用新配置把它拉起来"（约 8 秒）。
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
      const qold = Number(qcfg.screen.maxCaptureWidth || 0);
      qcfg.screen.maxCaptureWidth = w;
      try {
        writeFileSync(qcfgPath, JSON.stringify(qcfg, null, 2), 'utf8');
      } catch (e) {
        return qreply(500, { ok: false, message: '写配置文件失败：' + e.message });
      }
      console.log('screen-server: capture width ' + qold + ' -> ' + w + '，准备重启生效');
      // 改动：不再自动退出。抓屏几何是 start-screen.ps1 启动时作为参数传进来的，
      // 光重启 screen-server 只会继承旧参数（实测：配置写 2560，capture.mode 里仍是 1440）。
      // 所以这里只保存，由用户点桌面「重启」走完整重启流程，才能真正换分辨率。
      qreply(200, { ok: true, captureWidth: w, previous: qold, restarting: false, needFullRestart: true, message: '已保存。双击桌面「手机远程」里的「重启」后生效。' });
    });
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
    if (!src) {
      // 没配更新源也不装作能更新：老实说清楚当前版本，让客户联系卖家
      reply(200, { configured: false, current: current, hasUpdate: false });
      return;
    }
    if (!/^https?:\/\//i.test(src)) {
      reply(200, { configured: false, current: current, hasUpdate: false, error: '更新地址格式不对（要 http/https）' });
      return;
    }
    const timeoutMs = Math.max(2000, Math.min(20000, Number(upd.timeoutMs) || 8000));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    (async () => {
      try {
        const r = await fetch(src, { signal: ac.signal, headers: { 'cache-control': 'no-cache' } });
        if (!r.ok) { reply(200, { configured: true, current: current, hasUpdate: false, error: '更新服务返回 ' + r.status }); return; }
        const j = await r.json();
        const latest = String((j && j.version) || '');
        // 版本比较：按数字段逐段比，非数字按字符串兜底（够用，不引第三方库）
        const cmp = (a, b) => {
          const pa = a.split(/[.\-+]/), pb = b.split(/[.\-+]/);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] || '0', y = pb[i] || '0';
            const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
            if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
            else { if (x !== y) return x < y ? -1 : 1; }
          }
          return 0;
        };
        const hasUpdate = !!(latest && current && cmp(latest, current) > 0);
        reply(200, {
          configured: true,
          current: current,
          latest: latest,
          hasUpdate: hasUpdate,
          notes: String((j && j.notes) || ''),
          downloadUrl: String((j && j.url) || '')
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
    // 现在写回实际抓屏宽度 CAP_W（与 publishViewers() 一致），非 2560 的机器不会再白抖一下。
    sourceState.width = CAP_W;
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
          sourceState.width = Math.max(0, Math.min(CAP_W, Math.round(m.width)));
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
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'max-age=86400' });
    res.end(JSON.stringify({
      name: '电脑画面', short_name: '电脑画面', start_url: `/?k=${encodeURIComponent(KEY)}`,
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
    res.end(PAGE(KEY));
    return;
  }

  if (url.pathname === '/frame.jpg') {
    lastPoll = Date.now();   // polling counts as watching (low-bandwidth mode)
    if (!frame) { res.writeHead(503); res.end('no frame yet'); return; }
    // 省流量模式可以要求缩小的副本：?w=1280&q=45 会缩放+重编码，同一帧只算一次，
    // 结果缓存到下一帧到来。不带参数时行为不变（原图）。
    const wRaw = Number(url.searchParams.get('w') || 0);
    const qRaw = Number(url.searchParams.get('q') || 0);
    // 改动（P0-3）：上限从写死 2560 改成实际抓屏宽度 CAP_W（1920 的机器上不会再被"允许"到 2560）
    const w = Number.isFinite(wRaw) ? Math.max(0, Math.min(CAP_W, Math.round(wRaw))) : 0;
    const q = Number.isFinite(qRaw) && qRaw > 0 ? Math.max(20, Math.min(95, Math.round(qRaw))) : 0;
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
    // 改动（P0-3）：上限从写死 2560 改成实际抓屏宽度 CAP_W（同 /frame.jpg）
    const reqW = Number.isFinite(wRaw) ? Math.max(0, Math.min(CAP_W, Math.round(wRaw))) : 0;
    const reqQ = Number.isFinite(qRaw) && qRaw > 0 ? Math.max(20, Math.min(95, Math.round(qRaw))) : 0;
    const sid = String(url.searchParams.get('s') || '').slice(0, 24);   // 丢帧按会话统计
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
  rtc.attach(s, (req, url) => authorized(req, url));
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
