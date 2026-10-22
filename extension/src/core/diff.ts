export interface Op {
  path: (string | number)[];
  value?: unknown;
  remove?: boolean;
}

/**
 * 对比两份 JSON 模型，产出最小 op 列表。
 * - 对象：逐个 key 比较，新增/删除/修改分别产出
 * - 数组：长度相同则逐项递归；长度不同则整段替换（增删预设由调用方显式产生 op）
 */
export function diffModel(before: unknown, after: unknown, base: (string | number)[] = []): Op[] {
  if (before === after) return [];

  const beforeIsArray = Array.isArray(before);
  const afterIsArray = Array.isArray(after);
  if (beforeIsArray !== afterIsArray) return [{ path: base, value: clone(after) }];

  if (afterIsArray && beforeIsArray) {
    const b = before as unknown[];
    const a = after as unknown[];
    if (b.length !== a.length) return [{ path: base, value: clone(a) }];
    const ops: Op[] = [];
    for (let i = 0; i < a.length; i++) ops.push(...diffModel(b[i], a[i], base.concat(i)));
    return ops;
  }

  const beforeIsObject = before !== null && typeof before === 'object';
  const afterIsObject = after !== null && typeof after === 'object';
  if (!beforeIsObject || !afterIsObject) {
    return [{ path: base, value: clone(after) }];
  }

  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const ops: Op[] = [];

  for (const key of Object.keys(a)) {
    if (!(key in b)) ops.push({ path: base.concat(key), value: clone(a[key]) });
    else ops.push(...diffModel(b[key], a[key], base.concat(key)));
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) ops.push({ path: base.concat(key), remove: true });
  }
  return ops;
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
