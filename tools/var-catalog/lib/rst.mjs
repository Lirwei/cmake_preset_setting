/**
 * CMake 变量文档（reStructuredText）解析器。
 *
 * CMake 的 Help/variable/*.rst 有两种形态：
 *   1. 标题式（99%）：文件第一行是变量名，第二行是连字符下划线，之后是正文；
 *   2. 指令式（如 <PackageName>_ROOT.rst）：正文里用 `.. variable:: NAME` 分段。
 *
 * 我们只取「一句话说明」和少量元信息，不追求完整 RST 语义。
 */

const DIRECTIVE_RE = /^\.\.\s+([a-zA-Z][\w-]*)::\s*(.*)$/;

/** 把一段 RST 文本压成纯文本（去掉角色标记、内联代码、加粗等）。 */
export function cleanRst(text) {
  return String(text)
    // :ref:`显示文本 <目标>` -> 显示文本
    .replace(/:ref:`([^`]*?)\s*<[^`]*>`/g, '$1')
    // :role:`内容` -> 内容
    .replace(/:[\w-]+:`([^`]*)`/g, '$1')
    // ``code`` -> code
    .replace(/``([^`]*)``/g, '$1')
    // **bold** -> bold
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // 行内转义 "\ "
    .replace(/\\\s/g, ' ')
    // 软换行
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取第一句话（用于拼接第二段时控制长度）。 */
function firstSentence(text, maxLen = 160) {
  const m = /^(.+?[.!?。！？])(\s|$)/.exec(text);
  const s = m ? m[1] : text;
  return s.length > maxLen ? s.slice(0, maxLen).replace(/[,，;；:：]$/, '') + '…' : s;
}

/**
 * 从原始文档里猜可能的取值（只在正文明确写了 typical/possible values 时才猜）。
 * 例如 "Typical values include ``Debug``, ``Release`` ..."。
 */
export function guessValues(rawText) {
  const sentences = rawText.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (!/(typical|possible|valid|supported|one of|accepted)/i.test(s)) continue;
    const tokens = [...s.matchAll(/``([^`]{1,48})``/g)]
      .map((m) => m[1].trim())
      .filter((v) => v && !v.includes('\n') && v.length <= 48);
    if (tokens.length >= 2 && tokens.length <= 8) return tokens;
  }
  return [];
}

/**
 * 解析单个 .rst 文件。
 * @param {string} fallbackName 文件名推断的变量名
 * @param {string} text 文件内容
 * @returns {{name:string, summary:string, since:string|null, deprecated:string|null, values:string[], template:boolean}}
 */
export function parseVariableDoc(fallbackName, text) {
  const lines = text.split(/\r?\n/);

  // 标题：第一行是名字，第二行全是 - 或 =
  let start = 0;
  const first = (lines[0] || '').trim();
  if (first && /^[-=]{3,}\s*$/.test(lines[1] || '')) {
    start = 2;
  }

  // 去掉指令块（.. versionadded:: 之类），同时记录元信息
  const bodyLines = [];
  let since = null;
  let deprecated = null;
  let skipDirective = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!skipDirective) {
      const m = DIRECTIVE_RE.exec(line);
      if (m && !/^\s/.test(line)) {
        const [, kind, value] = m;
        const v = (value || '').trim();
        if (kind === 'versionadded' && !since) since = v;
        if (kind === 'versionchanged' && !since) since = v;
        if (kind === 'deprecated') deprecated = v || 'yes';
        skipDirective = true;
        continue;
      }
    } else {
      // 指令块的缩进正文，跳过；遇到顶格的非空行结束
      if (trimmed === '' || /^\s/.test(line)) continue;
      skipDirective = false;
      // 落到这里说明这行是正文，交给下面的逻辑处理
    }

    if (trimmed === '') {
      bodyLines.push('');
      continue;
    }
    if (/^\.\.\s+/.test(line) && !/^\s/.test(line)) {
      // 其它指令（note/warning/variable-divider 等），跳过其后的缩进块
      skipDirective = true;
      continue;
    }
    bodyLines.push(trimmed);
  }

  // 切段
  const paragraphs = [];
  let cur = [];
  for (const line of bodyLines) {
    if (line === '') {
      if (cur.length) {
        paragraphs.push(cur.join(' '));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) paragraphs.push(cur.join(' '));

  let summary = paragraphs[0] ? cleanRst(paragraphs[0]) : '';
  if (summary.length < 50 && paragraphs[1]) {
    const extra = firstSentence(cleanRst(paragraphs[1]), 140);
    if (extra) summary = (summary ? summary + ' ' : '') + extra;
  }
  if (!summary) {
    // 有些旧变量（如 CTEST_CVS_CHECKOUT）把正文写在 .. deprecated:: 的缩进块里
    const m = /^\.\.\s+deprecated::[^\n]*\r?\n\r?\n((?:[ \t]+[^\n]*\r?\n?)+)/m.exec(text);
    if (m) summary = cleanRst(m[1].split(/\r?\n/).map((l) => l.trim()).join(' '));
  }
  if (summary.length > 260) summary = firstSentence(summary, 250);

  return {
    name: first || fallbackName,
    summary,
    since: since || null,
    deprecated: deprecated || null,
    values: guessValues(text),
    template: /[<>]/.test(first || fallbackName),
  };
}
