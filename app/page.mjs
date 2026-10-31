const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>电脑画面</title>
<!-- 改动（第二轮 P0-1 / H1-r1）：清单地址由服务端渲染时现签注入（占位符见下行 href）。
     为什么不能写死 /manifest.json：浏览器取清单时**不带 cookie**（实测 Chrome 156），
     所以清单必须靠页面里签出来的短时 token 过鉴权；裸 GET /manifest.json 仍然是 401。
     原来的 ?v=2 作用不变：把手机上缓存过的旧清单（带过密钥、max-age=86400）换成新 URL。 -->
<link rel="manifest" href="__MANIFEST_HREF__">
<meta name="theme-color" content="#15161a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { margin:0; background:#0b0b0d; color:#c9ccd1; font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex; flex-direction:column; height:100dvh; overflow:hidden; overscroll-behavior:none; }
header { display:flex; gap:6px; align-items:center; padding:6px 8px; background:#15161a; flex-wrap:wrap;
         border-bottom:1px solid #24262b; }
button { background:#24262b; color:#c9ccd1; border:1px solid #33363d; border-radius:8px; padding:6px 9px;
         font:inherit; cursor:pointer; }
button.on { background:#2f6f3f; border-color:#3f8f53; color:#e8ffe9; }
button:active { transform:scale(0.97); }
select { background:#24262b; color:#c9ccd1; border:1px solid #33363d; border-radius:8px; padding:6px; font:inherit;
         max-width:34vw; }
#spacer { flex:1 }
#stat { color:#7d838c; font-size:12px }
#hud { color:#7d838c; font-variant-numeric:tabular-nums; font-size:12px }
#blk { position:absolute; left:50%; top:10px; transform:translateX(-50%); display:none;
       background:rgba(120,32,32,0.92); color:#ffe9e9; border:1px solid #b04a4a; border-radius:10px;
       padding:8px 12px; font-size:13px; z-index:8; max-width:90vw; line-height:1.45; }
#blk b { color:#fff }
#blk button { margin-left:8px; background:#ffe9e9; color:#7a1f1f; border:0; border-radius:7px;
              padding:5px 9px; font:inherit; font-weight:600; }
#stage { flex:1; position:relative; overflow:hidden; background:#000; touch-action:none; }
#img, #vid { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:none; background:#000; }
#img.show, #vid.show { display:block; }
#overlay { position:absolute; inset:0; z-index:5; touch-action:none; }
#overlay.off { pointer-events:none; }
#note { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); color:#8b9099; font-size:13px;
        text-align:center; pointer-events:none; z-index:6; }
.ripple { position:absolute; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%;
          border:2px solid #6ee7a0; opacity:0.9; pointer-events:none; z-index:7;
          animation: rip 420ms ease-out forwards; }
@keyframes rip { to { transform:scale(1.9); opacity:0; } }
.cursorDot { position:absolute; width:10px; height:10px; margin:-5px 0 0 -5px; border-radius:50%;
             background:#ffd166; box-shadow:0 0 6px #000; pointer-events:none; z-index:7; display:none; }
#hint { padding:5px 10px; color:#6b7079; font-size:12px; background:#101114; }
#kbbar { position:absolute; left:0; right:0; bottom:0; z-index:9; display:none; gap:6px; padding:8px;
         background:#181a1f; border-top:1px solid #2b2e35; }
#kbbar.on { display:flex; }
#kbtext { flex:1; min-height:40px; max-height:120px; background:#22252b; color:#e6e8eb; border:1px solid #34383f;
          border-radius:8px; padding:8px; font:inherit; resize:none; }
#kbsend { align-self:flex-end; }
/* 追加：特殊键按钮行的布局。kbbar 允许换行后，原来 textarea + 发送 仍占第一行，
   #keysrow 和 #keynote 用 flex-basis:100% 各自独占一整行，不影响原有排版 */
#kbbar { flex-wrap: wrap; }
#keysrow { flex:0 0 100%; display:flex; flex-wrap:wrap; gap:6px; }
#keysrow .kbtn { flex:1 1 auto; min-width:58px; padding:9px 8px; touch-action:manipulation; }
#keysrow .kbtn.down { background:#31527a; border-color:#4a7cb0; color:#eaf3ff; transform:scale(0.97); }
#keysrow .kundo { flex:1 1 100%; background:#3a2f24; border-color:#5c4a38; color:#ffd9b0; }
#keysrow .kundo.down { background:#5b452f; border-color:#8a6a48; }
#keynote { flex:0 0 100%; color:#6b7079; font-size:11px; line-height:1.35; }
#stage:focus { outline:none; }
#cmdbar { position:absolute; left:0; right:0; bottom:0; z-index:10; display:none; flex-direction:column; gap:6px;
          padding:8px; background:#181a1f; border-top:1px solid #2b2e35; }
#cmdbar.on { display:flex; }
#cmdtext { width:100%; min-height:48px; max-height:140px; background:#22252b; color:#e6e8eb;
           border:1px solid #34383f; border-radius:8px; padding:8px; font:inherit; resize:none; }
#cmdrow { display:flex; gap:6px; align-items:center; }
#cmdrun { flex:0 0 auto; }
#cmdhint { color:#6b7079; font-size:11px; flex:1; }
#cmdout { max-height:38vh; overflow:auto; margin:0; padding:8px; background:#0e1013; color:#c9d1d9;
          border:1px solid #2b2e35; border-radius:8px; display:none;
          font:12px/1.45 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
#cmdout.on { display:block; }
</style>
</head><body>
<header>
  <button id="mCrisp">清晰</button>
  <button id="mSmooth">流畅</button>
  <select id="src"><option value="m-1">全部屏幕</option></select>
  <button id="deskBtn" title="最小化所有窗口，露出桌面">桌面</button>
  <button id="snd">声音</button>
  <button id="ctl">控制</button>
  <button id="kbBtn">输入</button>
  <button id="lowbw">省流量</button>
  <button id="cmdBtn">命令</button>
  <span id="spacer"></span>
  <span id="stat">连接中…</span>
  <span id="hud"></span>
</header>
<!-- tabindex="-1"：画面区作为「焦点回收站」，点完特殊键按钮把焦点收回到这里，
     否则焦点留在按钮上，物理键盘按空格/回车会再次触发那个按钮 -->
<div id="stage" tabindex="-1">
  <img id="img" alt="">
  <video id="vid" playsinline autoplay muted></video>
  <div id="blk"></div>
  <div id="overlay"></div>
  <div class="cursorDot" id="dot"></div>
  <div id="note"></div>
  <div id="kbbar">
    <textarea id="kbtext" rows="1" placeholder="在这里打字，发到电脑…" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    <button id="kbsend">发送</button>
    <!-- 特殊键按钮：接物理键盘之前也能敲退格/删除/方向键。
         按下发 key down、抬起发 key up；data-vk 是 Windows 虚拟键码 -->
    <div id="keysrow">
      <button class="kbtn" data-vk="8">退格</button>
      <button class="kbtn" data-vk="46">删除</button>
      <button class="kbtn" data-vk="13">回车</button>
      <button class="kbtn" data-vk="27">Esc</button>
      <button class="kbtn" data-vk="9">Tab</button>
      <button class="kbtn" data-vk="37" title="左方向键">←</button>
      <button class="kbtn" data-vk="38" title="上方向键">↑</button>
      <button class="kbtn" data-vk="40" title="下方向键">↓</button>
      <button class="kbtn" data-vk="39" title="右方向键">→</button>
      <button class="kbtn kundo" id="kbundo">撤销(Ctrl+Z)</button>
    </div>
    <!-- 这一行必须写清楚：说成「撤回」就是假承诺。发出去的字是模拟键盘敲进电脑前台窗口的，
         系统层面收不回来；Ctrl+Z 只是让电脑上的软件自己撤销，能不能撤由那个软件决定 -->
    <div id="keynote">撤销 = 给电脑发一次 Ctrl+Z，由电脑上的软件自己执行，只对支持撤销的窗口有效（记事本/Word/浏览器）；已经敲进去的文字系统层面收不回来。</div>
  </div>
  <div id="cmdbar">
    <textarea id="cmdtext" rows="2" placeholder="PowerShell 命令，在这台电脑上执行…（Ctrl+Enter 运行）" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    <div id="cmdrow">
      <button id="cmdrun">执行</button>
      <button id="cmdclr">清空</button>
      <span id="cmdhint">结果只回显最后 20000 字符</span>
    </div>
    <pre id="cmdout"></pre>
  </div>
</div>
<div id="hint">点哪指哪：黄点跟着手指走 · 单击=左键 · 拖动=拖拽 · 双击=双击 · 长按=右键 · 双指滑=滚轮</div>
<script>
const KEY = "__KEY__";
  const SID = Math.random().toString(36).slice(2, 10);   // 本页会话 id：服务端按它统计丢帧，互不干扰
const stage = document.getElementById('stage');
let img = document.getElementById('img');
const vid = document.getElementById('vid');
// 流畅模式的真实帧率只能在客户端数：视频元素每解出一帧就回调一次
let vfcCount = 0, vfcLast = 0, vfcAt = 0, vfcFps = 0;
if (vid.requestVideoFrameCallback) {
  const tick = () => { vfcCount++; vid.requestVideoFrameCallback(tick); };
  vid.requestVideoFrameCallback(tick);
}
function videoFrameCount() {
  if (vid.requestVideoFrameCallback) return vfcCount;
  try { const q = vid.getVideoPlaybackQuality ? vid.getVideoPlaybackQuality() : null; return q ? q.totalVideoFrames : 0; } catch (e) { return 0; }
}
const overlay = document.getElementById('overlay');
const dot = document.getElementById('dot');
const note = document.getElementById('note');
const stat = document.getElementById('stat');
const hud = document.getElementById('hud');
const blk = document.getElementById('blk');
let lastBlk = -1, blkAt = 0;
const hint = document.getElementById('hint');
const btnCrisp = document.getElementById('mCrisp');
const btnSmooth = document.getElementById('mSmooth');
const srcSel = document.getElementById('src');
const btnSnd = document.getElementById('snd');
const btnCtl = document.getElementById('ctl');
const btnDesk = document.getElementById('deskBtn');
const btnKb = document.getElementById('kbBtn');
const btnLow = document.getElementById('lowbw');
const kbbar = document.getElementById('kbbar');
const kbtext = document.getElementById('kbtext');
const kbsend = document.getElementById('kbsend');
const btnCmd = document.getElementById('cmdBtn');
const cmdbar = document.getElementById('cmdbar');
const cmdtext = document.getElementById('cmdtext');
const cmdrun = document.getElementById('cmdrun');
const cmdclr = document.getElementById('cmdclr');
const cmdout = document.getElementById('cmdout');

const state = {
  mode: 'mjpeg', monitor: -1, window: 0, lowBw: false,
  control: localStorage.getItem('ctl') !== '0',   // 默认开启：点屏幕就该有反应
  audio: false, rect: null, monitors: [], windows: []
};
let stopped = document.hidden, lowTimer = null, pc = null, ws = null, statsTimer = null, noteTimer = null, rtcRetry = 0, videoWatch = null, gotVideo = false;
let srcTimer = null, srcSig = '';

function setStat(t) { stat.textContent = t; }
// 居中的临时提示：显示 ms 毫秒后自动消失（默认 5 秒），避免"已切换来源"一直挡在画面中间
function setNote(t, ms) {
  note.textContent = t || '';
  if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
  if (!t) return;
  noteTimer = setTimeout(() => {
    note.textContent = '';
    noteTimer = null;
  }, ms || 5000);
}
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

// ---- 来源列表 --------------------------------------------------------------
// 实时刷新：每 2 秒拉一次 /sources，只有列表真的变了才重建 <option>（不闪、不打断选择）。
// 用户正拉开下拉框时不重建，等下一次轮询再补上。
function sourcesSig() {
  const m = state.monitors.map((x) => x.i + ':' + x.w + 'x' + x.h).join('|');
  const w = state.windows.map((x) => x.hwnd + ':' + x.title).join('|');
  return m + '#' + w;
}

// HTML 转义。窗口标题、前台窗口名这些内容来自电脑上**任意程序**（任何网页都能改自己
// 的标题），属于不可信输入。凡是必须拼进 innerHTML 的地方一律先过这个函数。
// 事故背景（独立审查 H2）：标题原来直接拼进 innerHTML，恶意网页把自己的标题设成
// <img src=x onerror="fetch('/licence')..."> 之类的字符串，就能在手机页面上执行脚本，
// 进而窃取访问密钥 → 完全接管这台电脑。
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rebuildSourceOptions() {
  // 这里刻意改用 DOM API 而不是 innerHTML：option 的文字用 textContent 写入，
  // 浏览器会把任何 < > & 当普通字符处理，从根上不存在注入的可能（比转义更稳）。
  const addOpt = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    srcSel.appendChild(o);
  };
  while (srcSel.firstChild) srcSel.removeChild(srcSel.firstChild);
  addOpt('m-1', '全部屏幕');
  for (const m of state.monitors) {
    addOpt('m' + m.i, '显示器 ' + (m.i + 1) + '（' + m.w + '×' + m.h + '）');
  }
  for (const w of state.windows) {
    addOpt('w' + w.hwnd, '窗口：' + String(w.title == null ? '' : w.title).slice(0, 30));
  }
  const want = state.window ? 'w' + state.window : 'm' + (state.monitor >= 0 ? state.monitor : -1);
  if ([...srcSel.options].some((o) => o.value === want)) srcSel.value = want;
  applyRect();
}

async function loadSources(force) {
  try {
    const r = await fetch('/sources', { cache: 'no-store' });
    const j = await r.json();
    const nextMonitors = j.monitors || [];
    const nextWindows = j.windows || [];
    const nextSig = nextMonitors.map((x) => x.i + ':' + x.x + ',' + x.y + ':' + x.w + 'x' + x.h).join('|')
      + '#' + nextWindows.map((x) => x.hwnd + ':' + x.x + ',' + x.y + ':' + x.w + 'x' + x.h + ':' + x.title).join('|');
    if (!force && nextSig === srcSig) { state.monitors = nextMonitors; state.windows = nextWindows; return; }
    state.monitors = nextMonitors;
    state.windows = nextWindows;
    srcSig = nextSig;
    // 下拉框正开着就别重建（会把列表关掉），下一轮再说
    if (document.activeElement === srcSel && !force) return;
    rebuildSourceOptions();
    // 选中的窗口已经关掉了 → 自动切回"全部屏幕"，别让画面停在不存在的东西上
    if (state.window && !state.windows.some((x) => x.hwnd === state.window)) {
      state.window = 0; state.monitor = -1; applyRect();
      postMode({ monitor: -1, window: 0 });
      setNote('来源窗口已关闭，已切回全部屏幕');
      if (state.mode === 'mjpeg') restartImg();
    }
  } catch (e) { console.log('sources failed', e); }
}

function startSourcesPolling() {
  if (srcTimer) clearInterval(srcTimer);
  srcTimer = setInterval(() => { if (!stopped) loadSources(false); }, 2000);
}

// 「全部屏幕」时整块虚拟桌面就是抓屏矩形；以前这里返回 null，
// 坐标换算就会退化成「按视频像素算」，流畅模式帧是 1280 宽，点位直接缩到一半 —— 触屏全错。
function desktopRect() {
  const ms = state.monitors || [];
  if (!ms.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of ms) {
    x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w); y1 = Math.max(y1, m.y + m.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function currentRect() {
  if (state.window) {
    const w = (state.windows || []).find((x) => x.hwnd === state.window);
    if (w) return { x: w.x, y: w.y, w: w.w, h: w.h };
  }
  if (state.monitor >= 0 && state.monitors[state.monitor]) {
    const m = state.monitors[state.monitor];
    return { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  return desktopRect();   // 全部屏幕（monitor=-1, window=0）
}
function applyRect() { state.rect = currentRect(); }

srcSel.addEventListener('change', async () => {
  const v = srcSel.value;
  if (v.startsWith('m')) { state.monitor = Number(v.slice(1)); state.window = 0; }
  else if (v.startsWith('w')) { state.window = Number(v.slice(1)); state.monitor = -1; }
  applyRect();
  await postMode({ monitor: state.monitor, window: state.window });
  setNote('已切换来源');
  buzz(8);
  if (state.mode === 'mjpeg') restartImg(); else restartRtc();
});

async function postMode(patch) {
  Object.assign(state, patch);
  try {
    await fetch('/mode', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'mjpeg', monitor: state.monitor, window: state.window,
        width: state.mode === 'raw' ? 1280 : 2560 }) });
  } catch (e) { console.log('mode failed', e); }
}

// ---- 清晰模式（MJPEG）------------------------------------------------------
// 省流量：每 500ms 拉一张缩小+低质量的 JPEG（/frame.jpg?w=&q=），不再走 MJPEG 流。
// 全分辨率一张约 390KB、2 帧/秒 = 780KB/s；1280 宽 q45 只有几十 KB，省一个数量级。
// 省流量的轮询间隔（毫秒）。HUD 文案引用它，避免改了间隔界面还骗人。
const LOWBW_MS = 200;
function lowBwWidth() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = window.innerWidth || 1280;
  return Math.max(480, Math.min(1280, Math.round(cssW * dpr)));
}
function lowBwUrl() {
  return '/frame.jpg?k=' + encodeURIComponent(KEY) + '&w=' + lowBwWidth() + '&q=45&t=' + Date.now();
}
// ---- 清晰模式的带宽自适应 ---------------------------------------------------
// 远处（4G / Tailscale 中继）推不动 2560×1600 全帧：一帧约 190KB，24fps ≈ 36Mbps，
// 服务端只能不停丢帧，表现为"越来越卡、延迟越来越大"。这里按服务端回报的丢帧数
// 和排队帧数自动降档（1280 宽一帧约 45KB），带宽够了再自己升回去。
const W_LADDER = [2560, 1920];   // 只保留"满清晰"和"应急半档"两级：同一 Wi-Fi 下 2560 能跑满就不许乱跳
// 默认就是 2560 满清晰，只有连续两次真的塞满才退到 1920（60 秒内不再升回，避免来回跳）
let streamW = 2560;   // 默认满清晰（Wi-Fi 直连实测 24.5fps 0 丢帧）；真塞满了才自动降档
let goodPolls = 0;
let badPolls = 0;
let holdUntil = 0;      // 降档后 60 秒内不再升回去，避免在临界链路上来回跳（每次跳都要重开流）
// 往返延迟：直接量 /health 的往返时间。局域网 2~5ms；Tailscale 中继（DERP）200~500ms。
// 这个数决定"要不要压码率/是否该改用流畅模式"，HUD 里也直接显示。
let rttMs = 0;
let rttHist = [];
let advisedSlow = false;
// 调试用：?rtt=300 可以假装链路延迟是 300ms，用来验证降码率/降档逻辑（正常访问不带即可）
const rttForce = Number(new URLSearchParams(location.search).get('rtt') || 0);

