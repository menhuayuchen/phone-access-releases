// 2026-11-10 WebCodecs 自研接收端
//
// 目的：绕过浏览器接收端的 jitter buffer。它在零丢包、零抖动、速率完全匹配的情况下
// 仍会缓慢膨胀（实测 60fps 和 30fps 涨速一样，与帧率/分辨率/网络都无关），
// 而 jitterBufferTarget / playoutDelayHint 实测被 Chrome 完全无视，页面侧没有任何 API 能压住。
//
// 实测发现（2026-11-10）：Chrome 的 RTCRtpScriptTransform 在**接收端**给出的
// RTCEncodedVideoFrame.data 是**已经组装好的完整 H.264 编码帧（Annex-B，00 00 00 01 起始码）**，
// 不是 RTP 包 —— 所以不需要 FU-A 重组，直接按起始码切 NALU 就能喂 VideoDecoder。
//
// 数据流：
//   receiver.transform -> 本 Worker 收到完整帧（Annex-B）
//   -> 切 NALU，取 SPS(7)/PPS(8) 备用，找 IDR(5)
//   -> VideoDecoder（不设 description，按 Annex-B 输入）
//   -> VideoFrame 回传主线程 -> Canvas 绘制

/* eslint-disable no-restricted-globals */

// 诊断：Worker 一加载就回报
try { self.postMessage({ type: 'hello' }); } catch (e) { }

const S = {
  rtp: 0,          // 收到的编码帧数
  frames: 0,       // 送进解码器的帧数
  decoded: 0,      // 解码出的帧数
  dropped: 0,      // 丢弃（非关键帧且尚未拿到 IDR）
  keyframes: 0,
  lastPost: 0,
  lastErr: '',
};

let decoder = null;
let decoderReady = false;
let waitKey = true;
let sps = null, pps = null;
let tsUs = 0;              // 合成时间戳（微秒）：每帧按 1/fps 推进
let fpsHint = 60;          // 由主线程告知，默认 60

function post(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

// ---------- Annex-B 切 NALU ----------
// 输入是完整帧，可能含多个 NALU（SPS/PPS/IDR 或者单个 P 帧）
function splitAnnexB(u8) {
  const out = [];
  let i = 0;
  let start = -1;
  const len = u8.length;
  while (i + 2 < len) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (start >= 0) out.push(u8.subarray(start, i));
      start = i + 3;
      i += 3;
      continue;
    }
    if (i + 3 < len && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1) {
      if (start >= 0) out.push(u8.subarray(start, i));
      start = i + 4;
      i += 4;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < len) out.push(u8.subarray(start, len));
  return out;
}

// ---------- avcC（VideoDecoder 的 description）----------
function buildAvcC(spsArr, ppsArr) {
  const out = new Uint8Array(11 + spsArr.length + ppsArr.length);
  let i = 0;
  out[i++] = 1;
  out[i++] = spsArr[1];
  out[i++] = spsArr[2];
  out[i++] = spsArr[3];
  out[i++] = 0xff;
  out[i++] = 0xe1;
  out[i++] = (spsArr.length >> 8) & 0xff;
  out[i++] = spsArr.length & 0xff;
  out.set(spsArr, i); i += spsArr.length;
  out[i++] = 1;
  out[i++] = (ppsArr.length >> 8) & 0xff;
  out[i++] = ppsArr.length & 0xff;
  out.set(ppsArr, i);
  return out;
}

// Annex-B NALU 列表 -> AVCC（每段 4 字节大端长度前缀）
function toAvcc(nals) {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const buf = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    const L = n.length;
    buf[o++] = (L >>> 24) & 0xff;
    buf[o++] = (L >>> 16) & 0xff;
    buf[o++] = (L >>> 8) & 0xff;
    buf[o++] = L & 0xff;
    buf.set(n, o); o += L;
  }
  return buf;
}

