#!/usr/bin/env node
/**
 * CMake 变量目录工具（零依赖，Node >= 18）
 *
 *   node index.mjs build    [--cmake <exe>] [--out dist/variables.json] [--prototype <js>]
 *   node index.mjs project  [--dir <工程目录>] [--depth 3] [--out dist/project-vars.json]
 *   node index.mjs serve    [--data dist/variables.json] [--project dist/project-vars.json] [--port 4848]
 *   node index.mjs selftest
 *
 * 数据来自本机 CMake 安装目录的 Help/variable/*.rst，不联网、不执行项目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCMake, findDocsHome, loadVariableDocs } from './lib/cmake-docs.mjs';
import { enrich, isUsable, instantiateLangTemplates } from './lib/catalog.mjs';
import { collectProject, mergeProject, parseCMakeCache } from './lib/project.mjs';
import { startServer, searchVariables } from './lib/server.mjs';
import { parseVariableDoc } from './lib/rst.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function cmdBuild(args) {
  const cmake = findCMake(typeof args.cmake === 'string' ? args.cmake : undefined);
  if (!cmake) {
    console.error('找不到 cmake。请用 --cmake "C:\\Program Files\\CMake\\bin\\cmake.exe" 指定。');
    process.exitCode = 2;
    return;
  }

  const home = findDocsHome(cmake.exe, cmake.version);
  if (!home) {
    console.error(`找到 cmake ${cmake.version}，但没有找到 Help/variable 文档目录。`);
    console.error('可以手动指定：--docs <.../share/cmake-4.4>');
    process.exitCode = 2;
    return;
  }

  const { variables, problems, fileCount, dir } = loadVariableDocs(home);
  const expanded = instantiateLangTemplates(variables);
  const usable = expanded.filter(isUsable).map(enrich);

  const byName = new Map();
  for (const v of usable) if (!byName.has(v.name)) byName.set(v.name, v);
  const list = [...byName.values()].sort(
    (a, b) => Number(b.hot) - Number(a.hot) || a.name.localeCompare(b.name)
  );

  const skippedTemplate = variables.filter((v) => v.template).length;
  const instantiated = expanded.length - (variables.length - skippedTemplate);
  const missingSummary = expanded.filter((v) => isUsable(v) && !v.summary).length;
  const typed = list.filter((v) => v.type).length;

  const meta = {
    generatedAt: new Date().toISOString(),
    cmake: { version: cmake.version, exe: cmake.exe, docs: home },
    counts: {
      files: fileCount,
      usable: list.length,
      skippedTemplate,
      instantiated,
      missingSummary,
      typed,
      hot: list.filter((v) => v.hot).length,
    },
    sourceDir: dir,
  };

  const out = path.resolve(typeof args.out === 'string' ? args.out : path.join(DIST, 'variables.json'));
  writeJson(out, { meta, variables: list });
  writeReport(path.join(path.dirname(out), 'report.md'), meta, list, problems);

  if (typeof args.prototype === 'string') {
    const proto = path.resolve(args.prototype);
    writePrototypeData(proto, list);
    console.log('prototype data: ' + proto);
  }

  console.log(`cmake ${cmake.version}  docs=${home}`);
  console.log(`文档 ${fileCount} 个 → 可用 ${list.length} 条（模板 ${skippedTemplate} 个，其中实例化 ${instantiated} 条，无说明 ${missingSummary}）`);
  console.log(`带类型 ${typed}/${list.length}，常用 ${meta.counts.hot} 条`);
  console.log('输出: ' + out);
}

function writeReport(file, meta, list, problems) {
  const samples = list.filter((v) => v.hot).slice(0, 8);
  const lines = [
    '# CMake 变量目录生成报告',
    '',
    `- 生成时间：${meta.generatedAt}`,
    `- CMake 版本：${meta.cmake.version}`,
    `- 文档目录：\`${meta.cmake.docs}\``,
    '',
    '## 统计',
    '',
    '| 指标 | 数值 |',
    '|---|---|',
    `| 文档文件 | ${meta.counts.files} |`,
    `| 可用变量 | ${meta.counts.usable} |`,
    `| 跳过模板名（含 <>） | ${meta.counts.skippedTemplate} |`,
    `| 其中 CMAKE_<LANG>_* 实例化（C/C++） | ${meta.counts.instantiated} |`,
    `| 无说明 | ${meta.counts.missingSummary} |`,
    `| 有 cache 类型 | ${meta.counts.typed} |`,
    `| 常用变量 | ${meta.counts.hot} |`,
    '',
    '## 常用变量抽样',
    '',
    '| 变量 | 类型 | 说明 |',
    '|---|---|---|',
    ...samples.map((v) => `| \`${v.name}\` | ${v.type || '—'} | ${escapePipe(v.summary)} |`),
    '',
    '## 解析告警',
    '',
  ];
  if (problems.length) {
    for (const p of problems.slice(0, 20)) lines.push(`- ${p.file}: ${p.reason}`);
    if (problems.length > 20) lines.push(`- …共 ${problems.length} 条`);
  } else {
    lines.push('- 无');
  }
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

function writePrototypeData(file, list) {
  const slim = list.map((v) => ({
    name: v.name,
    type: v.type,
    desc: v.summary,
    values: v.values,
    hot: v.hot,
    preferField: v.preferField,
  }));
  ensureDir(path.dirname(file));
  const body =
    '/* 由 tools/var-catalog 自动生成（node index.mjs build --prototype …），请勿手改 */\n' +
    'window.CMAKE_VARIABLES = ' +
    JSON.stringify(slim) +
    ';\n';
  fs.writeFileSync(file, body, 'utf8');
}