function streamUrl() {
  const base = '/stream?k=' + encodeURIComponent(KEY) + '&s=' + SID;   // SID：丢帧只算自己这条流
  if (streamW >= 2560) return base + '&t=' + Date.now();      // 全速：透传抓屏原始 JPEG
  return base + '&w=' + streamW + '&q=65&t=' + Date.now();     // 窄带：服务端缩小后再发
}

function setStreamW(w) {
  if (w === streamW) return;
  const down = w < streamW;
  streamW = w;
  goodPolls = 0;
  badPolls = 0;
  if (down) holdUntil = Date.now() + 60000;
  try { setNote(down ? ('带宽不够，清晰度降到 ' + w + ' 宽') : ('清晰度提到 ' + w + ' 宽'), down ? 4000 : 2500); } catch (e) {}
  if (state.mode === 'mjpeg' && !state.lowBw && !stopped) {
    abortStream();
    setTimeout(() => { if (!stopped && state.mode === 'mjpeg' && !state.lowBw) showStream(); }, 120);
  }
}

function adaptStream(outFps, inFps, drops, lag) {
  if (state.mode !== 'mjpeg' || state.lowBw || stopped || !imgOkAt) return;
  const idx = Math.max(0, W_LADDER.indexOf(streamW));
  // 只有两级：2560 → 1920。降档必须是"连续两次都塞满"才动，避免一次抖动就换流导致画面跳。
  const canDown = idx < W_LADDER.length - 1;
  const starved = inFps >= 8 && outFps < inFps * 0.85;   // 抓屏本身没跑起来（刚重启）时不算塞车
  if (drops >= 10 || lag >= 4) {
    goodPolls = 0;
    if (++badPolls >= 2 && canDown) { badPolls = 0; setStreamW(W_LADDER[idx + 1]); }
    return;
  }
  if (starved) {                                  // 帧率跟不上但还没报丢
    if (++badPolls >= 2 && canDown) { badPolls = 0; setStreamW(W_LADDER[idx + 1]); }
    return;
  }
  badPolls = 0;
  const healthy = drops === 0 && lag <= 1 && inFps > 0 && outFps >= inFps * 0.9;
  if (healthy) {
    if (++goodPolls >= 6 && idx > 0 && Date.now() > holdUntil) { goodPolls = 0; setStreamW(W_LADDER[idx - 1]); }
  } else goodPolls = 0;
}

let swapGen = 0;
// 双缓冲换流：新的 <img> 先隐形加载，等它出第一帧再顶掉旧的。
// 换档、断流重连、服务器重启都不会再黑一下屏。
function showStream() {
  if (!img.classList.contains('show')) return;
  const old = img;
  const ni = document.createElement('img');
  ni.id = 'img';
  ni.className = 'show';
  ni.style.opacity = '0';
  bindImg(ni);
  const myGen = ++swapGen;
  let done = false;
  const discard = () => { try { ni.removeAttribute('src'); } catch (e) {} ni.remove(); };
  const up = () => {
    if (done) return;
    if (myGen !== swapGen || state.mode !== 'mjpeg') { done = true; discard(); return; }
    // 新的还没解出画面时，绝不能把旧的摘掉——否则服务端一重启，屏幕就黑着等十几秒。
    // 旧帧停在那是"卡住"，用户能接受；黑屏不行。
    if (!ni.naturalWidth && old.isConnected && old.naturalWidth) { setTimeout(up, 900); return; }
    done = true;
    ni.style.opacity = '';
    img = ni;
    try { old.removeAttribute('src'); } catch (e) {}   // 关掉旧流，别让服务端挂着两条连接
    old.remove();
  };
  ni.addEventListener('load', up);
  ni.addEventListener('error', () => { if (!done) { done = true; discard(); } });
  ni.src = streamUrl();
  stage.appendChild(ni);
  setTimeout(up, 1200);   // 兜底：1.2 秒还没出画面就再看一眼（旧帧还在就继续等）
}
function stopLowBw() {
  if (lowTimer) { clearInterval(lowTimer); lowTimer = null; }
}
function startLowBw() {
  stopLowBw();
  if (!img.classList.contains('show')) return;
  img.src = lowBwUrl();
  // 改动：500ms -> 200ms（2fps -> 5fps）。
  // 原来 2fps 是「只看一眼」的极端省流量，但用来点东西几乎没法操作（用户反馈很卡）。
  // 5fps 流量仍约为正常模式的十分之一，却能看清点击落点。
  lowTimer = setInterval(() => {
    if (stopped || state.mode !== 'mjpeg') return;
    img.src = lowBwUrl();
  }, LOWBW_MS);
}
// 中止当前 MJPEG 请求。注意：实测**换 <img> 元素不会**中止旧的流，旧连接会一直挂在
// 服务端（viewers 涨、浏览器每域 6 条连接被占满，之后所有请求都卡住）。
// 可靠做法是清掉 src，让浏览器主动断开这条响应。
function abortStream() {
  try { img.removeAttribute('src'); } catch (e) {}
}

function restartImg() {
  stopLowBw();
  img.classList.add('show');
  vid.classList.remove('show');
  imgOkAt = Date.now();
  // 切换来源/切模式后要重新按当前状态决定走流还是走轮询，否则省流量会静默失效
  if (state.lowBw && state.mode === 'mjpeg') startLowBw(); else showStream();
}
// ---- 流畅模式（WebRTC）-----------------------------------------------------
function stopRtc() {
  clearTimeout(videoWatch);
  // 关旧连接前先摘掉回调：否则旧 socket 的 onclose 会在新连接建好之后才触发，
  // 把刚建好的连接又重启一次，形成「每 1.5 秒重连一次」的循环。
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (e) {}
    ws = null;
  }
  if (pc) { try { pc.onconnectionstatechange = null; pc.close(); } catch (e) {} pc = null; }
  vid.srcObject = null;
}

// 按测到的 RTT 决定流畅模式的码率：局域网吃满 3Mbps/15fps，走中继时压到 0.9Mbps/10fps，
// 否则 3Mbps 的流在中继上只会一直丢包、卡成 PPT。
let rtcQAt = 0;
let lastQ = { kbps: 3000, fps: 15 };
function rtcTargets() {
  if (rttMs >= 250) return { kbps: 900, fps: 10 };
  if (rttMs >= 150) return { kbps: 1500, fps: 12 };
  return { kbps: 3000, fps: 15 };
}
// 码率/帧率只能在"建 track 之前"可靠生效：@roamhq/wrtc 的 sender.setParameters 只在
// 第一次调用时成功，之后再改会静默失败。所以真正改档 = 先把参数发给服务端，再重连一次
// （只在线路等级变化时发生，45 秒内最多一次）。
let qAppliedKey = '';
async function pushRtcQuality() {
  const tgt = rtcTargets();
  qAppliedKey = tgt.kbps + '/' + tgt.fps;
  lastQ = tgt;
  rtcQAt = Date.now();
  try { await fetch('/rtc-quality?kbps=' + tgt.kbps + '&fps=' + tgt.fps, { method: 'POST' }); } catch (e) {}
  return tgt;
}


async function restartRtc() {
  stopRtc();
  // 服务器重启后 rtcMode 会回到 false，重连前再打开一次，否则服务端不喂帧、只有声音。
  // 再等抓屏真的产出帧（age<3）才连，否则服务端只能给音频轨，画面会是空的。
  if (state.mode === 'raw') {
    try { await fetch('/rtc-on', { method: 'POST' }); } catch (e) {}
    await pushRtcQuality();   // 必须在建连之前：服务端建 track 时就用这个码率，之后再改不一定生效
    for (let i = 0; i < 10; i++) {
      let age = 99;
      try {
        const txt = await (await fetch('/health?s=' + SID, { cache: 'no-store' })).text();
        const m = /age=([0-9.]+)/.exec(txt);
        if (m) age = Number(m[1]);
      } catch (e) {}
      if (age < 3) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  img.classList.remove('show');
  vid.classList.add('show');
  setStat('WebRTC 连接中…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/rtc?k=' + encodeURIComponent(KEY));
  // 改动：不再用外部 STUN 服务器。手机和电脑都在同一个 tailnet 里，直接靠 host 候选（tailnet IP）就能连，
      // 不需要 STUN 打洞；去掉它以后这个产品在运行时不会向任何外部地址发请求，与「不连外网」的承诺一致。
      pc = new RTCPeerConnection({ iceServers: [] });
  window.__pc = pc; window.__vid = vid;
  // 服务端一轨一轨地加，必须合并进同一个 MediaStream，否则后到的轨会覆盖 srcObject
  const remote = new MediaStream();
  vid.srcObject = remote;
  gotVideo = false;
  pc.ontrack = (e) => {
    remote.addTrack(e.track);
    if (e.track.kind === 'video') gotVideo = true;
    vid.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    setStat('WebRTC ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      // 连上就等于服务端已经加上视频轨了（rtc.mjs 现在总是加 video 轨），
      // 这里只处理"连上了但一直没画面"的异常情况。
      rtcRetry = 0;   // 连上就清零：否则服务端重启后的一串重试会把额度用光，之后就再也不重连了
      clearTimeout(videoWatch);
      videoWatch = setTimeout(() => {
        if (vid.videoWidth > 0) { rtcRetry = 0; return; }
        // 收到视频轨只是还没出画面时不要重连（切换来源后头一两秒就是这种状态）
        if (!gotVideo && !document.hidden && state.mode === 'raw' && rtcRetry < 2) { rtcRetry++; restartRtc(); }
      }, 5000);
    }
  };

  ws.onopen = async () => {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.type === 'ice') { try { await pc.addIceCandidate(m.candidate); } catch (e) {} }
  };
  ws.onclose = () => {
    setStat('WebRTC 已断开');
    if (stopped || document.hidden || state.mode !== 'raw') return;   // 后台不重连，回前台再恢复
    rtcRetry++;
    // 改动（关键）：连续 3 次连不上就自动退回清晰模式，不要让客户对着黑屏无限等待。
    // 原来只会在 raw 模式里一直重试；RTC 因为任何原因连不上（编码器、ICE、浏览器差异），
    // 客户看到的现象都是「打不开了」，而他并不知道可以点「清晰」。
    if (rtcRetry >= 3) {
      rtcRetry = 0;
      setNote('WebRTC 连不上，已自动切回清晰模式', 6000);
      stopRtc();
      state.mode = 'mjpeg';
      try { btnCrisp.classList.add('on'); btnSmooth.classList.remove('on'); } catch (e) {}
      try { postMode({ mode: 'mjpeg', width: streamW }); } catch (e) {}
      restartImg();
      return;
    }
    // 一直重试，但封顶 8 秒一次：以前超过 6 次就放弃，服务端重启十几秒后画面就再也不回来了
    if (rtcRetry === 7) setNote('WebRTC 断线，正在重连…', 4000);
    const delay = Math.min(1200 * Math.min(rtcRetry, 7), 8000);
    setTimeout(() => { if (!stopped && state.mode === 'raw') restartRtc(); }, delay);
  };
  ws.onerror = () => setStat('WebRTC 出错');
}


let audioCtx = null, audioNode = null, audioWs = null;
// 环形缓冲（交错立体声 Float32）
const PCM_RING = { cap: 48000 * 2 * 3, data: new Float32Array(48000 * 2 * 3), avail: 0, rd: 0, wr: 0, playing: false };

function pcmReset() {
  PCM_RING.avail = 0; PCM_RING.rd = 0; PCM_RING.wr = 0; PCM_RING.playing = false;
}

function pcmPush(f32) {
  const R = PCM_RING, cap = R.cap, target = 48000 * 2 * 0.08, max = 48000 * 2 * 0.4;
  for (let i = 0; i < f32.length; i++) { R.data[R.wr] = f32[i]; R.wr = (R.wr + 1) % cap; }
  R.avail = Math.min(cap, R.avail + f32.length);
  if (R.avail > max) {                       // 积压太多就丢最旧的，压住延迟
    const drop = R.avail - max;
    R.rd = (R.rd + drop) % cap; R.avail -= drop;
  }
  if (R.avail >= target) R.playing = true;
}

function stopPcmAudio() {
  if (audioWs) { try { audioWs.close(); } catch (e) {} audioWs = null; }
  if (audioNode) { try { audioNode.disconnect(); } catch (e) {} audioNode = null; }
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  pcmReset();
}

async function startPcmAudio() {
  stopPcmAudio();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
    // 注意：没有用户手势时 resume() 会一直 pending，不能 await（会把整个函数卡死，
    // 连 ws 都建不起来）。放到最后，用超时兜底。
    const ratio = audioCtx.sampleRate / 48000;
    // 页面是 http:// 访问的，AudioWorklet 只在安全上下文可用，所以用 ScriptProcessor 兜底
    const sp = audioCtx.createScriptProcessor(2048, 0, 2);
    sp.onaudioprocess = (ev) => {
      const l = ev.outputBuffer.getChannelData(0), r = ev.outputBuffer.getChannelData(1);
      const n = l.length, need = n * 2, R = PCM_RING;
      if (!R.playing || R.avail < need) { l.fill(0); r.fill(0); return; }
      const cap = R.cap;
      for (let i = 0; i < n; i++) {
        l[i] = R.data[R.rd];
        r[i] = R.data[(R.rd + 1) % cap];
        R.rd = (R.rd + 2) % cap;
      }
      R.avail -= need;
      if (window.__pcm) window.__pcm.stat = { stat: 1, playing: R.playing, avail: R.avail };
    };
    sp.connect(audioCtx.destination);
    audioNode = sp;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    audioWs = new WebSocket(proto + '//' + location.host + '/ws-audio?k=' + encodeURIComponent(KEY));
    audioWs.binaryType = 'arraybuffer';
    window.__pcm = { ctx: audioCtx, node: sp, ws: audioWs, chunks: 0, last: null, stat: null };
    // 有用户手势时立刻恢复；没有就等下一次点击再恢复（避免卡住）
    if (audioCtx.state !== 'running') {
      Promise.race([audioCtx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 700))]);
    }
    audioWs.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;      // 头信息
      if (window.__pcm) window.__pcm.chunks++;
      const i16 = new Int16Array(ev.data);
      let f32;
      if (Math.abs(ratio - 1) < 0.001) {
        f32 = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      } else {
        // 采样率不一致（Safari 常见 44.1k）时线性重采样
        const frames = i16.length >> 1, outFrames = Math.floor(frames * ratio);
        f32 = new Float32Array(outFrames * 2);
        for (let i = 0; i < outFrames; i++) {
          const src = i / ratio, i0 = Math.floor(src), i1 = Math.min(i0 + 1, frames - 1), t = src - i0;
          for (let c = 0; c < 2; c++) {
            const a = i16[i0 * 2 + c] / 32768, b = i16[i1 * 2 + c] / 32768;
            f32[i * 2 + c] = a + (b - a) * t;
          }
        }
      }
      if (window.__pcm) window.__pcm.last = { frames: f32.length / 2, rate: audioCtx.sampleRate };
      pcmPush(f32);
    };
    audioWs.onclose = () => {
      audioWs = null;
      if (state.audio && state.mode === 'mjpeg' && !stopped) {
        setTimeout(() => { if (state.audio && state.mode === 'mjpeg') startPcmAudio(); }, 1500);
      }
    };
    setStat('声音已开（清晰模式）');
  } catch (e) {
    console.log('pcm audio failed', e);
    setStat('声音开不了：' + (e && e.message ? e.message : e));
  }
}

// ---- 顶栏 ------------------------------------------------------------------
btnCrisp.addEventListener('click', async () => {
  state.mode = 'mjpeg'; btnCrisp.classList.add('on'); btnSmooth.classList.remove('on');
  applyRect();
  stopRtc();
  try { await fetch('/rtc-off', { method: 'POST' }); } catch (e) {}
  await postMode({});
  restartImg();
  setStat('清晰模式');
  if (state.lowBw) startLowBw();
  if (state.audio) startPcmAudio();     // 声音跟着切到 PCM 通道
  buzz(8);
});

btnSmooth.addEventListener('click', async () => {
  state.mode = 'raw'; btnSmooth.classList.add('on'); btnCrisp.classList.remove('on');
  applyRect();
  stopPcmAudio();                       // 流畅模式用 WebRTC 的音频轨，PCM 通道关掉
  // 省流量只在清晰模式有意义；切到流畅时必须停掉轮询，否则会一直在后台拉 /frame.jpg
  stopLowBw();
  if (state.lowBw) { state.lowBw = false; btnLow.classList.remove('on'); }
  setNote('切换流畅模式…');
  await fetch('/rtc-on', { method: 'POST' });
  await loadSources(true);
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const t = await (await fetch('/health?s=' + SID, { cache: 'no-store' })).text();
      const m = /age=([0-9.]+)/.exec(t);
      if ((m && Number(m[1]) < 3) || /peers=[1-9]/.test(t)) { ready = true; break; }
    } catch (e) {}
  }
  setNote(ready ? '' : '画面还没准备好，稍后再试');
  if (ready) restartRtc();
  buzz(8);
});

btnSnd.addEventListener('click', () => {
  state.audio = !state.audio; btnSnd.classList.toggle('on', state.audio);
  if (state.mode === 'raw') {
    // 流畅模式：WebRTC 自带音频轨，直接开关 <video> 的声音
    vid.muted = !state.audio;
    if (state.audio) vid.play().catch(() => {});
    setStat(state.audio ? '声音已开（流畅模式）' : '声音已关');
  } else if (state.audio) {
    startPcmAudio();               // 清晰模式：PCM over WebSocket
  } else {
    stopPcmAudio();
    setStat('声音已关');
  }
  buzz(8);
});

btnLow.addEventListener('click', () => {
  state.lowBw = !state.lowBw; btnLow.classList.toggle('on', state.lowBw);
  if (state.mode !== 'mjpeg') { state.lowBw = false; btnLow.classList.remove('on'); setNote('省流量只在清晰模式有效'); return; }
  if (state.lowBw) startLowBw(); else { stopLowBw(); showStream(); }
  buzz(8);
});

function setControl(on) {
  state.control = on;
  localStorage.setItem('ctl', on ? '1' : '0');
  btnCtl.classList.toggle('on', on);
  overlay.classList.toggle('off', !on);
  hint.textContent = on
    ? '点哪指哪：黄点跟着手指走 · 单击=左键 · 拖动=拖拽 · 双击=双击 · 长按=右键 · 双指滑=滚轮'
    : '控制已关闭（只读）';
}

btnCtl.addEventListener('click', () => {
  setControl(!state.control);
  buzz(8);
});

// 「桌面」：一键把所有窗口最小化、露出桌面。Win+D 是开关，再点一次恢复原样。
btnDesk.addEventListener('click', async () => {
  btnDesk.disabled = true;
  try {
    const r = await fetch('/showdesktop', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) setNote('显示桌面失败：' + (j.err || '未知原因'), 3000);
    else setNote('已最小化所有窗口，回到桌面', 1800);
  } catch (e) {
    setNote('显示桌面失败：' + (e && e.message ? e.message : e), 3000);
  }
  btnDesk.disabled = false;
});

