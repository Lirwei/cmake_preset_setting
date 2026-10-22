/**
 * 冒烟测试：不依赖 dist/，直接从本机 CMake 文档构建目录，起服务、打接口、校验数据。
 *
 *   node test/smoke.mjs
 *   # 或 npm run smoke
 *
 * 退出码非 0 表示失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { findCMake, findDocsHome, loadVariableDocs } from '../lib/cmake-docs.mjs';
import { enrich, isUsable, instantiateLangTemplates } from '../lib/catalog.mjs';
import { startServer } from '../lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const PROTOTYPE = path.resolve(ROOT, '..', '..', 'docs', 'prototype', 'variables.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(err.message).replace(/\n/g, '\n        ')}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(err.message).replace(/\n/g, '\n        ')}`);
  }
}

console.log('\n[1/4] 解析本机 CMake 文档');
const cmake = findCMake();
assert.ok(cmake, '找不到 cmake，请确认已安装并在 PATH 中');
const home = findDocsHome(cmake.exe, cmake.version);
assert.ok(home, '找不到 Help/variable 文档目录');
console.log(`  cmake ${cmake.version}  docs=${home}`);

const { variables, fileCount } = loadVariableDocs(home);
const catalog = instantiateLangTemplates(variables).filter(isUsable).map(enrich);
console.log(`  文档 ${fileCount} 个 → 变量 ${catalog.length} 条`);

console.log('\n[2/4] 数据质量');

check('变量数量 > 500', () => {
  assert.ok(catalog.length > 500, `只有 ${catalog.length} 条`);
  return `${catalog.length} 条`;
});

check('没有空说明', () => {
  const empty = catalog.filter((v) => !v.summary);
  assert.equal(empty.length, 0, `有 ${empty.length} 条空说明: ${empty.slice(0, 3).map((v) => v.name).join(', ')}`);
  return '0 条';
});

check('说明里没有残留 RST 标记', () => {
  const bad = catalog.filter((v) => /\|[A-Z_]+\||:ref:|:variable:|``|\.\.\s/.test(v.summary));
  assert.equal(bad.length, 0, `${bad.length} 条残留: ${bad.slice(0, 3).map((v) => v.name).join(', ')}`);
  return '0 条';
});

check('常用变量带类型', () => {
  const buildType = catalog.find((v) => v.name === 'CMAKE_BUILD_TYPE');
  assert.ok(buildType, '缺少 CMAKE_BUILD_TYPE');
  assert.equal(buildType.type, 'STRING');
  assert.deepEqual(buildType.values, ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel']);
  return 'CMAKE_BUILD_TYPE = STRING + 4 个取值';
});

check('CMAKE_<LANG>_* 已实例化', () => {
  for (const name of ['CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_CXX_FLAGS']) {
    assert.ok(catalog.some((v) => v.name === name), `缺少 ${name}`);
  }
  return 'C / C++ 编译器与编译选项都在';
});

check('黑名单变量标注了替代字段', () => {
  const g = catalog.find((v) => v.name === 'CMAKE_GENERATOR_PLATFORM');
  assert.equal(g && g.preferField, 'architecture');
  return 'CMAKE_GENERATOR_PLATFORM → architecture';
});

console.log('\n[3/4] 本地 HTTP 服务');

const { server, started } = startServer({ catalog, meta: { cmake: { version: cmake.version } }, port: 0 });
const addr = await started;
const base = `http://127.0.0.1:${addr.port}`;

await checkAsync('GET /api/health', async () => {
  const r = await fetch(`${base}/api/health`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, catalog.length);
  return `${body.count} 条`;
});

await checkAsync('搜索排序（精确匹配优先）', async () => {
  const r = await fetch(`${base}/api/search?q=CMAKE_BUILD_TYPE&limit=5`);
  const body = await r.json();
  assert.ok(body.items.length > 0, '没有结果');
  assert.equal(body.items[0].name, 'CMAKE_BUILD_TYPE', `首条是 ${body.items[0].name}`);
  return body.items.map((i) => i.name).join(', ');
});

await checkAsync('搜索说明文字（描述命中）', async () => {
  const r = await fetch(`${base}/api/search?q=compile_commands&limit=5`);
  const body = await r.json();
  assert.ok(body.items.some((i) => i.name === 'CMAKE_EXPORT_COMPILE_COMMANDS'), '没搜到 CMAKE_EXPORT_COMPILE_COMMANDS');
  return `${body.items.length} 条命中`;
});

await checkAsync('GET / 页面可渲染', async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes('CMake 变量目录'), '页面标题缺失');
  assert.ok(html.includes(String(catalog.length)), '页面没有注入数量');
  return `${html.length} 字节`;
});

server.close();

console.log('\n[4/4] 原型数据文件');

check('docs/prototype/variables.js 可加载', () => {
  assert.ok(fs.existsSync(PROTOTYPE), `文件不存在: ${PROTOTYPE}\n        先运行 node index.mjs build --prototype ../../docs/prototype/variables.js`);
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(PROTOTYPE, 'utf8'), sandbox);
  const list = sandbox.window.CMAKE_VARIABLES;
  assert.ok(Array.isArray(list), 'window.CMAKE_VARIABLES 不是数组');
  assert.ok(list.length > 500, `只有 ${list.length} 条`);
  return `${list.length} 条`;
});

check('原型条目结构与扩展约定一致', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(PROTOTYPE, 'utf8'), sandbox);
  const sample = sandbox.window.CMAKE_VARIABLES.find((v) => v.name === 'CMAKE_BUILD_TYPE');
  assert.ok(sample, '缺少 CMAKE_BUILD_TYPE');
  for (const key of ['name', 'type', 'desc', 'values', 'hot']) {
    assert.ok(key in sample, `缺少字段 ${key}`);
  }
  return Object.keys(sample).join(', ');
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
