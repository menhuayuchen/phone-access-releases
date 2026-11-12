// enc-ab.mjs —— 编码器 A/B（真实抓屏，离线分析每帧体积 / 关键帧分布）
//
// 为什么要有它：低延迟链路里"卡一下"的主要来源是**关键帧一次性大突发**
// （1920x1200 CBR 下 IDR 可达数百 KB）。要给 `-intra-refresh`（渐进刷新）定性，
// 必须先把"每帧多大、关键帧多大、多久来一次"量出来，而不是靠观感。
//
// 做法：用**和生产完全相同的抓屏 + 编码参数**跑 ffmpeg，写 fMP4 到临时文件，
// 然后自己解析 fMP4 的 trun 得到每帧字节数与关键帧标记（含 NAL 类型扫描，
// 用来确认到底有没有 IDR / 恢复点 SEI）。
//
// 用法：
//   node release-tools/enc-ab.mjs                        # 默认：基线 vs PIR 两档，各 8 秒
//   node release-tools/enc-ab.mjs --seconds 10 --variants base,pir60,pir120
//   node release-tools/enc-ab.mjs --fps 60 --kbps 20000
//   node release-tools/enc-ab.mjs --file a.mp4            # 只分析已有文件（不抓屏）
//
// 注意：会独占 NVENC 若干秒；生产编码器没人观看时（/h264-status viewers=0）再跑。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'app', 'bin', 'ffmpeg.exe');
const OUTDIR = path.join(ROOT, '.encab');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const SECONDS = Number(arg('seconds', '8'));
const FPS = Number(arg('fps', '120'));
const KBPS = Number(arg('kbps', '20000'));
const W = Number(arg('w', '1920'));
const H = Number(arg('h', '1200'));
const MON = Number(arg('mon', '0'));
const ONLY = arg('file', '');
const VARIANTS = arg('variants', 'base,pir60,pir120').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- fMP4 解析（只依赖 Buffer，不引外部库）----------
function boxes(buf, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o, end: o + size, header });
    o += size;
  }
  return out;
}

function nalTypes(data) {
  // 输入是 AVCC（4 字节长度前缀）还是 Annex-B？fMP4 里是 AVCC
  const types = [];
  let o = 0;
  for (let guard = 0; guard < 64 && o + 4 <= data.length; guard++) {
    const len = data.readUInt32BE(o);
    if (len <= 0 || o + 4 + len > data.length) break;
    types.push(data[o + 4] & 0x1f);
    o += 4 + len;
  }
  return types;
}

function seiPayloadTypes(data) {
  // 扫 NAL 6（SEI），返回里面的 payloadType 列表（恢复点 SEI = 6）
  const out = [];
  let o = 0;
  for (let guard = 0; guard < 64 && o + 4 <= data.length; guard++) {
    const len = data.readUInt32BE(o);
    if (len <= 0 || o + 4 + len > data.length) break;
    const t = data[o + 4] & 0x1f;
    if (t === 6) {
      let p = o + 5;
      const endp = o + 4 + len;
      while (p + 1 < endp) {
        let pt = 0;
        while (p < endp && data[p] === 0xff) p++;
        if (p >= endp) break;
        pt = data[p++];
        let sz = 0;
        while (p < endp && data[p] === 0xff) p++;
        if (p >= endp) break;
        sz = data[p++];
        out.push(pt);
        p += sz;
        if (pt === 0x80) break;   // 只有最后一块有 0x80
      }
    }
    o += 4 + len;
  }
  return out;
}

