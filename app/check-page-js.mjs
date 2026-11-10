// 检查 page.mjs 里**嵌在模板字符串里的那段 JS**能不能通过语法检查。
// 为什么需要：page.mjs 导出的是一个巨大 HTML 字符串，`node --check page.mjs`
// 只检查它外面的 JS（导出、replace），完全看不到里面 <script> 的内容 ——
// 曾经因为在里面写了真实的换行导致浏览器整页脚本挂掉，而 --check 是绿的。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(process.argv[2] || 'page.mjs', 'utf8');
// 把 PAGE_HTML 求值出来：只取 const PAGE_HTML = String.raw`...`; 这一段
const m = src.match(/const PAGE_HTML = String\.raw`([\s\S]*?)`;\s*\n/);
if (!m) { console.error('FAIL: 找不到 PAGE_HTML 模板'); process.exit(2); }
const html = m[1];

// 2026-11-10 新增断言：模板里只要混进一个反引号，正则就会在**那里**提前收尾，
// 后面的页面 JS 全被当成模块代码 → 服务直接起不来（ReferenceError: xxx is not defined），
// 而上面那条正则和 node --check 都不会报错。所以要求截出来的 HTML 必须真的以 </html> 收尾。
if (!/<\/html>\s*$/.test(html)) {
  console.error('FAIL: PAGE_HTML 被提前截断（末尾不是 </html>）—— 模板字符串里混进了反引号？');
  const bt = [...src.matchAll(/`/g)].map((x) => x.index);
  console.error('  全文反引号位置:', bt.join(', '), '（应当只有开头和结尾两个）');
  console.error('  截断处上下文:', JSON.stringify(html.slice(-160)));
  process.exit(3);
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
console.log('内嵌 <script> 数:', scripts.length);
let bad = 0;
scripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-${i + 1}.js` });
    console.log(`  [OK]   script#${i + 1}  ${code.length} 字节`);
  } catch (e) {
    bad++;
    console.error(`  [FAIL] script#${i + 1}: ${e.message}`);
    const ln = Number((/inline-\d+\.js:(\d+)/.exec(e.stack) || [])[1] || 0);
    if (ln) {
      const lines = code.split('\n');
      for (let k = Math.max(0, ln - 3); k < Math.min(lines.length, ln + 2); k++) {
        console.error(`    ${k + 1}: ${lines[k].slice(0, 120)}`);
      }
    }
  }
});
process.exit(bad ? 1 : 0);
