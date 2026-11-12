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
  codec: 'h264',   // 2026-11-12：本次会话解码用的 codec（'h264' | 'hevc'）
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
  // 2026-11-11：**画面间断感**的量化。用户反馈"120 帧也看得出一点间断，240 帧就好些"，
  // 这不是吞吐问题，是帧**到达节奏**不匀（成簇到达）。这里按窗口统计相邻帧到达间隔：
  // arrAvg/arrP90/arrMax 单位 ms，arrOver=间隔超过 1.5 倍期望的次数（会看到"顿一下"），
  // arrUnder=间隔不到 0.5 倍的次数（成簇，紧接着就会空一个 vsync）。每窗口算完清零。
  arrN: 0,
  arrAvg: 0,
  arrP50: 0,
  arrP90: 0,
  arrMax: 0,
  arrOver: 0,
  arrUnder: 0,
};

// 到达节奏采样窗口（每次 stats 上报后清空，约 1 秒）
let _arrPrev = 0;
let _arrBuf = [];
function noteArrival() {
  const now = performance.now();
  if (_arrPrev > 0) {
    const d = now - _arrPrev;
    if (d >= 0 && d < 2000) {
      _arrBuf.push(d);
      if (_arrBuf.length > 600) _arrBuf.shift();
    }
  }
  _arrPrev = now;
}
function cadenceSnapshot() {
  const arr = _arrBuf;
  if (arr.length < 2) { S.arrN = arr.length; S.arrAvg = 0; S.arrP50 = 0; S.arrP90 = 0; S.arrMax = 0; S.arrOver = 0; S.arrUnder = 0; return; }
  const sorted = arr.slice().sort(function (a, b) { return a - b; });
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const avg = sum / n;
  const exp = 1000 / Math.max(1, fpsHint);
  let over = 0, under = 0;
  for (let i = 0; i < n; i++) { if (arr[i] > exp * 1.5) over++; else if (arr[i] < exp * 0.5) under++; }
  S.arrN = n;
  S.arrAvg = Math.round(avg * 10) / 10;
  S.arrP50 = Math.round(sorted[Math.floor(n * 0.5)] * 10) / 10;
  S.arrP90 = Math.round(sorted[Math.floor(n * 0.9)] * 10) / 10;
  S.arrMax = Math.round(sorted[n - 1] * 10) / 10;
  S.arrOver = over;
  S.arrUnder = under;
  _arrBuf = [];   // 下个窗口重新采样
}

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
// 2026-11-12 HEVC P1：H.265 的 VPS(32) 与 codec 串；codecHint 由主线程通过 postMessage 告知
// （页面按服务端 /rtc264/offer 返回的 codec 决定），收到 H265 编码帧时按 2 字节 NAL 头切。
let vps = null;
let codecHint = 'h264';
let hevcCodecStr = '';
// 2026-11-10：当前解码器是用哪一组 SPS/PPS 配置的。编码器重启（切分辨率/切窗口/崩溃重启）
// 会带来新的 SPS，而送进解码器的数据里 SPS/PPS 是被剥掉的（走 description/avcC 路线），
// 所以解码器不会自己发现参数变了 —— 必须在这里比对并重建，否则画面会冻住或花屏。
let cfgSps = null, cfgPps = null;
let cfgVps = null;          // HEVC：配置时用的 VPS（参数集变化检测）
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