// 输入框只在按「输入」时才弹出键盘，避免点屏幕就弹平板键盘
btnKb.addEventListener('click', () => {
  const on = !kbbar.classList.contains('on');
  kbbar.classList.toggle('on', on);
  btnKb.classList.toggle('on', on);
  if (on) {
    cmdbar.classList.remove('on'); btnCmd.classList.remove('on');   // 底栏只留一个
    kbtext.value = ''; kbtext.focus();
  } else { kbtext.blur(); }
});

async function sendText(s) {
  if (!s) return;
  await postEvents([{ t: 'text', s: s }]);
}

kbsend.addEventListener('click', async () => {
  await sendText(kbtext.value);
  kbtext.value = '';
});

kbtext.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText(kbtext.value + '\r');
    kbtext.value = '';
  }
});

// ---- 命令面板：直接在这台电脑上跑 PowerShell，不依赖注入和前台窗口 --------------
// 用途：VMware 控制台这类"拒绝合成输入"的窗口没法用触摸操作，但命令可以走这个通道；
// 也方便在外面临时查个状态、重启个服务。权限与页面相同（凭 key 访问）。
let cmdBusy = false;
let cmdHist = [];
let cmdHistAt = -1;

btnCmd.addEventListener('click', () => {
  const on = !cmdbar.classList.contains('on');
  cmdbar.classList.toggle('on', on);
  btnCmd.classList.toggle('on', on);
  if (on) {
    // 两个底栏都占满底部，同时开只会互相盖住：开命令面板就收起打字栏
    kbbar.classList.remove('on'); btnKb.classList.remove('on');
    setTimeout(() => cmdtext.focus(), 60);
  } else { cmdtext.blur(); }
});

async function runCmd() {
  const cmd = cmdtext.value.trim();
  if (!cmd || cmdBusy) return;
  cmdBusy = true; cmdrun.disabled = true;
  cmdout.classList.add('on');
  cmdout.textContent = '执行中…';
  const t0 = performance.now();
  try {
    const r = await fetch('/exec?k=' + encodeURIComponent(KEY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    const j = await r.json().catch(() => { throw new Error('HTTP ' + r.status + '（返回的不是 JSON，多半是没权限或不认识这条命令）'); });
    const ms = Math.round(performance.now() - t0);
    let txt = j.out || '';
    if (j.err) txt += (txt ? '\n' : '') + '[stderr]\n' + j.err;
    if (!txt.trim()) txt = '(无输出)';
    cmdout.textContent = txt + '\n— ' + (j.ok ? 'OK' : '失败(' + (j.code || '?') + ')') + ' · ' + ms + 'ms';
    if (cmdHist[cmdHist.length - 1] !== cmd) { cmdHist.push(cmd); if (cmdHist.length > 40) cmdHist.shift(); }
    cmdHistAt = cmdHist.length;
  } catch (e) {
    cmdout.textContent = '请求失败：' + (e && e.message ? e.message : e);
  }
  cmdBusy = false; cmdrun.disabled = false;
}

cmdrun.addEventListener('click', runCmd);
cmdclr.addEventListener('click', () => { cmdtext.value = ''; cmdout.textContent = ''; cmdout.classList.remove('on'); cmdtext.focus(); });

cmdtext.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCmd(); return; }
  if (e.key === 'ArrowUp' && cmdHist.length && cmdtext.selectionStart === 0 && cmdtext.selectionEnd === 0) {
    if (cmdHistAt <= 0) return;
    cmdHistAt--;
    cmdtext.value = cmdHist[cmdHistAt] || '';
    e.preventDefault();
  } else if (e.key === 'ArrowDown' && cmdHist.length
             && cmdtext.selectionStart === cmdtext.value.length && cmdtext.selectionEnd === cmdtext.value.length) {
    if (cmdHistAt >= cmdHist.length) return;
    cmdHistAt++;
    cmdtext.value = cmdHist[cmdHistAt] || '';
    e.preventDefault();
  }
});

// ---- 输入：坐标换算 --------------------------------------------------------
const media = () => (state.mode === 'raw' ? vid : img);

function contentBox() {
  const el = media();
  const r = el.getBoundingClientRect();
  const nw = state.mode === 'raw' ? (vid.videoWidth || 16) : (img.naturalWidth || 16);
  const nh = state.mode === 'raw' ? (vid.videoHeight || 9) : (img.naturalHeight || 9);
  if (!nw || !nh || !r.width || !r.height) return r;
  const scale = Math.min(r.width / nw, r.height / nh);
  const w = nw * scale, h = nh * scale;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

// 浏览器缩放/移动端双指缩放时，事件坐标是"视觉视口"的 CSS px，
// 而 getBoundingClientRect() 给的是"布局视口"坐标，两者差一个 scale + 偏移。
// 这里统一换算成布局视口坐标，后面的映射就与缩放无关了。
function layoutPoint(cx, cy) {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.005) return { x: cx, y: cy };
  return { x: vv.offsetLeft + cx / vv.scale, y: vv.offsetTop + cy / vv.scale };
}

function toScreen(cx, cy) {
  const box = contentBox();
  const src = state.rect;
  const nw = state.mode === 'raw' ? (vid.videoWidth || 1) : (img.naturalWidth || 1);
  const nh = state.mode === 'raw' ? (vid.videoHeight || 1) : (img.naturalHeight || 1);
  let fx = (cx - box.left) / box.width, fy = (cy - box.top) / box.height;
  fx = Math.min(1, Math.max(0, fx)); fy = Math.min(1, Math.max(0, fy));
  if (!src) return { x: Math.round(fx * nw), y: Math.round(fy * nh) };
  return { x: Math.round(src.x + fx * src.w), y: Math.round(src.y + fy * src.h) };
}

// 屏幕物理坐标 -> 页面坐标（抓屏来源矩形 + object-fit contain 的黑边都要算进去）
function toPage(sx, sy) {
  const box = contentBox();
  const src = state.rect;
  const nw = state.mode === 'raw' ? (vid.videoWidth || 1) : (img.naturalWidth || 1);
  const nh = state.mode === 'raw' ? (vid.videoHeight || 1) : (img.naturalHeight || 1);
  let fx, fy;
  if (src && src.w > 0 && src.h > 0) { fx = (sx - src.x) / src.w; fy = (sy - src.y) / src.h; }
  else { fx = sx / nw; fy = sy / nh; }
  return { x: box.left + fx * box.width, y: box.top + fy * box.height };
}


function showDot(x, y) {
  const r = stage.getBoundingClientRect();
  dot.style.left = (x - r.left) + 'px';
  dot.style.top = (y - r.top) + 'px';
  dot.style.display = 'block';
}
function ripple(x, y) {
  const r = stage.getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'ripple';
  d.style.left = (x - r.left) + 'px';
  d.style.top = (y - r.top) + 'px';
  stage.appendChild(d);
  setTimeout(() => d.remove(), 450);
}

async function postEvents(evs) {
  try {
    await fetch('/input', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: evs }) });
  } catch (e) { setNote('输入发送失败：' + e.message); }
}

let sendQueue = [], sendTimer = null, lastMoveSent = 0;
function queue(ev) {
  sendQueue.push(ev);
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    const evs = sendQueue; sendQueue = [];
    postEvents(evs);
  }, 25);
}

// ============================================================================
// 逐键转发：手机/平板上接的物理键盘，按键直接注入电脑
// ----------------------------------------------------------------------------
// 背景：后端 input.cs 一直支持 {t:'key', vk, down}（SendInput 注入任意虚拟键），
// 但前端从来没发过这个类型，所以「接键盘打字进不了电脑」。这里补上 keydown/keyup 通道。
// 三个必须守住的点：
//   ① 修饰键 down/up 必须成对 —— 少了 up 电脑上会卡住 Ctrl/Shift（粘键），
//      表现为「莫名其妙全选 / 快捷键全乱」，客户只会以为电脑坏了；
//   ② 焦点在页面自己的输入框（kbtext / cmdtext）里时绝不转发；
//   ③ 认不出的物理键尽量走 text 通道兜底，别静默丢键。
// ============================================================================

// event.code（物理键位）→ Windows 虚拟键码。
// 用 code 不用 key：大小写和手机输入法都不影响，电脑那边按它自己的布局 + 我们转过去的
// Shift 状态决定打出什么字符（这正是「接键盘就能打字」该有的语义）。
const VK_BY_CODE = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, NumpadEnter: 0x0D, Escape: 0x1B, Space: 0x20,
  CapsLock: 0x14, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5B, MetaRight: 0x5C,
  Delete: 0x2E, Insert: 0x2D, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE, Slash: 0xBF,
  Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
  NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadMultiply: 0x6A, NumpadDivide: 0x6F, NumpadDecimal: 0x6E
};
// 修饰键：左右各一个物理键，但 Windows 的虚拟键码是共用的（0x10/0x11/0x12），
// 所以配对要按 vk 计数，不能按 event.code 记
const VK_MOD = { 0x10: 1, 0x11: 1, 0x12: 1, 0x5B: 1, 0x5C: 1 };

function vkFromCode(code) {
  if (!code) return 0;
  if (VK_BY_CODE[code]) return VK_BY_CODE[code];
  let m = /^Key([A-Z])$/.exec(code);        // KeyA → 0x41（字母在虚拟键码上是连续的）
  if (m) return m[1].charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);          // Digit0 → 0x30
  if (m) return 0x30 + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);         // 小键盘数字 0x60 起
  if (m) return 0x60 + Number(m[1]);
  m = /^F([1-9]|1[0-2])$/.exec(code);       // F1 → 0x70
  if (m) return 0x6F + Number(m[1]);
  return 0;
}

// 焦点是否落在页面自己的输入框里。命中就绝不转发：
// 否则客户在「输入」/「命令」框里打字，字会同时敲进电脑上的窗口。
function inEditable(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName.toUpperCase();
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  return el.isContentEditable === true;
}

function focusStage() {
  try { stage.focus({ preventScroll: true }); } catch (e) { try { stage.focus(); } catch (e2) {} }
}
// 点完按钮后把焦点还给画面区。按钮留着焦点的话，之后按空格/回车会先"再点一次"它；
// 但如果用户正在自己的输入框里打字，就不能抢（会把手机软键盘收起来）。
function handFocusBack() {
  const ae = document.activeElement;
  if (ae && inEditable(ae)) return;
  focusStage();
}

// 现在按着哪些键：code → vk，以及 vk → 按着几个
// （左右 Shift 共用一个 vk，各按一个时不能提前发 up）
const heldByCode = new Map();
const heldVkCount = new Map();

function queueKey(vk, down) { queue({ t: 'key', vk: vk, down: down ? 1 : 0 }); }
// 立刻把待发队列推出去：页面失焦时要马上补 up，不能等 25ms 定时器（后台会被节流）
function flushQueue() {
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  if (!sendQueue.length) return;
  const evs = sendQueue;
  sendQueue = [];
  postEvents(evs);
}

// 兜底：页面失焦 / 切后台 / 被关掉时，把所有还按着的键补发 up。
// 少了这一步，用户按着 Ctrl 切走（或被通知打断），电脑上就永远卡着 Ctrl。
function releaseAllKeys(why) {
  if (!heldByCode.size) return;
  const vks = [];
  for (const vk of heldByCode.values()) if (vks.indexOf(vk) < 0) vks.push(vk);
  heldByCode.clear();
  heldVkCount.clear();
  for (const vk of vks) queueKey(vk, 0);   // 只补 up，绝不补 down
  flushQueue();
  if (why) console.log('keyboard: released stuck keys on ' + why);
}

let keyHintAt = 0;
function keyBlockedHint() {
  const now = Date.now();
  if (now - keyHintAt < 4000) return;
  keyHintAt = now;
  setNote('「控制」关着：键盘和触摸都不会发到电脑，先点顶栏的「控制」', 3500);
}

document.addEventListener('keydown', (e) => {
  if (inEditable(e.target)) return;                    // 在自己输入框里打字：本机输入，不转发
  if (e.isComposing || e.keyCode === 229) return;      // 手机输入法合成中，交给系统
  if (!state.control) { keyBlockedHint(); return; }    // 与鼠标一致：控制关了就不注入
  if (e.target && e.target.tagName === 'BUTTON') focusStage();   // 免得空格/回车又点一次按钮
  const vk = vkFromCode(e.code);
  if (vk) {
    e.preventDefault();
    if (heldByCode.has(e.code)) {
      // 长按的自动重复：注入的按键电脑那边不会自己重复，重复事件得自己转过去，
      // 否则按住退格只删一个字。修饰键不转重复。
      if (!VK_MOD[vk]) queueKey(vk, 1);
      return;
    }
    heldByCode.set(e.code, vk);
    const n = (heldVkCount.get(vk) || 0) + 1;
    heldVkCount.set(vk, n);
    if (n === 1) queueKey(vk, 1);   // 已经按着同一个 vk（另一侧 Shift）就不再发 down
    return;
  }
  // 认不出的物理键位（异形键盘 / 手机输入法给出的字符）：单个可打印字符改走 text 通道，
  // 后端用 KEYEVENTF_UNICODE 直接敲字符，不依赖电脑的键盘布局。
  // 带 Ctrl/Alt/Win 的一律不走：那是在按组合键，不能被当成字符敲进去。
  if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    queue({ t: 'text', s: e.key });
  }
});

document.addEventListener('keyup', (e) => {
  const vk = heldByCode.get(e.code);
  if (vk === undefined) return;        // 没转发过 down 的键，绝不补发 up
  e.preventDefault();
  heldByCode.delete(e.code);
  const n = (heldVkCount.get(vk) || 1) - 1;
  if (n > 0) { heldVkCount.set(vk, n); return; }   // 还按着同一个 vk 的另一个物理键
  heldVkCount.delete(vk);
  queueKey(vk, 0);
});

// 三路兜底：窗口失焦、切到后台、页面被关掉（手机最常走的是切后台/锁屏）
window.addEventListener('blur', () => releaseAllKeys('window blur'));
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllKeys('page hidden'); });
window.addEventListener('pagehide', () => releaseAllKeys('page hide'));

// ---- 特殊键按钮：不接物理键盘也能敲退格/删除/方向键 ------------------------
const keysrow = document.getElementById('keysrow');
const kbundo = document.getElementById('kbundo');
let pressedKeyBtn = null, pressedKeyVk = 0;

function keyBtnDown(btn, vk) {
  if (pressedKeyBtn) return;                    // 多指同时按：只认第一根，否则 up 会配错
  if (!state.control) { keyBlockedHint(); return; }
  pressedKeyBtn = btn; pressedKeyVk = vk;
  btn.classList.add('down');                    // 视觉反馈：按下变蓝
  queueKey(vk, 1);
  buzz(6);
}
function keyBtnUp() {
  const btn = pressedKeyBtn, vk = pressedKeyVk;
  pressedKeyBtn = null; pressedKeyVk = 0;
  if (!btn) return;
  btn.classList.remove('down');
  if (vk) queueKey(vk, 0);
}

if (keysrow) {
  for (const btn of keysrow.querySelectorAll('button[data-vk]')) {
    const vk = Number(btn.dataset.vk) || 0;
    if (!vk) continue;
    // pointerdown 上 preventDefault：既去掉移动端点击延迟，也不让 <button> 抢走焦点
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); keyBtnDown(btn, vk); });
    btn.addEventListener('pointerup', (e) => { e.preventDefault(); keyBtnUp(); handFocusBack(); });
    btn.addEventListener('pointercancel', () => { keyBtnUp(); handFocusBack(); });
    btn.addEventListener('pointerleave', () => { if (pressedKeyBtn === btn) keyBtnUp(); });   // 手指滑出去也要补 up
  }
}

// 撤销：发一次完整的 Ctrl+Z（Ctrl down → Z down → Z up → Ctrl up，四步同批按顺序发，
// 修饰键绝不单边）。这只是让电脑上的软件自己撤销，不是"把发出去的字撤回来"：
// 已经用 text 通道敲进去的内容是系统级输入，没有任何办法收回，所以按钮写「撤销」不写「撤回」。
if (kbundo) {
  kbundo.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!state.control) { keyBlockedHint(); return; }
    kbundo.classList.add('down');
    setTimeout(() => kbundo.classList.remove('down'), 150);
    queueKey(0x11, 1); queueKey(0x5A, 1); queueKey(0x5A, 0); queueKey(0x11, 0);
    buzz(10);
  });
  kbundo.addEventListener('pointerup', (e) => { e.preventDefault(); handFocusBack(); });
  kbundo.addEventListener('pointercancel', () => handFocusBack());
}

// ---- 手势：Pointer Events（Chrome/Safari 都支持）--------------------------
let ptr = null, longTimer = null, moved = false, dragBtn = -1, pinch = null, lastTapAt = 0;

overlay.addEventListener('pointerdown', (e) => {
  if (!state.control) return;
  if (ptr && !ptr.up) return;
  const q = layoutPoint(e.clientX, e.clientY);
  try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
  ptr = { id: e.pointerId, x: q.x, y: q.y, t: Date.now(), up: false };
  moved = false; dragBtn = -1;
  const p = toScreen(q.x, q.y);
  queue({ t: 'move', x: p.x, y: p.y });
  showDot(q.x, q.y);
  longTimer = setTimeout(() => {
    longTimer = null;
    if (moved || !ptr) return;
    dragBtn = 1;
    queue({ t: 'down', b: 1 });
    buzz(35);
  }, 550);
});

overlay.addEventListener('pointermove', (e) => {
  if (!state.control || !ptr || ptr.up) return;
  const q = layoutPoint(e.clientX, e.clientY);
  const dx = q.x - ptr.x, dy = q.y - ptr.y;
  if (!moved && Math.hypot(dx, dy) > 8) {
    moved = true;
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    if (dragBtn < 0) { dragBtn = 0; queue({ t: 'down', b: 0 }); }
  }
  const now = Date.now();
  if (now - lastMoveSent > 28) {
    lastMoveSent = now;
    const p = toScreen(q.x, q.y);
    queue({ t: 'move', x: p.x, y: p.y });
    showDot(q.x, q.y);
  }
});

overlay.addEventListener('pointerup', (e) => {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  if (!ptr || ptr.up) return;
  ptr.up = true;
  const q = layoutPoint(e.clientX, e.clientY);
  const p = toScreen(q.x, q.y);
  if (!moved) {
    if (dragBtn === 1) {
      queue({ t: 'up', b: 1 });
      ripple(q.x, q.y);
    } else {
      const now = Date.now();
      const dbl = now - lastTapAt < 320;
      lastTapAt = dbl ? 0 : now;
      queue({ t: 'move', x: p.x, y: p.y });
      queue({ t: 'click', b: 0, n: dbl ? 2 : 1 });
      ripple(q.x, q.y);
      buzz(12);
    }
  } else if (dragBtn === 1) {
    queue({ t: 'move', x: p.x, y: p.y });
    queue({ t: 'up', b: 1 });
  } else {
    queue({ t: 'move', x: p.x, y: p.y });
    queue({ t: 'up', b: 0 });
  }
  ptr = null; dragBtn = -1; moved = false;
});

