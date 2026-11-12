// run-suite.mjs —— 把全面压测按顺序跑完（每步输出到 .encab/，结束写 suite.done）
// 为什么用 Node 串行而不是一行 shell：路径里有中文，cmd 的代码页容易翻车；Node 的 spawn 不受影响。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.encab');
fs.mkdirSync(OUT, { recursive: true });

const steps = [
  { name: 'stress', args: ['release-tools/stress-test.mjs', '--scenario', 'all', '--minutes', '2'] },
  { name: 'qos', args: ['release-tools/qos-test.mjs', '--minutes', '6'] },
  { name: 'recovery', args: ['release-tools/recovery-test.mjs', '--rounds', '3'] },
];

const results = [];
for (const s of steps) {
  const log = path.join(OUT, 'suite-' + s.name + '.txt');
  const fd = fs.openSync(log, 'w');
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, s.args, { cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true });
    p.on('exit', (c) => resolve(c === null ? -1 : c));
    p.on('error', () => resolve(-2));
  });
  fs.closeSync(fd);
  const sec = Math.round((Date.now() - t0) / 1000);
  results.push({ step: s.name, code, sec });
  fs.writeFileSync(path.join(OUT, 'suite-progress.json'), JSON.stringify(results, null, 2));
  console.log('[' + s.name + '] exit=' + code + ' 用时 ' + sec + 's → ' + log);
}
fs.writeFileSync(path.join(OUT, 'suite.done'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log('SUITE DONE');
