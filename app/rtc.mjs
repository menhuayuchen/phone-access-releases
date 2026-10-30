// Minimal WebRTC sender: the browser offers (recvonly), we answer with a video track
// built from raw I420 frames and an audio track built from PCM chunks.
//
// Video frames arrive from capture.exe (mode=raw) via the named pipe; audio chunks come
// from audio.exe. libwebrtc inside @roamhq/wrtc does the VP8/H264 encoding, so the phone
// gets a normal <video> stream: hardware decode, tiny bandwidth, one connection for both.
import wrtcNs from '@roamhq/wrtc';
const { RTCPeerConnection, RTCSessionDescription } = wrtcNs;
const { RTCVideoSource, RTCAudioSource } = wrtcNs.nonstandard;
import { WebSocketServer } from 'ws';

const ICE = [
  // 改动：不再用外部 STUN。手机与电脑同处一个 tailnet，host 候选直连即可，ill work
];

// 改动（P0-3）：预置帧尺寸原来写死 1280×800。libwebrtc 在建轨时就锁帧尺寸，而 decode.mjs 产出多宽
// 取决于抓屏宽度（本机 2560×1600 → 1280×800，1920×1080 的机器 → 960×540）。两者不一致会黑屏/拉伸。
// 现在由 screen-server.mjs 按实际抓屏几何算好 prime 传进来；不传时退回 1280×800，行为与改动前一致。
const DEFAULT_PRIME = { width: 1280, height: 800 };

