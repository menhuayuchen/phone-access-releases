const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<!-- 访问密钥在页面 URL 的 ?k= 里：任何外链都不能把整条 URL 当 Referer 带出去。
     Chrome 默认 strict-origin-when-cross-origin 只发 origin，但老浏览器/WebView 不一定，
     这里显式声明，配合外链上的 rel="noreferrer" 双保险。 -->
<meta name="referrer" content="strict-origin-when-cross-origin">
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
#zoomPop { position:fixed; right:8px; z-index:40; display:none; width:min(330px,calc(100vw - 16px));
           background:#1b1d23; border:1px solid #3a3e4a; border-radius:12px; padding:10px;
           box-shadow:0 10px 30px rgba(0,0,0,.55); }
#zoomPop.on { display:block; }
#zoomPop .zpTitle { font-size:13px; font-weight:600; color:#e8eaee; margin:0 0 8px; }
#zoomPop .zpOpt { display:block; width:100%; text-align:left; margin-top:7px; background:#242730;
                  color:#c9ccd1; border:1px solid #343842; border-radius:9px; padding:8px 10px;
                  font-size:13px; line-height:1.4; cursor:pointer; }
#zoomPop .zpOpt.on { background:rgba(47,111,235,.22); color:#8fb6ff; border-color:#3f6fd0; }
#zoomPop .zpOpt small { display:block; color:#868c96; font-size:11px; margin-top:2px; }
#zoomPop .zpNote { color:#6b7078; font-size:11.5px; line-height:1.6; margin-top:8px; }
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
/* 全屏按钮：贴在左边缘垂直居中，平时半透明，按住/悬停变亮（不挡画面又能找到） */
#fsBtn { position:fixed; left:0; top:50%; transform:translateY(-50%); z-index:10001; width:24px; height:60px;
         border:1px solid rgba(255,255,255,.14); border-left:0; border-radius:0 12px 12px 0;
         background:rgba(24,24,28,.22); color:rgba(255,255,255,.85);
         font-size:14px; padding:0; cursor:pointer; opacity:.38; transition:opacity .2s, background .2s;
         backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); }
#fsBtn:hover, #fsBtn:active { opacity:.9; background:rgba(40,40,46,.55); }
body.fs #fsBtn { opacity:.30; background:rgba(10,10,12,.20); }
body.fs #fsBtn:hover, body.fs #fsBtn:active { opacity:.9; background:rgba(40,40,46,.55); }
body.fs header, body.fs #hint, body.fs #hud, body.fs #stat { display:none !important; }
body.fs #stage { position:fixed; left:0; top:0; width:100vw; height:100vh; z-index:9996; }
#img, #vid { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:none; background:#000; }
#img.show, #vid.show { display:block; }
#overlay { position:absolute; inset:0; z-index:5; touch-action:none; }
#viewReset { position:absolute; left:8px; top:50%; transform:translateY(-50%); z-index:8; display:none;
             background:rgba(18,20,25,.92); color:#e8eaee; border:1px solid #4a4f5c; border-radius:18px;
             padding:7px 10px; font-size:12px; line-height:1.2; cursor:pointer; touch-action:manipulation;
             box-shadow:0 3px 12px rgba(0,0,0,.45); }
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
/* 2026-11-07：真光标/外接鼠标模式下隐藏系统光标，只显示我们自己画的光标 */
body.mouse-real #overlay, body.mouse-real #vid, body.mouse-real #stage, body.mouse-real canvas { cursor: none !important; }
@media (max-width: 960px) {
  #hint { display: none !important; }
  #bar, .bar, header { font-size: 12px !important; }
  #hud { font-size: 11px !important; }
  #stage { border-radius: 0 !important; }
}
@media (max-width: 960px) {
  #hint { display: none !important; }
  #hud { font-size: 11px !important; }
  #bar, .bar, header { font-size: 12px !important; padding: 2px 6px !important; }
}
@media (max-width: 960px) {
  #bar, .bar, header { flex-wrap: wrap !important; padding: 2px 6px !important; }
  #bar button, #bar .btn, .bar button, header button { padding: 5px 8px !important; font-size: 12px !important; }
  #hud { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
#mobSheet button{padding:8px 12px;border-radius:9px;background:#2a2e35;color:#e6e8eb;border:0;font-size:13px;}@media (max-width: 960px) {
  /* 2026-11-05 修：原来是 flex-wrap:nowrap + overflow:visible，窄屏（手机竖屏）时
     顶栏按钮会一路挤出屏幕右侧、点不到（用户实测截图）。改成允许换行，
     同时把占位的 spacer 隐藏（#stat 已隐藏、#hud 已 fixed），避免多余空行。 */
  #bar, .bar, header { display: flex; align-items: center; flex-wrap: wrap !important; gap: 6px; padding: 4px 6px !important; overflow: visible !important; }
  #bar button, .bar button, header button { flex: 0 0 auto; white-space: nowrap; padding: 6px 10px !important; font-size: 13px !important; }
  #bar select, .bar select { flex: 1 1 auto; min-width: 0; }
  #spacer { display: none !important; }
  #stat { display: none !important; }
  #hint { display: none !important; }
  #hud { position: fixed; left: 8px; bottom: 8px; z-index: 9998; max-width: 92vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px !important; background: rgba(0,0,0,.55); padding: 3px 6px; border-radius: 6px; }
}
@media (max-width: 480px) {
  /* 更窄的竖屏手机：按钮和间距再收一点，保证两行内放得下 */
  #bar, .bar, header { gap: 4px !important; }
  #bar button, .bar button, header button { padding: 5px 8px !important; font-size: 12.5px !important; }
  #bar select, .bar select { font-size: 12.5px !important; padding: 4px 6px !important; }
}
/* 设置里的折叠窗：标题可点，内容收起；更紧凑的卡片外观 */
.setSec { margin-top:12px; background:#1a1c22; border:1px solid #292c35; border-radius:12px; overflow:hidden; }
.secHead { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 14px; cursor:pointer; user-select:none; -webkit-tap-highlight-color:transparent; }
.secHead:active { background:#20232b; }
.secTitle { color:#c9ccd1; font-size:12.5px; font-weight:700; letter-spacing:.04em; }
.secChev { color:#6b7078; font-size:12px; transition:transform .18s; flex-shrink:0; }
.setSec.closed .secChev { transform:rotate(-90deg); }
.setSec.closed .secBody { display:none; }
.secBody { padding:2px 14px 13px; border-top:1px solid #22242b; }
</style>
<style>
/* 选择显示来源：手机上原生 <select> 弹层会截断长列表，改成全屏底部面板 */
#srcSheet { position:fixed; inset:0; z-index:10002; background:rgba(0,0,0,.55); display:none; }
#srcSheet.show { display:flex; align-items:flex-end; }
#srcPanel { width:100%; max-height:84vh; background:#141519; border:1px solid #262932; border-bottom:0;
            border-radius:16px 16px 0 0; display:flex; flex-direction:column; box-shadow:0 -12px 30px rgba(0,0,0,.5); }
#srcPanel h3 { margin:0; padding:14px 16px 6px; font-size:15px; color:#e8eaee; font-weight:600; }
#srcList { overflow-y:auto; -webkit-overflow-scrolling:touch; padding:0 10px 8px; }
.srcHead { padding:12px 12px 4px; color:#7d838d; font-size:11.5px; font-weight:700; letter-spacing:.06em; }
.srcRow { display:flex; flex-direction:column; gap:2px; padding:11px 12px; margin:2px 0; border-radius:10px;
          color:#c9ccd1; font-size:13.5px; cursor:pointer; }
.srcRow:active { background:#22242b; }
.srcRow small { color:#6b7078; font-size:11.5px; }
.srcRow.cur { background:#1d2a3f; color:#cfe1ff; }
.srcRow.cur small { color:#8fa9c9; }
#srcSheet .srcBtns { display:flex; gap:10px; padding:10px 16px 16px; }
#srcSheet .srcBtns button { flex:1; border-radius:10px; padding:11px; font-size:13px; cursor:pointer; }
</style>
</head>
<body>
<header>
  <button id="mCrisp">清晰</button>
  <button id="mSmooth">流畅</button>
  <button id="srcBtn" title="选择显示来源">全部屏幕</button>
  <select id="src" style="display:none"><option value="m-1">全部屏幕</option></select>
  <button id="deskBtn" title="最小化所有窗口，露出桌面">桌面</button>
  <button id="snd">声音</button>
  <button id="ctl">控制</button>
  <button id="kbBtn">输入</button>
  <button id="zoomBtn" title="三指及以上手势的缩放方式">缩放</button>
  <button id="cmdBtn">命令</button>
  <span id="spacer"></span>
  <span id="stat">连接中…</span>
  <span id="hud"></span>
</header>
<button id="fsBtn" title="全屏（隐藏所有按钮和状态栏）">⛶</button>
<div id="srcSheet" role="dialog" aria-label="选择显示来源">
  <div id="srcPanel">
    <h3>选择显示来源</h3>
    <div id="srcList"></div>
    <div class="srcBtns">
      <button id="srcClose" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a">关闭</button>
      <button id="srcReload" style="background:#2f6feb;color:#fff;border:0">刷新列表</button>
    </div>
  </div>
</div>
<div id="zoomPop" role="dialog" aria-label="缩放方式">
  <div class="zpTitle">三指及以上缩放</div>
  <button class="zpOpt" data-m="system">系统缩放<small>Ctrl+滚轮，电脑里的软件自己放大</small></button>
  <button class="zpOpt" data-m="view">画面缩放<small>只放大手机画面，光标跟手心</small></button>
  <div class="zpNote">画面放大后，左侧会出现「恢复原大小」；回到原始大小自动消失。</div>
</div>
<!-- tabindex="-1"：画面区作为「焦点回收站」，点完特殊键按钮把焦点收回到这里，
     否则焦点留在按钮上，物理键盘按空格/回车会再次触发那个按钮 -->
<div id="stage" tabindex="-1">
  <img id="img" alt="">
  <video id="vid" playsinline autoplay muted></video>
  <!-- 首帧前的占位：避免"黑屏很久像卡死"，画面一到就把这层藏起来 -->
  <div id="loadOv" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#000;color:#9aa0aa;font-size:13px;z-index:5;pointer-events:none">
    <div style="width:34px;height:34px;border:3px solid #2a2d36;border-top-color:#8fb6ff;border-radius:50%;animation:paSpin .9s linear infinite"></div>
    <div style="letter-spacing:.08em">正在连接画面…</div>
  </div>
  <style>@keyframes paSpin{to{transform:rotate(360deg)}}</style>
  <div id="blk"></div>
  <div id="overlay"></div>
  <button id="viewReset" title="恢复画面原始大小">恢复原大小</button>
  <div class="cursorDot" id="dot"></div>
  <div id="mcur" style="position:fixed;left:0;top:0;width:16px;height:22px;pointer-events:none;z-index:9999;display:none;background:no-repeat url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2222%22 viewBox=%220 0 16 22%22><path d=%22M1 1 L1 17 L5 13 L8 21 L11 20 L8 12 L14 12 Z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221%22/></svg>');transform:translate(-1px,-1px)"></div>
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
<div id="hint"></div>
<script>
const KEY = "__KEY__";
  const SID = Math.random().toString(36).slice(2, 10);   // 本页会话 id：服务端按它统计丢帧，互不干扰
const stage = document.getElementById('stage');
let img = document.getElementById('img');
const vid = document.getElementById('vid');

// ---- 全屏模式：隐藏顶栏/提示/状态值，只留画面 + 左边缘的半透明按钮 ----
const fsBtn = document.getElementById('fsBtn');
function fsIsOn() { return document.body.classList.contains('fs'); }
function setFsOn(on) {
  document.body.classList.toggle('fs', !!on);
  if (fsBtn) fsBtn.textContent = on ? '⤢' : '⛶';
  try {
    if (on) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () { });
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () { });
    }
  } catch (e) { }
}
if (fsBtn) fsBtn.addEventListener('click', function () { setFsOn(!fsIsOn()); });
// 用户用系统手势退出全屏时，把 CSS 全屏一起收掉，别留下隐藏的顶栏
document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement && fsIsOn()) {
    document.body.classList.remove('fs');
    if (fsBtn) fsBtn.textContent = '⛶';
  }
});

// ---- 游戏模式：一键深链到 Moonlight（硬核玩家用 Sunshine+Moonlight）----
// ---- 游戏模式：深链到 Moonlight（入口在 设置 → 高性能模式，不占主界面）----
// Android 用 intent 打开 Moonlight 包；其它平台先试 moonlight://（没装就什么都不会发生）。
function moonDeepLink() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'intent://#Intent;package=com.limelight;end';
  return 'moonlight://';
}

// ---- 画面缩放（只放大手机上的显示，不动电脑）--------------------------------
// 系统缩放 = 三指及以上发 Ctrl+滚轮，由电脑里的软件自己缩放；
// 画面缩放 = 只对 #img/#vid 做 CSS transform，电脑端完全不知道。
// 两种模式用设置里的按钮切换，偏好存 localStorage（默认系统缩放，保持老手感）。
const viewReset = document.getElementById('viewReset');
const ZOOM_MODE_KEY = 'zoomMode';
let zoomMode = 'system';
try { if (localStorage.getItem(ZOOM_MODE_KEY) === 'view') zoomMode = 'view'; } catch (e) {}
const view = { scale: 1, tx: 0, ty: 0 };
let viewPan = null;
const activePtr = new Map();
let scrollAnchor = null;
let wheelAccP = 0;
function applyView() {
  const on = view.scale > 1.0001;
  const tf = on ? 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.scale + ')' : '';
  try {
    img.style.transformOrigin = '0 0';
    img.style.transform = tf;
    vid.style.transformOrigin = '0 0';
    vid.style.transform = tf;
    const cvEl = document.getElementById('wccv');
    if (cvEl) { cvEl.style.transformOrigin = '0 0'; cvEl.style.transform = tf; }
  } catch (e) {}
  if (viewReset) viewReset.style.display = 'none';   // 改用右侧 +/−/⟳ 按钮，左侧恢复按钮不再显示
}
function resetView() {
  view.scale = 1; view.tx = 0; view.ty = 0;
  applyView();
}
// 以 (cx,cy) 为不动点缩放画面（按钮用；手势路径另有实现）
function zoomViewAt(cx, cy, factor) {
  const r = stage.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  let s = Math.max(1, Math.min(5, view.scale * factor));
  if (s <= 1.0001) { view.scale = 1; view.tx = 0; view.ty = 0; }
  else {
    const k = s / view.scale;
    view.tx = px - (px - view.tx) * k;
    view.ty = py - (py - view.ty) * k;
    view.scale = s;
    view.tx = Math.min(0, Math.max(r.width * (1 - s), view.tx));
    view.ty = Math.min(0, Math.max(r.height * (1 - s), view.ty));
  }
  applyView();
}
function updateZoomCtl() {
  let el = document.getElementById('zoomCtl');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zoomCtl';
    el.style.cssText = 'position:fixed;right:8px;bottom:130px;z-index:9997;display:none;flex-direction:column;gap:2px;background:rgba(20,22,26,.35);border:1px solid rgba(255,255,255,.12);border-radius:26px;padding:4px;opacity:.55;transition:opacity .2s'; el.addEventListener('pointerdown', function(){ el.style.opacity = '1'; }); el.addEventListener('pointerleave', function(){ el.style.opacity = '.55'; });
    const items = [['＋', 1.25], ['－', 0.8], ['⟳', 0]];
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.textContent = it[0];
      b.style.cssText = 'width:38px;height:38px;border-radius:19px;background:transparent;color:#e6e8eb;border:0;font-size:18px;line-height:1';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (it[1] === 0) { resetView(); return; }
        const r = stage.getBoundingClientRect();
        zoomViewAt(r.left + r.width / 2, r.top + r.height / 2, it[1]);
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
  }
  el.style.display = (zoomMode === 'view') ? 'flex' : 'none';
}
// 2026-11-07：电脑浏览器没有"双指放大手机画面"的场景，只保留系统缩放
if ((function(){ try { return window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(pointer: coarse)').matches; } catch(e){ return false; } })()) { try { zoomMode = 'system'; localStorage.setItem(ZOOM_MODE_KEY, 'system'); } catch (e) { } }
function setZoomMode(m) {
  zoomMode = (m === 'view') ? 'view' : 'system';
  try { localStorage.setItem(ZOOM_MODE_KEY, zoomMode); } catch (e) {}
  if (zoomMode === 'system') { /* 画面缩放保留，用户可继续看大图；要复原点左侧按钮 */ }
  updateZoomCtl();
}
if (viewReset) viewReset.addEventListener('click', (e) => { e.stopPropagation(); resetView(); });

// ---- 顶部「缩放」折叠窗 -----------------------------------------------------
const zoomBtn = document.getElementById('zoomBtn');
updateZoomCtl();
const zoomPop = document.getElementById('zoomPop');
const headerEl = document.querySelector('header');
function paintZoomPop() {
  if (!zoomPop) return;
  try { const vb = zoomPop.querySelector('.zpOpt[data-m="view"]'); if (vb && IS_DESKTOP) vb.style.display = 'none'; } catch (e) { }
  [...zoomPop.querySelectorAll('.zpOpt')].forEach((b) => {
    b.classList.toggle('on', b.dataset.m === zoomMode);
  });
}
function setZoomPop(open) {
  if (!zoomPop || !zoomBtn) return;
  if (open && headerEl) {
    const r = headerEl.getBoundingClientRect();
    // 手机：按钮在底部抽屉里，弹层若贴着按钮会掉到屏幕外 → 固定显示在屏幕中上部
    const inSheet = !!(zoomBtn.closest && zoomBtn.closest('#mobSheet'));
    zoomPop.style.top = (inSheet ? Math.max(70, Math.round(window.innerHeight * 0.28)) : (r.bottom + 6)) + 'px';
  }
  zoomPop.classList.toggle('on', open);
  zoomBtn.classList.toggle('on', open);
  if (open) paintZoomPop();
}
if (zoomBtn) {
  zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setZoomPop(!zoomPop.classList.contains('on'));
  });
}
if (zoomPop) {
  zoomPop.addEventListener('click', (e) => e.stopPropagation());
  [...zoomPop.querySelectorAll('.zpOpt')].forEach((b) => {
    b.addEventListener('click', () => {
      setZoomMode(b.dataset.m);
      paintZoomPop();
      setZoomPop(false);
      setNote(zoomMode === 'view' ? '已切换：画面缩放（只放大手机画面）' : '已切换：系统缩放（Ctrl+滚轮）', 2200);
    });
  });
}
document.addEventListener('click', () => { if (zoomPop && zoomPop.classList.contains('on')) setZoomPop(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && zoomPop && zoomPop.classList.contains('on')) setZoomPop(false);
});
addEventListener('resize', () => setZoomPop(false));
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
const srcBtn = document.getElementById('srcBtn');
const srcSheet = document.getElementById('srcSheet');
const srcList = document.getElementById('srcList');
// 选择显示来源：把原生下拉（手机上会截断长列表）换成分组、可滚动的底部面板
function openSrcSheet() {
  try { loadSources(false); } catch (e) { }
  const rows = [];
  const add = (value, label, sub, cur) => {
    rows.push('<div class="srcRow' + (cur ? ' cur' : '') + '" data-v="' + value + '">'
      + '<span>' + escHtml(label) + (cur ? ' ✓' : '') + '</span>'
      + (sub ? '<small>' + escHtml(sub) + '</small>' : '')
      + '</div>');
  };
  const cur = state.window ? 'w' + state.window : 'm' + (state.monitor >= 0 ? state.monitor : -1);
  add('m-1', '全部屏幕', '主屏', cur === 'm-1');
  for (const m of (state.monitors || [])) {
    add('m' + m.i, '显示器 ' + (m.i + 1) + '（' + m.w + '×' + m.h + '）', m.i === 0 ? '主屏' : '副屏', cur === 'm' + m.i);
  }
  if ((state.windows || []).length) {
    rows.push('<div class="srcHead">窗口（' + state.windows.length + '）</div>');
    for (const w of state.windows) {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      let mon = '';
      for (const m of (state.monitors || [])) {
        if (cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) { mon = '显示器 ' + (m.i + 1); break; }
      }
      add('w' + w.hwnd, String(w.title == null ? '' : w.title), mon + ' · ' + w.w + '×' + w.h, cur === 'w' + w.hwnd);
    }
  } else {
    rows.push('<div class="srcHead">窗口（0）</div>');
    rows.push('<div class="srcRow" data-v="">没有可选的窗口（打开一个软件再刷新）</div>');
  }
  srcList.innerHTML = rows.join('');
  srcSheet.classList.add('show');
  srcList.querySelectorAll('.srcRow[data-v]').forEach((el) => {
    el.addEventListener('click', () => {
      const v = el.getAttribute('data-v');
      if (!v) return;
      if ([...srcSel.options].some((o) => o.value === v)) {
        srcSel.value = v;
        srcSel.dispatchEvent(new Event('change'));
      }
      srcSheet.classList.remove('show');
    });
  });
}
if (srcBtn) srcBtn.addEventListener('click', openSrcSheet);
if (srcSheet) {
  srcSheet.addEventListener('click', (e) => { if (e.target === srcSheet) srcSheet.classList.remove('show'); });
  const sc = document.getElementById('srcClose');
  if (sc) sc.addEventListener('click', () => srcSheet.classList.remove('show'));
  const sr = document.getElementById('srcReload');
  if (sr) sr.addEventListener('click', async () => {
    sr.textContent = '刷新中…';
    try { await loadSources(true); } catch (e) { }
    sr.textContent = '刷新列表';
    openSrcSheet();
  });
}
const btnSnd = document.getElementById('snd');
const btnCtl = document.getElementById('ctl');
const btnDesk = document.getElementById('deskBtn');
const btnKb = document.getElementById('kbBtn');
// 2026-11-07：电脑浏览器适配——有精确指针且没有触摸设备 = 桌面
const IS_DESKTOP = (function () {
  try {
    // 主指针是精确指针（鼠标/触控板）且不是触摸主指针 = 电脑浏览器。
    // 注意不能用 any-pointer: coarse —— 带触屏的电脑会同时命中，会被误判成手机。
    return window.matchMedia('(pointer: fine)').matches
      && !window.matchMedia('(pointer: coarse)').matches;
  } catch (e) { return false; }
})();
function hintText() {
  return IS_DESKTOP
    ? '鼠标：点=左键 · 拖动=拖拽 · 双击=双击 · 右键=右键 · 滚轮=滚动 · Ctrl+滚轮=缩放'
    : '点哪指哪：黄点跟着手指走 · 单击=左键 · 拖动=拖拽 · 双击=双击 · 长按=右键 · 双指滑=滚轮（光标固定） · 三指及以上捏合=缩放';
}
if (IS_DESKTOP && btnKb) btnKb.style.display = 'none';
try { const h = document.getElementById('hint'); if (h) h.textContent = hintText(); } catch (e) { }
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
// 视频类模式（WebRTC 流畅 / H.264 高清）：坐标换算都按 <video> 的实际像素算
const isVideoMode = () => (state.mode === 'raw' || state.mode === 'h264');
function videoSourceSize() {
  if (state.mode === 'h264') {
    // 2026-11-06 触屏偏移的真正根因：<video> 里只要有画面（不管走 track 还是 MSE/WebCodecs 喂流），
    // videoWidth/videoHeight 就是**最终解码尺寸**，一律优先用它。
    // 原来只在 h264.useTrack 为真时才用；MSE 路径下 useTrack=false、streamW 也没设，
    // 于是掉到 16:9 占位（16x9），而实际画面是 16:10（2560x1600 → 1920x1200）：
    // contentBox 按 16:9 算宽，比真实画面宽 11%，结果点哪都偏、越靠边越偏（中间几乎不偏）。
    if (vid.videoWidth && vid.videoHeight) return { w: vid.videoWidth, h: vid.videoHeight };
    if (h264.useTrack && vid.videoWidth) return { w: vid.videoWidth, h: vid.videoHeight };
    if (h264.streamW) return { w: h264.streamW, h: h264.streamH };
    const cv = h264.canvas || document.getElementById('wccv');
    return { w: (cv && cv.width) || 16, h: (cv && cv.height) || 9 };
  }
  if (state.mode === 'raw') return { w: vid.videoWidth || 16, h: vid.videoHeight || 9 };
  return { w: img.naturalWidth || 16, h: img.naturalHeight || 9 };
}
const h264 = { ws: null, ms: null, sb: null, queue: [], mime: null, okAt: 0, failTimer: null, appended: 0, supported: null, jumpTimer: null };
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
// （2026-11-06 清理：原来的 sourcesSig() 已无人调用，签名比较已在 loadSources 里内联。）

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
  const cur = state.window ? 'w' + state.window : 'm' + (state.monitor >= 0 ? state.monitor : -1);
  if ([...srcSel.options].some((o) => o.value === cur)) srcSel.value = cur;
  syncSrcBtn();
  applyRect();
}
function syncSrcBtn() {
  if (!srcBtn) return;
  const o = [...srcSel.options].find((x) => x.value === srcSel.value);
  let t = o ? o.textContent : '全部屏幕';
  t = String(t).replace(/^窗口：/, '');
  if (t.length > 12) t = t.slice(0, 11) + '…';
  srcBtn.textContent = t;
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
    try { if (win264On() && state.window) refreshWinRect(); } catch (e) { }
    try { if (state.mode === 'h264') sendCaptureArgs(false); } catch (e) { }
    // 选中的窗口已经关掉了 → 自动切回"全部屏幕"，别让画面停在不存在的东西上
    if (state.window && !state.windows.some((x) => x.hwnd === state.window)) {
      state.window = 0; state.monitor = -1; applyRect();
      postMode({ monitor: -1, window: 0 });
      setNote('来源窗口已关闭，已切回全部屏幕');
      if (state.mode === 'mjpeg') startMjpeg();
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
  // 单窗口采集（PrintWindow 客户区）：画面是「客户区」，输入换算必须用客户区屏幕矩形，
  // 用窗口矩形会整体偏一个标题栏+边框的高度（用户反馈的"单窗口坐标不准"）。
  if (win264On() && state.window && state.winRect && state.winRect.w > 0) return state.winRect;
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
// 单窗口采集时向服务端要「客户区屏幕矩形」，窗口移动/改大小时跟着更新
function refreshWinRect() {
  if (!win264On() || !state.window) { if (state.winRect) { state.winRect = null; applyRect(); } return; }
  fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => {
      const wr = j && j.winRect;
      if (!wr || !(wr.w > 0)) { if (state.winRect) { state.winRect = null; applyRect(); } return; }
      const a = state.winRect || {};
      if (a.x !== wr.x || a.y !== wr.y || a.w !== wr.w || a.h !== wr.h) {
        state.winRect = { x: wr.x, y: wr.y, w: wr.w, h: wr.h };
        applyRect();
      }
    })
    .catch(() => { });
}

// 非安全上下文（http）提示：画面/触控照常走 WebRTC264（2026-11-06 起 http 也能低延迟），
// 但有几样浏览器只给安全上下文：装成 App（Service Worker）、WebCodecs 备用高清通道、声音的 AudioWorklet。
// 所以只做一句轻提示，不吓人；想全功能还是用 https 地址（桌面「轻屏 → 离线模式」会自动给出）。
try {
  if (!window.isSecureContext) {
    setTimeout(function () {
      try { setNote('当前是 http 打开：画面/触控正常（走低延迟通道），但装不了 App、声音会用兼容模式。想要全部功能，用 https 地址。', 12000); } catch (e) { }
    }, 3500);
  }
} catch (e) { }

srcSel.addEventListener('change', async () => {
  const v = srcSel.value;
  if (v.startsWith('m')) { state.monitor = Number(v.slice(1)); state.window = 0; }
  else if (v.startsWith('w')) { state.window = Number(v.slice(1)); state.monitor = -1; }
  applyRect();
  try { syncSrcBtn(); } catch (e) { }
  await postMode({ monitor: state.monitor, window: state.window });
  try {
    if (win264On() && state.window) setTimeout(refreshWinRect, 900);
    else { state.winRect = null; applyRect(); }
  } catch (e) { }
  setNote('已切换来源');
  buzz(8);
  try { syncWin264(); } catch (e) { }
  if (state.mode === 'mjpeg') startMjpeg(); else if (state.mode === 'h264') { h264.graceUntil = Date.now() + 4000; try { sendCaptureArgs(true); } catch (e) { } setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 250); } else restartRtc();
});

async function postMode(patch) {
  Object.assign(state, patch);
  try {
    await fetch('/mode', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'mjpeg', monitor: state.monitor, window: state.window,
        width: isVideoMode() ? 1280 : 2560 }) });
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
// 默认就是 2560 满清晰，只有连续两次真的塞满才退到 1920（60 秒内不再升回，避免来回跳）
let streamW = 2560;   // 默认满清晰（Wi-Fi 直连实测 24.5fps 0 丢帧）
// 往返延迟：直接量 /health 的往返时间。局域网 2~5ms；Tailscale 中继（DERP）200~500ms。
// 这个数决定"要不要压码率/是否该改用流畅模式"，HUD 里也直接显示。
let rttMs = 0;
let rttHist = [];
let advisedSlow = false;
// 调试用：?rtt=300 可以假装链路延迟是 300ms，用来验证降码率/降档逻辑（正常访问不带即可）
const rttForce = Number(new URLSearchParams(location.search).get('rtt') || 0);

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

// ---- 高清模式（H.264 / WebCodecs，2026-11-04）------------------------------
// 服务端用 ffmpeg 把画面编成 H.264，这里优先走 B 方案（Pion WebRTC264），
// 不可用时回落到 WebCodecs 解码，再不行才回落到低频 /frame.jpg。
function h264Supported() {
  if (h264.supported !== null) return h264.supported;
  // 用 WebCodecs 能力判断（真实播放路径），不依赖 MSE 的 codec 列表
  h264.supported = !!(window.VideoDecoder && window.EncodedVideoChunk);
  return h264.supported;
}
function stopH264() {
  h264.gen = (h264.gen || 0) + 1;
  if (h264.failTimer) { clearTimeout(h264.failTimer); h264.failTimer = null; }
  if (h264.jumpTimer) { clearInterval(h264.jumpTimer); h264.jumpTimer = null; }
  if (h264.ws) {
    try { h264.ws.onclose = null; h264.ws.onerror = null; h264.ws.onmessage = null; h264.ws.close(); } catch (e) { }
    h264.ws = null;
  }
  h264.sb = null; h264.ms = null; h264.queue = []; h264.appended = 0; h264.okAt = 0; h264.configured = false;
  try { vid.removeAttribute('src'); } catch (e) { }
  try { vid.srcObject = null; } catch (e) { }
}
function startWtTransport() {
  const cfg = h264.wt;
  const u = Uint8Array.from(atob(cfg.hash), function (c) { return c.charCodeAt(0); });
  const wt = new WebTransport('https://' + location.hostname + ':' + cfg.port + '/video', { serverCertificateHashes: [{ algorithm: 'sha-256', value: u }] });
  h264.wtConn = wt;
  setStat('WT 连接中…');
  (async () => {
    await wt.ready;
    setStat('WT 已连接');
    const streams = wt.incomingUnidirectionalStreams.getReader();
    while (true) {
      const s = await streams.read();
      if (s.done) break;
      (async () => {
        const rd = s.value.getReader();
        let buf = new Uint8Array(0);
        while (true) {
          const r = await rd.read();
          if (r.done) break;
          const chunk = r.value;
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf, 0); merged.set(chunk, buf.length); buf = merged;
          while (buf.length >= 10) {
            const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
            if (buf.length < 10 + len) break;
            const type = buf[0], isKey = buf[5] === 1;
            const payload = buf.slice(10, 10 + len);
            buf = buf.slice(10 + len);
            if (type === 2) {
              try {
                const j = JSON.parse(new TextDecoder().decode(payload));
                const d = Uint8Array.from(atob(j.description), function (c) { return c.charCodeAt(0); });
                h264.decoder.configure({ codec: j.codec, description: d, optimizeForLatency: true });
                h264.streamW = j.width || 0; h264.streamH = j.height || 0; h264.configured = true;
                setStat('WT 解码器就绪 ' + (j.width || 0) + 'x' + (j.height || 0));
              } catch (e) { }
            } else if (type === 1) {
              if (!h264.wtKey) { if (!isKey) continue; h264.wtKey = true; }
              h264.wtFrames = (h264.wtFrames || 0) + 1;
              if (h264.wtFrames % 30 === 0) setStat('WT f=' + h264.wtFrames + ' e=' + (h264.wtErr || 0) + ' k=1');
              try { h264.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: h264.wtFrames * 16, data: payload })); } catch (err) { h264.wtErr = (h264.wtErr || 0) + 1; }
            }
          }
        }
      })().catch(function () { });
    }
  })().catch(function (e) { console.log('wt failed: ' + (e && e.message)); startMjpeg(); });
}
// ---- B 方案：Pion WebRTC H.264（?rtc264=1；?rtc264=relay 强制中继测试）-----
// 稳定性要点（2026-11-05）：
//  1. 每次连接都向侧车要一条新会话（新 PC + sid），刷新/切网/断线后能立刻重连；
//  2. ICE failed 或 12 秒没画面自动重试 2 次，还不行回落现有 WS 解码链路，不黑屏；
//  3. TURN 凭据由服务端下发（每次启动随机），手机在运营商 NAT 后面也能靠中继连上；
//  4. 回前台时如果连接已经死了，自动重连一次（手机锁屏再解锁的常见场景）。
let rtc264Gen = 0;
const RTC264 = { pc: null, sid: '', watchdog: null, statsTimer: null, attempts: 0, startedAt: 0, firstVideo: false, busy: false };
try { window.__rtc264 = RTC264; } catch (e) { }   // 诊断/端到端测试用