// ---------- 解码器 ----------
// 2026-11-10：两阶段配置 —— 优先硬件解码，不支持再回退。
//
// hardwareAcceleration 的语义（WebCodecs 规范）：
//   'prefer-hardware' : 优先硬件；**不支持时 configure 会失败**（不会自动回退）
//   'no-preference'   : 交给浏览器决定（Chrome 通常也走硬件，但不保证）
// 所以不能只写 prefer-hardware 就完事，必须先探测再决定，否则在低端设备上会直接崩。
//
// iOS 注意：Safari 的 VideoDecoder 是 16.4+ 才有的，isConfigSupported 实现比较保守；
// 探测失败一律当作"不支持硬件"，绝不把异常抛到主线程。
var decoderIniting = false;
var decoderHw = '';

function buildConfig(hw) {
  const desc = buildAvcC(sps, pps);
  const cfg = {
    codec: 'avc1.4D0032',     // 与实际码流一致（日志 avc1.4D4032 / Main 3.2）
    description: desc,
    optimizeForLatency: true,
  };
  if (hw) cfg.hardwareAcceleration = hw;
  return cfg;
}

function probe(hw) {
  try {
    if (typeof VideoDecoder.isConfigSupported !== 'function') return Promise.resolve(false);
    return VideoDecoder.isConfigSupported(buildConfig(hw))
      .then(function (r) { return !!(r && r.supported); })
      .catch(function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}

function createDecoder(hw) {
  try { if (decoder) decoder.close(); } catch (e) { }
  decoder = new VideoDecoder({
    output: (frame) => {
      S.decoded++;
      post({ type: 'frame', frame, ts: frame.timestamp }, [frame]);
    },
    error: (e) => {
      S.lastErr = 'dec: ' + String((e && e.message) || e);
      post({ type: 'error', message: S.lastErr });
      try { decoder.close(); } catch (x) { }
      decoder = null;
      decoderReady = false;
      decoderIniting = false;
      waitKey = true;
    },
  });
  decoder.configure(buildConfig(hw));
  decoderHw = hw || 'default';
  decoderReady = true;
  decoderIniting = false;
  post({ type: 'ready', hw: decoderHw });
  return true;
}

function ensureDecoder() {
  if (decoder) return decoderReady;
  if (decoderIniting) return false;
  if (!sps || !pps) return false;
  decoderIniting = true;

  // 阶段1：探测硬件支持
  probe('prefer-hardware').then(function (hwOk) {
    if (hwOk) {
      try { createDecoder('prefer-hardware'); return; }
      catch (e) {
        S.lastErr = 'hw-configure: ' + String((e && e.message) || e);
        // 硬件配置失败 -> 落到阶段2
      }
    }
    // 阶段2：回退到浏览器自选
    try { createDecoder(''); }
    catch (e2) {
      S.lastErr = 'configure: ' + String((e2 && e2.message) || e2);
      post({ type: 'error', message: S.lastErr });
      decoderIniting = false;
      decoderReady = false;
    }
  }).catch(function () {
    try { createDecoder(''); } catch (e3) { decoderIniting = false; decoderReady = false; }
  });

  return false;   // 本帧先丢，等初始化完成
}

// ---------- 一帧 ----------
function onEncodedFrame(data, isKey) {
  S.rtp++;
  if (!data || data.byteLength === 0) return;
  const u8 = new Uint8Array(data);

  if (S.rtp <= 3) {
    post({ type: 'diag', msg: 'frame len=' + u8.length + ' first=' + u8[0] + ',' + u8[1] + ',' + u8[2] + ',' + u8[3] + ' key=' + (isKey ? 1 : 0) });
  }

  let nals;
  try { nals = splitAnnexB(u8); } catch (e) { nals = []; }
  if (!nals.length) { S.dropped++; return; }

  const kept = [];
  const types = [];
  for (const n of nals) {
    if (n.length < 1) continue;
    const t = n[0] & 0x1f;
    types.push(t + ':' + n.length);
    if (t === 7) { sps = n.slice(); continue; }
    if (t === 8) { pps = n.slice(); continue; }
    kept.push(n);
  }
  if (S.frames < 4) post({ type: 'diag', msg: 'nals=' + nals.length + ' [' + types.join(',') + '] kept=' + kept.length + ' sps=' + (sps ? sps.length : 0) + ' pps=' + (pps ? pps.length : 0) });
  if (!kept.length) { S.dropped++; return; }

  // 关键帧必须从 NALU 判断：实测 RTCEncodedVideoFrame.type 几乎总是 'delta'，
  // 信它会导致 IDR 被标成 delta，解码器一直等关键帧、一帧都不输出。
  const hasIdr = kept.some((n) => (n[0] & 0x1f) === 5);
  const isKeyFrame = isKey || hasIdr;
  if (isKeyFrame) S.keyframes++;

  if (waitKey) {
    if (!isKeyFrame) { S.dropped++; return; }
    waitKey = false;
  }
  if (!decoderReady && !ensureDecoder()) { S.dropped++; return; }

  // 输入用 AVCC（4 字节长度前缀），与 configure 里的 avcC description 配套
  const buf = toAvcc(kept);

  // 首帧时探测配置是否真的被支持（不支持的 codec 会静默卡住，不报错）
  if (S.frames === 1 && !self.__probed) {
    self.__probed = true;
    try {
      if (typeof VideoDecoder.isConfigSupported === 'function') {
        VideoDecoder.isConfigSupported({ codec: 'avc1.4D0032', optimizeForLatency: true })
          .then(function (r) { post({ type: 'diag', msg: 'isConfigSupported=' + (r && r.supported) }); })
          .catch(function (e) { post({ type: 'diag', msg: 'probe-err ' + String(e && e.message || e) }); });
      }
    } catch (e) { }
  }
  tsUs += Math.round(1e6 / Math.max(1, fpsHint));

  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKeyFrame ? 'key' : 'delta',
      timestamp: tsUs,
      data: buf,
    }));
    S.frames++;
  } catch (e) {
    S.dropped++;
    S.lastErr = 'decode: ' + String((e && e.message) || e);
    post({ type: 'error', message: S.lastErr });
  }
}

