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
//   -> VideoDecoder（给 avcC description + AVCC 输入；参数集一变就重建解码器）
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
  // 2026-11-10 诊断：解码器被重建的次数 / SPS 变化的次数 / 当前解码队列积压
  cfg: 0,
  spsChanges: 0,
  queue: 0,
  resyncs: 0,   // 因解码队列堆积而主动重建的次数（页面据此判断"这台设备吃不下当前码率"）
  // 2026-11-10 诊断：收到的 RTCEncodedVideoFrame.timestamp 间隔（单位是 **90kHz 刻度**，不是微秒）。
  // 90fps 正常约 1000 刻度/帧。这里只做观测，**不拿它判丢帧**（见下面 noteInTs 的说明）。
  tsDelta: 0,
  tsMin: 0,
  tsMax: 0,
  tsEma: 0,
  tsN: 0,
};

// RTCEncodedVideoFrame.timestamp 实测是 90kHz 刻度，而且时间戳是侧车**按帧到达时刻**打的，
// 所以相邻帧的差值反映的是 Node→侧车的投递抖动，不是编码器的出帧节奏：
// 本机实测 delta 在 1~9576 刻度之间乱跳（正常帧间隔约 1000）。
// 于是"delta 变大就等于丢了帧"这个判据完全不成立 —— 试过一版，10 秒里误判 86 次、
// 白丢 520 帧（每次误判要等下一个 IDR 才恢复）。**不要再用它判断丢帧。**
// 真正可靠的丢帧信号只有两个：
//   ① 浏览器的 getStats().packetsLost（网络丢包，主线程 postMessage 'gap' 过来）；
//   ② 侧车自己丢帧时置 needKey（在 Go 里做，见 docs 交接文档）。
let inTsLast = 0, inTsInit = false, inTsEma = 0;
function noteInTs(ts) {
  if (typeof ts !== 'number' || !(ts > 0)) return;
  if (!inTsInit) { inTsInit = true; inTsLast = ts; return; }
  const d = ts - inTsLast;
  inTsLast = ts;
  if (d <= 0) { inTsEma = 0; return; }   // 编码器重启 / 时间戳回退
  S.tsDelta = d;
  S.tsN++;
  if (!S.tsMin || d < S.tsMin) S.tsMin = d;
  if (d > S.tsMax) S.tsMax = d;
  inTsEma = inTsEma === 0 ? d : (inTsEma * 0.9 + d * 0.1);
  S.tsEma = Math.round(inTsEma);
}

let decoder = null;
let decoderReady = false;
let waitKey = true;
let sps = null, pps = null;
// 2026-11-10：当前解码器是用哪一组 SPS/PPS 配置的。编码器重启（切分辨率/切窗口/崩溃重启）
// 会带来新的 SPS，而送进解码器的数据里 SPS/PPS 是被剥掉的（走 description/avcC 路线），
// 所以解码器不会自己发现参数变了 —— 必须在这里比对并重建，否则画面会冻住或花屏。
let cfgSps = null, cfgPps = null;
let pendingKey = null;     // 解码器还在 configure 时先存下的关键帧，配置好立刻喂进去
let tsUs = 0;              // 合成时间戳（微秒）：每帧按 1/fps 推进
let fpsHint = 60;          // 由主线程告知，默认 60

function bytesEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

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
  const prev = decoder;
  decoderReady = false;
  try { if (prev) prev.close(); } catch (e) { }
  const self = new VideoDecoder({
    output: (frame) => {
      S.decoded++;
      post({ type: 'frame', frame, ts: frame.timestamp }, [frame]);
    },
    error: (e) => {
      S.lastErr = 'dec: ' + String((e && e.message) || e);
      post({ type: 'error', message: S.lastErr });
      // 只拆自己这一只：旧解码器迟到的 error 不能把新解码器一起废掉
      try { self.close(); } catch (x) { }
      if (decoder === self) {
        decoder = null;
        decoderReady = false;
        decoderIniting = false;
        waitKey = true;
        pendingKey = null;
      }
    },
  });
  decoder = self;
  decoder.configure(buildConfig(hw));
  // 记住"这只解码器是按哪组参数集配的"，onEncodedFrame 里靠它发现编码器换参数了
  cfgSps = sps ? sps.slice() : null;
  cfgPps = pps ? pps.slice() : null;
  decoderHw = hw || 'default';
  decoderReady = true;
  decoderIniting = false;
  S.cfg++;
  post({ type: 'ready', hw: decoderHw, cfg: S.cfg });
  // configure 期间攒下的那个关键帧：现在解码器能用了，立刻喂进去（否则每次连上都要黑 0.5 秒等下一个 IDR）
  if (pendingKey) {
    const p = pendingKey;
    pendingKey = null;
    try { submitFrame(p, true); } catch (e) { S.lastErr = 'pending: ' + String((e && e.message) || e); }
  }
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

