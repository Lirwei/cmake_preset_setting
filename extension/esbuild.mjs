import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const root = import.meta.dirname;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

// 变量目录：tools/var-catalog 生成过就带进扩展
const catalogSource = path.resolve(root, '..', 'tools', 'var-catalog', 'dist', 'variables.json');
const catalogTarget = path.resolve(root, 'media', 'catalog.json');
if (fs.existsSync(catalogSource)) {
  fs.mkdirSync(path.dirname(catalogTarget), { recursive: true });
  fs.copyFileSync(catalogSource, catalogTarget);
  const size = (fs.statSync(catalogTarget).size / 1024).toFixed(0);
  console.log(`catalog: ${path.relative(root, catalogTarget)} (${size} KB)`);
} else {
  console.log('catalog: 未找到 tools/var-catalog/dist/variables.json，将使用内置兜底列表');
}

const options = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'dist', 'extension.js'),
  external: ['vscode'],
  // jsonc-parser 的 UMD 包在 bundle 里会退化成运行时 require，优先用 ESM 入口
  mainFields: ['module', 'main'],
  sourcemap: true,
  logLevel: 'info',
  minify: false,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('esbuild: watching…');
} else {
  await esbuild.build(options);
  console.log('esbuild: dist/extension.js 已生成');
}