// ---- 码率自动（可选，默认关）------------------------------------------------
// 设计：设置里「自动」按钮，默认不开启；开启后按 WebRTC 丢包自动升降码率
// （6–20 Mbps），只在 WebRTC264 通道生效。手动码率永远优先——用户一选固定值就退出自动。
// 注意：这段必须在**最外层作用域**（rtc264Stats 里要用 autoqTag；放进设置面板的闭包里会
// 变成 ReferenceError 被 catch 吞掉，表现就是状态栏一直停在「WebRTC264 连接中」）。
const AUTOQ = { on: false, kbps: 12000, lastApply: 0, badStreak: 0, goodStreak: 0, lastLost: 0, lastRecv: 0 };
try { AUTOQ.on = localStorage.getItem('hqAuto') === '1'; AUTOQ.kbps = Number(localStorage.getItem('hqAutoKbps')) || 12000; } catch (e) { }
function autoqTag() { return AUTOQ.on ? (' · 自动' + Math.round(AUTOQ.kbps / 1000) + 'M') : ''; }
async function autoqApply(kbps) {
  AUTOQ.kbps = Math.max(6000, Math.min(20000, Math.round(Number(kbps) || 12000)));
  AUTOQ.lastApply = Date.now();
  try { localStorage.setItem('hqAutoKbps', String(AUTOQ.kbps)); } catch (e) { }
  try { await fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kbps: AUTOQ.kbps }) }); } catch (e) { }
}
function autoqTick() {
  if (!AUTOQ.on) return;
  const pc = RTC264.pc;
  if (!pc || state.mode !== 'h264' || document.hidden) return;
  pc.getStats().then(function (st) {
    let lost = 0, recv = 0, rtt = 0;
    st.forEach(function (r) {
      if (r.type === 'inbound-rtp' && r.kind === 'video') { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) rtt = r.currentRoundTripTime;
    });
    const dLost = lost - AUTOQ.lastLost, dRecv = recv - AUTOQ.lastRecv;
    AUTOQ.lastLost = lost; AUTOQ.lastRecv = recv;
    const total = dLost + dRecv;
    if (total < 30) return;
    const loss = dLost / total;
    if (loss > 0.03) { AUTOQ.badStreak++; AUTOQ.goodStreak = 0; }
    else if (loss < 0.005) { AUTOQ.goodStreak++; AUTOQ.badStreak = 0; }
    else { AUTOQ.goodStreak = 0; }
    const now = Date.now();
    if (now - AUTOQ.lastApply < 15000) return;      // 降/升之间至少隔 15 秒，避免编码器反复重启
    if (AUTOQ.badStreak >= 2 && AUTOQ.kbps > 6000) { autoqApply(AUTOQ.kbps * 0.65); AUTOQ.badStreak = 0; return; }
    if (AUTOQ.goodStreak >= 5 && rtt < 0.15 && AUTOQ.kbps < 20000) { autoqApply(AUTOQ.kbps * 1.25); AUTOQ.goodStreak = 0; }
  }).catch(function () { });
}
setInterval(function () { try { autoqTick(); } catch (e) { } }, 4000);
try { if (AUTOQ.on) setTimeout(function () { autoqApply(AUTOQ.kbps); }, 1500); } catch (e) { }

// ---- 单窗口采集（实验）--------------------------------------------------------
// 选中窗口时把句柄交给服务端，用 PrintWindow 只抓这个窗口（被挡住也能抓到），
// 帧率受 PrintWindow 限制约 10–30fps；不选窗口就回普通全屏采集。
// 采集参数：显示器序号 + 相对**该显示器**的裁剪矩形。
// ddagrab 一次只能抓一个输出，副屏必须切 output_idx，否则抓到的是主屏（用户实测的副屏 bug）。
function h264CaptureArgs() {
  const ms = state.monitors || [];
  function monOf(px, py) {
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (px >= m.x && px < m.x + m.w && py >= m.y && py < m.y + m.h) return m;
    }
    return null;
  }
  if (state.window) {
    const w = (state.windows || []).find(function (x) { return x.hwnd === state.window; });
    if (w) {
      const mo = monOf(w.x + w.w / 2, w.y + w.h / 2) || ms[0] || { i: 0, x: 0, y: 0 };
      return { mon: mo.i, rect: { x: Math.max(0, w.x - mo.x), y: Math.max(0, w.y - mo.y), w: w.w, h: w.h } };
    }
  }
  if (state.monitor >= 0) {
    const mo = ms.find(function (x) { return x.i === state.monitor; });
    if (mo) return { mon: mo.i, rect: { x: 0, y: 0, w: mo.w, h: mo.h } };
  }
  const mo0 = ms.find(function (x) { return x.i === 0; }) || null;
  if (mo0) return { mon: 0, rect: { x: 0, y: 0, w: mo0.w, h: mo0.h } };
  return { mon: 0, rect: null };
}
// 只有参数真的变了才下发（loadSources 每 2 秒轮询一次，无脑下发会让编码器反复重启）
let lastCapKey = '';
function sendCaptureArgs(force) {
  try {
    const ca = h264CaptureArgs();
    const key = ca.mon + '|' + (ca.rect ? (ca.rect.x + ',' + ca.rect.y + ',' + ca.rect.w + ',' + ca.rect.h) : 'null');
    if (!force && key === lastCapKey) return;
    lastCapKey = key;
    fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ca) }).catch(function () { });
  } catch (e) { }
}
function win264On() { try { return localStorage.getItem('win264') === '1'; } catch (e) { return false; } }
// 局域网自动 2560 的开关（必须在最外层：startH264 也要用；默认开）
function lan264On() { try { return localStorage.getItem('lan2560') !== '0'; } catch (e) { return true; } }
function syncWin264() {
  let hwnd = 0;
  try { hwnd = (win264On() && state.window) ? Number(state.window) : 0; } catch (e) { hwnd = 0; }
  try {
    return fetch('/h264-window', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hwnd: hwnd }) })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}
function rtc264Mode() {
  try { return new URLSearchParams(location.search).get('rtc264') === 'relay' ? 'relay' : 'all'; } catch (e) { return 'all'; }
}
function stopRtc264() {
  const R = RTC264;
  rtc264Gen++;
  if (R.statsTimer) { clearInterval(R.statsTimer); R.statsTimer = null; }
  if (R.watchdog) { clearTimeout(R.watchdog); R.watchdog = null; }
  const sid = R.sid;
  R.sid = ''; R.firstVideo = false; R.startedAt = 0; R.hudText = '';
  R.lastCt = 0; R.frozenSince = 0; R.lastFr = 0; R.lastBr = 0;
  R.rate = null; R.qFps = 0; R.qRxFps = 0; R.qMbps = 0; R.playStart = 0;
  if (R.discTimer) { clearTimeout(R.discTimer); R.discTimer = null; }
  if (R.retryTimer) { clearTimeout(R.retryTimer); R.retryTimer = null; }
  try { rtc264AudioStop(); } catch (e) { }
  R.media = null;
  if (R.pc) {
    try { R.pc.ontrack = null; R.pc.oniceconnectionstatechange = null; R.pc.close(); } catch (e) { }
    R.pc = null;
  }
  window.__pc264 = null;
  try { vid.srcObject = null; } catch (e) { }
  if (sid) {
    try {
      fetch('/rtc264/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: sid }) }).catch(function () { });
    } catch (e) { }
  }
}
async function startRtc264() {
  stopRtc264();
  const R = RTC264;
  const my = rtc264Gen;
  const mode = rtc264Mode();
  R.startedAt = Date.now();
  try {
    const resp = await fetch('/rtc264/offer', { method: 'POST', cache: 'no-store' });
    if (!resp.ok) throw new Error('offer ' + resp.status);
    const offer = await resp.json();
    if (my !== rtc264Gen) return;
    if (!offer || !offer.sdp || !offer.sid) throw new Error('bad offer');
    R.sid = offer.sid;
    const ice = [];
    // 局域网/电脑热点（离线模式）：手机和电脑在同一网段，直接用 host 候选互连；
    // tailnet 的 TURN 在这里连不通，加进来只会拖慢 ICE 收集。
    const onLanHost = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(location.hostname || '');
    if (onLanHost) {
      // 不加任何 iceServers（host 候选直连）
    } else if (offer.turnOk && offer.turnPort) {
      // 只用 tailnet IP 的 TURN（不用域名：省掉 MagicDNS 解析时间，避免收候选变慢）；
      // 也不用公网 STUN：PC 宣告的是 tailnet 地址，手机的 srflx 帮不上忙，
      // 反而会因为它连不通（国内）拖慢 ICE 收集——实测这一条就慢 2 秒多。
      ice.push({ urls: ['turn:' + (offer.turnHost || location.hostname) + ':' + offer.turnPort + '?transport=udp'], username: offer.turnUser || '', credential: offer.turnPass || '' });
    } else {
      ice.push({ urls: 'stun:stun.cloudflare.com:3478' });   // 没有 TURN 时留一条兜底
    }
    const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: mode === 'relay' ? 'relay' : 'all' });
    R.pc = pc;
    window.__pc264 = pc;
    R.media = new MediaStream();
    pc.ontrack = function (e) {
      try {
        try { if (e.receiver) { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 20; if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } } catch (err) { }
        try { R.media.addTrack(e.track); } catch (err) { }
        vid.srcObject = R.media;
        vid.classList.add('show');
        img.classList.remove('show');
        vid.muted = !state.audio;
        vid.play().catch(function () { });
        if (state.audio) {
          try { stopPcmAudio(); } catch (err) { }
          // 2026-11-07 A/B：?audio=pcm 时清晰模式的音频改走 PCM-WS（实测比纯音频 WebRTC 少约 160ms）
          if (rtc264AudioUsePcm()) { try { startPcmAudio(); } catch (err) { } }
          else rtc264AudioStart();
        }
      } catch (err) { }
    };
    pc.oniceconnectionstatechange = function () {
      setStat('WebRTC264 ' + pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') rtc264Retry('ice-failed');
      // 服务端重启/切网时 Chrome 要过 10–30 秒才把 disconnected 判成 failed，中间一直是冻结画面。
      // 这里 4 秒不回来就主动重连，别让用户对着暂停的画面干等。
      if (pc.iceConnectionState === 'disconnected') {
        if (R.discTimer) clearTimeout(R.discTimer);
        R.discTimer = setTimeout(function () {
          if (R.pc !== pc) return;
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
          rtc264Retry('ice-disconnected');
        }, 4000);
      } else if (R.discTimer) { clearTimeout(R.discTimer); R.discTimer = null; }
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await new Promise(function (r) {
      if (pc.iceGatheringState === 'complete') return r();
      pc.onicegatheringstatechange = function () { if (pc.iceGatheringState === 'complete') r(); };
      setTimeout(r, 2500);
    });
    if (my !== rtc264Gen) return;
    const ar = await (await fetch('/rtc264/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: R.sid, type: pc.localDescription.type, sdp: pc.localDescription.sdp })
    })).json();
    if (my !== rtc264Gen) return;
    if (!ar || !ar.ok) throw new Error('answer failed');
    try { console.log('rtc264: answer ok sid=' + R.sid); } catch (e) { }
    state.mode = 'h264';
    setStat('WebRTC264 连接中');
    R.statsTimer = setInterval(rtc264Stats, 1000);   // 1 秒一次：冻结/重启后能更快发现
    R.watchdog = setTimeout(function () { if (!R.firstVideo) rtc264Retry('no-video'); }, 12000);
  } catch (e) {
    if (my !== rtc264Gen) return;
    rtc264Retry('start-error:' + (e && e.message));
  }
}
async function rtc264Stats() {
  const R = RTC264, pc = R.pc;
  if (!pc) return;
  try {
    const st = await pc.getStats();
    const cands = {};
    let br = 0, fr = 0, fd = 0, path = '', jb = 0, jbc = 0;
    let bestPair = null, bestBytes = -1;
    st.forEach(function (r) { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
    st.forEach(function (r) {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        br = r.bytesReceived || 0; fr = r.framesReceived || 0; fd = r.framesDecoded || 0;
        jb = r.jitterBufferDelay || 0; jbc = r.jitterBufferEmittedCount || 0;
      }
      // 原来取「最后一条 succeeded 的 candidate-pair」，同时存在多条通路时会随机显示成中继/直连；
      // 现在优先取浏览器标记的 selected 通路，没标记就取实际流量最大的那条（2026-11-06 体检）。
      if (r.type === 'candidate-pair' && r.state === 'succeeded') {
        const bytes = (Number(r.bytesReceived) || 0) + (Number(r.bytesSent) || 0);
        const sel = r.selected === true;
        const bestSel = !!(bestPair && bestPair.selected === true);
        if (!bestPair) { bestPair = r; bestBytes = bytes; }
        else if (sel && !bestSel) { bestPair = r; bestBytes = bytes; }
        else if (sel === bestSel && bytes > bestBytes) { bestPair = r; bestBytes = bytes; }
      }
    });
    if (bestPair) { const c = cands[bestPair.localCandidateId]; if (c) path = c.candidateType; }
    const vw = vid.videoWidth || 0;
    if (vw > 0) {
      if (!R.firstVideo) R.playStart = Date.now();   // 出第一帧的时刻：头 2 秒的帧率不可信
      R.firstVideo = true; R.attempts = 0;
      if (R.watchdog) { clearTimeout(R.watchdog); R.watchdog = null; }
      // 首次出画面后给一次流量提醒（每台设备只提示一次）：清晰模式默认 20Mbps ≈ 8.9GB/时
      if (!R.flowHinted) {
        R.flowHinted = true;
        try {
          if (localStorage.getItem('hint.flow') !== '1') {
            localStorage.setItem('hint.flow', '1');
            setTimeout(function () {
              try { setNote('提示：清晰模式很费流量（约 8.9GB/小时）；用手机流量时建议调低画质，或点「流畅」', 9000); } catch (e) { }
            }, 6000);
          }
        } catch (e) { }
      }
    }
    // 冻结自愈：前台时 framesReceived 不再增长（服务端重启/链路假死）就主动重连。
    // 注意不能用 video.currentTime 判断——MediaStream 的 currentTime 是照播的，
    // 服务端死了它也照涨（上一版就踩了这个坑，画面冻结 20 秒都没重连）。
    const nowMs = Date.now();
    if (!document.hidden && vw > 0) {
      if (fr > (R.lastFr || 0) || br > (R.lastBr || 0)) { R.lastFr = fr; R.lastBr = br; R.frozenSince = 0; }
      else if (!R.frozenSince) { R.frozenSince = nowMs; }
      else if (nowMs - R.frozenSince > 2500) { R.frozenSince = 0; R.lastFr = fr; R.lastBr = br; try { console.log('rtc264: 画面冻结（帧不再增长），主动重连'); } catch (e) { } rtc264Retry('frozen'); return; }
    } else { R.lastFr = fr; R.lastBr = br; R.frozenSince = 0; }
    const how = path === 'relay' ? '中继' : (path === 'srflx' || path === 'prflx' ? '直连(NAT)' : (path === 'host' ? '直连' : pc.iceConnectionState));
    const bufMs = jbc > 0 ? Math.round((jb / jbc) * 1000) : 0;
    const res = vw ? vw + 'x' + vid.videoHeight : '连接中';
    // 帧率/码率：用相邻两次采样的差值算。HUD 以前显示的是「帧1776/解1775」这种累计计数，
    // 越看越大、根本不是帧率（用户反馈"帧率显示有问题"就是它）。
    const prevRate = R.rate;
    R.rate = { t: nowMs, fr: fr, fd: fd, br: br };
    if (prevRate && nowMs > prevRate.t) {
      const dtRate = (nowMs - prevRate.t) / 1000;
      const dFd = fd - prevRate.fd, dFr = fr - prevRate.fr, dBr = br - prevRate.br;
      if (dtRate > 0.2 && dFd >= 0 && dFr >= 0 && dBr >= 0) {
        R.qFps = dFd / dtRate;          // 解码出来真正显示的帧率
        R.qRxFps = dFr / dtRate;        // 网络收到的帧率（和上面差得多 = 在丢帧）
        R.qMbps = (dBr * 8) / dtRate / 1e6;
      }
    }
    // 刚连上的头 2 秒帧率会偏低（解码器预热/首个关键帧），这时先别报数，免得手机上闪过一个假的 5 fps
    const fpsTxt = (R.qFps > 0 && Date.now() - (R.playStart || 0) > 2500) ? R.qFps.toFixed(1) + ' fps' : '… fps';
    const mbpsTxt = R.qMbps > 0 ? R.qMbps.toFixed(1) + ' Mbps' : '';
    // 手机端 #stat 是隐藏的，HUD 才是用户看到的；HUD 只放「帧率 · 码率 · 缓冲」，
    // 累计帧数和累计流量放 #stat，给桌面排查用。
    RTC264.hudText = 'WebRTC264 ' + how + ' · ' + res + ' · ' + fpsTxt
      + (mbpsTxt ? ' · ' + mbpsTxt : '')
      + ' · 缓' + bufMs + 'ms' + autoqTag();
    setStat(RTC264.hudText + ' · 帧' + fr + '/解' + fd + ' · 收' + Math.round(br / 1024) + 'KB');
  } catch (e) { }
}
function serverUp264() {
  // 2 秒超时：服务端在重启时 TCP 直接拒绝（很快失败），卡死时也不会把这里拖住
  return new Promise(function (resolve) {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ctl = window.AbortController ? new AbortController() : null;
    if (ctl) setTimeout(function () { try { ctl.abort(); } catch (e) { } }, 2000);
    fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { finish(!!(j && j.enabled)); })
      .catch(function () { finish(false); });
  });
}
function rtc264AttachAudio(track) {
  try {
    const A = RTC264;
    if (!A.media) A.media = new MediaStream();
    if (A.audioTrack) { try { A.media.removeTrack(A.audioTrack); } catch (e) { } }
    A.audioTrack = track;
    A.media.addTrack(track);
    vid.srcObject = A.media;
    vid.muted = !state.audio;
    if (state.audio) vid.play().catch(function () { });
  } catch (e) { }
}
function rtc264AudioStop() {
  const A = RTC264;
  if (A.audioSig) { try { A.audioSig.onclose = null; A.audioSig.onmessage = null; A.audioSig.close(); } catch (e) { } A.audioSig = null; }
  if (A.audioPc) { try { A.audioPc.ontrack = null; A.audioPc.close(); } catch (e) { } A.audioPc = null; }
  if (A.audioTrack && A.media) { try { A.media.removeTrack(A.audioTrack); } catch (e) { } }
  A.audioTrack = null;
}
// 2026-11-07：清晰模式音频 A/B 开关。
// 默认仍走 /rtc?audio=1 的纯音频 WebRTC；带 ?audio=pcm 时改用页面已有的 PCM over WebSocket。
// 实测（本机回环，同一声源）：PCM 路径 +75~89ms，WebRTC 纯音频连接 +242~250ms —— 相差约 160ms。
// 所以 PCM 其实更"跟得上"画面；但 PCM 是 1.5Mbps 未压缩流，弱网要靠环形缓冲兜底，
// 因此先做成开关，等真机弱网验证后再决定是否改默认。
function rtc264AudioUsePcm() {
  try { return new URLSearchParams(location.search).get('audio') === 'pcm'; } catch (e) { return false; }
}
// 清晰模式的音频：走 /rtc?audio=1 的纯音频 WebRTC 连接（复用 rtc.mjs 的 Opus 编码），
// 比原来 PCM over WebSocket 少一层缓冲，音画更同步。失败就静默退回无声（视频不受影响）。
async function rtc264AudioStart() {
  const A = RTC264;
  if (rtc264AudioUsePcm()) return;   // A/B：强制 PCM 时不要建这条纯音频连接
  if (!A.pc || A.audioPc || !state.audio) return;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sig = new WebSocket(proto + '//' + location.host + '/rtc?k=' + encodeURIComponent(KEY) + '&audio=1&s=' + SID);
    const pc = new RTCPeerConnection({ iceServers: [] });
    A.audioSig = sig;
    A.audioPc = pc;
    // 2026-11-07 19:0x：音频接收端补上和视频一样的低延迟提示。
    // 清晰模式的音频是**另一条纯音频 PeerConnection**，视频那条设了 jitterBufferTarget=20 /
    // playoutDelayHint=0，这条以前没设。本机回环抖动≈0 看不出差别；弱网/4G 下不设的话，
    // 音频抖动缓冲会自动涨，表现就是"声音慢慢比画面慢半拍"。这两句只是给上限，网络好时无副作用。
    pc.ontrack = function (e) {
      try {
        if (e.receiver) {
          if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 20;
          if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
        }
      } catch (err) { }
      rtc264AttachAudio(e.track);
    };
    pc.onicecandidate = function (e) { try { if (e.candidate && sig.readyState === 1) sig.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); } catch (err) { } };
    pc.onconnectionstatechange = function () { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') rtc264AudioStop(); };
    sig.onopen = async function () {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
        await pc.setLocalDescription(offer);
        sig.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      } catch (e) { rtc264AudioStop(); }
    };
    sig.onmessage = async function (ev) {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        else if (m.type === 'ice') { try { await pc.addIceCandidate(m.candidate); } catch (e) { } }
      } catch (e) { }
    };
    sig.onclose = function () { if (A.audioPc === pc) { A.audioPc = null; A.audioSig = null; } };
  } catch (e) { rtc264AudioStop(); }
}
function applyRtc264Audio() {
  if (!RTC264.pc) return;
  vid.muted = !state.audio;
  if (state.audio) {
    if (rtc264AudioUsePcm()) {
      try { rtc264AudioStop(); } catch (e) { }
      try { startPcmAudio(); } catch (e) { }
    } else {
      rtc264AudioStart();
    }
    if (typeof vid.play === 'function') vid.play().catch(function () { });
  } else {
    rtc264AudioStop();
    if (rtc264AudioUsePcm()) { try { stopPcmAudio(); } catch (e) { } }
  }
}
function rtc264Retry(why) {
  const R = RTC264;
  if (R.busy) return;
  try { console.log('rtc264: retry(' + why + ') attempts=' + R.attempts); } catch (e) { }
  R.busy = true;
  stopRtc264();
  R.busy = false;
  clearTimeout(R.retryTimer);
  // 先分辨是"电脑端在重启"还是"链路不通"：
  // 服务端重启时（supervisor 6–20 秒回来）盲目重试/回落 WS 都只会白折腾，
  // 实测那样要 22 秒才恢复；改成先等它回来，回来立刻建会话。
  R.retryTimer = setTimeout(async function () {
    if (state.mode !== 'h264' || document.hidden) return;
    let up = false;
    for (let i = 0; i < 30; i++) {
      up = await serverUp264();
      if (up) { try { console.log('rtc264: 电脑端恢复（等了 ' + (i + 1) + 's）'); } catch (e) { } break; }
      if (i % 3 === 0) { try { console.log('rtc264: 等电脑端 ' + (i + 1) + 's'); } catch (e) { } }
      setStat('等待电脑端恢复… ' + (i + 1) + 's');
      setNote('电脑端在重启，画面马上回来…', 4000);
      await new Promise(function (r) { setTimeout(r, 1000); });
      if (R.pc) return;                     // 期间别的地方已经连上了
    }
    if (!up) { rtc264Fallback('server-unreachable'); return; }
    if (R.attempts >= 3) { rtc264Fallback(why); return; }
    R.attempts++;
    setStat('WebRTC264 重连中 ' + R.attempts + '/3');
    startRtc264();
  }, 900);
}
// B 方案默认开启：没写参数就走 WebRTC264；?rtc264=0 强制旧 WS 通道；?rtc264=1/relay 强制开启/中继测试。
// h264.rtcEnabled 由 /h264-status 下发（配置开启 + 侧车 exe 存在才算可用）。
function rtc264Wanted() {
  let p = null;
  try { p = new URLSearchParams(location.search).get('rtc264'); } catch (e) { }
  if (p === '0') return false;
  // 2026-11-06 修正：**http（非安全上下文）也走 WebRTC264**。
  // 之前的判断是「http 下 WebRTC 连不上，直接走 WS」—— 实测是错的：
  //   http 下 RTCPeerConnection 正常、ICE 能收齐、<video> 能播 MediaStream；
  //   真正被安全上下文卡住的是 WebCodecs（window.VideoDecoder 在 http 下是 undefined），
  //   所以 http 走 WS 那条路必失败，最后只能掉到 5fps 的低频画面 —— 这才是「http 很卡」的根因。
  if (p === '1' || p === 'relay') return !!window.RTCPeerConnection;
  return !!(h264.rtcEnabled && window.RTCPeerConnection);
}
function rtc264Fallback(why) {
  try { console.log('rtc264 fallback: ' + why); } catch (e) { }
  stopRtc264();
  try {
    const u = new URL(location.href);
    u.searchParams.set('rtc264', '0');      // 记住这次失败，别在重连循环里反复试 WebRTC
    history.replaceState(null, '', u.toString());
  } catch (e) { }
  setNote('WebRTC 没连上，已回到高清模式', 5000);
  startH264();
}
document.addEventListener('visibilitychange', function () {
  if (document.hidden) return;
  if (!rtc264Wanted()) return;              // 已回落成 WS 或明确关闭
  if (state.mode !== 'h264') return;
  const R = RTC264;
  if (R.pc && (R.pc.iceConnectionState === 'connected' || R.pc.iceConnectionState === 'completed')) return;
  R.attempts = 0;
  startRtc264();
});
async function startH264() {
  stopRtc264();                       // 从 WebRTC264 切回来时先收掉 RTC 会话，避免两路同时解码
  try { syncWin264(); } catch (e) { }  // 单窗口采集开关：切到清晰模式时把当前窗口/全屏重新告诉服务端
  try { sendCaptureArgs(true); } catch (e) { }   // 显示器序号 + 裁剪矩形（副屏必须切 output_idx）
  let st = null;
  try { st = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json(); } catch (e) { st = null; }
  h264.wt = (st && st.wt) || null;
  h264.rtcEnabled = !!(st && st.rtc && st.rtc.enabled);
  // 局域网（https，有 WebRTC）默认拉满 2560：带宽/延迟都够，文字更清晰；设置里可关。
  // 必须**等它生效**再建 WebRTC 会话，否则编码器先按 1920 起、视频尺寸就定死成 1920 了。
  try {
    const onLan = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(location.hostname || '');
    if (onLan && lan264On() && !win264On() && st && Number(st.width) < 2560) {
      try { await fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width: 2560 }) }); } catch (e) { }
      try { st = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json(); } catch (e) { }
    }
  } catch (e) { }
  if (!st || !st.enabled) { startMjpeg(); return; }
  // 2026-11-06：WebRTC264 的判断必须放在 WebCodecs 检查**前面**。
  // http 下没有 window.VideoDecoder（WebCodecs 是安全上下文专属），但 WebRTC 完全可用；
  // 原来先判 WebCodecs，导致 http 直接掉到 5fps 的低频画面。
  if (rtc264Wanted()) { startRtc264(); return; }
  if (!(window.VideoDecoder && window.EncodedVideoChunk)) { startMjpeg(); return; }   // 没有 WebCodecs 就回落 MJPEG
  stopH264();
  stopRtc();
  state.mode = 'h264';
  btnCrisp.classList.add('on');
  btnSmooth.classList.remove('on');
  setStat('高清模式（H.264/WebCodecs）');
  applyRect();
  img.classList.remove('show');
  vid.classList.remove('show');
  try { abortStream(); } catch (e) { }
  h264.useTrack = false;
  h264.track = null; h264.writer = null; h264.pendingFrame = null;
  if (window.MediaStreamTrackGenerator) {
    // 直接输出到 <video>（GPU 合成，比 canvas drawImage 省电、延迟更低）
    try {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      h264.track = gen;
      h264.writer = gen.writable.getWriter();
      vid.srcObject = new MediaStream([gen]);
      vid.classList.add('show');
      vid.muted = !state.audio;
      vid.play().catch(function () { });
      h264.useTrack = true;
      h264.dispN = 0; h264.dispFps = 0; h264.dispAt = Date.now();
      if (vid.requestVideoFrameCallback) {
        const tick = () => {
          if (myGen !== h264.gen || !h264.useTrack || state.mode !== 'h264') return;
          h264.dispN++;
          const now = Date.now();
          if (now - h264.dispAt >= 1000) { h264.dispFps = h264.dispN * 1000 / (now - h264.dispAt); h264.dispN = 0; h264.dispAt = now; }
          if (myGen === h264.gen && state.mode === 'h264' && h264.useTrack) vid.requestVideoFrameCallback(tick);
        };
        vid.requestVideoFrameCallback(tick);
      }
    } catch (e) { h264.useTrack = false; }
  }
  if (!h264.useTrack) {
    let cv = document.getElementById('wccv');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'wccv';
      cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;background:#000;display:none;';
      stage.appendChild(cv);
    }
    cv.style.display = 'block';
    h264.canvas = cv;
    h264.ctx = cv.getContext('2d', { alpha: false });
  }
  h264.gen = (h264.gen || 0) + 1;
  const myGen = h264.gen;
  h264.configured = false;
  h264.pendingFrames = [];
  h264.frames = 0;
  h264.fps = 0; h264.fpsAt = Date.now(); h264.fpsN = 0;
  h264.decoder = new VideoDecoder({
    output: function (frame) {
      if (h264.useTrack && h264.writer) {
        try {
          const p = h264.writer.write(frame);   // VideoFrame 所有权交给 track
          if (p && p.catch) p.catch(function () { try { frame.close(); } catch (e) { } });
          h264.frames++;
          h264.fpsN++;
          const now = Date.now();
          if (now - h264.fpsAt >= 1000) { h264.fps = h264.fpsN * 1000 / (now - h264.fpsAt); h264.fpsAt = now; h264.fpsN = 0; }
        } catch (e) { try { frame.close(); } catch (e2) { } }
        return;
      }
      // 只保留最新一帧，用 rAF 画：解码比屏幕快时丢掉中间帧，延迟不会越积越大
      if (h264.pendingFrame) { try { h264.pendingFrame.close(); } catch (e) { } }
      h264.pendingFrame = frame;
      if (h264.rafPending) return;
      h264.rafPending = true;
      requestAnimationFrame(function () {
        h264.rafPending = false;
        const f = h264.pendingFrame;
        h264.pendingFrame = null;
        if (!f) return;
        try {
          if (cv.width !== f.displayWidth || cv.height !== f.displayHeight) { cv.width = f.displayWidth; cv.height = f.displayHeight; }
          h264.ctx.drawImage(f, 0, 0, cv.width, cv.height);
          h264.frames++;
          h264.fpsN++;
          const now = Date.now();
          if (now - h264.fpsAt >= 1000) { h264.fps = h264.fpsN * 1000 / (now - h264.fpsAt); h264.fpsAt = now; h264.fpsN = 0; }
        } finally { try { f.close(); } catch (e) { } }
      });
    },
    error: function (e) {
      console.log('h264 decoder error', e && e.message);
      const wNow = Number(h264.streamW) || 0;
      if (wNow > 1920) {
        setNote('这台设备解不动 ' + wNow + ' 宽，已自动降到 1920');
        try { h264.decoder.close(); } catch (e2) { }
        fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width: 1920, fps: 60 }) })
          .catch(function () { })
          .then(function () { setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 300); });
        return;
      }
      // 偶发解码错误优先重连高清，连续失败才降级到低频画面
      const nowE = Date.now();
      if (Date.now() < (h264.graceUntil || 0)) { setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 300); return; }
      if (nowE - (h264.lastErrAt || 0) > 30000) h264.errCount = 0;
      h264.lastErrAt = nowE;
      h264.errCount = (h264.errCount || 0) + 1;
      if (h264.errCount <= 6) {
        setNote('高清解码异常，正在重连…', 2500);
        setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 400);
        return;
      }
      setNote('高清连续解码失败，已切到低频画面: ' + ((e && e.message) || ''), 8000);
      startMjpeg();
    }
  });
  const connectWs = () => {  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(proto + '//' + location.host + '/ws-h264?k=' + encodeURIComponent(KEY) + '&s=' + SID);
  h264.ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onmessage = function (ev) {
    try { if (ev && ev.data && typeof ev.data !== 'string') { window.__net = window.__net || { ws: 0, rtc: 0, mjpeg: 0 }; window.__net.ws += (ev.data.byteLength || 0) + 9; } } catch (e) { }
    if (typeof ev.data === 'string') {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { }
      if (m && m.type === 'h264-init') {
        let desc = null;
        try { desc = Uint8Array.from(atob(m.description), function (c) { return c.charCodeAt(0); }); } catch (e) { desc = null; }
        try {
          h264.decoder.configure({ codec: m.codec, description: desc, optimizeForLatency: true });
          h264.streamW = m.width || 0;
          h264.streamH = m.height || 0;
          h264.configured = true; h264.bootTries = 0; h264.errCount = 0; setNote('HD init ok', 4000);
        } catch (e) {
          console.log('h264 configure failed', e && e.message);
          const cw = Number(m.width) || 0;
          if (cw > 1920) {
            setNote('这台设备解不动 ' + cw + ' 宽，已自动降到 1920', 6000);
            try { h264.decoder.close(); } catch (e2) { }
            fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width: 1920, fps: 60 }) })
              .catch(function () { })
              .then(function () { setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 300); });
            return;
          }
          setNote('高清解码器初始化失败，已切到低频画面', 6000);
          startMjpeg();
        }
      }
      return;
    }
    const buf = new Uint8Array(ev.data);
    if (buf.length < 9) return;
    if (!h264.configured) return;
    const ts = new DataView(ev.data).getInt32(0);
    const key = buf[4] === 1;
    const len = new DataView(ev.data).getUint32(5);
    if (len <= 0 || buf.length < 9 + len) return;
    try {
      h264.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: buf.subarray(9, 9 + len) }));
    } catch (e) {
      h264.errs = (h264.errs || 0) + 1;
      console.log('h264 decode fail', e && e.message);
      if (h264.errs >= 8) { h264.errs = 0; try { h264.decoder.close(); } catch (e2) { } restartH264(); }
    }
  };
  sock.onclose = function () {
    setNote('HD 连接关闭', 5000);
    if (state.mode !== 'h264' || stopped) return;
    setTimeout(function () { if (state.mode === 'h264') restartH264(); }, 1500);
  };
  h264.failTimer = setTimeout(function () {
    if (state.mode === 'h264' && !h264.configured) {
      h264.bootTries = (h264.bootTries || 0) + 1;
      if (h264.bootTries <= 2) { restartH264(); return; }   // 先重试高清，别直接掉低频
      setNote('高清模式多次连不上，已切到低频画面', 6000);
      startMjpeg();
    }
  }, 5000);  };

  const useWt = new URLSearchParams(location.search).get('wt') === '1' && h264.wt && h264.wt.enabled && h264.wt.hash && window.WebTransport;
  if (useWt) { startWtTransport(); return; }
  connectWs();
}function restartH264() { if (h264Supported()) startH264(); else startMjpeg(); }
function startMjpeg() {
  stopRtc264();                       // 降级到低频画面时不要留着 WebRTC264 会话
  try { setNote('已切到低频画面(诊断)', 6000); } catch (e) { }
  try { setNote('已切到低频画面', 4000); } catch (e) { }
  // MJPEG 流已退役（2026-11-04）：浏览器不支持 WebCodecs 或高清失败时，
  // 改用低频画面轮询（/frame.jpg），保留"能看见、能点"的基本能力。
  stopH264();
  state.mode = 'mjpeg';
  btnCrisp.classList.add('on');
  btnSmooth.classList.remove('on');
  applyRect();
  vid.classList.remove('show');
  img.classList.add('show');
  state.lowBw = true;                 // 只有"浏览器不支持高清"的兜底会走到这里，不再是用户按钮
  startLowBw();
  setStat('低频画面（当前浏览器不支持高清）');
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


// ---- 流畅模式：按真实丢包自适应（比只按 RTT 更贴近实际）--------------------
let rtcLastLost = 0, rtcLastRecv = 0;
async function rtcLossAdapt() {
  if (!pc || state.mode !== 'raw') return;
  try {
    const st = await pc.getStats();
    let lost = 0, recv = 0, fpsNow = 0;
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        lost = r.packetsLost || 0;
        fpsNow = r.framesPerSecond || 0;
        recv = r.packetsReceived || 0;
      }
    });
    const dLost = lost - rtcLastLost, dRecv = recv - rtcLastRecv;
    rtcLastLost = lost; rtcLastRecv = recv;
    if (dRecv + dLost < 40) return;
    const rate = dLost / (dRecv + dLost);
    // 帧率长期过低（编码/解码积压）：主动重连一次，别让画面越拖越慢
    if (fpsNow < 5 && dRecv > 10) {
      h264.__lowFps = (h264.__lowFps || 0) + 1;
      if (h264.__lowFps >= 3) { h264.__lowFps = 0; if (rtcRetry < 3) { rtcRetry++; restartRtc(); } }
    } else h264.__lowFps = 0;
    if (rate > 0.05 && Date.now() - rtcQAt > 25000) {
      const next = { kbps: Math.max(600, Math.round(lastQ.kbps * 0.6)), fps: Math.max(10, Math.round(lastQ.fps * 0.8)) };
      try { await fetch('/rtc-quality?kbps=' + next.kbps + '&fps=' + next.fps, { method: 'POST' }); } catch (e) { }
      lastQ = next; rtcQAt = Date.now(); rtcRetry = 0;
      setNote('网络丢包 ' + (rate * 100).toFixed(0) + '%，已降到 ' + next.kbps + 'kbps / ' + next.fps + 'fps', 3500);
      restartRtc();
    }
  } catch (e) { }
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
    if (e.track.kind === 'video') {
      gotVideo = true;
      // 压低浏览器侧抖动缓冲：跨网时默认缓冲往往 100–200ms，这里尽量压到 50–80ms
      try {
        if (e.receiver) {
          if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 60;
          if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0.06;
        }
      } catch (err) { }
    }
    vid.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { if (rtcRetry < 3) { rtcRetry++; setTimeout(function () { if (state.mode === 'raw') restartRtc(); }, 1500); } }
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
      startMjpeg();
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
      if (state.audio && (state.mode === 'mjpeg' || state.mode === 'h264') && !stopped) {
        setTimeout(() => { if (state.audio && (state.mode === 'mjpeg' || state.mode === 'h264')) startPcmAudio(); }, 1500);
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
  applyRect();
  stopRtc();
  try { await fetch('/rtc-off', { method: 'POST' }); } catch (e) {}
  await postMode({});
  // 2026-11-06：同样交给 startH264 自己选通道（http 下 WebCodecs 不可用，但 WebRTC264 可用）
  stopLowBw();                          // 高清模式下不该再挂着 200ms 的低频轮询定时器
  startH264();
  setStat('高清模式（H.264）');
  if (state.lowBw && state.mode === 'mjpeg') startLowBw();
  if (state.audio) startPcmAudio();     // 声音统一走 PCM 通道（H.264 只传画面）
  buzz(8);
});

