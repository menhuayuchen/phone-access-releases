// 吞吐测试：只读管道、按帧切分，统计帧率/带宽，不接 WebRTC
import net from 'node:net';

const t0 = Date.now();
let frames = 0, bytes = 0, jpeg = 0, i420 = 0;
const chunks = [];
let buffered = 0, head = Buffer.alloc(0), frameLen = 0, pending = 0;

const sock = net.connect('\\\\.\\pipe\\dsh-screen-frames');
sock.on('connect', () => console.log('connected'));
sock.on('error', (e) => { console.log('error', e.code); process.exit(1); });
sock.on('close', () => { console.log('closed'); report(); process.exit(0); });

sock.on('data', (chunk) => {
  bytes += chunk.length;
  chunks.push(chunk);
  buffered += chunk.length;
  while (buffered >= 4) {
    if (head.length < 4) {
      while (head.length < 4 && chunks.length) {
        const need = 4 - head.length;
        const take = Math.min(need, chunks[0].length);
        head = Buffer.concat([head, chunks[0].subarray(0, take)]);
        if (take === chunks[0].length) chunks.shift(); else chunks[0] = chunks[0].subarray(take);
        buffered -= take;
      }
      if (head.length < 4) return;
      frameLen = head.readUInt32LE(0);
      head = Buffer.alloc(0);
      if (frameLen === 0) continue;
      if (frameLen < 8 || frameLen > 64 * 1024 * 1024) { console.log('desync', frameLen); process.exit(1); }
    }
    if (buffered < frameLen) return;
    const parts = [];
    let need = frameLen;
    while (need > 0) {
      const c0 = chunks[0];
      if (c0.length <= need) { parts.push(c0); chunks.shift(); need -= c0.length; buffered -= c0.length; }
      else { parts.push(c0.subarray(0, need)); chunks[0] = c0.subarray(need); buffered -= need; need = 0; }
    }
    const f = parts.length === 1 ? parts[0] : Buffer.concat(parts, frameLen);
    frames++;
    if (f[0] === 0) jpeg++; else if (f[0] === 1) i420++;
    frameLen = 0;
  }
});

function report() {
  const dt = (Date.now() - t0) / 1000;
  console.log(`frames=${frames} jpeg=${jpeg} i420=${i420} in ${dt.toFixed(1)}s = ${(frames / dt).toFixed(1)} fps, ${(bytes / dt / 1048576).toFixed(1)} MiB/s`);
}
setInterval(report, 5000);
setTimeout(() => { report(); process.exit(0); }, 20000);
