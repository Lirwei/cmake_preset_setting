/**
 * CMakeCache.txt 的极简读取：只要 `NAME:TYPE=VALUE`。
 * 放在 core 里是为了能脱离 vscode 单测。
 */
export function readCacheEntry(text: string, name: string): string | undefined {
  const match = new RegExp('^' + name + ':[A-Z]+=(.*)$', 'm').exec(text);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}
