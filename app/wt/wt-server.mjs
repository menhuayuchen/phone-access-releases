import fs from 'node:fs';

const CHUNK = 1100;

export async function startWt({ port = 8444, certPath, keyPath, getInit }) {
  const mod = await import(new URL('./node_modules/@fails-components/webtransport/lib/index.node.js', import.meta.url));
  const Http3Server = mod.Http3Server;
  const server = new Http3Server({
    port,
    host: '0.0.0.0',
    secret: 'pa-wt-video-secret-0123456789012345',
    cert: fs.readFileSync(certPath),
    privKey: fs.readFileSync(keyPath)
  });
  await server.startServer();
  const sessions = new Set();
  let closed = false;

  function sendInit(writer) {
    let info = null;
    try { info = getInit(); } catch { }
    if (!info) return;
    const meta = JSON.stringify({ type: 'init', codec: info.codec, description: info.description, width: info.width, height: info.height });
    const b = Buffer.from(meta, 'utf8');
    for (let i = 0; i < b.length; i += 1000) {
      const part = b.subarray(i, i + 1000);
      const head = Buffer.alloc(4);
      head.writeUInt16BE(0xFFFF, 0);
      head.writeUInt16BE(i, 2);
      try { writer.write(Buffer.concat([head, part])).catch(() => { }); } catch { }
    }
  }

  (async () => {
    const reader = server.sessionStream('/video').getReader();
    while (!closed) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      const session = value;
      session.ready.then(() => {
        const writer = session.datagrams.writable.getWriter();
        const s = { writer };
        sessions.add(s);
        sendInit(writer);
        session.closed.then(() => sessions.delete(s)).catch(() => sessions.delete(s));
      }).catch(() => { });
    }
  })();

  return {
    sessions,
    broadcast(frame) {
      if (!sessions.size || !frame || !frame.data || !frame.data.length) return;
      const id = frame.id >>> 0;
      const total = Math.ceil(frame.data.length / CHUNK);
      for (let i = 0; i < total; i++) {
        const part = frame.data.subarray(i * CHUNK, (i + 1) * CHUNK);
        const head = Buffer.alloc(14);
        head.writeUInt32BE(id, 0);
        head.writeUInt16BE(i, 4);
        head.writeUInt16BE(total, 6);
        head[8] = frame.key ? 1 : 0;
        head.writeUInt32BE(frame.data.length, 9);
        head[13] = 0;
        const msg = Buffer.concat([head, part]);
        for (const s of sessions) {
          try { s.writer.write(msg).catch(() => { }); } catch { }
        }
      }
    },
    stop() {
      closed = true;
      for (const s of sessions) { try { s.writer.close(); } catch { } }
      sessions.clear();
      try { server.stopServer(); } catch { }
    }
  };
}
