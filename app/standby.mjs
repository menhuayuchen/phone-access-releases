// standby.mjs —— 「电脑已开机，但还没人登录」时顶在 8660 上的待机页（2026-11-11）
//
// 背景：产品是**用户会话**应用（计划任务 -AtLogOn）。重启后没人登录 Windows 时，
// screen-server 根本不运行，手机打开地址只能看到 502/连不上 —— 分不清"关机了"还是"开着没人登录"。
//
// 做法：一个 SYSTEM 计划任务在开机时跑本脚本，抢占 8660 只服务一句人话。
// 用户登录后 screen-server 启动、会写一个 app-ready.json 标记；本脚本看到**比自身启动更新的**标记
// 就立刻释放端口退出，把 8660 交还给它。
//
// 约束（别踩）：
//   · 零依赖：只用 node 内置模块。由 %LOCALAPPDATA%\PhoneAccess\runtime\node.exe 直接跑，
//     不能 import 任何 node_modules（SYSTEM 上下文和用户目录权限都不该依赖）。
//   · 不读任何敏感信息、不提供任何写操作 —— 只有一张静态页。**故意不校验 ?k=**（进不来才需要这页）。
//   · EADDRINUSE 时不抢：说明真正的服务已经在跑，直接安静退出。
//   · 端口被占用的重试与交接由 screen-server 侧的 bindWithRetry 配合完成。
//
// 用法：
//   node standby.mjs --port 8660 --sentinel "C:\Users\xx\AppData\Local\PhoneAccess\app-ready.json"
//                    [--ts "C:\Program Files\Tailscale\tailscale.exe"] [--log "...\standby.log"]

import { createServer } from 'node:http';
import { existsSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

// ---- 参数 ----
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : def;
}
const PORT = Number(arg('port', '8660')) || 8660;
const SENTINEL = arg('sentinel', '');
const TS_EXE = arg('ts', 'C:\\Program Files\\Tailscale\\tailscale.exe');
const LOG = arg('log', '');

const START = Date.now();
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\r\n';
  try { process.stdout.write(line); } catch { }
  if (LOG) { try { appendFileSync(LOG, line); } catch { } }
}

