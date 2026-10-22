import { FALLBACK_GENERATORS } from './catalog';

/**
 * 从 `cmake --help` 的 Generators 段落里取生成器名字。
 *
 * 这段输出有几个坑：
 *   - 默认生成器才有 `*` 前缀，其它行以两个空格缩进（旧实现只认 `*`，会漏掉几乎所有生成器）；
 *   - 名字太长时 `=` 会折到下一行，条目名在上一行；
 *   - 描述会跨多行，`(deprecated)` 经常出现在续行里；
 *   - 段落结束后可能跟着 `Options` 之类的顶格标题。
 */
export function parseGenerators(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Generators');
  if (start === -1) return FALLBACK_GENERATORS;

  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*The following generators/.test(line)) continue;

    const indented = /^( *)\S/.exec(line);
    const indent = indented ? indented[1].length : -1;

    // 顶格且不是 `*` 开头的行 = 段落结束（例如后面的 Options / Commands）
    if (indent === 0 && !line.startsWith('*')) break;

    const isEntry = line.startsWith('*') || (indent >= 1 && indent <= 3);
    if (isEntry) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }

  const names: string[] = [];
  for (const block of blocks) {
    const head = block[0];
    const inline = /^\s*\*?\s*(.+?)\s*=\s*(.*)$/.exec(head);
    let name: string;
    let description: string;

    if (inline) {
      name = inline[1].trim();
      description = [inline[2], ...block.slice(1)].join(' ');
    } else {
      name = head.replace(/^\s*\*?\s*/, '').trim();
      description = block
        .slice(1)
        .map((line) => line.replace(/^\s*=\s*/, ''))
        .join(' ');
    }

    if (!name) continue;
    if (/deprecated/i.test(description)) continue;
    names.push(name);
  }

  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : FALLBACK_GENERATORS;
}
