// Writes remote-input commands into the dsh-input named pipe, where input.exe injects them.
import net from 'node:net';

export function createInput({ pipeName = '\\\\.\\pipe\\dsh-input', log = () => {} } = {}) {
  let sock = null;
  let connecting = false;
  let sent = 0;
  let errors = 0;
  let lastError = '';
  let cursorPos = { x: -1, y: -1, s: 'arrow', v: 1 };
  let cursorAt = 0;                // 最后一次拿到光标回报的时间（实验版 /ws-exp 用它判断数据是否新鲜）
  let blocked = 0;                 // injector 报告的"注入被 UIPI 挡掉"次数
  let foreground = '';             // 挡在前面的那个前台窗口标题
  let blockedAt = 0;               // 最后一次拿到 blocked 的时间戳
  let blockedAge = -1;             // injector 报的「距最近一次被挡多少毫秒」（-1 = 从没被挡）
  let rx = '';
  const queue = [];

  function connect() {
    if (sock || connecting) return;
    connecting = true;
    const s = net.connect(pipeName);
    s.on('connect', () => {
      connecting = false;
      sock = s;
      log('input: injector connected');
      s.on('data', (buf) => {
        rx += buf.toString('utf8');
        let nl;
        while ((nl = rx.indexOf('\n')) >= 0) {
          const line = rx.slice(0, nl).trim();
          rx = rx.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const j = JSON.parse(line);
            if (typeof j.cx === 'number') {
              cursorPos = {
                x: j.cx, y: j.cy,
                s: (typeof j.cs === 'string' && j.cs) ? j.cs : 'arrow',
      cw: (typeof j.cw === 'number' && j.cw > 0) ? j.cw : 0,
      ch: (typeof j.ch === 'number' && j.ch > 0) ? j.ch : 0,
      chx: (typeof j.chx === 'number') ? j.chx : 0,
      chy: (typeof j.chy === 'number') ? j.chy : 0,
      img: (typeof j.img === 'string') ? j.img : '',
                v: (j.vis === 0 ? 0 : 1),
              };
              cursorAt = Date.now();
            }
            if (typeof j.blocked === 'number') { blocked = j.blocked; blockedAt = Date.now(); }
            if (typeof j.blkage === 'number') blockedAge = j.blkage;
            if (typeof j.fg === 'string') foreground = j.fg;
          } catch (e) {}
        }
      });
      while (queue.length) s.write(queue.shift());
    });
    s.on('error', (e) => {
      connecting = false;
      errors++;
      lastError = e.code || e.message;
      try { s.destroy(); } catch {}
    });
    s.on('close', () => {
      if (sock === s) sock = null;
      connecting = false;
    });
  }

  connect();
  setInterval(connect, 3000).unref?.();

  function send(obj) {
    const line = JSON.stringify(obj) + '\n';
    sent++;
    if (sock) sock.write(line);
    else {
      if (queue.length > 200) queue.shift();   // never let a dead injector grow memory
      queue.push(line);
      connect();
    }
  }

  // 询问 injector 当前真实光标（它会把 {cx,cy,cs,vis} 写回管道）
  // 2026-11-07 实验版 E1：400ms → 33ms（30Hz）。手机端要拿它画实时光标，
  // 400ms 会让光标看起来"一格一格跳"。命名管道是本机往返，30Hz 没有压力。
  function pollCursor() {
    if (sock) { try { sock.write(JSON.stringify({ t: 'cursor', want: wantImg ? 1 : 0 }) + '\n'); wantImg = false; } catch (e) {} }
  }
  let wantImg = false;
function requestCursorImage() { wantImg = true; }
setInterval(pollCursor, 33).unref?.();

  function cursor() { return { x: cursorPos.x, y: cursorPos.y, s: cursorPos.s, v: cursorPos.v, img: cursorPos.img || '', cw: cursorPos.cw || 0, ch: cursorPos.ch || 0, chx: cursorPos.chx || 0, chy: cursorPos.chy || 0, at: cursorAt }; }

  // 注入是否被系统挡住（前台高权限窗口 UIPI）。injector 每收到 cursor 询问就顺便回一次状态。
  function status() {
    return { blocked, foreground, ageMs: blockedAge };
  }

  // 让 injector 主动抢回前台（page 上的"抢回前台"按钮 / 服务端自动自愈都走这里）
  function unblock() {
    if (sock) { try { sock.write(JSON.stringify({ t: 'unblock' }) + '\n'); } catch (e) {} }
  }

  function stats() {
    return { connected: !!sock, sent, errors, lastError, queued: queue.length, blocked, foreground };
  }

  return { send, stats, cursor, status, unblock, requestCursorImage };
}