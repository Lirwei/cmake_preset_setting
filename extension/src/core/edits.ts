import * as jsonc from 'jsonc-parser';

export interface Op {
  /** JSON 路径，例如 ['configurePresets', 0, 'binaryDir'] */
  path: (string | number)[];
  /** 新值；undefined 表示删除该键/元素 */
  value?: unknown;
  /** 删除标记（postMessage 里无法可靠传 undefined） */
  remove?: boolean;
}

export interface Formatting {
  insertSpaces: boolean;
  tabSize: number;
  eol?: '\n' | '\r\n';
}

export interface Replacement {
  offset: number;
  length: number;
  text: string;
}

/**
 * 依次应用 JSON 编辑，返回“原文 → 新文”的最小替换区间。
 * 一次用户操作 = 一次 WorkspaceEdit = 一步撤销。
 */
export function computeReplacement(text: string, ops: Op[], formatting: Formatting): Replacement | null {
  let next = text;
  for (const op of ops) {
    const value = op.remove ? undefined : op.value;
    const edits = jsonc.modify(next, op.path, value, { formattingOptions: formatting });
    next = jsonc.applyEdits(next, edits);
  }
  if (next === text) return null;
  return minimalReplace(text, next);
}

/** 求两个字符串的最小差异区间（公共前缀/后缀之外的部分）。 */
export function minimalReplace(oldText: string, newText: string): Replacement {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;

  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { offset: start, length: endOld - start, text: newText.slice(start, endNew) };
}

/** 从文件内容猜缩进，避免把 Tab 文件改成空格。 */
export function detectFormatting(text: string, eol: '\n' | '\r\n' = '\n'): Formatting {
  const m = /\r?\n([ \t]+)\S/.exec(text);
  if (m) {
    const indent = m[1];
    if (indent.includes('\t')) {
      return { insertSpaces: false, tabSize: indent.split('\t').length, eol };
    }
    return { insertSpaces: true, tabSize: Math.min(indent.length, 8), eol };
  }
  return { insertSpaces: true, tabSize: 2, eol };
}

/** 解析并返回根对象的浅层类型信息，供扩展侧做合法性检查。 */
export function parsePresets(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
