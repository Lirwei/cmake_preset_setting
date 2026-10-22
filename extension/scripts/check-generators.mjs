/**
 * 诊断：打印扩展从本机 `cmake --help` 解析到的生成器列表。
 *
 *   node scripts/check-generators.mjs
 *
 * 需要先 `npm run compile`（生成 out/）。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGenerators } = require('../out/core/generators.js');

let help = '';
try {
  help = execFileSync('cmake', ['--help'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
} catch (err) {
  console.log('找不到 cmake，扩展会使用内置兜底列表：');
  console.log(parseGenerators('').join('\n'));
  process.exit(0);
}

const generators = parseGenerators(help);
console.log(`解析到 ${generators.length} 个生成器（已去掉 deprecated）：`);
for (const name of generators) console.log('  - ' + name);