btnSmooth.addEventListener('click', async () => {
  stopRtc264();
  stopH264();
  state.mode = 'raw'; btnSmooth.classList.add('on'); btnCrisp.classList.remove('on');
  applyRect();
  stopPcmAudio();                       // 流畅模式用 WebRTC 的音频轨，PCM 通道关掉
  // 低频轮询只在清晰模式的兜底里用；切到流畅时必须停掉，否则会一直在后台拉 /frame.jpg
  stopLowBw();
  if (state.lowBw) state.lowBw = false;
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
  } else if (state.mode === 'h264' && RTC264.pc) {
    // 清晰模式（WebRTC264）：声音走 WebRTC 音频轨（比 PCM over WS 延迟低），
    // 关掉 PCM 通道避免两路声音叠在一起。
    stopPcmAudio();
    applyRtc264Audio();
    setStat(state.audio ? '声音已开（WebRTC）' : '声音已关');
  } else if (state.audio) {
    startPcmAudio();               // 旧 WS 通道：PCM over WebSocket
  } else {
    stopPcmAudio();
    setStat('声音已关');
  }
  buzz(8);
});

// 省流量按钮已删除（2026-11-05）：清晰模式现在走 H.264，帧轮询只是"浏览器不支持高清"的
// 兜底画面，对用户手动开关已没有意义；省流量改由 设置 → 高清串流（码率/分辨率/帧率）控制。

function setControl(on) {
  state.control = on;
  localStorage.setItem('ctl', on ? '1' : '0');
  btnCtl.classList.toggle('on', on);
  overlay.classList.toggle('off', !on);
  hint.textContent = on
    ? hintText()
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
const media = () => (state.mode === 'h264' && h264.canvas) ? h264.canvas : (isVideoMode() ? vid : img);

function contentBox() {
  // 用 stage 的矩形，而不是 el.getBoundingClientRect()：
  // 画面缩放时 el 带着 CSS transform，getBoundingClientRect() 会返回放大后的框，
  // 再把指针坐标反算回未缩放坐标就会二次缩放，点哪都偏。stage 不受 transform 影响。
  const r = stage.getBoundingClientRect();
  const _vs = videoSourceSize();
  const nw = _vs.w;
  const nh = _vs.h;
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
  // 画面被 transform 放大后，先反算回未缩放的 stage 坐标，再走原来的映射；
  // 否则放大后点哪都偏。
  if (view.scale !== 1) {
    const r = stage.getBoundingClientRect();
    cx = r.left + (cx - r.left - view.tx) / view.scale;
    cy = r.top + (cy - r.top - view.ty) / view.scale;
  }
  const box = contentBox();
  const src = state.rect;
  const _vs2 = videoSourceSize();
  const nw = _vs2.w;
  const nh = _vs2.h;
  let fx = (cx - box.left) / box.width, fy = (cy - box.top) / box.height;
  fx = Math.min(1, Math.max(0, fx)); fy = Math.min(1, Math.max(0, fy));
  if (!src) return { x: Math.round(fx * nw), y: Math.round(fy * nh) };
  return { x: Math.round(src.x + fx * src.w), y: Math.round(src.y + fy * src.h) };
}

// 屏幕物理坐标 -> 页面坐标（抓屏来源矩形 + object-fit contain 的黑边都要算进去）
function toPage(sx, sy) {
  const box = contentBox();
  const src = state.rect;
  const _vs2 = videoSourceSize();
  const nw = _vs2.w;
  const nh = _vs2.h;
  let fx, fy;
  if (src && src.w > 0 && src.h > 0) { fx = (sx - src.x) / src.w; fy = (sy - src.y) / src.h; }
  else { fx = sx / nw; fy = sy / nh; }
  let x = box.left + fx * box.width, y = box.top + fy * box.height;
  // 画面缩放后，远程光标/黄点落在放大后的显示位置
  if (view.scale !== 1) {
    const r = stage.getBoundingClientRect();
    x = r.left + view.tx + (x - r.left) * view.scale;
    y = r.top + view.ty + (y - r.top) * view.scale;
  }
  return { x: x, y: y };
}


let dotHideTimer = null;
function scheduleDotHide() {
  if (dotHideTimer) clearTimeout(dotHideTimer);
  dotHideTimer = setTimeout(function () {
    // 手指还按着（拖动中/长按）就不算"无操作"，推迟隐藏
    try {
      if ((typeof ptr !== 'undefined' && ptr && !ptr.up) || viewPan) { scheduleDotHide(); return; }
    } catch (e) { }
    try { dot.style.display = 'none'; } catch (e) { }
    const mc = document.getElementById('mcur');
    if (mc) mc.style.display = 'none';
  }, 5000);
}
function showDot(x, y) {
  const r = stage.getBoundingClientRect();
  dot.style.left = (x - r.left) + 'px';
  dot.style.top = (y - r.top) + 'px';
  dot.style.display = 'block';
  scheduleDotHide();
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
  // 点击/按下/抬起/滚轮立刻发：输入延迟优先，不再等批处理
  if (ev && (ev.t === 'click' || ev.t === 'down' || ev.t === 'up' || ev.t === 'wheel')) { flushQueue(); return; }
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    flushQueue();
  }, 8);
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
  // 2026-11-07：部分安卓外接键盘不发 event.code（空串），会全部落到 text 通道；
  // 这里补一个按 event.key 名字转换的兜底，保证 Enter/Tab/方向键等特殊键仍能进电脑。
  if (!code) return 0;
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
// 2026-11-07：外接键盘兜底——部分安卓键盘不发 event.code，只有 event.key
function vkFromKeyName(key) {
  if (!key) return 0;
  const map = {
    Enter: 0x0D, Tab: 0x09, Escape: 0x1B, Backspace: 0x08, Delete: 0x2E, Insert: 0x2D,
    ' ': 0x20, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    Shift: 0x10, Control: 0x11, Alt: 0x12, Meta: 0x5B,
    PrintScreen: 0x2C, ScrollLock: 0x91, Pause: 0x13, CapsLock: 0x14
  };
  if (map[key]) return map[key];
  const f = /^F([1-9]|1[0-2])$/.exec(key);
  if (f) return 0x6F + Number(f[1]);
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if ((c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39)) return c;
  }
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
  const vk = vkFromCode(e.code) || vkFromKeyName(e.key);
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
let ptr = null, longTimer = null, moved = false, dragBtn = -1, pinch = null, zoomG = null, viewG = null, zoomCtrl = false, lastTapAt = 0;
// 多指手势期间置 true：抬手时不能把"最后一个手指离开"当成单点（缩放后尤其明显）
let multiGesture = false;

// 2026-11-07：外接鼠标走"电脑鼠标逻辑"。触屏那套（点哪移哪+点击、长按右键、拖动阈值）不参与。
let mouseBtnDown = -1;
// 2026-11-07：设置里的"接鼠标自动切换"开关（事件委托，面板重建也不丢）
document.addEventListener('click', function (e) {
  var t = e.target;
  var box = (t && t.closest) ? t.closest('#expAutoBox') : null;
  if (!box) return;
  var on = true;
  try { on = localStorage.getItem('pa.exp.mouseAuto') !== '0'; } catch (err) { }
  try { localStorage.setItem('pa.exp.mouseAuto', on ? '0' : '1'); } catch (err) { }
  window.__paMouseSwitchedOnce = false;
  var now = !on;
  box.textContent = now ? '✓' : '';
  box.style.background = now ? 'rgba(140,229,140,.14)' : 'transparent';
  try { setNote(now ? '已开启：接鼠标自动切到电脑真实光标' : '已关闭：接鼠标不再自动切换', 2500); } catch (err) { }
}, true);
// 2026-11-07：有些设备的外接鼠标事件 pointerType 不是 'mouse'（空串或 'pen'），
// 只要不是 touch 且带 buttons 就按鼠标处理，避免退回触屏语义。
function isMousePtr(e) {
  if (!e) return false;
  try { window.__paLastPtr = e.pointerType || '(empty)'; } catch (err) { }
  const t = e.pointerType;
  if (t === 'mouse' || t === 'pen') return true;
  // 2026-11-07：原来这里还有一条「pointerType 为空且有 buttons 就当鼠标」——
  // 某些环境 pointerType 上报为空，于是每一次触摸都被判成鼠标，触发下面的
  // mouseModeOn() 把 pa.exp.mode 永久写成 real，用户的个性化黄点就再也看不到了。
  // 现在宁可当触摸：现代浏览器都会给 pointerType。
  return false;
}
function mouseAutoOn() {
  try { return localStorage.getItem('pa.exp.mouseAuto') !== '0'; } catch (e) { return true; }
}
function mouseModeOn() {
  if (!mouseAutoOn()) return;
  if (window.__paMouseSwitchedOnce) return;
  window.__paMouseSwitchedOnce = true;
  try { setNote('检测到鼠标：已切换到电脑真实光标（可在 设置 → 外观 → 光标显示 里关掉自动切换）', 3500); } catch (e) { }
  // 先无条件隐藏系统光标（这里失败也不能影响别的）
  try { document.body.classList.add('mouse-real'); } catch (e) { }
  if (window.__paExp) { window.__paExp.mode = 'real'; window.__paExp.real = true; }
  try { document.body.classList.add('expNoDot'); } catch (e) { }
  // 2026-11-07：**不写 localStorage**。自动切换只在本次会话生效，
  // 绝不覆盖用户手动选的模式 —— 之前这行把 pa.exp.mode 永久写成 real，
  // 用户的个性化黄点（形状/大小/颜色/自定义图片）就永远看不到了，重启也不恢复。
}
overlay.addEventListener('pointerdown', (e) => {
  // 外接鼠标：立即在鼠标位置按下（右键交给 contextmenu，避免触发两次）
  if (isMousePtr(e)) {
    // 2026-11-07：检测到外接鼠标 → 自动切「电脑真实光标」（可在设置里关掉）
    mouseModeOn();
    if (!state.control) return;
    if (e.button === 2) return;
    const qm0 = layoutPoint(e.clientX, e.clientY);
    const pm0 = toScreen(qm0.x, qm0.y);
    queue({ t: 'move', x: pm0.x, y: pm0.y });
    if (window.__paExp && window.__paExp.real) {
      try { document.body.classList.add('ext-mouse'); } catch (e) { }
      try { if (window.__paCurLocal) window.__paCurLocal(pm0.x, pm0.y); } catch (e) { }
    } else {
      try { document.body.classList.remove('ext-mouse', 'mouse-real'); } catch (e) { }
    }
    try { hideMouseCur(); } catch (e) { }
    focusStage();
    const mb = (e.button === 1) ? 2 : 0;
    mouseBtnDown = mb;
    queue({ t: 'down', b: mb });
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { }
    e.preventDefault();
    return;
  }
  // 主指针落下 = 新的一轮触摸序列：清掉上一轮可能残留的指针状态。
  // （三指手势常被浏览器用 pointercancel 收尾，pointerup 不一定全会来；不清理的话
  //  activePtr 里会一直留着旧 id，之后每次单指都被当成"多指"，画面就拖不动了。）
  if (e.isPrimary) {
    activePtr.clear();
    multiGesture = false;
  }
  activePtr.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // 多指（第二根及以后）落下：取消单指状态与画面平移，别让抬手被当成点击
  const multiPt = (activePtr.size > 1) || e.isPrimary === false;
  if (multiPt) {
    multiGesture = true;
    viewPan = null;
    if (state.control) cancelSinglePointer();
  }
  // 画面缩放放大后：单指拖动 = 平移画面（不再发送远程移动）
  if (zoomMode === 'view' && view.scale > 1.001 && e.pointerType !== 'mouse') {
    if (multiPt) return;   // 多指手势：不建平移，也不在抬手时算点击
    viewPan = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, t: Date.now(), moved: false };
    // 先不 setPointerCapture：否则第二根手指落下时双指手势容易被吞
    return;
  }
  if (!state.control) return;
  if (ptr && !ptr.up) return;
  const q = layoutPoint(e.clientX, e.clientY);
  try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
  ptr = { id: e.pointerId, x: q.x, y: q.y, t: Date.now(), up: false };
  moved = false; dragBtn = -1;
  const p = toScreen(q.x, q.y);
  queue({ t: 'move', x: p.x, y: p.y });
  // 2026-11-07：触屏也做本地预测 —— 触屏原来没有本地预测，光标要等电脑回传
  // （采样 + 推送 + 网络 + 平滑 ≈ 100-250ms）才动，这就是「不跟手」的根源。
  // move 已经发出去了，电脑光标最终会到这个点；1.5 秒后以电脑回传为准（纠偏）。
  if (window.__paExp && window.__paExp.real) {
    try { if (window.__paCurLocal) window.__paCurLocal(p.x, p.y); } catch (e) { }
  }
  hideMouseCur();
  showDot(q.x, q.y);
  longTimer = setTimeout(() => {
    longTimer = null;
    if (moved || !ptr) return;
    dragBtn = 1;
    queue({ t: 'down', b: 1 });
    buzz(35);
  }, 550);
});

function showMouseCur(x, y) {
  const mc = document.getElementById('mcur');
  if (!mc) return;
  mc.style.display = 'block';
  mc.style.left = x + 'px';
  mc.style.top = y + 'px';
  scheduleDotHide();
}
function hideMouseCur() {
  const mc = document.getElementById('mcur');
  if (mc) mc.style.display = 'none';
}
overlay.addEventListener('pointermove', (e) => {
  if (activePtr.has(e.pointerId)) activePtr.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // 2026-11-07 修：原来 >=2 把三指也算成双指滚动，于是滚轮和缩放同时触发（手势打架）。
  // 现在只认「正好两根」，三指及以上统一交给缩放手势。
  if (activePtr.size === 2) {
    let sy = 0, n = 0;
    activePtr.forEach(function (v) { sy += v.y; n++; });
    const avgY = sy / n;
    if (scrollAnchor === null) scrollAnchor = avgY;
    wheelAccP += (scrollAnchor - avgY);
    scrollAnchor = avgY;
    const st = Math.trunc(wheelAccP / 18);
    if (st) { wheelAccP -= st * 18; queue({ t: 'wheel', d: st }); }
    return;
  }
  scrollAnchor = null;
  // 画面缩放放大后：单指拖动平移本机画面
  if (viewPan && e.pointerId === viewPan.id) {
    const dx = e.clientX - viewPan.x, dy = e.clientY - viewPan.y;
    if (!viewPan.moved && (Math.abs(dx) > 14 || Math.abs(dy) > 14)) {   // 与单指容差一致
      viewPan.moved = true;
      try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
    }
    if (viewPan.moved) {
      const r = stage.getBoundingClientRect();
      view.tx = Math.min(0, Math.max(r.width * (1 - view.scale), viewPan.tx + dx));
      view.ty = Math.min(0, Math.max(r.height * (1 - view.scale), viewPan.ty + dy));
      applyView();
    }
    // 放大平移时黄点仍跟着手指走
    const qp = layoutPoint(e.clientX, e.clientY);
    showDot(qp.x, qp.y);
    return;
  }
  // 手机外接鼠标：不需要按下也能移动（悬停），画一个箭头光标，隐藏触屏黄点
  if (isMousePtr(e) && state.control) {   // 外接鼠标：直接控制电脑鼠标，并按开关自动切真光标
    mouseModeOn();
    const qm = layoutPoint(e.clientX, e.clientY);
    const pm = toScreen(qm.x, qm.y);
    // 不再 20ms 节流：鼠标要跟手（queue 内部已有 8ms 批量）
    lastMoveSent = Date.now();
    queue({ t: 'move', x: pm.x, y: pm.y });
    // 2026-11-07：光标显示互斥——真光标模式只画系统位图（并隐藏系统光标+旧自绘），
    // 否则只留系统光标（不画任何自绘箭头/黄点），避免出现两个光标。
    if (window.__paExp && window.__paExp.real) {
      try { document.body.classList.add('ext-mouse'); } catch (e) { }
      try { hideMouseCur(); } catch (e) { }
      try { if (window.__paCurLocal) window.__paCurLocal(pm.x, pm.y); } catch (e) { }
    } else {
      try { document.body.classList.remove('ext-mouse', 'mouse-real'); } catch (e) { }
      try { hideMouseCur(); } catch (e) { }
    }
    const dd = document.getElementById('dot');
    if (dd) dd.style.display = 'none';
    return;
  }
  if (!state.control || !ptr || ptr.up) return;
  const q = layoutPoint(e.clientX, e.clientY);
  const dx = q.x - ptr.x, dy = q.y - ptr.y;
  if (!moved && Math.hypot(dx, dy) > 14) {   // 2026-11-06：容差 8→14，正常手指抖动不再被误判成拖拽（否则点击根本不触发）
    moved = true;
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    if (dragBtn < 0) { dragBtn = 0; queue({ t: 'down', b: 0 }); }
  }
  const now = Date.now();
  // 2026-11-07：去掉 28ms 节流。queue 内部已有 8ms 批量，这里再节流一次等于
  // 凭空多 0~28ms 延迟（外接鼠标那条早去掉了，触屏这条漏了）。
  {
    lastMoveSent = now;
    const p = toScreen(q.x, q.y);
    queue({ t: 'move', x: p.x, y: p.y });
    // 触屏本地预测：手指拿到哪，光标立刻跟到哪，不等电脑回传
    if (window.__paExp && window.__paExp.real) {
      try { if (window.__paCurLocal) window.__paCurLocal(p.x, p.y); } catch (e) { }
    }
    hideMouseCur();
  showDot(q.x, q.y);
  }
});

overlay.addEventListener('pointerup', (e) => {
  if (isMousePtr(e)) {
    if (mouseBtnDown >= 0) { const mb = mouseBtnDown; mouseBtnDown = -1; queue({ t: 'up', b: mb }); }
    return;
  }
  activePtr.delete(e.pointerId); scrollAnchor = null;
  if (viewPan) {
    const vp = viewPan; viewPan = null;
    // 多指手势后的抬手不算点击（缩放态下抬手指被误当成单点的根因）
    if (multiGesture || activePtr.size > 0) return;
    if (!vp.moved) {
      const qi = layoutPoint(vp.x, vp.y);   // 2026-11-06：放大状态的点按也用「按下点」（原来用抬手点，手指一抖就偏）
      // 2026-11-07 修 bug：放大态下长按（右键）抬手时，这里原来无条件下发左键 click
      // —— 用户看到的是「右键菜单弹出又被左键点掉」。长按已经把 b=1 按下去了，
      // 这里必须补的是右键抬起，不能再补一次左键。
      if (dragBtn === 1) {
        queue({ t: 'up', b: 1 });
        ripple(qi.x, qi.y);
        dragBtn = -1;
        return;
      }
      const pi = toScreen(qi.x, qi.y);
      const nowI = Date.now();
      const dblI = nowI - lastTapAt < 320;
      lastTapAt = dblI ? 0 : nowI;
      queue({ t: 'move', x: pi.x, y: pi.y });
      queue({ t: 'click', b: 0, n: dblI ? 2 : 1 });
      ripple(qi.x, qi.y);
      buzz(12);
    }
    return;
  }
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
      // 2026-11-06 触屏不准的主要来源：原来用「抬手位置」当点击落点，手指按下到抬起抖 5-20px 是常态，
      // 于是点哪偏哪（越快点越明显）。点击应当落在**按下时**瞄准的位置，抬手位置只用来判断是不是拖拽。
      const pd = toScreen(ptr.x, ptr.y);
      queue({ t: 'move', x: pd.x, y: pd.y });
      queue({ t: 'click', b: 0, n: dbl ? 2 : 1 });
      ripple(ptr.x, ptr.y);
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

// 双指滑动 = 滚轮；三指及以上捏合 = 缩放（Ctrl+滚轮）
// 手感约定（用户 2026-11-02 明确要求）：
//   ① 双指只在落下时把光标放到两指正中，之后光标**固定不动**，直到双指全部抬起；
//      滚动始终在起始中点发生，不会因为手指移动而滚到别的页面。
//   ② 三指及以上：所有触点的质心 = 手心；先 move 到质心，再 Ctrl down + wheel。
function touchPoints(e) {
  const out = [];
  for (let i = 0; i < e.touches.length; i++) {
    const t = e.touches[i];
    out.push(layoutPoint(t.clientX, t.clientY));
  }
  return out;
}
function pointsCenter(pts) {
  let x = 0, y = 0;
  for (let i = 0; i < pts.length; i++) { x += pts[i].x; y += pts[i].y; }
  return { x: x / pts.length, y: y / pts.length };
}
function pointsSpread(pts, c) {
  let d = 0;
  for (let i = 0; i < pts.length; i++) d += Math.hypot(pts[i].x - c.x, pts[i].y - c.y);
  return d / pts.length;
}
// 双指/三指及以上开始时，把单指那套状态收干净：不能留下按着的左键或长按计时器
function cancelSinglePointer() {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  if (ptr && !ptr.up && dragBtn >= 0) queue({ t: 'up', b: dragBtn });
  ptr = null; dragBtn = -1; moved = true;
}
function releaseZoomCtrl() {
  if (!zoomCtrl) return;
  zoomCtrl = false;
  queueKey(0x11, 0);       // Ctrl up
  flushQueue();            // 失焦/抬手后立刻发，别等 25ms 定时器被后台节流
}

overlay.addEventListener('touchstart', (e) => {
  if (!state.control) return;
  if (e.touches.length >= 2) multiGesture = true;   // 双指/三指手势：抬手后不能算单点
  if (e.touches.length === 2) {
    const pts = touchPoints(e);
    const c = pointsCenter(pts);
    cancelSinglePointer();
    releaseZoomCtrl();
    zoomG = null;
    // 只在这里定位一次：之后手指怎么动，光标都不再跟
    pinch = { ax: c.x, ay: c.y, lastY: c.y, acc: 0 };
    const p = toScreen(c.x, c.y);
    queue({ t: 'move', x: p.x, y: p.y });
    showDot(c.x, c.y);
    return;
  }
  if (e.touches.length >= 3) {
    const pts = touchPoints(e);
    const c = pointsCenter(pts);
    const d = pointsSpread(pts, c);
    cancelSinglePointer();
    pinch = null;
    if (zoomMode === 'view') {
      // 画面缩放：改 #img/#vid 的 CSS transform；光标仍然跟到手心（不向电脑发 Ctrl/滚轮）
      releaseZoomCtrl();
      zoomG = null;
      viewG = { dist: d, lastMove: 0 };
      const p = toScreen(c.x, c.y);
      queue({ t: 'move', x: p.x, y: p.y });
      showDot(c.x, c.y);
      setNote('画面缩放：以手心为中心，张开放大 / 捏合缩小 · 左侧可恢复', 2600);
      return;
    }
    viewG = null;
    zoomG = { x: c.x, y: c.y, dist: d, acc: 0, lastMove: 0 };
    const p = toScreen(c.x, c.y);
    queue({ t: 'move', x: p.x, y: p.y });
    showDot(c.x, c.y);
    if (!zoomCtrl) {
      zoomCtrl = true;
      queueKey(0x11, 1);    // Ctrl down，随后的滚轮就是缩放
      flushQueue();
    }
    setNote('系统缩放：以手心为中心，张开放大 / 捏合缩小', 2500);
  }
}, { passive: true });

overlay.addEventListener('touchmove', (e) => {
  if (!state.control) return;

  // 画面缩放：transform 本机画面 + 光标跟到手心（不发 Ctrl/滚轮）
  if (viewG && e.touches.length >= 3) {
    const pts = touchPoints(e);
    const c = pointsCenter(pts);
    const d = pointsSpread(pts, c);
    const now = Date.now();
    // 光标时刻在手心：缩放前/手心移动时都先发 move
    if (now - viewG.lastMove > 30) {
      viewG.lastMove = now;
      const p = toScreen(c.x, c.y);
      queue({ t: 'move', x: p.x, y: p.y });
      showDot(c.x, c.y);
    }
    if (d > 1 && viewG.dist > 1) {
      const ratio = d / viewG.dist;
      viewG.dist = d;
      const r = stage.getBoundingClientRect();
      const p = { x: c.x - r.left, y: c.y - r.top };
      let s = Math.max(1, Math.min(5, view.scale * ratio));
      if (s <= 1.0001) {
        view.scale = 1; view.tx = 0; view.ty = 0;
      } else {
        const k = s / view.scale;
        // 以手心为不动点缩放：手心下的那一点始终留在手指下面
        view.tx = p.x - (p.x - view.tx) * k;
        view.ty = p.y - (p.y - view.ty) * k;
        view.scale = s;
        const w = r.width, h = r.height;
        view.tx = Math.min(0, Math.max(w * (1 - s), view.tx));
        view.ty = Math.min(0, Math.max(h * (1 - s), view.ty));
      }
      const p2 = toScreen(c.x, c.y);
      queue({ t: 'move', x: p2.x, y: p2.y });   // 缩放这一下也先钉在手心
      applyView();
    }
    return;
  }

  // 系统缩放：质心=手心；跟随质心移动并换算成 Ctrl+滚轮格数
  if (zoomG && e.touches.length >= 3) {
    const pts = touchPoints(e);
    const c = pointsCenter(pts);
    const d = pointsSpread(pts, c);
    const now = Date.now();
    if (now - zoomG.lastMove > 30) {
      zoomG.lastMove = now;
      const p = toScreen(c.x, c.y);
      queue({ t: 'move', x: p.x, y: p.y });
      showDot(c.x, c.y);
    }
    if (d > 1 && zoomG.dist > 1) zoomG.acc += Math.log(d / zoomG.dist);
    zoomG.dist = d;
    const STEP = 0.10;      // 每累积 10% 的张开/捏合，走一格滚轮
    if (Math.abs(zoomG.acc) >= STEP) {
      const steps = Math.trunc(zoomG.acc / STEP);
      zoomG.acc -= steps * STEP;
      const p = toScreen(c.x, c.y);
      queue({ t: 'move', x: p.x, y: p.y });   // 先移到手心，再滚
      queue({ t: 'wheel', d: steps });        // 张开=正=放大；捏合=负=缩小
    }
    return;
  }

  // 双指：光标固定在按下时的两指中点，只累计纵向位移发滚轮
  if (pinch && e.touches.length === 2) {
    const pts = touchPoints(e);
    const c = pointsCenter(pts);
    pinch.acc += (pinch.lastY - c.y);
    pinch.lastY = c.y;
    const steps = Math.trunc(pinch.acc / 18);
    if (steps) {
      pinch.acc -= steps * 18;
      queue({ t: 'wheel', d: steps });
    }
  }
}, { passive: true });

overlay.addEventListener('touchend', (e) => {
  if (e.touches.length < 3 && viewG) viewG = null;
  if (e.touches.length < 3 && zoomG) {
    zoomG = null;
    releaseZoomCtrl();
  }
  if (e.touches.length < 2) pinch = null;
  // 多指手势结束后把单指状态彻底复位：否则偶尔残留 ptr/dragBtn，下一次单指会"没反应"
  if (e.touches.length === 0) {
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    ptr = null; dragBtn = -1; moved = false;
    viewPan = null;
    activePtr.clear();
    // 所有手指都抬起后延迟复位：先让这一轮的 pointerup 处理完，再允许下一次单点
    setTimeout(() => { multiGesture = false; }, 0);
  }
}, { passive: true });

overlay.addEventListener('touchcancel', () => {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  pinch = null;
  zoomG = null;
  viewG = null;
  viewPan = null;
  ptr = null; dragBtn = -1; moved = false;
  activePtr.clear();              // 关键：别让残留指针把下一次单指拖拽当成多指
  multiGesture = false;
  releaseZoomCtrl();
}, { passive: true });
// 切后台/失焦/关页面时一定要把 Ctrl 补起来，否则电脑上会卡着 Ctrl
window.addEventListener('blur', releaseZoomCtrl);
addEventListener('pagehide', releaseZoomCtrl);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseZoomCtrl(); });

// 改动（滚轮修复）：原来只有"双指滑动"能滚，页面从未监听 wheel 事件 ——
// 所以接物理鼠标时滚动滚轮完全没反应（用户实测反馈）。这里补上。
// 单位与双指滑动一致：页面发 d = 格数，后端 input.cs 再乘 120（WHEEL_DELTA）。
let wheelAcc = 0;
overlay.addEventListener('wheel', (e) => {
  if (!state.control) return;
  e.preventDefault();
  // 电脑浏览器：Ctrl+滚轮 = 系统缩放（与 Windows 一致）
  if (IS_DESKTOP && e.ctrlKey) { try { queueKey(0x11, 1); queue({ t: 'wheel', d: (e.deltaY > 0 ? -1 : 1) }); queueKey(0x11, 0); flushQueue(); } catch (err) { } return; }   // 别让浏览器自己滚页面/触发下拉刷新
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
        if (++deadPolls >= 2) { deadPolls = 0; setStat('断流重连中…'); startMjpeg(); }
      } else deadPolls = 0;
    } else deadPolls = 0;
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
          + ' · 延迟 ' + rttMs + 'ms';
    } else if (state.mode === 'h264' && RTC264.pc) {
      // WebRTC264 通道：HUD 显示真实的 RTC 状态（直连/中继、帧数、接收缓冲），
      // 不要再显示 WebCodecs 那套（RTC 模式下 h264.dispFps 是旧的，会误导成 20fps）
      hud.textContent = RTC264.hudText || 'WebRTC264 连接中…';
    } else if (state.mode === 'h264') {
      hud.textContent = '' + ((h264.useTrack ? (vid.videoWidth ? vid.videoWidth + '×' + vid.videoHeight : '—') : (h264.canvas && h264.canvas.width ? h264.canvas.width + '×' + h264.canvas.height : '—')))
        + ' · ' + (h264.useTrack && h264.dispFps ? ('显示 ' + h264.dispFps.toFixed(1) + ' fps') : (h264.fps ? h264.fps.toFixed(1) + ' fps' : '解码中…'));
    } else if (state.lowBw) {
      // 兜底的低频画面：显示轮询参数，避免误读成视频帧率
      hud.textContent = '省流量模式 · ' + Math.round(1000 / LOWBW_MS) + ' 帧/秒 · ' + lowBwWidth() + ' 宽 q45';
    } else {
      // 普通 MJPEG：out=服务端真正推给观看者的帧率，in=抓屏产出，drop10=最近 10 秒跳过的帧
      const capMs = cap ? Number(cap[1]) : 0;
      const capFps = capMs > 0 ? (1000 / capMs).toFixed(1) : '?';
      const dN = drop ? Number(drop[1]) : 0;
      hud.textContent = (out ? out[1] : '?') + ' fps'
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
    if (++failPolls >= 3 && state.mode === 'mjpeg' && !stopped) { failPolls = 0; startMjpeg(); }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopped = true; }
  else {
    stopped = false;
    if (state.mode === 'mjpeg') startMjpeg();
    else if (state.mode === 'h264') restartH264();
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
  el.addEventListener('load', () => { imgOkAt = Date.now(); setStat(state.lowBw ? '低频画面（' + Math.round(1000 / LOWBW_MS) + ' 帧/秒 · ' + lowBwWidth() + ' 宽）' : '直播中'); });
  el.addEventListener('error', () => { if (!stopped) setTimeout(() => startMjpeg(), 1200); });
}
bindImg(img);

