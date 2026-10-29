import net from 'node:net';
const s = net.connect('\\\\.\\pipe\\dsh-input');
s.on('connect', () => {
  console.log('connected');
  setTimeout(() => {
    s.write(JSON.stringify({ t: 'move', x: 300, y: 300 }) + '\n');
    console.log('wrote move');
  }, 800);
});
s.on('error', (e) => console.log('err', e.code));
s.on('close', () => console.log('closed'));
setTimeout(() => { console.log('done'); s.destroy(); process.exit(0); }, 5000);
