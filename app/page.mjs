const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<!-- 访问密钥在页面 URL 的 ?k= 里：任何外链都不能把整条 URL 当 Referer 带出去。
     Chrome 默认 strict-origin-when-cross-origin 只发 origin，但老浏览器/WebView 不一定，
     这里显式声明，配合外链上的 rel="noreferrer" 双保险。 -->
<meta name="referrer" content="strict-origin-when-cross-origin">
<!-- 2026-11-08：别把页面里的数字/邮箱自动识别成电话号码链接——iOS 上长按这类链接会弹系统菜单，抢掉我们的右键手势 -->
<meta name="format-detection" content="telephone=no,email=no,address=no">
<title>电脑画面</title>
<!-- 改动（第二轮 P0-1 / H1-r1）：清单地址由服务端渲染时现签注入（占位符见下行 href）。
     为什么不能写死 /manifest.json：浏览器取清单时**不带 cookie**（实测 Chrome 156），
     所以清单必须靠页面里签出来的短时 token 过鉴权；裸 GET /manifest.json 仍然是 401。
     原来的 ?v=2 作用不变：把手机上缓存过的旧清单（带过密钥、max-age=86400）换成新 URL。 -->
<link rel="manifest" href="__MANIFEST_HREF__">
<!-- 2026-11-12：浏览器标签图标改成**与官网一致的品牌标志**（2x2 四块）。
     图形与配色照抄官网 favicon（menhuayuchen.github.io/phone-access-releases/light-screen/）：
     底色 #05070A，左上象牙实心、右上与左下 30%、右下青绿 #0BD8B6。
     用 data: SVG 内联，不额外发请求，也不占服务端路由。 -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2305070A'/%3E%3Crect x='11' y='11' width='19' height='19' fill='%23EEEEEC'/%3E%3Crect x='34' y='11' width='19' height='19' fill='%23EEEEEC' opacity='.3'/%3E%3Crect x='11' y='34' width='19' height='19' fill='%23EEEEEC' opacity='.3'/%3E%3Crect x='34' y='34' width='19' height='19' fill='%230BD8B6'/%3E%3C/svg%3E">
<meta name="theme-color" content="#0A0B0D">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>
:root { color-scheme: dark;
        /* 2026-11-08 UI 改版第 1 批：安全区变量。iOS 独立模式给真实值（顶部 59 / 底部 34），
           安卓 WebView 经常返回 0，所以文件末尾 @media (display-mode: standalone) 里还有保底值。 */
        --sa-t: env(safe-area-inset-top, 0px);
        --sa-b: env(safe-area-inset-bottom, 0px);
        --sa-l: env(safe-area-inset-left, 0px);
        --sa-r: env(safe-area-inset-right, 0px); }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
/* 2026-11-08 UI 改版第 1 批：iOS 上「长按 = 右键」会被系统抢走 —— Safari 先在长按处弹
   「拷贝 / 全选 / 共享」并把文字选中（用户 iPhone 17 真机实测到了）。根因是
   -webkit-touch-callout 与 user-select，跟 contextmenu 事件没关系，所以必须在这一层压死。
   输入区在紧跟着的一行里单独放行，否则键盘栏 / 命令行里连字都选不了、光标也点不准。 */
html, body { -webkit-touch-callout:none; -webkit-user-select:none; user-select:none; -webkit-user-drag:none; }
#stage, #overlay, #vid, #img, #loadOv, #note, #blk, #hud, #stat, #hint, header,
.ripple, .cursorDot { -webkit-touch-callout:none; -webkit-user-select:none; user-select:none; -webkit-user-drag:none; }
img, #img, #vid { -webkit-user-drag:none; user-drag:none; }
input, textarea, select, [contenteditable="true"], #kbtext, #cmdtext, #cmdout {
  -webkit-user-select:text; user-select:text; -webkit-touch-callout:default; }
body { margin:0; background:#0b0b0d; color:#c9ccd1; font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex; flex-direction:column; height:100dvh; overflow:hidden; overscroll-behavior:none; }
header { display:flex; gap:6px; align-items:center; background:#15161a; flex-wrap:wrap;
         border-bottom:1px solid #24262b;
         padding: calc(6px + var(--sa-t)) calc(8px + var(--sa-r)) 6px calc(8px + var(--sa-l)); }
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
/* 2026-11-08：#spacer 元素随旧顶栏一起删掉了，这条 flex 占位规则一起清理 */
#stat { color:#7d838c; font-size:12px }
#hud { color:#7d838c; font-variant-numeric:tabular-nums; font-size:12px }
#blk { position:absolute; left:50%; top:10px; transform:translateX(-50%); display:none;
       background:rgba(120,32,32,0.92); color:#ffe9e9; border:1px solid #b04a4a; border-radius:10px;
       padding:8px 12px; font-size:13px; z-index:8; max-width:90vw; line-height:1.45; }
#blk b { color:#fff }
#blk button { margin-left:8px; background:#ffe9e9; color:#7a1f1f; border:0; border-radius:7px;
              padding:5px 9px; font:inherit; font-weight:600; }
#stage { flex:1; position:relative; overflow:hidden; background:#000; touch-action:none; }
/* 2026-11-08：原「左边缘全屏按钮 #fsBtn」的整套定位 + body.fs 全屏模式样式已删除（功能已下线）。 */
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
/* 长按进度环（2026-11-09）：按住时转满 550ms，转满变绿。rAF 驱动，见 startLongRing */
.paRing { position:absolute; width:40px; height:40px; margin:-20px 0 0 -20px;
          pointer-events:none; z-index:8; }
.paRing svg { width:100%; height:100%; display:block; }
.paRing.ok .paRingArc { stroke:#6EE7A0; }
.paRing.ok { animation: paRingOk .3s ease-out forwards; }
@keyframes paRingOk { to { transform:scale(1.6); opacity:0; } }
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
  #hud { font-size: 11px !important; }
  #stage { border-radius: 0 !important; }
}
@media (max-width: 960px) {
  #hint { display: none !important; }
  #hud { font-size: 11px !important; }
}
@media (max-width: 960px) {
  #hud { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
@media (max-width: 960px) {
  /* 2026-11-05 修：原来是 flex-wrap:nowrap + overflow:visible，窄屏（手机竖屏）时
     顶栏按钮会一路挤出屏幕右侧、点不到（用户实测截图）。改成允许换行，
     同时把占位的 spacer 隐藏（#stat 已隐藏、#hud 已 fixed），避免多余空行。 */
  #stat { display: none !important; }
  #hint { display: none !important; }
  #hud { position: fixed; left: 8px; bottom: 8px; z-index: 9998; max-width: 92vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px !important; background: rgba(0,0,0,.55); padding: 3px 6px; border-radius: 6px; }
}
@media (max-width: 480px) {
  /* 更窄的竖屏手机：按钮和间距再收一点，保证两行内放得下 */
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

/* ===== 2026-11-08 UI 改版第 2 批：视觉皮肤（A 案 · 近黑 + 冷青）=====
   这一批只换外观：颜色 / 圆角 / 描边 / 交互色。**不动任何元素的尺寸和位置**，
   所以触控坐标换算（toScreen / toPage / contentBox / videoSourceSize）完全不受影响。
   玻璃拟态（backdrop-filter）这批先不加：顶栏现在还在布局流里、不压在画面上，
   加了看不出效果，反而给低端安卓白搭一层合成开销。等第 3 批工具条浮起来再加。 */
:root {
  --bg:#0A0B0D; --s1:#12141A; --s2:#181B22; --s3:#212530;
  --stroke:rgba(255,255,255,.09); --stroke-2:rgba(255,255,255,.055);
  --tx:#E8EAEE; --tx2:#9AA1AB; --tx3:#697079;
  --accent:#35D6C4; --accent-rgb:53,214,196; --accent-soft:rgba(var(--accent-rgb),.15); --accent-line:rgba(var(--accent-rgb),.40);
}
body { background: var(--bg); color: var(--tx); }
header { background: #101217; border-bottom: 1px solid var(--stroke-2); }
button {
  background: var(--s3); color: #C6CCD4; border: 1px solid var(--stroke); border-radius: 11px;
}
/* 这里故意不写 transition：给 button 加 color/background 过渡后，页面启动时
   JS 补上 .on 的那一瞬间，Chrome 的过渡会「卡在起点」不前进（实测：等 10 秒
   仍然是未激活底色，getAnimations() 里 6 条 CSSTransition 一直 running，
   把 transition 临时设成 none 才立刻跳到正确颜色）。手机上本来也没有 hover，
   过渡没有收益，去掉最稳。 */
@media (hover: hover) { button:hover { background: #262B38; } }
button.on {
  background: rgba(var(--accent-rgb),.22); border-color: rgba(var(--accent-rgb),.62); color: #8CF6E9;
  box-shadow: 0 0 14px rgba(var(--accent-rgb),.14), inset 0 0 0 1px rgba(var(--accent-rgb),.10);
}
select { background: var(--s3); color:#C6CCD4; border:1px solid var(--stroke); border-radius:11px; }
#stat { color: var(--tx2); }
#hud { color: #7D848E; }
#hint { color: var(--tx3); background: #0F1115; }
#note { color: #8B9099; }
.ripple { border-color: var(--accent); }
#blk { border-radius: 12px; }

/* 2026-11-08：左边缘全屏把手的皮肤已随全屏功能一起删除 */
/* 恢复画面大小 */
#viewReset { background: rgba(20,22,28,.94); border: 1px solid var(--stroke); color: var(--tx); }

/* 键盘栏 / 命令行栏 */
#kbbar, #cmdbar { background: #101217; border-top: 1px solid var(--stroke-2); }
#kbtext, #cmdtext { background: #1A1D25; border: 1px solid var(--stroke); border-radius: 12px; color: var(--tx); }
#keysrow .kbtn { border-radius: 12px; }
#keysrow .kbtn.down { background: rgba(var(--accent-rgb),.18); border-color: var(--accent-line); color: #86F5E7; }
#keysrow .kundo { background: #2A2530; border-color: #4A3F58; color: #E4CDF2; }
#keynote, #cmdhint { color: var(--tx3); }
#cmdout { background: #0B0D11; border: 1px solid var(--stroke-2); color: #C9D1D9; }

/* 缩放方式面板 */
#zoomPop { background: rgba(20,22,28,.98); border: 1px solid var(--stroke); border-radius: 18px;
           box-shadow: 0 24px 64px rgba(0,0,0,.68); }
#zoomPop .zpTitle { color: #F0F2F5; }
#zoomPop .zpOpt { background: #1C2029; border: 1px solid var(--stroke); border-radius: 12px; color: #C6CCD4; }
#zoomPop .zpOpt.on { background: var(--accent-soft); border-color: var(--accent-line); color: #86F5E7; }
#zoomPop .zpOpt small, #zoomPop .zpNote { color: var(--tx3); }

/* 画面来源面板 */
#srcPanel { background: #12141A; border: 1px solid var(--stroke); border-radius: 20px 20px 0 0; }
#srcPanel h3 { color: var(--tx); }
.srcHead { color: var(--tx3); }
.srcRow { color: #C6CCD4; border-radius: 12px; }
.srcRow:active { background: #1C2029; }
.srcRow.cur { background: var(--accent-soft); color: #86F5E7; }
.srcRow.cur small { color: #57C0B2; }
#srcSheet .srcBtns button { border-radius: 12px; }

/* 设置面板里的折叠卡 */
.setSec { background: #14161C; border: 1px solid var(--stroke-2); border-radius: 14px; }
.secHead:active { background: #1A1D25; }
.secTitle { color: var(--tx); }
.secChev { color: var(--tx3); }

/* ===== 2026-11-08 UI 改版第 4 批：设置面板外壳（底部全屏面板 + 四个页签）===== */
.paSetHead {
  position: sticky; top: 0; z-index: 3;
  display: flex; align-items: center; justify-content: space-between;
  margin: 0 -16px 6px; padding: 14px 16px 10px;
  background: #0F1116; border-bottom: 1px solid rgba(255,255,255,.06);
}
.paSetTitle { font-size: 17px; font-weight: 600; color: #F0F2F5; letter-spacing: .01em; }
.paSetX {
  width: 32px; height: 32px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,.09); border: 0; color: #B7BDC6;
  font-size: 20px; line-height: 1; cursor: pointer;
}
.paSetX:active { background: rgba(255,255,255,.16); }

.paTabs {
  position: sticky; top: 57px; z-index: 2;
  display: flex; gap: 6px; margin: 0 0 10px; padding: 6px 0 8px;
  background: #0F1116;
}
.paTabs button {
  flex: 1; height: 36px; border-radius: 10px;
  background: #1A1D25; border: 1px solid rgba(255,255,255,.07);
  color: #A8B0BA; font-size: 13px; cursor: pointer;
}
.paTabs button.on {
  background: rgba(var(--accent-rgb),.18); border-color: rgba(var(--accent-rgb),.45); color: #7FF0D8;
}

/* 老代码把这些颜色写死在字符串的 style 里，只能靠 !important 才压得住 */
.paSetBox a { color: var(--accent) !important; }
.paSetBox button[style*="2f6feb"] {
  background: var(--accent) !important; color: #06201C !important;
  border-color: var(--accent) !important; font-weight: 600;
}
.paSetBox button[style*="2a2d36"] {
  background: #212530 !important; color: #E8EAEE !important;
  border-color: rgba(255,255,255,.09) !important;
}
.paSetBox input[type="text"], .paSetBox input:not([type]), .paSetBox textarea, .paSetBox select {
  background: #171A21 !important; color: #E8EAEE !important;
  border: 1px solid rgba(255,255,255,.09) !important; border-radius: 9px !important;
}
.paSetBox code { background: #171A21 !important; border-color: rgba(255,255,255,.08) !important; color: #C6CCD4 !important; }
.paSetBox input[type="checkbox"] { accent-color: var(--accent); width: 16px; height: 16px; }

/* 小屏帧率浮层 */
@media (max-width: 960px) {
  #hud { background: rgba(12,14,18,.74); border: 1px solid var(--stroke-2); border-radius: 8px; }
}

/* ===== 2026-11-08 UI 改版第 1 批：安全区适配 =====
   刘海 / 灵动岛 / 挖孔 / home 指示条 / 安卓手势条。
   注意：原来这里有一条 body > header 的顶部内边距补丁，第 3 批把旧顶栏整个删掉之后
   它已经没有作用对象了，一并清理；现在顶部让位由 #paTop 自己算。 */
/* 底部三条：临时提示 / 键盘栏 / 命令行栏 —— 不能被 home 指示条或安卓手势条压住 */
#hint { padding: 5px calc(10px + var(--sa-r)) calc(5px + var(--sa-b)) calc(10px + var(--sa-l)); }
#kbbar { padding: 8px calc(8px + var(--sa-r)) calc(8px + var(--sa-b)) calc(8px + var(--sa-l)); }
#cmdbar { padding: 8px calc(8px + var(--sa-r)) calc(8px + var(--sa-b)) calc(8px + var(--sa-l)); }
/* 右下角 / 左下角浮层 */
#hud { bottom: calc(8px + var(--sa-b)); }
#zoomPop { right: calc(8px + var(--sa-r)); }
#viewReset { left: calc(8px + var(--sa-l)); }
/* 来源选择面板（底部 sheet）的按钮行同样要躲开指示条 */
#srcSheet .srcBtns { padding-bottom: calc(16px + var(--sa-b)); }
/* 安卓 WebView / 部分国产浏览器在独立模式下 env() 返回 0，顶栏会直接钻进摄像头孔下面。
   给保底：顶部不少于 32px、底部不少于 16px；iOS 独立模式 env() = 59/34 时 max() 取真实值。 */
@media (display-mode: standalone) {
  :root { --sa-t: max(env(safe-area-inset-top, 0px), 32px);
          --sa-b: max(env(safe-area-inset-bottom, 0px), 16px); }
}

/* ===== 2026-11-08 UI 改版第 3 批：结构（顶部状态胶囊 + 底部 5 键工具条 + 更多抽屉）=====
   原来的 <header> 不再存在：画面不再被顶栏往下挤，stage 直接吃满整屏（手机上的黑边会少一大截）。
   所有按钮 id 保持不变，JS 的 getElementById 引用照旧。 */

/* --- 顶部状态胶囊：不吃触摸，纯显示 --- */
#paTop {
  position: fixed; z-index: 9000; display: inline-flex; align-items: center; gap: 8px;
  left: calc(10px + var(--sa-l)); top: calc(8px + var(--sa-t));
  max-width: calc(100vw - 20px - var(--sa-l) - var(--sa-r));
  padding: 6px 12px; border-radius: 14px;
  background: rgba(16,18,23,.93); border: 1px solid rgba(255,255,255,.07);
  /* 2026-11-08：去掉毛玻璃，见文件头说明 */
  font-size: 11.5px; color: #9AA4B0; line-height: 1.3;
  white-space: nowrap; overflow: hidden; pointer-events: none;
}
#paDot { width:6px; height:6px; border-radius:50%; background:var(--accent); flex:0 0 auto;
         box-shadow: 0 0 8px rgba(var(--accent-rgb),.8); }
#paTop #stat, #paTop #hud { overflow: hidden; text-overflow: ellipsis; }
#paTop #hud { color: #6E7681; }

/* --- 底部 5 键工具条 --- */
#paDock {
  position: fixed; z-index: 9001; left: 50%; transform: translateX(-50%);
  bottom: calc(10px + var(--sa-b));
  display: flex; align-items: center; gap: 2px; padding: 6px; border-radius: 26px;
  background: rgba(16,18,23,.93); border: 1px solid rgba(255,255,255,.09);
  
  box-shadow: 0 12px 38px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.07);
}
/* 2026-11-08：全屏按钮已下线，这里只剩工具条按钮本身的样式 */
#paDock button {
  position: static; left: auto; top: auto; transform: none; opacity: 1;
  width: auto; min-width: 52px; height: 46px; padding: 0 10px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 20px; border: 1px solid transparent;
  background: transparent; color: #C6CCD4; font-size: 12.5px; line-height: 1;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  /* #fsBtn 原来是贴左边缘的独立把手，带着 backdrop-filter 和 box-shadow；
     不清掉的话它在工具条里会自作主张糊掉底下的画面，看起来像"按下的深色块" */
  backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none;
}
#paDock button.on {
  background: rgba(var(--accent-rgb),.18); border-color: rgba(var(--accent-rgb),.45); color: #7FF0D8;
}
#paDock button:active { background: rgba(255,255,255,.08); transform: scale(.94); }

/* --- 工具条收起 / 拉出（用户反馈底部工具条挡画面）---
   把手在左边缘，点一下工具条滑出来，点画面任意处收回。
   这里可以放心加过渡：第 2 批踩的坑是「元素首屏就带着目标 class」，属于一次性渲染；
   这里走的是用户点击后的真实状态切换，transition 正常生效。 */
/* 注意：这里**不能**用 transition 做 opacity 过渡。
   实测：带 backdrop-filter 的元素（工具条就是）在 Chrome 上切 class 后
   opacity 会卡在起点不推进——class 明明加上了，元素却一直透明。
   改用一次性 @keyframes 动画（浏览器主动驱动，不受这个坑影响）。 */
/* 2026-11-08 最终决定：入场不用 CSS 动画。
   试过 transition 和 @keyframes 两种，实测在后台标签页 / 无头环境里动画时钟不推进，
   动画会卡在 from 帧，元素就一直透明——真机上万一撞到同样情况，工具条会直接看不见，
   这个代价太大。改成瞬时切换：可见性 100% 可靠；手感靠按钮的 :active 缩放补。 */
body.uiopen #paDock {
  opacity: 1; pointer-events: auto;
  transform: translateX(-50%) translateY(0);
}
body:not(.uiopen) #paDock {
  opacity: 0; pointer-events: none;
  transform: translateX(-50%) translateY(10px);
}
#paHandle {
  position: fixed; z-index: 9003;
  /* 2026-11-08：把手挪到左边缘。右侧原来挤着缩放浮层和设置/套餐/关于三个圆钮，
     把手放那儿就叠在一起了（用户横屏截图里的"最右边一堆东西"）。 */
  left: var(--sa-l); right: auto; top: 50%; transform: translateY(-50%);
  width: 26px; height: 66px; padding: 0;
  border-radius: 0 13px 13px 0;
  background: rgba(16,18,23,.88); border: 1px solid rgba(255,255,255,.10); border-left: 0;
  
  color: rgba(255,255,255,.6); font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: .8;
}
#paHandle:active { opacity: 1; background: rgba(30,36,46,.9); transform: translateY(-50%) scale(.95); }
body.uiopen #paHandle { opacity: 0; pointer-events: none; }
/* 2026-11-08 个性化：把手可以放右边（设置 → 常用 → 界面） */
body.ha-right #paHandle {
  left: auto; right: var(--sa-r);
  border-radius: 13px 0 0 13px;
  border-left: 1px solid rgba(255,255,255,.10); border-right: 0;
}

/* --- 更多抽屉 ---
   同样不用 transition / visibility：抽屉也带 backdrop-filter，opacity 过渡会卡住。
   用 @keyframes 做入场，命中判断交给 pointer-events。 */
#paSheet {
  position: fixed; z-index: 9002;
  opacity: 0; pointer-events: none;
  transform: translateY(18px) scale(.985);
  left: calc(9px + var(--sa-l)); right: calc(9px + var(--sa-r));
  bottom: calc(10px + var(--sa-b) + 62px);
  padding: 9px 12px 13px; border-radius: 24px;
  background: rgba(14,16,21,.97); border: 1px solid rgba(255,255,255,.09);
  
  box-shadow: 0 -10px 48px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.06);
}
#paSheet.on {
  opacity: 1; pointer-events: auto;
  transform: translateY(0) scale(1);
}
.paGrab { width: 36px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.2); margin: 0 auto 10px; }
.paGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.paGrid button {
  height: 46px; border-radius: 14px; padding: 0 6px;
  background: #1A1D25; border: 1px solid rgba(255,255,255,.07);
  color: #C6CCD4; font-size: 12.5px; cursor: pointer;
}
.paGrid button.on {
  background: rgba(var(--accent-rgb),.18); border-color: rgba(var(--accent-rgb),.45); color: #7FF0D8;
}
.paGrid button:active { background: #232833; }
/* 抽屉底部一行次级操作（目前只有「重新连接」） */
.paSheetFoot {
  display: flex; gap: 6px; margin-top: 9px; padding-top: 9px;
  border-top: 1px solid rgba(255,255,255,.07);
}
.paSheetFoot button {
  flex: 1; height: 40px; border-radius: 12px;
  background: transparent; border: 1px solid rgba(255,255,255,.09);
  color: #9AA1AB; font-size: 12.5px; cursor: pointer;
}
.paSheetFoot button:active { background: rgba(255,255,255,.06); }
/* 2026-11-08：抽屉格子 / 抽屉页签 / 设置页签按下去有点「回弹」，手感不生硬 */
.paGrid button, #paBtns > button, .paTabs button, .paSetX, .xbtn {
  transition: transform .09s ease, background .12s ease;
}
.paGrid button:active, #paBtns > button:active, .paTabs button:active { transform: scale(.95); }
/* 原来的三个圆形浮钮（设置/套餐/关于）现在住在抽屉里，改成和功能格一致的方块样式 */
#paBtns > button {
  width: auto; min-width: 0; height: 46px; border-radius: 14px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  background: #1A1D25; border: 1px solid rgba(255,255,255,.07); color: #C6CCD4;
  box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none;
}
#paBtns > button:active { background: #232833; }
#paBtns > button span { font-size: 10.5px; line-height: 1; color: #A8B0BA; }
/* 宽屏（平板横屏 / 桌面）：抽屉别拉满整屏，居中限宽。
   这里用 margin auto 居中，**不能**再用 transform: translateX(-50%)——
   那会和 #paSheet.on 的 transform 抢同一个属性，导致展开动画和位置算错。 */
@media (min-width: 600px) {
  #paSheet { left: 0; right: 0; margin: 0 auto; width: min(520px, calc(100vw - 24px)); }
}

/* --- 全屏模式已下线，下面这段原来控制 body.fs 的显隐，已删除 --- */

/* --- 覆盖旧规则：小屏原来把 #stat 和 #hud 藏了 / 钉到底部，现在它们住在顶部胶囊里 --- */
@media (max-width: 960px) {
  #stat { display: inline !important; }
  /* 手机上 #stat 和 #hud 的内容是重复的（都是"分辨率 · 帧率 · 码率"），
     两个都显示会让顶部胶囊拉得特别长，只留 #stat 一个。设置里的开关仍然两者一起控制。 */
  #hud { display: none !important; }
  #hud {
    position: static !important; left: auto !important; bottom: auto !important;
    max-width: none !important; background: none !important;
    border: 0 !important; border-radius: 0 !important;
    padding: 0 !important; font-size: 11.5px !important;
    white-space: nowrap !important; text-align: left !important;
  }
}
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
<!-- 2026-11-08 UI 改版第 3 批：结构改造。
     原来的 <header> 占了 60–130px 高度、把画面往下挤，而且 12 个按钮在手机上要折两行。
     现在拆成三层：顶部只留一条状态胶囊（不吃触摸）、底部 5 个常驻高频操作、其余全部进抽屉。
     所有按钮的 id 一个都没改，JS 里的 getElementById 引用全部照旧。 -->
<div id="paTop" aria-hidden="true">
  <span id="paDot"></span>
  <span id="stat">连接中…</span>
  <span id="hud"></span>
</div>

<div id="paDock">
  <button id="kbBtn" title="输入文字">键盘</button>
  <!-- 2026-11-09：声音从抽屉搬回常驻工具条。state.audio 默认 false（移动端有声音的视频
       不能自动播放），但按钮原来藏在抽屉里，用户根本想不到要先去点一下，体感就是"没声音"。 -->
  <button id="snd" title="传输电脑声音">声音</button>
  <button id="ctl" title="控制开关">控制</button>
  <button id="zoomBtn" title="三指及以上手势的缩放方式">缩放</button>
  <button id="moreBtn" title="更多功能">更多</button>
</div>
<!-- 右边缘把手：工具条收起后点它拉出来，平时只占 26px 宽，几乎不挡画面 -->
<button id="paHandle" title="显示工具条" aria-label="显示工具条">〈</button>

<div id="paSheet" role="dialog" aria-label="更多功能">
  <div class="paGrab"></div>
  <div class="paGrid">
    <button id="mCrisp">清晰</button>
    <button id="mSmooth">流畅</button>
    <button id="srcBtn" title="选择显示来源">全部屏幕</button>
    <button id="deskBtn" title="最小化所有窗口，露出桌面">桌面</button>
    <button id="cmdBtn">命令</button>
    <!-- 2026-11-11：全屏常驻入口。真机实测：全屏**不会**提高刷新率（raf 仍 60），
         但能去掉浏览器工具栏、多出显示面积、锁横屏 —— 对远控观看本身就是体验提升。 -->
    <button id="fsBtn" title="全屏观看（隐藏浏览器工具栏，多一点画面面积）">全屏</button>
    <!-- 2026-11-12：**只在 Android 壳（APK）里显示**：修改电脑地址。
         浏览器里没有 window.paAppBridge，这个按钮保持隐藏（下面有 JS 控制）。
         用户要求：不要 App 上的浮层按钮，入口要放进页面自己的「更多」里。 -->
    <button id="appAddrBtn" style="display:none" title="修改电脑地址">改地址</button>
  </div>
  <select id="src" style="display:none"><option value="m-1">全部屏幕</option></select>
  <!-- 2026-11-09：断线时原来只能刷新页面；给一个明确入口 -->
  <div class="paSheetFoot">
    <button id="paReconnect" type="button" title="重新建立连接">重新连接</button>
  </div>
</div>
<div id="srcSheet" role="dialog" aria-label="选择显示来源">
  <div id="srcPanel">
    <h3>选择显示来源</h3>
    <div id="srcList"></div>
    <div class="srcBtns">
      <button id="srcClose" style="background:#212530;color:#E8EAEE;border:1px solid rgba(255,255,255,.09)">关闭</button>
      <button id="srcReload" style="background:var(--accent);color:#06201C;border:0;font-weight:600">刷新列表</button>
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
  <img id="img" alt="" draggable="false">
  <video id="vid" playsinline autoplay muted></video>
  <!-- 首帧前的占位：避免"黑屏很久像卡死"，画面一到就把这层藏起来 -->
  <div id="loadOv" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#000;color:#9aa0aa;font-size:13px;z-index:5;pointer-events:none">
    <div style="width:34px;height:34px;border:3px solid #232832;border-top-color:var(--accent);border-radius:50%;animation:paSpin .9s linear infinite"></div>
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
  // 2026-11-07：页面版本。Service Worker 会把页面外壳缓存起来，切网/断网时会回落到缓存，
  // 结果是"修复前的旧页面又跑起来了"。这个标记会显示在「关于」面板里，一眼就能判断是不是旧缓存。
  const PA_PAGE_VER = '__PAGE_VER__';
  const SID = Math.random().toString(36).slice(2, 10);   // 本页会话 id：服务端按它统计丢帧，互不干扰
const stage = document.getElementById('stage');
let img = document.getElementById('img');
const vid = document.getElementById('vid');