(async function init() {
  btnCrisp.classList.add('on');
  setControl(state.control);
  await postMode({});
  await loadSources(true);
  startSourcesPolling();
  // 默认优先低延迟通道；startH264 内部会依次判断：WebRTC264 → WebCodecs(WS) → 低频画面兜底。
  // 2026-11-06 修正：http 下没有 WebCodecs（安全上下文专属），原来这里先判 h264Supported()
  // 就直接掉到 5fps 的低频画面，永远没机会走 WebRTC264。
  if (new URLSearchParams(location.search).get('mjpeg') === '1') {
    startMjpeg();
  } else {
    startH264();
  }
  pollStats();
  statsTimer = setInterval(pollStats, 2000);   // 顺带每 6 秒做一次 WebRTC 丢包自适应
  setInterval(() => { if (state.mode === 'raw' && pc) rtcLossAdapt(); }, 6000);
  window.__page = { state, contentBox, toScreen, toPage, layoutPoint };   // 调试用
  // 设置里的折叠窗：点标题展开/收起，记住状态（localStorage）
  try {
    document.addEventListener('click', function (ev) {
      const h = ev.target && ev.target.closest ? ev.target.closest('.secHead') : null;
      if (!h) return;
      const sec = h.parentElement;
      if (!sec || !sec.classList.contains('setSec')) return;
      sec.classList.toggle('closed');
      try {
        const key = 'setSec.closed';
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        const t = sec.getAttribute('data-title') || '';
        const i = arr.indexOf(t);
        if (sec.classList.contains('closed')) { if (i < 0) arr.push(t); }
        else if (i >= 0) arr.splice(i, 1);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch (e2) { }
    }, false);
  } catch (e) { }
  setNote('');
  // 首帧占位：画面一到（videoWidth>0 且有画面）就隐藏；20 秒兜底隐藏，避免一直挡着
  (function () {
    const ov = document.getElementById('loadOv');
    if (!ov) return;
    const t = setInterval(function () {
      const v = document.getElementById('vid');
      if (v && v.videoWidth > 0) { clearInterval(t); ov.style.display = 'none'; }
    }, 120);
    setTimeout(function () { clearInterval(t); if (ov) ov.style.display = 'none'; }, 20000);
  })();
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
  // 2026-10-31：自定义取色器用的主题字段（顺序就是设置面板里的顺序）
  const THEME_FIELDS = [
    { k: 'bodyBg', name: '背景', def: '#0b0b0d' },
    { k: 'headerBg', name: '顶栏', def: '#15161a' },
    { k: 'btnBg', name: '按钮', def: '#24262b' },
    { k: 'btnColor', name: '文字', def: '#c9ccd1' },
    { k: 'accent', name: '强调', def: '#8CE68C' }
  ];
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
  // <input type="color"> 只吃 #rrggbb：#abc 要展开、8 位去掉 alpha；非法值回落默认
  function toColorInput(v, d) {
    if (!isHex(v)) return d;
    let s = String(v).trim().slice(1).toLowerCase();
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length === 8) s = s.slice(0, 6);
    return '#' + s;
  }
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
    isHex: isHex, themeByKey: themeByKey,
    THEME_FIELDS: THEME_FIELDS, toColorInput: toColorInput
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

  // 2026-11-06 免费化：这里原来渲染「联系方式 + 支付宝/微信收款码」。
  // 现在不再收款，也不再放联系方式（branding 里的收款码/联系.txt 都不随包发），
  // 只保留一句可选的说明文案（support.note），其它交给「关于」面板。
  function supportHtml(lic, compact) {
    const s = lic.support || {};
    const note = String(s.note || '').trim();
    if (!note) return '';
    return '<div style="color:#8b9098;font-size:12.5px;line-height:1.7">' + esc(note) + '</div>';
  }

  function machineCodeHtml(lic) {
    if (!lic.machineCode) return '';
    return '<div style="margin:16px 0 0">'
      + '<div style="color:#8b9098;font-size:12px;margin-bottom:4px">本机机器码（换电脑时用来找回自己的设置）</div>'
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
      || '我在用「轻屏」：手机就能看电脑屏幕，还能点、能打字，出门在外很方便。\n下载试用（免费版日常够用）：{link}';
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
  // 用"可折叠分区卡片"的排版：标题一行、点一下收起，展开状态会记住
  // 默认收起的"高级"分区：第一次打开面板时界面更干净（客户点开才看）
  const DEFAULT_CLOSED = [
    '这台电脑的机器码', '剪贴板（手机 ↔ 电脑）', '串流玩游戏（Moonlight）', '画质与流量',
    '外观（主题 / 光标）', '防窥屏', '出问题时导出诊断'
  ];
  function secClosedList() {
    try {
      const raw = localStorage.getItem('setSec.closed');
      if (raw === null) return null;                  // 从没手动收过：用默认收起列表
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : null;
    } catch (e) { return null; }
  }
  function setSection(title, inner) {
    const saved = secClosedList();
    const closed = (saved === null) ? (DEFAULT_CLOSED.indexOf(title) >= 0) : (saved.indexOf(title) >= 0);
    return '<div class="setSec' + (closed ? ' closed' : '') + '" data-title="' + escHtml(title) + '">'
      + '<div class="secHead"><span class="secTitle">' + escHtml(title) + '</span><span class="secChev">▾</span></div>'
      + '<div class="secBody">' + inner + '</div></div>';
  }
  function setKv(k, v) {
    return '<div style="display:flex;gap:12px;padding:4px 0">'
      + '<div style="color:#868c96;font-size:13px;min-width:74px;flex-shrink:0">' + escHtml(k) + '</div>'
      + '<div style="flex:1;font-size:13px;word-break:break-all">' + v + '</div></div>';
  }
  // 手动下载入口（2026-11-02）：国内网盘 / Gitee / GitHub。
  // 数据来自 /licence 的 download（服务端读 product.config.json 的 update.*），改网盘只改配置、不用改代码。
  function dlLinksHtml(o, withTitle) {
    if (!o) return '';
    const links = [];
    if (o.mirrorPage) {
      links.push('<a href="' + escHtml(o.mirrorPage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">国内网盘（蓝奏云）</a>'
        + (o.mirrorPageNote ? '<span style="color:#6b7078">（' + escHtml(o.mirrorPageNote) + '）</span>' : ''));
    }
    if (o.giteePage) links.push('<a href="' + escHtml(o.giteePage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">Gitee 发行版</a>');
    if (o.githubPage) links.push('<a href="' + escHtml(o.githubPage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">GitHub 发行版</a>');
    if (!links.length) return '';
    if (withTitle) {
      return '<div style="margin-top:9px;color:#868c96;font-size:11.5px;line-height:1.95">'
        + '<div style="color:#aeb3bb">下载不动？用备选：</div>' + links.join('<br>') + '</div>';
    }
    return '<div style="margin-top:8px;color:#868c96;font-size:11.5px;line-height:1.9">下载不动？用备选：' + links.join(' · ') + '</div>';
  }
  // 「安装备选」常驻卡片：不点检查更新、或 GitHub 连不上时，也能自己拿到安装包。
  function installAltHtml(lic) {
    const d = (lic && lic.download) || null;
    if (!d) return '';
    const links = [];
    if (d.mirrorPage) {
      links.push('<a href="' + escHtml(d.mirrorPage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">国内网盘（蓝奏云）</a>'
        + (d.mirrorPageNote ? '<span style="color:#6b7078">（' + escHtml(d.mirrorPageNote) + '）</span>' : ''));
    }
    if (d.giteePage) links.push('<a href="' + escHtml(d.giteePage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">Gitee 发行版</a>');
    if (d.githubPage) links.push('<a href="' + escHtml(d.githubPage) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">GitHub 发行版</a>');
    if (!links.length) return '';
    return '<div style="margin-top:12px;padding:10px 12px;border:1px solid #262932;border-radius:9px;background:#0f1014">'
      + '<div style="color:#aeb3bb;font-size:12.5px;margin-bottom:6px">安装备选（检查更新用不了时，手动下最新版）</div>'
      + '<div style="color:#c9ccd1;font-size:12.5px;line-height:1.95">' + links.join('<br>') + '</div>'
      + '<div style="color:#6b7078;font-size:11.5px;margin-top:7px;line-height:1.6">'
      + '下载 .exe 安装包（约 50 MB）后双击安装即可；配置和许可证都会保留。</div></div>';
  }
  // ---- 连接体检（2026-11-03，A1/A3）--------------------------------------------
  // 数据来自服务端 /tailscale-status：安装/启动/登录/在线 + 节点是直连还是中继 + 健康告警。
  function tsRowsHtml(s) {
    const rows = [];
    const ok = !!(s.running && s.online);
    rows.push('<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + setPill(ok, '已连接', s.installed ? '未连接' : '未安装')
      + '<span style="color:#868c96;font-size:12px">'
      + escHtml(s.installed ? ((s.version ? 'Tailscale ' + s.version : 'Tailscale') + (s.backendState ? ' · ' + s.backendState : '')) : '这台电脑还没装 Tailscale')
      + '</span></div>');
    if (s.installed) {
      const addr = (s.ips && s.ips[0]) ? s.ips[0] : '—';
      rows.push(setKv('本机地址', '<span style="color:#aeb3bb">' + escHtml(addr) + (s.dnsName ? ' · ' + escHtml(s.dnsName) : '') + '</span>'));
      rows.push(setKv('在线节点', '<span style="color:#aeb3bb">' + (s.onlinePeers || 0) + ' / ' + (s.peerTotal || 0) + '</span>'));
      rows.push('<div style="color:#6b7078;font-size:11px;line-height:1.7;margin-top:2px">Tailscale 免费账号大约只能加 5 台设备（电脑、手机各算一台）；新设备加不进来时，先删掉不用的旧设备或升级套餐。</div>');
      // 远程 HTTPS 入口（tailscale serve）：一键开启，省得客户自己去后台折腾
      if (s.httpsUrl) {
        // 已开启：给「复制 / 直接打开」两个动作，省得客户手动抄地址
        rows.push(setKv('远程 HTTPS', '<a href="' + escHtml(s.httpsUrl) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">' + escHtml(s.httpsUrl) + '</a>'));
        rows.push('<div style="display:flex;gap:8px;align-items:center;margin:6px 0 2px;flex-wrap:wrap">'
          + '<button id="tsHttpsCopy" data-url="' + escHtml(s.httpsUrl) + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">复制这个地址</button>'
          + '<a href="' + escHtml(s.httpsUrl) + '" target="_blank" rel="noreferrer" style="background:#2f6feb;color:#fff;border-radius:8px;padding:5px 11px;font-size:11.5px;text-decoration:none">用它打开</a>'
          + '<span id="tsHttpsMsg" style="font-size:11.5px;color:#868c96"></span></div>');
        rows.push('<div style="color:#6b7078;font-size:11px;line-height:1.6">这个地址是 https 的，证书由 Tailscale 自动签发（手机不用装任何证书）。加到手机主屏当 App 用最方便。</div>');
      } else {
        rows.push(setKv('远程 HTTPS', '<span style="color:#ffb454">未开启</span>'));
        rows.push('<div style="display:flex;gap:8px;align-items:center;margin:6px 0 2px;flex-wrap:wrap">'
          + '<button id="tsHttpsBtn" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">一键开启远程 HTTPS</button>'
          + '<a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" style="color:#8fb6ff;font-size:11.5px;text-decoration:none">去 Tailscale 后台启用 HTTPS →</a>'
          + '<span id="tsHttpsMsg" style="font-size:11.5px;color:#868c96"></span></div>');
        // 三步傻瓜化：① 后台一次性启用 ② 回来点按钮 ③ 用新地址打开
        rows.push('<div style="color:#6b7078;font-size:11px;line-height:1.75">'
          + '<b style="color:#aeb3bb">怎么开（一次性）</b>：① 打开上面那个后台链接 → 登录 → <b>DNS</b> → <b>HTTPS Certificates</b> → 点 <b>Enable HTTPS</b>；'
          + '② 回到这里点「一键开启远程 HTTPS」；③ 出现 https 地址后，用「用它打开」进一次，再「添加到主屏幕」。'
          + '</div>');
        if (s.httpsHint) rows.push('<div style="margin-top:4px;color:#ffb454;font-size:11px;line-height:1.6">' + escHtml(s.httpsHint) + '</div>');
      }
    }
    if (s.peers && s.peers.length) {
      rows.push('<div style="margin-top:10px;color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em">tailnet 里的设备</div>');
      s.peers.forEach((p) => {
        rows.push('<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #202228;font-size:12.5px">'
          + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (p.online ? '#c9ccd1' : '#6b7078') + '">'
          + escHtml(p.host) + (p.os ? ' <span style="color:#6b7078">(' + escHtml(p.os) + ')</span>' : '') + '</span>'
          + (p.online
            ? ('<span style="color:' + (p.direct ? '#8CE58C' : '#ffb454') + '">' + (p.direct ? '直连' : '中继') + '</span>'
              + (!p.direct && p.relay ? '<span style="color:#6b7078;font-size:11px">' + escHtml(p.relay) + '</span>' : ''))
            : '<span style="color:#6b7078">离线</span>')
          + '</div>');
      });
    }
    if (s.health && s.health.length) {
      rows.push('<div style="margin-top:8px;color:#ffb454;font-size:12px;line-height:1.65">'
        + s.health.map((h) => escHtml(String(h))).join('<br>') + '</div>');
    }
    if (s.hint) {
      rows.push('<div style="margin-top:9px;padding:9px 11px;background:#1a1c22;border:1px solid #2b3a2f;'
        + 'border-radius:9px;color:#aeb3bb;font-size:12px;line-height:1.7">' + escHtml(s.hint) + '</div>');
    }
    if (!s.installed) {
      rows.push('<button id="tsInstall" style="margin-top:10px;background:#2f6feb;color:#fff;border:0;border-radius:9px;'
        + 'padding:9px 15px;font-size:13px;cursor:pointer">安装 Tailscale</button>');
      if (s.error) rows.push('<div style="color:#6b7078;font-size:11px;margin-top:6px">' + escHtml(s.error) + '</div>');
    }
    return rows.join('');
  }
  function tsBind(box) {
    const bodyEl = box.querySelector('#tsBody');
    const msgEl = box.querySelector('#tsMsg');
    const btn = box.querySelector('#tsRefresh');
    if (!bodyEl) return;
    const setMsg = (t, c) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = c || '#868c96'; } };
    const load = async () => {
      bodyEl.innerHTML = '<span style="color:#868c96">正在检测…</span>';
      let s = null;
      try { s = await fetch('/tailscale-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { s = null; }
      if (!s) { bodyEl.innerHTML = '<span style="color:#ff6b6b">检测失败：读不到 Tailscale 状态。</span>'; return; }
      bodyEl.innerHTML = tsRowsHtml(s);
      const httpsCopy = bodyEl.querySelector('#tsHttpsCopy');
      if (httpsCopy) httpsCopy.addEventListener('click', () => {
        const u = httpsCopy.getAttribute('data-url') || '';
        if (copyText(u)) { httpsCopy.textContent = '已复制'; setTimeout(() => { httpsCopy.textContent = '复制这个地址'; }, 1500); }
        else { setMsg('复制不了，长按上面的地址手动复制', '#ffb454'); }
      });
      const httpsBtn = bodyEl.querySelector('#tsHttpsBtn');
      if (httpsBtn) httpsBtn.addEventListener('click', async () => {
        const hm = bodyEl.querySelector('#tsHttpsMsg');
        httpsBtn.disabled = true; httpsBtn.style.opacity = '.6';
        if (hm) { hm.textContent = '正在开启（可能要 10–40 秒）…'; hm.style.color = '#868c96'; }
        let r = null;
        try { r = await fetch('/tailscale-https', { method: 'POST' }).then((x) => x.json()); } catch (e) { r = null; }
        if (hm) {
          if (r && r.ok) { hm.textContent = '已开启：' + (r.url || ''); hm.style.color = '#8CE58C'; }
          else { hm.textContent = (r && r.note) || '开启失败（看上面的说明）'; hm.style.color = '#ffb454'; }
        }
        httpsBtn.disabled = false; httpsBtn.style.opacity = '1';
        setTimeout(load, 2000);
      });
      const ins = bodyEl.querySelector('#tsInstall');
      if (ins) ins.addEventListener('click', async () => {
        ins.disabled = true; ins.style.opacity = '.6'; ins.textContent = '正在打开安装程序…';
        let r = null;
        try {
          r = await fetch('/tailscale-install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((x) => x.json());
        } catch (e) { r = null; }
        setMsg((r && r.message) || '没能打开安装程序', (r && r.ok) ? '#8CE58C' : '#ff6b6b');
        ins.disabled = false; ins.style.opacity = '1'; ins.textContent = '安装 Tailscale';
        setTimeout(load, 1500);
      });
    };
    if (btn) btn.addEventListener('click', () => { setMsg(''); load(); });
    load();
  }
  // ---- 小文件传输（2026-11-03，A5 第二步）--------------------------------------
  // 上传：XHR 原始字节流 POST /file?name=…（带进度）；列表/下载：GET /files、GET /file?name=…
  function h264QualityBind(box) {
    const wSel = box.querySelector('#hqW');
    const fpsSel = box.querySelector('#hqFps');
    const kSel = box.querySelector('#hqKbps');
    const qfCb = box.querySelector('#hqQf');
    const winCb = box.querySelector('#hqWin');
    const autoBtn = box.querySelector('#hqAuto');
    const msg = box.querySelector('#hqMsg');
    if (!wSel || !fpsSel || !kSel) return;
    const setMsg = (s, c) => { if (msg) { msg.textContent = s; msg.style.color = c || '#868c96'; } };
    const paintAuto = () => {
      if (autoBtn) {
        autoBtn.style.background = AUTOQ.on ? '#2f6f3f' : '#2a2d36';
        autoBtn.style.color = AUTOQ.on ? '#e8ffe9' : '#c9ccd1';
        autoBtn.textContent = AUTOQ.on ? '自动·开' : '自动';
      }
      if (kSel) kSel.disabled = AUTOQ.on;
    };
    paintAuto();
    if (autoBtn) autoBtn.addEventListener('click', async () => {
      if (AUTOQ.on) {
        AUTOQ.on = false;
        try { localStorage.setItem('hqAuto', '0'); } catch (e) { }
        paintAuto();
        const k = Number(kSel.value) || 20000;
        try {
          await fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kbps: k }) });
          setMsg('自动已关闭，恢复手动 ' + Math.round(k / 1000) + ' Mbps');
        } catch (e) { setMsg('自动已关闭'); }
        return;
      }
      AUTOQ.on = true;
      try { localStorage.setItem('hqAuto', '1'); } catch (e) { }
      paintAuto();
      await autoqApply(AUTOQ.kbps || 12000);
      setMsg('自动已开启：现在 ' + Math.round(AUTOQ.kbps / 1000) + ' Mbps，丢包自动降、稳定再升（6–20 Mbps）', '#8CE58C');
    });
    (async () => {
      try {
        const j = await (await fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json();
        if (!j || !j.ok) return;
        wSel.value = String(j.width);
        fpsSel.value = String(j.fps);
        kSel.value = String(j.kbps);
        if (qfCb) qfCb.checked = !!j.qf;
        if (!j.width || !j.height) setMsg('高清通道未启用');
        updateFlow();
      } catch (e) { }
    })();
    // 画质优先：p4+hq、VBR+CQ；切换后重启一次编码器生效（页面会重连，约 1 秒）
    if (qfCb) qfCb.addEventListener('change', async () => {
      setMsg('正在应用画质优先设置…');
      try {
        await fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qf: !!qfCb.checked }) });
        setMsg(qfCb.checked ? '画质优先已开：文字更锐，延迟约 +1 帧，流量会波动' : '已切回低延迟模式', '#8CE58C');
        if (state.mode === 'h264') restartH264();
      } catch (e) { setMsg('应用失败', '#ff6b6b'); }
    });
    // 单窗口采集（实验）
    if (winCb) {
      try { winCb.checked = win264On(); } catch (e) { }
      winCb.addEventListener('change', async () => {
        try { localStorage.setItem('win264', winCb.checked ? '1' : '0'); } catch (e) { }
        state.winRect = null;
        applyRect();
        await syncWin264();
        if (winCb.checked) {
          setMsg(state.window ? '单窗口采集已开：当前选中窗口生效（约 10–30fps）' : '单窗口采集已开：先在上方选一个「窗口」才会生效', '#8CE58C');
          setTimeout(refreshWinRect, 900);
        } else setMsg('已切回普通全屏采集', '#8CE58C');
        if (state.mode === 'h264') restartH264();
      });
    }
    const updateFlow = () => {
      const el = box.querySelector('#hqFlow');
      const k = AUTOQ.on ? AUTOQ.kbps : (Number(kSel.value) || 0);
      if (el && k) el.textContent = (AUTOQ.on ? '自动当前约 ' : '当前码率约 ') + (k / 1000).toFixed(0) + ' Mbps，满速约 ' + ((k * 3600) / 8 / 1024 / 1024).toFixed(1) + ' GB/小时（按编码码率估算，实际以流量为准）';
    };
    const apply = async () => {
      setMsg('正在应用…');
      try {
        const j = await (await fetch('/h264-quality', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ width: Number(wSel.value), fps: Number(fpsSel.value), kbps: Number(kSel.value) })
        })).json();
        if (j && j.ok) {
          try { fpsSel.value = String(j.fps); wSel.value = String(j.width); kSel.value = String(j.kbps); } catch (e) { }
          updateFlow();
          setMsg('已生效：' + j.width + '×' + j.height + ' · ' + j.fps + 'fps · ' + Math.round(j.kbps / 1000) + 'Mbps', '#8CE58C');
          updateFlow();
          if (state.mode === 'h264') restartH264();
        } else setMsg('应用失败', '#ff6b6b');
      } catch (e) { setMsg('应用失败：网络断了', '#ff6b6b'); }
    };
    wSel.addEventListener('change', apply);
    fpsSel.addEventListener('change', apply);
    kSel.addEventListener('change', apply);
  }
  function fileBind(box) {
    const pick = box.querySelector('#filePick');
    const sendBtn = box.querySelector('#fileSend');
    const msg = box.querySelector('#fileMsg');
    const listEl = box.querySelector('#fileList');
    const pcList = box.querySelector('#pcList');
    const wrap = box.querySelector('#fileProgWrap');
    const bar = box.querySelector('#fileBar');
    const prog = box.querySelector('#fileProg');
    const cancelBtn = box.querySelector('#fileCancel');
    const resumeEl = box.querySelector('#fileResume');
    if (!pick || !sendBtn) return;
    const BIG = 8 * 1024 * 1024;      // 超过 8MB 走分片并行
    const PARALLEL = 4;               // 4 路并发（吃满 Wi-Fi）
    const fmt = (n) => {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024 * 1024) return (v / 1073741824).toFixed(2) + ' GB';
      if (v >= 1024 * 1024) return (v / 1048576).toFixed(2) + ' MB';
      return (v / 1024).toFixed(0) + ' KB';
    };
    const fmtSpeed = (bps) => {
      if (!bps || !isFinite(bps)) return '';
      if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
      return (bps / 1024).toFixed(0) + ' KB/s';
    };
    const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || '#868c96'; } };
    // 取消支持（2026-11-06）：所有在飞的 XHR 都登记在这里，点「取消」一次性 abort。
    const liveXhr = new Set();
    let cancelReq = false;
    const killXhr = () => { for (const x of liveXhr) { try { x.abort(); } catch (e) { } } liveXhr.clear(); };
    // 断点续传提示：服务端暂存里的未完成会话（3 天内有效）
    let pending = [];
    const paintPending = async () => {
      if (!resumeEl) return;
      let j = null;
      try { j = await fetch('/upload/pending?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { j = null; }
      pending = (j && j.ok && j.items) ? j.items : [];
      if (!pending.length) { resumeEl.innerHTML = ''; return; }
      const ago = (ms) => {
        const m = Math.round((Number(ms) || 0) / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        const h = Math.round(m / 60);
        if (h < 24) return h + ' 小时前';
        return Math.round(h / 24) + ' 天前';
      };
      resumeEl.innerHTML = '<div style="margin-top:9px;background:#151a22;border:1px solid #263143;border-radius:9px;padding:9px 10px">'
        + '<div style="color:#8fb6ff;font-size:12px;font-weight:600;margin-bottom:5px">发现没传完的文件（可续传）</div>'
        + pending.map((it) => '<div style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:11.5px;color:#aeb3bb">'
          + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(it.name)
          + ' <span style="color:#6b7078">' + fmt(it.size) + ' · 已传 ' + it.pct + '%（' + it.doneCount + '/' + it.parts + ' 片）· ' + ago(it.ageMs) + '</span></span>'
          + '<button class="upDrop" data-id="' + it.id + '" data-key="' + escHtml('upq:' + it.name + ':' + it.size) + '"'
          + ' style="background:#2a2d36;color:#ffb4b4;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer">丢弃</button></div>').join('')
        + '<div style="color:#5c6169;font-size:11px;margin-top:5px;line-height:1.6">在下面重新选中同名文件就会从这个进度继续（浏览器不允许直接读旧文件，必须重新选一次）。</div>'
        + '</div>';
      resumeEl.querySelectorAll('.upDrop').forEach((el) => el.addEventListener('click', async () => {
        if (el.disabled) return;
        el.disabled = true;
        el.textContent = '清理中…';
        try { localStorage.removeItem(el.getAttribute('data-key') || ''); } catch (e) { }
        try {
          await fetch('/upload/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: el.getAttribute('data-id') || '' }) });
        } catch (e) { }
        await paintPending();
      }));
    };
    const load = async () => {
      if (!listEl) return;
      let j = null;
      try { j = await fetch('/files?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { j = null; }
      if (!j || !j.ok) { listEl.innerHTML = '<span style="color:#ff6b6b">读取文件列表失败</span>'; return; }
      if (!j.files.length) { listEl.innerHTML = '<span style="color:#6b7078">还没有从手机传过文件</span>'; return; }
      listEl.innerHTML = j.files.map((f) => {
        const d = new Date(f.at);
        const t = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
          + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        return '<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #202228">'
          + '<a href="/file?name=' + encodeURIComponent(f.name) + '" style="flex:1;min-width:0;color:#8fb6ff;'
          + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(f.name) + '</a>'
          + '<span style="color:#6b7078;font-size:11px;white-space:nowrap">' + fmt(f.size) + '</span>'
          + '<span style="color:#5c6169;font-size:10.5px;white-space:nowrap">' + t + '</span></div>';
      }).join('');
    };
    // 电脑文件浏览：只开放用户目录（桌面/下载/文档/图片），点文件夹进入、点下载存到手机
    const browse = async (dir) => {
      if (!pcList) return;
      pcList.innerHTML = '<span style="color:#6b7078">读取中…</span>';
      let j = null;
      try { j = await fetch('/browse?dir=' + encodeURIComponent(dir || '') + '&_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { j = null; }
      if (!j || !j.ok) { pcList.innerHTML = '<span style="color:#ff6b6b">' + escHtml((j && j.message) || '读取失败') + '</span>'; return; }
      let h = '';
      if (j.dir) {
        h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">'
          + '<button class="pcUp" data-dir="' + escHtml(j.parent || '') + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:11.5px;cursor:pointer">↑ 上一级</button>'
          + '<span style="color:#6b7078;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%">' + escHtml(j.dir) + '</span></div>';
      }
      if (!j.items.length) h += '<div style="color:#6b7078">空文件夹</div>';
      h += j.items.map((it) => {
        if (it.dir) {
          return '<div class="pcRow" data-dir="' + escHtml(it.path) + '" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #202228;cursor:pointer">'
            + '<span style="color:#ffd479;width:12px">▸</span>'
            + '<span style="flex:1;min-width:0;color:#c9ccd1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(it.name) + '</span>'
            + '<span style="color:#5c6169;font-size:10.5px">文件夹</span></div>';
        }
        return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #202228">'
          + '<span style="flex:1;min-width:0;color:#c9ccd1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(it.name) + '</span>'
          + '<span style="color:#6b7078;font-size:11px;white-space:nowrap">' + fmt(it.size) + '</span>'
          + '<a href="/download?path=' + encodeURIComponent(it.path) + '" style="color:#8fb6ff;font-size:11.5px;white-space:nowrap">下载</a></div>';
      }).join('');
      pcList.innerHTML = h;
      pcList.querySelectorAll('.pcRow, .pcUp').forEach((el) => el.addEventListener('click', (ev) => {
        if (ev.target && ev.target.tagName === 'A') return;
        browse(el.getAttribute('data-dir') || '');
      }));
    };
    // 小文件：单连接流式 POST
    const uploadSimple = (f, onProg) => new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      liveXhr.add(xhr);
      xhr.open('POST', '/file?name=' + encodeURIComponent(f.name));
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProg(ev.loaded); };
      xhr.onload = () => {
        liveXhr.delete(xhr);
        let j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) { }
        resolve({ ok: xhr.status === 200 && j && j.ok, msg: (j && j.message) || ('HTTP ' + xhr.status) });
      };
      xhr.onerror = () => { liveXhr.delete(xhr); resolve({ ok: false, msg: cancelReq ? '已取消' : '网络断了', cancelled: cancelReq }); };
      xhr.onabort = () => { liveXhr.delete(xhr); resolve({ ok: false, msg: '已取消', cancelled: true, cleaned: true }); };
      xhr.send(f);
    });
    // 大文件：分片 + 4 路并发（服务端按偏移写同一个文件），支持断点续传
    const uploadBig = async (f, onProg) => {
      const key = 'upq:' + f.name + ':' + f.size;
      let init = null;
      let loaded = 0;
      const chunkLenOf = (cs, i) => Math.min(cs, f.size - i * cs);
      try {
        let savedId = '';
        try { savedId = localStorage.getItem(key) || ''; } catch (e) { }
        if (savedId) {
          let st = null;
          try { const r = await fetch('/upload/status?id=' + savedId + '&_=' + Date.now(), { cache: 'no-store' }); if (r.status === 200) st = await r.json(); } catch (e) { }
          if (st && st.ok && st.size === f.size && st.name === f.name) {
            init = { id: st.id, chunkSize: st.chunkSize, parts: st.parts, done: st.done || [] };
          }
        }
        if (!init) {
          const r = await fetch('/upload/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, size: f.size }) });
          const j = await r.json().catch(() => null);
          if (!j || !j.ok) return { ok: false, msg: (j && j.message) || ('初始化失败 HTTP ' + r.status) };
          init = { id: j.id, chunkSize: j.chunkSize, parts: j.parts, done: [] };
        }
        try { localStorage.setItem(key, init.id); } catch (e) { }
        if (cancelReq) return { ok: false, cancelled: true, msg: '已取消' };
        const cs = init.chunkSize;
        const parts = init.parts;
        const doneSet = new Set(init.done || []);
        doneSet.forEach((i) => { loaded += chunkLenOf(cs, i); });
        if (loaded > 0) onProg(loaded, '续传');
        let next = 0;
        let failed = '';
        const sendPart = (i) => new Promise((resolve) => {
          const start = i * cs;
          const end = Math.min(f.size, start + cs);
          const blob = f.slice(start, end);
          const xhr = new XMLHttpRequest();
          liveXhr.add(xhr);
          xhr.open('POST', '/upload/part?id=' + init.id + '&index=' + i);
          let last = 0;
          xhr.upload.onprogress = (ev) => {
            if (!ev.lengthComputable) return;
            const delta = ev.loaded - last;
            last = ev.loaded;
            loaded += delta;
            onProg(loaded);
          };
          xhr.onload = () => {
            liveXhr.delete(xhr);
            if (xhr.status === 200) { doneSet.add(i); resolve(true); }
            else { failed = failed || ('分片 ' + (i + 1) + '/' + parts + ' 失败 HTTP ' + xhr.status); resolve(false); }
          };
          xhr.onerror = () => { liveXhr.delete(xhr); failed = failed || (cancelReq ? '已取消' : '网络断了'); resolve(false); };
          xhr.onabort = () => { liveXhr.delete(xhr); resolve(false); };
          xhr.send(blob);
        });
        const worker = async () => {
          for (;;) {
            if (cancelReq) return;
            const i = next++;
            if (i >= parts) return;
            if (doneSet.has(i)) continue;
            const ok = await sendPart(i);
            if (!ok) return;
            onProg(loaded);
          }
        };
        const workers = [];
        for (let wi = 0; wi < PARALLEL; wi++) workers.push(worker());
        await Promise.all(workers);
        if (cancelReq) {
          // 一片都没传成 → 没东西可续，直接把暂存会话清掉，别留空壳占盘
          if (!doneSet.size) {
            try {
              await fetch('/upload/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: init.id }) });
            } catch (e) { }
            try { localStorage.removeItem(key); } catch (e) { }
            return { ok: false, cancelled: true, cleaned: true, msg: '已取消' };
          }
          return { ok: false, cancelled: true, msg: '已取消' };
        }
        if (failed) return { ok: false, msg: failed, cancelled: false };
        const r2 = await fetch('/upload/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: init.id }) });
        const j2 = await r2.json().catch(() => null);
        if (!j2 || !j2.ok) return { ok: false, msg: (j2 && j2.message) || ('完成失败 HTTP ' + r2.status) };
        try { localStorage.removeItem(key); } catch (e) { }
        return { ok: true, msg: j2.message || '' };
      } catch (e) {
        return { ok: false, msg: (e && e.message) || '上传出错' };
      }
    };
    let busy = false;
    const setBusy = (on) => {
      busy = on;
      if (sendBtn) sendBtn.disabled = on;
      if (cancelBtn) {
        cancelBtn.style.display = on ? 'inline-block' : 'none';
        cancelBtn.disabled = false;
        cancelBtn.textContent = '取消';
      }
    };
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      if (!busy) { cancelBtn.style.display = 'none'; return; }
      cancelReq = true;
      killXhr();
      cancelBtn.disabled = true;
      cancelBtn.textContent = '取消中…';
      setMsg('正在取消…', '#ffb454');
    });
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      if (busy) return;
      const files = pick.files ? Array.from(pick.files) : [];
      if (!files.length) { setMsg('先选文件（可多选）', '#ffb454'); return; }
      cancelReq = false;
      setBusy(true);
      if (wrap) wrap.style.display = 'block';
      if (bar) bar.style.width = '0%';
      let doneBytes = 0;
      let okCount = 0;
      let failCount = 0;
      let stopped = false;
      let keptNothing = false;
      const tAll = Date.now();
      for (let i = 0; i < files.length; i++) {
        if (cancelReq) { stopped = true; break; }
        const f = files[i];
        const label = '（' + (i + 1) + '/' + files.length + '）' + f.name;
        const t0 = Date.now();
        let lastUi = 0;
        const onProg = (loaded, tag) => {
          const now = Date.now();
          if (now - lastUi < 120 && loaded < f.size) return;
          lastUi = now;
          const pct = f.size ? Math.min(100, Math.round(loaded * 100 / f.size)) : 0;
          if (bar) bar.style.width = pct + '%';
          const sec = Math.max(0.2, (now - t0) / 1000);
          const speed = loaded / sec;
          const left = speed > 0 ? (f.size - loaded) / speed : 0;
          if (prog) prog.textContent = label + (tag ? '（' + tag + '）' : '') + ' · ' + fmt(loaded) + ' / ' + fmt(f.size)
            + '（' + pct + '%） · ' + fmtSpeed(speed) + ' · 剩余 ' + (left > 1 ? Math.ceil(left) + ' 秒' : '…');
        };
        // 续传提示：服务端暂存里还有同名同大小的会话
        const back = pending.find((it) => it.name === f.name && it.size === f.size);
        if (back) {
          if (back.pct >= 100) setMsg(label + '：分片已传完，正在完成合并…', '#8CE58C');
          else if (back.pct > 0) setMsg(label + '：检测到没传完，从 ' + back.pct + '% 继续', '#8CE58C');
        }
        onProg(0);
        const res = f.size > BIG ? await uploadBig(f, onProg) : await uploadSimple(f, (n) => onProg(n));
        if ((res && res.cancelled) || cancelReq) { stopped = true; keptNothing = !!(res && res.cleaned); break; }
        if (res.ok) { okCount++; doneBytes += f.size; if (bar) bar.style.width = '100%'; }
        else { failCount++; setMsg(label + ' 失败：' + (res.msg || '未知'), '#ff6b6b'); }
      }
      const secs = Math.max(0.2, (Date.now() - tAll) / 1000);
      if (stopped) {
        setMsg(keptNothing
          ? '已取消（还没传成任何分片，暂存已清掉，不占硬盘）'
          : '已取消：已传的分片保留 3 天，重新选同名文件可续传（上面「丢弃」可清掉）', '#ffb454');
        if (prog) prog.textContent = '已取消';
      } else if (!failCount) {
        setMsg('完成：' + okCount + ' 个文件，共 ' + fmt(doneBytes) + '，' + secs.toFixed(1) + ' 秒（平均 ' + fmtSpeed(doneBytes / secs) + '）', '#8CE58C');
        pick.value = '';
        if (prog) prog.textContent = '平均 ' + fmtSpeed(doneBytes / secs);
      } else {
        setMsg('完成 ' + okCount + ' 个、失败 ' + failCount + ' 个（大文件重试会断点续传）', '#ffb454');
      }
      setBusy(false);
      if (!stopped) setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 3000);
      await paintPending();
      load();
    });
    load();
    browse('');
    paintPending();
  }
  // ---- 高性能模式（Sunshine/Moonlight，2026-11-03 S3）------------------------
  // 只做三件事：显示状态、列出等待配对的 Moonlight 设备、提交 4 位 PIN。
  // 配对请求走服务端 /sunshine-pairings 与 /sunshine-pin（Sunshine 凭据只在服务端）。
  function sunshineBind(box) {
    const bodyEl = box.querySelector('#ssBody');
    const msgEl = box.querySelector('#ssMsg');
    const btn = box.querySelector('#ssRefresh');
    if (!bodyEl) return;
    let timer = 0;
    let selectedId = '';
    let lastSig = '';
    let lastStatus = null;
    // 2026-11-07：配对地址（局域网最快 / tailnet 远程）+ 使用说明
    // 2026-11-07：配对地址（给普通用户看的说法：家里 / 在外面，两步操作）
    // 2026-11-07：配对地址分两种用法——Moonlight 只填 IP；浏览器才填 https://IP:端口
    // 2026-11-07：配对说明改成与产品界面一致——PIN 就在本页下面输，不需要开浏览器后台
    const renderAddr = (j) => {
      const box = document.getElementById('ssAddr');
      if (!box) return;
      const list = Array.isArray(j && j.lanIps) ? j.lanIps : [];
      const port = (j && j.webPort) || 47990;
      const lan = list.filter((x) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(x.ip || '')));
      const ts = list.filter((x) => /^100\./.test(String(x.ip || '')))[0] || ((j && j.tailnetIp) ? { ip: j.tailnetIp } : null);
      const chip = (text, color) => {
        const t = escHtml(text);
        return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:5px">'
          + '<code style="font:14px/1.4 ui-monospace,Consolas,monospace;color:' + color + ';background:#14151a;'
          + 'border:1px solid #24262e;border-radius:8px;padding:6px 9px;user-select:all">' + t + '</code>'
          + '<button type="button" data-copy="' + t + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;'
          + 'border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer">复制</button></div>';
      };
      const scene = (title, ip, color) => {
        return '<div style="margin-top:10px;color:' + color + ';font-size:12.5px;font-weight:600">' + title + '</div>'
          + '<div style="color:#aeb3bb;font-size:12px;margin-top:4px">① 手机装 Moonlight → 点「Add Host / 添加电脑」→ 填这个（<b style="color:#c9ccd1">只填 IP，不要加 https:// 和端口</b>）</div>'
          + chip(ip, color)
          + '<div style="color:#aeb3bb;font-size:12px;margin-top:6px">② 在 Moonlight 里点这台电脑 → 它会显示 4 位数字 → <b style="color:#c9ccd1">回到本页下面，在「4 位 PIN」里输入 → 点「完成配对」</b></div>';
      };
      let h = '<div style="color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em">怎么连（两步，PIN 就在本页填）</div>';
      if (lan.length) h += scene('在家里 / 连同一个 Wi-Fi（推荐，最顺）', lan[0].ip, '#8CE58C');
      if (ts) {
        h += scene('在外面 / 用手机流量', ts.ip, '#8fb6ff');
        h += '<div style="color:#6b7078;font-size:11.5px;margin-top:4px;line-height:1.7">在外面用的时候，手机也要装 Tailscale 并登录同一个账号，否则连不上（不装也能在家用）。<br>如果连同一个 Wi-Fi 也连不上，多半是路由器禁止设备互访——用上面「在外面」这个地址，或者用电脑开热点给手机连。</div>';
      }
      if (!lan.length && !ts) h += '<div style="margin-top:8px;color:#ffb454;font-size:12px">暂时没取到地址，先连上网络再刷新一次。</div>';
      h += '<div style="margin-top:10px;padding-top:9px;border-top:1px solid #23252c;color:#6b7078;font-size:11.5px;line-height:1.8">'
        + '· 觉得画面有点卡：在 Moonlight 里把「分辨率」选 <b style="color:#c9ccd1">1080p</b>、「帧率」选 <b style="color:#c9ccd1">60</b><br>'
        + '· 实在配不上的备用办法：用手机浏览器打开 <code style="color:#aeb3bb">https://' + escHtml(lan.length ? lan[0].ip : (ts ? ts.ip : '')) + ':' + port + '</code>，在后台里配对（一般不走到这一步）'
        + '</div>';
      box.innerHTML = h;
      box.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-copy') || '';
        const done = () => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done).catch(done); }
          else { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); done(); }
        } catch (e) { done(); }
      }));
    };
    try { fetch('/sunshine-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then(renderAddr).catch(() => { }); } catch (e) { }
    // 2026-11-07：产品内“添加游戏”（Steam 列表 + 手动 exe），用户不用进 Sunshine 英文后台
    const gamesHtml = (j) => {
      const games = (j && Array.isArray(j.games)) ? j.games : [];
      if (!j || !j.ok) return '<div style="color:#ff6b6b;font-size:12px">读取游戏列表失败</div>';
      if (!j.sunshine) return '<div style="color:#ffb454;font-size:12px">串流组件没连上，先确认上面显示「已就绪」</div>';
      if (!games.length) return '<div style="color:#6b7078;font-size:12px">这台电脑没检到已安装的 Steam 游戏</div>';
      let h = '<div style="color:#aeb3bb;font-size:12px;margin-bottom:6px">这台电脑上已安装的 Steam 游戏（点「添加」就能在 Moonlight 里选）</div>';
      h += games.map((g) => '<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #202228;font-size:12.5px">'
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9ccd1">' + escHtml(g.name) + '</span>'
        + (g.added
          ? '<span style="color:#8CE58C;font-size:11.5px">已添加</span><button data-grm="' + escHtml(g.appid) + '" style="background:#2a2d36;color:#ffb454;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer;margin-left:6px">移除</button>'
          : '<button data-gadd="' + escHtml(g.appid) + '" style="background:#2f6feb;color:#fff;border:0;border-radius:7px;padding:4px 10px;font-size:11.5px;cursor:pointer">添加</button>')
        + '</div>').join('');
      h += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #23252c">'
        + '<div style="color:#aeb3bb;font-size:12px;margin-bottom:5px">不是 Steam 的游戏？填 exe 完整路径也能加</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
        + '<input id="gmExe" placeholder="D:\\Games\\Game\\game.exe" style="flex:1;min-width:180px;background:#0f1014;color:#e8eaee;border:1px solid #262932;border-radius:8px;padding:6px 9px;font-size:12px">'
        + '<button id="gmAddExe" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer">添加 exe</button></div>'
        + '</div>';
      return h;
    };
    let gmBusy = false;
    const loadGames = async () => {
      const box2 = document.getElementById('ssGames');
      if (!box2) return;
      box2.innerHTML = '<div style="color:#868c96;font-size:12px">正在读取游戏列表…</div>';
      try {
        const j = await fetch('/game-list?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
        box2.innerHTML = gamesHtml(j);
        box2.querySelectorAll('[data-gadd]').forEach((b) => b.addEventListener('click', async () => {
          if (gmBusy) return;
          gmBusy = true; b.disabled = true; b.textContent = '添加中…';
          try {
            const r = await fetch('/game-add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appid: b.getAttribute('data-gadd') }) }).then((x) => x.json());
            if (r && r.ok && r.added) { b.outerHTML = '<span style="color:#8CE58C;font-size:11.5px">已添加</span>'; }
            else if (r && r.ok && r.duplicate) { b.outerHTML = '<span style="color:#6b7078;font-size:11.5px">已添加过</span>'; }
            else { b.disabled = false; b.textContent = '添加'; alert((r && r.error) || '添加失败'); }
          } catch (e) { b.disabled = false; b.textContent = '添加'; }
          gmBusy = false;
        }));
        box2.querySelectorAll('[data-grm]').forEach((rb) => rb.addEventListener('click', async () => {
          if (!confirm('从 Moonlight 列表里移除这个游戏？（不会卸载游戏本身）')) return;
          rb.disabled = true; rb.textContent = '…';
          try {
            const r = await fetch('/game-remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appid: rb.getAttribute('data-grm') }) }).then((x) => x.json());
            if (!(r && r.ok)) alert((r && r.error) || '移除失败');
          } catch (e) { alert('移除失败'); }
          loadGames();
        }));
        const exeBtn = box2.querySelector('#gmAddExe');
        if (exeBtn) exeBtn.addEventListener('click', async () => {
          const inp = box2.querySelector('#gmExe');
          const p2 = inp ? String(inp.value || '').trim() : '';
          if (!p2) { alert('请填 exe 的完整路径'); return; }
          exeBtn.disabled = true; exeBtn.textContent = '添加中…';
          try {
            const r = await fetch('/game-add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exePath: p2 }) }).then((x) => x.json());
            if (r && r.ok) { alert(r.duplicate ? '这个已经添加过了' : ('已添加：' + (r.name || ''))); loadGames(); }
            else alert((r && r.error) || '添加失败');
          } catch (e) { alert('添加失败'); }
          exeBtn.disabled = false; exeBtn.textContent = '添加 exe';
        });
      } catch (e) { box2.innerHTML = '<div style="color:#ff6b6b;font-size:12px">读取失败</div>'; }
    };
    try { loadGames(); } catch (e) { }
    let ssCreds = null;
    let ssCredsTried = false;
    const loadCreds = () => {
      if (ssCredsTried) return;
      ssCredsTried = true;
      fetch('/sunshine-creds?_=' + Date.now(), { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (j && j.ok) { ssCreds = j; lastStatus && render(lastStatus, lastPairings || []); } })
        .catch(() => { });
    };
    let lastPairings = [];
    const setMsg = (t, c) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = c || '#868c96'; } };
    const stop = () => { if (timer) { clearInterval(timer); timer = 0; } };
    const step = (n, text) => '<div style="display:flex;gap:8px;margin:4px 0;font-size:12.5px;color:#aeb3bb;line-height:1.75">'
      + '<b style="color:#8fb6ff;min-width:14px">' + n + '</b><span>' + text + '</span></div>';
    const pairsHtml = (pairings) => {
      if (!pairings || !pairings.length) {
        return '<div style="margin-top:9px;color:#6b7078;font-size:12px">在 Moonlight 里点这台电脑后，这里会自动出现配对请求。</div>';
      }
      return '<div style="margin-top:10px;color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em">等待配对的设备</div>'
        + pairings.map((p) => '<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #202228;font-size:12.5px">'
          + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9ccd1">'
          + escHtml(p.name || 'Moonlight 设备')
          + (p.address ? ' <span style="color:#6b7078">' + escHtml(p.address) + '</span>' : '') + '</span>'
          + '<button class="ssPick" data-id="' + escHtml(p.id) + '" style="background:' + (selectedId === p.id ? 'rgba(47,111,235,.25)' : '#2a2d36') + ';'
          + 'color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer">'
          + (selectedId === p.id ? '已选' : '选这个') + '</button></div>').join('');
    };
    const bindComponent = () => {
      const btn = bodyEl.querySelector('#ssComp');
      const msg = bodyEl.querySelector('#ssCompMsg');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        if (msg) msg.textContent = '开始下载…';
        let j = null;
        try { j = await fetch('/sunshine-component', { method: 'POST' }).then((r) => r.json()); } catch (e) { j = null; }
        if (!j || !j.ok) { btn.disabled = false; if (msg) msg.textContent = (j && (j.message || j.error)) || '下载启动失败'; return; }
        const timer = setInterval(async () => {
          if (!document.body.contains(box)) { clearInterval(timer); return; }
          lastSig = '';
          await poll();
          const st = bodyEl.querySelector('#ssComp');
          if (!st || !st.disabled) clearInterval(timer);
        }, 1500);
      });
    };    const bindPairs = (pairings) => {
      bodyEl.querySelectorAll('.ssPick').forEach((b) => b.addEventListener('click', () => {
        selectedId = b.getAttribute('data-id') || '';
        const area = bodyEl.querySelector('#ssPairs');
        if (area) { area.innerHTML = pairsHtml(pairings); bindPairs(pairings); }
      }));
      const pin = bodyEl.querySelector('#ssPin');
      const pair = bodyEl.querySelector('#ssPair');
      if (pair) pair.addEventListener('click', async () => {
        const code = String((pin && pin.value) || '').trim();
        if (!/^\d{4}$/.test(code)) { setMsg('PIN 是 Moonlight 上显示的 4 位数字', '#ffb454'); return; }
        if (!selectedId) { setMsg('先在 Moonlight 里点一次这台电脑，等下面出现设备再配对', '#ffb454'); return; }
        pair.disabled = true;
        setMsg('配对中…（Moonlight 那边会转圈）', '#868c96');
        let j = null;
        try {
          j = await fetch('/sunshine-pin', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pairing_id: selectedId, pin: code, name: '手机' })
          }).then((r) => r.json());
        } catch (e) { j = null; }
        pair.disabled = false;
        setMsg((j && (j.message || j.error)) || '配对失败', (j && j.ok) ? '#8CE58C' : '#ff6b6b');
        if (j && j.ok) { selectedId = ''; setTimeout(poll, 1200); }
        else { setTimeout(poll, 1500); }
      });
      const unpair = bodyEl.querySelector('#ssUnpair');
      if (unpair) unpair.addEventListener('click', async () => {
        if (!confirm('清空这台电脑上所有 Moonlight 配对？之后要在 Moonlight 里重新添加电脑并输入 PIN。')) return;
        unpair.disabled = true;
        setMsg('正在清空配对…', '#868c96');
        let j = null;
        try { j = await fetch('/sunshine-unpair', { method: 'POST' }).then((r) => r.json()); } catch (e) { j = null; }
        unpair.disabled = false;
        setMsg((j && (j.message || j.error)) || '清空配对失败', (j && j.ok) ? '#8CE58C' : '#ff6b6b');
        if (j && j.ok) { selectedId = ''; lastSig = ''; setTimeout(poll, 800); }
      });
    };
    const render = (s, pairings) => {
      lastStatus = s;
      lastPairings = pairings || [];
      if (s && s.installed && s.webUp) loadCreds();
      const sig = JSON.stringify([s.installed, s.webUp, s.credentialsSet, s.licensed, (pairings || []).map((p) => p.id), ssCreds ? 1 : 0]);
      if (sig === lastSig) return;
      lastSig = sig;
      const prevPin = (bodyEl.querySelector('#ssPin') || {}).value || '';
      let h = '';
      if (!s.installed) {
        const comp = s.component || {};
        const job = comp.job || {};
        const busy = job.phase === 'downloading' || job.phase === 'installing';
        const mb = (n) => ((Number(n) || 0) / 1048576).toFixed(1);
        const pct = job.total ? Math.min(100, Math.round((job.received || 0) / job.total * 100)) : 0;
        const phaseText = job.phase === 'downloading'
          ? ('下载中 ' + pct + '%（' + mb(job.received) + ' / ' + mb(job.total) + ' MB）')
          : job.phase === 'installing' ? '正在安装（电脑上会弹管理员授权，请点「是」）'
          : job.phase === 'error' ? ('失败：' + (job.error || '未知错误'))
          : '';
        h = setPill(false, '', '未启用') + '<div style="margin-top:8px">这台电脑还没装串流组件（Moonlight 用的 Sunshine）。</div>';
        if (comp.configured) {
          h += '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            + '<button id="ssComp" ' + (busy ? 'disabled' : '') + ' style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
            + 'padding:9px 15px;font-size:13px;cursor:pointer' + (busy ? ';opacity:.6' : '') + '">'
            + (busy ? '处理中…' : '下载并安装组件（约 32MB）') + '</button>'
            + '<span id="ssCompMsg" style="font-size:12px;color:#868c96">' + escHtml(phaseText) + '</span></div>'
            + '<div style="color:#6b7078;font-size:11px;margin-top:6px">Sunshine 是 GPL-3.0 独立程序（来源 LizardByte/Sunshine），'
            + '安装后只绑 tailnet；手机还需另装 Moonlight。安装时电脑会弹管理员授权。</div>';
        } else {
          h += '<div style="margin-top:8px;color:#868c96;font-size:12px">组件下载地址还没配置'
            + '（上传组件后把链接和 SHA256 填进 product.config.json → components.sunshine）。</div>';
        }
      } else if (!s.webUp || !s.credentialsSet) {
        const jobInit = s.init || {};
        const initBusy = jobInit.phase === 'running';
        h = setPill(false, '', s.credentialsSet ? '已安装未运行' : '待初始化')
          + '<div style="margin-top:8px">' + (s.credentialsSet
            ? 'Sunshine 已装但服务没运行：点下面初始化（会弹管理员授权），或重启电脑。'
            : 'Sunshine 已装，但还没生成配对凭据：点下面初始化（会弹管理员授权）。') + '</div>'
          + '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<button id="ssInit" ' + (initBusy ? 'disabled' : '') + ' style="background:#2f6feb;color:#fff;border:0;border-radius:9px;padding:9px 15px;font-size:13px;cursor:pointer' + (initBusy ? ';opacity:.6' : '') + '">' + (initBusy ? '初始化中…' : '一键初始化高性能模式') + '</button>'
          + '<span id="ssInitMsg" style="font-size:12px;color:#868c96">' + escHtml(initBusy ? '等电脑上点「是」（管理员授权）…' : (jobInit.phase === 'error' ? jobInit.error : '')) + '</span>'
          + '</div>';
      } else if (false) {   // 2026-11-07：产品已全部免费，高性能模式不再需要许可证
        h = setPill(false, '', '未授权') + '<div style="margin-top:8px"></div>';
      } else {
        const host = location.hostname || '本机';
        if (!selectedId || !(pairings || []).some((p) => p.id === selectedId)) {
          selectedId = (pairings && pairings.length) ? pairings[0].id : '';
        }
        h = setPill(true, '已就绪', '')
          + '<div style="display:flex;gap:8px;margin:10px 0 4px;flex-wrap:wrap">'
          + '<a id="ssOpen" href="' + moonDeepLink() + '" style="background:#2f6feb;color:#fff;border-radius:9px;padding:9px 15px;font-size:13px;text-decoration:none">🎮 用 Moonlight 打开</a>'
          + '<button id="ssCopyHost" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:9px 13px;font-size:12.5px;cursor:pointer">复制电脑地址</button>'
          + '<a href="https://github.com/moonlight-stream/moonlight-android/releases" target="_blank" rel="noopener noreferrer" style="color:#8fb6ff;font-size:12.5px;align-self:center">Moonlight 下载</a>'
          + '</div>'
          + step(1, '手机装 <b>Moonlight</b>（安卓点上面的「Moonlight 下载」；iPhone 在 App Store 搜 Moonlight）')
          + step(2, '按下面「怎么连」填地址；Moonlight 点这台电脑后，它会显示 4 位数字')
          + step(3, '把这 4 位数字填到下面的输入框，点「完成配对」')
          + '<div id="ssPairs">' + pairsHtml(pairings) + '</div>'
          + '<div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;align-items:center">'
          + '<input id="ssPin" inputmode="numeric" maxlength="4" placeholder="4 位 PIN" style="width:110px;background:#0f1014;color:#e8eaee;'
          + 'border:1px solid #262932;border-radius:9px;padding:8px 11px;font:14px ui-monospace,Consolas,monospace">'
          + '<button id="ssPair" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;padding:8px 15px;font-size:12.5px;cursor:pointer">完成配对</button></div>'
          + '<details style="margin-top:12px;padding-top:10px;border-top:1px solid #24262d">'
          + '<summary style="cursor:pointer;color:#8fb6ff;font-size:12.5px">高级：加新游戏 / 调画质 / 管理配对</summary>'
          + '<div style="margin-top:8px;color:#aeb3bb;font-size:12px;line-height:1.85">'
          + '想串流别的游戏、或调画质码率，才需要打开管理页：<a id="ssAdmin" target="_blank" rel="noopener" style="color:#8fb6ff">打开管理页</a>'
          + '<span id="ssAdminMsg" style="font-size:11.5px;color:#6b7078;margin-left:6px"></span>'
          + '<div style="margin-top:6px;color:#c9ccd1">登录用：账号 <code style="color:#8fb6ff">' + (ssCreds ? escHtml(ssCreds.username) : '读取中…') + '</code>'
          + (ssCreds ? ' <button id="ssCopyUser" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer">复制账号</button>' : '')
          + '<br>密码 <code id="ssPwText" style="color:#8fb6ff">' + (ssCreds ? '••••••••' : '读取中…') + '</code>'
          + (ssCreds ? ' <button id="ssPwShow" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer">显示</button><button id="ssCopyPw" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer">复制密码</button>' : '')
          + '<div style="color:#6b7078;font-size:11px;margin-top:5px;line-height:1.7">管理页是电脑本机的 https 页面，第一次打开浏览器会提示证书不安全——选「继续」再登录。只在你自己家里/私人网络里用，别在公共 Wi-Fi 下打开。</div>'
          + '</div></details>'
          + '<div style="margin-top:10px"><button id="ssUnpair" style="background:#2a2d36;color:#ffb454;border:1px solid #3a3e4a;'
          + 'border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">配对一直不成功？清空旧配对再试</button></div>';
          + '<div style="margin-top:10px"><button id="ssUnpair" style="background:#2a2d36;color:#ffb454;border:1px solid #3a3e4a;'
          + 'border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">清空配对（连不上时用）</button></div>';
      }
      bodyEl.innerHTML = h;
      const pinEl = bodyEl.querySelector('#ssPin');
      if (pinEl && prevPin) pinEl.value = prevPin;
      if (bodyEl.querySelector('#ssPairs')) bindPairs(pairings || []);
      if (bodyEl.querySelector('#ssComp')) bindComponent();
      // 一键初始化（已装 Sunshine 但没凭据/服务没起）：点了以后自动轮询状态
      const initBtn = bodyEl.querySelector('#ssInit');
      if (initBtn) initBtn.addEventListener('click', async () => {
        const msgEl = bodyEl.querySelector('#ssInitMsg');
        initBtn.disabled = true;
        initBtn.textContent = '初始化中…';
        if (msgEl) msgEl.textContent = '等电脑上点「是」（管理员授权）…';
        try { await fetch('/sunshine-init', { method: 'POST' }); } catch (e) { }
        let n = 0;
        const iv = setInterval(() => {
          n++;
          if (n > 48 || !document.body.contains(box)) { clearInterval(iv); return; }
          poll();
        }, 2500);
      });
      // 游戏模式的快捷入口：复制电脑地址 / 管理页（自动带出账号密码并复制密码）
      const copyHost = bodyEl.querySelector('#ssCopyHost');
      if (copyHost) copyHost.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(location.hostname);
          copyHost.textContent = '已复制：' + location.hostname;
        } catch (e) { setMsg('复制失败，请手动记：' + location.hostname, '#ffb454'); }
      });
      const adminLink = bodyEl.querySelector('#ssAdmin');
      if (adminLink) adminLink.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const msgEl = bodyEl.querySelector('#ssAdminMsg');
        try {
          const c = ssCreds || await fetch('/sunshine-creds?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
          if (!c || !c.ok) { if (msgEl) msgEl.textContent = '还没初始化账号（点上面的「一键初始化」）'; return; }
          try { await navigator.clipboard.writeText(c.password); } catch (e) { }
          if (msgEl) msgEl.textContent = '账号 ' + c.username + ' · 密码已复制到剪贴板';
          window.open('https://' + location.hostname + ':47990/', '_blank', 'noopener');
        } catch (e) {
          if (msgEl) msgEl.textContent = '打开失败：' + (e && e.message);
        }
      });
      const copyUser = bodyEl.querySelector('#ssCopyUser');
      if (copyUser) copyUser.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ssCreds.username); copyUser.textContent = '已复制'; } catch (e) { }
      });
      const pwShow = bodyEl.querySelector('#ssPwShow');
      if (pwShow) pwShow.addEventListener('click', () => {
        const t = bodyEl.querySelector('#ssPwText');
        if (!t || !ssCreds) return;
        const hidden = t.textContent.indexOf('•') >= 0;
        t.textContent = hidden ? ssCreds.password : '••••••••';
        pwShow.textContent = hidden ? '隐藏' : '显示';
      });
      const copyPw = bodyEl.querySelector('#ssCopyPw');
      if (copyPw) copyPw.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ssCreds.password); copyPw.textContent = '已复制'; } catch (e) { }
      });
    };
    const poll = async () => {
      let s = null;
      try { s = await fetch('/sunshine-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { s = null; }
      if (!s) { setMsg('检测失败：读不到状态', '#ff6b6b'); return; }
      if (s.installed && s.webUp && s.credentialsSet && s.licensed) {
        let p = null;
        try { p = await fetch('/sunshine-pairings?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { p = null; }
        if (p && p.ok) {
          render(s, p.pairings || []);
          if (!timer) timer = setInterval(() => { if (!document.body.contains(box)) { stop(); return; } poll(); }, 3000);
          return;
        }
        render(s, []);
        if (!timer) timer = setInterval(() => { if (!document.body.contains(box)) { stop(); return; } poll(); }, 3000);
        return;
      }
      stop();
      render(s, []);
    };
    if (btn) btn.addEventListener('click', () => { setMsg(''); lastSig = ''; poll(); });
    poll();
  }

  function clipboardBind(box) {
    const ta = box.querySelector('#cbText');
    const msg = box.querySelector('#cbMsg');
    const readBtn = box.querySelector('#cbRead');
    const sendBtn = box.querySelector('#cbSend');
    if (!ta) return;
    const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || '#868c96'; } };
    if (readBtn) readBtn.addEventListener('click', async () => {
      readBtn.disabled = true; setMsg('读取中…', '#868c96');
      let j = null;
      try { j = await fetch('/clipboard?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { j = null; }
      readBtn.disabled = false;
      if (!j || !j.ok) { setMsg((j && j.message) || '读取失败', '#ff6b6b'); return; }
      ta.value = j.text || '';
      setMsg('已读取 ' + (j.length || 0) + ' 字', '#8CE58C');
    });
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      const text = String(ta.value || '');
      if (!text) { setMsg('先输入要发送的文字', '#ffb454'); return; }
      sendBtn.disabled = true; setMsg('发送中…', '#868c96');
      let j = null;
      try {
        j = await fetch('/clipboard', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text })
        }).then((r) => r.json());
      } catch (e) { j = null; }
      sendBtn.disabled = false;
      if (!j || !j.ok) { setMsg((j && j.message) || '发送失败', '#ff6b6b'); return; }
      setMsg('已发送到电脑（' + (j.length || text.length) + ' 字），电脑上 Ctrl+V 即可', '#8CE58C');
    });
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
    if (!P) return '<div style="color:#868c96;font-size:12.5px">外观模块没加载</div>';
    const licensed = true;   // 2026-11-06 免费化：个性化对所有人生效
    const lock = licensed ? '' : ' <span style="font-size:11px">🔒</span>';
    let h = '';
    if (!licensed) {
      h += '<div style="color:#868c96;font-size:12.5px;margin-bottom:10px;line-height:1.6">'
        + '外观只影响你自己看到的样式，随时可以改。'
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
    // 2026-10-31：自定义配色取色器（主题）。以前只能手写 JSON，现在点色块直接改。
    const cust0 = licensed ? P.loadCustom() : null;
    h += '<div style="color:#868c96;font-size:12px;margin:10px 0 6px">自定义配色（主题）' + lock + '</div>'
      + '<div id="p13nThemePick" style="display:flex;gap:10px;flex-wrap:wrap">';
    for (const f of P.THEME_FIELDS) {
      h += '<label style="display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11.5px;color:#aeb3bb">'
        + escHtml(f.name)
        + '<input type="color" class="p13nTC" data-f="' + f.k + '" value="' + P.toColorInput(cust0 && cust0[f.k], f.def) + '"'
        + ' style="width:44px;height:30px;border:1px solid #3a3e4a;border-radius:8px;background:#1b1d23;padding:1px"' + (licensed ? '' : ' disabled') + '></label>';
    }
    h += '</div>';
    // 实验版 E1（2026-11-07 按用户规则）：光标显示方式**二选一，不能同时存在**。
    // 默认是跟随手指的黄点；想看到电脑上的真实光标形状，选「电脑真实光标」（不再自动切换）。
    if (window.__paExp && window.__paExp.want && window.__paExp.want.cursor) {
      const em = (function () { try { return localStorage.getItem('pa.exp.mode') === 'real' ? 'real' : 'dot'; } catch (e) { return 'dot'; } })();
      const mk = function (m, t1, t2) {
        const on = (em === m);
        return '<button class="expMode" data-m="' + m + '" style="flex:1;'
          + 'background:' + (on ? 'rgba(47,111,235,.22)' : '#242730') + ';color:' + (on ? '#8fb6ff' : '#c9ccd1') + ';'
          + 'border:1px solid ' + (on ? '#3f6fd0' : '#343842') + ';border-radius:9px;padding:9px 6px;'
          + 'font-size:12.5px;cursor:pointer;line-height:1.4">'
          + t1 + '<br><span style="font-size:11px;opacity:.72">' + t2 + '</span></button>';
      };
      h += '<div style="color:#868c96;font-size:12px;margin:12px 0 6px">光标显示</div>'
        + '<div style="display:flex;gap:8px" id="expModeRow">'
        + mk('dot', '跟随手指', '默认 · 黄点')
        + mk('real', '电脑真实光标', '显示电脑上的光标')
        + '</div>'
        + '<div style="color:#6b7079;font-size:11px;margin-top:6px">选「电脑真实光标」时，下面的形状/大小/颜色只对黄点生效</div>'
        + '<div id="expAutoRow" style="margin-top:9px;display:flex;gap:8px;align-items:center;font-size:12px;color:#aeb3bb">'
        + '<span id="expAutoBox" style="display:inline-flex;width:16px;height:16px;border-radius:4px;border:1px solid #3a3e4a;align-items:center;justify-content:center;font-size:12px;color:#8CE58C;cursor:pointer;background:' + ((function(){ try { return localStorage.getItem('pa.exp.mouseAuto') !== '0'; } catch(e){ return true; } })() ? 'rgba(140,229,140,.14)' : 'transparent') + '">' + ((function(){ try { return localStorage.getItem('pa.exp.mouseAuto') !== '0'; } catch(e){ return true; } })() ? '✓' : '') + '</span>'
        + '<span>接鼠标时自动切换到「电脑真实光标」</span></div>';
    }
    // 实验版 E2：高清放大增强（放大停手后把该区域的原生像素贴回来）。
    // 用户要求做成设置里的开关，而不是靠 URL 参数。
    if (window.__paExp && window.__paExp.want && (window.__paExp.want.ocr || window.__paExp.want.hires)) {
      // 必须和 expHiresOn() 用同一套判断（没设置过算开），否则 UI 高亮和实际状态打架
      const hi = (typeof expHiresOn === 'function') ? expHiresOn() : true;
      const hb = function (on, val, t1, t2) {
        return '<button class="expHires" data-v="' + val + '" style="flex:1;'
          + 'background:' + (on ? 'rgba(47,111,235,.22)' : '#242730') + ';color:' + (on ? '#8fb6ff' : '#c9ccd1') + ';'
          + 'border:1px solid ' + (on ? '#3f6fd0' : '#343842') + ';border-radius:9px;padding:9px 6px;'
          + 'font-size:12.5px;cursor:pointer;line-height:1.4">'
          + t1 + '<br><span style="font-size:11px;opacity:.72">' + t2 + '</span></button>';
      };
      h += '<div style="color:#868c96;font-size:12px;margin:12px 0 6px">高清放大增强</div>'
        + '<div style="display:flex;gap:8px" id="expHiresRow">'
        + hb(!hi, '0', '关闭', '正常视频画质')
        + hb(hi, '1', '开启', '放大后取原生像素')
        + '</div>'
        + '<div style="color:#6b7079;font-size:11px;margin-top:6px">开启后：画面放大到 1.25 倍以上并停手，会从电脑取这一块的原生像素贴回来（更清晰，但贴上去的是静态快照）。也可以直接点右上角那块状态牌强制取一次。</div>';
    }
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
    h += '</div>'
      + '<label style="display:inline-flex;align-items:center;gap:8px;font-size:11.5px;color:#aeb3bb;margin-top:8px">自定义颜色'
      + '<input type="color" id="p13nColorPick" value="' + P.toColorInput(curColor, '#ffd166') + '"'
      + ' style="width:44px;height:30px;border:1px solid #3a3e4a;border-radius:8px;background:#1b1d23;padding:1px"' + (licensed && curShape !== 'custom' ? '' : ' disabled') + '></label>';
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
    const licensed = true;   // 2026-11-06 免费化：个性化对所有人生效
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
        setMsg('', '#868c96');
      }));
      box.querySelectorAll('.p13nS').forEach((b) => b.addEventListener('click', () => {
        if (b.getAttribute('data-s') === 'dot') return;
        setMsg('', '#868c96');
      }));
      return;
    }
    box.querySelectorAll('.p13nT').forEach((b) => b.addEventListener('click', () => {
      const k = b.getAttribute('data-k');
      if (k === 'custom' && !P.loadCustom()) { setMsg('先在上面选个颜色（或用下面 JSON 导入），再选「自定义」', '#ffb454'); return; }
      P.saveTheme(k);
      P.applyTheme(k);
      markTheme(k);
      setMsg('已应用主题：' + P.themeByKey(k).name, '#8CE68C');
    }));
    // ---- 自定义配色（主题取色器，2026-10-31）----
    const themePick = box.querySelector('#p13nThemePick');
    if (themePick) {
      const applyFromPickers = () => {
        const j = { name: '我的主题' };
        themePick.querySelectorAll('.p13nTC').forEach((inp) => {
          const f = inp.getAttribute('data-f');
          if (f && P.isHex(inp.value)) j[f] = inp.value;
        });
        if (Object.keys(j).length <= 1) return;
        P.saveCustom(j);
        P.saveTheme('custom');
        P.applyTheme('custom');
        markTheme('custom');
        setMsg('已应用自定义配色（想换回预设主题点上面）', '#8CE68C');
      };
      themePick.querySelectorAll('.p13nTC').forEach((inp) => inp.addEventListener('input', applyFromPickers));
    }
    // ---- 光标形状（2026-10-29 新增）----
    const imgRow = box.querySelector('#p13nImgRow');
    const imgPick = box.querySelector('#p13nImgPick');
    const imgFile = box.querySelector('#p13nImgFile');
    const imgState = box.querySelector('#p13nImgState');
    const colorHint = box.querySelector('#p13nColorHint');
    const colorPick = box.querySelector('#p13nColorPick');
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
      if (colorPick) colorPick.disabled = !canColor;
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
      if (colorPick) colorPick.value = P.toColorInput(c, '#ffd166');
      syncPreview();
    }));
    // 光标自定义取色器（2026-10-31）：任意颜色，不再受 6 个预设色限制
    if (colorPick) colorPick.addEventListener('input', () => {
      const v = String(colorPick.value || '').trim();
      if (!P.isHex(v)) return;
      const c = curCursorCfg();
      c.color = v;
      P.saveCursor(c); P.applyCursor(c);
      const hit = P.DOT_COLORS.find((x) => x.toLowerCase() === v.toLowerCase());
      box.querySelectorAll('.p13nC').forEach((x) => {
        x.style.borderColor = (hit && x.getAttribute('data-c') === hit) ? '#8fb6ff' : 'rgba(255,255,255,.18)';
      });
      syncPreview();
      setMsg('光标颜色：' + v, '#8CE68C');
    });
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
      // 同步到取色器，方便继续微调
      if (themePick) themePick.querySelectorAll('.p13nTC').forEach((inp) => {
        const f = inp.getAttribute('data-f');
        if (f && P.isHex(j[f])) inp.value = P.toColorInput(j[f], inp.value);
      });
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
      return { label: '已授权', trial: true, color: '#8fb6ff', bg: 'rgba(143,182,255,.13)', border: 'rgba(143,182,255,.4)' };
    }
    return { label: '已授权', trial: false, color: '#8CE68C', bg: 'rgba(140,230,140,.13)', border: 'rgba(140,230,140,.4)' };
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
            + '这份许可证不会自动续费；到期后只是外观恢复默认，画面/触控/声音等全部功能照常免费。</div>'
          : '<div style="color:#868c96;font-size:12.5px;margin-top:6px;line-height:1.7">'
            + '超清画质不限时长 · 外观全开 · 同时观看不限台数</div>');
      // 已授权也保留粘贴入口（换许可证 / 续期要用），默认折叠不占地方
      h += '<details style="margin-top:12px;padding-top:10px;border-top:1px solid #23252c">'
        + '<summary style="cursor:pointer;color:#8fb6ff;font-size:13px">粘贴许可证（可选：换电脑 / 找回设置时用）</summary>'
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
        ? '许可证有效期内：外观全开 · 同时观看不限台数<br>'
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

  // ---- 防窥屏（privacy mode）页面侧 ------------------------------------------
  // 服务端负责真的盖住电脑本机屏幕；页面只负责开关、心跳（证明控制端还在）和换图。
  // 设备 id 存 localStorage：同一台手机刷新页面后仍是"第一个开的"那台，能自己关掉。
  // ---- 离线模式（没有互联网 / 没有 Tailscale）--------------------------------
  // 电脑开热点（Windows Mobile Hotspot）或手机开热点让电脑连；产品在局域网 IP 上监听（https），
  // 手机打开 https://<电脑IP>:<port>/?k=KEY。https 是安全上下文，WebRTC 可用、延迟最低。
  const HOTSPOT_SSID = 'PhoneAccess-Offline';
  const HOTSPOT_PASS = 'phoneaccess';
  function hsCfg() {
    let ssid = HOTSPOT_SSID, pass = HOTSPOT_PASS;
    try {
      ssid = localStorage.getItem('hs.ssid') || ssid;
      pass = localStorage.getItem('hs.pass') || pass;
    } catch (e) { }
    return { ssid: ssid, pass: pass };
  }
  function offlineBind(box) {
    const bodyEl = box.querySelector('#offBody');
    if (!bodyEl) return;
    let info = null;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const paint = (j) => {
      if (!j || !j.ok) { bodyEl.innerHTML = '<span style="color:#ffb454">读不到状态</span>'; return; }
      info = j;
      const on = !!j.offline;
      const hs = j.hotspot || {};
      let h = '<label style="display:flex;align-items:center;gap:8px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
        + '<input type="checkbox" id="offToggle" ' + (on ? 'checked' : '') + '> 开启局域网访问（会重启画面服务，约 10 秒；会弹一次管理员授权）</label>';
      if (on) {
        const firstIp = (j.ips && j.ips.length) ? j.ips[0] : null;
        const blockedPorts = (j.blockedPorts || []).map(Number);
        // 被旧防火墙规则挡住的端口排最后，二维码/首选地址用没被挡的那个
        const httpsPorts = [j.port, j.httpsPort2].filter((p) => Number(p) > 0);
        httpsPorts.sort((a, b) => ((blockedPorts.indexOf(a) >= 0 ? 1 : 0) - (blockedPorts.indexOf(b) >= 0 ? 1 : 0)));
        const firstPort = httpsPorts[0] || j.port;
        const firstUrl = firstIp ? ((j.https === false ? 'http://' : 'https://') + firstIp.ip + ':' + firstPort + '/?k=' + encodeURIComponent(KEY)) : '';
        h += '<div style="margin-top:12px;color:#e8eaee;font-size:12.5px">手机扫码或打开（同一 Wi-Fi / 热点）：</div>';
        if (!j.ips || !j.ips.length) {
          h += '<div style="color:#ffb454;font-size:12px;margin-top:4px">没检测到局域网 IP（先连上 Wi-Fi 或开热点；用 USB 共享网络也可以）</div>';
        } else {
          h += '<div style="display:flex;gap:14px;align-items:flex-start;margin-top:8px;flex-wrap:wrap">'
            + '<img id="offQr" src="/qr?d=' + encodeURIComponent(firstUrl) + '" width="150" height="150" alt="二维码" '
            + 'style="background:#fff;padding:6px;border-radius:10px;display:block">'
            + '<div style="flex:1;min-width:210px">';
          for (const it of j.ips) {
            for (const p of httpsPorts) {
              const isBlocked = blockedPorts.indexOf(p) >= 0;
              const url = (j.https === false ? 'http://' : 'https://') + it.ip + ':' + p + '/?k=' + encodeURIComponent(KEY);
              let tag = '';
              if (it.usb) tag += '<span style="background:#1d3a24;color:#8CE58C;border:1px solid #2f5f3a;border-radius:6px;padding:1px 6px;font-size:10.5px">USB 直连 · 最快</span>';
              if (p !== j.port) tag += '<span style="background:#20232b;color:#8fb6ff;border:1px solid #2a2f3a;border-radius:6px;padding:1px 6px;font-size:10.5px">备用端口 ' + p + '</span>';
              if (isBlocked) tag += '<span style="color:#ffb454;font-size:10.5px">被旧防火墙规则挡住，需点一次管理员授权修复</span>';
              if (!it.usb && !isBlocked) tag += '<span style="color:#6b7078;font-size:11px">' + esc(it.name) + '</span>';
              h += '<div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">'
                + '<code style="color:' + (isBlocked ? '#8a8f98' : '#8fb6ff') + ';font-size:12px">' + esc(url) + '</code>'
                + '<button class="offCopy" data-url="' + esc(url) + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;padding:4px 9px;font-size:11.5px;cursor:pointer">复制</button>'
                + tag + '</div>';
            }
          }
          h += '</div></div>';
          h += '<div style="color:#6b7078;font-size:11px;margin-top:6px">这台电脑是自签证书：手机第一次打开提示"不安全"，点「高级 → 继续前往」；'
            + '继续后 HUD 应显示「WebRTC264 直连」（才是低延迟通道）。</div>';
          if (firstIp && j.fallbackPort) {
            const fb = 'http://' + firstIp.ip + ':' + j.fallbackPort + '/?k=' + encodeURIComponent(KEY);
            h += '<div style="margin-top:6px;color:#6b7078;font-size:11px;line-height:1.7">打不开时用下面的备用地址（可能稍慢一点）：'
              + '<code style="color:#8fb6ff">' + esc(fb) + '</code> '
              + '<button class="offCopy" data-url="' + esc(fb) + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;padding:3px 8px;font-size:11px;cursor:pointer">复制</button>'
              + '<div style="display:flex;gap:10px;align-items:center;margin-top:8px">'
              + '<img id="offQr2" src="/qr?d=' + encodeURIComponent(fb) + '" width="96" height="96" alt="备用二维码" style="background:#fff;padding:4px;border-radius:8px;display:block">'
              + '<div style="color:#6b7078;font-size:11px;line-height:1.6">备用二维码（<b>http</b>，扫码直接用）<br>注意：<b>ip:8661 必须带 http://</b>，<br>Chrome 直接输地址会先试 https，就会报 ERR_SSL_PROTOCOL_ERROR。</div>'
              + '</div></div>';
          }
          h += '<div style="margin-top:10px;padding:10px 11px;border:1px solid #26405a;background:#101b26;border-radius:9px">'
            + '<div style="color:#8fb6ff;font-size:12.5px;font-weight:600">想让手机不再提示“不安全”（可选，设一次就好）</div>'
            + '<div style="color:#aeb3bb;font-size:11.5px;line-height:1.75;margin-top:6px">'
            + '① 手机先打开 <code style="color:#8fb6ff">http://' + esc(String(firstIp.ip)) + ':' + esc(String(j.fallbackPort)) + '/ca.crt</code> 下载证书<br>'
            + '② 设置 → 安全 → 加密与凭据 → 安装证书 → <b>CA 证书</b> → 选刚下载的文件 → 安装<br>'
            + '③ 重新打开上面的 https 地址：不再提示「不安全」，Chrome 里也能「安装应用」'
            + '</div>'
            + '<a href="/ca.crt" style="display:inline-block;margin-top:8px;background:#2f6feb;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;text-decoration:none">下载 CA 证书</a>'
            + '</div>';
          h += '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #24262d">'
            + '<button id="lanCheckBtn" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">检测局域网（手机连不上时点）</button>'
            + '<div id="lanCheckMsg" style="margin-top:6px;font-size:11.5px;color:#868c96;line-height:1.7"></div>'
            + '</div>';
        }
        const hsOn = hs.state === 'On';
        const hsClients = Number(hs.clients || 0) || 0;
        h += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #24262d">'
          + '<div style="color:#c9ccd1;font-size:12.5px">电脑热点：' + (hsOn ? ('已开启' + (hsClients > 0 ? '（已连 ' + hsClients + ' 台）' : '')) : (hs.capability === 'Enabled' ? '已关闭' : (hs.capability ? ('不可用（' + esc(hs.capability) + '）') : '未知'))) + '</div>'
          + '<div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">'
          + '<label style="font-size:12px;color:#aeb3bb">Wi-Fi 名 <input id="hsSsid" value="' + esc(hs.ssid || HOTSPOT_SSID) + '" style="width:150px;background:#0f1014;color:#e8eaee;border:1px solid #262932;border-radius:8px;padding:6px 9px;font-size:12px"></label>'
          + '<label style="font-size:12px;color:#aeb3bb">密码 <input id="hsPass" type="text" value="' + esc(HOTSPOT_PASS) + '" style="width:120px;background:#0f1014;color:#e8eaee;border:1px solid #262932;border-radius:8px;padding:6px 9px;font-size:12px"></label>'
          + '</div>'
          + '<div style="margin-top:6px;color:#6b7078;font-size:11px">手机连这个 Wi-Fi，然后打开上面的 https 地址（热点下电脑通常是 192.168.137.1）。</div>'
          + '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<button id="hsToggle" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:12.5px;cursor:pointer">' + (hsOn ? '关闭电脑热点' : '开启电脑热点') + '</button>'
          + '<span id="hsMsg" style="font-size:12px;color:#868c96"></span></div></div>';
        h += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #24262d">'
          + '<label style="display:flex;align-items:center;gap:8px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
          + '<input type="checkbox" id="off2560" ' + (lan264On() ? 'checked' : '') + '> 局域网自动 2560 超清（更清晰，流量更大）</label>'
          + '<div style="color:#6b7078;font-size:11px;margin-top:4px">没有 Wi-Fi 也可以：手机 USB 连电脑 → 打开手机「USB 网络共享」，页面会自动多出 USB 网段的地址。</div>'
          + '</div>';
      }
      bodyEl.innerHTML = h;
      const tog = bodyEl.querySelector('#offToggle');
      if (tog) tog.addEventListener('change', async () => {
        const want = tog.checked;
        tog.disabled = true;
        try { await fetch('/offline/' + (want ? 'on' : 'off'), { method: 'POST' }); } catch (e) { }
        bodyEl.innerHTML = '<span style="color:#8CE58C">已保存，正在重启画面服务（约 10 秒）。如果弹出管理员授权，请点「是」（放行局域网端口，手机才能连上）。</span>';
      });
      bodyEl.querySelectorAll('.offCopy').forEach((btn) => btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(btn.getAttribute('data-url')); btn.textContent = '已复制'; } catch (e) { }
      }));
      const hsBtn = bodyEl.querySelector('#hsToggle');
      if (hsBtn) hsBtn.addEventListener('click', async () => {
        const hsNow = (info && info.hotspot) || {};
        const wantOn = hsNow.state !== 'On';
        const ssidEl = bodyEl.querySelector('#hsSsid');
        const passEl = bodyEl.querySelector('#hsPass');
        const cfg = hsCfg();
        const ssid = (ssidEl && ssidEl.value.trim()) || cfg.ssid;
        const pass = (passEl && passEl.value.trim()) || cfg.pass;
        try { localStorage.setItem('hs.ssid', ssid); localStorage.setItem('hs.pass', pass); } catch (e) { }
        hsBtn.disabled = true;
        const msg = bodyEl.querySelector('#hsMsg');
        if (msg) msg.textContent = wantOn ? '正在开热点…' : '正在关热点…';
        try {
          const r = await fetch('/hotspot/' + (wantOn ? 'on' : 'off'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ssid: ssid, pass: pass }) }).then((x) => x.json());
          if (msg) msg.textContent = r && r.ok ? (wantOn ? '已开启，手机连 Wi-Fi「' + ssid + '」' : '已关闭') : ('失败：' + ((r && (r.error || (r.job && r.job.error))) || '未知'));
        } catch (e) {
          if (msg) msg.textContent = '失败：' + (e && e.message);
        }
        fetch('/offline-info?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then(paint).catch(() => { });
      });
      const cb2560 = bodyEl.querySelector('#off2560');
      if (cb2560) cb2560.addEventListener('change', async () => {
        try { localStorage.setItem('lan2560', cb2560.checked ? '1' : '0'); } catch (e) { }
        // 立刻把发送宽度切过去：勾上 2560、取消回 1920（只改本地开关不会动服务端）
        try {
          await fetch('/h264-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width: cb2560.checked ? 2560 : 1920 }) });
        } catch (e) { }
        try { if (state.mode === 'h264') restartH264(); } catch (e) { }
      });
      const qrImg = bodyEl.querySelector('#offQr');
      if (qrImg) qrImg.addEventListener('error', () => { qrImg.style.display = 'none'; });
      const qrImg2 = bodyEl.querySelector('#offQr2');
      if (qrImg2) qrImg2.addEventListener('error', () => { qrImg2.style.display = 'none'; });
      const lcBtn = bodyEl.querySelector('#lanCheckBtn');
      if (lcBtn) lcBtn.addEventListener('click', async () => {
        const box = bodyEl.querySelector('#lanCheckMsg');
        if (box) box.textContent = '检测中…';
        try {
          const j = await fetch('/lan-check?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
          if (box) {
            box.innerHTML = (j.checks || []).map((c) => '<div>' + (c.ok ? '✅ ' : '⚠️ ') + esc(c.name + '：' + c.text) + '</div>').join('')
              + '<div style="margin-top:6px;color:#6b7078">' + esc(j.hint || '') + '</div>';
          }
        } catch (e) { if (box) box.textContent = '检测失败：' + (e && e.message); }
      });
    };
    const refresh = () => fetch('/offline-info?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then(paint).catch(() => {
      bodyEl.innerHTML = '<span style="color:#ffb454">检测失败</span>';
    });
    refresh();
    // 网络切换后 IP 会变：开着这个面板时每 5 秒自动刷新一次地址（正在输入 SSID/密码时跳过，别把输入冲掉）
    if (window.__offTimer) { clearInterval(window.__offTimer); window.__offTimer = null; }
    window.__offTimer = setInterval(() => {
      try {
        const act = document.activeElement;
        if (act && act.closest && act.closest('#offBody')) return;
        refresh();
      } catch (e) { }
    }, 5000);
  }

  function privacyBind(box) {
    const tog = box.querySelector('#prvToggle');
    const msg = box.querySelector('#prvMsg');
    const pick = box.querySelector('#prvImgPick');
    const del = box.querySelector('#prvImgDel');
    const file = box.querySelector('#prvImgFile');
    const imgMsg = box.querySelector('#prvImgMsg');
    const lockCb = box.querySelector('#prvLock');
    let lockOn = true;
    try { lockOn = localStorage.getItem('prv.lock') !== '0'; } catch (e) { }
    if (lockCb) lockCb.checked = lockOn;
    let dev = '';
    try {
      dev = localStorage.getItem('pa-dev') || '';
      if (!dev) { dev = Math.random().toString(36).slice(2, 12); localStorage.setItem('pa-dev', dev); }
    } catch (e) { dev = SID; }
    const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || '#868c96'; } };
    let beatTimer = null;
    const stopBeat = () => { if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } };
    // 2026-11-06 修复（防窥屏自己关掉 / 状态不同步）：
    //   ① 立即发一次心跳：原来启动后要等 20 秒才发第一条，服务端 120 秒收不到心跳就自动解除，
    //      刚开的那 20 秒是"裸奔"窗口，手机一旦切后台就容易被判超时。
    //   ② 间隔 20s → 10s：手机浏览器切到后台会把定时器节流到约 1 次/分钟，20 秒的定时器常被拖到 60s+，
    //      再碰上网络抖动就超过 120 秒，服务端会以为控制端掉线而自动解除。
    //   ③ 幂等：定时器已在跑就不重建。原来 paint() 每次刷新都会 startBeat()，把定时器反复清零，
    //      心跳可能永远发不出去（表现就是"防窥屏开一会儿自己关了"）。
    const beatOnce = async () => {
      try {
        const r = await fetch('/privacy/beat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: dev }) });
        const st = await r.json();
        if (!st || !st.active) stopBeat();
      } catch (e) { }
    };
    const startBeat = () => {
      if (beatTimer) return;
      beatOnce();
      beatTimer = setInterval(beatOnce, 10000);
    };
    const paint = (st) => {
      const active = !!(st && st.active);
      const mine = active && st.owner === dev;
      if (tog) {
        tog.textContent = active ? (mine ? '关闭防窥屏' : '已由其它设备开启') : '开启防窥屏';
        tog.style.background = active ? '#7a2f2f' : '#2a2d36';
        tog.disabled = active && !mine;
      }
      if (imgMsg) imgMsg.textContent = st && st.hasImage ? '当前：自定义图' : '当前：纯黑';
      if (lockCb && active && mine) lockCb.checked = st.lockInput !== false;
      if (mine) { setMsg('已开启（电脑本机已遮住' + (st && st.lockInput ? '，键盘鼠标已锁' : (st && st.hotkeys ? '，仅拦快捷键' : '')) + '）', '#8CE58C'); startBeat(); }
      else if (active) setMsg('另一台设备已开启（以先开的为准）', '#ffb454');
      else setMsg('');
      try { window.__prvActive = active; window.__prvMine = mine; } catch (e) { }
    };
    const refresh = () => fetch('/privacy/status', { cache: 'no-store' }).then((r) => r.json()).then(paint).catch(() => { });
    const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
    if (tog) tog.addEventListener('click', async () => {
      tog.disabled = true;
      try {
        if (window.__prvMine) { await post('/privacy/off', { sid: dev }); stopBeat(); }
        else { const r = await post('/privacy/on', { sid: dev, lock: lockOn }); if (r && r.ok && r.owner) startBeat(); }
        await refresh();
      } catch (e) { setMsg('操作失败：' + (e && e.message), '#ff9d9d'); }
      tog.disabled = false;
    });
    // 「锁住电脑前的键盘和鼠标」：默认开；开着的时候改选项 → 重启一次遮罩让它生效
    if (lockCb) lockCb.addEventListener('change', async () => {
      lockOn = !!lockCb.checked;
      try { localStorage.setItem('prv.lock', lockOn ? '1' : '0'); } catch (e) { }
      if (window.__prvMine) {
        try {
          setMsg('正在应用新设置…');
          await post('/privacy/off', { sid: dev });
          stopBeat();
          await new Promise(function (r) { setTimeout(r, 1200); });
          await post('/privacy/on', { sid: dev, lock: lockOn });
          startBeat();
          await refresh();
        } catch (e) { setMsg('应用失败：' + (e && e.message), '#ff9d9d'); }
      } else {
        setMsg(lockOn ? '下次开启时会锁住键盘和鼠标' : '下次开启只拦快捷键');
      }
    });
    if (pick && file) pick.addEventListener('click', () => file.click());
    if (file) file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { imgMsg.textContent = '图片太大（上限 5MB）'; return; }
      imgMsg.textContent = '上传中…';
      try {
        const buf = await f.arrayBuffer();
        const r = await fetch('/privacy/image', { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: buf });
        const j = await r.json();
        imgMsg.textContent = j && j.ok ? '已更新锁屏图' : ('失败：' + ((j && j.error) || ''));
        refresh();
      } catch (e) { imgMsg.textContent = '上传失败'; }
      try { file.value = ''; } catch (e) { }
    });
    if (del) del.addEventListener('click', async () => {
      try {
        const j = await (await fetch('/privacy/image', { method: 'DELETE' })).json();
        imgMsg.textContent = j && j.ok ? '已恢复纯黑' : '失败';
        refresh();
      } catch (e) { imgMsg.textContent = '失败'; }
    });
    refresh();
    // 2026-11-06：面板开着时每 5 秒对一次状态。原来只刷新一次，
    // 服务端因心跳超时自动解除、或被别的设备接管后，页面还显示"已开启"，用户以为还遮着（其实是安全问题）。
    if (window.__prvPoll) { clearInterval(window.__prvPoll); window.__prvPoll = null; }
    window.__prvPoll = setInterval(() => {
      try {
        if (!document.getElementById('prvToggle')) { clearInterval(window.__prvPoll); window.__prvPoll = null; return; }
        refresh();
      } catch (e) { }
    }, 5000);
    // 手机从后台回到前台：立刻补一次心跳，别等服务端 120 秒超时
    if (!window.__prvVisHooked) {
      window.__prvVisHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try { if (window.__prvMine) { fetch('/privacy/beat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: dev }) }).catch(() => { }); } } catch (e) { }
      });
    }
  }

  // ---- 定时开关机（2026-11-07，内置到产品）----------------------------------
  // 规则存服务端 power-schedule.json，真正的计划任务由 power-apply.ps1 创建。
  // 能定时"休眠 + 唤醒"（= 可定时开机）；完全关机（S5）之后软件叫不醒，只能 BIOS RTC / WOL。
  let pwCache = { rules: [], enabled: false };
  function powerInner() {
    return '<div id="pwWrap"><div style="color:#868c96;font-size:12.5px">正在读取…</div></div>';
  }
  function esc2(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pwRepeatText(r) {
    if (r.repeat === 'weekdays') return '工作日';
    if (r.repeat === 'once') return '仅一次' + (r.date ? '（' + r.date + '）' : '');
    return '每天';
  }
  function pwRuleText(r) {
    const mode = r.mode === 'shutdown' ? '关机' : '休眠';
    let t = pwRepeatText(r) + ' ' + esc2(r.offTime) + ' ' + mode;
    if (r.wakeTime) t += ' → 唤醒 ' + esc2(r.wakeTime);
    return t;
  }
  function powerRowsHtml(st) {
    const rules = (st && Array.isArray(st.rules)) ? st.rules : [];
    const tasks = (st && Array.isArray(st.tasks)) ? st.tasks : [];
    const last = (st && st.last) || null;
    const on = !!(st && st.enabled);
    const busy = !!(st && st.busy);
    const taskOf = (id) => {
      const off = tasks.filter((t) => t.name === '轻屏-电源-' + id)[0];
      const wk = tasks.filter((t) => t.name === '轻屏-电源-' + id + '-唤醒')[0];
      return { off: off, wake: wk };
    };
    let h = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<button id="pwToggle" style="background:' + (on ? '#7a2f2f' : '#2a6b3a') + ';color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer">' + (on ? '暂停所有定时' : '启用定时开关机') + '</button>'
      + '<span style="font-size:12.5px;color:' + (on ? '#8CE58C' : '#868c96') + '">' + (on ? '已启用 · ' + rules.length + ' 条规则' : '当前未启用') + '</span>'
      + '<span style="flex:1"></span>'
      + '<button id="pwClear" style="background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">全部清除</button>'
      + '</div>';

    // 快捷预设
    h += '<div style="color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em;margin-bottom:6px">快速添加</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">'
      + '<button class="pwPre" data-pre="work" style="background:#242730;color:#c9ccd1;border:1px solid #343842;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">工作日 23:30 睡 · 07:00 醒</button>'
      + '<button class="pwPre" data-pre="every" style="background:#242730;color:#c9ccd1;border:1px solid #343842;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">每天 23:00 睡 · 07:30 醒</button>'
      + '<button class="pwPre" data-pre="sleep1h" style="background:#242730;color:#c9ccd1;border:1px solid #343842;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">一小时后休眠</button>'
      + '<button class="pwPre" data-pre="off1h" style="background:#242730;color:#c9ccd1;border:1px solid #343842;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">一小时后关机</button>'
      + '</div>';

    if (!rules.length) {
      h += '<div style="color:#6b7078;font-size:12.5px;margin-bottom:10px">还没有规则。点上面的快捷按钮，或自己在下面加一条。</div>';
    } else {
      rules.forEach((r, i) => {
        const tk = taskOf(r.id);
        const nextTxt = tk.off && tk.off.next ? (' · 下次 ' + esc2(tk.off.next)) : '';
        h += '<div style="display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #202228;font-size:13px">'
          + '<span style="flex:1;min-width:0;color:#c9ccd1">' + pwRuleText(r)
          + (r.mode === 'shutdown' && r.wakeTime ? ' <span style="color:#ff6b6b;font-weight:700">（关机后叫不醒）</span>' : '')
          + '<span style="color:#6b7078;font-size:11.5px">' + nextTxt + '</span></span>'
          + '<button data-pwdel="' + i + '" style="background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:12px;cursor:pointer">删除</button></div>';
      });
    }

    if (tasks.length) {
      h += '<div style="margin-top:10px;color:#6b7078;font-size:11.5px;line-height:1.7">系统里的计划任务：'
        + tasks.map((t) => esc2(t.name.replace('轻屏-电源-', '')) + '（' + esc2(t.state) + (t.next ? ' · 下次 ' + esc2(t.next) : '') + (t.wake ? ' · 可唤醒' : '') + '）').join('，')
        + '</div>';
    }

    // 状态：休眠支持 / 唤醒定时器 / 上次应用结果
    const lt = (last && last.wakeTimer) || {};
    const hi = last ? (last.hibernate ? '支持' : '不支持') : '未检测';
    const acTxt = lt.ac === 'on' ? '已开' : (lt.ac === 'off' ? '未开' : '未知');
    const dcTxt = lt.dc === 'on' ? '已开' : (lt.dc === 'off' ? '未开' : '未知');
    h += '<div style="margin-top:12px;padding:9px 10px;background:#181a20;border:1px solid #23252c;border-radius:9px;font-size:11.5px;color:#aeb3bb;line-height:1.85">'
      + '休眠：<b style="color:' + (hi === '支持' ? '#8CE58C' : (hi === '不支持' ? '#ff6b6b' : '#c9ccd1')) + '">' + hi + '</b>'
      + ' · 唤醒定时器（交流/电池）：<b style="color:' + (acTxt === '已开' ? '#8CE58C' : '#ffb454') + '">' + acTxt + '</b> / <b style="color:' + (dcTxt === '已开' ? '#8CE58C' : '#ffb454') + '">' + dcTxt + '</b>'
      + (last && last.at ? '<br>上次应用：' + esc2(last.at) + (last.ok ? ' · 成功' : ' · 有错误') : '')
      + '</div>';
    if (last && Array.isArray(last.errors) && last.errors.length) {
      h += '<div style="margin-top:8px;color:#ff6b6b;font-size:12px;line-height:1.8">' + last.errors.map((x) => '· ' + esc2(x)).join('<br>') + '</div>';
    }
    if (last && Array.isArray(last.warnings) && last.warnings.length) {
      h += '<div style="margin-top:8px;color:#ffb454;font-size:12px;line-height:1.8">' + last.warnings.map((x) => '· ' + esc2(x)).join('<br>') + '</div>';
    }

    // 编辑器
    h += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #23252c">'
      + '<div style="color:#aeb3bb;font-size:12.5px;margin-bottom:8px">加一条规则</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px">'
      + '<label style="color:#868c96">休眠/关机 <input id="pwOff" type="time" value="23:00" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"></label>'
      + '<label style="color:#868c96">唤醒 <input id="pwWake" type="time" value="07:30" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"></label>'
      + '<select id="pwRepeat" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"><option value="daily">每天</option><option value="weekdays">工作日</option><option value="once">仅一次</option></select>'
      + '<input id="pwDate" type="date" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px">'
      + '<select id="pwMode" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"><option value="hibernate">休眠（可定时开机）</option><option value="shutdown">关机</option></select>'
      + '<button id="pwAdd" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer">加入</button>'
      + '<button id="pwApply" style="background:#2f6b3a;color:#e8eaee;border:0;border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer">保存并应用</button>'
      + '</div>'
      + '<div id="pwWarn" style="display:none;color:#ff6b6b;font-size:12px;font-weight:700;margin-top:8px;line-height:1.7">⚠ 你选了「关机」又填了唤醒时间：完全关机之后软件叫不醒电脑，这次唤醒不会生效。想要定时开机，请把方式改成「休眠」。</div>'
      + '<div id="pwMsg" style="color:#868c96;font-size:11.5px;margin-top:8px;line-height:1.7">' + (busy ? '<span style="color:#ffb454">正在应用，请稍候…</span>' : '') + '</div>'
      + '<div style="color:#6b7078;font-size:11.5px;margin-top:6px;line-height:1.7">休眠可以被定时叫醒（醒来回到原界面）；完全关机后叫不醒，只能靠主板 BIOS 定时开机或网络唤醒。</div>'
      + '</div>';
    return h;
  }
  function powerBind(box) {
    const wrap = box.querySelector('#pwWrap');
    if (!wrap) return;
    let pwCache = { enabled: false, rules: [] };
    let pollTimer = 0;
    const msg = (t, c) => { const m = box.querySelector('#pwMsg'); if (m) { m.innerHTML = esc2(t); m.style.color = c || '#868c96'; } };
    const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } };
    const paint = (st) => {
      pwCache = { enabled: !!(st && st.enabled), rules: (st && Array.isArray(st.rules)) ? st.rules : [] };
      wrap.innerHTML = powerRowsHtml(st);
      const wireWarn = () => {
        const m = wrap.querySelector('#pwMode');
        const t = wrap.querySelector('#pwWake');
        const w = wrap.querySelector('#pwWarn');
        const sync = function () {
          if (!w) return;
          const okTime = t && /^([01]?d|2[0-3]):[0-5]d$/.test(String(t.value || '').trim());
          w.style.display = (m && m.value === 'shutdown' && okTime) ? 'block' : 'none';
        };
        if (m) m.addEventListener('change', sync);
        if (t) t.addEventListener('input', sync);
        sync();
      };
      wireWarn();

      const tg = wrap.querySelector('#pwToggle');
      if (tg) tg.addEventListener('click', () => post({ enabled: !pwCache.enabled, rules: pwCache.rules }));
      const cl = wrap.querySelector('#pwClear');
      if (cl) cl.addEventListener('click', () => {
        if (!confirm('清除所有定时规则（会删掉系统里的计划任务）？')) return;
        post({ enabled: false, rules: [] });
      });
      wrap.querySelectorAll('[data-pwdel]').forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-pwdel'));
        const rules = pwCache.rules.slice();
        rules.splice(i, 1);
        post({ enabled: pwCache.enabled, rules: rules });
      }));
      wrap.querySelectorAll('.pwPre').forEach((btn) => btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-pre');
        const now = new Date();
        const hh = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        let rules = pwCache.rules.slice();
        if (kind === 'work') rules.push({ id: 'p' + Date.now().toString(36), mode: 'hibernate', repeat: 'weekdays', offTime: '23:30', wakeTime: '07:00', date: '' });
        if (kind === 'every') rules.push({ id: 'p' + Date.now().toString(36), mode: 'hibernate', repeat: 'daily', offTime: '23:00', wakeTime: '07:30', date: '' });
        if (kind === 'sleep1h' || kind === 'off1h') {
          const t = new Date(now.getTime() + 60 * 60 * 1000);
          rules.push({ id: 'p' + Date.now().toString(36), mode: kind === 'off1h' ? 'shutdown' : 'hibernate', repeat: 'once', date: t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'), offTime: hh(t), wakeTime: '' });
        }
        post({ enabled: true, rules: rules });
      }));
      const add = wrap.querySelector('#pwAdd');
      if (add) add.addEventListener('click', () => {
        const off = String((wrap.querySelector('#pwOff') || {}).value || '').trim();
        const wake = String((wrap.querySelector('#pwWake') || {}).value || '').trim();
        const repeat = (wrap.querySelector('#pwRepeat') || {}).value || 'daily';
        const date = String((wrap.querySelector('#pwDate') || {}).value || '').trim();
        const mode = (wrap.querySelector('#pwMode') || {}).value || 'hibernate';
        const okT = (t) => /^([01]?d|2[0-3]):[0-5]d$/.test(t);
        if (!okT(off)) { msg('休眠/关机时间要写成 HH:mm，例如 23:00', '#ffb454'); return; }
        if (wake && !okT(wake)) { msg('唤醒时间要写成 HH:mm，例如 07:00', '#ffb454'); return; }
        if (wake && wake === off) { msg('唤醒时间和关机时间不能一样', '#ffb454'); return; }
        if (repeat === 'once') {
          if (!date) { msg('选「仅一次」时要选日期', '#ffb454'); return; }
          const when = new Date(date + 'T' + (off.length === 4 ? '0' + off : off) + ':00');
          if (isNaN(when.getTime()) || when.getTime() <= Date.now()) { msg('这个日期时间已经过去了，换一个', '#ffb454'); return; }
        }
        const rules = pwCache.rules.concat([{ id: 'r' + Date.now().toString(36), offTime: off, wakeTime: wake, repeat: repeat, date: repeat === 'once' ? date : '', mode: mode }]);
        post({ enabled: true, rules: rules });
      });
      const ap = wrap.querySelector('#pwApply');
      if (ap) ap.addEventListener('click', () => post({ enabled: pwCache.enabled, rules: pwCache.rules }));
    };
    const post = async (doc) => {
      msg('正在应用到系统（会创建/更新计划任务，约 5-15 秒）…');
      stopPoll();
      try {
        const r = await fetch('/power/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }).then((x) => x.json());
        if (r && r.ok) {
          msg((r.note || '已提交') + (r.busy ? ' · 正在应用' : ''));
          let n = 0;
          pollTimer = setInterval(async () => {
            n++;
            const st = await fetch('/power/status?_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
            if (st) paint(st);
            if (!st || !st.busy || n > 12) {
              stopPoll();
              if (st && st.last) {
                const errs = (st.last.errors || []).length, warns = (st.last.warnings || []).length;
                msg('已应用' + (errs ? ('，有 ' + errs + ' 个错误') : '') + (warns ? ('，' + warns + ' 条提醒') : ''), errs ? '#ff6b6b' : (warns ? '#ffb454' : '#8CE58C'));
              }
            }
          }, 2000);
        } else {
          msg('应用失败：' + ((r && r.error) || '未知错误'), (r && r.busy) ? '#ffb454' : '#ff6b6b');
        }
      } catch (e) { msg('请求失败：' + ((e && e.message) || e), '#ff9d9d'); }
      await load();
    };
    const load = async () => {
      try {
        const st = await fetch('/power/status?_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json());
        paint(st);
        if (st && st.busy) {
          stopPoll();
          let n = 0;
          pollTimer = setInterval(async () => {
            n++;
            const s2 = await fetch('/power/status?_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
            if (s2) paint(s2);
            if (!s2 || !s2.busy || n > 12) stopPoll();
          }, 2000);
        }
      } catch (e) { wrap.innerHTML = '<div style="color:#ffb454;font-size:12.5px">读取失败（服务可能正在重启）</div>'; }
    };
    load();
  }

  function openSettings(lic) {
    const ver = String(lic.version || '—');
    let body = '';
    const uq = lic.ultraQuota || null;   // 画面质量分区也要用（超清配额提示）
    body += setSection('许可证（可选）', licenceInner(lic));

    // 机器码（可复制）
    body += setSection('这台电脑的机器码',
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
    // 状态数值开关（原来靠 MutationObserver 往高清串流里注入，藏得太深不好找；
    // 2026-11-05 用户反馈「关掉数据显示的选项不见了」，改成这一节里的固定勾选）
    connInner += '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
      + '<input type="checkbox" id="hudToggle"> 显示帧率/分辨率等状态数值</label>';
    body += setSection('连接与画面', connInner);

    // 连接体检（Tailscale）——2026-11-03 A1/A3：装没装、登没登、在不在线、手机是直连还是中继。
    // 客户最大的门槛就是这一步；数据来自服务端 /tailscale-status（只读，不透传节点公钥）。
    body += setSection('网络连接体检',
      '<div id="tsBody" style="color:#868c96;font-size:12.5px;line-height:1.7">正在检测…</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">'
      + '<button id="tsRefresh" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:8px 13px;font-size:12.5px;cursor:pointer">重新检测</button>'
      + '<span id="tsMsg" style="font-size:12px;color:#868c96"></span></div>'
      + '<div style="color:#5c6169;font-size:11px;margin-top:8px;line-height:1.6">'
      + '「直连」= 点对点，最快；「中继」= 经 Tailscale 的 DERP 中转，能用在但慢一些。'
      + '手机和电脑必须登录同一个 Tailscale 账号。</div>');

    // 文本剪贴板（2026-11-03，A5 第一步）：手机 ↔ 电脑 传一段文字。
    body += setSection('剪贴板（手机 ↔ 电脑）',
      '<div style="color:#868c96;font-size:12px;margin-bottom:8px">'
      + '把手机上的文字发到电脑，或在手机上读取电脑剪贴板（验证码、链接、命令最常用）。</div>'
      + '<textarea id="cbText" placeholder="在这里输入或粘贴文字…" style="width:100%;min-height:86px;box-sizing:border-box;'
      + 'background:#0f1014;color:#e8eaee;border:1px solid #262932;border-radius:9px;padding:9px 11px;'
      + 'font:13px/1.5 ui-monospace,Consolas,monospace;resize:vertical"></textarea>'
      + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">'
      + '<button id="cbRead" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:8px 13px;font-size:12.5px;cursor:pointer">读取电脑剪贴板</button>'
      + '<button id="cbSend" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
      + 'padding:8px 15px;font-size:12.5px;cursor:pointer">发送到电脑</button>'
      + '<span id="cbMsg" style="font-size:12px;color:#868c96"></span></div>'
      + '<div style="color:#5c6169;font-size:11px;margin-top:8px;line-height:1.6">'
      + '上限 64KB；写入后电脑上 Ctrl+V 就能用。剪贴板内容会经过你自己的 Tailscale 网络，不经过第三方。</div>');

    // 大文件传输（2026-11-06）：局域网/离线模式下手机↔电脑直传，速度就是 Wi-Fi 上限。
    body += setSection('传文件（手机 ↔ 电脑）',
      '<div style="color:#868c96;font-size:12px;margin-bottom:8px">'
      + '不经过任何服务器、只走局域网：<b>4 路并发 + 断点续传</b>，速度能吃到 Wi-Fi 上限（Wi-Fi 6 常见 80–120 MB/s）。单个文件上限 20GB。</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
      + '<input id="filePick" type="file" multiple style="flex:1;min-width:170px;color:#c9ccd1;font-size:12.5px">'
      + '<button id="fileSend" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
      + 'padding:8px 15px;font-size:12.5px;cursor:pointer">发送到电脑</button>'
      + '<button id="fileCancel" style="display:none;background:#3a2225;color:#ffb4b4;border:1px solid #5a2e33;border-radius:9px;'
      + 'padding:8px 13px;font-size:12.5px;cursor:pointer">取消</button>'
      + '<span id="fileMsg" style="font-size:12px;color:#868c96"></span></div>'
      + '<div id="fileResume"></div>'
      + '<div id="fileProgWrap" style="display:none;margin-top:9px">'
      + '<div style="height:7px;background:#0f1014;border:1px solid #262932;border-radius:5px;overflow:hidden">'
      + '<div id="fileBar" style="height:100%;width:0;background:#8CE68C;transition:width .15s"></div></div>'
      + '<div id="fileProg" style="color:#868c96;margin-top:6px;font-size:11.5px"></div></div>'
      + '<div style="margin-top:14px;color:#c9ccd1;font-size:12.5px;font-weight:600">电脑上的文件（点「下载」存到手机）</div>'
      + '<div id="pcList" style="margin-top:7px;color:#868c96;font-size:12px">正在读取…</div>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:6px">列表只显示最近 5 个；全部文件在电脑的「下载\\PhoneAccess」文件夹里。</div>'
      + '<div style="margin-top:14px;color:#c9ccd1;font-size:12.5px;font-weight:600">手机传到电脑的文件（存在「下载\\PhoneAccess」）</div>'
      + '<div id="fileList" style="margin-top:7px;color:#868c96;font-size:12px">正在读取…</div>');

    // 高性能模式（Sunshine/Moonlight）——2026-11-03 S3：电脑装好 Sunshine 后，手机装 Moonlight 用 PIN 配对。
    body += setSection('串流玩游戏（Moonlight）',
      '<div id="secSunshine"></div>'
      + '<div id="ssBody" style="color:#868c96;font-size:12.5px;line-height:1.7">正在检测…</div>'
      + '<div id="ssAddr" style="margin-top:10px"></div>'
      + '<div id="ssGames" style="margin-top:12px"></div>'
      + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">'
      + '<button id="ssRefresh" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:8px 13px;font-size:12.5px;cursor:pointer">刷新</button>'
      + '<span id="ssMsg" style="font-size:12px;color:#868c96"></span></div>'
      + '<div style="color:#5c6169;font-size:11px;margin-top:8px;line-height:1.6">'
      + '低延迟/高帧率通道：手机装 Moonlight 后，在 Moonlight 里添加这台电脑，PIN 在这里输入完成配对。'
      + '装不了 Moonlight 也没关系，网页模式（就是现在这个）一直可用。</div>');

    // 画面质量三档按钮（paQ / #setQMsg）已随 MJPEG 退役删除（2026-11-06 体检）：
    // 清晰度现在只由下面「高清串流（H.264）」的分辨率/帧率/码率控制，
    // 旧代码把整段 HTML 拼好后直接 void 丢掉，按钮和事件都不会存在。
    // 服务端 /set-quality 保留，兼容手机上缓存着的旧页面。

    // 高清串流（H.264）手动设置：分辨率/帧率/码率
    body += setSection('画质与流量',
      '<div style="display:flex;gap:14px;flex-wrap:wrap;color:#c9ccd1;font-size:12.5px;align-items:center">'
      + '<label>分辨率 <select id="hqW" class="paSel"><option value="1280">1280</option><option value="1600">1600</option><option value="1920">1920</option><option value="2560">2560（原生·需设备支持）</option></select></label>'
      + '<label>帧率 <select id="hqFps" class="paSel"><option value="30">30</option><option value="60">60</option></select></label>'
      + '<label>码率 <select id="hqKbps" class="paSel"><option value="8000">8 Mbps（≈3.4 GB/时）</option><option value="12000">12 Mbps（≈5.3 GB/时）</option><option value="15000">15 Mbps（≈6.7 GB/时）</option><option value="20000">20 Mbps（≈8.9 GB/时）</option><option value="30000">30 Mbps（≈13.4 GB/时）</option></select></label>'
      + '<button id="hqAuto" title="按网络自动调码率：丢包就降、稳定再升" style="background:#2a2d36;color:#c9ccd1;border:1px solid #3a3e4a;border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer">自动</button>'
      + '</div>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:8px">流量只由码率决定：1 Mbps ≈ 0.45 GB/时；分辨率/帧率改的是清晰度和流畅度，几乎不加减流量。'
      + '手机流量紧张选 8 Mbps；同网可 60fps，跨网建议 30fps。实测 20 Mbps 约 19.8、12 约 11.8、8 约 7.5–8 Mbps。</div>'
      + '<div id="hqFlow" style="font-size:12.5px;color:#8CE58C;margin-top:8px"></div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
      + '<input type="checkbox" id="hqQf"> 画质优先（文字更锐；延迟约 +1 帧，流量会波动）</label>'
      + '<label style="display:flex;align-items:center;gap:8px;margin-top:8px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
      + '<input type="checkbox" id="hqWin"> 单窗口采集（实验：只传选中的窗口，被挡住也能抓；约 10–30fps）</label>'
      + '<div id="hqMsg" style="font-size:12.5px;color:#868c96;margin-top:8px"></div>');

    // 个性化（许可证功能；未授权显示锁定说明与购买入口）
    body += setSection('外观（主题 / 光标）', p13nInner(lic));

    // 防窥屏（privacy mode）：盖住电脑本机屏幕，手机端不受影响
    body += setSection('防窥屏',
      '<div style="color:#aeb3bb;font-size:12.5px;line-height:1.75">'
      + '开启后，电脑本机会被一层锁屏图盖住：屏幕前的人看不到桌面、鼠标点不动；'
      + '<b>你手机上的画面和控制不受影响</b>。<br>'
      + '别的设备再开启不会抢（以先开的为准）；你关掉或断开后自动解除。最长 8 小时自动解除，防止把电脑锁死。'
      + '</div>'
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">'
      + '<button id="prvToggle" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:9px 15px;font-size:13px;cursor:pointer">开启防窥屏</button>'
      + '<span id="prvMsg" style="font-size:12.5px;color:#868c96;flex:1;min-width:150px"></span>'
      + '</div>'
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">'
      + '<button id="prvImgPick" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:7px 12px;font-size:12.5px;cursor:pointer">自定义锁屏图…</button>'
      + '<button id="prvImgDel" style="background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:7px 12px;font-size:12.5px;cursor:pointer">恢复纯黑</button>'
      + '<input type="file" id="prvImgFile" accept="image/png,image/jpeg,image/webp" style="display:none">'
      + '<span id="prvImgMsg" style="font-size:12px;color:#6b7078"></span>'
      + '</div>'
      + '<label style="display:flex;gap:8px;align-items:center;margin-top:10px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
      + '<input type="checkbox" id="prvLock" checked> 同时锁住电脑前的键盘和鼠标（更彻底，推荐）</label>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:4px">关掉则只拦 Win/Alt+Tab 这类能绕过遮罩的快捷键；手机上的操作始终不受影响。</div>');

    // 离线模式（没有互联网 / 没有 Tailscale）：局域网访问 + 电脑热点 + USB 网络共享
    body += setSection('定时开关机（这台电脑）', powerInner());
    body += setSection('没有网络时（离线模式）',
      '<div id="offBody" style="color:#868c96;font-size:12.5px;line-height:1.7">正在检测…</div>'
      + '<div style="color:#5c6169;font-size:11px;margin-top:8px;line-height:1.6">'
      + '没有互联网、也没装 Tailscale 时：电脑开热点（或手机开热点让电脑连），手机连上同一个网络后打开这里的地址。'
      + '局域网/热点现在用 https（电脑自签证书）：手机第一次打开会提示"不安全"，点「继续/高级→继续」即可。'
      + '这样才是安全上下文，WebRTC 能用、延迟最低（http 下会自动退回 WS 通道，延迟更高）。'
      + '<br><b style="color:#8fb6ff">USB 直连最快</b>（传大文件首选）：手机用数据线连电脑 → 手机设置里打开「USB 网络共享」→ '
      + '几秒后这里会多出一个标记 USB 的地址，走 USB 带宽（通常 200–400 MB/s），比 Wi-Fi/热点快得多。'
      + '<br>开启/关闭离线模式时会弹一次管理员授权（放行局域网端口），点「是」即可。</div>');

    // 诊断导出（给卖家排查：编码参数 + 链路状态 + 最近日志，访问密钥已打码）
    body += setSection('出问题时导出诊断',
      '<div style="color:#aeb3bb;font-size:12.5px;line-height:1.75">画面、声音或连接出问题时，点一下生成一份报告发给作者，就能帮你排查。报告里不会有你的密码。</div>'
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">'
      + '<button id="diagBtn" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;'
      + 'padding:9px 14px;font-size:13px;cursor:pointer">导出诊断报告</button>'
      + '<span id="diagMsg" style="font-size:12.5px;color:#868c96"></span></div>');


    // 版本与更新
    body += setSection('版本与更新',
      setKv('当前版本', '<span style="color:#aeb3bb">' + escHtml(ver) + '</span>')
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:11px;flex-wrap:wrap">'
      + '<button id="setCheckUpd" style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
      + 'padding:9px 15px;font-size:13px;cursor:pointer">检查更新</button>'
      + '<span id="setUpdMsg" style="font-size:12.5px;color:#868c96;flex:1;min-width:120px"></span>'
      + '</div>'
      + '<div id="setUpdBox" style="display:none;margin-top:10px;padding:10px 12px;border-radius:9px;'
      + 'background:#0f1014;border:1px solid #262932;font-size:12.5px;color:#c9ccd1"></div>'
      + installAltHtml(lic));

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
    privacyBind(box);
    powerBind(box);
    offlineBind(box);
    // 状态数值开关（与 HUD 共用 localStorage 'hudvis'）
    const hudT = box.querySelector('#hudToggle');
    if (hudT) {
      try { hudT.checked = localStorage.getItem('hudvis') !== '0'; } catch (e) { }
      hudT.addEventListener('change', () => {
        try { localStorage.setItem('hudvis', hudT.checked ? '1' : '0'); } catch (e) { }
        try { if (window.__paHudVis) window.__paHudVis.apply(); } catch (e) { }
      });
    }
    // 诊断导出
    const diagBtn = box.querySelector('#diagBtn');
    if (diagBtn) diagBtn.addEventListener('click', async () => {
      const dm = box.querySelector('#diagMsg');
      diagBtn.disabled = true;
      try {
        const r = await fetch('/diagnose?k=' + encodeURIComponent(KEY), { cache: 'no-store' });
        const t = await r.text();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' }));
        a.download = 'phoneaccess-diagnose.txt';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { } }, 5000);
        if (dm) dm.textContent = '已导出（' + Math.round(t.length / 1024) + 'KB）';
      } catch (e) {
        if (dm) dm.textContent = '导出失败：' + (e && e.message);
      }
      diagBtn.disabled = false;
    });
    bindLicencePaste(box);
    // 连接体检（Tailscale）：打开设置时自动检测一次，可手动重测/一键拉起安装包
    tsBind(box);
    // 文本剪贴板：读取/发送
    clipboardBind(box);
    // 小文件传输：上传/列表/下载
    fileBind(box);
    h264QualityBind(box);
    // 高性能模式（Moonlight）：状态 + 配对
    sunshineBind(box);

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
      if (j.error) {
        setMsg('检查更新失败', '#ff6b6b');
        if (ubox) {
          const alt = (j.mirrorPage || j.giteePage || j.githubPage) ? j : (lic.download || null);
          ubox.style.display = 'block';
          ubox.innerHTML = '<div style="color:#ff6b6b">' + escHtml(j.error) + '</div>'
            + '<div style="color:#868c96;margin-top:8px">不影响使用：当前版本照常能用。想装新版就走下面这些手动下载。</div>'
            + dlLinksHtml(alt, true);
        }
        return;
      }
      if (!j.configured) {
        setMsg('还没配置更新源', '#ffb454');
        if (ubox) {
          ubox.style.display = 'block';
          ubox.innerHTML = '当前版本 <b style="color:#e8eaee">' + escHtml(j.current || ver) + '</b>。<br>'
            + '需要新版时联系卖家拿安装包，双击安装即可——<b style="color:#8CE68C">配置和许可证都会保留</b>。'
            + dlLinksHtml(lic.download || null, true);
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
                + '<button id="updGo" data-label="' + escHtml(j.downloadLabel || (j.mirror ? '国内镜像下载' : '下载并安装')) + '" style="background:#2f6b3a;color:#e8eaee;border:0;border-radius:9px;padding:9px 16px;font-size:13px;cursor:pointer">'
                + escHtml(j.downloadLabel || (j.mirror ? '国内镜像下载' : '下载并安装')) + '</button>'
                + (j.fallbackUrl ? ' <button id="updGo2" data-label="' + escHtml(j.fallbackLabel || '改用 GitHub 下载') + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:9px;padding:9px 14px;font-size:13px;cursor:pointer">'
                  + escHtml(j.fallbackLabel || '改用 GitHub 下载') + '</button>' : '')
                + '<div id="updGoMsg" style="color:#868c96;margin-top:8px;font-size:12px"></div>'
                + '<div style="margin-top:10px;color:#6b7078;font-size:11.5px;line-height:1.7">'
                + '默认走国内源（Gitee），下不动再换 GitHub 或网盘。<br>'
                + '<a href="' + escHtml(j.pageUrl || '#') + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">打开发布页</a>'
                + ' · <a id="updCopy" href="#" style="color:#8fb6ff">复制下载地址</a>'
                + '</div>'
                + dlLinksHtml(j, true)
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
                body: JSON.stringify({ url: url, sha256: j.sha256 || '' })
              }).then((x) => x.json());
            } catch (e) { r = null; }
            stopPoll();
            poll();
            [go, go2].forEach((b) => { if (b) { b.disabled = false; b.style.opacity = '1'; } });
            if (btn) btn.textContent = btn.dataset.label || '下载并安装';
            if (m) {
              m.style.color = (r && r.ok) ? '#8CE58C' : '#ff6b6b';
              m.textContent = (r && r.message) || '下载没成功：可以重试、改用另一个源，或用上方的网盘手动下载。';
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
        if (ubox) {
          ubox.style.display = 'block';
          ubox.innerHTML = '当前 ' + escHtml(j.current) + '，没有更新的版本。'
            + '<div style="color:#6b7078;margin-top:6px;font-size:11.5px">想重装、或给另一台电脑装，用下面的安装备选。</div>'
            + dlLinksHtml((j.mirrorPage || j.giteePage || j.githubPage) ? j : (lic.download || null), true);
        }
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
      + '· 完全免费：不用许可证、没有广告、不用注册账号<br>'
      + '· 只有需要按你的环境定制（多机位 / 批处理 / 特定软件适配）时，才走右边的「定制」<br>'
      + '· 换电脑时把机器码记下来，能用它找回自己的设置</div>'
      + '<div style="margin-top:10px">' + supportHtml(lic, true) + '</div>';
    openSheet(plans.title || '完全免费', body, 'plClose');
  }
  function openSupport(lic) {
    // 2026-11-06 免费化：这个面板原来叫「支持 / 购买」，展示专业版/试用/收款码/联系方式。
    // 现在只讲「这是什么 + 完全免费能做什么」+ 机器码（换机找回设置用）+ 分享。
    const title = (lic.support && lic.support.title) ? lic.support.title : '关于';
    const body = '<div style="color:#8CE58C;font-size:16px;font-weight:600;margin-bottom:8px">完全免费</div>'
      + '<div style="color:#aeb3bb;font-size:12.5px;line-height:1.9">'
      + '· 画面 / 触控 / 声音 / 文本剪贴板 / 大文件传输，全部功能都能用<br>'
      + '· 高清 1920 与超清 2560 都不限时；多台设备同时观看，不限台数<br>'
      + '· 无广告、不用注册账号、没有试用期倒计时<br>'
      + '· 个性化（主题 / 光标形状）和同时观看台数都不再有门槛</div>'
      + machineCodeHtml(lic)
      + (lic.licensed
        ? '<div style="color:#6b7078;font-size:11.5px;margin-top:10px">这台电脑已经装好许可证（可选项）。</div>'
        : '<div style="color:#6b7078;font-size:11.5px;margin-top:10px">许可证是可选项：不装不影响任何功能；需要时在「设置 → 许可证」里粘贴。</div>')
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
        await navigator.share({ title: (lic.share && lic.share.title) || '轻屏', text: shareText() });
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
      heart = makeBtn('paSupport', ICON_HEART, ((lic.support && lic.support.title) || '关于'));
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
    try { window.__paP13n.applyAll(true); } catch (e) { }
    bottomButtons(lic);
    if (false) {   // 2026-11-06 免费化：不再因未授权回落默认外观
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
          try { window.__paP13n.applyAll(true); } catch (e) { }
          if (j.usable) setNote('许可证已生效：超清不限时长 · 外观全开', 6000);
        }
      }).catch(() => { });
    }, 30000);
  }).catch(() => { /* 拿不到许可证信息时不打扰用户：画面照常能看，个性化保持默认 */ });

  // ===== 实验层（2026-11-07，?exp=...；不带参数时整段不执行）=================
  // 约束：这一段只能"新增"，不修改上面任何逻辑。所有异常都在内部吃掉，
  // 最坏情况是实验功能不出现，绝不影响画面、输入、音频。
  // 注意：整页是 String.raw 模板，所以这段代码里不能出现反引号和美元花括号。
  // 每个形状自带 viewBox 尺寸 w/h，热点 hx/hy 用的是**viewBox 内坐标**。
  // 2026-11-07 两次修正：
  //   ① 原来所有形状共用 16x16，而箭头路径画到 y=19.6 —— 底部被裁掉，看到的是个缺了尾巴的怪箭头；
  //   ② 用户实拍了自己电脑上的真实光标发过来对比：真实 Windows 光标是 32px 位图上的**瘦长**箭头
  //      （宽高比约 0.6），黑边只有 1px。上一版 0.73 宽 + 描边 1.1，看着又胖又假，所以按照片重画。
  var EXP_SHAPES = {
    arrow:    { w: 14, h: 19, hx: 1, hy: 1, s: '<path d="M1 1 L1 17.4 L5.3 13.4 L8.1 18.2 L10.5 17.3 L7.8 11.6 L13.4 11.6 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>' },
    ibeam:    { w: 10, h: 18, hx: 5, hy: 9, s: '<path d="M1.2 1.4 H8.8 M5 1.4 V16.6 M1.2 16.6 H8.8" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round"/><path d="M1.2 1.4 H8.8 M5 1.4 V16.6 M1.2 16.6 H8.8" fill="none" stroke="#fff" stroke-width="0.95" stroke-linecap="round"/>' },
    hand:     { w: 15, h: 20, hx: 3.4, hy: 1.5, s: '<path d="M3.4 9.6 V3.6 M7.2 9.6 V2.6 M11 9.6 V4.4" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round"/><path d="M3.4 9.6 V14 C3.4 17.1 5.7 19 8 19 C10.4 19 12.7 17.1 12.7 14 V9.6" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round"/><path d="M3.4 9.6 V3.6 M7.2 9.6 V2.6 M11 9.6 V4.4" fill="none" stroke="#fff" stroke-width="0.95" stroke-linecap="round"/><path d="M3.4 9.6 V14 C3.4 17.1 5.7 19 8 19 C10.4 19 12.7 17.1 12.7 14 V9.6" fill="none" stroke="#fff" stroke-width="0.95" stroke-linecap="round"/>' },
    wait:     { w: 16, h: 16, hx: 8, hy: 8, s: '<circle cx="8" cy="8" r="6.4" fill="#fff" stroke="#000" stroke-width="1"/><path d="M8 4.2 V8 L11 9.8" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>' },
    progress: { w: 17, h: 24, hx: 1, hy: 1, s: '<path d="M1 1 L1 17.4 L5.3 13.4 L8.1 18.2 L10.5 17.3 L7.8 11.6 L13.4 11.6 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/><circle cx="14" cy="5" r="3.3" fill="#fff" stroke="#000" stroke-width="1"/><path d="M14 3 V5 L15.3 5.9" fill="none" stroke="#000" stroke-width="1.1"/>' },
    cross:    { w: 16, h: 16, hx: 8, hy: 8, s: '<path d="M8 1 V15 M1 8 H15" stroke="#000" stroke-width="2" stroke-linecap="round"/><path d="M8 1 V15 M1 8 H15" stroke="#fff" stroke-width="0.85" stroke-linecap="round"/>' },
    sizeall:  { w: 16, h: 16, hx: 8, hy: 8, s: '<path d="M8 1.2 V14.8 M1.2 8 H14.8" stroke="#000" stroke-width="2" stroke-linecap="round"/><path d="M8 1.2 V14.8 M1.2 8 H14.8" stroke="#fff" stroke-width="0.85" stroke-linecap="round"/><path d="M8 0.6 L10.4 3.6 H5.6 Z M8 15.4 L10.4 12.4 H5.6 Z M0.6 8 L3.6 5.6 V10.4 Z M15.4 8 L12.4 5.6 V10.4 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>' },
    sizewe:   { w: 16, h: 16, hx: 8, hy: 8, s: '<path d="M1 8 H15 M1 8 L4.2 4.8 M1 8 L4.2 11.2 M15 8 L11.8 4.8 M15 8 L11.8 11.2" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"/><path d="M1 8 H15 M1 8 L4.2 4.8 M1 8 L4.2 11.2 M15 8 L11.8 4.8 M15 8 L11.8 11.2" fill="none" stroke="#fff" stroke-width="0.9" stroke-linecap="round"/>' },
    sizens:   { w: 16, h: 16, hx: 8, hy: 8, s: '<path d="M8 1 V15 M8 1 L4.8 4.2 M8 1 L11.2 4.2 M8 15 L4.8 11.8 M8 15 L11.2 11.8" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"/><path d="M8 1 V15 M8 1 L4.8 4.2 M8 1 L11.2 4.2 M8 15 L4.8 11.8 M8 15 L11.2 11.8" fill="none" stroke="#fff" stroke-width="0.9" stroke-linecap="round"/>' },
    no:       { w: 16, h: 16, hx: 8, hy: 8, s: '<circle cx="8" cy="8" r="6.3" fill="#fff" stroke="#000" stroke-width="1.1"/><path d="M4.1 4.1 L11.9 11.9" stroke="#d00" stroke-width="2" stroke-linecap="round"/>' },
    help:     { w: 17, h: 24, hx: 1, hy: 1, s: '<path d="M1 1 L1 17.4 L5.3 13.4 L8.1 18.2 L10.5 17.3 L7.8 11.6 L13.4 11.6 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/><text x="11.6" y="7.6" font-size="8" font-weight="700" font-family="sans-serif" fill="#1546d8">?</text>' },
    uparrow:  { w: 13, h: 18, hx: 6.5, hy: 1, s: '<path d="M6.5 1 L12 7.4 H9 V16 H4 V7.4 H1 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>' }
  };
  function expShape(s) {
    if (EXP_SHAPES[s]) return EXP_SHAPES[s];
    if (s === 'sizenwse' || s === 'sizenesw') return EXP_SHAPES.sizeall;
    return EXP_SHAPES.arrow;
  }

  // E1：电脑真实光标。采集端 draw_mouse=0，视频里没有光标，这里靠 /ws-exp
  // 拿 {x,y,s,v}（屏幕物理像素），用 toPage() 换算成页面坐标后本地画一个。
  // 坐标换算必须复用 toPage —— 另写一套就会重演 2026-11-06 的触屏偏移事故。
  function expCursorStart() {
    var el = document.createElement('div');
    el.id = 'expCursor';
    el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:9998;'
      + 'display:none;will-change:transform;background-repeat:no-repeat;';
    document.body.appendChild(el);

    var st = { rx: 0, ry: 0, tx: 0, ty: 0, x: 0, y: 0, hx: 1, hy: 1, k: 1, shape: '', shown: false, raf: 0, fails: 0, vis: true, got: false, cw: 0, ch: 0, chx: 0, chy: 0, hxr: 0, hyr: 0, pw: 0, ph: 0, imgs: {} };
    window.__paCurImgs = st.imgs;

    // 尺寸（2026-11-07 第三版，按用户实机反馈重定）：
    // 真实光标在 2560 宽的屏幕上占 32px（1.25%）。手机上按真实比例只剩 4~5px，根本看不见，
    // 所以放到约 2.7 倍：clamp(画面宽度 × 3.4%, 14, 26) CSS px。
    //
    // 2026-11-07 第三修：画面放大时**温和跟随**（缩放倍数的 0.35 次方）。
    //   完全不跟（上一版）：放大 2 倍后光标相对画面只剩一半大，用户反馈「自适应出问题」；
    //   线性跟：放大 4 倍光标变 106px，占半个屏幕，更糟。
    //   0.35 次方：scale 2→1.27 倍、4→1.62 倍、8→2.06 倍，放大看得清又不喧宾夺主。
    // 2026-11-07 第四版：按**系统光标的真实像素尺寸和热点**画，位置用本地预测、直接写 transform（不等下一帧）
    var MIN_PX = 10;      // 再真实也不能小到看不见
    var MAX_PX = 46;      // 也不至于糊住半个屏幕
    var BOOST = 1.2;      // 真实比例在手机上偏小，放大一点更实用
    function cssScale() {
      // 屏幕像素 → 页面 CSS 像素 的换算比例（含画面缩放/旋转）
      try {
        var a0 = toPage(0, 0), a1 = toPage(1000, 0);
        var w = Math.abs(a1.x - a0.x) / 1000;
        if (w > 0 && isFinite(w)) return w;
      } catch (e) { }
      return 0;
    }
    function drawnSize() {
      // 有真实尺寸就按真实比例算；没有就退回旧的启发式（保证任何情况下都能显示）
      if (st.cw > 0 && st.ch > 0) {
        var sc = cssScale() || 1;
        var w = st.cw * sc * BOOST;
        w = Math.max(MIN_PX, Math.min(MAX_PX, w));
        return { w: w, h: w * (st.ch / st.cw) };
      }
      var ww = 0;
      try { ww = stage.getBoundingClientRect().width; } catch (e) { ww = 0; }
      var px = ww > 0 ? Math.min(22, Math.max(11, ww * 0.028)) : 14;
      return { w: px, h: px };
    }
    function paint(s) {
      var d = expShape(s);
      var sz = drawnSize();
      // 真实热点（像素）归一化；没有真实数据就用形状自带的
      var hxr = (st.cw > 0 && st.cw > 0) ? (st.chx / st.cw) : (d.hx / d.w);
      var hyr = (st.ch > 0) ? (st.chy / st.ch) : (d.hy / d.h);
      st.hxr = Math.max(0, Math.min(1, hxr));
      st.hyr = Math.max(0, Math.min(1, hyr));
      st.pw = sz.w; st.ph = sz.h; st.k = sz.w;
      el.style.width = Math.round(sz.w) + 'px';
      el.style.height = Math.round(sz.h) + 'px';
      el.style.backgroundSize = Math.round(sz.w) + 'px ' + Math.round(sz.h) + 'px';
      var real = st.imgs[s] || '';
      if (real) {
        // 真实系统光标位图（PNG）。这是 Windows 自己的像素，外形/明暗/阴影都和电脑上一致
        el.style.backgroundImage = 'url("data:image/png;base64,' + real + '")';
        el.style.imageRendering = 'auto';
      } else {
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + d.w + '" height="' + d.h + '" viewBox="0 0 ' + d.w + ' ' + d.h + '">' + d.s + '</svg>';
        el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + ')';
      }
    }
    function show(on) {
      if (st.shown === on) return;
      st.shown = on;
      el.style.display = on ? 'block' : 'none';
    }
    // 同步落位：鼠标/外接鼠标移动时立刻写 transform，不等 rAF（这是"拖泥带水"的直接来源）
    function placeNow(px, py) {
      st.x = px; st.y = py;
      el.style.transform = 'translate3d(' + (px - st.hxr * st.pw).toFixed(1) + 'px,'
        + (py - st.hyr * st.ph).toFixed(1) + 'px,0)';
    }
    var lastLocalMouseAt = 0;
    window.__paCurLocal = function (sx, sy) {
      st.rx = sx; st.ry = sy; st.got = true; st.vis = true; st.snap = true;
      lastLocalMouseAt = Date.now();
      try {
        var p0 = toPage(sx, sy);
        if (p0 && isFinite(p0.x) && isFinite(p0.y)) {
          if (!st.pw) paint(st.shape || 'arrow');
          placeNow(p0.x, p0.y);
          if (st.vis) show(true);
        }
      } catch (e) { }
      if (!st.raf) frame();
    };
    function frame() {
      st.raf = requestAnimationFrame(frame);
      if (!st.got || !st.vis) { show(false); return; }
      if (!window.__paExp || !window.__paExp.real) { show(false); return; }   // 只有 real 模式才画真光标
      var vs;
      try { vs = videoSourceSize(); } catch (e) { return; }
      if (!vs || vs.w < 100 || vs.h < 100) { show(false); return; }   // 画面还没就绪
      var p;
      try { p = toPage(st.rx, st.ry); } catch (e) { return; }
      if (!p || !isFinite(p.x) || !isFinite(p.y)) { show(false); return; }
      // 尺寸随窗口/缩放变化时才重画（每帧比对一次，代价很小）
      var want = drawnSize();
      if (!st.pw || Math.abs(want.w - st.pw) > 0.5) paint(st.shape || 'arrow');
      if (!st.shown) { st.x = p.x; st.y = p.y; }
      var kk = st.snap ? 1 : 0.78; st.snap = false;
      var dx = p.x - st.x, dy = p.y - st.y;
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) { st.x = p.x; st.y = p.y; }
      else { st.x += dx * kk; st.y += dy * kk; }
      el.style.transform = 'translate3d(' + (st.x - st.hxr * st.pw).toFixed(1) + 'px,'
        + (st.y - st.hyr * st.ph).toFixed(1) + 'px,0)';
      show(true);
    }
    function stop() {
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      show(false);
    }
    function connect() {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var w;
      try { w = new WebSocket(proto + '//' + location.host + '/ws-exp?k=' + encodeURIComponent(KEY) + '&s=' + SID); }
      catch (e) { return; }
      w.onopen = function () { st.fails = 0; };
      w.onmessage = function (ev) {
        var j;
        try { j = JSON.parse(ev.data); } catch (e) { return; }
        if (!j || j.t !== 'cur') return;
        if (typeof j.x !== 'number' || typeof j.y !== 'number') return;
        // 2026-11-07：鼠标刚动过的 400ms 内以本地预测为准，忽略电脑回传的旧位置（否则光标被"拽回去"）
        if (Date.now() - lastLocalMouseAt > 1500) {   // 3s -> 1.5s：预测窗口短一点，电脑拒绝注入时更快纠回真实位置
st.rx = j.x; st.ry = j.y; st.got = true;      // 存原始屏幕坐标，换算交给 frame()
        } else {
          st.got = true;
        }
        st.vis = (j.v !== 0);

        // 2026-11-07：注入器回传的系统光标真实像素尺寸与热点（用于按真实大小/热点绘制）
        var sizeChanged = false;
        if (typeof j.cw === 'number' && j.cw > 0 && j.cw !== st.cw) { st.cw = j.cw; sizeChanged = true; }
        if (typeof j.ch === 'number' && j.ch > 0 && j.ch !== st.ch) { st.ch = j.ch; sizeChanged = true; }
        if (typeof j.chx === 'number') { st.chx = j.chx; }
        if (typeof j.chy === 'number') { st.chy = j.chy; }
        if (typeof j.img === 'string' && j.img) {
          st.imgs[j.s || 'arrow'] = j.img;
          if ((j.s || 'arrow') === st.shape) paint(st.shape);
        }
        if (sizeChanged) paint(st.shape || 'arrow');
        var sh = j.s || 'arrow';
        if (sh !== st.shape) { st.shape = sh; paint(sh); }
        if (!st.raf) frame();
      };
      w.onclose = function () {
        stop();
        st.fails++;
        setTimeout(connect, st.fails <= 5 ? 2000 : 30000);
      };
      w.onerror = function () { try { w.close(); } catch (e) { } };
    }
    paint('arrow');
    connect();
  }

  // E2：矢量文字层（2026-11-07）。画面放大到 1.4 倍以上并停手 350ms 后，
  // 把「当前视口对应的原始画面矩形」发给 /exp/ocr，拿回每行的文字和位置，
  // 用矢量字重画一遍盖在视频上 —— 放大后不再是像素糊，而是真的清晰文字。
  //
  // 为什么只在放大时做：实测服务端 800x500 区域 OCR 稳定态约 500-700ms
  // （2560x1600 全屏要 6 秒，绝对不能全屏做），只有"用户主动放大看细节"这个场景
  // 值得等这半秒；平时看全屏时像素本来就够清楚。
  function expOcrStart() {
    var layer = null;
    var lastRect = null, lastAt = 0;
    var busy = false, gen = 0, lastScale = 1, timer = null, lastChangeAt = Date.now();
    var lastViewRect = null;   // 未裁剪的视口矩形：只用来判断「画面有没有动」，别和裁剪后的 lastRect 混用

    // 状态牌：让用户一眼看到 OCR 到底有没有在工作（不然"没感觉"完全无法判断）。
    // 只有 ?exp=ocr 才存在，不污染主线。
    var badge = document.createElement('div');
    badge.id = 'expOcrBadge';
    badge.style.cssText = 'position:fixed;right:8px;top:104px;z-index:9999;padding:5px 10px;border-radius:8px;'
      + 'background:rgba(16,18,22,.82);color:#8fb6ff;font-size:10.5px;line-height:1.45;'
      + 'max-width:calc(100vw - 20px);white-space:pre-line;box-sizing:border-box;'
      + 'font-family:system-ui,sans-serif;display:none;cursor:pointer;'
      + 'pointer-events:auto;user-select:none;';
    document.body.appendChild(badge);
    // 点状态牌 = 强制增强当前这块（绕过缩放倍数/去抖/节流的所有条件）
    badge.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (onForce) onForce();
    });
    var onForce = null;
    function badgeSet(t, color) {
      badge.textContent = t || '';
      badge.style.color = color || '#8fb6ff';
      badge.style.display = t ? 'block' : 'none';
    }

    function ensureLayer() {
      if (layer) return layer;
      layer = document.createElement('div');
      layer.id = 'expTextLayer';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9997;overflow:hidden;';
      document.body.appendChild(layer);
      return layer;
    }
    function clearLayer() { gen++; hdImg = null; hdRc = null; if (layer) layer.innerHTML = ''; }

    // 视口四角反算回"原始画面像素"矩形（复用主线的 toScreen，不另写一套）
    function viewRect() {
      var r = stage.getBoundingClientRect();
      var a = toScreen(r.left, r.top);
      var b = toScreen(r.left + r.width, r.top + r.height);
      return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
    }

    function render(j, rc) {
      var el = ensureLayer();
      var box = contentBox();
      // 关键：k 必须是「屏幕物理像素 -> 页面像素」。
      // 分母用**采集区域的物理宽度**（state.rect.w，全屏时就是 2560），
      // 不是 rc.w（那只是这次请求的矩形宽），也不是视频宽（那是缩放后的 1920）。
      // 踩过的坑：一开始用 rc.w 做分母，字号被放大约 3 倍，文字比底图大一圈。
      var sw = (state.rect && state.rect.w) ? state.rect.w : 2560;
      var k = (box.width * view.scale) / sw;
      var html = '';
      for (var i = 0; i < j.lines.length; i++) {
        var L = j.lines[i];
        if (!L || L.score < 0.55) continue;            // 认不准的不画，宁可留像素
        var p = toPage(rc.x + L.x, rc.y + L.y);
        var W = L.w * k, H = L.h * k;
        var fs = H * 0.8;                              // bbox 高度 ≈ 字号 × 1.25
        if (fs < 7 || fs > 200) continue;
        // 必须先铺背景色把原来的模糊像素字盖掉，否则清晰字和糊字叠成双影。
        // 宽度只给 6%+2px 的余量：给多了（试过 25%）相邻两行的背景块会粘连成一片，
        // 看起来像贴了好几块灰胶布。字体不同导致少数行尾部被截是可以接受的代价。
        html += '<div style="position:absolute;left:' + p.x.toFixed(1) + 'px;top:' + p.y.toFixed(1) + 'px;'
          + 'width:' + (W * 1.06 + 2).toFixed(1) + 'px;height:' + H.toFixed(1) + 'px;overflow:hidden;'
          + 'border-radius:3px;'
          + 'background:' + (L.bg || 'transparent') + ';color:' + (L.fg || '#fff') + ';'
          + 'font-size:' + fs.toFixed(1) + 'px;line-height:' + H.toFixed(1) + 'px;'
          + 'white-space:nowrap;font-family:\'Microsoft YaHei\',\'PingFang SC\',system-ui,sans-serif;'
          + 'text-align:left;">' + escHtml(L.text) + '</div>';
      }
      el.innerHTML = html;
      badgeSet('OCR 已增强 ' + el.children.length + ' 行 · ' + Math.round(j.ms || 0) + 'ms', '#8CE68C');
    }

    function request() {
      if (!expHiresOn()) { clearLayer(); badgeSet('高清增强已关闭（设置 → 个性化）', '#8b9099'); return; }
      if (busy) return;
      var rawRc = viewRect();
      var rc = rawRc;
      if (rc.w < 180 || rc.h < 110) return;
      // 2026-11-07 修：原来区域超过 1200x900 就直接 return（静默放弃）——
      // 用户放大 1.38 倍时整屏对应 1852x1024，点了 + 也永远没反应，还看不到任何提示。
      // 现在改成只取视线中心的一块去增强，其余保持像素；中心才是用户真正在看的。
      // 高清贴图用完整视口：JPEG 编码很快（实测 1000x700 只要 106ms），
      // 只有真的特别大（全屏 2560x1600）才裁中心，避免一次传几百 KB。
      var MAXW = 1400, MAXH = 1000;
      if (rc.w * rc.h > MAXW * MAXH) {
        var kc = Math.sqrt((MAXW * MAXH) / (rc.w * rc.h));
        var nw = rc.w * kc, nh = rc.h * kc;
        rc = { x: rc.x + (rc.w - nw) / 2, y: rc.y + (rc.h - nh) / 2, w: nw, h: nh };
      }
      if (lastRect && Math.abs(lastRect.x - rc.x) < 24 && Math.abs(lastRect.y - rc.y) < 24
        && Math.abs(lastRect.w - rc.w) < 40 && Math.abs(lastRect.h - rc.h) < 40) return;
      // 节流只挡「同一区域」的重复请求（上面 lastRect 那步已经在挡了），
      // 这里从 2.5 秒降到 800ms —— 原来移动完画面要等 2.5 秒才重新识别，
      // 用户以为「一次性，移动一下就不继续了」。
      if (lastAt && Date.now() - lastAt < 800) return;   // lastAt=0 表示强制请求，跳过节流
      busy = true; lastRect = rc; lastViewRect = rawRc; lastAt = Date.now();
      badgeSet('取高清图…', '#ffb454');
      var my = ++gen;
      var tSend = Date.now();
      // 2026-11-07 换方案：不再 OCR 重画（字体不同 + bbox 矩形 + 背景色采样误差，
      // 在彩色气泡/密集文字上就是糊成一片、还和底图错位），改成向服务端要
      // **这一块的原生像素 JPEG** 直接贴上去。实测 1000x700 只要 106ms / 126KB，
      // 比 OCR 的 1700ms 快一个数量级，而且没有重画的任何副作用。
      fetch('/exp/hidpi?k=' + encodeURIComponent(KEY) + '&s=' + SID, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rect: { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.w), h: Math.round(rc.h) } }),
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined,
      }).then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        return r.blob();
      }).then(function (b) {
        busy = false;
        if (my !== gen) return;
        var url = URL.createObjectURL(b);
        showHiRes(rc, url);
        badgeSet('高清图 ' + Math.round(b.size / 1024) + 'KB · ' + (Date.now() - tSend) + 'ms', '#8CE68C');
      }).catch(function () {
        busy = false;
        // 失败/超时也要更新状态牌，否则它会一直停在「取高清图…」，
        // 用户以为还在跑，其实早就断了。
        badgeSet('高清图失败，稍后自动重试', '#ff6b6b');
      });
    }

    // 高清图必须**跟着画面走**：平移/缩放时按 toPage 每帧重算位置。
    // 之前是固定坐标贴上去，用户移动画面后它就留在原地 —— 看起来是残影。
    var hdImg = null, hdRc = null;
    function repositionHd() {
      if (!hdImg || !hdRc) return;
      var p1, p2;
      try {
        p1 = toPage(hdRc.x, hdRc.y);
        p2 = toPage(hdRc.x + hdRc.w, hdRc.y + hdRc.h);
      } catch (e) { return; }
      var w = p2.x - p1.x, h = p2.y - p1.y;
      if (!(w > 1) || !(h > 1)) { hdImg.style.display = 'none'; return; }
      hdImg.style.display = 'block';
      hdImg.style.left = p1.x.toFixed(1) + 'px';
      hdImg.style.top = p1.y.toFixed(1) + 'px';
      hdImg.style.width = w.toFixed(1) + 'px';
      hdImg.style.height = h.toFixed(1) + 'px';
    }

    // 把高清图贴到 rc 对应的页面位置上，盖住视频层那一块
    function showHiRes(rc, url) {
      var el = ensureLayer();
      hdRc = rc;
      el.innerHTML = '<img alt="" src="' + url + '" style="position:absolute;display:block;left:0;top:0;width:1px;height:1px;">';
      hdImg = el.querySelector('img');
      repositionHd();
    }

