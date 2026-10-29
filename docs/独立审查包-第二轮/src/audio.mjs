// audio.mjs - client for audio.exe (system loopback PCM over a Windows named pipe)
//
// Usage:
//   import { startAudio, stopAudio } from './audio.mjs';
//   startAudio({
//     pipeName: 'dsh-audio',
//     onChunk: (pcm) => { /* Buffer: 48000 Hz, 16-bit LE, stereo */ },
//     log: (msg) => {},
//   });
//
// Protocol (written by audio.exe):
//   [uint32 little-endian length][PCM payload] ...
//   chunk length is 3840 bytes = 20 ms of 48 kHz / 16-bit / 2ch PCM.
//
// Behavior:
//   - connects to \\.\pipe\<pipeName>
//   - parses length-prefixed chunks, drops lengths < 20 or > 65536
//   - reconnects automatically every 1 second after disconnect
//   - stopAudio() tears down the socket and any pending reconnect timer
//
// No third-party dependencies.

import net from 'node:net';

const RECONNECT_MS = 1000;
const MIN_CHUNK = 20;
const MAX_CHUNK = 65536;

let state = null;

function defaultLog() {}

/**
 * Start reading the audio pipe. Calling it again replaces the previous stream.
 * @param {object} options
 * @param {string} [options.pipeName='dsh-audio']
 * @param {(pcm: Buffer) => void} [options.onChunk]
 * @param {(msg: string) => void} [options.log]
 * @returns {{ stop: () => void }}
 */
export function startAudio(options = {}) {
  const pipeName = options.pipeName || 'dsh-audio';
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : () => {};
  const log = typeof options.log === 'function' ? options.log : defaultLog;

  stopAudio();

  const st = {
    pipeName,
    onChunk,
    log,
    stopped: false,
    socket: null,
    retryTimer: null,
    buffer: Buffer.alloc(0),
    connected: false,
    chunks: 0,
    bytes: 0,
    invalid: 0,
  };
  state = st;
  log(`[audio] starting pipe client for \\\\.\\pipe\\${pipeName}`);
  connect(st);
  return { stop: stopAudio };
}

/** Stop the pipe client. Safe to call when nothing is running. */
export function stopAudio() {
  const st = state;
  state = null;
  if (!st) return;
  st.stopped = true;
  if (st.retryTimer) {
    clearTimeout(st.retryTimer);
    st.retryTimer = null;
  }
  if (st.socket) {
    const socket = st.socket;
    st.socket = null;
    try { socket.destroy(); } catch { /* ignore */ }
  }
  st.log('[audio] stopped');
}

function connect(st) {
  if (st.stopped) return;

  const pipePath = `\\\\.\\pipe\\${st.pipeName}`;
  const socket = net.connect(pipePath);
  st.socket = socket;
  let settled = false;

  const down = (reason) => {
    if (settled) return;
    settled = true;
    st.connected = false;
    if (st.socket === socket) st.socket = null;
    try { socket.destroy(); } catch { /* ignore */ }
    if (st.stopped) return;
    st.log(`[audio] disconnected (${reason}); reconnect in ${RECONNECT_MS} ms`);
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null;
      connect(st);
    }, RECONNECT_MS);
  };

  socket.setNoDelay(true);
  socket.on('connect', () => {
    st.connected = true;
    st.buffer = Buffer.alloc(0);
    st.log(`[audio] connected ${pipePath}`);
  });
  socket.on('data', (data) => {
    try {
      feed(st, data);
    } catch (err) {
      st.log(`[audio] parse error: ${err && err.message ? err.message : err}`);
      st.buffer = Buffer.alloc(0);
    }
  });
  socket.on('error', (err) => down(err && err.code ? err.code : String(err)));
  socket.on('close', () => down('close'));
}

function feed(st, data) {
  st.buffer = st.buffer.length === 0 ? data : Buffer.concat([st.buffer, data]);

  while (true) {
    if (st.buffer.length < 4) break;
    const length = st.buffer.readUInt32LE(0);

    if (length < MIN_CHUNK || length > MAX_CHUNK) {
      st.invalid++;
      st.log(`[audio] invalid chunk length ${length}; dropping ${st.buffer.length} buffered bytes`);
      st.buffer = Buffer.alloc(0);
      break;
    }

    if (st.buffer.length < 4 + length) break;

    const payload = st.buffer.subarray(4, 4 + length);
    st.buffer = st.buffer.subarray(4 + length);
    st.chunks++;
    st.bytes += length;

    // Copy so downstream code can retain the buffer safely.
    const pcm = Buffer.from(payload);
    try {
      st.onChunk(pcm);
    } catch (err) {
      st.log(`[audio] onChunk error: ${err && err.message ? err.message : err}`);
    }
  }

  if (st.buffer.length === 0) st.buffer = Buffer.alloc(0);
}