// ---------- 与主线程的桥 ----------
function handleRtpTransform(event) {
  try { self.postMessage({ type: 'tx-event' }); } catch (e) { }
  const transformer = event.transformer;
  if (!transformer || !transformer.readable || transformer.readable.locked) return;

  transformer.readable
    .pipeThrough(new TransformStream({
      transform: (frame, controller) => {
        try {
          onEncodedFrame(frame.data, frame.type === 'key');
        } catch (e) {
          S.lastErr = 'onFrame: ' + String((e && e.message) || e);
        }
        // 2026-11-10：必须继续往下传。实测不传会让浏览器判定"没收到数据"，
        // PeerConnection 直接被关掉（hasPc=false）。浏览器那份解码是浪费，
        // 但它维持着传输链路的活性；我们的画面走自己的 VideoDecoder + Canvas，
        // 不受它的 jitter buffer 影响。
        controller.enqueue(frame);
      },
    }))
    .pipeTo(transformer.writable)
    .catch(() => { });

  setInterval(() => {
    post({ type: 'stats', stats: Object.assign({}, S), ready: decoderReady, waitKey, err: S.lastErr });
  }, 2000);
}

self.addEventListener('rtctransform', handleRtpTransform);

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'fps') {
    fpsHint = Number(m.fps) || 60;
  } else if (m.type === 'reset') {
    waitKey = true;
    tsUs = 0;
    sps = null; pps = null;
    try { if (decoder) decoder.close(); } catch (x) { }
    decoder = null; decoderReady = false;
  } else if (m.type === 'ping') {
    post({ type: 'stats', stats: Object.assign({}, S), ready: decoderReady, waitKey, err: S.lastErr });
  }
};