// ===== 2026-11-08 个性化：强调色 / 工具条把手位置 =====
// 存 localStorage，页面一加载就应用（写 inline style，优先级高于 :root 里的默认值）。
// 强调色的半透明层（激活态、状态点光晕）全部走 var(--accent-rgb)，所以只改两个变量就整体跟着变。
function paHexToRgb(h) {
  const s = String(h || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return '53,214,196';
  return parseInt(s.slice(0, 2), 16) + ',' + parseInt(s.slice(2, 4), 16) + ',' + parseInt(s.slice(4, 6), 16);
}
function applyAccent(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(c || ''))) return;
  try {
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent-rgb', paHexToRgb(c));
  } catch (e) { }
}
function applyHandleSide(side) {
  try { document.body.classList.toggle('ha-right', side === 'right'); } catch (e) { }
}
(function paApplyPrefs() {
  try {
    const a = localStorage.getItem('pa.accent');
    if (a) applyAccent(a);
    const s = localStorage.getItem('pa.handleSide');
    if (s === 'right') applyHandleSide('right');
  } catch (e) { }
})();
// 本次会话的开始时间：设置面板里显示「本次已连接多久」（比"最近连接"更实用，我们没有设备列表首页）
window.__paStart = Date.now();

// 2026-11-08：全屏功能已删除（用户判断"没什么意义了"）。
// 理由：第 3 批之后画面本来就铺满整屏（顶栏已去掉），工具条又能收进左边缘，
// 再套一层 fullscreen 只会在手机上触发浏览器 UI 变化、且退出路径不明显。
// 原来这里有 fsBtn / setFsOn / fullscreenchange 一整段，连同 body.fs 的样式一起清掉了。

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
    // 2026-11-10：WebCodecs 自研接收端的 canvas 也要跟着缩放，
    // 否则双指放大后画面不动、坐标映射（toScreen/toPage 会按 view.scale 反算）却按放大算了，点哪都偏。
    const cvEl2 = document.getElementById('wc264c');
    if (cvEl2) { cvEl2.style.transformOrigin = '0 0'; cvEl2.style.transform = tf; }
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
// 2026-11-09：画面缩放模式下常驻的缩放浮条（＋ － ⟳ ×）。
// 实测第一版太糟：bottom:130px 正好压在底部工具条上、38px 按钮又大又不透明、× 和别的按钮一样大。
// 现在：抬到工具条上方更远处、按钮 28px、整体半透明（opacity .5）、× 单独 22px。
function updateZoomCtl() {
  let el = document.getElementById('zoomCtl');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zoomCtl';
    el.style.cssText = 'position:fixed;right:6px;bottom:210px;z-index:9997;display:none;flex-direction:column;gap:3px;background:rgba(20,22,26,.22);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:3px;opacity:.5;transition:opacity .15s';
    el.addEventListener('pointerdown', function () { el.style.opacity = '.95'; });
    el.addEventListener('pointerleave', function () { el.style.opacity = '.5'; });
    // × ：关掉浮条并自动切回「系统缩放」
    const items = [['＋', 1.25], ['－', 0.8], ['⟳', 0], ['×', -1]];
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.textContent = it[0];
      // × 额外小一号（用户要求）
      if (it[0] === '×') {
        b.style.cssText = 'width:22px;height:22px;border-radius:11px;background:transparent;color:rgba(230,232,235,.72);border:0;font-size:12px;line-height:1;align-self:center';
      } else {
        b.style.cssText = 'width:28px;height:28px;border-radius:14px;background:transparent;color:rgba(230,232,235,.92);border:0;font-size:15px;line-height:1';
      }
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        // × ：关掉浮条并自动切回系统缩放（同时会复位画面）
        if (it[1] === -1) { setZoomMode('system'); return; }
        if (it[1] === 0) { resetView(); return; }
        const r = stage.getBoundingClientRect();
        zoomViewAt(r.left + r.width / 2, r.top + r.height / 2, it[1]);
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
  }
  // 2026-11-09：画面缩放模式常驻显示；系统缩放模式隐藏（点 × 会切回系统缩放，浮条随之消失）
  el.style.display = (zoomMode === 'view') ? 'flex' : 'none';
}
// 2026-11-07：电脑浏览器没有"双指放大手机画面"的场景，只保留系统缩放
if ((function(){ try { return window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(pointer: coarse)').matches; } catch(e){ return false; } })()) { try { zoomMode = 'system'; localStorage.setItem(ZOOM_MODE_KEY, 'system'); } catch (e) { } }
function setZoomMode(m) {
  zoomMode = (m === 'view') ? 'view' : 'system';
  try { localStorage.setItem(ZOOM_MODE_KEY, zoomMode); } catch (e) {}
  // 2026-11-09：切回系统缩放时自动复位画面（原来什么都不做，用户会以为已复位）
  if (zoomMode === 'system') { resetView(); }
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
  // 2026-11-10：WebCodecs 接收端启用时，<video> 拿不到解码权（RTP 被 transform 拦走），
  // vid.videoWidth 恒为 0，后面的分支也拿不到真实尺寸，最后会掉到 16x9 兜底。
  // 而实际画面是 16:10（1920x1200）—— contentBox 按 16:9 算宽，比真实画面宽 11%，
  // 结果就是触屏点哪都偏、越靠边越偏（中间几乎不偏）。这里优先用 canvas 的真实尺寸。
  try {
    if (window.__wc264 && window.__wc264.on && window.__wc264.canvas &&
        window.__wc264.canvas.width > 0 && window.__wc264.canvas.height > 0) {
      return { w: window.__wc264.canvas.width, h: window.__wc264.canvas.height };
    }
  } catch (e) { }
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

// 2026-11-08：状态文字做「显示层压缩」。
// 原始文案太长（WebRTC264 直连 · 1920x1200 · 58.4 fps · 11.6 Mbps · 缓12ms · 帧806/解804 · 收15624KB），
// 402 宽的屏放不下，后面的延迟会被省略号吃掉——而延迟恰恰是最该看的。
// 这里统一砍掉连接方式前缀、帧计数和累计流量，只留「分辨率 · 帧率 · 码率 · 延迟」四段。
// 只影响显示，不动任何内部状态，也不改调用方。
function setStat(t) {
  let s = String(t == null ? '' : t);
  s = s.replace(/^WebRTC264\s*直连\s*·\s*/, '');
  s = s.replace(/^WebRTC264\s*/, '');
  s = s.replace(/\s*·\s*帧\s*\d+\s*\/\s*解\s*\d+/g, '');
  s = s.replace(/\s*·\s*收\s*[\d.]+\s*[KMG]?B?/g, '');
  s = s.replace(/\s*·\s*上限\s*[\d.]+\s*/g, ' · ');
  s = s.replace(/\s*·\s*抓屏\s*[\d.]+\s*/g, '');
  stat.textContent = s;
}
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
// 2026-11-08：清晰模式可用性看门狗（常驻 interval，只在“清晰”灯亮着时检查）。
// 背景：清晰模式在虚拟机/远程桌面/锁屏时可能起不来；原有兜底会先切到低频 mjpeg 但按钮还亮着，
// 用户看到的仍是“清晰点了没反应”。这里一旦服务端报 capable=false 就自动切回流畅并说明原因。
// 用常驻 interval 而不是 setTimeout 链：stopH264()/原有兜底会清掉一次性定时器。
function startH264AvailabilityWatch() {
  if (window.__paH264Watch) return;
  let lastKick = 0;
  window.__paH264Watch = setInterval(async () => {
    try {
      if (!btnCrisp.classList.contains('on')) return;        // 用户已在流畅：不用管
      if (Date.now() - lastKick < 15000) return;             // 切过之后 15 秒内不重复操作
      const hs = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json();
      if (hs && hs.capable === false && Number(hs.retryInMs) > 0) {
        lastKick = Date.now();
        const waitTxt = (hs.retryInMs > 0) ? ('（约 ' + Math.ceil(hs.retryInMs / 1000) + ' 秒后自动重试）') : '';
        try { btnSmooth.click(); } catch (e) { }
        setTimeout(function () { setNote('清晰模式暂时不可用：' + (hs.reason || '桌面复制采集不可用') + waitTxt + '，已切回流畅模式', 15000); }, 900);
      }
    } catch (e) { }
  }, 2500);
}
function stopH264() {
  h264.gen = (h264.gen || 0) + 1;
  if (h264.availTimer) { clearTimeout(h264.availTimer); h264.availTimer = null; }
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
// 2026-11-10：WebCodecs 自研接收端（可选路径）。
// 目的：绕过浏览器 jitter buffer —— 它在零丢包/零抖动/速率匹配的情况下仍会缓慢膨胀，
// 且 jitterBufferTarget/playoutDelayHint 实测被 Chrome 无视，页面侧没有任何 API 能压住。
// 做法：RTCRtpScriptTransform 把 RTP 交给 Worker 自己解包 + VideoDecoder 解码 + Canvas 渲染。
// 不支持 RTCRtpScriptTransform 的老浏览器（部分旧 iOS）自动回退到原来的 <video> 路径。
// 2026-11-10：尝试启用 WebCodecs 接收端。receivers 刚创建时 track 可能还没绑，轮询几次。
function tryStartWC264(pc) {
  let tries = 0;
  const attempt = function () {
    tries++;
    try {
      if (WC264.on) return;
      const rxs = pc.getReceivers ? pc.getReceivers().filter(function (r) { return r.track && r.track.kind === 'video'; }) : [];
      if (rxs.length && WC264.start(pc)) return;
    } catch (e) { }
    if (tries < 20) setTimeout(attempt, 100);
  };
  attempt();
}
// ---- 2026-11-11：展示节奏调度（frame pacing）--------------------------------
// 问题（已量化，见 screen-server 的 feedCad 与 diag 的 cad=）：
//   编码器产帧是**成簇**的 —— 本机实测 120fps 下相邻帧到达间隔 p50=5.2ms、p90=15.4ms、
//   max=52ms（理论 8.33ms）。而原来是"解码出一帧就立刻 drawImage"，于是 120Hz 屏上必然
//   出现"有的 vsync 挤两帧、有的空一帧" → 用户看到的那一点点**间断感**。
//   这也解释了为什么 240fps 反而更顺：帧更密，每个 vsync 都必有新帧。
// 做法：解码帧进小队列，按 worker 合成的**均匀时间戳**用 requestAnimationFrame 逐帧呈现。
//   成簇到达被缓成均匀播放；代价约 1~2 帧延迟（120fps 下 8~16ms）。
//   积压超上限丢最旧的（宁可跳帧也不能越拖越久）；连续欠载时把缓冲从 2 帧加到最多 4 帧。
// 第二版（2026-11-11 晚）：**不再依赖 worker 的合成时间戳**，直接按**实测到达速率**定呈现周期。
// 为什么改：第一版用合成时间戳当播放时钟，而它的步长来自 fpsHint；实测切档（120→90 自动降档）
// 时 worker 还按旧步长累加，播放时钟整体跑偏，只能靠"追上/对齐"硬纠正，纠正瞬间又造成新抖动
// （实测 240 个采样里 82 个是超长间隔）。到达速率本身就是内容帧率最可靠的来源，1 秒内自动跟随。
const PQ = { q: [], playing: false, raf: 0, drawn: 0, arrived: 0, under: 0, over: 0, periodUs: 8333, nextAt: 0, arrSum: 0, arrN: 0, lastArr: 0, di: [], lastDrawAt: 0, boost: 0, drawMs: 0,
  // 2026-11-12：**呈现循环的分账计数器**。查"解码 120 只画 95"时必须知道帧去哪了：
  //   ticks=rAF 次数、notDue=还没到呈现时刻、starveN=队列空（没东西可画）、
  //   skipN=被"按比例抽帧"静默丢掉、capDrop=队列超上限被动丢、rateN/rateAt=到达速率估计窗口
  ticks: 0, notDue: 0, starveN: 0, skipN: 0, capDrop: 0, rateN: 0, rateAt: 0, bufSince: 0 };
try { window.__pq = PQ; } catch (e) { }

// 2026-11-12（傍晚）：判断"浏览器是否把我们节流了"。
// 依据两条之一：页面不可见（document.hidden），或实测 rAF 明显低于稳定刷新率（<60%）。
// 为什么不能用"有没有画帧"来判断：节流时 rAF 本身就慢（1~30Hz），画不出帧是浏览器的行为，
// 不是链路坏了；把它当停摆会触发重建接收端 + 自动降档，反而把好好的流打断。
function _pqThrottled() {
  try {
    if (typeof document !== 'undefined' && document && document.hidden) return true;
    if (typeof _rafHz === 'number' && _rafHz > 0 && typeof _dispRate === 'number' && _dispRate >= 60) {
      return _rafHz < _dispRate * 0.6;
    }
  } catch (e) { }
  return false;
}

function pqStop() {
  const q = PQ.q;
  PQ.q = [];
  for (let i = 0; i < q.length; i++) { try { q[i].frame.close(); } catch (e) { } }
  PQ.playing = false; PQ.nextAt = 0; PQ.lastDrawAt = 0;
  if (PQ.raf) { try { cancelAnimationFrame(PQ.raf); } catch (e) { } PQ.raf = 0; }
}

// 缓冲延迟：2 个帧周期，夹在 [10ms, 45ms]。按时间而非帧数 ——
// 固定 2 帧的缓冲在 120fps 是 16.7ms（刚好）、30fps 变成 66ms（延迟白白翻四倍）。
// boost 是欠载时自动加深的补偿（弱网/弱机），上限 +2 帧。
function pqDelayMs(periodUs) {
  const us = periodUs * (2 + Math.max(0, Math.min(2, PQ.boost)));
  return Math.max(10, Math.min(60, us / 1000));
}

function pqSchedule() {
  if (PQ.raf) return;
  try { PQ.raf = requestAnimationFrame(pqTick); } catch (e) { }
}

// 2026-11-12：**端到端跟手度探针**（用户反馈"画面不跟手"）。
// 量的是"手指按下/拖动"到"之后画出的第 2 帧"的时间 —— 这才是用户真实感受到的延迟：
// 触屏上报 + 服务端应用输入 + 编码 + 传输 + 解码 + 呈现，全部包含在内。
// 只统计每个动作一次（同一段拖动不重复计）。
try {
  window.addEventListener('pointerdown', function () { PQ.touchAt = performance.now(); PQ.touchSkip = 0; }, { passive: true });
  window.addEventListener('pointermove', function () {
    // 拖动：每 200ms 取一次样本，避免高频事件把数组刷爆
    if (!PQ.touchAt || performance.now() - PQ.touchAt > 200) { PQ.touchAt = performance.now(); PQ.touchSkip = 0; }
  }, { passive: true });
} catch (e) { }

function pqPush(frame, ts) {
  const w = window.__wc264;
  if (!w || !w.canvas || !w.ctx) { try { frame.close(); } catch (e) { } return; }
  const now = performance.now();
  // 2026-11-12：**内容帧率估计改为"窗口内到达帧数 / 窗口时长"**。
  //
  // 原来用"相邻帧到达间隔的 EMA"，看起来更直接，实测却是**错得最厉害**的地方：
  // 解码帧是**成簇**到达的（同一个解码批次两三帧几乎同时 postMessage 出来），
  // 于是相邻间隔一半是 <0.3ms（被 d>0.3 这个下限过滤掉、根本不计入），另一半是 16~30ms，
  // EMA 只往大间隔收敛 —— 实测 120fps 被估成 **80fps（periodUs=12.47ms）**。
  // 后果（线上与离线都能复现）：调度器按 12.5ms 排帧 → 每秒只画 80 帧 →
  // 队列一路涨到我们自己的 8 帧安全上限 → **32% 的帧被自己丢掉**：
  // diag 分账 = arr=3780 drew=2465 超限=1223 未到点=4730，画/解只有 65%。
  //
  // 窗口计数对"成簇"和"偶发断档"都无偏（断档期间没送达的帧会在断档结束时成批补上），
  // 1 秒窗口 + 半衰平滑，切档后 1~2 秒跟上。
  if (!PQ.rateAt) { PQ.rateAt = now; PQ.rateN = 0; } else { PQ.rateN++; }
  const _rdt = now - PQ.rateAt;
  if (_rdt >= 1000) {
    const _fps = (PQ.rateN * 1000) / _rdt;
    if (_fps >= 5 && _fps <= 500) {
      const _us = Math.max(1000, Math.min(200000, 1e6 / _fps));
      PQ.periodUs = PQ.periodUs * 0.5 + _us * 0.5;
    }
    PQ.rateAt = now;
    PQ.rateN = 0;
  }
  PQ.lastArr = now;
  // 2026-11-12（傍晚）：**先判断"是不是浏览器把我们节流了"**。
  //
  // 线上实测（120fps 真机压测）：手机屏幕变暗/切后台时浏览器把 rAF 降到 1~30Hz，
  // 于是"超过 1 秒没画过"每隔 1.18 秒就触发一次 → 停摆计数成串 → 一分钟内 3 次雪崩
  // → rtc264Retry('avalanche') 重建接收端 → **编码器重启 + 页面自动降档到 90fps**。
  // 一次客户端节流被放大成整段质量下降，这是设计缺陷：**不是我们的链路坏了**。
  // 现在区分三种情况：
  //   ① 节流（document.hidden 或实测 rAF 低于稳定刷新率的 60%）→ 只记数，不动任何自愈；
  //   ② 有帧但画不出来（队列非空）→ 真·呈现停摆 → 重锚 + 计数；
  //   ③ 队列空（没帧可画）→ 断流（网络/编码器），只记数，不重锚不重建。
  PQ.throttled = _pqThrottled();
  if (PQ.lastDrawAt && (now - PQ.lastDrawAt) > 1000) {
    if (PQ.throttled) {
      PQ.thrGaps = (PQ.thrGaps || 0) + 1;
      PQ.lastDrawAt = now;    // 同一段节流只记一次，别每帧刷
    } else if (PQ.q.length >= 1) {
      // 真·呈现停摆：有帧却画不出来 → 重锚（原来的逻辑）
      PQ.playing = false;
      PQ.nextAt = 0;
      PQ.emptySince = 0;
      PQ.stalls = (PQ.stalls || 0) + 1;
      PQ.stallGaps = PQ.stallGaps || [];
      PQ.stallGaps.push(Math.round(now - PQ.lastDrawAt));
      if (PQ.stallGaps.length > 12) PQ.stallGaps.shift();
      console.log('[pq] 呈现停摆 ' + Math.round(now - PQ.lastDrawAt) + 'ms，强制重锚');
    } else {
      // 断流：队列空，没东西可画。不是呈现层的问题，只记数并重置计时，避免误判雪崩。
      PQ.starveLong = (PQ.starveLong || 0) + 1;
      PQ.lastDrawAt = now;
    }
  }
  // 2026-11-12（画质压测后加）：**缓冲雪崩看门狗**。
  // 压测实测：120fps 档跑两分钟后 解=0 画=0、缓冲估到 1.5 秒 → 7.8 秒，画面彻底定住且不恢复。
  // 300ms 那条自愈不够用：它只重锚，积压的帧还在、解码器继续灌，于是"重锚→又堆满→再重锚"循环。
  // 升级为：① 停摆超 2.5 秒 → 丢掉所有旧帧只留最新（把延迟强制拉回当前）；
  //        ② 一分钟内连续 3 次 → 判定接收端不可用，整条重建（rtc264Retry）；
  //        ③ 计数进 diag（avalanches=），以后能直接看还发不发生。
  // 2026-11-12 追加：只在**真的有问题**时才动它 —— 节流期间不记；队列空（断流）不记。
  if (!PQ.throttled && PQ.lastDrawAt && (now - PQ.lastDrawAt) > 2500 && PQ.q.length >= 1) {
    PQ.avalanches = (PQ.avalanches || 0) + 1;
    if (!PQ.firstAvalancheAt || now - PQ.firstAvalancheAt > 60000) PQ.firstAvalancheAt = now;
    while (PQ.q.length > 1) {
      const old2 = PQ.q.shift();
      PQ.over++;
      try { old2.close(); } catch (e) { }
    }
    PQ.playing = false;
    PQ.nextAt = 0;
    PQ.emptySince = 0;
    console.log('[pq] 缓冲雪崩（第 ' + PQ.avalanches + ' 次，停摆 ' + Math.round(now - PQ.lastDrawAt) + 'ms），丢旧帧重锚');
    if (PQ.avalanches >= 3) {
      PQ.avalanches = 0;
      PQ.firstAvalancheAt = 0;
      console.log('[pq] 一分钟内连续 3 次雪崩 → 重建接收端');
      try { rtc264Retry('avalanche'); } catch (e) { }
    }
  }
  PQ.q.push(frame);
  PQ.arrived++;   // 到达计数（= 解码帧率）。HUD 用它算"流有多少帧"，不拿画到屏幕的帧数冒充
  // 安全上限：积压太多说明播放侧跟不上（例如页面切后台），丢最旧的，别让延迟无上限增长。
  // 2026-11-12：8 → 5。120fps 内容 + 120Hz 屏时，每一帧都只能靠一个 vsync 画，
  // 队列深到 8 帧意味着**多背 66ms 延迟**；实测 buf 常年在 2~10ms，说明平时根本用不到这么深，
  // 只有解码成批输出时才短暂堆几帧 —— 5 帧（约 42ms）足够吸收，且丢帧时刻更早、延迟更低。
  while (PQ.q.length > 5) {
    const old = PQ.q.shift();
    PQ.over++;
    PQ.capDrop++;
    try { old.close(); } catch (e) { }
  }
  pqSchedule();
}

function pqTick() {
  PQ.raf = 0;
  PQ.ticks++;
  const w = window.__wc264;
  if (!w || !w.canvas || !w.ctx) { pqStop(); return; }
  const q = PQ.q;
  const now = performance.now();
  // 注意单位：periodUs 是**微秒**（来自到达间隔统计），performance.now() 是**毫秒**。
  // 这里统一换成毫秒再用，否则 nextAt 会被一次加进 8333ms，表现就是"画两帧后彻底不动"。
  // 2026-11-12：呈现周期取「内容周期」与「屏幕周期」的**较大者**。
  // 手机上常见的是屏幕 60Hz + 内容 120fps：原来仍按 8.3ms 排，但 rAF 只给 16.7ms，
  // 结果队列积压、随机丢帧（PQ.over 一直涨），观感就是细微不均匀。
  // 按较大者排 = 主动按屏幕能力**均匀抽帧**，队列保持浅、不丢、节奏稳。
  // 用**稳定后的屏幕频率**（_dispRate），不要用瞬时 _rafHz——
  // APK 的 WebView 实测 rAF 在 77~120 之间乱跳，直接用瞬时值会让周期忽长忽短。
  const _rHz = (typeof _dispRate === 'number' && _dispRate > 20) ? _dispRate : 60;
  const _dispMs = 1000 / _rHz;
  const periodMs = Math.max(PQ.periodUs / 1000, _dispMs);
  if (!PQ.playing) { PQ.nextAt = now + pqDelayMs(PQ.periodUs); PQ.playing = true; PQ.emptySince = 0; }
  if (!q.length) {
    // 队列空：**短暂**空（不到 2 个周期）保持节奏继续等，别重锚 ——
    // 低帧率下来不及攒帧，一空就重锚会每帧多等一个 delay，节奏被打断
    // （离线实测：30fps 容差内只有 50%、p90 出现 58ms 的翻倍间隔）。
    // 真断流（超过 2 个周期）才重置，等重新攒够缓冲再播。
    PQ.starveN++;
    if (!PQ.emptySince) PQ.emptySince = now;
    else if (now - PQ.emptySince > periodMs * 2) { PQ.playing = false; PQ.emptySince = 0; PQ.under++; }
    PQ.starved = true;
    pqSchedule();
    return;
  }
  PQ.emptySince = 0;
  // 2026-11-12（v2）：内容帧率 ≥ 屏幕帧率时（常见：120fps 内容 + 120Hz 屏），
  // **每个 rAF 就该画一帧**，不再做"到点没到点"的判断。
  //
  // 为什么：那个 judgement 依赖 nextAt 的累加，一旦因为周期估计跳动/丢帧而漂到未来，
  // 就会出现 diag 里那种「解=120 画=0/17」—— 解码满、屏幕满，但我们自己在空转。
  // 用户实测显示只有 ~100 而不是 120，主要就是这里少画了。
  const _cMs = PQ.periodUs / 1000;
  // 2026-11-12：容差改成**相对**屏幕周期（原来绝对 1.2ms：240fps 内容 + 240Hz 屏时
  // _cMs=5.4 而 _dispMs=4.17，差 1.23ms 就被判成"内容比屏幕慢"→ 走排程 → rAF 粒度
  // 4.17ms 下 5.4ms 的周期实际变成"隔一个 tick 才画"= 8.34ms，240fps 档掉到 147fps）。
  const _everyTick = _cMs <= (_dispMs * 1.45 + 0.8);
  // 2026-11-12：**队列深了就立刻消耗**（不排程）。
  // 起因（离线实测 240fps 档）：内容 199 帧/秒、按到达速率估出来的周期只有 185 帧/秒，
  // 排程永远是"慢一点点"→ 队列涨到 8 帧上限 → 4 秒里自己丢了 196 帧（画出只剩 150/s）。
  // 规则：队列深过 3 帧 = 我们落后了，这一拍不等排程，直接画（靠 rAF 上限自然限速），
  // 排程逻辑只在"队列很浅"时才用来控制节奏。
  const _deep = PQ.q.length > 3;
  if (!_everyTick && !_deep && now + 0.4 < PQ.nextAt) { PQ.notDue++; pqSchedule(); return; }   // 还没到点：保持当前画面，不重画
  // 落后超过 2 个周期（切后台/卡顿回来）→ 直接对齐，不做"追赶播放"：
  // 追赶会连着吐出几帧，反而更抖。
  if (now - PQ.nextAt > periodMs * 2) PQ.nextAt = now;
  // 2026-11-12：内容帧率高于屏幕时（如 60Hz 屏播 120fps），**按比例均匀抽帧**：
  // 一次呈现之间该跳过几帧就算几帧，直接丢掉；否则队列会一路涨到上限再被动丢，
  // 丢的时刻不均匀，观感就是细微卡顿。
  const _contentMs = PQ.periodUs / 1000;
  const _skip = Math.max(0, Math.round(periodMs / Math.max(0.5, _contentMs)) - 1);
  for (let i = 0; i < _skip && q.length > 1; i++) {
    const sk = q.shift();
    PQ.skipN++;
    try { sk.close(); } catch (e) { }
  }
  // 2026-11-12（v5）：**每个 vsync 画最新的那一帧，而不是最旧的**。
  //
  // 实测（画质压测 + 用户反馈"画面很不连贯"）：帧是**成簇到达**的
  // （到达间隔 p90 15.4ms，理想 8.3ms），有时两三帧一起来、有时空一拍。
  // 原来取最旧的帧画，簇里多出来的就被积压逻辑丢掉；而空拍时又没东西可画 →
  // 结果"画出帧数"只有解码帧数的 65~80%，观感就是一卡一卡。
  //
  // 屏幕一次刷新只能显示一帧，所以**最新的那帧永远是最该显示的**：
  // 每次 rAF 取队尾，把中间的全关掉。这样每个 vsync 都有新内容，簇不再造成丢帧。
  const f = q.shift();   // 2026-11-12 回滚：试过"每个 vsync 取最新帧"，离线测试把 120Hz/120fps 从 120/s 打掉一半，退回原逻辑，改法待重做。
  PQ.lastDrawAt = now;
  // 跟手度结算：触摸后画出的第 2 帧作为样本（第 1 帧多半还是触摸前的旧内容）
  try {
    if (PQ.touchAt) {
      PQ.touchSkip = (PQ.touchSkip || 0) + 1;
      if (PQ.touchSkip >= 2) {
        const _vis = now - PQ.touchAt;
        if (_vis >= 0 && _vis < 3000) {
          PQ.touchVis = PQ.touchVis || [];
          PQ.touchVis.push(Math.round(_vis));
          if (PQ.touchVis.length > 40) PQ.touchVis.shift();
        }
        PQ.touchAt = 0; PQ.touchSkip = 0;
      }
    }
  } catch (e) { }
  const _drawT0 = performance.now();
  try {
    const c = w.canvas, x = w.ctx;
    if (c.width !== f.displayWidth || c.height !== f.displayHeight) { c.width = f.displayWidth; c.height = f.displayHeight; }
    x.drawImage(f, 0, 0);
    w.frames++; w.lastFrameAt = Date.now();
    // 出帧 = 活着：清连续失败计数并解除冷却（看门狗逻辑不变，改由调度器在呈现时更新）
    if (w.restarts) w.restarts = 0;
    w.gaveUp = false;
    PQ.drawn++;
    // 呈现间隔采样（最近 240 个）：这是"画得匀不匀"的客观证据
    try {
      const _pd = performance.now();
      if (PQ.lastDrawAt) {
        const _pi = _pd - PQ.lastDrawAt;
        if (_pi > 0 && _pi < 500) { PQ.di.push(Math.round(_pi * 10) / 10); if (PQ.di.length > 240) PQ.di.shift(); }
      }
      PQ.lastDrawAt = _pd;
      // 2026-11-11：记录**每帧绘制耗时**（EMA）。这是区分两种"只画 60"的关键：
      //   · 耗时 ~1-2ms 且 raf=60  → 是浏览器/屏幕只给 60Hz，与我们无关；
      //   · 耗时 ~8-16ms 且 raf=60 → 是我们画得太重，Chrome 把合成降到 60Hz（rAF 跟着降）。
      try { const _dm = _pd - _drawT0; PQ.drawMs = PQ.drawMs ? (PQ.drawMs * 0.9 + _dm * 0.1) : _dm; } catch (e) { }
    } catch (e) { }
  } catch (e) { }
  try { f.close(); } catch (e) { }
  // 2026-11-11：排下一帧的时刻。
  // ① 欠载过（队列空过）→ 从**现在重新起算一个完整周期**：此时 nextAt 已经落后，
  //    若还按"最小间隔 0.6 周期"排就会提前，30fps 下变成 5 tick 而不是 8 tick
  //    （离线实测容差内只有 2%）。
  // ② 没欠载 → 正常 +1 周期，但禁止累积欠账：一旦某次晚了几毫秒，欠账会让接下来
  //    连续几个 rAF 都"到点"→ 出现 4.17ms 连发（离线实测 90fps 下 83 个过挤间隔）。
  if (PQ.starved) { PQ.nextAt = now + periodMs; PQ.starved = false; }
  else PQ.nextAt = Math.max(PQ.nextAt + periodMs, now + periodMs * 0.6);
  // 欠载时自动加深缓冲（上限 +2 帧），减少后续空 vsync；恢复顺畅后不自动回退，避免振荡
  if (!PQ.q.length) {
    const t = Date.now();
    if (t - (PQ.lastUnderAt || 0) > 1500) { PQ.lastUnderAt = t; if (PQ.boost < 2) PQ.boost++; }
  }
  pqSchedule();
}

// 2026-11-11：worker 的合成时间戳步长 = 1/fpsHint，但它只在 start() 时同步过一次。
// 帧率一改（本机设置面板 / 另一台设备改共享主路 / 服务端自动降档），worker 还按旧步长
// 累加时间戳 → 播放时钟和实际到达速度对不上 → 队列堆积、丢帧（实测 30→60fps 时
// 播放时钟只有一半速度，240 个采样里 82 个是超长间隔）。
// 这里每 5 秒校准一次（一个小 GET），任何来源的帧率变化都能在 5 秒内跟上。
let _fpsSyncAt = 0, _fpsSyncLast = 0;
setInterval(function () {
  const w = window.__wc264;
  if (!w || !w.on || !w.worker) return;
  const now = Date.now();
  if (now - _fpsSyncAt < 5000) return;
  _fpsSyncAt = now;
  try {
    fetch('/h264-quality', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.fps) return;
      const f = Number(j.fps);
      if (!(f > 0) || f === _fpsSyncLast) return;
      _fpsSyncLast = f;
      try { if (w.worker) w.worker.postMessage({ type: 'fps', fps: f }); } catch (e) { }
    }).catch(function () { });
  } catch (e) { }
}, 1000);

// 2026-11-11：手机端**真实刷新节奏**探针。
// 用途：用户报"解码 120 但屏幕只画 60"时，一锤定音区分两种情况：
//   · raf=60  → 浏览器/系统只给了 60Hz（屏幕刷新率设置、Chrome 限制），与我们无关；
//   · raf=120 而 drawn=60 → 是我们渲染太重（画布 drawImage + 合成）跟不上。
// 只做计数，代价可忽略；随 [wc264-diag] 每 30 秒上报一次。
let _rafCount = 0, _rafHz = 0, _rafLastAt = performance.now();
// 2026-11-12：**稳定后的屏幕刷新率**，给调度器用（pqTick 不再直接用瞬时 _rafHz）。
//
// 为什么需要：APK 的 WebView 实测 rAF 在 77~120Hz 之间乱跳（系统在不同显示模式间抖），
// 而调度器的呈现周期直接取瞬时值 → 周期一会儿 8.3ms 一会儿 12.9ms，
// 结果 over=101 under=127（一会被迫丢帧、一会饿死），观感就是"不稳定"。
//
// 做法：量化到常见档位 + 滞后确认（连续 3 秒稳定在新档位才切），避免来回抖。
let _dispRate = 60;
let _dispCand = 0, _dispCandCount = 0;
const _RATE_BUCKETS = [60, 72, 90, 120, 144, 165, 240];
function _quantizeRate(hz) {
  let best = _RATE_BUCKETS[0], bd = 1e9;
  for (let i = 0; i < _RATE_BUCKETS.length; i++) {
    const d = Math.abs(_RATE_BUCKETS[i] - hz);
    if (d < bd) { bd = d; best = _RATE_BUCKETS[i]; }
  }
  return best;
}
(function rafProbe() {
  // 最近 8 秒的 rAF 采样。用**最高值**当作"屏幕能力上限"，而不是平均值：
  // APK 实测 rAF 在 60~120 之间来回切（系统省电策略），平均会落到 ~91Hz，
  // 平均/直接量化都会把目标定成 90，于是"屏幕明明 120 却只画 90"。
  // 取最高值 = 按屏幕真实能力排；只有当系统**持续**压低（8 秒内最高也只有 60）
  // 才真的降档，避免被短暂降频误伤。
  const _ring = [];
  function tick() {
    _rafCount++;
    const n = performance.now();
    if (n - _rafLastAt >= 1000) {
      _rafHz = Math.round(_rafCount * 1000 / (n - _rafLastAt));
      _rafCount = 0; _rafLastAt = n;
      _ring.push(_rafHz);
      if (_ring.length > 8) _ring.shift();
      let cap = 0;
      for (let i = 0; i < _ring.length; i++) if (_ring[i] > cap) cap = _ring[i];
      const q = _quantizeRate(cap);
      // 滞后：同一个量化档位连续 3 次（≈3 秒）才真正切换
      if (q === _dispRate) { _dispCand = 0; _dispCandCount = 0; }
      else if (q === _dispCand) {
        _dispCandCount++;
        if (_dispCandCount >= 3) { _dispRate = q; _dispCand = 0; _dispCandCount = 0; }
      } else { _dispCand = q; _dispCandCount = 1; }
    }
    try { requestAnimationFrame(tick); } catch (e) { }
  }
  try { requestAnimationFrame(tick); } catch (e) { }
})();

// 2026-11-11：两个排查/突破用的 URL 开关（不改任何现有 UI）
//
// ① ?fs=1 —— 首次触摸自动进全屏。
//    Chrome on Android 对普通标签页常把合成钉在 60Hz；全屏（尤其接近视频播放的形态）
//    才可能放开到屏幕原生刷新率。全屏本身对远控也是体验提升（面积更大、藏掉浏览器栏）。
// ② ?wc=0 —— 强制走浏览器 <video> 解码，而不是 WebCodecs + canvas。
//    用来判断"限制来自 canvas 合成"还是"屏幕/浏览器整体"：
//    如果 <video> 能到 120Hz 而 canvas 只有 60Hz，那就说明有得绕。
(function () {
  try {
    if (!/[?&]fs=1(&|$)/.test(location.search)) return;
    let tries = 0;
    window.__paFsTries = 0;
    window.__paFsErr = '';
    const cleanup = function () {
      try { document.removeEventListener('pointerdown', go, true); } catch (e) { }
      try { document.removeEventListener('touchend', go, true); } catch (e) { }
    };
    const go = function () {
      if (document.fullscreenElement) { window.__paFsTries = tries; cleanup(); return; }
      tries++;
      window.__paFsTries = tries;
      try {
        const el = document.documentElement;
        if (!el.requestFullscreen) { window.__paFsErr = 'no-api'; return; }
        const p = el.requestFullscreen();
        if (p && p.catch) p.catch(function (e) { window.__paFsErr = String((e && e.name) || e); });
      } catch (e) { window.__paFsErr = String((e && e.message) || e); }
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () { }); } catch (e) { }
    };
    // 2026-11-11：**每次点击都重试**，直到真的进了全屏才解绑。
    // 原来只试一次就解绑 —— 第一次点击如果因为"没有用户手势/被页面 preventDefault"被拒，
    // 后面就再也不会有反应，从日志里只能看到 全屏=0，无法判断是没点到还是被拒。
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('touchend', go, true);
  } catch (e) { }
})();

const WC264 = {
  on: false, worker: null, canvas: null, ctx: null, stats: null, frames: 0,
  // 2026-11-11：初值给"现在"，不要给 0。
  // 看门狗的外层条件是 lastFrameAt 存在；给 0 的话，**不支持 WebCodecs 的浏览器永远进不去**
  // 那段逻辑，连"浏览器解码这条兜底路也死了"的检测都没有 —— 那才是真的没人管。
  lastFrameAt: Date.now(), lastErr: "",
  // 2026-11-10：卡死自愈用。gaveUp=彻底放弃（回退 <video>）；restarts=已经重建过几次接收端。
  gaveUp: false, restarts: 0, restarting: false,
  supported() {
    try {
      // 2026-11-11：?wc=0 强制走浏览器 <video> 解码路径（A/B 实验用）。
      // 目的：如果 <video> 那条路在手机上能拿到 120Hz 合成而 canvas 只有 60Hz，
      // 就说明限制来自"canvas 合成"而不是屏幕，我们就有办法绕。
      if (/[?&]wc=0(&|$)/.test(location.search)) return false;
      return typeof RTCRtpScriptTransform !== "undefined" && typeof VideoDecoder !== "undefined";
    } catch (e) { return false; }
  },
  start(pc) {
    if (this.on || !pc) return false;
    if (!this.supported()) { this.lastErr = "no-rtp-tf"; return false; }
    this.lastErr = "";
    this.restarting = false;
    try {
      const rxs = pc.getReceivers ? pc.getReceivers().filter(function (r) { return r.track && r.track.kind === "video"; }) : [];
      if (!rxs.length) { this.lastErr = "no-video-receiver"; return false; }
      const w = new Worker("/wc264-worker.js");
      const self_ = this;
      w.onmessage = function (e) { self_.onMsg(e.data); };
      w.onerror = function (e) { self_.lastErr = "worker:" + (e && e.message); };
      for (let i = 0; i < rxs.length; i++) { rxs[i].transform = new RTCRtpScriptTransform(w); }
      this.worker = w;
      // 告诉 Worker 当前的编码帧率：合成时间戳和"时间戳跳档=缺帧"的判定都要用它。
      // 注意 H264_FPS 这个变量在页面里**并不存在**（历史遗留，typeof 永远 undefined），
      // 所以以前一直按 60 在算 —— 90fps 的流上，缺口判定和帧间隔全错。现在直接问服务端要。
      try {
        w.postMessage({ type: "fps", fps: 60 });
        fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.fps) { try { w.postMessage({ type: "fps", fps: Number(j.fps) }); } catch (e0) { } } })
          .catch(function () { });
      } catch (e) { }
      let c = document.getElementById("wc264c");
      if (!c) {
        c = document.createElement("canvas");
        c.id = "wc264c";
        // 2026-11-10：必须加 object-fit:contain。
        // 原来只有 width:100%;height:100%，canvas 会被拉伸铺满（变形），
        // 而 <video> 一直是 contain（保持比例+黑边），坐标映射也按 contain 算 ——
        // 两者不一致就是"触屏有偏移"和"画面显示不一样"的直接原因。
        c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:block;z-index:3;";
        const st = document.getElementById("stage") || document.body;
        st.appendChild(c);
      }
      c.style.display = "block";
      this.canvas = c;
      this.ctx = c.getContext("2d", { alpha: false, desynchronized: true });
      this.on = true;
      // 2026-11-11（关键修正）：重建接收端之后必须把"上一次出帧时间"重置到现在。
      // 原来没重置 → 看门狗拿着**重建前**的旧时间戳，1.2 秒后立刻又判"还在卡"，
      // 3 次重建名额在约 5 秒内烧光 → 过早 gaveUp → 之后只能整页重连才恢复。
      // 这就是"画面静止 + 不停重新连接"的直接成因。
      this.lastFrameAt = Date.now();
      this.frames = 0;
      this.stats = null;
      this._lastDec = undefined;
      this._lastRtp = undefined;
      this._vidFramesLast = undefined;
      this._vidStallSince = 0;
      setStat("WebCodecs 接收端已启用");
      return true;
    } catch (e) {
      this.lastErr = String((e && e.message) || e);
      this.stop();
      return false;
    }
  },
  onMsg(m) {
    if (!m) return;
    if (m.type === "frame") {
      // 2026-11-11：不再"一到就画" —— 交给展示节奏调度（见 PQ 上方注释）。
      pqPush(m.frame, m.ts);
    } else if (m.type === "stats") {
      this.stats = m.stats;
    } else if (m.type === "reconfig") {
      // 2026-11-10：编码器换了参数集（切分辨率/切窗口/崩溃重启），Worker 正在重建解码器。
      // 这里只记一笔，画布保留最后一帧（比黑屏好看），新解码器配置好后第一帧就会覆盖它。
      this.cfg = m.cfg; this.spsChanges = m.spsChanges;
      try { console.log("wc264: 参数集变化 #" + m.spsChanges + "，正在重建解码器（cfg#" + m.cfg + "）"); } catch (e) { }
    } else if (m.type === "resync") {
      // 2026-11-10：Worker 发现解码队列堆积（画面越拖越远），主动重建解码器清空积压。
      // 这里累计次数，rtc264Stats 里据此判断"这台设备吃不下当前帧率"并自动降档。
      this.resyncs = m.resyncs || ((this.resyncs || 0) + 1);
      this.lastQueue = m.queue || 0;
      try { console.log("wc264: 解码队列堆积 " + (m.queue || '?') + " 帧，已重建解码器等关键帧（第 " + this.resyncs + " 次）"); } catch (e) { }
    } else if (m.type === "hello" || m.type === "tx-event" || m.type === "first-rtp" || m.type === "diag") {
      if (m.type === "diag" && this.lastErr.length < 400) { this.lastErr = (this.lastErr || "") + " {" + m.msg + "}"; }
      if (this.lastErr.length < 400) this.lastErr = (this.lastErr || "") + " [" + m.type + "]";
    } else if (m.type === "ready") {
      // 记录实际用的解码方式，HUD 里能看到是硬件还是回退
      try { this.hw = m.hw || "?"; } catch (e) { }
      console.log("wc264 decoder ready", m.codec);
    } else if (m.type === "error") {
      this.lastErr = String(m.message || "decode");
      console.warn("wc264", this.lastErr);
    }
  },
  stop() {
    // 2026-11-10：回退必须把 transform 摘掉，否则浏览器永远收不到解码权，<video> 一片黑。
    // 这是 iOS 老版本/不支持设备走回退路径的关键一步。
    try {
      const _pc = window.__rtc264 && window.__rtc264.pc;
      if (_pc && _pc.getReceivers) {
        _pc.getReceivers().forEach(function (r) {
          try { if (r.track && r.track.kind === "video") r.transform = null; } catch (e) { }
        });
      }
    } catch (e) { }
    // 2026-11-11：调度器里的解码帧是所有权对象，必须在这里 close 掉，否则会泄漏 GPU 纹理
    try { pqStop(); } catch (e0) { }
    try { if (this.worker) this.worker.terminate(); } catch (e) { }
    this.worker = null; this.on = false; this.stats = null;
    if (this.canvas) { try { this.canvas.remove(); } catch (e) { } this.canvas = null; this.ctx = null; }
  }
};
try { window.__wc264 = WC264; } catch (e) { }
try { window.__rtc264 = RTC264; } catch (e) { }   // 诊断/端到端测试用