// 点状态牌 = 强制对当前视口取一次高清图。绕过缩放倍数检查、去抖和节流 ——
    // 用户反馈「经常不触发」，这是最可靠的兜底入口。
    onForce = function () {
      lastRect = null; lastAt = 0; lastChangeAt = 0;
      badgeSet('强制取高清图…', '#ffb454');
      request();
    };

    // 250ms 看一次状态。三种情况要清掉旧文字层：
    //   ① 缩回原大小 ② 缩放倍数变了（位置会错）③ 画面内容动了（滚动/切窗口/换来源）
    // ③ 是新加的：文字层是"某一帧的坐标快照"，画面一动它立刻就对不上，
    // 留着不如不显示 —— 滚动过程中用像素，停手后 350ms 再重新增强。
    setInterval(function () {
      if (state.mode !== 'h264' && state.mode !== 'raw') { clearLayer(); return; }
      if (!expHiresOn()) { clearLayer(); badgeSet('高清增强已关闭（设置 → 个性化）', '#8b9099'); return; }
      var s = view.scale;
      if (s < 1.25) {
        clearLayer(); lastRect = null; lastScale = s;
        // 关键提示：很多人没意识到「画面缩放」和「系统缩放」是两个模式，
        // 系统缩放下 view.scale 永远是 1 —— 这里直接把当前倍数打在屏幕上。
        // 用真实换行（badge 是 textContent，写 &#10; 会被当成字面文本显示）。
        // 注意：这里不能用反斜杠 n 之外的转义写法 —— 整段是 String.raw 模板，
        // 而且不能出现反引号（会提前终止模板）。String.fromCharCode(10) 最稳。
        var tip = '';
        if (s <= 1.001) {
          var NL = String.fromCharCode(10);
          tip = (typeof zoomMode === 'string' && zoomMode === 'view')
            ? NL + '点右侧 + 放大'
            : NL + '先点「缩放」选「画面缩放」';
        }
        badgeSet('OCR 待机 ' + s.toFixed(2) + 'x（需 >1.25x）' + tip, '#8b9099');
        return;
      }
      // 2026-11-07 修核心 bug：原来这里每次都是 clearTimeout + setTimeout(350)，
      // 而外面 setInterval 是 250ms 一次 —— 250 < 350，定时器每轮都被重置，
      // request() 永远没机会执行（之前测试能过，都是靠调试钩子手动 fire 的）。
      // 现在改成记「最后一次变化时间」，停手满 350ms 才发请求，不依赖定时器链。
      var now = Date.now();
      if (Math.abs(s - lastScale) > 0.02) { clearLayer(); lastScale = s; lastChangeAt = now; schedule(380); }
      // 用未裁剪的视口矩形判断「画面有没有动」—— 之前拿裁剪后的 lastRect 比，
      // 尺寸永远差 600+ 像素，于是每轮都判成动了：刚渲染的文字层立刻被清掉。
      if (lastViewRect) {
        var vr = viewRect();
        if (Math.abs(vr.x - lastViewRect.x) > 30 || Math.abs(vr.y - lastViewRect.y) > 30
          || Math.abs(vr.w - lastViewRect.w) > 60 || Math.abs(vr.h - lastViewRect.h) > 60) {
          repositionHd(); lastChangeAt = now;   // 跟着走，不要清掉（清了就会闪回模糊视频）
        }
      }
      // 兜底触发：轮询发现「已经安静 350ms 且没有在跑」时补一次。
      // 正路是下面 pointerup 的 schedule()，这里只防"手势没走完/事件丢了"。
      repositionHd();
      if (!busy && !schedTimer && now - lastChangeAt >= 350) {
        lastChangeAt = now;
        request();
      }
    }, 250);

    // ---- 事件驱动的触发（2026-11-07 重写）----------------------------------
    // 之前全靠 setInterval 轮询判断"停手了没有"。链路里任何一个条件卡住
    // （某次 busy 没复位、rect 比较没过）就再也不触发，而且完全静默 ——
    // 用户实测「经常不触发、移动一下画面就没反应、好像只能触发一次」就是这么来的。
    //
    // 现在正路是：手指一抬起就调度一次请求（强制重置 lastRect/lastAt，
    // 不管上次取过没有、也不受节流限制）。轮询只做待机提示、缩放清层和兜底。
    var schedTimer = null;
    function schedule(ms) {
      if (schedTimer) { clearTimeout(schedTimer); schedTimer = null; }
      schedTimer = setTimeout(function () {
        schedTimer = null;
        if (state.mode !== 'h264' && state.mode !== 'raw') return;
        if (view.scale < 1.25) return;
        lastRect = null;      // 强制重新取
        lastAt = 0;           // 跳过 800ms 节流
        lastChangeAt = 0;
        request();
      }, ms || 380);
    }