function parseMp4(file) {
  const buf = fs.readFileSync(file);
  const top = boxes(buf, 0, buf.length);
  let sps = null, pps = null;
  for (const b of top) {
    if (b.type !== 'moov') continue;
    // 找 avcC，取 SPS/PPS 长度，后面检查 PIR 有没有改 profile
    const walk = (s, e, depth) => {
      if (depth > 6) return;
      for (const c of boxes(buf, s, e)) {
        if (c.type === 'avcC') {
          const q = c.start + 8;
          const numSps = buf[q + 5] & 0x1f;
          let p = q + 6;
          const spss = [];
          for (let i = 0; i < numSps; i++) { const L = buf.readUInt16BE(p); p += 2; spss.push(L); p += L; }
          const numPps = buf[p]; p += 1;
          const ppss = [];
          for (let i = 0; i < numPps; i++) { const L = buf.readUInt16BE(p); p += 2; ppss.push(L); p += L; }
          sps = spss; pps = ppss;
          return;
        }
        walk(c.start + c.header, c.end, depth + 1);
      }
    };
    walk(b.start + b.header, b.end, 0);
  }

  const frames = [];
  for (const moof of top.filter((b) => b.type === 'moof')) {
    const i = top.indexOf(moof);
    const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
    if (!mdat) continue;
    const payload = buf.subarray(mdat.start + mdat.header, mdat.end);
    let off = 0;
    for (const traf of boxes(buf, moof.start + moof.header, moof.end)) {
      if (traf.type !== 'traf') continue;
      let defSize = 0;
      const truns = [];
      for (const g of boxes(buf, traf.start + traf.header, traf.end)) {
        if (g.type === 'tfhd') {
          const flags = buf.readUInt32BE(g.start + 8) & 0xffffff;
          let q = g.start + 16;
          if (flags & 0x1) q += 8;
          if (flags & 0x2) q += 4;
          if (flags & 0x8) q += 4;
          if (flags & 0x10) defSize = buf.readUInt32BE(q);
        } else if (g.type === 'trun') truns.push(g);
      }
      for (const g of truns) {
        const flags = buf.readUInt32BE(g.start + 8) & 0xffffff;
        let q = g.start + 12;
        const count = buf.readUInt32BE(q); q += 4;
        if (flags & 0x1) q += 4;
        let firstFlags = 0;
        if (flags & 0x4) { firstFlags = buf.readUInt32BE(q); q += 4; }
        const hasDur = !!(flags & 0x100), hasSize = !!(flags & 0x200), hasFlags = !!(flags & 0x400), hasCto = !!(flags & 0x800);
        for (let k = 0; k < count; k++) {
          let dur = 0;
          if (hasDur) { dur = buf.readUInt32BE(q); q += 4; }
          const size = hasSize ? (q += 4, buf.readUInt32BE(q - 4)) : defSize;
          let sflags = firstFlags;
          if (hasFlags) { sflags = buf.readUInt32BE(q); q += 4; }
          if (hasCto) q += 4;
          const data = payload.subarray(off, off + size);
          off += size;
          const nt = nalTypes(data);
          const sync = !!(sflags & 0x10000);
          const hasIdr = nt.includes(5);
          frames.push({
            size, dur, sync, hasIdr, nal: nt, sei: seiPayloadTypes(data),
            key: sync || hasIdr,
          });
        }
      }
    }
  }
  return { frames, sps, pps, bytes: buf.length };
}

// ---------- 统计 ----------
const kb = (n) => (n / 1024).toFixed(1);
const pctv = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function summarize(name, r, seconds) {
  const f = r.frames;
  const sizes = f.map((x) => x.size);
  const keys = f.filter((x) => x.key);
  const total = sizes.reduce((a, b) => a + b, 0);
  const keySizes = keys.map((x) => x.size);
  const nonKey = f.filter((x) => !x.key).map((x) => x.size);
  const idrOnly = f.filter((x) => x.hasIdr);
  const seiRec = f.filter((x) => x.sei && x.sei.includes(6));
  const over = (n) => sizes.filter((x) => x > n * 1024).length;
  return {
    name,
    frames: f.length,
    fpsObserved: +(f.length / seconds).toFixed(1),
    kbps: +(total * 8 / seconds / 1000).toFixed(0),
    avgKB: +kb(total / Math.max(1, f.length)),
    maxKB: +kb(Math.max(0, ...sizes)),
    p50KB: +kb(pctv(sizes, 0.5)),
    p95KB: +kb(pctv(sizes, 0.95)),
    p99KB: +kb(pctv(sizes, 0.99)),
    over200: over(200),
    over300: over(300),
    keyCount: keys.length,
    keyP50KB: keySizes.length ? +kb(pctv(keySizes, 0.5)) : 0,
    keyMaxKB: keySizes.length ? +kb(Math.max(...keySizes)) : 0,
    nonKeyP99KB: nonKey.length ? +kb(pctv(nonKey, 0.99)) : 0,
    idrCount: idrOnly.length,
    seiRecoveryCount: seiRec.length,
    keyGapFrames: keys.slice(1).map((x, i) => f.indexOf(x) - f.indexOf(keys[i])).filter((v, i, a) => a.indexOf(v) === i),
    top5: [...f.map((x, i) => ({ i, kb: +kb(x.size), key: x.key, nal: x.nal.join('/'), sei: x.sei.join('/') }))]
      .sort((a, b) => b.kb - a.kb).slice(0, 5),
    keyList: keys.map((x, i) => ({
      i: f.indexOf(x), kb: +kb(x.size),
      nals: x.nal.join('/'), idr: x.hasIdr, sync: x.sync, sei: x.sei.join('/'),
    })).slice(0, 40),
  };
}