overlay.addEventListener('pointercancel', () => {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  if (ptr && !ptr.up) { queue({ t: 'up', b: dragBtn === 1 ? 1 : 0 }); }
  ptr = null; dragBtn = -1; moved = false;
});

// 双指滑动 = 滚轮
overlay.addEventListener('touchstart', (e) => {
  if (!state.control) return;
  if (e.touches.length === 2) {
    const q1 = layoutPoint(e.touches[0].clientX, e.touches[0].clientY);
    const q2 = layoutPoint(e.touches[1].clientX, e.touches[1].clientY);
    pinch = { y: (q1.y + q2.y) / 2, acc: 0 };
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    if (ptr && !ptr.up) { ptr.up = true; ptr = null; }
    moved = true;
  }
}, { passive: true });

overlay.addEventListener('touchmove', (e) => {
  if (!state.control || !pinch || e.touches.length !== 2) return;
  const qa = layoutPoint(e.touches[0].clientX, e.touches[0].clientY);
  const qb = layoutPoint(e.touches[1].clientX, e.touches[1].clientY);
  const y = (qa.y + qb.y) / 2;
  pinch.acc += (pinch.y - y);
  pinch.y = y;
  const steps = Math.trunc(pinch.acc / 18);
  if (steps) {
    pinch.acc -= steps * 18;
    queue({ t: 'wheel', d: steps });
  }
}, { passive: true });

overlay.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinch = null;
}, { passive: true });

// 改动（滚轮修复）：原来只有"双指滑动"能滚，页面从未监听 wheel 事件 ——
// 所以接物理鼠标时滚动滚轮完全没反应（用户实测反馈）。这里补上。
// 单位与双指滑动一致：页面发 d = 格数，后端 input.cs 再乘 120（WHEEL_DELTA）。
let wheelAcc = 0;
overlay.addEventListener('wheel', (e) => {
  if (!state.control) return;
  e.preventDefault();   // 别让浏览器自己滚页面/触发下拉刷新
  // 物理鼠标一格通常 deltaY≈100~120；触控板会碎成 1~4 的小值，累积到 100 才走一格，
  // 否则触控板上一次轻微滑动会发出几十条消息。
  wheelAcc += e.deltaY;
  const unit = 100;
  const steps = Math.trunc(wheelAcc / unit);
  if (steps) {
    wheelAcc -= steps * unit;
    // 浏览器 deltaY>0 表示向下滚；后端 d>0 表示滚轮向前（mouseData 正数），方向相反，取负。
    queue({ t: 'wheel', d: -steps });
  }
}, { passive: false });

// 焦点/模式切换时清掉累积量，避免残留导致下一次滚动"跳一下"
overlay.addEventListener('pointerdown', () => { wheelAcc = 0; }, { passive: true });

// 桌面鼠标右键
overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.control) return;
  const q = layoutPoint(e.clientX, e.clientY);
  const p = toScreen(q.x, q.y);
  queue({ t: 'move', x: p.x, y: p.y });
  queue({ t: 'click', b: 1, n: 1 });
});

// ---- 统计 ------------------------------------------------------------------
// 口径（三个数含义完全不同，别混）：
//   in  = 抓屏侧：管道里真正收到的帧数（capture.exe 的实际产出速度）
//   out = 送达侧：唯一帧被推给观看者的速度（多设备同时看不会翻倍）
//   丢帧 = 最近 10 秒被跳过的帧数（不是累计值，链路一好就自动清零）
// 半免费（2026-10-29 起）：/health 里多了 uq= 字段 —— 未授权机器的超清每日配额。
//   uq=<秒数> 今日超清还剩多少秒；uq=0:x 已用完（服务端正按高清 1920 出图）；uq=na 不适用。
let uqToastShown = false;
function fmtUq(s) { s = Math.max(0, Math.round(Number(s) || 0)); return s >= 60 ? (Math.floor(s / 60) + ' 分钟') : (s + ' 秒'); }
async function pollStats() {
  try {
    const wasDown = failPolls > 0;
    failPolls = 0;   // 成功即清零（原先只在触发重连时清零，失败会跨服务中断累计，恢复后多失败两次就会误重连）
    const t0 = performance.now();
    const r = await fetch('/health?s=' + SID, { cache: 'no-store' });
    const t = await r.text();
    // 改动（2026-10-30 第四轮）：画质刚改过且服务刚重启恢复（本轮之前轮询失败过）→ 整页刷新一次。
    // iOS 独立模式（装到主屏幕的 App）视口高度会在会话中漂移，换画质后画面底部被裁（用户实测；
    // 浏览器同操作正常）。全新加载总是对的（用户原话"刚进去画面是好的"）。UI 已承诺
    // "约 8 秒后刷新生效"，这里的 1 秒重载在该承诺之内；浏览器里同样触发（1 秒闪一下，可接受）。
    if (wasDown && qualityPending && Date.now() - qualityPending < 600000) {
      qualityPending = 0;
      setTimeout(() => location.reload(), 800);
    }
    // 往返延迟（含服务端处理，局域网 2~5ms，Tailscale 中继 200~500ms）
    rttHist.push(performance.now() - t0);
    if (rttHist.length > 5) rttHist.shift();
    rttMs = rttForce > 0 ? rttForce : Math.round(rttHist.slice().sort((a, b) => a - b)[Math.floor(rttHist.length / 2)]);
    if (rttMs > 200 && !advisedSlow && state.mode === 'mjpeg') {
      advisedSlow = true;
      setNote('链路延迟 ' + rttMs + 'ms（多半在走中继），建议改用「流畅」模式', 8000);
    }
    const out = /out=([0-9.]+)/.exec(t), cap = /cap=(\d+)/.exec(t), drop = /drop10=(\d+)/.exec(t);
    const inp = / in=([0-9.]+)/.exec(t);
    const lagM = / lag=(\d+)/.exec(t);
    const peers = /"peers":(\d+)/.exec(t);
    const vw = /viewers=(\d+)/.exec(t);
    // 半免费：超清配额状态。用完的那一瞬间弹一次提示（画面已被服务端降为高清出图），
    // 恢复（跨天/装上许可证）后重置标志，允许下一次再提示。
    const uqm = / uq=([0-9]+)(:x)?/.exec(t);
    if (uqm) {
      const uqEx = !!uqm[2];
      window.__uq = { remaining: Number(uqm[1]), exhausted: uqEx };
      if (uqEx && !uqToastShown) {
        uqToastShown = true;
        setNote('今日超清 1 小时已用完，画面已自动切为高清。明天 0 点恢复 · 许可证不限时长', 10000);
      } else if (!uqEx && uqToastShown && Number(uqm[1]) > 60) {
        uqToastShown = false;
      }
    } else {
      window.__uq = null;
    }
    // 注入被前台高权限窗口挡住（UIPI）：injector 会一直累加 blk，前台切走就停
    const bN = /blk=(\d+)/.exec(t), fg = /fg=("(?:[^"\\]|\\.)*")/.exec(t);
    if (bN) {
      const n = Number(bN[1]);
      let name = '';
      if (fg) { try { name = JSON.parse(fg[1]); } catch (e) { name = ''; } }
      if (n !== lastBlk) { lastBlk = n; blkAt = Date.now(); }
      const hot = n > 0 && Date.now() - blkAt < 12000;
      if (hot) {
        blk.innerHTML = '⚠ 前台窗口 <b>' + escHtml(name || '管理员窗口') +
          '</b> 挡住了鼠标注入<br>把它切到后台 / 关掉，或点' +
          '<button id="blkFix">抢回前台</button>';
        blk.style.display = 'block';
        const fix = document.getElementById('blkFix');
        if (fix && !fix._bound) {
          fix._bound = 1;
          fix.onclick = async () => { try { await fetch('/unblock', { method: 'POST' }); } catch (e) {} };
        }
      } else {
        blk.style.display = 'none';
      }
    }
    // 看门狗：改成问服务端。Chrome 对 multipart/x-mixed-replace 只在第一帧触发一次 load，
    // 用 load 计时会每 6 秒误判一次（之前"隔一秒黑一下"就是它）。现在只有在
    // 服务器明确说"我们这条流已经不在了"（viewers=0）时才重开，正常播放零重开。
    if (state.mode === 'mjpeg' && !state.lowBw && !stopped && img.getAttribute('src') && vw) {
      if (Number(vw[1]) === 0) {
        if (++deadPolls >= 2) { deadPolls = 0; setStat('断流重连中…'); restartImg(); }
      } else deadPolls = 0;
    } else deadPolls = 0;
    if (out && !state.lowBw) adaptStream(Number(out[1]), inp ? Number(inp[1]) : 0, drop ? Number(drop[1]) : 0, lagM ? Number(lagM[1]) : 0);
    const nowT = performance.now();
    if (vfcAt) {
      const dt = (nowT - vfcAt) / 1000;
      if (dt > 0.3) { const c = videoFrameCount(); vfcFps = (c - vfcLast) / dt; vfcLast = c; vfcAt = nowT; }
    } else { vfcAt = nowT; vfcLast = videoFrameCount(); }
    if (state.mode === 'raw') {
      hud.textContent = 'WebRTC · ' + (vfcFps > 0 ? vfcFps.toFixed(1) + ' fps' : '—')
        + (peers ? ' · ' + peers[1] + ' 连接' : '')
          // 这是 /health 的 HTTP 往返时间，**不是视频延迟**。流畅模式的视频走 WebRTC
          // （host 候选直连），和这条轮询链路不是同一条路，所以只标「链路」，
          // 免得用户看到三千毫秒以为画面很卡、实际却很流畅。
          + ' · 链路 ' + rttMs + 'ms · 上限 ' + (lastQ.kbps / 1000) + 'Mbps';
    } else if (state.lowBw) {
      // 省流量不走 MJPEG 流，服务器 out= 恒为 0，显示帧率会误导，这里直接标轮询参数
      hud.textContent = '省流量 · ' + Math.round(1000 / LOWBW_MS) + ' 帧/秒 · ' + lowBwWidth() + ' 宽 q45';
    } else if (out) {
      const capMs = cap ? Number(cap[1]) : 0;
      const capFps = capMs > 0 ? (1000 / capMs).toFixed(1) : '?';
      const dN = drop ? Number(drop[1]) : 0;
      hud.textContent = out[1] + ' fps'
        + (inp ? '（抓屏 ' + inp[1] + '）' : '')
        + ' · 上限 ' + capFps
        + (streamW < 2560 ? ' · ' + streamW + ' 宽' : '')
        + (rttMs > 0 ? ' · 延迟 ' + rttMs + 'ms' : '')
        + (dN > 0 ? ' · 丢帧 ' + dN + '/10s' : '')
        + (window.__uq ? (window.__uq.exhausted ? ' · 超清已用完·高清出图' : ' · 超清余 ' + fmtUq(window.__uq.remaining)) : '');
    }
  } catch (e) {
    hud.textContent = '';
    // /health 连续拿不到：多半是服务端在重启，6 秒后自己把流重开一次
    if (++failPolls >= 3 && state.mode === 'mjpeg' && !stopped) { failPolls = 0; restartImg(); }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopped = true; }
  else {
    stopped = false;
    if (state.mode === 'mjpeg') restartImg();
    // 流畅模式下回到前台时，如果连接已经断了/画面死了，主动重连一次
    else if (!pc || pc.connectionState !== 'connected') { rtcRetry = 0; restartRtc(); }
  }
});

let imgOkAt = Date.now();
let deadPolls = 0;
let failPolls = 0;
// 改动（2026-10-30 第四轮，用户 iPad 装出来的 App 实测）：独立 App 里换画质后画面底部被裁掉，
// 浏览器里同样操作正常。原因是 iOS 独立模式（apple-mobile-web-app 全屏）的视口高度会在会话中
// 漂移——100dvh 可能算成比可见屏幕更大的值，布局盒从底部溢出屏幕（顶部正常、左右无黑边，
// 与用户截图一致）。这里把 body 高度钉在 visualViewport 实测值（真实可见区域）上，
// resize/转屏/visualViewport 变化时重新同步；浏览器与桌面两者相等，无影响。
// qualityPending：画质保存成功时记下时间戳；服务重启恢复后由 pollStats 钩子整页刷新一次（见下）。
let qualityPending = 0;
function syncViewportHeight() {
  const vv = window.visualViewport;
  if (vv) {
    const h = vv.height + (vv.offsetTop || 0);
    if (h > 0) document.body.style.height = h + 'px';
  }
}
syncViewportHeight();
addEventListener('resize', syncViewportHeight);
addEventListener('orientationchange', syncViewportHeight);
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);
function bindImg(el) {
  el.addEventListener('load', () => { imgOkAt = Date.now(); setStat(state.lowBw ? '省流量（2 帧/秒 · ' + lowBwWidth() + ' 宽）' : '直播中'); });
  el.addEventListener('error', () => { if (!stopped) setTimeout(() => restartImg(), 1200); });
}
bindImg(img);

(async function init() {
  btnCrisp.classList.add('on');
  setControl(state.control);
  await postMode({});
  await loadSources(true);
  startSourcesPolling();
  restartImg();
  pollStats();
  statsTimer = setInterval(pollStats, 2000);
  window.__page = { state, contentBox, toScreen, toPage, layoutPoint };   // 调试用
  setNote('');
})();

// ---- 注册 Service Worker：让手机能把本页"安装到桌面" ------------------------
// 安卓 Chrome 只有在存在带 fetch 事件的 SW 时才弹安装提示（manifest 齐了也不够）。
// 服务端的 /sw.js 刻意不做缓存，所以注册了也不会导致"改了页面但手机看到旧的"。
(function registerSw() {
  try {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && !/^127\.|^100\./.test(location.hostname)) {
      // http 下非安全来源不会注册成功（Tailscale 的 100.x 在 Chrome 里视为安全来源，通常可用）
    }
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* 装不上 App 不影响使用 */ });
  } catch (e) { }
})();