// ---- 丢包快速反应（2026-11-10）--------------------------------------------------
// 为什么单独做一个 600ms 的轮询：原来丢包判断搭在 2 秒一次的统计里，等它发现，
// 手机上花屏已经显示 1~2 秒了。这里只看 packetsLost/pliCount，一涨就通知 Worker
// 停喂、等下一个关键帧（GOP 0.5 秒）。**不改任何编码参数，画质完全不受影响**，
// 只是把"花一片"的时长尽可能压短。
//
// 注意：getStats 在安卓上不是免费的，所以 ①只在 WebCodecs 生效且页面可见时跑；
// ②上一次没返回就跳过这一轮（用 _busy 防重入）；③只读 inbound-rtp 一行。
let _wcLossTimer = null;
function wc264WatchLoss() {
  if (_wcLossTimer) return;
  let busy = false;
  _wcLossTimer = setInterval(function () {
    if (busy) return;
    const R = RTC264, w = window.__wc264;
    if (!R.pc || document.hidden) return;
    if (!w || !w.on || !w.worker) return;
    busy = true;
    R.pc.getStats().then(function (st) {
      let lost = 0, pli = 0;
      st.forEach(function (r) {
        if (r.type === 'inbound-rtp' && r.kind === 'video') { lost = r.packetsLost || 0; pli = r.pliCount || 0; }
      });
      w.lost = lost; w.pli = pli;
      if (w._lastLost === undefined) { w._lastLost = lost; busy = false; return; }
      if (lost > w._lastLost) {
        const d = lost - w._lastLost;
        w._lastLost = lost;
        w.gaps = (w.gaps || 0) + 1;
        try { w.worker.postMessage({ type: 'gap' }); } catch (e) { }
        try { console.log('wc264: 丢包 +' + d + '（累计 ' + lost + '）→ 停喂等关键帧'); } catch (e2) { }
      }
      busy = false;
    }).catch(function () { busy = false; });
  }, 600);
}

