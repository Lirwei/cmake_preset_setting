import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'debug', 'release',
  'CMakeFiles', '.vs', '.vscode', 'out', 'bin', 'obj',
]);

/** 解析 CMakeCache.txt：//help 注释 + NAME:TYPE=VALUE。 */
export function parseCMakeCache(text) {
  const entries = [];
  let help = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('//')) {
      help = line.slice(2).trim();
      continue;
    }
    if (!line.trim() || line.startsWith('#') || line.startsWith('//')) {
      help = '';
      continue;
    }
    const m = /^([A-Za-z0-9_.+\-/]+):([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m) {
      entries.push({ name: m[1], type: m[2], value: m[3], help });
      help = '';
    } else if (line.includes(':') && line.includes('=')) {
      help = '';
    }
  }
  return entries;
}

const RE_PATTERNS = [
  /\bset\s*\(\s*([A-Za-z_]\w*)\s[^)]*?\bCACHE\b/g,
  /\boption\s*\(\s*([A-Za-z_]\w*)/g,
  /\bcmake_dependent_option\s*\(\s*([A-Za-z_]\w*)/g,
];

/** 从 CMake 脚本里扫 set(... CACHE ...) / option() 定义的变量名。 */
export function scanCMakeSource(text) {
  const names = new Set();
  const stripped = text.replace(/#\[\[[\s\S]*?\]\]/g, '').replace(/#[^\n]*/g, '');
  for (const re of RE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) names.add(m[1]);
  }
  return [...names];
}

function walk(root, maxDepth, visit) {
  const stack = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      seen++;
      if (e.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        visit(full, e.name);
      }
    }
  }
}

/**
 * 扫描一个工程：CMakeLists / *.cmake 里的自定义变量 + 已有构建目录的 CMakeCache.txt。
 * @returns {{sources: string[], cacheFiles: string[], cache: object[], custom: object[]}}
 */
export function collectProject(root, maxDepth = 3) {
  const sourceFiles = [];
  const cacheFiles = [];
  const custom = new Map();
  const cache = new Map();

  walk(root, maxDepth, (full, name) => {
    if (name === 'CMakeCache.txt') {
      cacheFiles.push(full);
      return;
    }
    if (name === 'CMakeLists.txt' || name.endsWith('.cmake')) sourceFiles.push(full);
  });

  for (const file of sourceFiles) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const n of scanCMakeSource(text)) {
      if (!custom.has(n)) custom.set(n, { name: n, source: path.relative(root, file) });
    }
  }

  for (const file of cacheFiles) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const e of parseCMakeCache(text)) {
      if (e.type === 'INTERNAL' || e.type === 'STATIC') continue;
      if (!cache.has(e.name)) {
        cache.set(e.name, { ...e, cacheFile: path.relative(root, file) });
      }
    }
  }

  return {
    root,
    sources: sourceFiles.map((f) => path.relative(root, f)),
    cacheFiles: cacheFiles.map((f) => path.relative(root, f)),
    cache: [...cache.values()],
    custom: [...custom.values()],
  };
}

/**
 * 把项目扫描结果并进变量目录。
 * 目录里已有的变量补上「项目来源」标记；没有的（自定义变量/第三方模块变量）补成新条目。
 */
export function mergeProject(catalog, project) {
  const byName = new Map(catalog.map((v) => [v.name, { ...v, sources: [] }]));

  for (const c of project.cache) {
    const hit = byName.get(c.name);
    if (hit) {
      hit.sources.push('CMakeCache');
      if (c.help && !hit.summary) hit.summary = c.help;
      if (!hit.type && c.type && c.type !== 'UNINITIALIZED') hit.type = c.type;
      if (c.value !== undefined && c.value !== '') hit.currentValue = c.value;
    } else {
      byName.set(c.name, {
        name: c.name,
        summary: c.help || '来自 CMakeCache.txt',
        type: c.type === 'UNINITIALIZED' ? null : c.type,
        values: [],
        since: null,
        deprecated: null,
        hot: false,
        preferField: null,
        sources: ['CMakeCache'],
        currentValue: c.value,
      });
    }
  }

  for (const c of project.custom) {
    const hit = byName.get(c.name);
    if (hit) {
      if (!hit.sources.includes('CMakeLists')) hit.sources.push('CMakeLists');
      if (!hit.summary || hit.summary.startsWith('来自')) hit.summary = '项目自定义变量';
    } else {
      byName.set(c.name, {
        name: c.name,
        summary: '项目自定义变量',
        type: null,
        values: [],
        since: null,
        deprecated: null,
        hot: false,
        preferField: null,
        sources: ['CMakeLists'],
      });
    }
  }

  return [...byName.values()];
}
