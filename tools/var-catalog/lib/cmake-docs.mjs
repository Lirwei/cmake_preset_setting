import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseVariableDoc } from './rst.mjs';

/** 找到可执行的 cmake（优先用 --cmake 传入的路径）。 */
export function findCMake(override) {
  const candidates = [];
  if (override) candidates.push(override);
  if (process.env.CMAKE) candidates.push(process.env.CMAKE);

  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['cmake'], {
      encoding: 'utf8',
    });
    out.split(/\r?\n/).filter(Boolean).forEach((p) => candidates.push(p.trim()));
  } catch {
    /* not on PATH */
  }
  candidates.push('cmake');

  for (const c of candidates) {
    try {
      const v = execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 });
      const line = v.split(/\r?\n/)[0].trim();
      const m = /version\s+([0-9][\w.\-+]*)/i.exec(line);
      if (m) return { exe: c, version: m[1] };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 候选 share 目录（Windows 安装器 / 包管理器 / Homebrew 各有习惯）。 */
function shareRoots(exe) {
  const roots = [];
  if (exe) {
    const exeDir = path.dirname(path.resolve(exe));
    roots.push(path.resolve(exeDir, '..'));
    roots.push(exeDir);
  }
  if (process.platform === 'win32') {
    roots.push('C:\\Program Files\\CMake', 'C:\\Program Files (x86)\\CMake');
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'CMake'));
  } else {
    roots.push('/usr', '/usr/local', '/opt/homebrew', '/opt/local');
  }
  return [...new Set(roots)];
}

/** 找带 Help/variable 的 cmake 数据目录，优先匹配当前 cmake 主版本。 */
export function findDocsHome(exe, version) {
  const majorMinor = version ? version.split('.').slice(0, 2).join('.') : null;
  const found = [];

  for (const root of shareRoots(exe)) {
    for (const share of new Set([path.join(root, 'share'), root])) {
      let entries = [];
      try {
        entries = fs.readdirSync(share, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !/^cmake-/.test(e.name)) continue;
        const home = path.join(share, e.name);
        if (fs.existsSync(path.join(home, 'Help', 'variable'))) found.push(home);
      }
    }
  }

  if (majorMinor) {
    const exact = found.find((p) => p.endsWith('cmake-' + majorMinor));
    if (exact) return exact;
  }
  return found[0] || null;
}

/** 解析一个数据目录下的全部变量文档。 */
export function loadVariableDocs(home) {
  const dir = path.join(home, 'Help', 'variable');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.rst'));

  const variables = [];
  const problems = [];
  for (const file of files) {
    const fallback = file.replace(/\.rst$/, '');
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const text = prepareText(raw, dir);
      const parsed = parseVariableDoc(fallback, text);
      if (!parsed.summary) problems.push({ file, reason: 'empty-summary' });
      variables.push(parsed);
    } catch (err) {
      problems.push({ file, reason: String(err.message || err) });
    }
  }
  return { variables, problems, fileCount: files.length, dir };
}

/**
 * CMake 的变量文档里有两类间接引用：
 *   .. |FIND_XXX| replace:: :command:`find_program`   —— 替换占位
 *   .. include:: include/CMAKE_FIND_ROOT_PATH_MODE_XXX.rst —— 引用公共片段
 * 不展开它们，正文就会只剩一行 include 指令（说明为空）。
 */
export function prepareText(text, baseDir, depth = 0) {
  let out = String(text);

  // 1. 先展开 include：父文件里定义的占位替换要能作用到子片段上
  if (depth < 4) {
    out = out.replace(/^\.\. include::[ \t]*(.+)$/gm, (m, rel) => {
      const target = path.resolve(baseDir, rel.trim());
      const inside = path.relative(baseDir, target);
      if (inside.startsWith('..') || path.isAbsolute(inside)) return '';
      try {
        return prepareText(fs.readFileSync(target, 'utf8'), baseDir, depth + 1);
      } catch {
        return '';
      }
    });
  }

  // 2. 收集并移除替换定义，然后把 |NAME| 展开
  const subs = new Map();
  out = out.replace(/^\.\. \|([^|]+)\| replace::[ \t]*(.*)$/gm, (m, key, value) => {
    subs.set(key.trim(), value.trim());
    return '';
  });
  for (const [key, value] of subs) {
    out = out.split('|' + key + '|').join(value);
  }

  return out;
}