// ---- 码率自动（可选，默认关）------------------------------------------------
// 设计：设置里「自动」按钮，默认不开启；开启后按 WebRTC 丢包自动升降码率
// （6–20 Mbps），只在 WebRTC264 通道生效。手动码率永远优先——用户一选固定值就退出自动。
// 注意：这段必须在**最外层作用域**（rtc264Stats 里要用 autoqTag；放进设置面板的闭包里会
// 变成 ReferenceError 被 catch 吞掉，表现就是状态栏一直停在「WebRTC264 连接中」）。
const AUTOQ = { on: false, kbps: 12000, lastApply: 0, badStreak: 0, goodStreak: 0, lastLost: 0, lastRecv: 0 };
// 2026-11-12：**默认开启**丢包自适应码率（用户没手动关过就开）。
// 实测证据：lost=624 / rtp=11904 ≈ 5.2% 丢包、pli=143（关键帧请求 143 次）→ 画面一顿一顿。
// 这套机制本来就是治它的，但默认关闭等于白写。
// 注意：不再在启动时套用 AUTOQ.kbps（原来会一加载就把用户设的 50M 压成 12M），
// 只有真的连续两次丢包超 3% 才降档。
try {
  const _hqAuto = localStorage.getItem('hqAuto');
  AUTOQ.on = (_hqAuto === null) ? true : (_hqAuto === '1');
  AUTOQ.kbps = Number(localStorage.getItem('hqAutoKbps')) || 12000;
} catch (e) { }
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
// 2026-11-12：删掉启动即降码率（只在真检测到丢包时才降，避免一加载就把画质压到 12M）

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
function stopRtc264(why) {
  // 2026-11-11：把"谁关掉了连接"上报到服务端。
  // 为什么需要：侧车日志只能看到 pc-closed，看不到**是谁**、因为什么触发的。
  // 为了查"每 30 秒重连一次"这个问题，之前只能靠猜；现在服务端日志里直接会有
  // [rtc264-stop] 原因=...，一眼定位。
  try {
    if (why) {
      fetch('/wc264-diag?k=' + encodeURIComponent(KEY), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stop: String(why).slice(0, 180) }), cache: 'no-store', keepalive: true
      }).catch(function () { });
    }
  } catch (e) { }
  // 2026-11-10：重连必须把 WebCodecs 接收端一起停掉、并摘掉 transform。
  // 否则 WC264.on 一直是 true，重连后 start() 直接 return，新 PC 挂不上 transform，
  // 表现：画面停在最后一帧、「缓」一路涨到几万毫秒（实测 21886ms）。
  try { WC264.stop(); } catch (e) { }
  // 每次重连都重新给 WebCodecs 机会：上一次连接攒下的"放弃/重建次数"不能带到新连接上
  try { WC264.gaveUp = false; WC264.restarts = 0; WC264.restarting = false; WC264._lastDec = undefined; WC264._lastRtp = undefined; } catch (e) { }
  const R = RTC264;
  rtc264Gen++;
  if (R.statsTimer) { clearInterval(R.statsTimer); R.statsTimer = null; }
  if (R.watchdog) { clearTimeout(R.watchdog); R.watchdog = null; }
  const sid = R.sid;
  R.sid = ''; R.firstVideo = false; R.startedAt = 0; R.hudText = '';
  try { clearTimeout(R.noVideoTimer); R.noVideoTimer = 0; } catch (e) { }
  R.lastCt = 0; R.frozenSince = 0; R.lastFr = 0; R.lastBr = 0; R.frozenProbe = false;
  R.rate = null; R.qFps = 0; R.qRxFps = 0; R.qMbps = 0; R.playStart = 0;
  if (R.discTimer) { clearTimeout(R.discTimer); R.discTimer = null; }
  if (R.retryTimer) { clearTimeout(R.retryTimer); R.retryTimer = null; }
  try { rtc264AudioStop(); } catch (e) { }
  // 2026-11-08 P1b：同 PC 音频的状态必须一起清，否则重连后 audioSamePc 还是 true，
  // 音频会永远不再建立（P1 回退到旧纯音频连接时也永远起不来）。
  R.audioSamePc = false;
  R.audioTrack = null;
  R.audioReceiver = null;
  R.videoReceiver = null;
  R.media = null;
  if (R.pc) {
    try { R.pc.ontrack = null; R.pc.oniceconnectionstatechange = null; R.pc.close(); } catch (e) { }
    R.pc = null;
  }
  window.__pc264 = null;
  try { vid.srcObject = null; } catch (e) { }
  if (sid) {
    try {
      fetch('/rtc264/close?stream=' + (RTC264.stream || 1), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: sid }) }).catch(function () { });
    } catch (e) { }
  }
}
async function startRtc264() {
  stopRtc264('restart');
  const R = RTC264;
  // 2026-11-11（C 方案）：建会话前先问服务端"我该走哪一路"。
  // 只在没有/超过 20 秒没问过时才问（重连循环里不必每次都问）。
  try {
    if (!R.streamAt || Date.now() - R.streamAt > 20000) {
      const wantF = Number((function () { try { return localStorage.getItem('hqFps'); } catch (e) { return 0; } })() || R.inFps || 0);
      const wantK = Number((function () { try { return localStorage.getItem('hqKbps'); } catch (e) { return 0; } })() || 0);
      const pk = await (await fetch('/h264-stream-pick', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fps: wantF || 0, kbps: wantK || 0, client: paClientId() })
      })).json();
      if (pk && pk.ok) {
        R.stream = (Number(pk.stream) === 2) ? 2 : 1;
        R.ownsPrimary = pk.owner === true;      // 只有主路主人能改主路档位
        R.streamAt = Date.now();
      }
    }
  } catch (e) { }
  const my = rtc264Gen;
  const mode = rtc264Mode();
  R.startedAt = Date.now();
  // 2026-11-07：黑屏兜底。个别网络/旧缓存页面下 WebRTC 可能一直出不来画面，
  // 以前会停在「WebRTC264 连接中」黑着不动。这里 8 秒还没第一帧就自动退回低频画面，
  // 用户至少能看到屏幕；下次切清晰模式会重新再试 WebRTC。
  clearTimeout(R.noVideoTimer);
  const noVideoFallback = (why) => {
    if (my !== rtc264Gen) return;
    if (state.mode !== 'h264' || document.hidden) return;
    if (R.firstVideo) return;
    try { console.log('rtc264: ' + why + '，退回低频画面'); } catch (e) { }
    R.noVideoTimer = 0;
    rtc264Fallback(why);
  };
  R.noVideoTimer = setTimeout(function () {
    if (my !== rtc264Gen) return;
    if (state.mode !== 'h264' || document.hidden) return;
    if (R.firstVideo) return;
    // ICE 已连上但还没首帧：多半是编码器/关键帧慢，再给 7 秒，避免在 4G/tailnet 上误判
    const ice = R.pc ? R.pc.iceConnectionState : '';
    if (ice === 'connected' || ice === 'completed') {
      R.noVideoTimer = setTimeout(() => noVideoFallback('no-video-15s'), 7000);
      return;
    }
    noVideoFallback('no-video-8s');
  }, 8000);
  try {
    // 2026-11-11（C 方案）：带上"我走哪一路"，服务端据此把 offer 转发给主路或第二路侧车
    const resp = await fetch('/rtc264/offer?pv=' + encodeURIComponent(PA_PAGE_VER) + '&stream=' + (RTC264.stream || 1)
      // 2026-11-12：带上客户端 id。服务端据此认定"谁真的在观看"——主路归属只认这个信号，
      // 不再认"反复调用 /h264-stream-pick"，避免只认领不观看的客户端长期霸占主路。
      + '&client=' + encodeURIComponent(paClientId()), { method: 'POST', cache: 'no-store' });
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
        try {
          if (e.receiver) {
            // 2026-11-08 P1b：音/视频各自的 receiver 分开记。
            // 原来不分 kind 一律写成 videoReceiver，音频轨到达后把视频的覆盖掉了，
            // 结果滑杆/校准全作用在音频 receiver 上（校准时还会 400ms 就报错退出）。
            if (e.track.kind === 'audio') {
              RTC264.audioReceiver = e.receiver;
              if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 20;
              if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
            } else {
              RTC264.videoReceiver = e.receiver;
          // 2026-11-10：视频轨到了就尝试启用 WebCodecs 接收端（成功则 RTP 由 Worker 接管，
          // 绕过浏览器 jitter buffer；失败/不支持则什么都不做，继续用原来的 <video> 解码渲染）。
              if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 20;
              if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
            }
          }
        } catch (err) { }
        if (e.track.kind === 'audio') {
          // 2026-11-08 P1：同一条 PC 送来的音频，直接用（Chrome 会自动对齐音画）
          R.audioSamePc = true;
          // P1b：P1 漏了这一步——校准/统计都靠 RTC264.audioTrack，null 时校准直接说"音频还没连上"
          try { RTC264.audioTrack = e.track; } catch (err) { }
          try { RTC264.audioSamePcTrack = e.track; } catch (err) { }   // 2026-11-08：这条永不主动清空，关/开声音靠它恢复
          try { R.media.addTrack(e.track); } catch (err) { }
          try { vid.muted = !state.audio; } catch (err) { }
          return;
        }
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
    // 2026-11-10：WebCodecs 接收端必须在「接收开始之前」挂上 transform。
    // 放在 setRemoteDescription 之后（此时 receivers 已按 offer 创建）、setLocalDescription 之前。
    // 之前放在 ontrack 里太晚了 —— 那时 RTP 已经在往浏览器解码器送，transform 挂上去收不到流。
    try { tryStartWC264(pc); } catch (e0) { }
    try { wc264WatchLoss(); } catch (e0b) { }
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await new Promise(function (r) {
      if (pc.iceGatheringState === 'complete') return r();
      pc.onicegatheringstatechange = function () { if (pc.iceGatheringState === 'complete') r(); };
      setTimeout(r, 2500);
    });
    if (my !== rtc264Gen) return;
    const ar = await (await fetch('/rtc264/answer?stream=' + (RTC264.stream || 1), {
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
// 2026-11-12：**HEVC 能力探测**（模块级，页面加载后只跑一次，结果缓存在 __hevcCap）。
// 为什么要探：HEVC 能不能上的唯一未知项就是"这台手机能不能解 HEVC"。
// 每 30 秒的诊断里带上这四个 0/1，电脑端 grep 一下就有答案，不用让用户在手机上开控制台：
//   wc     = WebCodecs 能配 hvc1（软解或硬解，任一支持）
//   hw     = WebCodecs 在 prefer-hardware 下能配 hvc1（有硬件解码器）
//   main10 = 能配 Main10（10bit，将来 HDR 用）
//   rtp    = WebRTC 收发能力里有 video/H265（SDP 协商能不能谈）
//   done/err = 探测是否跑完 / 有没有异常（区分"不支持"和"探测失败"）
var __hevcCap = { wc: 0, hw: 0, main10: 0, rtp: 0, done: 0, err: 0 };
try {
  if (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities) {
    var _hevcCapRtp = RTCRtpReceiver.getCapabilities('video');
    if (_hevcCapRtp && _hevcCapRtp.codecs) {
      __hevcCap.rtp = _hevcCapRtp.codecs.some(function (c) { return /H265|HEVC/i.test(String(c.mimeType || '')); }) ? 1 : 0;
    }
  }
} catch (e) { __hevcCap.err++; }
try {
  if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
    __hevcCap.err++;                       // 没有 WebCodecs（老浏览器）
  } else {
    (function () {
      var left = 3;
      var probe = function (codec, hw, key) {
        var cfg = { codec: codec, optimizeForLatency: true };
        if (hw) cfg.hardwareAcceleration = hw;
        var fin = function () { left--; if (left <= 0) __hevcCap.done = 1; };
        try {
          VideoDecoder.isConfigSupported(cfg).then(function (r) {
            if (r && r.supported) __hevcCap[key] = 1;
            fin();
          }).catch(function () { __hevcCap.err++; fin(); });
        } catch (e) { __hevcCap.err++; fin(); }
      };
      probe('hvc1.1.6.L123.B0', null, 'wc');
      probe('hvc1.1.6.L123.B0', 'prefer-hardware', 'hw');
      probe('hvc1.2.4.L123.B0', 'prefer-hardware', 'main10');
    })();
  }
} catch (e) { __hevcCap.err++; }

async function rtc264Stats() {
  const R = RTC264, pc = R.pc;
  if (!pc) return;
  // 2026-11-10：把 video 元素尺寸贴合到视频实际显示区域（object-fit:contain 后的区域），
  // 不再撑满全屏。原来 #vid 是 width:100%;height:100% + contain —— 元素仍占满屏幕，
  // 浏览器按整个元素面积合成。实测：全屏时渲染管线跟不上 → 积压 → Chrome 自适应加大
  // jitter buffer → 「缓」1 分钟涨到 300ms（安卓和 iPhone 17 Pro 一样）；
  // 把元素缩到 480px 宽后缓冲立刻不涨。这里按原比例居中，视觉上和以前一模一样（黑边由容器背景提供）。
  try {
    if (vid && vid.videoWidth > 0) {
      const _pe = vid.parentElement || document.body;
      const _cw = _pe.clientWidth || window.innerWidth;
      const _ch = _pe.clientHeight || window.innerHeight;
      const _va = vid.videoWidth / vid.videoHeight;
      const _ca = _cw / _ch;
      let _w, _h;
      if (_va > _ca) { _w = _cw; _h = Math.round(_cw / _va); } else { _h = _ch; _w = Math.round(_ch * _va); }
      if (Math.abs((vid.clientWidth || 0) - _w) > 2 || Math.abs((vid.clientHeight || 0) - _h) > 2) {
        vid.style.inset = "auto";
        vid.style.left = Math.round((_cw - _w) / 2) + "px";
        vid.style.top = Math.round((_ch - _h) / 2) + "px";
        vid.style.width = _w + "px";
        vid.style.height = _h + "px";
      }
    }
  } catch (e) { }
  try {
    const st = await pc.getStats();
    const cands = {};
    let br = 0, fr = 0, fd = 0, path = '', jb = 0, jbc = 0, lost = 0, pli = 0;
    let bestPair = null, bestBytes = -1;
    st.forEach(function (r) { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
    st.forEach(function (r) {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        br = r.bytesReceived || 0; fr = r.framesReceived || 0; fd = r.framesDecoded || 0;
        jb = r.jitterBufferDelay || 0; jbc = r.jitterBufferEmittedCount || 0;
        lost = r.packetsLost || 0;
        pli = r.pliCount || 0;
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
    // 2026-11-10：WebCodecs 接收端启用后，RTP 被 transform 拦走，<video> 拿不到解码权，
    // videoWidth 永远是 0。原来只看 videoWidth 会把 firstVideo 一直判成 false，
    // 12 秒后 watchdog 触发 rtc264Retry -> 黑屏重连 -> 又 12 秒 -> 无限循环。
    // 所以两种"有画面"都算：<video> 有尺寸，或者 WebCodecs 已经绘出过帧。
    const wcAlive = !!(window.__wc264 && window.__wc264.on && window.__wc264.frames > 0);
    if (vw > 0 || wcAlive) {
      if (!R.firstVideo) R.playStart = Date.now();   // 出第一帧的时刻：头 2 秒的帧率不可信
    if (!R.firstVideo) { clearTimeout(R.noVideoTimer); R.noVideoTimer = 0; }
      R.firstVideo = true; R.attempts = 0;
      if (R.watchdog) { clearTimeout(R.watchdog); R.watchdog = null; }
      // 首次出画面后给一次流量提醒（每台设备只提示一次）。
      // 2026-11-10：GB/时 不再写死 8.9 —— 发布版和自用版用同一套码率上限，默认码率也可能被改到
      // 50/100 Mbps，写死的数字会变成假话。这里按**实际生效的码率**算。
      if (!R.flowHinted) {
        R.flowHinted = true;
        try {
          if (localStorage.getItem('hint.flow') !== '1') {
            localStorage.setItem('hint.flow', '1');
            setTimeout(function () {
              // 问服务端当前实际生效的码率，别猜
              fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                  const k = Number(j && j.kbps) || 20000;
                  const gb = Math.round((k * 3600) / 8 / 1024 / 1024 * 10) / 10;
                  try { setNote('提示：清晰模式很费流量（约 ' + gb + ' GB/小时）；用手机流量时建议调低画质，或点「流畅」', 9000); } catch (e) { }
                })
                .catch(function () {
                  try { setNote('提示：清晰模式很费流量；用手机流量时建议调低画质，或点「流畅」', 9000); } catch (e) { }
                });
            }, 6000);
          }
        } catch (e) { }
      }
    }
    // 冻结自愈：前台时 framesReceived 不再增长（服务端重启/链路假死）就主动重连。
    // 注意不能用 video.currentTime 判断——MediaStream 的 currentTime 是照播的，
    // 服务端死了它也照涨（上一版就踩了这个坑，画面冻结 20 秒都没重连）。
    // 2026-11-09 修：画面**静止**时编码器会降码率，某些 2.5 秒窗口里 bytes 可能真的不涨，
    // 于是被误判成"冻结"→ 强制重连 → 用户看到帧率掉成"…"并卡一下（用户实测反馈）。
    // 现在多一道确认：先问服务端 /h264-status，它还活着就只清零计时、不重连。
    const nowMs = Date.now();
    if (!document.hidden && vw > 0) {
      if (fr > (R.lastFr || 0) || br > (R.lastBr || 0)) { R.lastFr = fr; R.lastBr = br; R.frozenSince = 0; }
      else if (!R.frozenSince) { R.frozenSince = nowMs; }
      else if (nowMs - R.frozenSince > 2500 && !R.frozenProbe) {
        R.frozenProbe = true;
        const since = R.frozenSince;
        serverUp264().then(function (up) {
          R.frozenProbe = false;
          if (R.frozenSince !== since) return;          // 期间有新帧了，什么都不用做
          if (up) {
            // 服务端活着 → 只是画面静止（编码器低频输出），不清零会影响后续判断，但绝不重连
            try { console.log('rtc264: 2.5s 无新帧但服务端在线（画面静止），不重连'); } catch (e) { }
            R.frozenSince = 0;
            R.lastFr = fr; R.lastBr = br;
            return;
          }
          R.frozenSince = 0; R.lastFr = fr; R.lastBr = br;
          try { console.log('rtc264: 画面冻结（服务端也失联），主动重连'); } catch (e) { }
          rtc264Retry('frozen');
        }).catch(function () {
          R.frozenProbe = false;
          R.frozenSince = 0; R.lastFr = fr; R.lastBr = br;
          rtc264Retry('frozen');
        });
        return;
      }
    } else { R.lastFr = fr; R.lastBr = br; R.frozenSince = 0; }
    const how = path === 'relay' ? '中继' : (path === 'srflx' || path === 'prflx' ? '直连(NAT)' : (path === 'host' ? '直连' : pc.iceConnectionState));
    // 2026-11-10：WebCodecs 模式下画面不走浏览器 jitter buffer，
    // 实测「缓」涨到 300ms 时 WebCodecs 那边的帧率仍是 87fps、延迟由我们自己的解码管线决定。
    // 所以这里在 WebCodecs 生效时显示真实链路延迟（帧从解码到绘制的间隔），而不是误导性的 jitterBufferDelay。
    let _wcBufOverride = -1;
    try {
      // 2026-11-11 看门狗（第三版）：改成"有恢复路径"的状态机。
      //
      // 第二版的两个硬伤（今天实测确认）：
      //   ① 重建接收端后没有重置 lastFrameAt → 看门狗拿着**重建前**的旧时间戳继续判"卡住"，
      //      3 次重建名额在约 5 秒内烧光，于是过早 gaveUp；
      //   ② 外层条件是 __wc264.on && ...，gaveUp 把 on 置 false 之后**整块看门狗不再执行** ——
      //      冷却、重连、任何恢复路径都没有了，只能整页刷新/重连才回来。
      //      这正是"画面静止 + 不停重新连接"的成因（也违反 10287a02：false 必须有恢复路径）。
      //
      // 第三版的规则：
      //   · 只在"该有画面"时判卡：清晰模式 + 页面可见 + PeerConnection 已连接；
      //   · 出帧即清零连续失败计数（restarts 是**连续**失败数，不是终身计数）；
      //   · 放弃 ≠ 永久：救不回就回退浏览器解码，**60 秒后自动再试**；
      //   · 另外盯住浏览器解码这条兜底路：两条路都 >10 秒没有新帧 → 才升级成一次重连，
      //     并且限流 60 秒一次，避免变成"重连风暴"。
      const _wc0 = window.__wc264;
      if (_wc0 && _wc0.lastFrameAt) {
        if (_wc0.on) _wcBufOverride = Math.max(0, Date.now() - _wc0.lastFrameAt);
        try {
          const _wc = _wc0;
          const _R = window.__rtc264 || {};
          const _pc2 = _R.pc;
          const _pcAlive = !!(_pc2 && (_pc2.connectionState === 'connected' || _pc2.connectionState === 'completed'));
          const _now = Date.now();
          const _shouldBeLive = (state.mode === 'h264') && !document.hidden && _pcAlive;
          if (!_shouldBeLive) {
            // 切后台 / 换模式 / 电脑端没连上：不判卡，也不累积任何"卡住"的状态
            _wc._lastDec = undefined; _wc._lastRtp = undefined;
            _wc._vidFramesLast = undefined; _wc._vidStallSince = 0;
          } else {
            // 冷却结束 → 重新武装（恢复路径）
            if (_wc.gaveUp && (_now - (_wc.gaveUpAt || 0)) > 60000) {
              try { console.log("wc264: 冷却结束，重新尝试 WebCodecs"); } catch (e0) { }
              _wc.gaveUp = false; _wc.restarts = 0; _wc.lastFrameAt = _now;
              _wc._lastDec = undefined; _wc._lastRtp = undefined;
              try { if (_pc2) _wc.start(_pc2); } catch (e1) { }
            }
            if (_wc.on) {
              // ---- WebCodecs 生效中：判"卡了"或"解码器僵死" ----
              const _st = _wc.stats;
              let _stuck = false;
              if (_st) {
                const _rtpNow = Number(_st.rtp || 0), _decNow = Number(_st.decoded || 0);
                // 僵死：RTP 还在进（至少 30 包）但解出来的帧数不涨 —— 光看时间戳发现不了
                if (_wc._lastDec !== undefined && _wc._lastRtp !== undefined
                  && (_rtpNow - _wc._lastRtp) >= 30 && _decNow <= _wc._lastDec) _stuck = true;
                _wc._lastDec = _decNow; _wc._lastRtp = _rtpNow;
              }
              const _stall = _now - (_wc.lastFrameAt || 0);
              if (!_wc.restarting && (_stall > 8000 || _stuck)) {
                _wc.restarts = (_wc.restarts || 0) + 1;
                if (_wc.restarts <= 3) {
                  _wc.restarting = true;
                  try { console.log("wc264: " + (_stuck ? "解码器僵死" : "卡了 " + _stall + "ms") + "，第 " + _wc.restarts + " 次重建接收端"); } catch (e2) { }
                  try { _wc.stop(); } catch (e3) { }
                  setTimeout(function () {
                    try { _wc.restarting = false; } catch (e4) { }
                    try {
                      const _p3 = window.__rtc264 && window.__rtc264.pc;
                      if (_p3 && state.mode === 'h264' && !_wc.on) {
                        _wc.lastFrameAt = Date.now();   // 给新接收端宽限期，别让旧时间戳立刻再触发一轮
                        _wc._lastDec = undefined; _wc._lastRtp = undefined;
                        _wc.start(_p3);
                      }
                    } catch (e5) { }
                  }, 1200);
                } else if (!_wc.gaveUp) {
                  _wc.gaveUp = true; _wc.gaveUpAt = _now;
                  try { console.log("wc264: 连续 3 次重建都没救回来，先回退浏览器解码，60 秒后自动再试"); } catch (e6) { }
                  try { _wc.stop(); } catch (e7) { }
                }
              }
            } else {
              // ---- WebCodecs 没启用（不支持 / 冷却中 / 刚 stop）：盯住浏览器解码这条兜底路 ----
              try {
                // 必须先确认"确实有视频轨道"（videoWidth>0），否则还没接到画面就会误判成
                // "两条路都死"，每 60 秒白重连一次（真机上会表现成莫名其妙的周期性重连）。
                const _vid = document.getElementById('vid');
                const _hasTrack = !!(_vid && _vid.videoWidth > 0);
                if (!_hasTrack) {
                  _wc._vidFramesLast = undefined; _wc._vidStallSince = 0;
                } else {
                  const _vfc = videoFrameCount();
                  if (_wc._vidFramesLast === undefined || _vfc > _wc._vidFramesLast) {
                    _wc._vidFramesLast = _vfc; _wc._vidStallSince = 0;
                  } else if (!_wc._vidStallSince) {
                    _wc._vidStallSince = _now;
                  } else if ((_now - _wc._vidStallSince) > 10000 && (_now - (_wc._mediaRetryAt || 0)) > 60000) {
                    _wc._mediaRetryAt = _now; _wc._vidStallSince = 0; _wc.restarts = 0;
                    try { console.log("wc264: WebCodecs 与浏览器解码都没有新帧（>10s），重连会话"); } catch (e8) { }
                    try { rtc264Retry('media-dead'); } catch (e9) { }
                  }
                }
              } catch (e10) { }
            }
          }
        } catch (e) { }
      }
    } catch (e) { }
    const bufMs = jbc > 0 ? Math.round((jb / jbc) * 1000) : 0;

    // 2026-11-10：解码器扛不住当前帧率 → 自动降档（手机端实测：解码队列攒到 1481 帧 ≈25 秒，
    // 画面越拖越卡、HUD 显示静止，而丢包/PLI 全是 0）。
    //
    // 2026-11-10 第二次修（用户反馈"有时候会误判"）：判据从"一次队列事件"改成**持续性**判定。
    // 之前的两个误判来源：
    //   · 场景突变（全屏/换窗口）会吐巨帧（历史实测单帧 688KB），解码器瞬时卡一下就把队列顶到 30，
    //     清空后可能再顶一次 → 12 秒内 2 次重建 → 直接降半档，而设备其实完全够用；
    //   · 只砍半（240→120→60→30）步骤太粗，且**只降不升**，一次瞬时误判会挂一整个会话。
    // 现在的判据（三选二不算，必须同时满足）：
    //   ① worker 因队列堆积重建过 ≥2 次（清空后又堆 = 真的吃不下，不是一次抖动）；
    //   ② 最近 10 秒（5 个采样）我们**自己画布的出帧率**平均不到输入帧率的 85%
    //      —— 这是"设备真的解不动"的直接证据，场景突变不会把 10 秒平均拉下来；
    //   再加上 90 秒冷却；降一档（按 30/60/90/120/240 标准档位，不再砍半）。
    // 恢复：连续 5 个采样画满 90% 且期间没重建 → 计一次"稳定"，攒够 15 次（约 30 秒）回一档，
    // 每次会话最多回 2 档、且不超过用户存过的选择（hqFps）—— 误判能自己修回来，也不会来回抖。
    try {
      const _w = window.__wc264;
      if (_w && _w.on && _w.stats) {
        const _now = Date.now();
        const _rs = _w.resyncs | 0;
        // ① worker 重建计数变化
        if (_rs !== (_w._rsSeen | 0)) { _w._rsSeen = _rs; _w._rsAt = _now; }
        // ② 自己画布的出帧率（2 秒一个采样，保留 5 个 ≈10 秒）
        const _nf = _w.frames | 0;
        if (!RTC264.drawAt) { RTC264.drawAt = _now; RTC264.drawN = _nf; }
        else if (_now - RTC264.drawAt >= 1500) {
          const _dt = (_now - RTC264.drawAt) / 1000;
          const _df = (_nf - (RTC264.drawN | 0)) / _dt;
          RTC264.drawAt = _now; RTC264.drawN = _nf;
          RTC264.dw = RTC264.dw || [];
          RTC264.dw.push(Math.max(0, _df));
          if (RTC264.dw.length > 10) RTC264.dw.shift();
        }
        const _avgDraw = (RTC264.dw && RTC264.dw.length >= 8)
          ? (RTC264.dw.reduce(function (a, b) { return a + b; }, 0) / RTC264.dw.length) : 0;
        // 2026-11-10 修（独立审查 P1-1）：inFps 原来只在 h264QualityBind 里赋值，而那个函数
        // 只有"用户打开设置面板"才跑 → 不开设置，_need 恒为 false，自动降档**永不触发**（功能回归）。
        // 现在每 ~10 秒直接问服务端要一次当前帧率，与设置面板解耦。
        if (!RTC264.inFpsAt || _now - RTC264.inFpsAt > 10000) {
          if (!RTC264.inFpsAt) RTC264.inFpsAt = _now;   // 防抖：请求在飞的时候不要连发
          fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              const f = Number(j && j.fps) || 0;
              if (f > 0) { RTC264.inFps = f; RTC264.inFpsAt = Date.now(); }
            })
            .catch(function () { });
        }
        const _in = Number(RTC264.inFps) || 0;
        // 2026-11-12（重要）：**页面在后台/息屏时，两条降档判据都必须跳过**。
        // 实测踩到：手机切后台后 rAF 掉到 30、画出也跟着掉，于是被判成"设备吃不下"，
        // 一路降到 30fps；用户切回来时画面糊成一片，还得手动改回去。
        const _hidden = (typeof document !== 'undefined' && document.hidden === true);
        const _need = !_hidden && _in > 0 && _avgDraw > 0 && _avgDraw < _in * 0.85;
        const _rsHot = (_rs >= 2 && _w._rsAt && _now - _w._rsAt < 12000);
        // 启动宽限：连上后的前 15 秒出帧率天然偏低（解码器预热 + 首批关键帧），不参与判断。
        // 实测启动瞬间 worker 也会因为首批突发重建 1~2 次，两个信号凑一起会误判成"设备吃不下"。
        const _warm = _now - (R.playStart || 0) < 15000;
        // 2026-11-12（A 方案：跟随实际刷新率）：新增第二条降档依据。
        // 实测手机上：屏幕 120Hz，但 **WebView 的 rAF 只给到 ~104** → 编码 120 时
        // 每 5 帧就丢 1 帧（diag 里 over 一直涨），画面反而比"编码降到屏幕能给的值"更抖。
        // 这条不要求 worker 重建（_rsHot），只看持续性的出帧不足，且用稳定后的 _dispRate
        // 判断，避免被瞬时抖动误伤。步进仍走标准档位（30/60/90/120/240）。
        const _dispLow = (typeof _dispRate === 'number' && _dispRate >= 60 &&
                          _in > 0 && _dispRate < _in * 0.88);
        // 2026-11-12（傍晚）：节流（页面不可见 / rAF 被浏览器压低）期间**绝不自动降档**。
        // 实测踩过：手机变暗的几十秒里画出率掉到 76/120，页面把它当成"解不动"自动降到 90fps，
        // 写进会话后整段画质就低了一档 —— 根因根本不是设备能力。
        const _thrNow = (typeof _pqThrottled === 'function') ? _pqThrottled() : false;
        const _need2 = !_hidden && !_thrNow && !_warm && _dispLow && _avgDraw > 0 && _avgDraw < _in * 0.92;
        if (((_need && _rsHot) || _need2) && !RTC264.downshifting && _now - (RTC264.lastDown | 0) > 90000) {
          RTC264.downshifting = true;
          RTC264.lastDown = _now;
          RTC264.goodTicks = 0;
          (async function () {
            try {
              const j = await (await fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json();
              const cur = Number(j && j.fps) || 60;
              const STEPS = [30, 60, 90, 120, 240];
              let next = 30;
              for (const st of STEPS) { if (st < cur) next = st; }      // 取"比当前小的最大标准档"
              if (next >= cur) { RTC264.downshifting = false; return; } // 已经在最低档
              if (!RTC264.userTarget) RTC264.userTarget = cur;          // 记下用户原本要的档
              setStat('解码跟不上（' + Math.round(_avgDraw) + '/' + cur + 'fps），本次临时降到 ' + next + 'fps…');
              // 2026-11-10 修（重要）：自动降档**只对本次会话生效，不写进记忆**。
              // 之前把降档结果写进 localStorage，结果一次瞬时卡顿（例如手机上同时开了两个页面、
              // 两份解码抢同一个硬件解码器）就被当成"设备上限"永久记住；实测这台手机单独跑
              // 1920x1200@121fps / 54Mbps 完全正常（q=0、丢包 0）——降档把它冤枉地压成了 30fps。
              // 现在：自动降档只发 auto:true 的请求（服务端也不落盘），用户自己的选择永远不变；
              // 刷新页面 / 手动选画质就回到用户想要的值。
              const rj = await (await fetch('/h264-quality', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ fps: next, auto: true })
              })).json();
              // 审查 P1-2：基线必须用**服务端实际生效的值**回填（原来写的是降档前的 cur，
              // 导致恢复判据（next 必须大于当前值）永远达不到、_need 长期误判为真 → 可能二次误降）。
              const applied = Number(rj && rj.fps) || next;
              RTC264.inFps = applied;
              RTC264.inFpsAt = Date.now();
              RTC264.downgraded = true;                                 // 只有真降过档才允许走恢复路径
              try { const _fs = document.getElementById('hqFps'); if (_fs) _fs.value = String(applied); } catch (e) { }
              RTC264.dw = [];   // 重新攒窗口，别拿降档前的旧值触发下一步
              setMsg('这台设备解码跟不上，本次已临时降到 ' + applied + 'fps（可在设置里改回；刷新页面也会恢复）', '#ffb454');
            } catch (e2) { } finally { RTC264.downshifting = false; }
          })();
        }
      }
    } catch (e) { }
    // 2026-11-10：自动降档的**恢复路径**（误判自愈，别只降不升）。
    // 判据：**确实降过档**（RTC264.downgraded）＋最近 16~20 秒（≥8 个采样）画布出帧率平均 ≥ 输入帧率的 90%
    // ＋这 20 秒内 worker 没再重建过。攒够 15 个这样的采样（约 30 秒）→ 回一档；每次会话最多回 2 档、
    // 两次之间至少 30 秒，且绝不超过用户存过的选择（hqFps）。
    // 审查 P1-2：原来没有"曾降档"前置 → 打开过一次设置的健康设备会在 30~60 秒后被主动升档（还杀 ffmpeg 重启）。
    try {
      const _w2 = window.__wc264;
      const _in2 = Number(RTC264.inFps) || 0;
      if (_w2 && _w2.on && _in2 > 0 && RTC264.dw && RTC264.dw.length >= 8) {
        const _now2 = Date.now();
        const _avg2 = RTC264.dw.reduce(function (a, b) { return a + b; }, 0) / RTC264.dw.length;
        const _stable = _avg2 >= _in2 * 0.9 && !(_now2 - (_w2._rsAt | 0) < 20000);
        RTC264.goodTicks = _stable ? ((RTC264.goodTicks | 0) + 1) : 0;
        const _want = Number(localStorage.getItem('hqFps') || 0) || Number(RTC264.userTarget || 0) || 0;
        const _ups = RTC264.ups | 0;
        if (RTC264.downgraded && _want > _in2 && RTC264.goodTicks >= 15 && _ups < 2 &&
            _now2 - (RTC264.lastUp | 0) > 30000 && !RTC264.downshifting) {
          RTC264.goodTicks = 0;
          RTC264.lastUp = _now2;
          RTC264.ups = _ups + 1;
          (async function () {
            try {
              const j = await (await fetch('/h264-quality?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json();
              const cur = Number(j && j.fps) || 0;
              const STEPS = [30, 60, 90, 120, 240];
              let next = 0;
              for (const st of STEPS) { if (st > cur && st <= _want) { next = st; break; } }
              if (!next || next <= cur) return;
              setStat('解码跟得上了，恢复到 ' + next + 'fps…');
              const rj = await (await fetch('/h264-quality', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ fps: next, auto: true })
              })).json();
              // 审查 P1-2：用服务端实际生效值回填基线；已回到用户要的档就不再算"降档中"，
              // 否则恢复路径会一直挂着、反复尝试。
              const applied = Number(rj && rj.fps) || next;
              RTC264.inFps = applied;
              RTC264.inFpsAt = Date.now();
              // 审查 P1-3：**不要在这里清 ups**（原来清了 → "每次会话最多回 2 档"的额度被还回去 →
              // 对确实吃不下目标档的设备会 60⇄90 无限振荡，88 秒一轮、每轮两次编码器重启）。
              // ups 只由"用户手动改画质"（apply）清零；自动路径用满 2 档就停在低档不再升。
              if (!_want || applied >= _want) { RTC264.downgraded = false; }
              RTC264.dw = [];
              try { const _fs = document.getElementById('hqFps'); if (_fs) _fs.value = String(applied); } catch (e3) { }
              setMsg('画面已经跟得上，帧率恢复到 ' + applied + 'fps', '#8CE58C');
            } catch (e4) { }
          })();
        }
      }
    } catch (e) { }
    // 我们自己的解码器看不到 RTP 序号（transform 拿到的是完整帧），网络丢包时它会把
    // 依赖丢失帧的那些 P 帧照旧解下去 —— 结果就是一整片花屏，直到下一个 IDR（GOP 0.5 秒）。
    // 浏览器自带管线遇到缺包会直接丢弃这些帧，我们绕过了它，所以得自己补这一刀。
    //
    // 注意：真正干活的是下面的 wc264WatchLoss()（600ms 一次，反应快得多）。
    // 这里只做兜底同步（它 2 秒才跑一次，等它发现花屏早就显示 1~2 秒了），
    // 所以不再重复计数、也不再重复发消息，只把基线对上，避免快速轮询那边误判。
    try {
      const _wc = window.__wc264;
      if (_wc && _wc.on) _wc._lastLost = lost;
    } catch (e) { }
    // 2026-11-10：缓冲自愈。Chrome/WebKit 接收端的 jitter buffer 在"零丢包、零抖动、速率匹配"
    // 的情况下仍会缓慢膨胀（实测 60fps 与 30fps 涨速一样，与帧率/分辨率/网络无关），
    // 页面侧没有 API 能压住它（jitterBufferTarget=0 实测无效）。唯一能让延迟回到低位的手段
    // 是重建 PeerConnection。这里做阈值触发 + 30 秒冷却，避免频繁闪烁。
    try {
      const _now = Date.now();
      // 2026-11-10 修：WebCodecs 生效时不要做这个判断。
      // bufMs 来自浏览器的 jitterBufferDelay，它照涨；但 WebCodecs 模式下画面根本不走它，
      // 之前没排除，于是每 30 秒被误判"缓冲过高"触发一次 rtc264Retry ——
      // 用户看到的"经常黑屏重启"，侧车日志里就是每 29 秒一次 pc-closed。
      const _wcActive = !!(window.__wc264 && window.__wc264.on);
      if (!_wcActive && bufMs >= 200 && !RTC264.resyncing && _now - (RTC264.lastResync || 0) > 30000) {
        RTC264.resyncing = true;
        RTC264.lastResync = _now;
        setStat('缓冲过高，正在同步…');
        setTimeout(function () {
          try { RTC264.resyncing = false; } catch (e2) { }
          try { rtc264Retry('buffer-high'); } catch (e3) { }
        }, 600);
      }
    } catch (e) { }
    let res = vw ? vw + 'x' + vid.videoHeight : '连接中';
    // 2026-11-10：WebCodecs 模式下画面走画布、<video> 不接管，videoWidth 可能一直是 0，
    // HUD 就永远显示"连接中"（用户排查时完全看不出真实分辨率）。有画布就用画布的尺寸。
    try {
      const _cv = (window.__wc264 && window.__wc264.on) ? window.__wc264.canvas : null;
      if (_cv && _cv.width > 0) res = _cv.width + 'x' + _cv.height;
    } catch (e) { }
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
    // 2026-11-09：帧率显示分三种情况，别再把"画面静止"显示成"…"（用户会以为出故障）。
    //   · 刚连上的 2.5 秒内：解码器还没稳定，显示 …
    //   · 正常有帧：显示实际帧率
    //   · 帧率归零（画面没变化，编码器低频输出）：显示"静止"
    // 2026-11-10 修：WebCodecs 生效时 **必须用我们自己画布的出帧率**。
    // R.qFps 来自浏览器内置解码器的 framesDecoded，手机端它可能一直是 0（那份解码被饿着），
    // 于是画面明明在动、HUD 却永远显示"静止"——用户会以为卡死了（实测踩过）。
    let _fpsShow = R.qFps;
    let _drawFps = 0;
    try {
      const _w = window.__wc264;
      const _pq = window.__pq;
      if (_w && _w.on) {
        const _now = Date.now();
        const _arr = _pq ? (_pq.arrived | 0) : (_w.frames | 0);
        const _drw = _pq ? (_pq.drawn | 0) : (_w.frames | 0);
        if (_w._hudLastAt && _now - _w._hudLastAt > 200) {
          const _dt = (_now - _w._hudLastAt) / 1000;
          const _dA = _arr - (_w._hudLastArrived | 0);
          const _dD = _drw - (_w._hudLastDrawn | 0);
          // 2026-11-11：HUD 的帧率必须区分两件事 ——
          //   _hudFps     = **解码/接收**帧率（编码器实际给了多少帧，用户设置的那个数字）
          //   _hudDrawFps = **实际呈现**帧率（受屏幕刷新率上限约束）
          // 上一版改成"出帧由调度器驱动"之后，HUD 拿画到屏幕的帧数冒充帧率，
          // 于是 60Hz 屏上永远显示 60，用户改 120/240 都像没生效（实际是屏幕吃不下）。
          if (_dt > 0 && _dA >= 0) _w._hudFps = _dA / _dt;
          if (_dt > 0 && _dD >= 0) _w._hudDrawFps = _dD / _dt;
          // 2026-11-11：<video> 元素自己解出来的帧率。和 _hudDrawFps 对比就能判断
          // 是不是"canvas 合成被限速"（?wc=0 时走这条路）。
          try {
            const _vfc = videoFrameCount();
            const _dV = _vfc - (_w._hudLastVfc | 0);
            if (_dt > 0 && _dV >= 0) _w._hudVidFps = _dV / _dt;
            _w._hudLastVfc = _vfc;
          } catch (e) { }
          _w._hudLastArrived = _arr;
          _w._hudLastDrawn = _drw;
          _w._hudLastAt = _now;
        } else if (!_w._hudLastAt) {
          _w._hudLastAt = _now;
          try { _w._hudLastVfc = videoFrameCount(); } catch (e) { }
          _w._hudLastArrived = _arr;
          _w._hudLastDrawn = _drw;
        }
        if (typeof _w._hudFps === 'number') { _fpsShow = _w._hudFps; _drawFps = _w._hudDrawFps || 0; }
      }
      // 2026-11-11：video 元素自身的呈现帧率 —— **必须在 WebCodecs 关闭时也测**。
      // 上一版把它写在上面的 _w.on 判断里，而 ?wc=0（video 路径）时 on 为 false，
      // 于是日志里永远是 vid=0，没法判断 video 路径到底能呈现多少帧（B 实验白跑）。
      try {
        const _vEl = document.getElementById('vid');
        if (_w && _vEl && _vEl.videoWidth > 0) {
          const _now2 = Date.now();
          if (_w._vidLastAt && _now2 - _w._vidLastAt > 200) {
            const _dt2 = (_now2 - _w._vidLastAt) / 1000;
            const _c2 = videoFrameCount();
            const _dc2 = _c2 - (_w._vidLastC | 0);
            if (_dt2 > 0 && _dc2 >= 0) _w._hudVidFps = _dc2 / _dt2;
            _w._vidLastC = _c2; _w._vidLastAt = _now2;
          } else if (!_w._vidLastAt) {
            _w._vidLastAt = _now2; _w._vidLastC = videoFrameCount();
          }
        }
      } catch (e) { }
    } catch (e) { }
    const connMs = Date.now() - (R.playStart || 0);
    let fpsTxt;
    if (connMs < 2500) fpsTxt = '… fps';
    else if (_fpsShow > 0.05) {
      fpsTxt = _fpsShow.toFixed(1) + ' fps';
      // 2026-11-11：屏幕刷新率低于内容帧率时，把"实际呈现"也标出来。
      // canvas 路径看 _drawFps；video 路径（?wc=0）看 _hudVidFps。
      const _dispFps = (_drawFps > 0.5) ? _drawFps : ((window.__wc264 && window.__wc264._hudVidFps) || 0);
      if (_dispFps > 0.5 && (_fpsShow - _dispFps) > _fpsShow * 0.15) fpsTxt += '·显示' + _dispFps.toFixed(0);
    }
    else fpsTxt = '静止';
    const mbpsTxt = R.qMbps > 0 ? R.qMbps.toFixed(1) + ' Mbps' : '';
    // 手机端 #stat 是隐藏的，HUD 才是用户看到的；HUD 只放「帧率 · 码率 · 缓冲」，
    // 累计帧数和累计流量放 #stat，给桌面排查用。
      // 2026-11-10 诊断标记：显示 video 元素实际渲染尺寸，便于确认「贴合尺寸」逻辑是否生效
      let _fitTag = '';
      try {
        const _v = document.getElementById('vid');
        if (_v && _v.videoWidth > 0) {
          const _pe = _v.parentElement;
          const _cw = _pe ? _pe.clientWidth : 0; const _ch = _pe ? _pe.clientHeight : 0;
          _fitTag = ' [画' + (_v.clientWidth||0) + 'x' + (_v.clientHeight||0) + '/' + _cw + 'x' + _ch + ']';
          // 2026-11-10：能力检测 —— WebCodecs 自研接收端方案的前提
          try {
            const _f = [];
            if (typeof RTCRtpScriptTransform !== 'undefined') _f.push('RTP-TF');
            if (typeof MediaStreamTrackProcessor !== 'undefined') _f.push('MSTP');
            if (typeof VideoDecoder !== 'undefined') _f.push('VD');
            if (typeof OffscreenCanvas !== 'undefined') _f.push('OC');
            if (typeof VideoFrame !== 'undefined') _f.push('VF');
            _fitTag += ' {' + _f.join('/') + '}';
            try { const _hw = window.__wc264 && window.__wc264.hw; if (_hw) _fitTag += " hw=" + _hw; } catch (e) { }
          } catch (e) { }
        }
      } catch (e) { }
    RTC264.hudText = 'WebRTC264 ' + how + ' · ' + res + ' · ' + fpsTxt
      + (mbpsTxt ? ' · ' + mbpsTxt : '')
      + ' · 缓' + ((_wcBufOverride >= 0 ? _wcBufOverride : bufMs)) + 'ms' + (_wcBufOverride >= 0 ? '(WC)' : '') + autoqTag() + _fitTag;
    // 2026-11-10：把 WebCodecs 接收端的健康度也放进来（桌面排查用，手机上看不到 #stat）：
    //   cfg=解码器重建次数 缺=时间戳跳档/丢包断链次数 丢=被丢弃的帧数（启动阶段+断链等待）
    let _wcDiag = '';
    try {
      const _wd = window.__wc264;
      if (_wd && _wd.on && _wd.stats) {
        _wcDiag = ' · WC cfg' + (_wd.stats.cfg | 0)
          + ' 断链' + (_wd.stats.gaps | 0)
          + ' 丢' + (_wd.stats.dropped | 0)
          + ' ts' + (_wd.stats.tsEma | 0) + '/' + (_wd.stats.tsMax | 0) + 't';
      }
    } catch (e) { }
    setStat(RTC264.hudText + ' · 帧' + fr + '/解' + fd + ' · 收' + Math.round(br / 1024) + 'KB' + _wcDiag);

    // 2026-11-10：每 30 秒把接收端健康度报给服务端，压成一行写进 screen-server.log。
    // 花屏/冻屏只有手机端能看到真相，而安卓 Chrome 的 console 不好取 —— 出问题时
    // 直接在电脑上 grep「[wc264-diag]」就能看到手机那边的 rtp/decoded/dropped/cfg/gaps。
    // 注意：这段在 PAGE_HTML 的模板字符串里，**注释里也不能出现反引号**（会把模板截断，
    // 整个服务起不来：ReferenceError: xxx is not defined）。check-page-js.mjs 已加断言防这个。
    // 只报数字和尺寸，不含画面内容与密钥；失败一律吞掉，绝不影响播放。
    // 注：HEVC 能力探测在 __hevcCap（模块级，只跑一次），这里只把它带进诊断。

    try {
      const _now = Date.now();
      if (!window.__diagNextAt || _now > window.__diagNextAt) {
        window.__diagNextAt = _now + 30000;
        const _wd = window.__wc264 || {};
        const _cv = _wd.canvas || null;
        const body = JSON.stringify({
          on: !!_wd.on,
          hw: _wd.hw || '',
          stats: _wd.stats || null,
          cw: _cv ? _cv.width : 0, ch: _cv ? _cv.height : 0,
          vw: vid.videoWidth || 0, vh: vid.videoHeight || 0,
          fps: Math.round((R.qFps || 0) * 10) / 10,
          mbps: Math.round((R.qMbps || 0) * 10) / 10,
          // 2026-11-11：手机端刷新节奏与呈现节奏。用来判断"解码 120 但只画 60"是
          // 屏幕/浏览器上限（raf=60）还是我们渲染跟不上（raf=120 而 drawn=60）。
          raf: _rafHz,
          dispRate: (typeof _dispRate === 'number') ? _dispRate : 0,
          stalls: ((window.__pq || {}).stalls) || 0,
          // 2026-11-12（傍晚）：节流 / 断流 / 真停摆分开报 —— 压测时据此判断"这条样本是否有效"。
          // thr=1 表示浏览器把我们节流了（页面不可见或 rAF 被压低），此时的低画出率不算产品问题。
          thr: (window.__pq && window.__pq.throttled) ? 1 : 0,
          hid: (typeof document !== 'undefined' && document.hidden) ? 1 : 0,
          starveLong: ((window.__pq || {}).starveLong) | 0,
          thrGaps: ((window.__pq || {}).thrGaps) | 0,
          avalanches: ((window.__pq || {}).avalanches) || 0,
          stallGaps: (((window.__pq || {}).stallGaps) || []).join('|'),
          touchVis: (((window.__pq || {}).touchVis) || []).join('|'),
          drawnHz: Math.round((_wd._hudDrawFps || 0) * 10) / 10,
          decHz: Math.round((_wd._hudFps || 0) * 10) / 10,
          // 每帧绘制耗时（ms，EMA）。判"只画 60"到底是屏幕上限还是我们画得慢。
          drawMs: Math.round((((window.__pq || {}).drawMs) || 0) * 100) / 100,
          // 2026-11-12：**呈现循环分账**。查"解码 120 只画 95"时，一眼看出帧是被
          // 空拍吞了（sv）、被抽帧静默丢了（sk）、还是队列超限丢的（cap）。
          pq: (function () {
            const p = window.__pq || {};
            return {
              tick: p.ticks | 0, nd: p.notDue | 0, sv: p.starveN | 0, sk: p.skipN | 0, cap: p.capDrop | 0,
              drew: p.drawn | 0, arr: p.arrived | 0, perUs: Math.round(p.periodUs || 0), boost: p.boost | 0,
            };
          })(),
          // 2026-11-11：全屏状态 / WebCodecs 是否启用 / <video> 自己解出的帧率。
          // ?fs=1 看全屏能否放开高刷；?wc=0 看 video 路径能否绕过 canvas 合成限制。
          fs: !!document.fullscreenElement,
          fsTries: (window.__paFsTries | 0),
          fsErr: String(window.__paFsErr || '').slice(0, 40),
          wc: !!_wd.on,
          // 2026-11-12：WebView 里 WebCodecs 没启用（wc=0）时，到底缺哪个 API。
          // 实测 APK 的 WebView 能拿到 raf=110~121Hz（高刷请求成功！），但 wc=0，
          // 于是回落到 <video> 原生解码（延迟大）。下面两个字段用来区分：
          //   tf=0 → 没有 RTCRtpScriptTransform（那就只能走 video 路径）
          //   vd=0 → 没有 VideoDecoder（真的不支持 WebCodecs）
          tf: (typeof RTCRtpScriptTransform !== 'undefined') ? 1 : 0,
          vd: (typeof VideoDecoder !== 'undefined') ? 1 : 0,
          vidFps: Math.round((_wd._hudVidFps || 0) * 10) / 10,
          dpr: Math.round((window.devicePixelRatio || 0) * 100) / 100,
          scr: (window.screen ? (screen.width + 'x' + screen.height) : ''),
          buf: Math.round(_wcBufOverride >= 0 ? _wcBufOverride : bufMs),
          // 2026-11-10：丢包/PLI 才是"花屏"的直接线索（gaps 只是触发了几次停喂）。
          // err 改成给**末尾**一段：lastErr 前面全是启动期的 diag，解码错误恰好会被截掉。
          lost: (_wd.lost !== undefined ? _wd.lost : lost),
          pli: pli,
          err: String((_wd.lastErr || '')).slice(-160),
          // 2026-11-12：HEVC 能力（见上面的探测块）。wc/hw/main10/rtp 各 0/1，done=探测是否完成。
          hevc: __hevcCap,
          ua: navigator.userAgent
        });
        fetch('/wc264-diag?k=' + encodeURIComponent(KEY), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, cache: 'no-store' })
          .catch(function () { });
      }
    } catch (e) { }
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
  // 2026-11-08 修：**同一条 PC 送来的音频轨不归这里管**。它属于 RTC264.media 那条流，
  // 原来这里无条件 removeTrack + 清空 audioTrack，导致"关声音→再开"时轨已经找不回来，
  // 而 rtc264AudioStart() 又因为 audioSamePc 直接 return → 之后永久没声音。
  if (!A.audioSamePc) {
    if (A.audioTrack && A.media) { try { A.media.removeTrack(A.audioTrack); } catch (e) { } }
    A.audioTrack = null;
  }
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
  if (A.audioSamePc) return;         // P1：音频已由同一条 PC 送来
  if (!A.pc || A.audioPc || !state.audio) return;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sig = new WebSocket(proto + '//' + location.host + '/rtc?k=' + encodeURIComponent(KEY) + '&audio=1&s=' + SID);
    const pc = new RTCPeerConnection({ iceServers: [] });
    A.audioSig = sig;
    A.audioPc = pc;
    // 2026-11-07 诊断用：把音频连接挂到 window 上，便于在控制台/自动化里读 getStats
    // （只读句柄，不改变任何行为；排查完可以留着，对性能无影响）。
    try { window.__audioPc = pc; } catch (e) { }
    // 2026-11-07 19:0x：音频接收端补上和视频一样的低延迟提示。
    // 清晰模式的音频是**另一条纯音频 PeerConnection**，视频那条设了 jitterBufferTarget=20 /
    // playoutDelayHint=0，这条以前没设。本机回环抖动≈0 看不出差别；弱网/4G 下不设的话，
    // 音频抖动缓冲会自动涨，表现就是"声音慢慢比画面慢半拍"。这两句只是给上限，网络好时无副作用。
    pc.ontrack = function (e) {
      try {
        if (e.receiver) {
          // 2026-11-08 P1b：「声音延后」补偿在这条旧纯音频连接上也要生效（P1 失败时的回退路径）
          RTC264.audioReceiver = e.receiver;
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
    // 2026-11-08 修：音频在同一条 PC 里时，**只需要把 <video> 的静音关掉**。
    // 轨道始终留在 RTC264.media 里；不要再走"建连接/摘轨"那套（老通道才需要）。
    // 顺带兜底：万一轨被别的路径摘掉了，从这里补回去（audioSamePcTrack 不会被清空）。
    if (RTC264.audioSamePc) {
      const tr = RTC264.audioSamePcTrack || RTC264.audioTrack;
      try {
        if (RTC264.media && tr && RTC264.media.getAudioTracks().indexOf(tr) < 0) RTC264.media.addTrack(tr);
      } catch (e) { }
      vid.muted = false;
      try { if (typeof vid.play === 'function') vid.play().catch(function () { }); } catch (e) { }
      return;
    }
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
  stopRtc264('retry:' + why);
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
// 2026-11-11（C 方案）：这台设备的稳定 id（同一浏览器持久），用于"谁是主路主人"的认领。
// 没有它就只能按"有没有人在看"猜，实测会把两台设备分到同一路。
function paClientId() {
  try {
    let v = localStorage.getItem('pa-client');
    if (!v) { v = 'c' + Math.random().toString(36).slice(2, 12); localStorage.setItem('pa-client', v); }
    return v;
  } catch (e) { return 'c-nostore'; }
}

function rtc264Wanted() {
  let p = null;
  try { p = new URLSearchParams(location.search).get('rtc264'); } catch (e) { }
  if (p === '0') {
    // 2026-11-10（用户报"两台设备设置不同 → 黑屏且不恢复，必须杀掉重进"）：
    // 这个标记原来是**永久**的 —— 只要回落过一次，地址里的 rtc264=0 就一直留着
    // （"添加到主屏幕"甚至带着它重启），页面永远走不回 WebRTC → 长久黑屏。
    // 现在给它 10 分钟有效期：过期自动清掉、重新尝试 WebRTC。
    const TTL = 10 * 60 * 1000;
    let at = 0;
    try { at = Number(sessionStorage.getItem('rtc264OffAt') || 0); } catch (e) { }
    if (!at) {
      at = Date.now();
      try { sessionStorage.setItem('rtc264OffAt', String(at)); } catch (e) { }
    }
    if (Date.now() - at < TTL) return false;
    try {
      const u = new URL(location.href);
      u.searchParams.delete('rtc264');
      history.replaceState(null, '', u.toString());
      sessionStorage.removeItem('rtc264OffAt');
      setNote('已经过了 10 分钟，重新尝试 WebRTC 直连', 4000);
    } catch (e) { }
    return !!window.RTCPeerConnection;
  }
  try { sessionStorage.removeItem('rtc264OffAt'); } catch (e) { }
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
  stopRtc264('fallback:' + why);
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
  stopRtc264('switch-to-h264');                       // 从 WebRTC264 切回来时先收掉 RTC 会话，避免两路同时解码
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
  if (st.capable === false && Number(st.retryInMs) > 0) {
    // 2026-11-08：服务端明确说清晰模式暂不可用（虚拟机 / 远程桌面 / 锁屏）：
    // 不要在这里反复重试（否则会 清晰→低频→再清晰 来回跳），直接切回流畅并说明原因。
    const waitTxt2 = (st.retryInMs > 0) ? ('（约 ' + Math.ceil(st.retryInMs / 1000) + ' 秒后自动重试）') : '';
    try { btnSmooth.click(); } catch (e) { }
    setTimeout(function () { setNote('清晰模式暂时不可用：' + (st.reason || '桌面复制采集不可用') + waitTxt2 + '，已切回流畅模式', 15000); }, 900);
    return;
  }
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
  stopRtc264('switch-to-mjpeg');                       // 降级到低频画面时不要留着 WebRTC264 会话
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
  // 2026-11-08：先问服务端这台电脑能不能做清晰模式；桌面复制不可用（虚拟机等）时保持流畅并说明原因
  try {
    const hs = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json();
    if (hs && hs.capable === false && hs.retryInMs > 0) {
      setNote('清晰模式暂时不可用：' + (hs.reason || '桌面复制采集不可用') + '（约 ' + Math.ceil(hs.retryInMs / 1000) + ' 秒后自动重试）', 12000);
      return;
    }
  } catch (e) { }
  // 2026-11-07 修复：这里以前**从不**更新按钮状态，只有 startH264 内部某些分支才加 .on，
  // 所以「流畅 → 清晰」时状态已是 h264、按钮却还亮着「流畅」（用户实测）。
  // 和 btnSmooth 一样，在入口先把模式和按钮同步掉。
  state.mode = 'h264';
  btnCrisp.classList.add('on');
  btnSmooth.classList.remove('on');
  applyRect();
  stopRtc();
  try { await fetch('/rtc-off', { method: 'POST' }); } catch (e) {}
  await postMode({});
  // 2026-11-06：同样交给 startH264 自己选通道（http 下 WebCodecs 不可用，但 WebRTC264 可用）
  stopLowBw();                          // 高清模式下不该再挂着 200ms 的低频轮询定时器
  startH264();
  startH264AvailabilityWatch();   // 2026-11-08：常驻看门狗（虚拟机/锁屏时清晰不可用会自动切回流畅）
  setStat('高清模式（H.264）');
  if (state.lowBw && state.mode === 'mjpeg') startLowBw();
  if (state.audio) startPcmAudio();     // 声音统一走 PCM 通道（H.264 只传画面）
  buzz(8);
});

// 2026-11-12：Android 壳（APK）里的"改地址"入口。
// APK 通过 addJavascriptInterface 注入 window.paAppBridge；浏览器里它不存在，
// 所以这个按钮只在 APK 里出现（用户明确要求：入口放进页面自己的「更多」，不要 App 浮层）。
(function () {
  var b = null;
  try { b = document.getElementById('appAddrBtn'); } catch (e) { return; }
  if (!b) return;
  var br = null;
  try { br = window.paAppBridge || null; } catch (e) { }
  if (!br) { try { b.style.display = 'none'; } catch (e) { } return; }
  try { b.style.display = ''; } catch (e) { }
  try {
    var v = (br.version && br.version()) || '';
    if (v) b.title = '修改电脑地址（App ' + v + '）';
  } catch (e) { }
  b.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    try { br.openSettings(); } catch (e2) { }
    try { if (window.paCloseSheet) window.paCloseSheet(); } catch (e3) { }
  });
})();

// 2026-11-11：全屏常驻入口（实测：不会提高刷新率，但面积更大、去掉浏览器工具栏、锁横屏）
(function () {
  var b = null;
  try { b = document.getElementById('fsBtn'); } catch (e) { return; }
  if (!b) return;
  var sync = function () {
    try { b.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; } catch (e) { }
    try { b.classList.toggle('on', !!document.fullscreenElement); } catch (e) { }
  };
  b.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    try {
      if (document.fullscreenElement) {
        var pe = document.exitFullscreen();
        if (pe && pe.catch) pe.catch(function () { });
      } else {
        var el = document.documentElement;
        if (el.requestFullscreen) {
          var pr = el.requestFullscreen();
          if (pr && pr.catch) pr.catch(function () { });
        }
        try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () { }); } catch (e2) { }
      }
    } catch (e3) { }
    setTimeout(sync, 350);
  });
  try { document.addEventListener('fullscreenchange', sync); } catch (e) { }
  sync();
})();