// ---------- HEVC（H.265）2026-11-12 P1 ----------
// VideoDecoder 解 hvc1 需要 HEVCDecoderConfigurationRecord（hvcC）当 description；
// 我们收到的帧里带着参数集（服务端每个关键帧前都会拼 VPS/SPS/PPS），足够现场组出 hvcC。
// 只支持 Main 8bit 4:2:0（服务端 -profile:v main），其它 profile 直接报错让页面回落 H.264。
function hevcRev32(v) {
  let r = 0;
  for (let i = 0; i < 32; i++) { r = (r << 1) | ((v >>> i) & 1); }
  return r >>> 0;
}
function stripEmu(u8) {
  const out = new Uint8Array(u8.length + 2);
  let o = 0, i = 0;
  while (i < u8.length) {
    if (i + 2 < u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 3) {
      out[o++] = 0; out[o++] = 0; i += 3;
    } else {
      out[o++] = u8[i++];
    }
  }
  return out.subarray(0, o);
}
// sps 含 2 字节 NAL 头。RBSP[0] = vps_id(4)/max_sub_layers_minus1(3)/tid_nesting(1)，
// 紧跟着 profile_tier_level 固定 12 字节（96 bit），直接按下标取比写 bit reader 稳。
function hevcSpsInfo(spsBuf) {
  const rbsp = stripEmu(spsBuf.subarray(2));
  if (rbsp.length < 13) return null;
  const maxSubLayers = (rbsp[0] >> 1) & 7;
  const ptl = rbsp.subarray(1, 13);
  return {
    maxSubLayers,
    profileSpace: (ptl[0] >> 6) & 3,
    tier: (ptl[0] >> 5) & 1,
    profileIdc: ptl[0] & 0x1f,
    compat: ((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0,
    // 6 字节：高 4 bit 是 progressive/interlaced/non_packed/frame_only，其余是 44 bit 约束位
    constraint: ptl.subarray(5, 11),
    level: ptl[11],
  };
}
function buildHvcC() {
  if (!vps || !sps || !pps) return null;
  const si = hevcSpsInfo(sps);
  if (!si) return null;
  if (si.profileIdc !== 1) {
    S.lastErr = 'hevc-profile-unsupported:' + si.profileIdc;
    return null;
  }
  const arrs = [vps, sps, pps];
  const types = [32, 33, 34];
  let total = 23;
  for (const n of arrs) total += 5 + n.length;
  const out = new Uint8Array(total);
  let o = 0;
  out[o++] = 1;                                                        // configurationVersion
  out[o++] = ((si.profileSpace & 3) << 6) | ((si.tier & 1) << 5) | (si.profileIdc & 0x1f);
  out[o++] = (si.compat >>> 24) & 0xff; out[o++] = (si.compat >>> 16) & 0xff;
  out[o++] = (si.compat >>> 8) & 0xff; out[o++] = si.compat & 0xff;
  out.set(si.constraint, o); o += 6;                                   // general_constraint_indicator_flags
  out[o++] = si.level & 0xff;
  out[o++] = 0xF0; out[o++] = 0x00;                                    // min_spatial_segmentation_idc=0
  out[o++] = 0xFC;                                                     // parallelismType=0
  out[o++] = 0xFD;                                                     // chromaFormat=1 (4:2:0)
  out[o++] = 0xF8;                                                     // bitDepthLumaMinus8=0
  out[o++] = 0xF8;                                                     // bitDepthChromaMinus8=0
  out[o++] = 0x00; out[o++] = 0x00;                                    // avgFrameRate
  out[o++] = (((si.maxSubLayers + 1) & 7) << 3) | 0x04 | 0x03;         // numTemporalLayers / temporalIdNested / lengthSize=4
  out[o++] = 3;                                                        // numOfArrays
  for (let a = 0; a < 3; a++) {
    const n = arrs[a];
    out[o++] = 0x80 | types[a];
    out[o++] = 0x00; out[o++] = 0x01;                                  // numNalus=1
    out[o++] = (n.length >>> 8) & 0xff; out[o++] = n.length & 0xff;
    out.set(n, o); o += n.length;
  }
  // RFC 6381 codec 串
  const space = ['', 'A', 'B', 'C'][si.profileSpace] || '';
  let ce = 6;
  while (ce > 0 && si.constraint[ce - 1] === 0) ce--;
  let consHex = '';
  for (let i = 0; i < ce; i++) consHex += si.constraint[i].toString(16).padStart(2, '0').toUpperCase();
  hevcCodecStr = 'hvc1.' + space + si.profileIdc + '.' + hevcRev32(si.compat).toString(16).toUpperCase()
    + '.' + (si.tier ? 'H' : 'L') + si.level + (consHex ? '.' + consHex : '');
  return out;
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
  let cfg;
  if (codecHint === 'hevc') {
    const desc = buildHvcC();
    if (!desc) return null;
    cfg = {
      codec: hevcCodecStr,        // 从 SPS 的 profile_tier_level 推出来（hvc1.1.6.L153.90 这类）
      description: desc,          // hvcC：VideoDecoder 解 hvc1 必需
      optimizeForLatency: true,
    };
  } else {
    cfg = {
      codec: 'avc1.4D0032',     // 与实际码流一致（日志 avc1.4D4032 / Main 3.2）
      description: buildAvcC(sps, pps),
      optimizeForLatency: true,
    };
  }
  if (hw) cfg.hardwareAcceleration = hw;
  return cfg;
}

function probe(hw) {
  try {
    if (typeof VideoDecoder.isConfigSupported !== 'function') return Promise.resolve(false);
    const cfg = buildConfig(hw);
    if (!cfg) return Promise.resolve(false);
    return VideoDecoder.isConfigSupported(cfg)
      .then(function (r) { return !!(r && r.supported); })
      .catch(function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}

function createDecoder(hw) {
  const prev = decoder;
  decoderReady = false;
  try { if (prev) prev.close(); } catch (e) { }
  const cfg = buildConfig(hw);
  if (!cfg) {
    // HEVC 参数集还没齐 / profile 不支持：不建解码器，交给 onEncodedFrame 继续等/报错
    if (!S.lastErr) S.lastErr = 'no-config';
    return false;
  }
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
  decoder.configure(cfg);
  // 记住"这只解码器是按哪组参数集配的"，onEncodedFrame 里靠它发现编码器换参数了
  cfgSps = sps ? sps.slice() : null;
  cfgPps = pps ? pps.slice() : null;
  cfgVps = vps ? vps.slice() : null;
  decoderHw = hw || 'default';
  decoderReady = true;
  decoderIniting = false;
  S.cfg++;
  post({ type: 'ready', hw: decoderHw, cfg: S.cfg, codec: codecHint, codecString: hevcCodecStr, err: S.lastErr });
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
  if (codecHint === 'hevc') {
    if (!vps || !sps || !pps) return false;
  } else if (!sps || !pps) return false;
  decoderIniting = true;

  // 阶段1：探测硬件支持
  probe('prefer-hardware').then(function (hwOk) {
    if (hwOk) {
      try { if (createDecoder('prefer-hardware')) return; }
      catch (e) {
        S.lastErr = 'hw-configure: ' + String((e && e.message) || e);
        // 硬件配置失败 -> 落到阶段2
      }
    }
    // 阶段2：回退到浏览器自选
    try {
      if (!createDecoder('')) {
        decoderIniting = false;
        decoderReady = false;
        post({ type: 'error', message: 'decoder-config-unavailable: ' + (S.lastErr || 'no-config') });
      }
    } catch (e2) {
      S.lastErr = 'configure: ' + String((e2 && e2.message) || e2);
      post({ type: 'error', message: S.lastErr });
      decoderIniting = false;
      decoderReady = false;
    }
  }).catch(function () {
    try { if (!createDecoder('')) { decoderIniting = false; decoderReady = false; } }
    catch (e3) { decoderIniting = false; decoderReady = false; }
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
  noteArrival();       // 2026-11-11：到达节奏采样（画面间断感的量化依据）
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
  let hasKeyNal = false;
  for (const n of nals) {
    if (!n.length) continue;
    if (codecHint === 'hevc') {
      // HEVC NAL 头 2 字节：type=(b>>1)&0x3f。参数集 32/33/34，关键帧 IRAP 16~21。
      if (n.length < 2) continue;
      const t = (n[0] >> 1) & 0x3f;
      types.push(t + ':' + n.length);
      if (t === 32) { vps = n.slice(); continue; }
      if (t === 33) { sps = n.slice(); continue; }
      if (t === 34) { pps = n.slice(); continue; }
      if (t >= 16 && t <= 21) hasKeyNal = true;
      kept.push(n);
    } else {
      const t = n[0] & 0x1f;
      types.push(t + ':' + n.length);
      if (t === 7) { sps = n.slice(); continue; }
      if (t === 8) { pps = n.slice(); continue; }
      if (t === 5) hasKeyNal = true;
      kept.push(n);
    }
  }
  if (S.frames < 4 || S.rtp <= 2) {
    post({ type: 'diag', msg: 'codec=' + codecHint + ' nals=' + nals.length + ' [' + types.join(',') + '] kept=' + kept.length
      + ' vps=' + (vps ? vps.length : 0) + ' sps=' + (sps ? sps.length : 0) + ' pps=' + (pps ? pps.length : 0) });
  }
  if (!kept.length) { S.dropped++; return; }

  // 关键帧必须从 NALU 判断：实测 RTCEncodedVideoFrame.type 几乎总是 'delta'，
  // 信它会导致 IDR 被标成 delta，解码器一直等关键帧、一帧都不输出。
  // HEVC 的 IRAP = 16~21（19/20 是 IDR）。
  const isKeyFrame = isKey || hasKeyNal;
  if (isKeyFrame) S.keyframes++;

  // 参数集变了 = 编码器重启了（切分辨率、切窗口、崩溃重启）。
  // 现有解码器是按旧 avcC/hvcC 配的，而我们在喂数据前把参数集剥掉了，解码器自己永远发现不了 ——
  // 继续喂的结果就是画面冻住（桌面硬解）或整屏花屏（手机硬解），而且计数器看着完全正常。
  // 这里必须重建解码器，等下一个关键帧重新 configure。
  if ((sps && !bytesEq(cfgSps, sps)) || (pps && !bytesEq(cfgPps, pps)) || (vps && !bytesEq(cfgVps, vps))) {
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

  // 输入用 AVCC（4 字节长度前缀）：H.264 配 avcC、HEVC 配 hvcC，格式都是长度前缀
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
  // 阈值按**时间**算（250ms 的帧数）：240fps 时 30 帧只有 125ms（太敏感），30fps 时 30 帧是 1 秒（太迟钝）。
  //
  // 2026-11-10 修正（线上事故）：上一版把 tsEma 当成"毫秒/帧"直接除，但它是 **RTP 时间戳差（90kHz）**：
  // 240fps 下 tsEma ≈ 375，250/375 取整成 0，再被 Math.max(4,…) 兜成 4 帧 ——
  // 于是 240fps 时每 16ms 就"队列过深"一次，解码器被无休止重建（实测 cfg 从 60 涨到 122 / 30 秒），
  // 每次重建都要等关键帧 → 画面基本全黑。现在换算成毫秒（/90）并把结果钳在 8~120 帧，
  // 另外加 2 秒重建限流：限流期间只丢帧等关键帧，绝不反复重建。
  {
    let q = 0;
    try { q = (decoder && decoder.decodeQueueSize) || 0; } catch (e) { q = 0; }
    S.queue = q | 0;
    const _msPerFrame = (S.tsEma > 90 ? (S.tsEma / 90) : 16);
    let _maxQ = Math.round(250 / _msPerFrame);
    if (!(_maxQ > 0)) _maxQ = 30;
    if (_maxQ < 8) _maxQ = 8;
    if (_maxQ > 120) _maxQ = 120;
    if (q > _maxQ) {
      const _nowR = performance.now();   // 用单调时钟：系统时间回拨不会让限流窗口变长
      if (_nowR - (S.lastResyncAt | 0) < 2000) {
        // 重建限流：2 秒内只重建一次。这段时间里直接丢帧、等到下一个关键帧再恢复，
        // 宁可画面停一下，也不能因为反复重建把整屏变成黑的。
        S.dropped++;
        waitKey = true;
        return;
      }
      S.lastResyncAt = _nowR;
      S.resyncs = (S.resyncs || 0) + 1;
      post({ type: 'resync', queue: q, resyncs: S.resyncs, max: _maxQ });
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
        const _pc = buildConfig('');
        if (_pc) VideoDecoder.isConfigSupported(_pc)
          .then(function (r) { post({ type: 'diag', msg: 'isConfigSupported=' + (r && r.supported) + ' codec=' + _pc.codec }); })
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
    try { cadenceSnapshot(); } catch (e) { }   // 到达节奏统计（算完清零）
    post({ type: 'stats', stats: Object.assign({}, S), ready: decoderReady, waitKey, err: S.lastErr });
  }, 2000);
}

function resetDecoderState() {
  waitKey = true;
  tsUs = 0;
  sps = null; pps = null; vps = null;
  cfgSps = null; cfgPps = null; cfgVps = null;
  hevcCodecStr = '';
  pendingKey = null;
  try { if (decoder) decoder.close(); } catch (x) { }
  decoder = null; decoderReady = false; decoderIniting = false;
}

self.addEventListener('rtctransform', handleRtpTransform);

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'fps') {
    fpsHint = Number(m.fps) || 60;
  } else if (m.type === 'codec') {
    // 2026-11-12 HEVC P1：主线程按 /rtc264/offer 的响应告诉我们这次是 h264 还是 hevc。
    // 换 codec 必须整只解码器重建（description 完全不同）。
    const c = (m.codec === 'hevc') ? 'hevc' : 'h264';
    if (c !== codecHint) {
      codecHint = c;
      S.codec = codecHint;
      resetDecoderState();
      post({ type: 'diag', msg: 'codec hint -> ' + codecHint });
    }
    S.codec = codecHint;
  } else if (m.type === 'reset') {
    resetDecoderState();
  } else if (m.type === 'gap') {
    // 2026-11-10：主线程从 getStats 看到丢包，说明参考帧链断了。
    // 继续解 P 帧只会得到一整片花屏，改成等下一个 IDR（GOP 0.5 秒，画面最多停半秒）。
    S.gaps = (S.gaps || 0) + 1;
    waitKey = true;
  } else if (m.type === 'ping') {
    post({ type: 'stats', stats: Object.assign({}, S), ready: decoderReady, waitKey, err: S.lastErr });
  }
};
