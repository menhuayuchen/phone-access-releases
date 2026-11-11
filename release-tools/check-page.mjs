// check-page.mjs —— 改 app/page.mjs 后必须跑的检查（2026-11-11）
//
// 为什么需要它：page.mjs 的整页 HTML 放在 `const PAGE_HTML = String.raw\`...\`` 模板里。
// 模板里**任何**反引号都会提前结束模板、后面的文字变成 JS 去执行 → 服务启动即崩
// （实测踩过 4 次，最惨一次是把生产服务搞挂：ReferenceError: video is not defined）。
// 另外 String.raw 只关掉转义处理，**仍然会做 ${} 插值**，所以模板里也不能出现 ${。
//
// 用法: node release-tools/check-page.mjs [page.mjs 路径]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const file = process.argv[2] || path.join(__dirname, '..', 'app', 'page.mjs');
const src = fs.readFileSync(file, 'utf8');
const BT = String.fromCharCode(96);
const DOLLAR_BRACE = '$' + '{';
let bad = 0;

// 1) 整文件语法
try {
  execFileSync(NODE, ['--check', file], { stdio: 'pipe' });
  console.log('[OK] 整文件语法通过');
} catch (e) {
  console.log('[FAIL] 语法错误');
  console.log(String(e.stderr || e.stdout || e.message).slice(0, 2000));
  process.exit(1);
}

// 2) 反引号必须**恰好 2 个**（模板开 / 闭）。多出来的必然在模板内部，会把模板截断。
const lines = src.split('\n');
const btLines = [];
lines.forEach((l, i) => { if (l.indexOf(BT) >= 0) btLines.push(i + 1); });
if (btLines.length === 2) {
  console.log('[OK] 反引号恰好 2 个（模板定界符）：行 ' + btLines.join(', '));
} else {
  bad++;
  console.log('[FAIL] 反引号有 ' + btLines.length + ' 个（必须恰好 2 个），出现在行: ' + btLines.join(', '));
  btLines.forEach((n) => console.log('   L' + n + ': ' + (lines[n - 1] || '').trim().slice(0, 140)));
}

// 3) 模板内部不能出现 ${（String.raw 仍然会插值）
const openIdx = src.indexOf('String.raw' + BT);
const closeIdx = src.lastIndexOf(BT);
if (openIdx >= 0 && closeIdx > openIdx) {
  const body = src.slice(openIdx + ('String.raw' + BT).length, closeIdx);
  const hit = body.indexOf(DOLLAR_BRACE);
  if (hit >= 0) {
    bad++;
    const before = body.slice(0, hit);
    const lineNo = (src.slice(0, openIdx + before.length).split('\n').length);
    console.log('[FAIL] 模板内部出现 ${（会被当成插值执行），约在行 ' + lineNo);
  } else {
    console.log('[OK] 模板内部没有 ${');
  }
}

// 4) 把 <script> 块抽出来单独做语法检查（页面里的 JS 语法错也要在部署前发现）
const scripts = [];
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(src)) !== null) scripts.push(m[1]);
console.log('抽到 <script> 块: ' + scripts.length + ' 个');
let fail = 0;
scripts.forEach((code, i) => {
  const tmp = path.join(require_tmp(), 'inline-' + i + '.js');
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(NODE, ['--check', tmp], { stdio: 'pipe' });
    console.log('  [' + i + '] OK  ' + code.length + ' 字符');
  } catch (e) {
    fail++;
    console.log('  [' + i + '] FAIL ' + code.length + ' 字符');
    console.log(String(e.stderr || '').slice(0, 1200));
  }
});
if (fail) { bad++; console.log('[FAIL] ' + fail + ' 个内联脚本语法错误'); }
else console.log('[OK] 所有内联 <script> 语法通过');

function require_tmp() {
  const d = path.join(process.env.TEMP || process.env.TMP || '.', 'dsh-sync');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}

if (bad) { console.log('\n==> 有 ' + bad + ' 项不通过，**不要部署**'); process.exit(1); }
console.log('\n==> 全部通过，可以部署');