// ---------- 变体参数 ----------
function argsFor(variant, outFile) {
  // 抓屏与主路生产参数逐条对齐（见 app/screen-server.mjs h264Start/h264EncOnly）
  const enc = [
    '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1',
    '-rc', 'cbr_ld_hq', '-rc-lookahead', '0', '-delay', '0', '-surfaces', '2',
    '-b:v', String(KBPS) + 'K',
  ];
  let gop = Math.max(1, Math.round(FPS / 2));
  const extra = [];
  if (variant === 'base') {
    // 现状：0.5 秒 GOP，周期性 IDR
  } else if (variant.startsWith('pirf')) {
    // pirf120_4 = PIR，GOP 120，另外每 4 秒强制一次真 IDR（无 -forced-idr，看 ffmpeg 默认行为）
    const m = variant.match(/^pirf(\d+)(?:_([\d.]+))?$/);
    gop = Number(m && m[1]) || Math.round(FPS / 2);
    const every = m && m[2] ? Number(m[2]) : 4;
    extra.push('-intra-refresh', '1', '-force_key_frames', `expr:gte(t,n_forced*${every})`);
  } else if (variant.startsWith('piri')) {
    // piri60_1 = PIR + 每 1 秒强制一次**真 IDR**（-forced-idr 1 才会是 IDR）
    const m = variant.match(/^piri(\d+)(?:_([\d.]+))?$/);
    gop = Number(m && m[1]) || Math.round(FPS / 2);
    const every = m && m[2] ? Number(m[2]) : 1;
    extra.push('-intra-refresh', '1', '-forced-idr', '1', '-force_key_frames', `expr:gte(t,n_forced*${every})`);
  } else if (variant === 'nosc') {
    extra.push('-no-scenecut', '1');
  } else if (variant.startsWith('pir') && variant.endsWith('n')) {
    // pir60n = PIR + 关掉 scenecut（场景切换不再插大 I 帧）
    gop = Number(variant.slice(3, -1)) || Math.round(FPS / 2);
    extra.push('-intra-refresh', '1', '-no-scenecut', '1');
  } else if (variant.startsWith('pir')) {
    // pir60 / pir120 / pir240 = 纯渐进刷新，GOP 内完成一轮整屏刷新
    gop = Number(variant.slice(3)) || Math.round(FPS / 2);
    extra.push('-intra-refresh', '1');
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'lavfi', '-i', `ddagrab=framerate=${FPS}:draw_mouse=0:output_idx=${MON}`,
    '-filter_complex', `[0:v]hwdownload,format=bgra,scale=${W}:-2:flags=lanczos+accurate_rnd[v]`,
    '-map', '[v]', '-pix_fmt', 'nv12', '-r', String(FPS),
    ...enc, '-g', String(gop), '-bf', '0', ...extra,
    '-t', String(SECONDS),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+separate_moof',
    '-frag_duration', '5000', '-flush_packets', '1', outFile,
  ];
}