function cmdProject(args) {
  const root = path.resolve(typeof args.dir === 'string' ? args.dir : process.cwd());
  const depth = Number(args.depth) || 3;
  const data = collectProject(root, depth);
  const out = path.resolve(typeof args.out === 'string' ? args.out : path.join(DIST, 'project-vars.json'));
  writeJson(out, { meta: { generatedAt: new Date().toISOString(), root }, ...data });
  console.log(`工程: ${root}`);
  console.log(`源文件 ${data.sources.length}，CMakeCache ${data.cacheFiles.length}`);
  console.log(`CMakeLists 自定义变量 ${data.custom.length}，cache 条目 ${data.cache.length}`);
  console.log('输出: ' + out);
}

async function cmdServe(args) {
  const dataFile = path.resolve(typeof args.data === 'string' ? args.data : path.join(DIST, 'variables.json'));
  if (!fs.existsSync(dataFile)) {
    console.error('缺少数据文件：' + dataFile + '\n先运行：node index.mjs build');
    process.exitCode = 2;
    return;
  }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  let catalog = data.variables || [];

  const projFile = path.resolve(
    typeof args.project === 'string' ? args.project : path.join(DIST, 'project-vars.json')
  );
  let merged = 0;
  if (fs.existsSync(projFile)) {
    const project = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    const before = catalog.length;
    catalog = mergeProject(catalog, project);
    merged = catalog.length - before;
  }

  const basePort = Number(args.port) || 4848;
  for (let port = basePort; port < basePort + 10; port++) {
    const { server, started } = startServer({
      catalog,
      meta: data.meta,
      port,
      host: '127.0.0.1',
    });
    try {
      const addr = await started;
      console.log(`变量目录服务已启动： http://${addr.address}:${addr.port}`);
      console.log(`数据 ${catalog.length} 条${merged ? `（含项目变量 ${merged} 条）` : ''}`);
      console.log('Ctrl+C 退出');
      const shutdown = () => server.close(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  console.error('端口被占用，试试 --port 另一个端口');
  process.exitCode = 2;
}

function cmdSelftest() {
  const cases = [
    {
      name: 'CMAKE_BUILD_TYPE',
      text: [
        'CMAKE_BUILD_TYPE',
        '----------------',
        '',
        'Specifies the build type on single-configuration generators (e.g.',
        ':ref:`Makefile Generators` or :generator:`Ninja`).  Typical values include',
        '``Debug``, ``Release``, ``RelWithDebInfo`` and ``MinSizeRel``, but custom',
        'build types can also be defined.',
        '',
        'See :manual:`cmake-compile-features(7)` for more.',
      ].join('\n'),
      expect: (r) => r.summary.includes('Makefile Generators') && !r.summary.includes(':ref:') && r.values.length === 4,
    },
    {
      name: 'CMAKE_VERBOSE_MAKEFILE',
      text: [
        'CMAKE_VERBOSE_MAKEFILE',
        '----------------------',
        '',
        '.. versionadded:: 3.1',
        '',
        'A Boolean switch which causes additional detail in the build output.',
      ].join('\n'),
      expect: (r) => r.since === '3.1' && r.summary.startsWith('A Boolean switch'),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const r = parseVariableDoc(c.name, c.text);
    const ok = r.name === c.name && c.expect(r);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  → ${r.summary.slice(0, 70)}…`);
    if (!ok) failed++;
  }

  console.log(`\n${cases.length - failed}/${cases.length} 通过`);

  // 项目变量：CMakeCache 解析 + 合并
  const cache = parseCMakeCache('// help text\nMY_CACHE_VAR:STRING=abc\n');
  const merged = mergeProject([], { cache, custom: [{ name: 'MY_CACHE_VAR' }] });
  const okCache = cache.length === 1 && cache[0].type === 'STRING' && cache[0].help === 'help text';
  const okMerge =
    merged.length === 1 &&
    merged[0].sources.includes('CMakeCache') &&
    merged[0].sources.includes('CMakeLists');
  console.log(`${okCache ? 'PASS' : 'FAIL'}  parseCMakeCache`);
  console.log(`${okMerge ? 'PASS' : 'FAIL'}  mergeProject  → ${JSON.stringify(merged[0] && merged[0].sources)}`);
  if (!okCache || !okMerge) failed++;

  if (failed) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'build';

try {
  switch (cmd) {
    case 'build':
      cmdBuild(args);
      break;
    case 'project':
      cmdProject(args);
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case 'selftest':
      cmdSelftest();
      break;
    case 'search': {
      const data = JSON.parse(fs.readFileSync(path.join(DIST, 'variables.json'), 'utf8'));
      const q = args._[1] || '';
      for (const v of searchVariables(data.variables, q, 10)) {
        console.log(`${v.name}${v.type ? ` [${v.type}]` : ''}  ${v.summary}`);
      }
      break;
    }
    default:
      console.log('用法: node index.mjs build|project|serve|selftest|search');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