// ---- 个性化（许可证解锁的付费功能，半免费 2026-10-29 起）------------------------
// 颜色主题 / 光标大小与颜色 / 自定义主题导入。偏好保存在手机本地 localStorage，
// 是否生效以服务端 /licence 的 usable 为准：未授权时页面加载一律回落默认主题+默认光标
// （已保存的偏好不清除，装上许可证后自动恢复）。外观类功能在页面侧强制；
// 服务端的强制点是超清配额与出图宽度，两边互不影响。
(function personalization() {
  const LS_THEME = 'pa.theme', LS_CURSOR = 'pa.cursor', LS_CUSTOM = 'pa.customTheme', LS_CURSOR_IMG = 'pa.cursorImg';
  const THEMES = [
    { key: 'dark', name: '深邃黑', free: true, meta: '#15161a' },
    { key: 'light', name: '暖白', free: false, meta: '#f2f3f5' },
    { key: 'blue', name: '海洋蓝', free: false, meta: '#101a2b' },
    { key: 'purple', name: '暗夜紫', free: false, meta: '#171024' },
    { key: 'custom', name: '自定义', free: false, meta: '#15161a' }
  ];
  const DOT_COLORS = ['#ffd166', '#6ee7a0', '#74c0fc', '#ff8787', '#ffffff', '#ff9de2'];
  const DOT_DEFAULT = { size: 10, color: '#ffd166' };
  // 光标形状（2026-10-29 新增；2026-10-30 规则澄清，用户拍板）：
  //   五种内置形状（圆点/圆环/十字/箭头/方框）全部可调颜色 + 大小；
  //   只有用户自定义导入的图片（custom）只能调大小，不可调颜色（图片自带颜色，染色无意义）。
  // colorable 是设置面板禁用色板的唯一依据（syncColorRow）。
  const CURSOR_SHAPES = {
    dot: { name: '圆点', icon: '●', colorable: true },
    ring: { name: '圆环', icon: '◯', colorable: true },
    cross: { name: '十字', icon: '✚', colorable: true },
    arrow: { name: '箭头', icon: '➤', colorable: true },
    square: { name: '方框', icon: '▢', colorable: true },
    custom: { name: '自定义', icon: '🖼', colorable: false }
  };
  const CURSOR_SHAPE_KEYS = ['dot', 'ring', 'cross', 'arrow', 'square', 'custom'];

  // 主题 = 覆盖样式表，只影响主界面（顶栏/按钮/提示条/输入条）；画面区永远黑底，不动。
  const THEME_CSS = ''
    + 'body.pa-t-light{background:#eceef1;color:#33373d}'
    + 'body.pa-t-light header{background:#ffffff;border-bottom-color:#d9dce1}'
    + 'body.pa-t-light button{background:#e7e9ee;color:#33373d;border-color:#c9ced5}'
    + 'body.pa-t-light button.on{background:#2f9e4f;border-color:#268543;color:#ffffff}'
    + 'body.pa-t-light select{background:#e7e9ee;color:#33373d;border-color:#c9ced5}'
    + 'body.pa-t-light #hint{background:#e3e6ea;color:#5c6169}'
    + 'body.pa-t-light #stat,body.pa-t-light #hud{color:#5c6169}'
    + 'body.pa-t-light #kbbar,body.pa-t-light #cmdbar{background:#f5f6f8;border-top-color:#d9dce1}'
    + 'body.pa-t-light #kbtext,body.pa-t-light #cmdtext{background:#ffffff;color:#22252b;border-color:#c9ced5}'
    + 'body.pa-t-light #cmdout{background:#f1f2f5;color:#33373d;border-color:#d9dce1}'
    + 'body.pa-t-light #note{color:#5c6169}'
    + 'body.pa-t-light .ripple{border-color:#2f9e4f}'
    + 'body.pa-t-blue{background:#0a1220;color:#c6d4e8}'
    + 'body.pa-t-blue header{background:#101a2b;border-bottom-color:#1d2c44}'
    + 'body.pa-t-blue button{background:#16233a;color:#c6d4e8;border-color:#26395a}'
    + 'body.pa-t-blue button.on{background:#1f5f8f;border-color:#2a78b0;color:#eaf6ff}'
    + 'body.pa-t-blue select{background:#16233a;color:#c6d4e8;border-color:#26395a}'
    + 'body.pa-t-blue #hint{background:#0d1626;color:#7286a3}'
    + 'body.pa-t-blue #stat,body.pa-t-blue #hud{color:#7286a3}'
    + 'body.pa-t-blue #kbbar,body.pa-t-blue #cmdbar{background:#0f182a;border-top-color:#1d2c44}'
    + 'body.pa-t-blue #kbtext,body.pa-t-blue #cmdtext{background:#16233a;color:#dce8f8;border-color:#26395a}'
    + 'body.pa-t-blue #cmdout{background:#0c1424;color:#b9c9e0;border-color:#1d2c44}'
    + 'body.pa-t-blue #note{color:#7286a3}'
    + 'body.pa-t-blue .ripple{border-color:#74c0fc}'
    + 'body.pa-t-purple{background:#100a1c;color:#d6cbe8}'
    + 'body.pa-t-purple header{background:#171024;border-bottom-color:#2a1f3d}'
    + 'body.pa-t-purple button{background:#211634;color:#d6cbe8;border-color:#372952}'
    + 'body.pa-t-purple button.on{background:#6b3fa0;border-color:#8a56c7;color:#f4ecff}'
    + 'body.pa-t-purple select{background:#211634;color:#d6cbe8;border-color:#372952}'
    + 'body.pa-t-purple #hint{background:#130c20;color:#8d7fa8}'
    + 'body.pa-t-purple #stat,body.pa-t-purple #hud{color:#8d7fa8}'
    + 'body.pa-t-purple #kbbar,body.pa-t-purple #cmdbar{background:#150e22;border-top-color:#2a1f3d}'
    + 'body.pa-t-purple #kbtext,body.pa-t-purple #cmdtext{background:#211634;color:#e6dcf5;border-color:#372952}'
    + 'body.pa-t-purple #cmdout{background:#100a1c;color:#c9bce0;border-color:#2a1f3d}'
    + 'body.pa-t-purple #note{color:#8d7fa8}'
    + 'body.pa-t-purple .ripple{border-color:#c39df0}';

  let styleEl = null, customStyleEl = null;
  function ensureStyle() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'paThemeCss';
      styleEl.textContent = THEME_CSS;
      document.head.appendChild(styleEl);
    }
    if (!customStyleEl) {
      customStyleEl = document.createElement('style');
      customStyleEl.id = 'paCustomCss';
      document.head.appendChild(customStyleEl);
    }
  }
  function isHex(c) { return typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c.trim()); }
  function loadCustom() {
    try { const j = JSON.parse(localStorage.getItem(LS_CUSTOM) || 'null'); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null; } catch (e) { return null; }
  }
  // 自定义主题：所有字段可选，缺省回落深色默认值；只接受 #hex 颜色
  function buildCustomCss(j) {
    if (!j) return '';
    const g = (f, d) => (isHex(j[f]) ? String(j[f]).trim() : d);
    const bodyBg = g('bodyBg', '#0b0b0d'), textColor = g('textColor', '#c9ccd1');
    const headerBg = g('headerBg', '#15161a'), btnBg = g('btnBg', '#24262b');
    const btnColor = g('btnColor', textColor), btnBorder = g('btnBorder', '#33363d');
    const accent = g('accent', '#8CE68C'), inputBg = g('inputBg', '#22252b');
    return ''
      + 'body.pa-t-custom{background:' + bodyBg + ';color:' + textColor + '}'
      + 'body.pa-t-custom header{background:' + headerBg + ';border-bottom-color:' + btnBorder + '}'
      + 'body.pa-t-custom button{background:' + btnBg + ';color:' + btnColor + ';border-color:' + btnBorder + '}'
      + 'body.pa-t-custom button.on{background:' + accent + ';border-color:' + accent + ';color:#0b0b0d}'
      + 'body.pa-t-custom select{background:' + btnBg + ';color:' + btnColor + ';border-color:' + btnBorder + '}'
      + 'body.pa-t-custom #hint{background:' + headerBg + ';color:' + btnColor + '}'
      + 'body.pa-t-custom #stat,body.pa-t-custom #hud{color:' + btnColor + '}'
      + 'body.pa-t-custom #kbbar,body.pa-t-custom #cmdbar{background:' + headerBg + ';border-top-color:' + btnBorder + '}'
      + 'body.pa-t-custom #kbtext,body.pa-t-custom #cmdtext{background:' + inputBg + ';color:' + textColor + ';border-color:' + btnBorder + '}'
      + 'body.pa-t-custom #cmdout{background:' + bodyBg + ';color:' + textColor + ';border-color:' + btnBorder + '}'
      + 'body.pa-t-custom #note{color:' + btnColor + '}'
      + 'body.pa-t-custom .ripple{border-color:' + accent + '}';
  }
  function themeByKey(k) { for (const t of THEMES) { if (t.key === k) return t; } return THEMES[0]; }
  function applyTheme(key) {
    ensureStyle();
    const t = themeByKey(key);
    document.body.classList.remove('pa-t-dark', 'pa-t-light', 'pa-t-blue', 'pa-t-purple', 'pa-t-custom');
    if (t.key !== 'dark') document.body.classList.add('pa-t-' + t.key);
    if (t.key === 'custom') customStyleEl.textContent = buildCustomCss(loadCustom());
    try {
      const m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', t.meta);
    } catch (e) { }
  }
  // 把一个元素渲染成指定光标形状（#dot 与设置面板里的预览共用同一套逻辑）
  function styleShapeEl(el, shape, color, imgData) {
    if (!el) return;
    const s = CURSOR_SHAPES[shape] ? shape : 'dot';
    // .cursorDot 基类自带黄底/圆角/黑光晕：内联清成 '' 会漏出类样式（实测圆环内是黄的），
    // 所以每个属性都显式设中性值，再按形状覆盖。
    el.style.background = 'transparent';
    el.style.border = 'none';
    el.style.borderRadius = '0';
    el.style.clipPath = 'none';
    el.style.boxShadow = 'none';
    el.style.filter = 'none';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.style.backgroundRepeat = '';
    el.style.boxSizing = 'border-box';
    // 2026-10-30 规则澄清：五种内置形状全部吃 color（用户选的色板颜色，已校验 #hex）；
    // 原来除圆点外固定白色，与"官方形状可调颜色"的口径不符。custom（图片）不吃颜色。
    if (s === 'dot') {
      el.style.background = color;
      el.style.borderRadius = '50%';
      el.style.boxShadow = '0 0 6px #000';
    } else if (s === 'ring') {
      el.style.border = '2px solid ' + color;
      el.style.borderRadius = '50%';
      el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.9))';
    } else if (s === 'square') {
      el.style.border = '2px solid ' + color;
      el.style.borderRadius = '2px';
      el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.9))';
    } else if (s === 'cross') {
      el.style.backgroundImage = 'linear-gradient(' + color + ',' + color + '), linear-gradient(' + color + ',' + color + ')';
      el.style.backgroundSize = '2px 100%, 100% 2px';
      el.style.backgroundPosition = 'center, center';
      el.style.backgroundRepeat = 'no-repeat, no-repeat';
      el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.9))';
    } else if (s === 'arrow') {
      el.style.background = color;
      el.style.clipPath = 'polygon(10% 2%, 10% 75%, 28% 60%, 42% 90%, 56% 83%, 41% 55%, 65% 53%)';
      el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.9))';
    } else if (s === 'custom') {
      if (imgData) {
        el.style.backgroundImage = 'url("' + imgData + '")';
        el.style.backgroundSize = 'contain';
        el.style.backgroundPosition = 'center';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.9))';
      } else {
        // 选了自定义但还没导入图片：回落默认圆点，别让客户看到隐形光标
        el.style.background = color;
        el.style.borderRadius = '50%';
        el.style.boxShadow = '0 0 6px #000';
      }
    }
  }
  function applyCursor(cfg) {
    const d = document.getElementById('dot');
    if (!d) return;
    const size = Math.max(6, Math.min(24, Math.round(Number(cfg && cfg.size) || DOT_DEFAULT.size)));
    const color = isHex(cfg && cfg.color) ? String(cfg.color).trim() : DOT_DEFAULT.color;
    const shape = CURSOR_SHAPES[cfg && cfg.shape] ? cfg.shape : 'dot';
    const half = Math.round(size / 2);
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    d.style.margin = ('-' + half) + 'px 0 0 ' + ('-' + half) + 'px';
    styleShapeEl(d, shape, color, shape === 'custom' ? loadCursorImg() : null);
  }
  function loadTheme() { try { return String(localStorage.getItem(LS_THEME) || 'dark'); } catch (e) { return 'dark'; } }
  function loadCursor() {
    try { const j = JSON.parse(localStorage.getItem(LS_CURSOR) || 'null'); return (j && typeof j === 'object') ? j : null; } catch (e) { return null; }
  }
  function saveTheme(k) { try { localStorage.setItem(LS_THEME, k); } catch (e) { } }
  function saveCursor(c) { try { localStorage.setItem(LS_CURSOR, JSON.stringify(c)); } catch (e) { } }
  function saveCustom(j) { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(j)); } catch (e) { } }
  // 自定义光标图片（dataURL）。只认 data: 前缀，别的一律当没存过。
  function loadCursorImg() {
    try { const s = localStorage.getItem(LS_CURSOR_IMG); return (typeof s === 'string' && s.slice(0, 5) === 'data:') ? s : null; } catch (e) { return null; }
  }
  function saveCursorImg(dataUrl) { try { localStorage.setItem(LS_CURSOR_IMG, String(dataUrl)); return true; } catch (e) { return false; } }
  function clearCursorImg() { try { localStorage.removeItem(LS_CURSOR_IMG); } catch (e) { } }
  // 页面加载与许可证状态变化时调用：未授权一律回落默认（偏好保留不清除）
  function applyAll(licensed) {
    if (licensed) {
      applyTheme(loadTheme());
      applyCursor(loadCursor() || DOT_DEFAULT);
    } else {
      applyTheme('dark');
      applyCursor(DOT_DEFAULT);
    }
  }
  window.__paP13n = {
    THEMES: THEMES, DOT_COLORS: DOT_COLORS, DOT_DEFAULT: DOT_DEFAULT,
    CURSOR_SHAPES: CURSOR_SHAPES, CURSOR_SHAPE_KEYS: CURSOR_SHAPE_KEYS,
    applyAll: applyAll, applyTheme: applyTheme, applyCursor: applyCursor,
    styleShapeEl: styleShapeEl,
    loadTheme: loadTheme, loadCursor: loadCursor, loadCustom: loadCustom,
    loadCursorImg: loadCursorImg, saveCursorImg: saveCursorImg, clearCursorImg: clearCursorImg,
    saveTheme: saveTheme, saveCursor: saveCursor, saveCustom: saveCustom,
    isHex: isHex, themeByKey: themeByKey
  };
})();