export function createRtc({ log = () => {}, rawStampFn = () => 0, prime = DEFAULT_PRIME } = {}) {
  const rawStamp = () => rawStampFn();
  const numW = Number(prime && prime.width), numH = Number(prime && prime.height);
  const pw = (Number.isFinite(numW) && numW >= 16) ? Math.round(numW) : DEFAULT_PRIME.width;
  const ph = (Number.isFinite(numH) && numH >= 16) ? Math.round(numH) : DEFAULT_PRIME.height;
  const videoSource = new RTCVideoSource();
    // prime the source with one black frame: libwebrtc fixes the frame size when a track is
    // created, and a 0x0 track never renders in the browser
    videoSource.onFrame({ width: pw, height: ph, data: Buffer.alloc(Math.floor(pw * ph * 3 / 2), 0x10) });   // 预置一帧把 track 尺寸定成 pw×ph
  const audioSource = new RTCAudioSource();

  let frames = 0, audioChunks = 0, lastFrame = 0, lastAudio = 0, lastPush = 0, skipped = 0;
  // 远端链路差的时候要把码率/帧率压下来（DERP 中继通常只有 1~3Mbps）。
  // 默认值给局域网用；页面按自己测到的 RTT 调 setQuality()。
  // 改动：帧率 15 -> 24。15fps 用来远程控制明显发飘（用户反馈不够顺），24 与清晰模式一致。
// 码率保持 3000 不变：24fps 下每帧分到的比特更少，但真实帧率上去了，体感更好。
let qKbps = 3000, qFps = 24;
  const senderPcs = new Set();
    let lastFeed = 0;
  const peers = new Set();

  function video(i420, w, h) {
      const now = Date.now();
      if (now - lastPush < 1000 / qFps) { skipped++; return; }   // 按当前画质设置限帧（setParameters 不一定生效，这条一定生效）
        lastFeed = now;
      lastPush = now;
    if (!i420 || !w || !h) return;
    try {
      videoSource.onFrame({ width: w, height: h, data: i420 });
      frames++;
      lastFrame = Date.now();
    } catch (e) { log('rtc video error: ' + e.message + ' w=' + w + ' h=' + h + ' len=' + (i420 ? i420.length : -1)); }
  }

  function audio(pcm) {
    if (!pcm || !pcm.length) return;
    try {
        // libwebrtc wants 10 ms frames (480 stereo frames @ 48 kHz); the pipe sends 20 ms.
        const total = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
        const per = 960;                       // 480 frames x 2 channels
        for (let off = 0; off < total.length; off += per) {
          const slice = total.subarray(off, Math.min(off + per, total.length));
          const copy = new Int16Array(slice.length);
          copy.set(slice);
          audioSource.onData({
            samples: copy,
            sampleRate: 48000,
            bitsPerSample: 16,
            channelCount: 2,
            numberOfFrames: copy.length / 2,
          });
          audioChunks++;
            lastAudio = Date.now();
        }
      } catch (e) { log('rtc audio error: ' + e.message); }
    }

  function attach(server, isAllowed) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x');
      // 改动（第二轮 P4-4）：这里**不能** socket.destroy()。本处理器先于 screen-server 的
      // /ws-audio 处理器注册，销毁 socket 会把后注册的处理器要接的连接也一起打断。
      // "不匹配路径要 destroy" 只能放在最后一个处理器里（见 screen-server.mjs 的 attachAudioWs）。
      if (url.pathname !== '/rtc') return;
      // 谓词可以返回三种值（2026-10-30 扩展，为了把"并发上限"讲清楚）：
      //   true      -> 放行
      //   false     -> 401 未授权
      //   '429 xxx' -> 原样写成状态行（免费版设备数已满）
      const verdict = isAllowed ? isAllowed(req, url) : true;
      if (typeof verdict === 'string') {
        try { socket.write('HTTP/1.1 ' + verdict + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { }
        socket.destroy();
        return;
      }
      if (verdict === false) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws, req) => {
      const who = (req && req.socket && (req.socket.remoteAddress || '')) + ':' + (req && req.socket ? req.socket.remotePort : '');
      log('rtc: viewer connected from ' + who);
      const pc = new RTCPeerConnection({ iceServers: ICE });
      peers.add(pc);
      // 每条连接都要新建 track：一个 MediaStreamTrack 只能挂在一个 RTCPeerConnection 上，
      // 复用上次的 track 会让新连接立刻 failed（表现就是 1.5 秒重连一次、画面一直闪）。
      let vTrack = null, aTrack = null;

      // libwebrtc 在 track 创建时就锁定帧尺寸，所以我们**始终**按同一个尺寸（创建时预置的 pw×ph，
      // 见上面的 prime 参数与 decode.mjs 的 width）喂帧，预置帧也是这个尺寸，因此可以直接建 track。
      // 以前这里要等 "最近 5 秒内有过帧"，服务端刚重启/刚切到流畅时来不及，观众就会
      // 永远只拿到音频（画面一直黑着），现在不存在这个竞态。
      vTrack = videoSource.createTrack();
      pc.addTrack(vTrack);
      log('rtc: video track added, senders=' + pc.getSenders().map((s) => s.track ? s.track.kind : 'null').join(','));
      aTrack = audioSource.createTrack();
      pc.addTrack(aTrack);
      log('rtc: audio track added, senders=' + pc.getSenders().map((s) => s.track ? s.track.kind : 'null').join(','));
      // keep the software VP8 encoder within budget
      try {
        senderPcs.add(pc);
        applyQuality();
      } catch (e) {}

      pc.onicecandidate = (e) => {
        if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
      };
      pc.onconnectionstatechange = () => {
        log('rtc: state ' + pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanup();
      };

      let closed = false;
      function cleanup() {
        if (closed) return;
        closed = true;
        peers.delete(pc);
        try { if (vTrack) vTrack.stop(); } catch {}
        try { if (aTrack) aTrack.stop(); } catch {}
        try { pc.close(); } catch {}
        try { ws.close(); } catch {}
        log('rtc: viewer closed ' + who + ' code=' + ws._closeCode + ' pc=' + (function(){ try { return pc.connectionState; } catch (e) { return '?'; } })());
      }

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        try {
          if (msg.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp }));
          } else if (msg.type === 'ice') {
            await pc.addIceCandidate(msg.candidate);
          } else if (msg.type === 'bye') {
            cleanup();
          }
        } catch (e) {
          log('rtc: ' + e.message);
        }
      });

      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
    return wss;
  }

  function applyQuality() {
    for (const pc of senderPcs) {
      try {
        const vs = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (!vs) continue;
        const p = vs.getParameters();
        if (p.encodings && p.encodings[0]) {
          p.encodings[0].maxBitrate = qKbps * 1000;
          p.encodings[0].maxFramerate = qFps;
        }
        p.degradationPreference = 'maintain-framerate';
        vs.setParameters(p)
          .then(() => log('rtc: quality -> ' + qKbps + 'kbps/' + qFps + 'fps'))
          .catch((e) => log('rtc: setParameters failed: ' + e.message));
      } catch (e) {}
    }
  }
  function setQuality(kbps, fps) {
    if (Number.isFinite(kbps) && kbps >= 300 && kbps <= 8000) qKbps = kbps;
    if (Number.isFinite(fps) && fps >= 5 && fps <= 30) qFps = fps;
    applyQuality();
    return { kbps: qKbps, fps: qFps };
  }

  function stats() {
    return {
      peers: peers.size,
      frames, audioChunks,
      frameAge: lastFrame ? (Date.now() - lastFrame) / 1000 : -1,
      audioAge: lastAudio ? (Date.now() - lastAudio) / 1000 : -1,
      qKbps, qFps,
    };
  }

  return { attach, video, audio, stats, setQuality };
}