btnSmooth.addEventListener('click', async () => {
  stopRtc264('user-smooth');
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

// ===== 2026-11-09：长按进度环 =====
// 长按 550ms 才触发右键，这 0.55 秒里原来屏幕上什么都没有，用户会以为没按到而提前松手。
// 现在按住时在按点画一个转满的圆弧；转满变绿 = 右键已触发。
// 用 requestAnimationFrame 驱动（用户正按着屏幕＝页面在前台）；万一 rAF 被节流，
// 圆环会停在起点——但右键该触发还是触发，只是少了个视觉反馈，不影响功能。
const PA_LONG_MS = 550;
const PA_ARC_LEN = 94.25;   // 2 * PI * r(15)
let paLongRing = null;
function startLongRing(x, y) {
  try {
    stopLongRing(false);
    const r = stage.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'paRing';
    d.style.left = (x - r.left) + 'px';
    d.style.top = (y - r.top) + 'px';
    d.innerHTML = '<svg viewBox="0 0 36 36">'
      + '<circle cx="18" cy="18" r="15" fill="none" stroke="rgba(53,214,196,.25)" stroke-width="2.5"></circle>'
      + '<circle class="paRingArc" cx="18" cy="18" r="15" fill="none" stroke="#35D6C4" stroke-width="2.5"'
      + ' stroke-linecap="round" transform="rotate(-90 18 18)"'
      + ' style="stroke-dasharray:' + PA_ARC_LEN + ';stroke-dashoffset:' + PA_ARC_LEN + '"></circle>'
      + '</svg>';
    stage.appendChild(d);
    const arc = d.querySelector('.paRingArc');
    const ring = { el: d, arc: arc, t0: Date.now(), raf: 0 };
    paLongRing = ring;
    const tick = function () {
      if (paLongRing !== ring) return;
      const p = Math.min(1, (Date.now() - ring.t0) / PA_LONG_MS);
      try { arc.style.strokeDashoffset = (PA_ARC_LEN * (1 - p)).toFixed(2); } catch (e) { }
      if (p < 1) ring.raf = requestAnimationFrame(tick);
    };
    ring.raf = requestAnimationFrame(tick);
  } catch (e) { }
}
function stopLongRing(ok) {
  try {
    if (!paLongRing) return;
    const ring = paLongRing;
    paLongRing = null;
    if (ring.raf) { try { cancelAnimationFrame(ring.raf); } catch (e) { } }
    if (ok) {
      ring.el.classList.add('ok');
      setTimeout(function () { try { ring.el.remove(); } catch (e) { } }, 300);
    } else {
      try { ring.el.remove(); } catch (e) { }
    }
  } catch (e) { }
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
  // 2026-11-09：按住就开始转进度环，转满同长按触发（550ms）
  try { startLongRing(q.x, q.y); } catch (e) { }
  longTimer = setTimeout(() => {
    longTimer = null;
    if (moved || !ptr) { try { stopLongRing(false); } catch (e) { } return; }
    dragBtn = 1;
    queue({ t: 'down', b: 1 });
    buzz(35);
    // 长按成立：圆环变绿收尾（替掉之前那个涟漪，两者叠加太吵）
    try { stopLongRing(true); } catch (e) { }
  }, PA_LONG_MS);
});

// 2026-11-10：删掉 showMouseCur —— 死代码（定义了但从没被调用过）。
// mcur 元素现在只有隐藏逻辑（scheduleDotHide / hideMouseCur 在用），没有显示路径。
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
    if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
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
  if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
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
  if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
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
  if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
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
    if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
    ptr = null; dragBtn = -1; moved = false;
    viewPan = null;
    activePtr.clear();
    // 所有手指都抬起后延迟复位：先让这一轮的 pointerup 处理完，再允许下一次单点
    setTimeout(() => { multiGesture = false; }, 0);
  }
}, { passive: true });