// ---- 人话页面 ----
function noticeHtml() {
  const bootMs = Date.now() - Math.round(os.uptime() * 1000);
  const boot = new Date(bootMs);
  const pad = (n) => String(n).padStart(2, '0');
  const bootStr = boot.getFullYear() + '-' + pad(boot.getMonth() + 1) + '-' + pad(boot.getDate())
    + ' ' + pad(boot.getHours()) + ':' + pad(boot.getMinutes());
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0A0B0D">
<meta name="robots" content="noindex,nofollow">
<title>轻屏 · 电脑已开机，等待登录</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0A0B0D;color:#e8eaee;
    font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    padding:24px;-webkit-tap-highlight-color:transparent}
  .card{width:100%;max-width:460px;background:#12141a;border:1px solid #24272f;border-radius:16px;padding:26px 22px}
  .dot{width:9px;height:9px;border-radius:50%;background:#ffb454;display:inline-block;margin-right:8px;
    box-shadow:0 0 0 4px rgba(255,180,84,.14);vertical-align:middle}
  .kicker{color:#ffb454;font-size:12.5px;font-weight:700;letter-spacing:.06em}
  h1{font-size:20px;line-height:1.45;margin:12px 0 10px;font-weight:700}
  p{margin:10px 0;color:#aeb3bb;font-size:14px}
  b{color:#e8eaee}
  .meta{margin-top:16px;padding-top:14px;border-top:1px solid #22252c;color:#6b7078;font-size:12.5px}
  .hint{margin-top:14px;padding:11px 13px;background:#16181f;border:1px solid #262a33;border-radius:10px;
    color:#868c96;font-size:12.5px}
  code{background:#0f1014;border:1px solid #24272f;border-radius:6px;padding:1px 6px;font-size:12px;color:#c9ccd1}
</style></head><body>
<div class="card">
  <div class="kicker"><span class="dot"></span>轻屏 · 待机</div>
  <h1>电脑已经开机了，但还没人登录 Windows</h1>
  <p>这个页面由电脑在<b>开机时就启动</b>，所以你能看到它，说明机器是<b>开着、连着网</b>的 —— 不是关机。</p>
  <p>请在<b>电脑本身上</b>登录一次。登录后轻屏会自动接管这个地址，这一页会自己变成你的桌面。</p>
  <div class="meta">电脑启动时间：${bootStr}　·　本页每 5 秒自动刷新</div>
  <div class="hint">
    已经登录了还停在这一页？等 10~20 秒再刷新一次。<br>
    仍然不行：在电脑上双击「轻屏 → 重启」，或检查电脑是否连上网/登录了 Tailscale。
  </div>
</div>
<script>
  // 登录后这边的进程会退出、真正的服务接管同一端口；自动刷新能让手机不用手动重开。
  setTimeout(function () { location.reload(); }, 5000);
</script>
</body></html>`;
}

const HTML = noticeHtml();

// ---- 服务 ----
function onReq(req, res) {
  try {
    const path = String(req.url || '').split('?')[0];
    // ⚠ 健康检查类路径必须报 503：supervisor 的存活判据就是 /health，返回 200 会让它以为
    // 真正的画面服务还活着，于是登录后永远不去拉起真服务 —— 手机会卡在待机页出不来。
    // （2026-11-11 实测踩到：待机页占着 8660 且 /health 回 200，supervisor 判定"一切正常"。）
    if (path === '/health' || path === '/h264-status' || path === '/tailscale-status' || path === '/device-check') {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-lightscreen-standby': '1'
      });
      res.end(JSON.stringify({ ok: false, standby: true, port: PORT, note: '电脑已开机，但还没有人登录 Windows' }));
      return;
    }
    // 其它任何路径都给这张说明页（含 /manifest.json、/favicon.ico 等），避免手机端出现 JSON/404/破图。
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-lightscreen-standby': '1'
    });
    res.end(HTML);
  } catch { }
}

let closed = false;
const servers = [];
function shutdown(code, why) {
  if (closed) return;
  closed = true;
  log('退出（' + why + '）');
  for (const s of servers) { try { s.close(); } catch { } }
  setTimeout(() => { try { process.exit(code); } catch { } }, 120);
}

// 回环端口（tailscale serve 的代理目标就是它，所以这条一定要有）
const s1 = createServer(onReq);
servers.push(s1);
s1.on('error', (e) => {
  const code = e && e.code;
  if (code === 'EADDRINUSE') {
    // 真正的服务已经在跑（或另一个待机页在跑）—— 不抢，安静退出
    log('端口 ' + PORT + ' 已被占用，说明服务已在运行，本待机页退出');
    shutdown(0, 'port-in-use');
    return;
  }
  log('监听失败 ' + (code || (e && e.message)));
  shutdown(1, 'bind-error');
});
s1.listen(PORT, '127.0.0.1', () => log('待机页已监听 127.0.0.1:' + PORT));

// ⚠ 只绑回环，**故意不绑 tailnet 地址**（2026-11-11 实测踩到的死锁）：
//   start-screen.ps1 的启动条件是「$hosts 里还有地址没在监听」。如果待机页把 tailnet IP 也绑上，
//   那所有地址都"在听" → 它认为服务已经跑起来了 → 跳过启动；而待机页又要等真服务写 app-ready 才退出
//   → 两边互相等，登录后手机会永久卡在待机页上。
//   所以：待机页只占 127.0.0.1（tailscale serve 的代理目标就是它，HTTPS 入口照常可用），
//   tailnet 地址留空 —— 登录后 start-screen.ps1 一眼就能看出"还差地址没绑"，于是正常启动真服务。
//   代价：MagicDNS 抽风时的「数字 IP 直连」备用入口在未登录期间不可用（这时本来也进不了桌面）。
function tailscaleIp() {
  try {
    const out = execFileSync(TS_EXE, ['ip', '-4'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const ip = String(out || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /^100\.\d+\.\d+\.\d+$/.test(s));
    return ip || '';
  } catch { return ''; }
}
// 只做日志用，不监听
setTimeout(() => {
  try {
    const ip = tailscaleIp();
    if (ip) log('tailnet 地址 ' + ip + '（待机页故意不绑，留给真服务）');
  } catch { }
}, 3000).unref?.();

// ---- 交接：看到比自身启动更新的 app-ready 就退出 ----
function appReadyNow() {
  if (!SENTINEL) return false;
  try {
    if (!existsSync(SENTINEL)) return false;
    const st = statSync(SENTINEL);
    return st.mtimeMs > START;
  } catch { return false; }
}
setInterval(() => { if (appReadyNow()) shutdown(0, 'app-ready'); }, 500).unref?.();

// 启动时清一下自己的 pid 记录，方便排查
try {
  if (LOG) writeFileSync(LOG.replace(/\.log$/i, '') + '.pid', String(process.pid), 'utf8');
} catch { }

log('待机页启动 pid=' + process.pid + ' port=' + PORT + ' sentinel=' + (SENTINEL || '(未配置)'));
