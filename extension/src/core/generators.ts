import { FALLBACK_GENERATORS } from './catalog';

/** 从 `cmake --help` 的 Generators 段落里取生成器名字。 */
export function parseGenerators(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Generators');
  if (start === -1) return FALLBACK_GENERATORS;

  const generators: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (generators.length > 0) break;
      continue;
    }
    const match = /^\s*\*\s*(.+?)\s*=/.exec(line);
    if (match) generators.push(match[1].trim());
    else if (generators.length > 0) break;
  }
  return generators.length > 0 ? generators : FALLBACK_GENERATORS;
}
