import fs from 'node:fs';

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

  function writeMsg(w, type, key, data) {
    const head = Buffer.alloc(10);
    head[0] = type;                       // 1=帧 2=init
    head.writeUInt32BE(data.length, 1);
    head[5] = key ? 1 : 0;
    head.writeUInt32BE(0, 6);
    try { w.write(Buffer.concat([head, data])).catch(() => { }); } catch { }
  }

  function sendInit(w) {
    let info = null;
    try { info = getInit(); } catch { }
    if (!info) return;
    const meta = JSON.stringify({ type: 'init', codec: info.codec, description: info.description, width: info.width, height: info.height });
    writeMsg(w, 2, 1, Buffer.from(meta, 'utf8'));
  }

  (async () => {
    const reader = server.sessionStream('/video').getReader();
    while (!closed) {
      const r = await reader.read().catch(() => ({ done: true }));
      if (r.done) break;
      const session = r.value;
      session.ready.then(async () => {
        try {
          const stream = await session.createUnidirectionalStream();
          const w = stream.getWriter();
          const s = { w };
          sessions.add(s);
          sendInit(w);
          session.closed.then(() => sessions.delete(s)).catch(() => sessions.delete(s));
        } catch (e) { }
      }).catch(() => { });
    }
  })();

  return {
    sessions,
    broadcast(frame) {
      if (!sessions.size || !frame || !frame.data || !frame.data.length) return;
      for (const s of sessions) writeMsg(s.w, 1, frame.key, frame.data);
    },
    stop() {
      closed = true;
      for (const s of sessions) { try { s.w.close(); } catch { } }
      sessions.clear();
      try { server.stopServer(); } catch { }
    }
  };
}