// ---- 许可证 / 支持入口 ------------------------------------------------------
// 刻意用 JS 动态注入，不改原有 HTML/CSS 模板：改动面最小，出问题也只影响这一块。
//
// 两种表现：
//   未授权  → 整屏遮罩，显示机器码 + 联系方式 + 收款码（客户唯一的出路就在这）
//   已授权  → 右下角一个小按钮（仅在 support.enabled 时出现），点了看购买/捐赠信息
// 已授权且 support.enabled=false 时，页面上一点都不多。
(function licenceUI() {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function readLicence() {
    const u = new URL(location.href);
    u.pathname = '/licence';
    if (!u.searchParams.get('k') && window.__pageKey) u.searchParams.set('k', window.__pageKey);
    return fetch(u.toString(), { cache: 'no-store' }).then((r) => r.json());
  }

  function copyText(t) {
    try {
      if (navigator.clipboard) { navigator.clipboard.writeText(t); return true; }
    } catch (e) { }
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      ta.remove(); return true;
    } catch (e) { return false; }
  }

  function supportHtml(lic, compact) {
    const s = lic.support || {};
    const b = lic.branding || {};
    const contact = (b.contact || s.contact || '').trim();
    const parts = [];
    if (s.note) parts.push('<div style="color:#8b9098;font-size:13px;margin:10px 0 0">' + esc(s.note) + '</div>');
    if (contact) {
      parts.push('<div style="margin:14px 0 0"><div style="color:#8b9098;font-size:12px;margin-bottom:4px">联系方式</div>'
        + '<pre style="margin:0;white-space:pre-wrap;font:13px/1.6 ui-monospace,Consolas,monospace;color:#e8eaee;'
        + 'background:#14151a;border:1px solid #24262e;border-radius:8px;padding:10px;user-select:text">' + esc(contact) + '</pre></div>');
    }
    const qrs = [];
    if (b.alipay) qrs.push('<figure style="margin:0;text-align:center"><img src="' + esc(b.alipay) + '" alt="支付宝" style="width:150px;height:150px;image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px"><figcaption style="color:#8b9098;font-size:12px;margin-top:6px">支付宝</figcaption></figure>');
    if (b.wechat) qrs.push('<figure style="margin:0;text-align:center"><img src="' + esc(b.wechat) + '" alt="微信" style="width:150px;height:150px;image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px"><figcaption style="color:#8b9098;font-size:12px;margin-top:6px">微信</figcaption></figure>');
    if (qrs.length) parts.push('<div style="display:flex;gap:16px;justify-content:center;margin:16px 0 0;flex-wrap:wrap">' + qrs.join('') + '</div>');
    else if (!compact) parts.push('<div style="color:#6b7078;font-size:12px;margin:14px 0 0">（卖家还没放收款码。把 支付宝.png / 微信.png 放进安装目录的 branding 文件夹就会显示）</div>');
    return parts.join('');
  }

  function machineCodeHtml(lic) {
    if (!lic.machineCode) return '';
    return '<div style="margin:16px 0 0">'
      + '<div style="color:#8b9098;font-size:12px;margin-bottom:4px">本机机器码（发给卖家换取许可证）</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<code style="font:15px/1.4 ui-monospace,Consolas,monospace;color:#e8eaee;background:#14151a;'
      + 'border:1px solid #24262e;border-radius:8px;padding:8px 10px;user-select:all" id="licMachine">' + esc(lic.machineCode) + '</code>'
      + '<button id="licCopy" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;'
      + 'padding:8px 12px;font-size:13px;cursor:pointer">复制</button>'
      + '</div></div>';
  }

  // ---- 「分享给朋友」（2026-10-30 加）------------------------------------------
  // 和「支持/购买」放在同一个面板里：产品要推广，但**绝不能**把当前访问地址（带 k= 的钥匙）转出去。
  // 分享文案来自 product.config.json 的 share.text，{link} 会被替换成 share.link。
  // 用 navigator.share（手机系统分享面板）优先，不支持就退回"复制文案"。
  function shareBlockHtml(lic) {
    const s = lic.share || {};
    if (s.enabled === false) return '';
    const link = String(s.link || '').trim();
    const tpl = String(s.text || '').trim()
      || '我在用「手机远程」：手机就能看电脑屏幕，还能点、能打字，出门在外很方便。\n下载试用（免费版日常够用）：{link}';
    const text = tpl.replace(/\{link\}/g, link || '（联系我拿安装包）');
    const title = String(s.title || '分享给朋友');
    let h = '<div style="margin:16px 0 0;padding-top:14px;border-top:1px solid #23252c">'
      + '<div style="color:#8b9098;font-size:12px;margin-bottom:6px">' + esc(title) + '</div>'
      + '<pre id="shareText" style="margin:0;white-space:pre-wrap;word-break:break-word;'
      + 'font:12.5px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#c9ccd1;'
      + 'background:#14151a;border:1px solid #24262e;border-radius:8px;padding:10px;user-select:all">'
      + esc(text) + '</pre>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:9px">'
      + '<button id="shareCopy" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;'
      + 'border-radius:8px;padding:8px 13px;font-size:13px;cursor:pointer">复制分享文案</button>'
      + (typeof navigator !== 'undefined' && navigator.share
        ? '<button id="shareSend" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;'
          + 'padding:8px 14px;font-size:13px;cursor:pointer">用系统分享…</button>'
        : '')
      + '</div>'
      + '<div style="color:#6b7078;font-size:11.5px;line-height:1.6;margin-top:8px">'
      + '只转发这段文字就够了——别把上面带 <code>k=</code> 的完整地址发给别人，那是你这台电脑的钥匙。</div>'
      + '</div>';
    return h;
  }

  // 原「未授权整屏遮罩」blockPage 已删除（半免费 2026-10-29）：免费模式不再拦画面，
  // 粘贴许可证的激活入口移进设置面板「许可证」分区（见 bindLicencePaste）。


  // ---- 右下角两个常驻按钮：齿轮（设置） + 心形（支持）----------------------------
  // 用内嵌 SVG 而不是 emoji/图片：emoji 在不同手机上长相差异大，图片要多一次请求。
  // 46×46 是手机可点的合适尺寸，两个并排放在底部提示条上方，不挡内容。
  const ICON_GEAR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34'
    + ' 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06'
    + 'a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09'
    + 'A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34'
    + 'H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06'
    + 'a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09'
    + 'A1.7 1.7 0 0 0 19.4 15z"/></svg>';
  const ICON_HEART = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M20.8 5.6a5.1 5.1 0 0 0-7.2 0L12 7.2l-1.6-1.6a5.1 5.1 0 1 0-7.2 7.2L12 21.6l8.8-8.8'
    + 'a5.1 5.1 0 0 0 0-7.2z"/></svg>';
  // 套餐按钮图标（价签）——2026-10-30 加：和设置/支持同一套圆形按钮
  const ICON_PRICE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3.3 13.3a2 2 0 0 1-.6-1.5l.2-6.1a2 2 0 0 1 1.9-1.9l6.1-.2'
    + 'a2 2 0 0 1 1.5.6l7.3 7.3a2 2 0 0 1 0 2.8z"/>'
    + '<circle cx="8.2" cy="8.2" r="1.3"/></svg>';
  const BTN_CSS = 'width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
    + 'border-radius:50%;background:rgba(26,28,34,.9);color:#8CE68C;border:1px solid rgba(140,230,140,.38);'
    + 'cursor:pointer;padding:0;backdrop-filter:blur(6px);-webkit-tap-highlight-color:transparent;'
    + 'box-shadow:0 2px 10px rgba(0,0,0,.45)';

  function makeBtn(id, iconHtml, title) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = BTN_CSS;
    b.innerHTML = iconHtml;
    return b;
  }

  function row(label, valueHtml) {
    return '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #202228">'
      + '<div style="color:#8b9098;font-size:13px;min-width:72px">' + escHtml(label) + '</div>'
      + '<div style="flex:1;font-size:13px;word-break:break-all">' + valueHtml + '</div></div>';
  }

  // 通用弹层（设置 / 支持共用外观）
  function openSheet(titleText, bodyHtml, closeId) {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.62);'
      + 'display:flex;align-items:center;justify-content:center;padding:18px';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:460px;width:100%;max-height:84vh;overflow:auto;background:#15161a;color:#e8eaee;'
      + 'border:1px solid #2c2f38;border-radius:14px;padding:20px;'
      + 'font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif';
    box.innerHTML = '<div style="font-size:17px;font-weight:600;margin-bottom:12px">' + escHtml(titleText) + '</div>'
      + bodyHtml
      + '<div style="margin-top:18px;text-align:right"><button id="' + closeId + '" style="background:#2a2d36;'
      + 'color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer">关闭</button></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    box.querySelector('#' + closeId).addEventListener('click', close);
    return box;
  }

  // ---- 设置面板 ---------------------------------------------------------------
  // 用"分区标题 + 卡片"的排版，比之前一列纯文本好扫读；徽章用胶囊+圆点表示状态。
  function setSection(title, inner) {
    return '<div style="margin-top:15px">'
      + '<div style="color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em;'
      + 'margin:0 0 7px 2px">' + escHtml(title) + '</div>'
      + '<div style="background:#1a1c22;border:1px solid #292c35;border-radius:11px;padding:13px 14px">'
      + inner + '</div></div>';
  }
  function setKv(k, v) {
    return '<div style="display:flex;gap:12px;padding:4px 0">'
      + '<div style="color:#868c96;font-size:13px;min-width:74px;flex-shrink:0">' + escHtml(k) + '</div>'
      + '<div style="flex:1;font-size:13px;word-break:break-all">' + v + '</div></div>';
  }
  function setPill(ok, textOk, textBad) {
    const c = ok ? '#8CE68C' : '#ffb454';
    const bg = ok ? 'rgba(140,230,140,.13)' : 'rgba(255,180,84,.13)';
    return '<span style="display:inline-flex;align-items:center;gap:6px;background:' + bg + ';color:' + c
      + ';border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600">'
      + '<span style="width:6px;height:6px;border-radius:50%;background:' + c + '"></span>'
      + escHtml(ok ? textOk : textBad) + '</span>';
  }

  // ---- 设置面板「个性化」分区（许可证功能：主题/光标/自定义导入）------------------
  function p13nInner(lic) {
    const P = window.__paP13n;
    if (!P) return '<div style="color:#868c96;font-size:12.5px">个性化模块未加载</div>';
    const licensed = !!lic.usable;
    const lock = licensed ? '' : ' <span style="font-size:11px">🔒</span>';
    let h = '';
    if (!licensed) {
      h += '<div style="color:#868c96;font-size:12.5px;margin-bottom:10px;line-height:1.6">'
        + '个性化是许可证功能，免费版里显示默认外观。'
        + '<a href="#" id="p13nBuy" style="color:#8fb6ff">看看怎么解锁</a></div>';
    }
    const curT = licensed ? P.loadTheme() : 'dark';
    h += '<div style="color:#868c96;font-size:12px;margin:2px 0 6px">颜色主题' + lock + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap" id="p13nThemes">';
    for (const t of P.THEMES) {
      const on = curT === t.key;
      const locked = !licensed && !t.free;
      h += '<button class="p13nT" data-k="' + t.key + '" style="flex:1;min-width:62px;'
        + 'background:' + (on ? 'rgba(47,111,235,.22)' : '#242730') + ';color:' + (on ? '#8fb6ff' : '#c9ccd1') + ';'
        + 'border:1px solid ' + (on ? '#3f6fd0' : '#343842') + ';border-radius:9px;padding:8px 4px;font-size:12.5px;cursor:pointer">'
        + (locked ? '🔒' : '') + escHtml(t.name) + '</button>';
    }
    h += '</div>';
    const curC = licensed ? (P.loadCursor() || P.DOT_DEFAULT) : P.DOT_DEFAULT;
    const curSize = Math.max(6, Math.min(24, Math.round(Number(curC.size) || P.DOT_DEFAULT.size)));
    const curColor = P.isHex(curC.color) ? String(curC.color) : P.DOT_DEFAULT.color;
    const curShape = P.CURSOR_SHAPES[curC.shape] ? curC.shape : 'dot';
    const hasImg = !!P.loadCursorImg();
    // 光标形状：六种；五种内置形状均可调颜色（2026-10-30 规则澄清），
    // 只有自定义（导入图片）只能调大小、不可调颜色；自定义 = 导入图片
    h += '<div style="color:#868c96;font-size:12px;margin:12px 0 6px">光标形状' + lock + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap" id="p13nShapes">';
    for (const k of P.CURSOR_SHAPE_KEYS) {
      const sp = P.CURSOR_SHAPES[k];
      const on = curShape === k;
      h += '<button class="p13nS" data-s="' + k + '" style="flex:1;min-width:56px;'
        + 'background:' + (on ? 'rgba(47,111,235,.22)' : '#242730') + ';color:' + (on ? '#8fb6ff' : '#c9ccd1') + ';'
        + 'border:1px solid ' + (on ? '#3f6fd0' : '#343842') + ';border-radius:9px;padding:7px 4px;font-size:12px;cursor:pointer;line-height:1.4">'
        + '<span style="font-size:15px">' + sp.icon + '</span><br>' + escHtml(sp.name) + '</button>';
    }
    h += '</div>'
      + '<div id="p13nImgRow" style="gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;display:' + (curShape === 'custom' ? 'flex' : 'none') + '">'
      + '<button id="p13nImgPick" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer"' + (licensed ? '' : ' disabled') + '>选择图片…</button>'
      + '<span id="p13nImgState" style="font-size:11.5px;color:#868c96;flex:1;min-width:140px">'
      + (hasImg ? '已导入自定义图片' : '未导入。支持 PNG/JPG/WebP/GIF，小于 300KB、不超过 512×512，透明底效果最好') + '</span>'
      + (hasImg ? '<button id="p13nImgDel" style="background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer">移除</button>' : '')
      + '<input type="file" id="p13nImgFile" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">'
      + '</div>';
    h += '<div style="color:#868c96;font-size:12px;margin:12px 0 6px">光标大小' + lock + '</div>'
      + '<div style="display:flex;gap:10px;align-items:center">'
      + '<input type="range" id="p13nSize" min="6" max="24" step="1" value="' + curSize + '" style="flex:1"' + (licensed ? '' : ' disabled') + '>'
      + '<span id="p13nSizeV" style="color:#aeb3bb;font-size:12px;min-width:34px;text-align:right">' + curSize + 'px</span>'
      + '<span id="p13nPreview" style="display:inline-block;flex:0 0 auto;box-sizing:border-box;width:' + curSize + 'px;height:' + curSize + 'px;background:' + escHtml(curColor) + ';border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,.8)"></span>'
      + '</div>'
      + '<div style="color:#868c96;font-size:12px;margin:12px 0 6px">光标颜色' + lock
      + ' <span id="p13nColorHint" style="color:#ffb454;font-size:11px' + (curShape === 'custom' ? '' : ';display:none') + '">（自定义图片光标只能调大小，不能改颜色）</span></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap" id="p13nColors">';
    for (const c of P.DOT_COLORS) {
      const on = curColor.toLowerCase() === c.toLowerCase();
      const cOff = !licensed || curShape === 'custom';
      h += '<button class="p13nC" data-c="' + c + '" style="width:30px;height:30px;border-radius:50%;background:' + c + ';'
        + 'border:2px solid ' + (on ? '#8fb6ff' : 'rgba(255,255,255,.18)') + ';cursor:pointer;padding:0;'
        + 'opacity:' + (cOff ? '.4' : '1') + '"' + (cOff ? ' disabled' : '') + '></button>';
    }
    h += '</div>';
    const cust = licensed ? P.loadCustom() : null;
    h += '<div style="color:#868c96;font-size:12px;margin:14px 0 6px">导入自定义主题' + lock + '</div>'
      + '<textarea id="p13nImport" rows="3" spellcheck="false" '
      + 'placeholder=\'JSON，字段都是颜色，例如 {"name":"我的主题","bodyBg":"#101018","headerBg":"#1a1a24","btnBg":"#26262e","btnColor":"#e8e8f0","accent":"#ff9d5c"}\''
      + ' style="width:100%;box-sizing:border-box;background:#0f1014;color:#e8eaee;border:1px solid #262932;border-radius:9px;padding:9px;font:12px/1.5 ui-monospace,Consolas,monospace;resize:vertical"' + (licensed ? '' : ' disabled') + '>'
      + escHtml(cust ? JSON.stringify(cust) : '') + '</textarea>'
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:8px">'
      + '<button id="p13nImportBtn" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer"' + (licensed ? '' : ' disabled') + '>导入并应用</button>'
      + '<span id="p13nMsg" style="font-size:12.5px;color:#868c96;flex:1"></span></div>';
    return h;
  }

  function p13nBind(box, lic) {
    const P = window.__paP13n;
    if (!P) return;
    const licensed = !!lic.usable;
    const msg = box.querySelector('#p13nMsg');
    const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || '#868c96'; } };
    const buy = box.querySelector('#p13nBuy');
    if (buy) buy.addEventListener('click', (e) => { e.preventDefault(); if (window.__paOpenSupport) window.__paOpenSupport(lic); });
    const preview = box.querySelector('#p13nPreview');
    const sizeV = box.querySelector('#p13nSizeV');
    const markTheme = (k) => {
      box.querySelectorAll('.p13nT').forEach((x) => {
        const on = x.getAttribute('data-k') === k;
        x.style.background = on ? 'rgba(47,111,235,.22)' : '#242730';
        x.style.color = on ? '#8fb6ff' : '#c9ccd1';
        x.style.borderColor = on ? '#3f6fd0' : '#343842';
      });
    };
    if (!licensed) {
      // 未授权：点锁定项只提示购买，不改任何偏好
      box.querySelectorAll('.p13nT').forEach((b) => b.addEventListener('click', () => {
        const t = P.themeByKey(b.getAttribute('data-k'));
        if (t && t.free) return;
        setMsg('许可证功能：点上方「看看怎么解锁」或右下角 ❤', '#ffb454');
      }));
      box.querySelectorAll('.p13nS').forEach((b) => b.addEventListener('click', () => {
        if (b.getAttribute('data-s') === 'dot') return;
        setMsg('许可证功能：点上方「看看怎么解锁」或右下角 ❤', '#ffb454');
      }));
      return;
    }
    box.querySelectorAll('.p13nT').forEach((b) => b.addEventListener('click', () => {
      const k = b.getAttribute('data-k');
      if (k === 'custom' && !P.loadCustom()) { setMsg('先在下面导入一个自定义主题，再选「自定义」', '#ffb454'); return; }
      P.saveTheme(k);
      P.applyTheme(k);
      markTheme(k);
      setMsg('已应用主题：' + P.themeByKey(k).name, '#8CE68C');
    }));
    // ---- 光标形状（2026-10-29 新增）----
    const imgRow = box.querySelector('#p13nImgRow');
    const imgPick = box.querySelector('#p13nImgPick');
    const imgFile = box.querySelector('#p13nImgFile');
    const imgState = box.querySelector('#p13nImgState');
    const colorHint = box.querySelector('#p13nColorHint');
    const markShape = (k) => {
      box.querySelectorAll('.p13nS').forEach((x) => {
        const on = x.getAttribute('data-s') === k;
        x.style.background = on ? 'rgba(47,111,235,.22)' : '#242730';
        x.style.color = on ? '#8fb6ff' : '#c9ccd1';
        x.style.borderColor = on ? '#3f6fd0' : '#343842';
      });
    };
    // 2026-10-30 规则澄清：五种内置形状都可调颜色；只有自定义（导入图片）
    // 把色板整行禁用并给出提示。判定走 CURSOR_SHAPES[shape].colorable，单一出处。
    const syncColorRow = (shape) => {
      const canColor = !!(P.CURSOR_SHAPES[shape] && P.CURSOR_SHAPES[shape].colorable);
      box.querySelectorAll('.p13nC').forEach((x) => { x.disabled = !canColor; x.style.opacity = canColor ? '1' : '.4'; });
      if (colorHint) colorHint.style.display = canColor ? 'none' : '';
    };
    const curCursorCfg = () => P.loadCursor() || { size: P.DOT_DEFAULT.size, color: P.DOT_DEFAULT.color };
    const curShapeOf = (c) => P.CURSOR_SHAPES[c.shape] ? c.shape : 'dot';
    const syncPreview = () => {
      const c = curCursorCfg();
      const shape = curShapeOf(c);
      const color = P.isHex(c.color) ? String(c.color) : P.DOT_DEFAULT.color;
      P.styleShapeEl(preview, shape, color, shape === 'custom' ? P.loadCursorImg() : null);
    };
    const ensureImgDel = () => {
      if (!imgRow || box.querySelector('#p13nImgDel')) return;
      const del = document.createElement('button');
      del.id = 'p13nImgDel';
      del.textContent = '移除';
      del.style.cssText = 'background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer';
      del.addEventListener('click', removeImg);
      imgRow.appendChild(del);
    };
    const setShape = (k) => {
      if (k === 'custom' && !P.loadCursorImg()) {
        if (imgRow) imgRow.style.display = 'flex';
        setMsg('先点「选择图片」导入一张光标图，才能用自定义形状', '#ffb454');
        return;
      }
      const c = curCursorCfg();
      c.shape = k;
      P.saveCursor(c); P.applyCursor(c);
      markShape(k);
      syncColorRow(k);
      syncPreview();
      if (imgRow) imgRow.style.display = (k === 'custom') ? 'flex' : 'none';
      setMsg('光标形状：' + P.CURSOR_SHAPES[k].name, '#8CE68C');
    };
    function removeImg() {
      P.clearCursorImg();
      const c = curCursorCfg();
      c.shape = 'dot';
      P.saveCursor(c); P.applyCursor(c);
      markShape('dot'); syncColorRow('dot'); syncPreview();
      if (imgState) imgState.textContent = '未导入。支持 PNG/JPG/WebP/GIF，小于 300KB、不超过 512×512，透明底效果最好';
      const del = box.querySelector('#p13nImgDel');
      if (del && del.parentNode) del.parentNode.removeChild(del);
      setMsg('已移除自定义图片，回到默认圆点', '#8CE68C');
    }
    box.querySelectorAll('.p13nS').forEach((b) => b.addEventListener('click', () => setShape(b.getAttribute('data-s'))));
    if (imgPick && imgFile) imgPick.addEventListener('click', () => imgFile.click());
    const del0 = box.querySelector('#p13nImgDel');
    if (del0) del0.addEventListener('click', removeImg);
    if (imgFile) imgFile.addEventListener('change', () => {
      const f = imgFile.files && imgFile.files[0];
      imgFile.value = '';   // 允许重选同一张图
      if (!f) return;
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(String(f.type || ''))) { setMsg('只支持 PNG / JPG / WebP / GIF 图片', '#ff6b6b'); return; }
      if (f.size > 300 * 1024) { setMsg('图片太大：要小于 300KB（当前 ' + Math.round(f.size / 1024) + 'KB）', '#ff6b6b'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const url = String(fr.result || '');
        if (url.slice(0, 5) !== 'data:') { setMsg('读取图片失败', '#ff6b6b'); return; }
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth > 512 || probe.naturalHeight > 512) {
            setMsg('图片请不超过 512×512（当前 ' + probe.naturalWidth + '×' + probe.naturalHeight + '）', '#ff6b6b');
            return;
          }
          if (!P.saveCursorImg(url)) { setMsg('存储失败：图片太大或存储空间不足', '#ff6b6b'); return; }
          const c = curCursorCfg();
          c.shape = 'custom';
          P.saveCursor(c); P.applyCursor(c);
          markShape('custom'); syncColorRow('custom'); syncPreview();
          if (imgState) imgState.textContent = '已导入自定义图片（' + probe.naturalWidth + '×' + probe.naturalHeight + '）';
          if (imgRow) imgRow.style.display = 'flex';
          ensureImgDel();
          setMsg('已导入并应用自定义光标', '#8CE68C');
        };
        probe.onerror = () => setMsg('图片解码失败，换一张试试', '#ff6b6b');
        probe.src = url;
      };
      fr.onerror = () => setMsg('读取图片失败', '#ff6b6b');
      fr.readAsDataURL(f);
    });
    syncColorRow(curShapeOf(curCursorCfg()));
    syncPreview();

    const sz = box.querySelector('#p13nSize');
    if (sz) sz.addEventListener('input', () => {
      const n = Math.max(6, Math.min(24, Number(sz.value) || 10));
      if (sizeV) sizeV.textContent = n + 'px';
      const c = P.loadCursor() || { size: P.DOT_DEFAULT.size, color: P.DOT_DEFAULT.color };
      c.size = n;
      P.saveCursor(c); P.applyCursor(c);
      if (preview) { preview.style.width = n + 'px'; preview.style.height = n + 'px'; }
    });
    box.querySelectorAll('.p13nC').forEach((b) => b.addEventListener('click', () => {
      const c = b.getAttribute('data-c');
      const cur = P.loadCursor() || { size: P.DOT_DEFAULT.size, color: P.DOT_DEFAULT.color };
      cur.color = c;
      P.saveCursor(cur); P.applyCursor(cur);
      box.querySelectorAll('.p13nC').forEach((x) => { x.style.borderColor = (x.getAttribute('data-c') === c) ? '#8fb6ff' : 'rgba(255,255,255,.18)'; });
      syncPreview();
    }));
    const ib = box.querySelector('#p13nImportBtn');
    if (ib) ib.addEventListener('click', () => {
      const ta = box.querySelector('#p13nImport');
      let j = null;
      try { j = JSON.parse(String((ta && ta.value) || '').trim()); } catch (e) { j = null; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) { setMsg('不是合法的 JSON', '#ff6b6b'); return; }
      const hexFields = ['bodyBg', 'textColor', 'headerBg', 'btnBg', 'btnColor', 'btnBorder', 'accent', 'inputBg'];
      for (const f of hexFields) {
        if (j[f] != null && j[f] !== '' && !P.isHex(j[f])) { setMsg('字段 ' + f + ' 不是颜色值（示例 #ff9d5c）', '#ff6b6b'); return; }
      }
      if (j.name != null) j.name = String(j.name).slice(0, 24);
      P.saveCustom(j);
      P.saveTheme('custom');
      P.applyTheme('custom');
      markTheme('custom');
      setMsg('已导入并应用' + (j.name ? '：' + j.name : ''), '#8CE68C');
    });
  }

  // 免费模式：在设置面板「许可证」区粘贴激活（原整屏遮罩已随半免费取消）
  function bindLicencePaste(box) {
    const la = box.querySelector('#setLicApply');
    if (!la) return;
    la.addEventListener('click', async () => {
      const ta = box.querySelector('#setLicPaste');
      const m = box.querySelector('#setLicMsg');
      const setM = (t, c) => { if (m) { m.textContent = t; m.style.color = c; } };
      const text = (((ta && ta.value) || '') + '').trim();
      if (!text) { setM('请先粘贴许可证内容', '#ffb454'); return; }
      la.disabled = true; la.style.opacity = '.6'; la.textContent = '验证中…';
      let res;
      try {
        const r = await fetch('/licence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }) });
        res = await r.json();
      } catch (e) { res = { ok: false, message: '提交失败：' + e.message }; }
      if (!res || !res.ok) {
        setM((res && res.message) || '验证没通过', '#ff6b6b');
        la.disabled = false; la.style.opacity = '1'; la.textContent = '验证并安装';
        return;
      }
      la.textContent = '已接受，正在生效…';
      setM('许可证已接受，正在生效…', '#4ade80');
      const started = Date.now();
      const tick = async () => {
        try {
          const j = await fetch('/licence?_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json());
          // 必须看 licensed（真的装了许可证），不能看 usable：试用期内 usable 本来就是 true，
          // 用它判断会在守护进程还没重新校验许可证时就"假成功"刷新页面（用户会看到还是免费版）。
          const accepted = j && ((typeof j.licensed === 'boolean') ? j.licensed : !!j.usable);
          if (accepted) { setM('好了！正在刷新页面…', '#4ade80'); setTimeout(() => location.reload(), 800); return; }
        } catch (e) { }
        if (Date.now() - started > 20000) {
          setM('已保存，但还没生效。刷新页面看看。', '#ffb454');
          la.disabled = false; la.style.opacity = '1'; la.textContent = '刷新页面试试';
          la.onclick = () => location.reload();
          return;
        }
        setTimeout(tick, 1500);
      };
      setTimeout(tick, 1200);
    });
  }

  // ---- 「许可证」分区：专业版 / 免费版 + 试用剩余 + 粘贴激活 -------------------
  // 改动（2026-10-30，用户真机/虚拟机实测反馈）：原来这里用 lic.usable 判断"已授权"，
  // 但 /licence 的 usable 语义是"全功能可用（正式许可证 **或** 7 天试用期内）"。
  // 于是新装还没付款的用户在试用期内被显示成「已授权 · 有效期 永久」，
  // 而且粘贴框是按 lic.usable 隐藏的 —— 客户真买了反而找不到粘贴的地方。
  // 现在显示口径统一用 lic.licensed（真的装了许可证）：
  //   专业版 = 有许可证；免费版 = 没有（再写清"试用还剩几天 / 是不是已结束"）。
  // lic.usable 仍然只负责"解锁超清/个性化/并发"的行为判断，不进文案。
  function trialSummary(trial) {
    const t = trial || null;
    const days = (t && Number(t.days)) > 0 ? Number(t.days) : 7;
    if (t && t.active) {
      const left = Number(t.daysLeft || 0);
      const ends = String(t.ends || '').slice(0, 10);
      let s = days + ' 天全功能试用中 · ' + (left > 0 ? ('还剩 ' + left + ' 天') : '今天到期');
      if (ends) s += '（' + ends + ' 到期）';
      return s;
    }
    if (t && t.state === 'expired') return days + ' 天全功能试用已结束';
    if (t && t.state === 'clock-tamper') return '试用已失效（检测到系统时间被调过）';
    if (t && t.state === 'no-machine') return '读不到机器码，试用无法校验（按免费版）';
    return '';
  }

  function pasteBlock(compact) {
    return '<div' + (compact
      ? ' style="margin-top:10px"'
      : ' style="margin-top:12px;padding-top:11px;border-top:1px solid #23252c"') + '>'
      + '<div style="font-weight:600;margin-bottom:6px;font-size:13.5px">已有许可证？粘贴到这里激活</div>'
      + '<textarea id="setLicPaste" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" '
      + 'placeholder="把卖家发你的整段文字原样粘贴进来…" style="width:100%;box-sizing:border-box;background:#0f1014;color:#e8eaee;'
      + 'border:1px solid #262932;border-radius:9px;padding:9px;font:12px/1.5 ui-monospace,Consolas,monospace;resize:none"></textarea>'
      + '<div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<button id="setLicApply" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;padding:9px 15px;'
      + 'font-size:13.5px;cursor:pointer">验证并安装</button>'
      + '<span id="setLicMsg" style="font-size:12.5px;color:#868c96"></span></div></div>';
  }

  // 2026-10-31：新增「体验版」（¥10 / 1 个月全功能）。许可证 payload 里 edition='trial'（或 'month'）
  // 就显示体验版徽章；其它 edition（basic/owner/test…）显示专业版。到期时间由许可证 expires 控制，
  // 到期后 licensed=false，自动回落免费版。
  function licenceKind(lic) {
    const e = String((lic && lic.edition) || '').toLowerCase();
    if (e === 'trial' || e === 'trial30' || e === 'month') {
      return { label: '体验版', trial: true, color: '#8fb6ff', bg: 'rgba(143,182,255,.13)', border: 'rgba(143,182,255,.4)' };
    }
    return { label: '专业版', trial: false, color: '#8CE68C', bg: 'rgba(140,230,140,.13)', border: 'rgba(140,230,140,.4)' };
  }
  function licencePill(lic, licensed) {
    const k = licensed ? licenceKind(lic)
      : { label: '免费版', color: '#ffb454', bg: 'rgba(255,180,84,.13)', border: 'rgba(255,180,84,.45)' };
    return '<span style="display:inline-flex;align-items:center;gap:6px;background:' + k.bg + ';color:' + k.color
      + ';border:1px solid ' + k.border + ';border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600">'
      + '<span style="width:6px;height:6px;border-radius:50%;background:' + k.color + '"></span>'
      + escHtml(k.label) + '</span>';
  }
  function daysLeftText(exp) {
    if (!exp || exp === 'never') return '';
    const t = Date.parse(String(exp) + 'T23:59:59');
    if (!Number.isFinite(t)) return '';
    const d = Math.ceil((t - Date.now()) / 86400000);
    return d > 0 ? '（还剩 ' + d + ' 天）' : '';
  }

  function licenceInner(lic) {
    const licensed = !!lic.licensed;
    const exp = (lic.expires && lic.expires !== 'never') ? String(lic.expires) : '永久';
    const uq = lic.ultraQuota || null;
    const kind = licenceKind(lic);
    let h = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'
      + licencePill(lic, licensed)
      + (lic.name ? '<span style="color:#aeb3bb;font-size:13px">' + escHtml(String(lic.name)) + '</span>' : '')
      + '</div>';
    // 有许可证文件但没通过（换了机器 / 过期 / 文件损坏）：把原因摆出来，
    // 否则客户只看到"免费版"会以为标错了。
    if (!licensed && lic.state && lic.state !== 'missing' && lic.state !== 'ok') {
      h += '<div style="margin-top:8px;color:#ffb454;font-size:12.5px;line-height:1.6">'
        + escHtml(String(lic.message || '许可证校验没通过')) + '</div>';
    }
    if (licensed) {
      h += '<div style="margin-top:8px">' + setKv('有效期', escHtml(exp) + (exp === '永久' ? '' : daysLeftText(exp))) + '</div>'
        + (kind.trial
          ? '<div style="color:#8fb6ff;font-size:12.5px;margin-top:6px;line-height:1.7">'
            + '体验版：1 个月全功能（超清不限时 · 个性化 · 多设备）。<br>'
            + '到期后自动回落免费版，不自动续费；想继续用可以买专业版（一次买断）。</div>'
          : '<div style="color:#868c96;font-size:12.5px;margin-top:6px;line-height:1.7">'
            + '超清画质不限时长 · 个性化已解锁 · 同时观看不限台数</div>');
      // 已授权也保留粘贴入口（换许可证 / 续期要用），默认折叠不占地方
      h += '<details style="margin-top:12px;padding-top:10px;border-top:1px solid #23252c">'
        + '<summary style="cursor:pointer;color:#8fb6ff;font-size:13px">换许可证 / 续期：点这里粘贴新的</summary>'
        + pasteBlock(true) + '</details>';
      return h;
    }
    const trialOn = !!(lic.trial && lic.trial.active);
    const tl = trialSummary(lic.trial);
    if (tl) {
      h += '<div style="margin-top:9px;font-size:13px;line-height:1.6;color:' + (trialOn ? '#8CE68C' : '#ffb454') + '">'
        + escHtml(tl) + '</div>';
    }
    h += '<div style="color:#868c96;font-size:12.5px;margin-top:5px;line-height:1.7">'
      + (trialOn
        ? '试用期内按专业版算：超清不限时长 · 个性化全开 · 同时观看不限台数<br>'
          + '试用结束后不会锁画面，自动回落到免费版（基础功能一直免费）。'
        : '免费版可用：画面 + 触控 + 声音 + 流畅模式 + 高清/标准画质（不限时）<br>'
          + '免费版限制：超清每天 1 小时 · 个性化锁定 · 同时观看最多 3 台')
      + '</div>';
    // 每日超清配额只对"真的免费版"有意义：试用期内超清本来就不限时，别显示这行让人误解
    if (!trialOn && uq && uq.ultra) {
      h += '<div style="color:' + (uq.exhausted ? '#ffb454' : '#868c96') + ';font-size:12.5px;margin-top:6px">'
        + (uq.exhausted ? '今日超清时长已用完 · 正按高清出图 · 明天 0 点恢复'
          : '今日超清还剩约 ' + fmtUq(uq.remainingSec) + '（免费版每天 ' + fmtUq(uq.limitSec) + '）') + '</div>';
    }
    h += pasteBlock(false);
    return h;
  }

  function openSettings(lic) {
    const ver = String(lic.version || '—');
    let body = '';
    const uq = lic.ultraQuota || null;   // 画面质量分区也要用（超清配额提示）
    body += setSection('许可证', licenceInner(lic));

    // 机器码（可复制）
    body += setSection('本机机器码',
      '<div style="color:#868c96;font-size:12.5px;margin-bottom:8px">换许可证、报修时把这一串发给卖家</div>'
      + '<div style="display:flex;gap:8px;align-items:stretch">'
      + '<code style="flex:1;display:flex;align-items:center;font:14px/1.3 ui-monospace,Consolas,monospace;'
      + 'color:#e8eaee;background:#0f1014;border:1px solid #262932;border-radius:9px;padding:9px 11px;'
      + 'user-select:all;letter-spacing:.02em">' + escHtml(lic.machineCode || '—') + '</code>'
      + '<button id="setCopyCode" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:0 13px;font-size:13px;cursor:pointer;white-space:nowrap">复制</button>'
      + '</div>');

    // 连接与画面
    let connInner = setKv('地址', '<span style="color:#aeb3bb">' + escHtml(location.host) + '</span>');
    try {
      const im = document.querySelector('#stream, #frame, img[src*="frame"], img[src*="stream"]');
      const w = im && im.naturalWidth ? im.naturalWidth : 0;
      const h = im && im.naturalHeight ? im.naturalHeight : 0;
      if (w && h) connInner += setKv('分辨率', w + ' × ' + h);
    } catch (e) { }
    try {
      const hud = document.querySelector('#hud');
      if (hud && hud.textContent && hud.textContent.trim()) {
        connInner += setKv('实时', '<span style="color:#aeb3bb">' + escHtml(hud.textContent.trim()) + '</span>');
      }
    } catch (e) { }
    body += setSection('连接与画面', connInner);

    // 画面质量（2026-10-30 起 = "发送宽度"档位；抓屏固定原生分辨率，服务端缩放，切换立即生效）
    // 半免费档位命名（2026-10-29 起）：超清 2560（未授权每天免费 1 小时）/ 高清 1920 / 标准 1440（免费不限时）
    // 改动（2026-10-29 用户反馈"三档看不出差距"）：机制实测正常（1440/2560 全链路验证），差距是感知问题——
    // 手机屏会把三档都压到屏幕宽。所以按钮上直接标流量估算，说明文案讲清"差距在放大细节和流量"。
    // 2026-10-30 实测纠正：页面 viewport 设了 maximum-scale=1，**双指缩放是禁用的**（双指手势 = 滚动），
    // 所以文案里不能再写"双指放大看小字"。这里只描述真实存在的差别：发送宽度 / 文字边缘 / 流量。
    const QUAL = [[2560, '超清', '字最清楚 · 文字边缘更锐利', '约26GB/时'], [1920, '高清', '清晰流畅平衡', '约15GB/时'], [1440, '标准', '最省流量 · 弱网最流畅', '约8GB/时']];
    const curW = Number(lic.captureWidth || 0);
    let qInner = '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    for (const [w, label, tip, flow] of QUAL) {
      const on = (curW === w) || (curW === 0 && w === 2560);
      const badge = (w > 1920 && !lic.usable) ? ' · 🔒1小时/天' : '';
      qInner += '<button class="paQ" data-w="' + w + '" title="' + escHtml(tip) + '" style="flex:1;min-width:78px;'
        + 'background:' + (on ? 'rgba(47,111,235,.22)' : '#242730') + ';'
        + 'color:' + (on ? '#8fb6ff' : '#c9ccd1') + ';'
        + 'border:1px solid ' + (on ? '#3f6fd0' : '#343842') + ';border-radius:9px;padding:9px 6px;'
        + 'font-size:13px;cursor:pointer;line-height:1.35">' + escHtml(label)
        + '<br><span style="font-size:11px;color:#868c96">' + w + '</span>'
        + '<br><span style="font-size:10.5px;color:#6f7580">' + flow + badge + '</span></button>';
    }
    qInner += '</div>';
    if (!lic.usable && uq && uq.ultra) {
      qInner += '<div style="color:' + (uq.exhausted ? '#ffb454' : '#868c96') + ';font-size:12px;margin-top:8px;line-height:1.6">'
        + (uq.exhausted
          ? '今日超清时长已用完 · 当前按高清出图 · 明天 0 点恢复'
          : '今日超清还剩约 ' + fmtUq(uq.remainingSec) + '（每天免费 ' + fmtUq(uq.limitSec) + '）')
        + '</div>';
    }
    qInner += '<div style="color:#868c96;font-size:11.5px;margin-top:9px;line-height:1.6">'
      + '切换后立即生效，不用重启。抓屏始终按电脑原分辨率，三档只是「发到手机上的宽度」：<br>'
      + '数字小的更省流量；数字大的文字边缘更清楚（帧率三档一样）。<br>'
      + '手机屏会把画面压到屏幕宽，正常看差别不大，差别主要在文字密集的界面和流量。<br>'
      + '想看更细：选超清档；或者用手机系统的放大功能（设置 → 无障碍 → 放大手势），网页本身没有缩放。<br>'
      + '高清/标准免费不限时；超清未授权每天免费 1 小时，许可证不限时长。</div>'
      + '<div id="setQMsg" style="font-size:12.5px;color:#868c96;margin-top:8px"></div>';
    // 2026-10-30 画质修复：抓屏宽度不再随档位变（详情见 screen-server.mjs 顶部注释），
    // 所以换档不需要重启；这里也不再写「请双击桌面重启」。
    body += setSection('画面质量', qInner);

    // 个性化（许可证功能；未授权显示锁定说明与购买入口）
    body += setSection('个性化', p13nInner(lic));


    // 版本与更新
    body += setSection('版本与更新',
      setKv('当前版本', '<span style="color:#aeb3bb">' + escHtml(ver) + '</span>')
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:11px;flex-wrap:wrap">'
      + '<button id="setCheckUpd" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
      + 'padding:9px 15px;font-size:13px;cursor:pointer">检查更新</button>'
      + '<span id="setUpdMsg" style="font-size:12.5px;color:#868c96;flex:1;min-width:120px"></span>'
      + '</div>'
      + '<div id="setUpdBox" style="display:none;margin-top:10px;padding:10px 12px;border-radius:9px;'
      + 'background:#0f1014;border:1px solid #262932;font-size:12.5px;color:#c9ccd1"></div>');

    // 底部操作
    body += '<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">'
      + '<button id="setCopyUrl" style="flex:1;min-width:118px;background:#2a2d36;color:#e8eaee;'
      + 'border:1px solid #3a3e4a;border-radius:9px;padding:11px 14px;font-size:13.5px;cursor:pointer">复制完整地址</button>'
      + '<button id="setReload" style="flex:1;min-width:118px;background:#2a2d36;color:#e8eaee;'
      + 'border:1px solid #3a3e4a;border-radius:9px;padding:11px 14px;font-size:13.5px;cursor:pointer">重新连接</button></div>'
      + '<div style="margin-top:11px;color:#5c6169;font-size:11.5px;line-height:1.6">'
      + '完整地址里含访问密钥，只复制给你自己的设备。<br>'
      + '检查更新只在你点按钮时联网一次，产品平时不会主动连接任何服务器。'
      + '</div>';

    const box = openSheet('设置', body, 'setClose');

    // 个性化 + 许可证粘贴激活的事件绑定（半免费）
    p13nBind(box, lic);
    bindLicencePaste(box);

    // 复制机器码
    const cc = box.querySelector('#setCopyCode');
    if (cc) cc.addEventListener('click', () => {
      if (copyText(lic.machineCode)) { cc.textContent = '已复制'; setTimeout(() => { cc.textContent = '复制'; }, 1500); }
    });

    // 复制完整地址
    const cu = box.querySelector('#setCopyUrl');
    if (cu) cu.addEventListener('click', () => {
      if (copyText(location.href)) { cu.textContent = '已复制'; setTimeout(() => { cu.textContent = '复制完整地址'; }, 1500); }
    });
    const rl = box.querySelector('#setReload');
    if (rl) rl.addEventListener('click', () => location.reload());

    // 画面质量按钮：POST /set-quality（服务端立即按新宽度发送，无需重启/重连）
    const qMsg = box.querySelector('#setQMsg');
    const qBtns = [...box.querySelectorAll('.paQ')];
    qBtns.forEach((b) => b.addEventListener('click', async () => {
      const w = Number(b.getAttribute('data-w'));
      if (!w || b.dataset.busy === '1') return;
      qBtns.forEach((x) => { x.dataset.busy = '1'; x.style.opacity = '.6'; });
      if (qMsg) { qMsg.style.color = '#8fb6ff'; qMsg.textContent = '正在应用…'; }
      let r = null;
      try {
        r = await fetch('/set-quality', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ captureWidth: w })
        }).then((x) => x.json());
      } catch (e) { r = null; }
      if (!r || !r.ok) {
        qBtns.forEach((x) => { x.dataset.busy = ''; x.style.opacity = '1'; });
        if (qMsg) { qMsg.style.color = '#ff6b6b'; qMsg.textContent = (r && r.message) || '设置失败'; }
        return;
      }
      // 已生效：画质现在只是"发送宽度"，服务端逐帧按新宽度缩放，不需要重启也不用重连。
      // 直接把高亮刷到新档位上，避免用户以为没点中。
      const applied = Number((r && r.captureWidth) || 0);
      if (applied) {
        qBtns.forEach((x) => {
          const on = Number(x.getAttribute('data-w')) === applied;
          x.style.background = on ? 'rgba(47,111,235,.22)' : '#242730';
          x.style.color = on ? '#8fb6ff' : '#c9ccd1';
          x.style.borderColor = on ? '#3f6fd0' : '#343842';
        });
      }
      if (qMsg) {
        qMsg.style.color = '#8CE58C';
        // 服务端 message 附带"实际发送宽度 + 超清配额提醒"，原样透出
        qMsg.textContent = (r && r.message) || '已生效，不用重启。';
      }
      qBtns.forEach((x) => { x.dataset.busy = ''; x.style.opacity = '1'; });
    }));
    // 检查更新：客户主动点才发一次请求，平时不联网
    const ck = box.querySelector('#setCheckUpd');
    const msg = box.querySelector('#setUpdMsg');
    const ubox = box.querySelector('#setUpdBox');
    const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || '#868c96'; } };
    if (ck) ck.addEventListener('click', async () => {
      ck.disabled = true;
      ck.style.opacity = '.65';
      ck.textContent = '检查中…';
      setMsg('');
      if (ubox) { ubox.style.display = 'none'; ubox.innerHTML = ''; }
      let j = null;
      try {
        j = await fetch('/update-check', { cache: 'no-store' }).then((r) => r.json());
      } catch (e) { j = null; }
      ck.disabled = false;
      ck.style.opacity = '1';
      ck.textContent = '检查更新';
      if (!j) { setMsg('检查没成功，稍后再试', '#ff6b6b'); return; }
      if (j.error) { setMsg(j.error, '#ff6b6b'); return; }
      if (!j.configured) {
        setMsg('还没配置更新源', '#ffb454');
        if (ubox) {
          ubox.style.display = 'block';
          ubox.innerHTML = '当前版本 <b style="color:#e8eaee">' + escHtml(j.current || ver) + '</b>。<br>'
            + '需要新版时联系卖家拿安装包，双击安装即可——<b style="color:#8CE68C">配置和许可证都会保留</b>。';
        }
        return;
      }
      if (j.hasUpdate) {
        setMsg('有新版本', '#8CE68C');
        if (ubox) {
          const hasDl = !!j.downloadUrl;
          ubox.style.display = 'block';
          ubox.innerHTML = '<div style="color:#8CE68C;font-weight:600;margin-bottom:6px">新版本 '
            + escHtml(j.latest) + '（当前 ' + escHtml(j.current) + '）</div>'
            + (j.notes ? '<div style="margin-bottom:8px;white-space:pre-wrap">' + escHtml(j.notes) + '</div>' : '')
            + '<div style="color:#868c96;margin-bottom:10px">安装新版不会丢配置和许可证。</div>'
            + (hasDl
              ? '<div id="updProgWrap" style="display:none;margin:0 0 8px">'
                  + '<div style="height:6px;background:#0f1014;border:1px solid #262932;border-radius:5px;overflow:hidden">'
                  + '<div id="updBar" style="height:100%;width:0;background:#8CE68C;transition:width .25s"></div></div>'
                  + '<div id="updProg" style="color:#868c96;margin-top:6px;font-size:12px"></div></div>'
                + '<button id="updGo" style="background:#2f6b3a;color:#e8eaee;border:0;border-radius:9px;padding:9px 16px;font-size:13px;cursor:pointer">'
                + (j.mirror ? '用国内镜像下载' : '下载并安装') + '</button>'
                + (j.fallbackUrl ? ' <button id="updGo2" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:9px 14px;font-size:13px;cursor:pointer">改用 GitHub 下载</button>' : '')
                + '<div id="updGoMsg" style="color:#868c96;margin-top:8px;font-size:12px"></div>'
                + '<div style="margin-top:10px;color:#6b7078;font-size:11.5px;line-height:1.7">'
                + '下载不动多半是网络到 GitHub 不通。可以点「打开发布页」用浏览器/下载工具下，或者让卖家发国内网盘链接。<br>'
                + '<a href="' + escHtml(j.pageUrl || '#') + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">打开发布页</a>'
                + ' · <a id="updCopy" href="#" style="color:#8fb6ff">复制下载地址</a>'
                + (j.mirrorPage ? ' · <a href="' + escHtml(j.mirrorPage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">国内网盘下载（手动）</a>'
                  + (j.mirrorPageNote ? '<span style="color:#6b7078">（' + escHtml(j.mirrorPageNote) + '）</span>' : '') : '')
                + '</div>'
              : '<div style="color:#868c96">这次发布没有附安装包，去发布页手动下载：'
                + escHtml(j.pageUrl || '') + '</div>');
          const go = ubox.querySelector('#updGo');
          const go2 = ubox.querySelector('#updGo2');
          const m = ubox.querySelector('#updGoMsg');
          const bar = ubox.querySelector('#updBar');
          const prog = ubox.querySelector('#updProg');
          const wrap = ubox.querySelector('#updProgWrap');
          let pollTimer = 0;
          const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } };
          const fmtMb = (n) => (Number(n) / 1024 / 1024).toFixed(1) + ' MB';
          const poll = async () => {
            try {
              const p = await fetch('/update-progress?_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json());
              if (!prog) return;
              if (p.phase === 'connecting') prog.textContent = '正在连接下载服务器…（20 秒没响应会自动失败）';
              else if (p.phase === 'downloading') {
                const pct = p.total ? p.pct : 0;
                if (bar) bar.style.width = (p.total ? pct : 5) + '%';
                prog.textContent = '已下载 ' + fmtMb(p.bytes) + (p.total ? ' / ' + fmtMb(p.total) + '（' + pct + '%）' : '')
                  + (p.speedKB ? ' · ' + (p.speedKB / 1024).toFixed(1) + ' MB/s' : '')
                  + (p.total && p.speedKB ? ' · 预计还需 ' + Math.max(1, Math.round((p.total - p.bytes) / (p.speedKB * 1024) / 60)) + ' 分钟' : '')
                  + (p.idleSec > 6 ? ' · 已 ' + p.idleSec + ' 秒没新数据…' : '');
              } else if (p.phase === 'done') prog.textContent = '下载完成，正在打开安装程序…';
              else if (p.phase === 'error') prog.textContent = p.error || '下载失败';
            } catch (e) { }
          };
          const start = async (url, btn) => {
            if (!url) return;
            if (wrap) wrap.style.display = 'block';
            if (bar) bar.style.width = '2%';
            if (prog) prog.textContent = '正在连接下载服务器…';
            if (m) m.textContent = '';
            [go, go2].forEach((b) => { if (b) { b.disabled = true; b.style.opacity = '.6'; } });
            if (btn) btn.textContent = '下载中…';
            stopPoll();
            pollTimer = setInterval(poll, 1000);
            poll();
            let r = null;
            try {
              r = await fetch('/update-install', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url })
              }).then((x) => x.json());
            } catch (e) { r = null; }
            stopPoll();
            poll();
            [go, go2].forEach((b) => { if (b) { b.disabled = false; b.style.opacity = '1'; } });
            if (btn) btn.textContent = (j.mirror && url === j.mirror) ? '用国内镜像下载' : '下载并安装';
            if (m) {
              m.style.color = (r && r.ok) ? '#8CE58C' : '#ff6b6b';
              m.textContent = (r && r.message) || '下载没成功：网络可能到不了 GitHub，可以重试、改用另一个源，或让卖家发国内网盘链接。';
            }
            if (r && r.ok && bar) bar.style.width = '100%';
          };
          if (go) go.addEventListener('click', () => start(j.downloadUrl, go));
          if (go2) go2.addEventListener('click', () => start(j.fallbackUrl, go2));
          const cp = ubox.querySelector('#updCopy');
          if (cp) cp.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (copyText(j.downloadUrl || '')) {
              cp.textContent = '已复制';
              setTimeout(() => { cp.textContent = '复制下载地址'; }, 1500);
            }
          });
        }
      } else {
        setMsg('已是最新版本', '#8CE68C');
        if (ubox) { ubox.style.display = 'block'; ubox.innerHTML = '当前 ' + escHtml(j.current) + '，没有更新的版本。'; }
      }
    });
  }


  // 套餐面板（2026-10-30）：三档价格的卡片页。内容全部来自 product.config.json 的 plans，
  // 卖家改价/改文案不用改代码；每张卡下方统一给收款码与联系方式（复用支持面板的渲染）。
  function openPlans(lic) {
    const plans = (lic && lic.plans) || {};
    const items = Array.isArray(plans.items) ? plans.items : [];
    let body = '';
    if (plans.note) {
      body += '<div style="color:#8b9098;font-size:13px;margin-bottom:10px">' + escHtml(plans.note) + '</div>';
    }
    items.forEach((p) => {
      const hl = !!p.highlight;
      const feats = (p.features || []).map((f) => '<li style="margin:3px 0">' + escHtml(f) + '</li>').join('');
      body += '<div style="border:1px solid ' + (hl ? '#3f7a4a' : '#2c2f38') + ';border-radius:12px;'
        + 'padding:13px 14px;margin-bottom:10px;background:' + (hl ? 'rgba(47,107,58,.16)' : '#1a1c22') + '">'
        + '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap">'
        + '<div style="font-size:15px;font-weight:600;color:' + (hl ? '#8CE68C' : '#e8eaee') + '">'
        + escHtml(p.name || '') + '</div>'
        + (p.tag ? '<span style="font-size:11px;color:' + (hl ? '#8CE68C' : '#868c96')
          + ';border:1px solid currentColor;border-radius:20px;padding:1px 8px">' + escHtml(p.tag) + '</span>' : '')
        + '</div>'
        + '<div style="margin:6px 0 2px"><span style="font-size:22px;font-weight:700;color:#e8eaee">'
        + escHtml(p.price || '') + '</span><span style="font-size:12px;color:#868c96;margin-left:6px">'
        + escHtml(p.unit || '') + '</span></div>'
        + (feats ? '<ul style="margin:8px 0 0;padding-left:18px;color:#aeb3bb;font-size:13px;line-height:1.65">'
          + feats + '</ul>' : '')
        + (p.small ? '<div style="margin-top:8px;color:#6b7078;font-size:11.5px">' + escHtml(p.small) + '</div>' : '')
        + '</div>';
    });
    body += '<div style="color:#868c96;font-size:12px;line-height:1.75;margin-top:4px">'
      + '· 许可证按机器绑定（CPU + 主板），换硬盘、重装系统不受影响<br>'
      + '· 付款后把「机器码 + 付款截图」发给作者，签发后手机上粘贴即生效<br>'
      + '· 联系方式：</div>'
      + '<div style="margin-top:10px">' + supportHtml(lic, true) + '</div>';
    openSheet(plans.title || '套餐与价格', body, 'plClose');
  }
  function openSupport(lic) {
    const title = (lic.support && lic.support.title) ? lic.support.title : '支持 / 购买';
    // 三种状态分开显示（2026-10-30 加试用）：专业版 / 免费版·试用中 / 免费版
    // 口径与设置面板一致：一律看 licensed，不看 usable（usable 试用期内也是 true）。
    const trialLine = trialSummary(lic.trial);
    const stKind = licenceKind(lic);
    const stExp = (lic.expires && lic.expires !== 'never') ? String(lic.expires) : '';
    const statusText = lic.licensed
      ? (stKind.label + '（' + (stExp ? '有效期至 ' + stExp : '永久') + '）')
      : ('免费版' + (trialLine ? ' · ' + trialLine : ''));
    const body = '<div style="color:#8b9098;font-size:13px;margin-bottom:4px">当前版本：'
      + escHtml(statusText)
      + (lic.name ? ('（' + escHtml(lic.name) + '）') : '') + '</div>'
      + (lic.licensed ? '' :
        (lic.trial && lic.trial.active
          ? '<div style="background:#1a1c22;border:1px solid #2b3a2f;border-radius:11px;padding:12px 13px;margin:10px 0 0;font-size:12.5px;line-height:1.8;color:#aeb3bb">'
            + '<div style="color:#8CE68C;font-weight:600;margin-bottom:4px">试用中：全功能已解锁</div>'
            + '· 超清画质（2560）不限时长<br>'
            + '· 个性化：主题 / 光标形状与颜色 / 自定义导入<br>'
            + '· 多设备同时观看不限台数<br>'
            + '<span style="color:#6b7078">到期时间 ' + escHtml(String(lic.trial.ends || ''))
            + '，之后自动回落免费版（基础功能永久免费）</span></div>'
          : '<div style="background:#1a1c22;border:1px solid #292c35;border-radius:11px;padding:12px 13px;margin:10px 0 0;font-size:12.5px;line-height:1.8;color:#aeb3bb">'
            + '<div style="color:#e8eaee;font-weight:600;margin-bottom:4px">安装许可证后解锁</div>'
            + '· 超清画质（2560）不限时长 —— 免费版每天 1 小时<br>'
            + '· 个性化：颜色主题 / 光标形状（含导入自定义图片）/ 光标大小颜色 / 自定义主题导入<br>'
            + '· 多设备同时观看：免费版最多 3 台<br>'
            + '<span style="color:#6b7078">基础功能永久免费：画面、触控、声音、流畅模式、高清/标准画质</span></div>'))
      + machineCodeHtml(lic)
      + '<div style="margin-top:16px">' + supportHtml(lic, true) + '</div>'
      + shareBlockHtml(lic);
    const box = openSheet(title, body, 'spClose');
    const cp = box.querySelector('#licCopy');
    if (cp) cp.addEventListener('click', () => {
      if (copyText(lic.machineCode)) { cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制'; }, 1500); }
    });
    // 分享给朋友：复制文案 / 系统分享（不支持 navigator.share 的环境自动退回复制）
    const shareTextEl = box.querySelector('#shareText');
    const shareText = () => (shareTextEl ? shareTextEl.textContent : '');
    const sc = box.querySelector('#shareCopy');
    if (sc) sc.addEventListener('click', () => {
      if (copyText(shareText())) {
        sc.textContent = '已复制';
        setTimeout(() => { sc.textContent = '复制分享文案'; }, 1500);
      } else {
        sc.textContent = '复制失败：长按上面文字手动复制';
      }
    });
    const ss = box.querySelector('#shareSend');
    if (ss) ss.addEventListener('click', async () => {
      try {
        await navigator.share({ title: (lic.share && lic.share.title) || '手机远程', text: shareText() });
      } catch (e) {
        if (copyText(shareText())) {
          ss.textContent = '已复制';
          setTimeout(() => { ss.textContent = '用系统分享…'; }, 1500);
        }
      }
    });
  }

  function bottomButtons(lic) {
    const wrap = document.createElement('div');
    wrap.id = 'paBtns';
    // 纵排（上下叠）贴在屏幕最右边：齿轮在上、支持在下。
    // 用 column + gap 控制间距；right/bottom 留 8/12px，让它们贴着右下角但不压到内容。
    wrap.style.cssText = 'position:fixed;right:8px;bottom:12px;z-index:9000;'
      + 'display:flex;flex-direction:column;gap:8px;align-items:flex-end';
    const gear = makeBtn('paGear', ICON_GEAR, '设置');
    wrap.appendChild(gear);
    // 套餐按钮（2026-10-30 加）：三种方案写在这里，价格由 product.config.json 的 plans 提供，
    // 卖家改价格/改文案不用改代码。plans.enabled=false 就整个隐藏。
    const plans = lic.plans || null;
    const showPlans = !!(plans && plans.enabled !== false && Array.isArray(plans.items) && plans.items.length);
    let priceBtn = null;
    if (showPlans) {
      priceBtn = makeBtn('paPlans', ICON_PRICE, (plans.title || '套餐与价格'));
      wrap.appendChild(priceBtn);
    }
    // 支持按钮：卖家可以在 product.config.json 里用 support.enabled=false 整体关掉
    const showSupport = !(lic.support && lic.support.enabled === false);
    let heart = null;
    if (showSupport) {
      heart = makeBtn('paSupport', ICON_HEART, '支持 / 购买');
      wrap.appendChild(heart);
    }
    document.body.appendChild(wrap);
    // 用最新的许可证信息而不是页面加载时那一份：页面可能开着跨过试用到期，
    // 30 秒轮询会更新 window.__paLic，弹层每次都读最新的才不会显示过期状态。
    const latest = () => (window.__paLic || lic);
    gear.addEventListener('click', () => openSettings(latest()));
    if (priceBtn) priceBtn.addEventListener('click', () => openPlans(latest()));
    if (heart) heart.addEventListener('click', () => openSupport(latest()));
  }

  // 个性化锁定项点击"看看怎么解锁"时打开支持面板
  window.__paOpenSupport = (lic2) => openSupport(lic2 || window.__paLic || {});

  readLicence().then((lic) => {
    if (!lic) return;
    // 半免费（2026-10-29 起）：未授权不再整屏遮罩——基本功能全部可用。
    // 免费模式的限制：超清每天 1 小时（服务端出图强制）+ 个性化锁定（页面侧）。
    window.__paLic = lic;
    try { window.__paP13n.applyAll(!!lic.usable); } catch (e) { }
    bottomButtons(lic);
    if (!lic.usable) {
      let noted = false;
      try { noted = !!sessionStorage.getItem('paFreeNoted'); sessionStorage.setItem('paFreeNoted', '1'); } catch (e) { }
      if (!noted) setTimeout(() => setNote('当前为免费版：超清每天 1 小时 · 个性化锁定。点右下角齿轮看详情或粘贴许可证', 9000), 1500);
    } else if (!lic.licensed && lic.trial && lic.trial.active) {
      // 免费版（7 天全功能试用期内）：进页面提示一次剩余天数，别每刷一次都弹。
      let noted = false;
      try { noted = !!sessionStorage.getItem('paTrialNoted'); sessionStorage.setItem('paTrialNoted', '1'); } catch (e) { }
      if (!noted) {
        const ends = String(lic.trial.ends || '').slice(0, 10);
        setTimeout(() => setNote('免费版 · 全功能试用还剩 ' + Number(lic.trial.daysLeft || 0) + ' 天'
          + (ends ? '（' + ends + ' 到期）' : '') + ' · 点右下角齿轮看详情 / 粘贴许可证', 9000), 1500);
      }
    }
    // 低频轮询许可证状态：客户"放许可证文件/在另一台设备粘贴"后，本页不用刷新也能解锁
    setInterval(() => {
      readLicence().then((j) => {
        if (!j) return;
        const was = !!(window.__paLic && window.__paLic.usable);
        window.__paLic = j;
        if (!!j.usable !== was) {
          try { window.__paP13n.applyAll(!!j.usable); } catch (e) { }
          if (j.usable) setNote('许可证已生效：超清不限时长 · 个性化已解锁', 6000);
        }
      }).catch(() => { });
    }, 30000);
  }).catch(() => { /* 拿不到许可证信息时不打扰用户：画面照常能看，个性化保持默认 */ });
})();
</script>
</body></html>`;

export const PAGE = (key, manifestHref = '/manifest.json') => PAGE_HTML
  .replace(/__KEY__/g, encodeURIComponent(key))
  // 用函数式替换 + 全局：href 里带 & 和 sig，避免 $ 之类被 replace 当成替换模式；
  // 用 /g 是因为注释里也可能出现同一个占位符（踩过一次：只换第一处，href 反而没换）。
  .replace(/__MANIFEST_HREF__/g, () => manifestHref);