// 拖动画面时先把高清图藏起来 —— 它是快照，手指比重新取图快得多，
    // 拖着走只会看到一张滞后的图"粘"在画面上。松手后 schedule() 会重新取。
    try {
      var dragFrom = null;
      overlay.addEventListener('pointerdown', function (e) {
        dragFrom = (e.pointerType === 'mouse') ? null : { x: e.clientX, y: e.clientY };
      }, true);
      overlay.addEventListener('pointermove', function (e) {
        if (!dragFrom) return;
        if (Math.abs(e.clientX - dragFrom.x) > 6 || Math.abs(e.clientY - dragFrom.y) > 6) {
          dragFrom = null;
          if (hdImg) hdImg.style.display = 'none';
        }
      }, true);
    } catch (e) { }

    try {
      ['pointerup', 'pointercancel', 'touchend'].forEach(function (ev) {
        overlay.addEventListener(ev, function () { schedule(420); }, true);
      });
    } catch (e) { console.warn('exp hidpi bind:', e); }

// 设置里切「高清放大增强」后从这儿回调：开启就立刻取一次，关闭就清掉图层
    window.__paExp.onHiresChange = function () {
      if (!expHiresOn()) { clearLayer(); badgeSet('高清增强已关闭（设置 → 个性化）', '#8b9099'); return; }
      lastRect = null; lastAt = 0; lastChangeAt = 0;
      schedule(200);
    };

    // 调试入口（只在 ?exp=ocr 时存在）：手机上放大是触摸手势，调试时没法模拟，
    // 这里直接改 view.scale + 手动触发一次，用来验证整条链路。
    window.__paExp.ocrDebug = {
      setScale: function (s) {
        view.scale = s; view.tx = 0; view.ty = 0;
        try { applyView(); } catch (e) { }
      },
      rect: viewRect,
      fire: function () { lastRect = null; lastAt = 0; request(); },
      size: function () { return layer ? layer.children.length : 0; },
    };
  }

  // E1 光标显示方式（2026-11-07 按用户规则重写）：
  //   · 两种模式**互斥**：dot = 跟随手指的黄点（默认）、real = 电脑真实光标
  //   · 开关在「设置 → 个性化 → 光标显示」，不再放画面角落
  //   · 检测到接了鼠标（pointerType === 'mouse'）自动切到 real —— 只自动切一次，
  //     之后尊重用户手动选择（否则他手动切回黄点会被下一帧鼠标移动再切走）
  // 真光标和黄点互斥必须用 body class + CSS !important：
  // 主线是直接改 dot.style.display 的内联样式，普通样式表规则压不住。
  // E2 高清增强开关（设置里切换，存 localStorage）。没设置过就默认开 ——
  // 能加载实验层本身就说明用户想用，默认关会让人以为功能坏了。
  function expHiresOn() {
    try {
      var v = localStorage.getItem('pa.exp.hires');
      return (v === null) ? true : (v === '1');
    } catch (e) { return true; }
  }

  var EXP_MODE_KEY = 'pa.exp.mode';
  function expMode() {
    try { return localStorage.getItem(EXP_MODE_KEY) === 'real' ? 'real' : 'dot'; } catch (e) { return 'dot'; }
  }
  function expApplyMode(m) {
    var real = (m === 'real');
    if (window.__paExp) { window.__paExp.mode = m; window.__paExp.real = real; }
    try { document.body.classList.toggle('mouse-real', !!real); } catch (e) { }
    // 2026-11-07：切回「跟随手指」时必须把 ext-mouse 也清掉。
    // body.ext-mouse #dot { display:none !important } —— 之前只 toggle 了 expNoDot，
    // 这两个类留着，于是「先用真光标再切回来」黄点永远不显示（用户实测复现）。
    if (!real) { try { document.body.classList.remove('ext-mouse'); } catch (e) { } }
    document.body.classList.toggle('expNoDot', real);
    var row = document.getElementById('expModeRow');
    if (row) {
      var bs = row.querySelectorAll('.expMode');
      for (var i = 0; i < bs.length; i++) {
        var on = bs[i].getAttribute('data-m') === m;
        bs[i].style.background = on ? 'rgba(47,111,235,.22)' : '#242730';
        bs[i].style.color = on ? '#8fb6ff' : '#c9ccd1';
        bs[i].style.borderColor = on ? '#3f6fd0' : '#343842';
      }
    }
  }
  function expSetMode(m, save) {
    m = (m === 'real') ? 'real' : 'dot';
    if (save) { try { localStorage.setItem(EXP_MODE_KEY, m); } catch (e) { } }
    expApplyMode(m);
  }
  function expInitMode() {
    var css = document.createElement('style');
    css.textContent = 'body.expNoDot #dot, body.expNoDot #mcur { display:none !important; }'
      + ' body.ext-mouse #overlay, body.ext-mouse #stage, body.ext-mouse #vid, body.ext-mouse canvas { cursor: none !important; }'
      + ' body.ext-mouse #mcur, body.ext-mouse #dot { display:none !important; }'
      // real 模式下黄点的形状/大小/颜色没意义：置灰并禁点（CSS 跟着 body class 自动生效，不用重开面板）
      + ' body.expNoDot #p13nShapes, body.expNoDot #p13nImgRow, body.expNoDot #p13nSize, body.expNoDot #p13nColors { opacity:.3; pointer-events:none; }';
    document.head.appendChild(css);
    expApplyMode(expMode());
    // 设置面板每次打开都重建 DOM，用事件委托绑一次就够
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var b = t.closest('.expMode');
      if (b) { expSetMode(b.getAttribute('data-m'), true); return; }
      // 高清增强开关：切换后刷新按钮态，并通知高清层重新评估（开→立刻取一次）
      var h = t.closest('.expHires');
      if (h) {
        var on = h.getAttribute('data-v') === '1';
        try { localStorage.setItem('pa.exp.hires', on ? '1' : '0'); } catch (e) { }
        var row = document.getElementById('expHiresRow');
        if (row) {
          var bs = row.querySelectorAll('.expHires');
          for (var i = 0; i < bs.length; i++) {
            var isOn = bs[i].getAttribute('data-v') === (on ? '1' : '0');
            bs[i].style.background = isOn ? 'rgba(47,111,235,.22)' : '#242730';
            bs[i].style.color = isOn ? '#8fb6ff' : '#c9ccd1';
            bs[i].style.borderColor = isOn ? '#3f6fd0' : '#343842';
          }
        }
        if (window.__paExp && window.__paExp.onHiresChange) {
          try { window.__paExp.onHiresChange(); } catch (e) { }
        }
      }
    }, true);
    var auto = false;
    function onPtr(e) {
      if (auto || !e || e.pointerType !== 'mouse') return;
      auto = true;
      if (expMode() !== 'real') expSetMode('real', true);
    }
    window.addEventListener('pointermove', onPtr, true);
    window.addEventListener('pointerdown', onPtr, true);
  }

  (function expInit() {
    var raw = '';
    try { raw = new URLSearchParams(location.search).get('exp') || ''; } catch (e) { raw = ''; }
    var want = {};
    raw.split(',').forEach(function (x) { x = x.trim(); if (x) want[x] = 1; });
    window.__paExp = { want: want, on: {} };

    // 2026-11-07：**真光标正式进产品**，不再要求 URL 参数。
    // 默认就加载（用户可以在 设置 → 个性化 → 光标显示 里切真假光标，
    // 规则：默认真光标关闭=黄点，显示电脑上的光标真光标）。
    // 需要临时关掉时用 ?exp=nocursor；服务端 features.realCursor=false 时 /ws-exp 404，
    // 页面这边会静默失败、不影响画面和输入。它是**正式功能**，不跟 experiments 开关联动。
    if (!want.nocursor) {
      // 2026-11-07 修 bug：设置里的「光标显示」要求 want.cursor 为真；want 只从 ?exp= 解析，
      // 默认没参数 → 设置项永远不渲染（用户找不到）。真光标默认开启，这里置 1。
      want.cursor = 1;
      try { expCursorStart(); window.__paExp.on.cursor = true; } catch (e) { console.warn('exp cursor:', e); }
      try { expInitMode(); window.__paExp.on.mode = true; } catch (e) { console.warn('exp mode:', e); }
    }
    // 高清放大增强仍是实验功能：只有显式 ?exp=ocr 才加载（设置里另有开关控制启用与否）
    if (want.ocr) {
      try { expOcrStart(); window.__paExp.on.ocr = true; } catch (e) { console.warn('exp ocr:', e); }
    }
  })();
})();
</script>