function runOne(variant) {
  const outFile = path.join(OUTDIR, `${variant}.mp4`);
  try { fs.rmSync(outFile, { force: true }); } catch { }
  const args = argsFor(variant, outFile);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let err = '';
    const p = spawn(FFMPEG, args, { windowsHide: true });
    p.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
    p.on('exit', (code) => {
      const ms = Date.now() - t0;
      if (code !== 0 || !fs.existsSync(outFile)) {
        console.log(`[${variant}] ffmpeg 失败 code=${code} ${err.slice(-600)}`);
        resolve(null);
        return;
      }
      let r = null;
      try { r = parseMp4(outFile); } catch (e) { console.log(`[${variant}] 解析失败 ${e.message}`); resolve(null); return; }
      const s = summarize(variant, r, SECONDS);
      s.wallMs = ms;
      s.fileMB = +(fs.statSync(outFile).size / 1048576).toFixed(1);
      s.sps = r.sps; s.pps = r.pps;
      console.log(`\n=== ${variant}（${SECONDS}s @${FPS}fps ${KBPS}kbps，耗时 ${(ms / 1000).toFixed(1)}s）`);
      console.log(`  帧 ${s.frames}（实测 ${s.fpsObserved}fps） 平均码率 ${s.kbps}kbps  平均 ${s.avgKB}KB/帧`);
      console.log(`  帧体积：p50=${s.p50KB}KB p95=${s.p95KB}KB p99=${s.p99KB}KB max=${s.maxKB}KB`);
      console.log(`  大帧：>200KB ${s.over200} 个，>300KB ${s.over300} 个`);
      console.log(`  关键帧：${s.keyCount} 个（真 IDR ${s.idrCount} 个，恢复点SEI ${s.seiRecoveryCount} 个）`
        + `  关键帧体积 p50=${s.keyP50KB}KB max=${s.keyMaxKB}KB`);
      console.log(`  关键帧间隔（帧）：${s.keyGapFrames.join(',') || '-'}`);
      console.log(`  最大的 5 帧：` + s.top5.map((x) => `#${x.i}:${x.kb}KB${x.key ? '(key)' : ''}`).join('  '));
      if (s.keyList.length) {
        console.log(`  关键帧明细（前 ${s.keyList.length}）：`);
        for (const k of s.keyList.slice(0, 12)) console.log(`    #${String(k.i).padStart(4)}  ${String(k.kb).padStart(7)}KB  nals=${k.nals}  idr=${k.idr} sync=${k.sync} sei=${k.sei || '-'}`);
      }
      resolve(s);
    });
  });
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  if (!fs.existsSync(FFMPEG)) { console.error('缺 ffmpeg: ' + FFMPEG); process.exit(2); }
  if (ONLY) {
    const r = parseMp4(ONLY);
    console.log(JSON.stringify(summarize(path.basename(ONLY), r, SECONDS), null, 2));
    return;
  }
  console.log(`编码 A/B：${W}x${H} @${FPS}fps ${KBPS}kbps，每档 ${SECONDS}s，屏幕 ${MON}`);
  console.log('变体：' + VARIANTS.join(', '));
  const all = [];
  for (const v of VARIANTS) {
    const s = await runOne(v);
    if (s) all.push(s);
    await new Promise((r) => setTimeout(r, 1200));
  }
  fs.writeFileSync(path.join(OUTDIR, `ab-${Date.now()}.json`), JSON.stringify(all, null, 2));
  if (all.length > 1) {
    console.log('\n=== 对比 ===');
    const H2 = ['变体', '帧', '码率', 'maxKB', 'p99KB', '>200', '>300', 'key数', 'keyMax', 'IDR', '恢复点SEI'];
    const rows = all.map((s) => [s.name, s.frames, s.kbps, s.maxKB, s.p99KB, s.over200, s.over300, s.keyCount, s.keyMaxKB, s.idrCount, s.seiRecoveryCount]);
    const w = H2.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(' | ');
    console.log(line(H2));
    for (const r of rows) console.log(line(r));
  }
})();