// 真正把一帧交给解码器。抽出来是为了两条路共用：正常路径和"configure 期间攒下的关键帧"。
function submitFrame(buf, isKeyFrame) {
  if (!decoder || !decoderReady) throw new Error('decoder-not-ready');
  tsUs += Math.round(1e6 / Math.max(1, fpsHint));
  decoder.decode(new EncodedVideoChunk({
    type: isKeyFrame ? 'key' : 'delta',
    timestamp: tsUs,
    data: buf,
  }));
  S.frames++;
  // 提交成功才允许喂 P 帧：原来是一拿到 IDR 就清 waitKey，可那时解码器可能还在 configure，
  // 这一帧被丢掉之后紧接着喂 P 帧 → "A key frame is required after configure()"，
  // 每次连上前 0.5 秒必黑、还白丢 40 多帧。
  waitKey = false;
  try { S.queue = decoder.decodeQueueSize | 0; } catch (e) { S.queue = 0; }
}

// ---------- 一帧 ----------
function onEncodedFrame(data, isKey, inTs) {
  S.rtp++;
  noteInTs(inTs);   // 只做观测，不参与丢帧判断（原因见 noteInTs 上方注释）
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

  // 参数集变了 = 编码器重启了（切分辨率、切窗口、崩溃重启）。
  // 现有解码器是按旧 avcC 配的，而我们在喂数据前把 SPS/PPS 剥掉了，解码器自己永远发现不了 ——
  // 继续喂的结果就是画面冻住（桌面硬解）或整屏花屏（手机硬解），而且计数器看着完全正常。
  // 这里必须重建解码器，等下一个关键帧重新 configure。
  if ((sps && !bytesEq(cfgSps, sps)) || (pps && !bytesEq(cfgPps, pps))) {
    if (decoder || cfgSps) {
      S.spsChanges++;
      post({ type: 'reconfig', spsChanges: S.spsChanges, cfg: S.cfg });
      try { if (decoder) decoder.close(); } catch (e0) { }
      decoder = null;
      decoderReady = false;
      decoderIniting = false;
      waitKey = true;
      pendingKey = null;
    }
  }

  // 输入用 AVCC（4 字节长度前缀），与 configure 里的 avcC description 配套
  const buf = toAvcc(kept);

  // 解码器不在就建；关键帧先攒着，configure 完立刻喂（createDecoder 里会取走 pendingKey）
  if (!decoderReady) {
    if (!ensureDecoder()) {
      if (isKeyFrame) pendingKey = buf;
      S.dropped++;
      return;
    }
  }
  if (waitKey) {
    if (!isKeyFrame) { S.dropped++; return; }
  }

  // 2026-11-10：解码队列保护（手机端实测踩过）。
  // 解码器跟不上输入时 decodeQueueSize 会**无上限**增长：实测手机端攒到 1481 帧 ≈ 25 秒，
  // 表现就是"画面越来越卡、HUD 显示静止"，而 rtp/丢包/PLI 全都正常 —— 光看那些指标发现不了。
  // 这里到 30 帧（≈0.5 秒 @60fps）就主动重建解码器并等到下一个关键帧：
  // 队列立刻清空、画面追上实时，代价是最多冻半个 GOP。页面那边会据此自动降帧率（见 rtc264Stats）。
  {
    let q = 0;
    try { q = (decoder && decoder.decodeQueueSize) || 0; } catch (e) { q = 0; }
    S.queue = q | 0;
    if (q > 30) {
      S.resyncs = (S.resyncs || 0) + 1;
      post({ type: 'resync', queue: q, resyncs: S.resyncs });
      try { if (decoder) decoder.close(); } catch (e9) { }
      decoder = null;
      decoderReady = false;
      decoderIniting = false;
      waitKey = true;
      pendingKey = null;
      S.dropped++;
      return;
    }
  }

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

  try {
    submitFrame(buf, isKeyFrame);
  } catch (e) {
    S.dropped++;
    S.lastErr = 'decode: ' + String((e && e.message) || e);
    post({ type: 'error', message: S.lastErr });
    // 提交失败说明解码器状态已经坏了：拆掉，下一帧按当前 SPS 重建
    try { if (decoder) decoder.close(); } catch (e2) { }
    decoder = null;
    decoderReady = false;
    decoderIniting = false;
    waitKey = true;
    pendingKey = null;
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
          onEncodedFrame(frame.data, frame.type === 'key', frame.timestamp);
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
    try { S.queue = decoder ? (decoder.decodeQueueSize | 0) : 0; } catch (e) { S.queue = 0; }
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
    cfgSps = null; cfgPps = null;
    pendingKey = null;
    try { if (decoder) decoder.close(); } catch (x) { }
    decoder = null; decoderReady = false; decoderIniting = false;
  } else if (m.type === 'gap') {
    // 2026-11-10：主线程从 getStats 看到丢包，说明参考帧链断了。
    // 继续解 P 帧只会得到一整片花屏，改成等下一个 IDR（GOP 0.5 秒，画面最多停半秒）。
    S.gaps = (S.gaps || 0) + 1;
    waitKey = true;
  } else if (m.type === 'ping') {
    post({ type: 'stats', stats: Object.assign({}, S), ready: decoderReady, waitKey, err: S.lastErr });
  }
};