<style>
@media (max-width: 960px) {
  body { padding-top: 0 !important; }
  #bar, .bar, header { margin-top: 0 !important; padding-top: 2px !important; padding-bottom: 2px !important; }
  #hud { white-space: pre-line !important; text-align: left !important; }
}
</style>
<script>
(function () {
  try {
    var h = document.getElementById('hud');
    var KEYV = 'hudvis';
    function visible() { return localStorage.getItem(KEYV) !== '0'; }
    // 开关同时管 #hud（帧率/分辨率）和 #stat（状态栏实时值），否则平板横屏关掉一个还剩另一个在刷新
    function applyVis() {
      var on = visible();
      if (h) h.style.display = on ? '' : 'none';
      var s = document.getElementById('stat');
      if (s) s.style.display = on ? '' : 'none';
    }
    function fmt() {
      if (!h) return;
      applyVis();
      if (!matchMedia('(max-width:960px)').matches) return;
      var txt = h.textContent || '';
      if (txt.indexOf(' · ') >= 0) h.textContent = txt.split(' · ').join('\n');
    }
    if (h) { new MutationObserver(fmt).observe(h, { childList: true, characterData: true, subtree: true }); fmt(); }
    window.__paHudVis = { visible: visible, apply: applyVis, key: KEYV };
  } catch (e) {}
})();
</script><style>#zoomPop{z-index:10001 !important;}</style>
<script>
(function(){
  try{
    var sheet=document.getElementById('mobSheet');
    if(sheet){ sheet.addEventListener('click',function(e){ if(e.target && e.target.tagName==='BUTTON'){ setTimeout(function(){ sheet.style.display='none'; },60); } }); }
  }catch(e){}
})();
</script>
</body></html>`;

export const PAGE = (key, manifestHref = '/manifest.json') => PAGE_HTML
  .replace(/__KEY__/g, encodeURIComponent(key))
  // 用函数式替换 + 全局：href 里带 & 和 sig，避免 $ 之类被 replace 当成替换模式；
  // 用 /g 是因为注释里也可能出现同一个占位符（踩过一次：只换第一处，href 反而没换）。
  .replace(/__MANIFEST_HREF__/g, () => manifestHref);