overlay.addEventListener('touchcancel', () => {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; try { stopLongRing(false); } catch (e) { } }
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

// ===== 2026-11-08 UI 改版第 1 批：iOS 系统手势抑制 =====
// 只靠 CSS（-webkit-touch-callout / user-select）还不够稳 —— iOS 的 pinch 手势和选择行为
// 还有 JS 层入口，这里补齐。四条都放行「正在编辑的输入框」：否则粘贴、拖光标、中文输入法
// 候选词都会被我们自己的拦截打断，那就变成更烦人的新 bug。
function isEditableEl(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
}
// ① 双指 / 多指 pinch：iOS 专属（gesturestart 系列），缩放的是整个页面而不是我们的画面
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
  document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
});
// ② 长按选中：先拦「开始选择」，再兜底清选区（长按/双击都可能留下残余高亮）
document.addEventListener('selectstart', function (e) {
  if (!isEditableEl(e.target)) e.preventDefault();
}, { passive: false });
document.addEventListener('selectionchange', function () {
  if (isEditableEl(document.activeElement)) return;
  const s = window.getSelection && window.getSelection();
  if (s && s.rangeCount) { try { s.removeAllRanges(); } catch (e) { } }
});
// ③ 文档级 contextmenu 兜底：原来只挂在 #overlay 上，长按顶栏按钮 / 浮层 / 提示区仍会弹系统菜单
document.addEventListener('contextmenu', function (e) {
  if (isEditableEl(e.target)) return;   // 输入框里保留系统菜单，否则没法粘贴
  e.preventDefault();
}, { passive: false });

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
      // 2026-11-10：#hud 在 WebRTC264 模式下是完整的（直连·分辨率·帧率·码率·缓冲），
      // 而 #stat 只是它的压缩版（setStat 会去掉前缀/帧计数/流量），两个同时显示=重复数值。
      // 只在这里隐藏 #stat；WebCodecs 模式（下面那个分支）的 #hud 不完整，必须保留它。
      
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
  el.addEventListener('error', () => { if (!stopped && state.mode === 'mjpeg') setTimeout(() => startMjpeg(), 1200); });
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
    // 2026-11-08：先问服务端清晰模式能不能用（虚拟机/远程桌面/锁屏时会不可用）。
    // 不可用就直接起流畅并说明原因，不再先黑屏 8 秒再兜底。
    let hs0 = null;
    try { hs0 = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json(); } catch (e) { }
    if (hs0 && ((hs0.capable === false && Number(hs0.retryInMs) > 0) || hs0.enabled === false)) {
      const why = hs0.reason || (hs0.enabled === false ? '这台电脑没有启用清晰模式' : '清晰模式不可用');
      const waitTxt = (hs0.retryInMs > 0) ? ('（约 ' + Math.ceil(hs0.retryInMs / 1000) + ' 秒后自动重试）') : '';
      // 延迟到 init 末尾的 setNote('') 之后再提示，否则会被清掉
      setTimeout(function () { setNote('清晰模式暂时不可用：' + why + waitTxt + '，已先用流畅模式', 15000); }, 900);
      try { btnSmooth.click(); } catch (e) { }
    } else {
      startH264();
      startH264AvailabilityWatch();
    }
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
    { key: 'dark', name: '深邃黑', free: true, meta: '#0A0B0D' },
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

  // ---- 作者 B 站主页（2026-11-10 加；同日改版：卡片化 + 号召关注）------------------
  // 教程视频（下载 / 安装 / 使用）都放在这里。用**直连**的 space 地址，不用 b23.tv 短链：
  // 直连少一次 302 跳转（更快），也不带分享会话参数、不会过期。
  // 文案全部来自 product.config.json 的 support.bili —— 以后改字不用动代码。
  function biliBlockHtml(lic) {
    const b = (lic.support && lic.support.bili) || null;
    if (!b || b.enabled === false) return '';
    const url = String(b.url || '').trim();
    if (!/^https:\/\/\S+$/i.test(url)) return '';
    const name = String(b.name || '').trim() || 'B 站';
    const note = String(b.note || '').trim() || '教程 / 更新 / 答疑都在这里';
    const cta = String(b.cta || '').trim() || '去 B 站关注支持';
    const cheer = String(b.cheer || '').trim() || '如果「轻屏」帮到了你，点个关注就是最大的支持。';
    return '<div style="margin:18px 0 0;border-radius:14px;padding:14px 15px;'
      + 'background:linear-gradient(135deg,rgba(251,114,153,.17),rgba(0,161,214,.13));'
      + 'border:1px solid rgba(251,114,153,.36)">'
      + '<div style="display:flex;align-items:center;gap:11px">'
      + '<div style="width:38px;height:38px;border-radius:11px;flex:0 0 auto;'
      + 'background:linear-gradient(135deg,#FB7299,#00A1D6);display:flex;align-items:center;justify-content:center;'
      + 'box-shadow:0 3px 12px rgba(251,114,153,.38)">'
      + '<svg viewBox="0 0 24 24" width="19" height="19" fill="#fff" aria-hidden="true">'
      + '<path d="M7.6 3.2 10.4 6h3.2l2.8-2.8 1.3 1.3L16.1 6H18a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h1.9L6.3 4.5zM6 8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1zm3.2 3.1 5.2 2.9-5.2 2.9z"/></svg>'
      + '</div>'
      + '<div style="min-width:0">'
      + '<div style="color:#fff;font-size:14px;font-weight:600;line-height:1.3">' + esc(name) + ' · B 站</div>'
      + '<div style="color:#c9ccd1;font-size:11.5px;line-height:1.5;margin-top:2px">' + esc(note) + '</div>'
      + '</div></div>'
      + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" '
      + 'style="margin-top:12px;display:block;text-align:center;'
      + 'background:linear-gradient(135deg,#FB7299,#00A1D6);text-decoration:none;'
      + 'border-radius:10px;padding:10px 14px;box-shadow:0 4px 14px rgba(251,114,153,.28)">'
      + '<span style="color:#fff;font-size:13.5px;font-weight:600;'
      + '-webkit-text-fill-color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.18)">' + esc(cta) + '</span></a>'
      + '<div style="color:#8b9098;font-size:11.5px;line-height:1.6;margin-top:9px">' + esc(cheer) + '</div>'
      + '</div>';
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
      || '我在用「轻屏」：手机就能看电脑屏幕，还能点、能打字，出门在外很方便。\n免费下载（手机浏览器打开就能用）：{link}';
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
    + 'border-radius:50%;background:rgba(18,20,26,.88);color:var(--accent);border:1px solid rgba(var(--accent-rgb),.34);'
    + 'cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent;'
    + 'box-shadow:0 2px 12px rgba(0,0,0,.5)';

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
    // 2026-11-08 UI 改版第 4 批：从"中间的小弹窗"改成"从底部上滑的全屏面板"。
    // 手机上小弹窗里滚几百个开关很难受，底部面板能贴到拇指、滚动更顺。
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.6);'
      + 'display:flex;align-items:flex-end;justify-content:center';
    const box = document.createElement('div');
    box.className = 'paSetBox';
    box.style.cssText = 'max-width:600px;width:100%;max-height:92vh;overflow:auto;-webkit-overflow-scrolling:touch;'
      + 'background:#0F1116;color:#E8EAEE;border:1px solid rgba(255,255,255,.09);border-bottom:0;'
      + 'border-radius:22px 22px 0 0;padding:0 16px calc(22px + env(safe-area-inset-bottom, 0px));'
      + 'font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;'
      + 'box-shadow:0 -14px 64px rgba(0,0,0,.72)';
    box.innerHTML = '<div class="paSetHead"><div class="paSetTitle">' + escHtml(titleText) + '</div>'
      + '<button id="' + closeId + '" class="paSetX" type="button" aria-label="关闭">×</button></div>'
      + bodyHtml;
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    box.querySelector('#' + closeId).addEventListener('click', close);
    return box;
  }

  // ---- 设置面板 ---------------------------------------------------------------
  // 用「可折叠分区卡片 + 四个页签」的排版：标题一行、点一下收起，展开状态会记住。
  // 2026-11-08：原来的 DEFAULT_CLOSED（首次打开默认收起哪几组）已经删掉——
  // 分页之后每页只剩 3-5 张卡，默认全展开更顺手，不必再点两下。
  function secClosedList() {
    try {
      const raw = localStorage.getItem('setSec.closed');
      if (raw === null) return null;                  // 从没手动收过：用默认收起列表
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : null;
    } catch (e) { return null; }
  }
  // 2026-11-08：设置面板分页。用「分区标题 → 页签」的映射表来归属，
  // 这样 14 处 setSection 调用一个字都不用改（改调用点最容易漏参数出错）。
  const SET_TAB_OF = {
    '许可证（可选）': 'about',
    '这台电脑的机器码': 'about',
    '连接与画面': 'basic',
    '网络连接体检': 'net',
    '剪贴板（手机 ↔ 电脑）': 'func',
    '传文件（手机 ↔ 电脑）': 'func',
    '串流玩游戏（Moonlight）': 'func',
    '画质与流量': 'basic',
    '外观（主题 / 光标）': 'basic',
    '防窥屏': 'func',
    '定时开关机（这台电脑）': 'func',
    '没有网络时（离线模式）': 'net',
    '出问题时导出诊断': 'about',
    '版本与更新': 'about'
  };
  function setSection(title, inner, tab) {
    const saved = secClosedList();
    // 分页之后每页只剩 3-5 张卡片，默认全展开；用户手动收过的仍然记住
    const closed = (saved === null) ? false : (saved.indexOf(title) >= 0);
    const tabKey = tab || SET_TAB_OF[title] || 'basic';
    return '<div class="setSec' + (closed ? ' closed' : '') + '" data-title="' + escHtml(title) + '"'
      + ' data-tab="' + escHtml(tabKey) + '">'
      + '<div class="secHead"><span class="secTitle">' + escHtml(title) + '</span><span class="secChev">▾</span></div>'
      + '<div class="secBody">' + inner + '</div></div>';
  }
  function setKv(k, v) {
    return '<div style="display:flex;gap:12px;padding:4px 0">'
      + '<div style="color:#868c96;font-size:13px;min-width:74px;flex-shrink:0">' + escHtml(k) + '</div>'
      + '<div style="flex:1;font-size:13px;word-break:break-all">' + v + '</div></div>';
  }

  // ---- 手势说明（2026-11-09）----
  // 除了作者本人，没人猜得到「双指=滚动、三指=缩放、长按=右键」。这些手势一直是隐形的。
  function gestureInner() {
    const g = function (k, v, note) {
      return '<div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.045)">'
        + '<div style="flex:0 0 108px;color:#C6CCD4;font-size:12.5px">' + k + '</div>'
        + '<div style="flex:1;color:#9AA1AB;font-size:12.5px;line-height:1.5">' + v
        + (note ? '<span style="color:#5F666F">（' + note + '）</span>' : '') + '</div></div>';
    };
    return '<div style="font-size:12px;color:#5F666F;margin-bottom:6px">在画面上操作时的手势，全部在手机上完成。</div>'
      + g('单指点击', '左键单击')
      + g('快速点两下', '左键双击')
      + g('单指长按', '右键（按住时圆环转满即触发）')
      + g('单指拖动', '拖动 / 移动光标')
      + g('双指上下滑', '滚动滚轮')
      + g('三指张开 / 捏合', '缩放', '按上面「缩放」里选的方式')
      + g('点画面', '收起工具条；工具条收起后点左边缘的小竖条叫出来');
  }

  // ---- 界面个性化（2026-11-08）：工具条把手位置 + 强调色 ----
  const PA_ACCENTS = [
    { name: '冷青', c: '#35D6C4' },
    { name: '深海蓝', c: '#4C8DFF' },
    { name: '星紫', c: '#A78BFA' },
    { name: '苔绿', c: '#5FD68A' },
    { name: '琥珀', c: '#FFB454' }
  ];
  function paAccentNow() {
    try { return String(localStorage.getItem('pa.accent') || '#35D6C4').toLowerCase(); } catch (e) { return '#35d6c4'; }
  }
  function paSideNow() {
    try { return localStorage.getItem('pa.handleSide') === 'right' ? 'right' : 'left'; } catch (e) { return 'left'; }
  }
  function interfaceInner() {
    const cur = paAccentNow();
    const side = paSideNow();
    function sideBtn(id, label, key) {
      const on = side === key;
      return '<button type="button" id="' + id + '" style="flex:1;padding:10px;border-radius:10px;cursor:pointer;'
        + 'background:' + (on ? 'rgba(var(--accent-rgb),.18)' : '#212530') + ';'
        + 'color:' + (on ? '#7FF0D8' : '#C6CCD4') + ';'
        + 'border:1px solid ' + (on ? 'rgba(var(--accent-rgb),.45)' : 'rgba(255,255,255,.09)') + '">' + label + '</button>';
    }
    let colors = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">';
    PA_ACCENTS.forEach(function (a) {
      const on = a.c.toLowerCase() === cur;
      colors += '<button type="button" data-accent="' + a.c + '" title="' + a.name + '" aria-label="' + a.name + '"'
        + ' style="width:40px;height:40px;border-radius:50%;padding:0;cursor:pointer;background:' + a.c + ';'
        + 'border:2px solid ' + (on ? '#E8EAEE' : 'transparent') + ';box-shadow:0 0 0 1px rgba(255,255,255,.12)"></button>';
    });
    colors += '</div>';
    return '<div style="color:#9AA1AB;font-size:12.5px;margin-bottom:6px">工具条把手位置</div>'
      + '<div style="display:flex;gap:8px">' + sideBtn('paSideL', '左边', 'left') + sideBtn('paSideR', '右边', 'right') + '</div>'
      + '<div style="color:#9AA1AB;font-size:12.5px;margin:16px 0 2px">强调色</div>'
      + colors
      + '<div style="color:#5F666F;font-size:11px;margin-top:10px;line-height:1.6">'
      + '换色只影响按钮激活态、开关、状态点和把手高光；整套主题（顶栏/卡片底色）在「外观」里换。</div>';
  }
  function interfaceBind(box) {
    const cur = paAccentNow();
    box.querySelectorAll('[data-accent]').forEach(function (b) {
      b.addEventListener('click', function () {
        const c = b.getAttribute('data-accent');
        try { localStorage.setItem('pa.accent', c); } catch (e) { }
        applyAccent(c);
        box.querySelectorAll('[data-accent]').forEach(function (x) {
          x.style.borderColor = (x === b) ? '#E8EAEE' : 'transparent';
        });
      });
    });
    const L = box.querySelector('#paSideL'), R = box.querySelector('#paSideR');
    function paint(side) {
      [[L, 'left'], [R, 'right']].forEach(function (pair) {
        const el = pair[0];
        if (!el) return;
        const on = pair[1] === side;
        el.style.background = on ? 'rgba(var(--accent-rgb),.18)' : '#212530';
        el.style.color = on ? '#7FF0D8' : '#C6CCD4';
        el.style.borderColor = on ? 'rgba(var(--accent-rgb),.45)' : 'rgba(255,255,255,.09)';
      });
    }
    if (L) L.addEventListener('click', function () {
      try { localStorage.setItem('pa.handleSide', 'left'); } catch (e) { }
      applyHandleSide('left'); paint('left');
    });
    if (R) R.addEventListener('click', function () {
      try { localStorage.setItem('pa.handleSide', 'right'); } catch (e) { }
      applyHandleSide('right'); paint('right');
    });
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
    // 2026-11-11（B1）：把中继区域码翻成人话（sin → 新加坡（SIN））。relayZh 由服务端 tailscaleSummary 给。
    const relayLabel = (p) => {
      const code = String(p.relay || '').toUpperCase();
      const zh = String(p.relayZh || '');
      if (p.peerRelay) return 'peer 中转' + (zh ? '·' + zh : '');
      if (zh && code) return zh + '（' + code + '）';
      if (zh) return zh;
      return code || '未知区域';
    };
    const ok = !!(s.running && s.online);
    rows.push('<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + setPill(ok, '已连接', s.installed ? '未连接' : '未安装')
      + '<span style="color:#868c96;font-size:12px">'
      + escHtml(s.installed ? ((s.version ? 'Tailscale ' + s.version : 'Tailscale') + (s.backendState ? ' · ' + s.backendState : '')) : '这台电脑还没装 Tailscale')
      + '</span></div>');
    // 2026-11-11（B1）：公网暴露告警。放在最上面 —— 这是"安全模型被拆掉"级别的提示，不该藏在下面。
    // 注意：只告警、不动 /health（那是 supervisor 的存活判据）。
    if (s.funnel && s.funnel.on) {
      rows.push('<div style="margin-top:10px;padding:10px 12px;border:1px solid #7a2b2b;background:#1f1113;border-radius:9px;color:#ff9b9b;font-size:12px;line-height:1.75">'
        + '<b>⚠ 检测到 Tailscale Funnel 已开启</b><br>'
        + (s.funnel.exposingScreen
          ? '它正在把<b>本机画面端口 ' + escHtml(String(s.funnel.port || '')) + '</b> 暴露到公网 —— 这会让「只走私网、不暴露公网」的承诺失效，只剩网址里的密钥这一道门。<br>'
          : '本机某些服务已经公网可达，和本产品「只走 Tailscale 私网」的定位冲突。<br>')
        + '关掉：在电脑上打开终端执行 <code style="color:#ffd0d0;user-select:all">tailscale funnel reset</code>，'
        + '或去 Tailscale 后台 → Machines → 这台电脑 → 关掉 Funnel。'
        + '</div>');
    } else if (s.funnel && s.funnel.ok === false) {
      rows.push('<div style="margin-top:8px;color:#6b7078;font-size:11px;line-height:1.6">公网暴露检查没读到结果（' + escHtml(s.funnel.error || '未知原因') + '），不影响使用。</div>');
    }
    if (s.installed) {
      const addr = (s.ips && s.ips[0]) ? s.ips[0] : '—';
      rows.push(setKv('本机地址', '<span style="color:#aeb3bb">' + escHtml(addr) + (s.dnsName ? ' · ' + escHtml(s.dnsName) : '') + '</span>'));
      rows.push(setKv('在线节点', '<span style="color:#aeb3bb">' + (s.onlinePeers || 0) + ' / ' + (s.peerTotal || 0) + '</span>'));
      // 2026-11-11：节点密钥到期时间。Tailscale 默认 180 天过期，到期那一刻这台电脑在手机上
      // **所有入口会突然打不开**（要重新授权）。对人不在电脑前的场景 = 一次售后事故，
      // 所以提前显出来；≤14 天变黄、已过期变红，并给出"关掉过期"的一句话修法。
      try {
        if (s.keyExpiryDays === null) {
          rows.push(setKv('密钥到期', '<span style="color:#8CE58C">不过期（已关闭）</span>'));
        } else if (typeof s.keyExpiryDays === 'number') {
          const kd = s.keyExpiryDays;
          const kdate = String(s.keyExpiry || '').slice(0, 10);
          const kcol = kd < 0 ? '#ff6b6b' : (kd <= 14 ? '#ffb454' : '#aeb3bb');
          const ktxt = kd < 0 ? ('已经过期（' + kdate + '）') : (kd + ' 天后（' + kdate + '）');
          rows.push(setKv('密钥到期', '<span style="color:' + kcol + '">' + escHtml(ktxt) + '</span>'));
          if (kd <= 14) {
            rows.push('<div style="margin-top:4px;padding:8px 10px;border:1px solid #4a3a1f;background:#1d1810;border-radius:8px;color:#ffb454;font-size:11.5px;line-height:1.7">'
              + (kd < 0 ? '密钥已经过期，手机端现在打不开' : ('密钥 ' + kd + ' 天后过期'))
              + '。到期后这台电脑在手机上<b>所有入口会突然打不开</b>，需要重新授权。<br>'
              + '最省事的修法：Tailscale 后台 → <b>Machines</b> → 这台电脑 → 右侧 <b>⋯</b> → <b>Disable key expiry</b>（关掉过期）。点下面「后台地址」直接去。</div>');
          }
        }
      } catch (e) { }
      // 2026-11-11 修正：原来写"免费账号只能加 5 台设备"是错的（那是很久以前的老额度）。
      // 官方定价页（tailscale.com/pricing，2026-11 查）个人版 Personal：$0、**设备不限台数**、
      // 最多 6 个用户账号、50 个「打了标签的资源」、临时资源每月 1000 分钟。
      // 普通电脑/手机不计入"标记资源"，所以日常根本不会撞上限 —— 别再吓用户去删设备。
      rows.push('<div style="color:#6b7078;font-size:11px;line-height:1.7;margin-top:2px">Tailscale 个人版是免费的：你自己的设备<b>不限台数</b>（最多 6 个用户账号），电脑、手机随便加，不用删设备。</div>');
      // 远程 HTTPS 入口（tailscale serve）：一键开启，省得客户自己去后台折腾
      if (s.httpsUrl) {
        // 已开启：给「复制 / 直接打开」两个动作，省得客户手动抄地址
        rows.push(setKv('远程 HTTPS', '<a href="' + escHtml(s.httpsUrl) + '" target="_blank" rel="noreferrer" style="color:#8fb6ff">' + escHtml(s.httpsUrl) + '</a>'));
        rows.push('<div style="display:flex;gap:8px;align-items:center;margin:6px 0 2px;flex-wrap:wrap">'
          + '<button id="tsHttpsCopy" data-url="' + escHtml(s.httpsUrl) + '" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">复制这个地址</button>'
          + '<a href="' + escHtml(s.httpsUrl) + '" target="_blank" rel="noreferrer" style="background:#2f6feb;color:#fff;border-radius:8px;padding:5px 11px;font-size:11.5px;text-decoration:none">用它打开</a>'
          + '<span id="tsHttpsMsg" style="font-size:11.5px;color:#868c96"></span></div>');
  // 2026-11-08（用户要求）：把 Tailscale 后台地址直接挂在设置里，并写清楚点哪里
  rows.push('<div style="margin-top:8px;padding:8px 10px;border:1px solid #26405a;background:#101b26;border-radius:8px;color:#aeb3bb;font-size:11.5px;line-height:1.75">'
    + '<b style="color:#8fb6ff">后台地址</b>（复制到浏览器打开，手机/电脑都行）：<br>'
    + '<code id="tsAdminUrl" style="color:#8fb6ff;user-select:all;font-size:11.5px">https://login.tailscale.com/admin/dns</code> '
    + '<button id="tsAdminCopy" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer">复制</button><br>'
    + '打开后：用<b>和电脑同一个 Tailscale 账号</b>登录 → <b>DNS</b> → <b>HTTPS Certificates</b> → 点 <b>Enable HTTPS</b>；'
    + '再回到本页点「一键开启远程 HTTPS」。这一步每个账号只做一次，证书由 Tailscale 自动签发，手机不用装证书。'
    + '</div>');
        rows.push('<div style="color:#6b7078;font-size:11px;line-height:1.6">这个地址是 https 的，证书由 Tailscale 自动签发（手机不用装任何证书）。加到手机主屏当 App 用最方便。</div>');
      } else {
        rows.push(setKv('远程 HTTPS', '<span style="color:#ffb454">未开启</span>'));
        rows.push('<div style="display:flex;gap:8px;align-items:center;margin:6px 0 2px;flex-wrap:wrap">'
          + '<button id="tsHttpsBtn" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">一键开启远程 HTTPS</button>'
          + '<a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" style="color:#8fb6ff;font-size:11.5px;text-decoration:none">去 Tailscale 后台启用 HTTPS →</a>'
          + '<span id="tsHttpsMsg" style="font-size:11.5px;color:#868c96"></span></div>');
  // 2026-11-08（用户要求）：把 Tailscale 后台地址直接挂在设置里，并写清楚点哪里
  rows.push('<div style="margin-top:8px;padding:8px 10px;border:1px solid #26405a;background:#101b26;border-radius:8px;color:#aeb3bb;font-size:11.5px;line-height:1.75">'
    + '<b style="color:#8fb6ff">后台地址</b>（复制到浏览器打开，手机/电脑都行）：<br>'
    + '<code id="tsAdminUrl" style="color:#8fb6ff;user-select:all;font-size:11.5px">https://login.tailscale.com/admin/dns</code> '
    + '<button id="tsAdminCopy" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer">复制</button><br>'
    + '打开后：用<b>和电脑同一个 Tailscale 账号</b>登录 → <b>DNS</b> → <b>HTTPS Certificates</b> → 点 <b>Enable HTTPS</b>；'
    + '再回到本页点「一键开启远程 HTTPS」。这一步每个账号只做一次，证书由 Tailscale 自动签发，手机不用装证书。'
    + '</div>');
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
              + (!p.direct ? '<span style="color:#6b7078;font-size:11px">' + escHtml(relayLabel(p)) + '</span>' : ''))
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
    // 2026-11-11（B1）：公网暴露检查通过的安静提示（不占大块版面，只在末尾一行）
    if (s.funnel && s.funnel.ok && !s.funnel.on) {
      rows.push('<div style="margin-top:8px;color:#5f8f66;font-size:11px;line-height:1.6">公网暴露检查：没开 Funnel —— 只有你自己的 tailnet 能连到这台电脑。</div>');
    }
    // 2026-11-11（B1）：网络体检。按需触发（一次 10~20 秒），失败可重试。
    if (s.installed) {
      rows.push('<div style="margin-top:12px;padding:10px 12px;border:1px solid #262932;border-radius:9px;background:#0f1014">'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<span style="color:#aeb3bb;font-size:12.5px;font-weight:600">网络体检</span>'
        + '<button id="tsNetcheckBtn" data-tsnc="1" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;'
        + 'padding:5px 11px;font-size:11.5px;cursor:pointer">运行体检</button>'
        + '<span style="color:#6b7078;font-size:11px">约 10~20 秒</span></div>'
        + '<div id="tsNetcheck" style="margin-top:8px;color:#868c96;font-size:12px;line-height:1.8">'
        + '还没体检。点上面的按钮，能查出「能不能打洞、最近的中继在哪、为什么卡」。</div>'
        + '</div>');
    }
    return rows.join('');
  }
  // 2026-11-11（B1）：网络体检结果的渲染。
  // 刻意把「失败」也渲染成可重试的按钮 —— 10287a02：任何失败态都必须有恢复路径，不能一错到底。
  function netcheckInner(r) {
    const retryBtn = '<div style="margin-top:8px"><button id="tsNetcheckRetry" data-tsnc="1" '
      + 'style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;'
      + 'font-size:11.5px;cursor:pointer">重试</button></div>';
    if (!r) return '<span style="color:#ff6b6b">没拿到体检结果（网络或服务异常），可以重试。</span>' + retryBtn;
    if (r.busy) return '<span style="color:#868c96">' + escHtml(r.hint || '正在体检…') + '</span>';
    if (!r.ok) return '<span style="color:#ff6b6b">体检没成功：' + escHtml(r.error || '未知原因') + '</span>' + retryBtn;
    const rows = [];
    rows.push(setKv('UDP', r.udp === true
      ? '<span style="color:#8CE58C">可以出（打洞有戏）</span>'
      : (r.udp === false ? '<span style="color:#ffb454">出不去（只能走中继）</span>' : '<span style="color:#868c96">—</span>')));
    rows.push(setKv('NAT', r.symmetric === true
      ? '<span style="color:#ffb454">对称 NAT（打洞成功率低）</span>'
      : (r.symmetric === false ? '<span style="color:#8CE58C">锥形 NAT（能打洞）</span>' : '<span style="color:#868c96">—</span>')));
    rows.push(setKv('端口映射', r.portMapping
      ? '<span style="color:#8CE58C">' + escHtml(r.portMapping) + '</span>'
      : '<span style="color:#ffb454">没开 UPnP / NAT-PMP</span>'));
    if (r.nearest) {
      rows.push(setKv('最近中继', '<span style="color:#aeb3bb">' + escHtml(String(r.nearest.zh || r.nearest.city || ''))
        + '（' + escHtml(String(r.nearest.code || '').toUpperCase()) + '） ' + escHtml(String(r.nearest.ms)) + ' ms</span>'));
    }
    if (r.regions && r.regions.length > 1) {
      const nearCode = (r.nearest && r.nearest.code) || '';
      const others = r.regions.slice(0, 6).filter((x) => x.code !== nearCode);
      if (others.length) {
        rows.push('<div style="margin-top:6px;color:#6b7078;font-size:11.5px;line-height:1.85">其他中继：'
          + others.map((x) => escHtml(String(x.zh || x.city || x.code) + ' ' + x.ms + 'ms')).join(' · ') + '</div>');
      }
    }
    if (r.hint) {
      rows.push('<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:#1a1c22;border:1px solid #2b3138;'
        + 'color:#aeb3bb;font-size:12px;line-height:1.7">' + escHtml(r.hint) + '</div>');
    }
    if (r.ageMs && r.ageMs > 3000) {
      rows.push('<div style="margin-top:6px;color:#6b7078;font-size:11px">结果来自 ' + Math.round(r.ageMs / 1000) + ' 秒前（缓存）</div>');
    }
    rows.push('<div style="margin-top:8px"><button id="tsNetcheckRetry" data-tsnc="1" '
      + 'style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;'
      + 'font-size:11.5px;cursor:pointer">再体检一次</button></div>');
    return rows.join('');
  }
  function tsBind(box) {
    const bodyEl = box.querySelector('#tsBody');
    const msgEl = box.querySelector('#tsMsg');
    const btn = box.querySelector('#tsRefresh');
    if (!bodyEl) return;
    const setMsg = (t, c) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = c || '#868c96'; } };
    // 2026-11-11（B1）：网络体检按钮。结果区每次重新渲染后按钮是新建的，所以绑定要放在渲染之后调。
    const bindNetcheck = () => {
      const ncEl = bodyEl.querySelector('#tsNetcheck');
      const btnNc = bodyEl.querySelector('#tsNetcheckBtn');
      const run = async () => {
        if (!ncEl) return;
        if (btnNc) { btnNc.disabled = true; btnNc.style.opacity = '.6'; btnNc.textContent = '体检中…'; }
        ncEl.innerHTML = '<span style="color:#868c96">正在探测（约 10~20 秒，别关掉这一页）…</span>';
        let r = null;
        try {
          r = await fetch('/ts-netcheck?force=1&_=' + Date.now(), { cache: 'no-store' }).then((x) => x.json());
        } catch (e) { r = null; }
        ncEl.innerHTML = netcheckInner(r);
        if (btnNc) { btnNc.disabled = false; btnNc.style.opacity = '1'; btnNc.textContent = '运行体检'; }
        const rt = ncEl.querySelector('#tsNetcheckRetry');
        if (rt) rt.addEventListener('click', run);
      };
      if (btnNc) btnNc.addEventListener('click', run);
    };
    const load = async () => {
      bodyEl.innerHTML = '<span style="color:#868c96">正在检测…</span>';
      let s = null;
      try { s = await fetch('/tailscale-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { s = null; }
      if (!s) { bodyEl.innerHTML = '<span style="color:#ff6b6b">检测失败：读不到 Tailscale 状态。</span>'; return; }
      bodyEl.innerHTML = tsRowsHtml(s);
      bindNetcheck();
      const adminCopy = bodyEl.querySelector('#tsAdminCopy');
  if (adminCopy) adminCopy.addEventListener('click', () => {
    const u = 'https://login.tailscale.com/admin/dns';
    if (copyText(u)) { adminCopy.textContent = '已复制'; setTimeout(() => { adminCopy.textContent = '复制'; }, 1500); }
    else { setMsg('复制不了，长按上面的地址手动复制', '#ffb454'); }
  });
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
    const winCb = box.querySelector('#hqWin');
    const autoBtn = box.querySelector('#hqAuto');
    const msg = box.querySelector('#hqMsg');
    if (!wSel || !fpsSel || !kSel) return;
    const setMsg = (s, c) => { if (msg) { msg.textContent = s; msg.style.color = c || '#868c96'; } };
  // 2026-11-08：显示清晰模式可用性（虚拟机/远程桌面不支持时说明原因，避免点了没反应）
  // 2026-11-10（1.0.21）：同时显示**设备审查**结果 —— 硬件编码不够的机器会被自动限制画质，
  // 提前说清楚，免得用户以为"调不高是坏了"。
  (async () => {
    try {
      const capEl = box.querySelector('#hqCap');
      if (!capEl) return;
      let hs = null, dv = null;
      try { hs = await (await fetch('/h264-status?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json(); } catch (e) { }
      try { dv = await (await fetch('/device-check?k=' + encodeURIComponent(KEY), { cache: 'no-store' })).json(); } catch (e) { }
      let txt = '';
      let color = '#6b7078';
      if (hs && hs.capable === false && Number(hs.retryInMs) > 0) {
        txt = '清晰模式：暂时不可用 —— ' + (hs.reason || '桌面复制采集不可用') + (hs.retryInMs > 0 ? ('（约 ' + Math.ceil(hs.retryInMs / 1000) + ' 秒后自动重试）') : '');
        color = '#ffb454';
      } else if (hs && hs.capable === true) {
        txt = '清晰模式：可用' + (hs.encoder ? '（编码器 ' + hs.encoder + '）' : '');
        color = '#8CE58C';
      }
      if (dv && dv.done && Number(dv.level) > 0) {
        const c = dv.caps || {};
        txt += (txt ? '；' : '') + '这台电脑已按设备能力限制画质：最高 ' + (c.maxWidth || '?') + ' 宽 / ' + (c.maxFps || '?') + ' fps / '
          + (c.maxKbps ? (Math.round(c.maxKbps / 1000) + ' Mbps') : '?') + (dv.notes && dv.notes[0] ? ('（' + dv.notes[0] + '）') : '');
        color = '#ffb454';
      }
      if (txt) { capEl.textContent = txt; capEl.style.color = color; }
    } catch (e) { }
  })();
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
        // 2026-11-08：服务端 width 可能不在选项里（虚拟机采集宽度未知/很小），
        // 直接赋值会让下拉显示空白。这里选最接近的档位，并说明实际采集宽度。
        wSel.value = String(j.width);
        if (wSel.selectedIndex < 0) {
          const want = Number(j.width) || 1920;
          let best = wSel.options[0];
          for (const o of wSel.options) {
            if (Math.abs(Number(o.value) - want) < Math.abs(Number(best.value) - want)) best = o;
          }
          wSel.value = best.value;
          setMsg('当前采集宽度 ' + (j.width || '未知') + '，已按最接近的 ' + wSel.value + ' 显示', '#ffb454');
        }
        fpsSel.value = String(j.fps);
        kSel.value = String(j.kbps);
        // 2026-11-10：自动降档判据要用"输入帧率"，这里把服务端当前档位记下来
        try { RTC264.inFps = Number(j.fps) || 0; } catch (e) { }
        // 2026-11-10：把用户在设置里**显式选过**的画质，在这次页面加载时和服务端对齐。
        // 起因：服务端重启（升级/部署/崩溃自愈）会把帧率/码率重读回配置默认；而"自动降档"是
        // 临时性的（auto:true、不落盘、不写 localStorage），所以这里以用户的显式选择为准：
        // 服务端和它不一致就下发一次，双向收敛（这样"刷新页面也会恢复"才是真的）。
        try {
          const wantF = Number(localStorage.getItem('hqFps') || 0);
          const wantK = Number(localStorage.getItem('hqKbps') || 0);
          // 2026-11-11（C 方案）：先问服务端"我该走哪一路"。
          //   第一台设备 / 档位和主路一致 → 主路（stream=1，可以改全局档位）
          //   第二台设备档位不同          → 给它单开一路（stream=2，只改自己那一路）
          //   第三台以后 / 弱机器 / 起不来 → 共享主路（stream=1）
          try {
            const pickBody = {
              width: Number(wSel.value) || j.width,
              fps: wantF >= 30 ? wantF : Number(j.fps),
              kbps: wantK >= 2000 ? wantK : Number(j.kbps),
              client: paClientId()
            };
            const pk = await (await fetch('/h264-stream-pick', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pickBody)
            })).json();
            if (pk && pk.ok) {
              RTC264.stream = (Number(pk.stream) === 2) ? 2 : 1;
              RTC264.ownsPrimary = pk.owner === true;
              try { window.__paStream = RTC264.stream; } catch (e) { }
              if (RTC264.stream === 2) {
                setMsg('这台设备用独立画质（' + pickBody.fps + 'fps / ' + Math.round(pickBody.kbps / 1000) + 'Mbps），不影响别人', '#8CE58C');
              }
            }
          } catch (e) { RTC264.stream = 1; }
          // 2026-11-12：**这里不再把本地保存的档位推回服务端**。
          // 之前每次打开设置面板/页面重载都会把"服务端自动降到的 90fps"改回本地存的 120，
          // 触发一次 h264: start（编码器重启）。压测实测：每次重启都伴随 1.7~2.8 秒的事件循环
          // 卡顿 + 音频丢 1.5 秒以上（ffmpeg 重启时 CreateProcess 在内存压力下阻塞主线程）。
          // 现在**以服务端为准**：把服务端的档位同步到界面和 localStorage；
          // 只有用户主动改下拉框（下面 fpsSel/kSel 的 change 处理）才真正下发。
          try {
            if (fpsSel && Number(j.fps) > 0) fpsSel.value = String(j.fps);
            if (kSel && Number(j.kbps) > 0) kSel.value = String(j.kbps);
            try { if (Number(j.fps) > 0) localStorage.setItem('hqFps', String(j.fps)); } catch (e) { }
            try { if (Number(j.kbps) > 0) localStorage.setItem('hqKbps', String(j.kbps)); } catch (e) { }
            RTC264.inFps = Number(j.fps) || RTC264.inFps;
            RTC264.inFpsAt = Date.now();
          } catch (e) { }
        } catch (e) { }
        if (!j.width || !j.height) setMsg('高清通道未启用');
        updateFlow();
      } catch (e) { }
    })();
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
      // 2026-11-11（C 方案）：共享主路（不是主人）时改档位不会生效，直接说清楚，
      // 免得用户以为"设置坏了/选不了"。
      if (RTC264.stream !== 2 && RTC264.ownsPrimary === false) {
        setMsg('当前和另一台设备共享主路画质：档位由它决定，改这里不会生效。等它断开后会自动归你。', '#ffb454');
        return;
      }
      setMsg('正在应用…');
      // 2026-11-10（独立审查建议）：只有用户**真的改了帧率**才把新值写成"我的选择"。
      // 否则他在"自动降档后的低帧率"状态下去改码率，会把降档值永久写成自己的选择。
      const fpsChanged = Number(fpsSel.value) !== Number(RTC264.inFps || 0);
      try {
        const j = await (await fetch('/h264-quality', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          // C 方案：第二路的设备改画质时带 stream:2 —— 服务端只改第二路，不会打断第一台
          body: JSON.stringify({ width: Number(wSel.value), fps: Number(fpsSel.value), kbps: Number(kSel.value), stream: Number(RTC264.stream || 1), client: paClientId() })
        })).json();
        if (j && j.ok) {
          try { fpsSel.value = String(j.fps); wSel.value = String(j.width); kSel.value = String(j.kbps); } catch (e) { }
          try {
            localStorage.setItem('hqKbps', String(j.kbps));
            if (fpsChanged) localStorage.setItem('hqFps', String(j.fps));
          } catch (e) { }
          // 用户显式拍板 = 清掉自动降档的记录，让它重新从当前档位判断
          try {
            RTC264.inFps = Number(j.fps) || 0;
            RTC264.inFpsAt = Date.now();
            RTC264.dw = []; RTC264.goodTicks = 0; RTC264.ups = 0; RTC264.userTarget = 0;
            RTC264.lastDown = 0; RTC264.lastUp = 0;
            if (fpsChanged) RTC264.downgraded = false;
          } catch (e) { }
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
    // 2026-11-10：保存位置的两个按钮（用户反馈"找不到文件在哪 / 为什么不能改路径"）
    const dirOpenBtn = box.querySelector('#fileDirOpen');
    if (dirOpenBtn) dirOpenBtn.addEventListener('click', async () => {
      try {
        const j = await (await fetch('/files/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
        if (j && j.ok) setMsg('已在你电脑上打开这个文件夹', '#8CE58C');
        else setMsg((j && j.message) || '打不开文件夹', '#ff6b6b');
      } catch (e) { setMsg('电脑没响应（网络断了？）', '#ff6b6b'); }
    });
    const dirChangeBtn = box.querySelector('#fileDirChange');
    if (dirChangeBtn) dirChangeBtn.addEventListener('click', async () => {
      const curEl = box.querySelector('#fileDirPath');
      const cur = (curEl && curEl.textContent !== '读取中…') ? curEl.textContent : '';
      const input = prompt('手机传过来的文件，存到电脑哪个文件夹？\n\n· 要填绝对路径（例如 D:\\手机传文件）\n· 目录不存在会自动创建', cur);
      if (input === null) return;
      const p = String(input).trim();
      if (!p) return;
      try {
        const j = await (await fetch('/files/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: p }) })).json();
        if (j && j.ok) {
          if (curEl) curEl.textContent = j.dir;
          setMsg('保存位置已改为：' + j.dir, '#8CE58C');
          load();
        } else setMsg((j && j.message) || '改不了这个路径', '#ff6b6b');
      } catch (e) { setMsg('网络断了', '#ff6b6b'); }
    });
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
      // 2026-11-10：把"存到电脑哪个文件夹"显示出来（原来只显示文件名，用户根本找不到）
      const dirEl = box.querySelector('#fileDirPath');
      if (dirEl && j.dir) dirEl.textContent = j.dir;
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
        setMsg('完成：' + okCount + ' 个文件，共 ' + fmt(doneBytes) + '，' + secs.toFixed(1) + ' 秒（平均 ' + fmtSpeed(doneBytes / secs) + '）· 存在电脑的「保存到」那个文件夹里，可点「在电脑上打开」', '#8CE58C');
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
    // 2026-11-08：同一 Wi-Fi 串流开关（只放行 Sunshine 自己的端口，不含 47990 管理后台）
    const lsState = () => box.querySelector('#ssLanState');
    const lsMsg = (txt, color) => { const el = lsState(); if (el) { el.textContent = txt; el.style.color = color || '#6b7078'; } };
    // 2026-11-08：手机侧探测局域网地址 + 等防火墙规则生效（打开「允许同一 Wi-Fi 串流」后自动验证）
    const paProbeLan = (ip, timeoutMs) => new Promise((resolve) => {
      const addr = String(ip || '').trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) { resolve(false); return; }
      let done = false;
      const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
      let ctrl = null;
      try { ctrl = new AbortController(); } catch (e) { }
      const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch (e) { } fin(false); }, Math.max(1200, Number(timeoutMs) || 2500));
      try {
        fetch('http://' + addr + ':47989/', { mode: 'no-cors', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
          .then(() => { clearTimeout(timer); fin(true); })
          .catch(() => { clearTimeout(timer); fin(false); });
      } catch (e) { clearTimeout(timer); fin(false); }
    });
    const paLanIp = async () => {
      try {
        const j = await fetch('/sunshine-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
        const list = Array.isArray(j && j.lanIps) ? j.lanIps : [];
        const lan = list.filter((x) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String((x && x.ip) || '')));
        return lan.length ? String(lan[0].ip) : '';
      } catch (e) { return ''; }
    };
    const paWaitRules = async (deadlineMs) => {
      const end = Date.now() + Math.max(3000, Number(deadlineMs) || 20000);
      while (Date.now() < end) {
        try {
          const s = await fetch('/stream/status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
          if (s && s.ok && Number(s.rules) > 0) return true;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, 1500));
      }
      return false;
    };
    const loadStream = async () => {
      try {
        const s = await fetch('/stream/status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
        if (!s || !s.ok) { lsMsg('读取失败'); return; }
        lsMsg(s.enabled ? ('当前：已放行（' + (s.rules || 0) + ' 条规则），同一 Wi-Fi 可以连 Moonlight') : '当前：关闭（只允许 Tailscale）', s.enabled ? '#8CE58C' : '#6b7078');
      } catch (e) { lsMsg('读取失败：' + ((e && e.message) || e)); }
    };
    const setStream = async (on) => {
      lsMsg('正在' + (on ? '放行' : '关闭并恢复') + '：请在电脑上点「是」（管理员授权）…', '#ffb454');
      try {
        const r = await fetch('/stream/lan/' + (on ? 'on' : 'off'), { method: 'POST' }).then((x) => x.json());
        if (!r || !r.ok) { lsMsg((r && (r.error || r.note)) || '操作被拒绝', '#ff6b6b'); return; }
        if (!on) { lsMsg((r.note || '已关闭'), '#ffb454'); setTimeout(loadStream, 6000); return; }
        // 打开：等规则建好（UAC 要用户点「是」），再从手机这边实际验证能不能连
        lsMsg('已提交，请在电脑上点「是」…马上自动验证', '#ffb454');
        const rulesOk = await paWaitRules(25000);
        if (!rulesOk) { lsMsg('规则还没建成：可能没点「是」或被安全软件拦了，请再点一次', '#ffb454'); return; }
        loadStream();
        const ip = await paLanIp();
        if (!ip) { lsMsg('已放行，但没取到局域网地址', '#ffb454'); return; }
        const ok = await paProbeLan(ip, 3000);
        if (ok) {
          lsMsg('✓ 已放行，且手机这边能连到 ' + ip + '（Moonlight 可以直接用这个地址）', '#8CE58C');
        } else {
          lsMsg('已放行，但手机这边连不上 ' + ip + '：多半是网络隔离/不同网段，请用 Tailscale 地址', '#ffb454');
        }
        // 顺手刷新地址卡片，让「手机这边能连到…」那行同步更新
        try {
          const j = await fetch('/sunshine-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
          renderAddr(j);
        } catch (e) { }
      } catch (e) { lsMsg('请求失败：' + ((e && e.message) || e), '#ff9d9d'); }
    };
    const lsOn = box.querySelector('#ssLanOn');
    if (lsOn) lsOn.addEventListener('click', () => setStream(true));
    const lsOff = box.querySelector('#ssLanOff');
    if (lsOff) lsOff.addEventListener('click', () => setStream(false));
    loadStream();
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
      // 2026-11-08：同 Wi-Fi 地址不一定能用（校园网/公共 Wi-Fi 常禁止设备互访）。
      // 由手机这边实际去连一次（http://<局域网IP>:47989，Sunshine 的 HTTP 端口，0.0.0.0 监听），
      // 连不上就在下面直接给出原因和替代方案，避免用户拿一个死地址反复试。
      h += '<div id="lanProbe" style="margin-top:6px;font-size:12px;color:#868c96">正在从手机这边测试局域网地址能不能连…</div>';
      if (lan.length) h += scene('在家里 / 连同一个 Wi-Fi（推荐，最顺）', lan[0].ip, '#8CE58C');
      if (ts) {
        h += scene('在外面 / 用手机流量', ts.ip, '#8fb6ff');
        h += '<div style="color:#6b7078;font-size:11.5px;margin-top:4px;line-height:1.7">在外面用的时候，手机也要装 Tailscale 并登录同一个账号，否则连不上（不装也能在家用）。<br>如果连同一个 Wi-Fi 也连不上：① 点上面的「允许同一 Wi-Fi 串流」（只放行 Sunshine 端口，弹一次管理员授权）；② 还是不行，多半是路由器禁止设备互访——用上面「在外面」这个地址，或者用电脑开热点给手机连。</div>';
      }
      if (!lan.length && !ts) h += '<div style="margin-top:8px;color:#ffb454;font-size:12px">暂时没取到地址，先连上网络再刷新一次。</div>';
      h += '<div style="margin-top:10px;padding-top:9px;border-top:1px solid #23252c;color:#6b7078;font-size:11.5px;line-height:1.8">'
        + '· 觉得画面有点卡：在 Moonlight 里把「分辨率」选 <b style="color:#c9ccd1">1080p</b>、「帧率」选 <b style="color:#c9ccd1">60</b><br>'
        + '· 实在配不上的备用办法：手机先连上 Tailscale，再用浏览器打开 <code style="color:#aeb3bb">https://' + escHtml(ts ? ts.ip : '（需 Tailscale 地址）') + ':' + port + '</code> 在后台配对（47990 管理后台不对局域网开放，一般不走到这一步）'
        + '</div>';
      box.innerHTML = h;
      // 2026-11-08：手机侧可达性探测（不依赖服务端；失败不代表地址错，而是网络隔离/不同网段）
      (async () => {
        const el = box.querySelector('#lanProbe');
        if (!el) return;
        if (location.protocol !== 'http:') { el.textContent = ''; return; }   // https 页面会拦 http 探测
        const firstLan = (lan && lan[0] && lan[0].ip) ? String(lan[0].ip) : '';
        if (!firstLan) { el.textContent = ''; return; }
        const ok = await paProbeLan(firstLan, 2500);
        if (!el) return;
        if (ok) {
          el.textContent = '✓ 手机这边能连到 ' + firstLan + '（同一个 Wi-Fi 可以用）';
          el.style.color = '#8CE58C';
        } else {
          el.innerHTML = '<div style="background:#2a1d10;border:1px solid #5a3a12;border-radius:9px;padding:9px 10px;line-height:1.75">'
            + '<b style="color:#ffb454">手机这边连不上 ' + escHtml(firstLan) + '</b><br>'
            + '常见原因：校园网 / 公共 Wi-Fi / 公司网<b>禁止设备互访</b>（设备隔离），或者手机没连同一个 Wi-Fi、不在同一网段。<br>'
            + '解决办法：用下面「在外面 / 用手机流量」那个 <b>Tailscale 地址</b>（已可用）；或者让电脑开热点，手机连电脑的热点。'
            + '</div>';
          el.style.color = '#ffb454';
        }
      })();
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
      let lastPairCount = 0;   // 2026-11-08：已配对记录数（≥2 时提示清空重配）
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
        if (j && j.needFix) { try { const fb = bodyEl.querySelector('#ssFix'); if (fb) { fb.style.color = '#8fb6ff'; fb.style.borderColor = '#2f6feb'; } } catch (e) { } }
        if (j && j.ok) { selectedId = ''; setTimeout(poll, 1200); }
        else { setTimeout(poll, 1500); }
      });
      const fixBtn = bodyEl.querySelector('#ssFix');
      if (fixBtn) fixBtn.addEventListener('click', async () => {
        const fm = bodyEl.querySelector('#ssFixMsg');
        const say2 = (t, c) => { if (fm) { fm.textContent = t; fm.style.color = c || '#6b7078'; } };
        fixBtn.disabled = true;
        say2('正在修复：系统会弹一次管理员授权，请点「是」…', '#868c96');
        let j = null;
        try { j = await fetch('/sunshine-fix', { method: 'POST' }).then((r) => r.json()); } catch (e) { j = null; }
        if (!j || !j.ok) { fixBtn.disabled = false; say2((j && (j.message || j.error)) || '启动修复失败', '#ff6b6b'); return; }
        say2(j.message || '正在修复…', '#868c96');
        // 轮询 /sunshine-status 的 fix 字段（最多 60 秒）
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          let st = null;
          try { st = await fetch('/sunshine-status?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { st = null; }
          const fx = st && st.fix;
          if (!fx) continue;
          if (fx.phase === 'done') { fixBtn.disabled = false; say2('凭据已修好：回 Moonlight 重新点一次这台电脑，拿新的 4 位 PIN 再配对。', '#8CE58C'); lastSig = ''; setTimeout(poll, 800); return; }
          if (fx.phase === 'error') { fixBtn.disabled = false; say2('修复失败：' + (fx.error || '未知原因') + '（可以再点一次，或重装高性能组件）', '#ff6b6b'); return; }
        }
        fixBtn.disabled = false;
        say2('修复超时：可能没点管理员授权。再点一次「修复凭据」试试。', '#ffb454');
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
      // 2026-11-10 修：这里原来写的是 (p && Number(p.pairCount)) || 0，
      // 但 p 只在 poll() 内部定义（那条语句还用了 p），render 里根本看不到它
      // → 每次渲染都抛 "p is not defined"，整个「串流玩游戏」面板永远停在"正在检测…"。
      // 已配对数量本来就该从传进来的 pairings 数出来。
      lastPairCount = Array.isArray(pairings) ? pairings.length : 0;   // 已配对数量（>1 要提醒清空重配）
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
        const localMsi = !!(comp.localMsi || s.localMsi);
        if (comp.configured || localMsi) {
          h += '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            + '<button id="ssComp" ' + (busy ? 'disabled' : '') + ' style="background:#2f6feb;color:#fff;border:0;border-radius:9px;'
            + 'padding:9px 15px;font-size:13px;cursor:pointer' + (busy ? ';opacity:.6' : '') + '">'
            + (busy ? '处理中…' : (localMsi ? '安装高性能组件（用安装包自带的，约 1–2 分钟）' : '下载并安装组件（约 32MB）')) + '</button>'
            + '<span id="ssCompMsg" style="font-size:12px;color:#868c96">' + escHtml(phaseText) + '</span></div>'
            + '<div style="color:#6b7078;font-size:11px;margin-top:6px">Sunshine 是 GPL-3.0 独立程序（来源 LizardByte/Sunshine），'
            + '安装后只绑 tailnet；手机还需另装 Moonlight。安装时电脑会弹一次管理员授权，请点「是」；'
            + (localMsi ? '组件随安装包自带，不需要联网。' : '需要联网下载。') + '</div>';
        } else {
          h += '<div style="margin-top:8px;color:#868c96;font-size:12px">当前安装包没带高性能组件（也没有下载地址）。'
            + '重新下载完整安装包后，这里会出现安装按钮；不装也不影响网页模式。</div>';
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
          + (lastPairCount >= 2 ? ('<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(255,180,84,.12);border:1px solid rgba(255,180,84,.35);color:#ffb454;font-size:12px;line-height:1.7">'
              + '检测到这台电脑已经有 <b>' + lastPairCount + '</b> 条配对记录。重复配对会让 Moonlight 报 <b>401 / Certificate verification failed</b>。'
              + '<br>建议：先点下面「清空配对」，然后在 Moonlight 里删除这台电脑、重新添加，再输一次 PIN。'
              + '</div>') : '')
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
          + '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
          + '<button id="ssUnpair" style="background:#2a2d36;color:#ffb454;border:1px solid #3a3e4a;'
          + 'border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">配对一直不成功？清空旧配对再试</button>'
          + '<button id="ssFix" style="background:#2a2d36;color:#8fb6ff;border:1px solid #3a3e4a;'
          + 'border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">修复凭据（报 401 时用）</button></div>'
          + '<div id="ssFixMsg" style="font-size:11.5px;color:#6b7078;margin-top:6px"></div>';
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
          // 2026-11-08 安全收紧：47990（Sunshine 管理后台）不对局域网放行，只走 Tailscale。
          // 当前页面如果是局域网 IP，就用 tailnet 地址打开后台。
          const onLanNow = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname || '');
          const tsIpNow = (() => {
            try {
              const l = (lastStatus && lastStatus.lanIps) || [];
              const x = l.filter((y) => /^100\./.test(String(y.ip || '')))[0];
              return x ? x.ip : ((lastStatus && lastStatus.tailnetIp) || '');
            } catch (e) { return ''; }
          })();
          const adminHost = onLanNow ? tsIpNow : location.hostname;
          if (!adminHost) { if (msgEl) msgEl.textContent = '管理后台只走 Tailscale：请先在手机上连上 Tailscale 再打开'; return; }
          if (onLanNow) { if (msgEl) msgEl.textContent = '管理后台不对局域网开放，已用 Tailscale 地址打开（账号 ' + c.username + ' · 密码已复制）'; }
          window.open('https://' + adminHost + ':47990/', '_blank', 'noopener');
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
          // 必须看 licensed（真的装了许可证），不能看 usable（免费版 usable 也是 true），
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

  // ---- 「许可证」分区：专业版 / 免费版 + 粘贴激活 -------------------
  // 2026-11-08：7 天试用规则已彻底删除（产品完全免费），这里只区分
  // "装了许可证" 和 "没装许可证（免费版）"，口令/有效期来自 /licence 的 licensed。
  // lic.usable 仍然只负责"解锁超清/个性化/并发"的行为判断，不进文案。

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
    h += '<div style="color:#868c96;font-size:12.5px;margin-top:5px;line-height:1.7">'
      + '完全免费：画面 + 触控 + 声音 + 流畅模式 + 高清/标准画质（不限时）<br>'
      + '超清画质、外观个性化等也全部免费，没有试用期、没有功能锁。'
      + '</div>';
    if (uq && uq.ultra) {
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
              if (isBlocked) tag += '<span style="color:#ffb454;font-size:10.5px">被旧防火墙规则挡住</span>'
                + '<button class="lanFix" style="background:#7a2f2f;color:#ffd7d7;border:1px solid #a44;border-radius:6px;padding:2px 8px;font-size:10.5px;cursor:pointer">点这里修复（弹一次管理员授权）</button>';
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
      // 2026-11-07：被旧防火墙规则挡住时给一个可点的修复入口（重跑 /offline/on 会提权修规则）
      bodyEl.querySelectorAll('.lanFix').forEach((b) => b.addEventListener('click', async () => {
        const m = bodyEl.querySelector('#lanCheckMsg');
        if (m) m.textContent = '正在修复：请在电脑上点「是」（管理员授权）…';
        try {
          await fetch('/offline/repair', { method: 'POST' });
          setTimeout(() => { try { refresh(); } catch (e) { } }, 6000);
        } catch (e) { if (m) m.textContent = '修复请求失败：' + ((e && e.message) || e); }
      }));
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
      // （「真息屏」按钮的文字/状态由 paintSleep 管，这里不再覆盖）
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
    // 2026-11-11：一键息屏 = 用黑屏遮罩把本机盖住（不锁键鼠），远程照常可见。
    // 为什么不用"关显示器"：实测真关屏（DPMS）后桌面复制抓不到（access denied / 挂住），远程就黑了。
    // 2026-11-11：真息屏 = 把显示器背光调到 0（不是 DPMS 关屏！关屏会让抓屏失败、远程就黑了）。
    // 实测：背光 0 时桌面复制照常出帧，所以"屏幕不亮 + 手机照常看"可以同时成立。
    const sleepBtn = box.querySelector('#prvSleep');
    const sleepMsg = box.querySelector('#prvSleepMsg');
    const saySleep = (t, c) => { if (sleepMsg) { sleepMsg.textContent = t; sleepMsg.style.color = c || '#6b7078'; } };
    const paintSleep = (st) => {
      if (!sleepBtn) return;
      const on = !!(st && st.sleeping);
      sleepBtn.textContent = on ? '恢复亮屏' : '息屏（挡住屏幕）';
      sleepBtn.style.background = on ? '#7a2f2f' : '#1f2a3a';
      if (on && sleepMsg) saySleep('息屏中：屏幕纯黑、看不到任何内容；手机照常。点「恢复亮屏」还原。', '#8CE58C');
    };
    const refreshSleep = () => fetch('/screen/state', { cache: 'no-store' }).then((r) => r.json()).then(paintSleep).catch(() => { });
    if (sleepBtn) sleepBtn.addEventListener('click', async () => {
      sleepBtn.disabled = true;
      try {
        const st = await (await fetch('/screen/state', { cache: 'no-store' })).json();
        if (st && st.sleeping) {
          const r = await (await fetch('/screen/wake', { method: 'POST' })).json();
          saySleep('已恢复亮屏（背光 ' + (r && r.brightness) + '）', '#8CE58C');
        } else {
          const r = await (await fetch('/screen/sleep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: dev }) })).json();
          if (r && r.ok) saySleep('已息屏：电脑屏幕纯黑（看不到内容），你手机上照常能看能操作', '#8CE58C');
          else saySleep((r && r.message) || '息屏失败', '#ffb454');
        }
        await refreshSleep();
      } catch (e) { saySleep('操作失败：' + (e && e.message), '#ff9d9d'); }
      sleepBtn.disabled = false;
    });
    refreshSleep();
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
    // 2026-11-09：周末（周六、周日）
    if (r.repeat === 'weekend') return '周末';
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
      + '<button class="pwPre" data-pre="selftest" style="background:#2a2d36;color:#8fb6ff;border:1px solid #3f6fd0;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">自检：2 分钟后休眠 · 4 分钟后唤醒</button>'
      + '</div>';

    if (!rules.length) {
      h += '<div style="color:#6b7078;font-size:12.5px;margin-bottom:10px">还没有规则。点上面的快捷按钮，或自己在下面加一条。</div>';
    } else {
      rules.forEach((r, i) => {
        const tk = taskOf(r.id);
        const ruleOn = r.enabled !== false;
        // 2026-11-09：把「下次休眠」和「下次唤醒」都显出来。之前只显示 off 的 next，
        // 用户看不出唤醒到底排在什么时候（实测踩过：填了 05:30 以为是下午 5 点半）。
        let nextTxt = '';
        if (tk.off && tk.off.next) nextTxt += ' · 下次休眠 ' + esc2(tk.off.next);
        if (tk.wake && tk.wake.next) nextTxt += ' · 下次唤醒 ' + esc2(tk.wake.next);
        if (!ruleOn) nextTxt = ' · <span style="color:#ffb454">已关闭</span>';
        h += '<div style="display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #202228;font-size:13px' + (ruleOn ? '' : ';opacity:.55') + '">'
          + '<input type="checkbox" data-pwrule="' + i + '"' + (ruleOn ? ' checked' : '') + ' title="单条启用/停用" style="width:15px;height:15px;flex:0 0 auto;cursor:pointer;accent-color:#35D6C4">'
          + '<span style="flex:1;min-width:0;color:#c9ccd1;' + (ruleOn ? '' : 'text-decoration:line-through') + '">' + pwRuleText(r)
          + (r.mode === 'shutdown' && r.wakeTime ? ' <span style="color:#ff6b6b;font-weight:700">（关机后叫不醒）</span>' : '')
          + '<span style="color:#6b7078;font-size:11.5px">' + nextTxt + '</span></span>'
          + '<button data-pwdel="' + i + '" style="background:#2a2d36;color:#ff9d9d;border:1px solid #3a3e4a;border-radius:7px;padding:3px 9px;font-size:12px;cursor:pointer">删除</button></div>';
      });
    }

    // 编辑器
    h += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #23252c">'
      + '<div style="color:#aeb3bb;font-size:12.5px;margin-bottom:8px">加一条规则</div>'
      // 2026-11-09：提示从输入框下方移到上方。手机用户反馈"点加入没反应"，
      // 一部分原因就是失败/成功提示在他们视线之外。
      + '<div id="pwMsg" style="color:#8CE58C;font-size:12px;margin:0 0 8px;line-height:1.7;word-break:break-all">' + (busy ? '<span style="color:#ffb454">正在应用，请稍候…</span>' : '') + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px">'
      + '<label style="color:#868c96">休眠/关机 <input id="pwOff" type="time" value="23:00" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"></label>'
      + '<label style="color:#868c96">唤醒 <input id="pwWake" type="time" value="07:30" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"></label>'
      + '<select id="pwRepeat" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekend">周末</option><option value="once">仅一次</option></select>'
      + '<input id="pwDate" type="date" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px">'
      + '<select id="pwMode" style="background:#14151a;border:1px solid #24262e;color:#e8eaee;border-radius:6px;padding:4px 6px"><option value="hibernate">休眠（可定时开机）</option><option value="shutdown">关机</option></select>'
      + '<button id="pwAdd" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer">加入</button>'
      + '<button id="pwApply" style="background:#2f6b3a;color:#e8eaee;border:0;border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer">保存并应用</button>'
      + '</div>'
      + '<div id="pwWarn" style="display:none;color:#ff6b6b;font-size:12px;font-weight:700;margin-top:8px;line-height:1.7">⚠ 你选了「关机」又填了唤醒时间：完全关机之后软件叫不醒电脑，这次唤醒不会生效。想要定时开机，请把方式改成「休眠」。</div>'
      + ((st && st.wakeMissing) ? '<div style="color:#ff6b6b;font-size:12px;font-weight:700;margin-top:8px;line-height:1.7">⚠ 检测到「唤醒任务」缺失：今晚的定时休眠不会自动唤醒。请点下面的「保存并应用」重建（会弹一次管理员授权）。</div>' : '')
      + '<div style="color:#6b7078;font-size:11.5px;margin-top:6px;line-height:1.7">休眠可以被定时叫醒（醒来回到原界面）；完全关机后叫不醒。'
      + '<b style="color:#ffb454">保存带「唤醒」的规则时会弹一次管理员授权</b>：定时唤醒要用系统身份注册计划任务，普通用户身份注册的闹钟在部分机器上到点不醒（已实测）。'
      + '另外，如果这台机器的主板 BIOS 没开 RTC 唤醒，系统侧闹钟登记了也不会醒 —— 请先点上面的「自检」：'
      + '能自己回来就说明支持；回不来就要进 BIOS（开机按 F2）找 <b>Power / Automatic Power On / Wake on RTC / Wake up on Time</b> 打开它，'
      + '或者只能把「关机」时间当纯定时休眠用、手动开机。</div>'
      + '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #202228;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + ((st && st.profile === 'release') ? '' : '<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;color:#c9ccd1;cursor:pointer"><input type="checkbox" id="pwUnlock"' + (st && st.unlockOnWake ? ' checked' : '') + ' style="width:15px;height:15px"> 唤醒后不要求登录（自用便利模式）</label>')
      + '<span style="flex:1"></span>'
      + '<button id="pwLockNow" style="background:#2a2d36;color:#c9ccd1;border:1px solid #3a3e4a;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer">立即锁屏</button>'
      + '</div>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:4px;line-height:1.6">' + ((st && st.profile === 'release') ? '唤醒后不要求登录：仅自用版提供，发布版不提供该选项。' : '勾选后：唤醒/开机直接回桌面，手机不用输 Windows 密码。代价是走到电脑前的人也能直接用 —— 用完可以点「立即锁屏」。改完会弹一次管理员授权。') + '</div>'
      + '</div>';

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


    return h;
  }
  function powerBind(box) {
    const wrap = box.querySelector('#pwWrap');
    if (!wrap) return;
    let pwCache = { enabled: false, rules: [] };
    let lastSt = null;          // 最近一次完整状态，用于「加入」时只重绘列表、不提交
    let pollTimer = 0;
    // 2026-11-09：手机端 <input type="time"> 的 value 不一定是标准 HH:mm
    // （部分 Android 浏览器/输入法会给 "2:00 PM"、"02:00PM" 这类格式），
    // 原来的严格正则会把用户填好的时间判成非法，然后什么都不会发生 —— 用户看到的就是"点了加入没反应"。
    // 这里统一宽容解析：标准 24 小时制、带 AM/PM 的 12 小时制都接受，统一转成 HH:mm。
    const parseTimeInput = (raw) => {
      const v = String(raw || '').trim();
      if (!v) return '';
      let m = v.match(/^([01]?\d|2[0-3]):([0-5]\d)(:\d{2})?$/);
      if (m) return String(m[1]).padStart(2, '0') + ':' + m[2];
      m = v.match(/^(\d{1,2}):([0-5]\d)\s*([AaPp])\.?[Mm]\.?$/);
      if (m) {
        let h = parseInt(m[1], 10);
        const mm = m[2];
        const pm = (m[3] || '').toLowerCase() === 'p';
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
        if (h >= 0 && h <= 23) return String(h).padStart(2, '0') + ':' + mm;
      }
      return '';
    };
    const msg = (t, c) => { const m = box.querySelector('#pwMsg'); if (m) { m.innerHTML = esc2(t); m.style.color = c || '#868c96'; } };
    const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } };
    const paint = (st) => {
      lastSt = st || null;
      pwCache = { enabled: !!(st && st.enabled), rules: (st && Array.isArray(st.rules)) ? st.rules : [] };
      wrap.innerHTML = powerRowsHtml(st);
      const wireWarn = () => {
        const m = wrap.querySelector('#pwMode');
        const t = wrap.querySelector('#pwWake');
        const w = wrap.querySelector('#pwWarn');
        const sync = function () {
          if (!w) return;
          const okTime = t && /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t.value || '').trim());
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
        // 2026-11-07：唤醒自检。有些笔记本主板默认没开 RTC 唤醒，软件侧定时器注册了也不醒。
        // 这条规则 2 分钟后休眠、4 分钟后唤醒，一次就能验出这台机器到底能不能定时开机。
        if (kind === 'selftest') {
          const off = new Date(now.getTime() + 2 * 60 * 1000);
          const wake = new Date(now.getTime() + 4 * 60 * 1000);
          const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          rules.push({ id: 'selftest', mode: 'hibernate', repeat: 'once', date: ymd(off), offTime: hh(off), wakeTime: hh(wake) });
        }
        post({ enabled: true, rules: rules });
      }));
      // 2026-11-09：单条规则的启用/停用开关。开关是"立即生效"的语义，
      // 所以这里直接提交；停用的规则在引擎里会被跳过并删掉它遗留的计划任务。
      wrap.querySelectorAll('[data-pwrule]').forEach((cb) => cb.addEventListener('change', () => {
        const i = Number(cb.getAttribute('data-pwrule'));
        const rules = pwCache.rules.slice();
        if (!rules[i]) return;
        rules[i] = Object.assign({}, rules[i], { enabled: !!cb.checked });
        post({ enabled: pwCache.enabled, rules: rules });
      }));
      const add = wrap.querySelector('#pwAdd');
      if (add) add.addEventListener('click', () => {
        const rawOff = String((wrap.querySelector('#pwOff') || {}).value || '').trim();
        const rawWake = String((wrap.querySelector('#pwWake') || {}).value || '').trim();
        const off = parseTimeInput(rawOff);
        const wake = parseTimeInput(rawWake);
        const repeat = (wrap.querySelector('#pwRepeat') || {}).value || 'daily';
        const date = String((wrap.querySelector('#pwDate') || {}).value || '').trim();
        const mode = (wrap.querySelector('#pwMode') || {}).value || 'hibernate';
        // 校验失败时把「实际读到的值」也显示出来，否则用户完全不知道哪一步卡住了
        if (!off) { msg('休眠/关机时间没读到有效值（读到的是 "' + rawOff + '"）。请重新选一次时间。', '#ff6b6b'); return; }
        if (rawWake && !wake) { msg('唤醒时间没读到有效值（读到的是 "' + rawWake + '"）。请重新选一次时间。', '#ff6b6b'); return; }
        if (wake && wake === off) { msg('唤醒时间和休眠时间不能一样（都是 ' + off + '）', '#ffb454'); return; }
        if (repeat === 'once') {
          if (!date) { msg('选「仅一次」时要选日期', '#ffb454'); return; }
          const when = new Date(date + 'T' + off + ':00');
          if (isNaN(when.getTime()) || when.getTime() <= Date.now()) { msg('这个日期时间已经过去了，换一个', '#ffb454'); return; }
        }
        // 2026-11-09 修：原来「加入」直接 post 到系统，和「保存并应用」完全重复（用户反馈）。
        // 现在「加入」只把规则放进本地列表并重绘，真正写进系统要再点「保存并应用」。
        const rules = pwCache.rules.concat([{ id: 'r' + Date.now().toString(36), offTime: off, wakeTime: wake, repeat: repeat, date: repeat === 'once' ? date : '', mode: mode, enabled: true }]);
        pwCache.rules = rules;
        pwCache.enabled = true;
        paint(Object.assign({}, lastSt || {}, { enabled: true, rules: rules }));
        // 2026-11-09：手机用户反馈"点了加入没反应"——功能其实是好的（规则确实进列表了），
        // 但没有任何可见反馈：新规则加在列表末尾可能在视口外，提示文字也在下方看不见。
        // 所以这里强制做三件事：①滚到新规则 ②按钮闪一下 ③消息回显实际加入的内容。
        try {
          const w2 = document.querySelector('.paSetBox').querySelector('#pwWrap');
          const cbs = w2 ? w2.querySelectorAll('[data-pwrule]') : [];
          const lastCb = cbs[cbs.length - 1];
          if (lastCb && lastCb.parentElement) lastCb.parentElement.scrollIntoView({ block: 'center' });
          const addBtn2 = w2 ? w2.querySelector('#pwAdd') : null;
          if (addBtn2) {
            addBtn2.textContent = '✓ 已加入';
            addBtn2.style.background = '#2a6b3a';
            setTimeout(function () {
              try { addBtn2.textContent = '加入'; addBtn2.style.background = '#2f6feb'; } catch (e) { }
            }, 1500);
          }
        } catch (e) { }
        const repTxt = (repeat === 'weekdays' ? '工作日' : (repeat === 'weekend' ? '周末' : (repeat === 'once' ? '仅一次' : '每天')));
        msg('已加入：' + repTxt + ' ' + off + ' 休眠' + (wake ? (' → 唤醒 ' + wake) : '') + '（共 ' + rules.length + ' 条）。点「保存并应用」才会写进系统。', '#8CE58C');
      });
      const uw = wrap.querySelector('#pwUnlock');
      if (uw) uw.addEventListener('change', () => {
        post({ enabled: pwCache.enabled, rules: pwCache.rules, unlockOnWake: uw.checked });
      });
      const lk = wrap.querySelector('#pwLockNow');
      if (lk) lk.addEventListener('click', async () => {
        if (!confirm('现在锁屏？锁上以后手机端要输 Windows 密码才能解锁（除非开了上面的免登录）。')) return;
        try { await fetch('/lock', { method: 'POST' }); msg('已锁屏', '#8CE58C'); } catch (e) { msg('锁屏请求失败：' + ((e && e.message) || e), '#ff9d9d'); }
      });
      const ap = wrap.querySelector('#pwApply');
      if (ap) ap.addEventListener('click', () => {
        // 2026-11-09：用户反馈"填好了直接点保存却加不进去"——保存原来只看列表，不理输入框。
        // 现在保存时如果输入框里填了有效时间，自动把它并进列表一起保存（并清空输入框，
        // 避免下次保存重复添加同一条）。
        try {
          const rawOff = String((wrap.querySelector('#pwOff') || {}).value || '').trim();
          const rawWake = String((wrap.querySelector('#pwWake') || {}).value || '').trim();
          const off = parseTimeInput(rawOff);
          const wake = parseTimeInput(rawWake);
          const repeat = (wrap.querySelector('#pwRepeat') || {}).value || 'daily';
          const date = String((wrap.querySelector('#pwDate') || {}).value || '').trim();
          const mode = (wrap.querySelector('#pwMode') || {}).value || 'hibernate';
          if (off && (!wake || (wake && wake !== off)) && (repeat !== 'once' || date)) {
            const rules2 = pwCache.rules.concat([{ id: 'r' + Date.now().toString(36), offTime: off, wakeTime: wake, repeat: repeat, date: repeat === 'once' ? date : '', mode: mode, enabled: true }]);
            pwCache.rules = rules2;
            pwCache.enabled = true;
            const repTxt2 = (repeat === 'weekdays' ? '工作日' : (repeat === 'weekend' ? '周末' : (repeat === 'once' ? '仅一次' : '每天')));
            msg('保存中（已自动加入：' + repTxt2 + ' ' + off + ' 休眠' + (wake ? ' → 唤醒 ' + wake : '') + '）…', '#8CE58C');
            // 清空输入框，防止重复添加
            try {
              const o = wrap.querySelector('#pwOff'); if (o) o.value = '';
              const w = wrap.querySelector('#pwWake'); if (w) w.value = '';
            } catch (e2) { }
          }
        } catch (e3) { }
        post({ enabled: pwCache.enabled, rules: pwCache.rules });
      });
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

    // 页面版本：放在设置最上面，一眼能看到（排查"新旧页面"问题时第一步就看它）
    body += '<div style="color:#4f5561;font-size:10.5px;margin:-2px 0 10px">页面版本 ' + PA_PAGE_VER
      + ' · 电脑端 ' + escHtml(lic.version || '—') + '</div>';
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
    // 2026-11-08：本次已连接多久（原来只有"实时"那行瞬时值，看不出连了多久）
    try {
      const secs = Math.max(0, Math.round((Date.now() - (window.__paStart || Date.now())) / 1000));
      const t = secs < 60 ? (secs + ' 秒') : (Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒');
      connInner += setKv('已连接', '<span style="color:#aeb3bb">' + t + '</span>');
    } catch (e) { }
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
    // 2026-11-08：个性化——工具条把手位置 + 强调色
    body += setSection('界面', interfaceInner(), 'basic');
    // 2026-11-09：手势说明（双指/三指/长按这些一直没人猜得到）
    body += setSection('手势说明', gestureInner(), 'basic');

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
      + '<div style="margin-top:14px;color:#c9ccd1;font-size:12.5px;font-weight:600">手机传到电脑的文件</div>'
      // 2026-11-10（用户反馈"找不到文件在哪 / 为什么不能改路径"）：把保存位置直接摆出来，
      // 并给「在电脑上打开」「更改位置」两个按钮。
      + '<div id="fileDirBox" style="margin-top:7px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;'
      + 'background:#14151a;border:1px solid #24262e;border-radius:9px;padding:8px 10px">'
      + '<span style="color:#8b9098;font-size:11.5px;flex:0 0 auto">保存到</span>'
      + '<span id="fileDirPath" style="flex:1 1 140px;min-width:120px;color:#c9ccd1;font-size:11.5px;'
      + 'word-break:break-all;font-family:ui-monospace,Consolas,monospace">读取中…</span>'
      + '<button id="fileDirOpen" style="background:#2a2d36;color:#e8eaee;border:1px solid #3a3e4a;border-radius:7px;'
      + 'padding:4px 9px;font-size:11.5px;cursor:pointer;white-space:nowrap">在电脑上打开</button>'
      + '<button id="fileDirChange" style="background:#1f2a3a;color:#bcd4ff;border:1px solid #2d4a6e;border-radius:7px;'
      + 'padding:4px 9px;font-size:11.5px;cursor:pointer;white-space:nowrap">更改位置</button>'
      + '</div>'
      + '<div id="fileList" style="margin-top:7px;color:#868c96;font-size:12px">正在读取…</div>');

    // 高性能模式（Sunshine/Moonlight）——2026-11-03 S3：电脑装好 Sunshine 后，手机装 Moonlight 用 PIN 配对。
    body += setSection('串流玩游戏（Moonlight）',
      '<div id="secSunshine"></div>'
      + '<div id="ssBody" style="color:#868c96;font-size:12.5px;line-height:1.7">正在检测…</div>'
      // 2026-11-08：同一 Wi-Fi 串流开关（独立于离线模式；只放行 Sunshine 端口，不含 47990）
      + '<div id="ssLanBox" style="margin-top:12px;padding-top:10px;border-top:1px solid #23252c">'
      + '<div style="color:#7d838d;font-size:11.5px;font-weight:700;letter-spacing:.06em">同一 Wi-Fi 串流</div>'
      + '<div id="ssLanState" style="color:#6b7078;font-size:11.5px;margin-top:4px">读取中…</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'
      + '<button id="ssLanOn" style="background:#2f6b3a;color:#e8eaee;border:0;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">允许同一 Wi-Fi 串流</button>'
      + '<button id="ssLanOff" style="background:#2a2d36;color:#c9ccd1;border:1px solid #3a3e4a;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">关闭并恢复</button>'
      + '</div>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:5px;line-height:1.6">只放行 Sunshine 自己的端口（程序限定、来源仅局域网私有网段、不含 47990 管理后台）；关掉时规则全部删除、恢复只允许 Tailscale。开/关都会弹一次管理员授权。</div>'
      + '</div>'
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
      + '<label>帧率 <select id="hqFps" class="paSel"><option value="30">30</option><option value="60">60</option><option value="90">90</option><option value="120">120</option><option value="240">240（需设备支持）</option></select></label>'
      + '<label>码率 <select id="hqKbps" class="paSel"><option value="8000">8 Mbps（≈3.4 GB/时）</option><option value="12000">12 Mbps（≈5.3 GB/时）</option><option value="15000">15 Mbps（≈6.7 GB/时）</option><option value="20000">20 Mbps（≈8.9 GB/时）</option><option value="30000">30 Mbps（≈13.4 GB/时）</option><option value="50000">50 Mbps（≈22.5 GB/时）</option><option value="80000">80 Mbps（≈36 GB/时）</option><option value="100000">100 Mbps（≈45 GB/时）</option></select></label>'
      + '<button id="hqAuto" title="按网络自动调码率：丢包就降、稳定再升" style="background:#2a2d36;color:#c9ccd1;border:1px solid #3a3e4a;border-radius:9px;padding:7px 12px;font-size:12.5px;cursor:pointer">自动</button>'
      + '</div>'
      + '<div style="color:#6b7078;font-size:11px;margin-top:8px">流量只由码率决定：1 Mbps ≈ 0.45 GB/时；分辨率/帧率改的是清晰度和流畅度，几乎不加减流量。'
      + '手机流量紧张选 8 Mbps；同网可 60fps，跨网建议 30fps。实测 20 Mbps 约 19.8、12 约 11.8、8 约 7.5–8 Mbps。50/80/100 Mbps 属于高负载档：只建议在局域网/Tailscale 直连时用，4G 一定卡。</div>'
      + '<div id="hqFlow" style="font-size:12.5px;color:#8CE58C;margin-top:8px"></div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;color:#c9ccd1;font-size:12.5px;cursor:pointer">'
      + '<input type="checkbox" id="hqWin"> 单窗口采集（实验：只传选中的窗口，被挡住也能抓；约 10–30fps）</label>'
      + '<div id="hqMsg" style="font-size:12.5px;color:#868c96;margin-top:8px"></div>'
  + '<div id="hqCap" style="font-size:11.5px;color:#6b7078;margin-top:6px;line-height:1.6"></div>');

    // 个性化（许可证功能；未授权显示锁定说明与购买入口）
    body += setSection('外观（主题 / 光标）', p13nInner(lic));

    // 防窥屏（privacy mode）：盖住电脑本机屏幕，手机端不受影响
    body += setSection('防窥屏',
      // 2026-11-11：一键息屏。实测结论：**真正把显示器电源关掉（DPMS）时，桌面复制抓不到画面**
      // （探针不是报 access denied 就是直接挂住不出帧），远程就瞎了。
      // 所以这里的"息屏"用防窥屏的黑屏遮罩实现：本机屏幕全黑、看不到任何东西，
      // 但系统仍在正常合成，远程画面完全不受影响 —— 这才是"人不在电脑前"想要的效果。
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">'
      + '<button id="prvSleep" style="background:#1f2a3a;color:#bcd4ff;border:1px solid #2d4a6e;border-radius:9px;'
      + 'padding:9px 15px;font-size:13px;cursor:pointer">息屏（挡住屏幕）</button>'
      + '<span id="prvSleepMsg" style="font-size:12px;color:#6b7078;flex:1;min-width:160px;line-height:1.6">'
      + '电脑屏幕立刻变成纯黑（<b>什么都看不到</b>，别人看不到你的桌面），同时把背光降到 0；'
      + '电脑照常运行，你手机上的画面和操作完全不受影响。'
      + '会一直保持到你点「恢复亮屏」（最长 8 小时自动恢复）。</span>'
      + '</div>'
      + '<div style="color:#aeb3bb;font-size:12.5px;line-height:1.75">'
      + '下面的「防窥屏」更彻底：电脑本机会被一层锁屏图盖住，屏幕前的人看不到桌面、鼠标点不动；'
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

    // 2026-11-08 UI 改版第 4 批：分页外壳。14 个分区按「常用 / 功能 / 网络 / 关于」过滤，
    // 各分区的内容一律没动，只是在外层加了个页签和显隐开关。
    body = '<div id="setTabs" class="paTabs">'
      + '<button type="button" data-tab="basic" class="on">常用</button>'
      + '<button type="button" data-tab="func">功能</button>'
      + '<button type="button" data-tab="net">网络</button>'
      + '<button type="button" data-tab="about">关于</button>'
      + '</div>' + body;

    const box = openSheet('设置', body, 'setClose');

    // 页签切换：只切 .setSec[data-tab] 的显隐，卡片内部的元素（含事件绑定）一直活着
    (function bindSetTabs() {
      const tabsEl = box.querySelector('#setTabs');
      if (!tabsEl) return;
      const show = function (key) {
        const secs = box.querySelectorAll('.setSec[data-tab]');
        for (let i = 0; i < secs.length; i++) {
          secs[i].style.display = (secs[i].getAttribute('data-tab') === key) ? '' : 'none';
        }
        const bs = tabsEl.querySelectorAll('button');
        for (let j = 0; j < bs.length; j++) {
          bs[j].classList.toggle('on', bs[j].getAttribute('data-tab') === key);
        }
      };
      tabsEl.addEventListener('click', function (e) {
        const t = e.target;
        const b = (t && t.closest) ? t.closest('button[data-tab]') : null;
        if (b) show(b.getAttribute('data-tab'));
      });
      show('basic');
    })();

    // 个性化 + 许可证粘贴激活的事件绑定（半免费）
    p13nBind(box, lic);
    interfaceBind(box);
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
    // 2026-11-10：手动重连要连退避标记一起清掉，否则会一直停在 WS 回落路径上。
    if (rl) rl.addEventListener('click', () => {
      try { sessionStorage.removeItem('rtc264OffAt'); } catch (e) { }
      location.reload();
    });

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
      // 2026-11-10：这一版改动很大（花屏 / 黑屏等待 / 音画不同步 / 弱机器保护），
      // 在「关于」里直接告诉用户修好了什么，比让他去猜"是不是缓存还是老样子"有用得多。
      + '<div style="margin:13px 0 0;padding:11px 13px;border-radius:10px;background:#14151a;'
      + 'border:1px solid #24262e;color:#aeb3bb;font-size:12px;line-height:1.8">'
      + '<span style="color:#8CE58C;font-weight:600">这一版（1.0.21）修好了</span><br>'
      + '· 全屏 / 最小化窗口时偶尔「花一下」——找到真因并修掉了<br>'
      + '· 切「清晰」以前要黑等好几秒，现在几乎立刻出画面<br>'
      + '· 声音越听越不同步（几分钟偏一点、突然跳一下）——现在会一直对齐<br>'
      + '· 弱电脑一开清晰就黑屏——现在自动识别，按设备能力降档，保证有画面<br>'
      + '· 240fps 下偶发黑屏、解码队列越拖越卡——都已修'
      + '</div>'
      + machineCodeHtml(lic)
      + (lic.licensed
        ? '<div style="color:#6b7078;font-size:11.5px;margin-top:10px">这台电脑已经装好许可证（可选项）。</div>'
        : '<div style="color:#6b7078;font-size:11.5px;margin-top:10px">许可证是可选项：不装不影响任何功能；需要时在「设置 → 许可证」里粘贴。</div>')
      + '<div style="margin-top:16px">' + supportHtml(lic, true) + '</div>'
      + biliBlockHtml(lic)
      + '<div style="color:#4f5561;font-size:10.5px;margin-top:14px">页面版本 ' + PA_PAGE_VER
      + '（如果你刚更新过电脑端却还看到老问题，多半是手机缓存了旧页面：下拉刷新或「清除缓存」一次）</div>'
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
    // 2026-11-08 UI 改版第 3 批补充：原来这三个圆按钮 fixed 在右下角，和缩放浮层、
    // 工具条把手挤成一竖列（用户横屏截图里"最右边一堆东西"）。
    // 现在 display:contents 让它们直接变成「更多」抽屉里的三个格子，右侧彻底清空。
    wrap.style.cssText = 'display:contents';
    const gear = makeBtn('paGear', ICON_GEAR, '设置');
    wrap.appendChild(gear);
    // 套餐按钮（2026-10-30 加）：三种方案写在这里，价格由 product.config.json 的 plans 提供，
    // 卖家改价格/改文案不用改代码。plans.enabled=false 就整个隐藏。
    const plans = lic.plans || null;
    const showPlans = !!(plans && plans.enabled !== false && Array.isArray(plans.items) && plans.items.length);
    let priceBtn = null;
    if (showPlans) {
      priceBtn = makeBtn('paPlans', ICON_PRICE, (plans.title || '套餐'));
      wrap.appendChild(priceBtn);
    }
    // 支持按钮：卖家可以在 product.config.json 里用 support.enabled=false 整体关掉
    const showSupport = !(lic.support && lic.support.enabled === false);
    let heart = null;
    if (showSupport) {
      heart = makeBtn('paSupport', ICON_HEART, ((lic.support && lic.support.title) || '关于'));
      wrap.appendChild(heart);
    }
    // 塞进抽屉的功能网格（#paSheet .paGrid），没有就退回 body 免得整块消失
    const grid = document.querySelector('#paSheet .paGrid');
    (grid || document.body).appendChild(wrap);
    // 抽屉里只有图标认不出来，给每个格子补一行小字。
    // 注意：makeBtn 写的是 inline 样式（圆形 34px），外部 CSS 压不过它，
    // 所以这里必须直接改 inline，否则它们在网格里还是三个小圆点挤成一团。
    [gear, priceBtn, heart].forEach(function (b) {
      if (!b) return;
      b.style.cssText = 'width:auto;min-width:0;height:46px;border-radius:14px;padding:0 4px;'
        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;'
        + 'background:#1A1D25;border:1px solid rgba(255,255,255,.07);color:#C6CCD4;'
        + 'box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;cursor:pointer';
      const s = document.createElement('span');
      s.style.cssText = 'font-size:10.5px;line-height:1;color:#A8B0BA';
      s.textContent = (b.id === 'paPlans') ? '套餐' : b.title;
      b.appendChild(s);
    });
    // 用最新的许可证信息而不是页面加载时那一份：页面可能开着跨过许可证到期，
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
  /* 第 3 批：#hud 已经住进顶部状态胶囊，不能再按 " · " 拆成多行（会把胶囊撑高挡住画面） */
  #hud { white-space: nowrap !important; text-align: left !important; }
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
      // 2026-11-10：#hud 在 WebRTC264 模式下已经完整（直连·分辨率·帧率·码率·缓冲），
      // #stat 只是它的压缩版；横屏（>960px）时两个都露出来 → 用户看到重复的两份数值。
      // 只在 WebRTC264 模式隐藏 #stat；WebCodecs/低频/MJPEG 的 #hud 不完整，必须保留 #stat。
      var rtcMode = !!(window.__rtc264 && window.__rtc264.pc && h && (h.textContent || '').indexOf('WebRTC264') === 0);
      if (s) s.style.display = (on && !rtcMode) ? '' : 'none';
      // 2026-11-08：两个数值都关掉时，顶部胶囊不能留个空壳继续占着画面（用户反馈"关不掉"）
      var top = document.getElementById('paTop');
      if (top) top.style.display = on ? '' : 'none';
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
/* 2026-11-08：#mobSheet 这个元素从来没被创建过（页面里查不到），
   原来这段挂在它上面的点击收起脚本是空操作，已随死代码清理删除。 */
</script>
<script>
/* 2026-11-08 UI 改版第 3 批补充：工具条收起 / 从右边缘拉出（用户反馈底部条挡画面） */
(function () {
  try {
    var handle = document.getElementById('paHandle');
    var body = document.body;
    var timer = null;
    function open() { body.classList.add('uiopen'); if (timer) { clearTimeout(timer); timer = null; } }
    function close() { body.classList.remove('uiopen'); if (timer) { clearTimeout(timer); timer = null; } }
    window.__paUiOpen = open;
    window.__paUiClose = close;
    if (handle) {
      handle.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      handle.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(); });
    }
    // 点画面就把工具条收起来；这一下照常发给电脑（不吞点击，否则"想收工具条"会丢一次点击）
    var ov = document.getElementById('overlay');
    if (ov) ov.addEventListener('pointerdown', function () { close(); }, true);
    // 打开页面先亮出来，让人看见工具条在哪。
    // 2026-11-08：第一次进页面**不自动收起**（新用户很可能没注意到就收了，之后只剩一个
    // 没人认识的小竖条）；同时给一句提示。之后的访问仍然 4.5 秒自动收起。
    open();
    var firstVisit = false;
    try { firstVisit = !localStorage.getItem('pa.seen'); } catch (e) { }
    if (firstVisit) {
      try { localStorage.setItem('pa.seen', '1'); } catch (e) { }
      try { setNote('点画面任意处可收起工具条；收起后点左边缘的小竖条再叫出来', 7000); } catch (e) { }
    } else {
      timer = setTimeout(function () {
        var sh = document.getElementById('paSheet');
        if (sh && sh.classList.contains('on')) return;
        close();
      }, 4500);
    }
  } catch (e) { }
})();
(function () {
  try {
    var more = document.getElementById('moreBtn');
    var sheet = document.getElementById('paSheet');
    if (!more || !sheet) return;
    function setOpen(on) {
      sheet.classList.toggle('on', on);
      more.classList.toggle('on', on);
      more.textContent = on ? '收起' : '更多';
    }
    more.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      setOpen(!sheet.classList.contains('on'));
    });
    // 抽屉里点了任何按钮 → 收起来，别一直挡着画面下半截
    sheet.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'BUTTON') setTimeout(function () { setOpen(false); }, 90);
    });
    // 点画面其它地方也收起；这一下不往电脑发点击（否则"想关抽屉"会顺手点坏电脑上的东西）
    document.addEventListener('pointerdown', function (e) {
      if (!sheet.classList.contains('on')) return;
      if (sheet.contains(e.target) || more.contains(e.target)) return;
      setOpen(false);
      e.stopPropagation();
    }, true);

    // 2026-11-09：抽屉里的「重新连接」——重新加载页面即重建 WebRTC 会话
    var rc = document.getElementById('paReconnect');
    if (rc) rc.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      // 2026-11-10：重连先清掉 WebRTC 退避标记（否则会一直停在 WS 回落路径上）
      try { sessionStorage.removeItem('rtc264OffAt'); } catch (err0) { }
      try { location.reload(); } catch (err) { }
    });
  } catch (e) { }
})();
</script>
</body></html>`;

// 页面版本：屏幕端和页面端共用同一个值（服务端 import 后做 __PAGE_VER__ 替换，
// 并在 /rtc264/offer 的日志里打出手机带上来 pv，用来识别"手机还在跑缓存旧页面"）。
export const PAGE_VER = '2026-11-13.3';
export const PAGE = (key, manifestHref = '/manifest.json') => PAGE_HTML
  .replace(/__PAGE_VER__/g, PAGE_VER)
  .replace(/__KEY__/g, encodeURIComponent(key))
  // 用函数式替换 + 全局：href 里带 & 和 sig，避免 $ 之类被 replace 当成替换模式；
  // 用 /g 是因为注释里也可能出现同一个占位符（踩过一次：只换第一处，href 反而没换）。
  .replace(/__MANIFEST_HREF__/g, () => manifestHref);
