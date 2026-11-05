// 把产品 /ws-h264 的实时帧转发给 rtc-h264 侧车的 TCP 帧输入（本地联调用）。
// 用法：node feed-live.cjs <key> [产品端口=8660] [帧输入端口=9900]
// 说明：产品自己也会喂侧车；这个脚本只用于脱离产品、单独测侧车（或对比两条链路）。
// 用 Node 24 内置的 WebSocket，不依赖 ws 包，源码目录直接能跑。
const http = require('http');
const net = require('net');

function getJson(port, path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function annexb(a) {
  const o = []; let p = 0;
  while (p + 4 <= a.length) {
    const n = a.readUInt32BE(p); p += 4;
    if (n <= 0 || p + n > a.length) break;
    o.push(Buffer.from([0, 0, 0, 1])); o.push(a.subarray(p, p + n)); p += n;
  }
  return Buffer.concat(o);
}
function avcc(b64) {
  const b = Buffer.from(b64, 'base64');
  const ns = b[5] & 0x1f; let p = 6; const out = [];
  for (let i = 0; i < ns; i++) { const l = b.readUInt16BE(p); p += 2; out.push(Buffer.from([0, 0, 0, 1])); out.push(b.subarray(p, p + l)); p += l; }
  const np = b[p]; p += 1;
  for (let i = 0; i < np; i++) { const l = b.readUInt16BE(p); p += 2; out.push(Buffer.from([0, 0, 0, 1])); out.push(b.subarray(p, p + l)); p += l; }
  return Buffer.concat(out);
}

(async () => {
  const key = process.argv[2] || '';
  const productPort = Number(process.argv[3] || 8660);
  const feedPort = Number(process.argv[4] || 9900);
  const sock = net.connect({ host: '127.0.0.1', port: feedPort }, () => console.log('feed tcp → ' + feedPort));
  sock.on('error', (e) => { console.error('feed tcp error: ' + e.message); process.exit(1); });

  // 先连 WS：连上会触发产品启动编码器，avcC（SPS/PPS）在 h264-init 文本消息里下发。
  let pre = null;
  const ws = new WebSocket('ws://127.0.0.1:' + productPort + '/ws-h264?k=' + encodeURIComponent(key));
  ws.binaryType = 'arraybuffer';
  let frames = 0, bytes = 0, keys = 0, skipped = 0;
  ws.onopen = () => console.log('ws /ws-h264 connected');
  ws.onerror = () => console.error('ws error');
  ws.onclose = () => console.log('ws closed');
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m && m.type === 'h264-init' && m.description) {
          pre = avcc(m.description);
          console.log('init ' + m.codec + ' ' + m.width + 'x' + m.height);
        }
      } catch (e) { }
      return;
    }
    const b = Buffer.from(ev.data);
    if (b.length < 10) return;
    const isKey = b[4] === 1;
    const len = b.readUInt32BE(5);
    if (len <= 0 || b.length < 9 + len) return;
    if (!pre) { skipped++; return; }                     // 还没拿到 SPS/PPS，关键帧也没法拼
    let pl = annexb(b.subarray(9, 9 + len));
    if (isKey) pl = Buffer.concat([pre, pl]);
    const h = Buffer.alloc(5);
    h.writeUInt32BE(pl.length, 0);
    h[4] = isKey ? 1 : 0;
    try { sock.write(Buffer.concat([h, pl])); } catch (e) { }
    frames++; bytes += pl.length; if (isKey) keys++;
  };
  setInterval(() => {
    console.log('frames=' + frames + ' keys=' + keys + ' MB=' + (bytes / 1048576).toFixed(1) + ' skipped=' + skipped);
  }, 3000);
})();
