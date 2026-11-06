// E1 注入器自测：直接连测试管道，发 {t:'cursor'}，看回复里有没有 cs/vis。
import net from 'node:net';

const pipe = process.argv[2] || '\\\\.\\pipe\\dsh-input-test1';
const s = net.connect(pipe);
let buf = '';
let got = 0;

s.on('connect', () => {
  s.write(JSON.stringify({ t: 'cursor' }) + '\n');
});
s.on('data', (b) => {
  buf += b.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    got++;
    let j = null;
    try { j = JSON.parse(line); } catch { }
    if (!j) { console.log('BAD JSON: ' + line); continue; }
    console.log('reply ' + got + ': cx=' + j.cx + ' cy=' + j.cy + ' cs=' + j.cs + ' vis=' + j.vis
      + ' blocked=' + j.blocked);
    if (typeof j.cs !== 'string' || !j.cs) { console.log('FAIL: cs 缺失'); process.exit(2); }
    if (typeof j.vis !== 'number') { console.log('FAIL: vis 缺失'); process.exit(2); }
  }
});
s.on('error', (e) => { console.log('FAIL connect: ' + e.code); process.exit(1); });
setTimeout(() => {
  s.write(JSON.stringify({ t: 'cursor' }) + '\n');
}, 300);
setTimeout(() => {
  console.log(got > 0 ? 'PASS (' + got + ' replies)' : 'FAIL: 没有收到回复');
  process.exit(got > 0 ? 0 : 1);
}, 1500);
