import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeReplacement, minimalReplace, detectFormatting } = require('../out/core/edits.js');
const { diffModel } = require('../out/core/diff.js');
const { parseGenerators } = require('../out/core/generators.js');

const TAB_FORMAT = { insertSpaces: false, tabSize: 1 };

function apply(text, ops, formatting = TAB_FORMAT) {
  const r = computeReplacement(text, ops, formatting);
  if (!r) return text;
  return text.slice(0, r.offset) + r.text + text.slice(r.offset + r.length);
}

test('修改字段：保留 Tab 缩进与其它内容', () => {
  const text = JSON.stringify(
    { version: 7, configurePresets: [{ name: 'a', binaryDir: 'old' }, { name: 'b' }] },
    null,
    '\t'
  );
  const next = apply(text, [{ path: ['configurePresets', 0, 'binaryDir'], value: '${sourceDir}/build' }]);
  const parsed = JSON.parse(next);
  assert.equal(parsed.configurePresets[0].binaryDir, '${sourceDir}/build');
  assert.equal(parsed.configurePresets[0].name, 'a');
  assert.match(next, /\n\t+"name": "a"/, 'Tab 缩进应保留');
  assert.doesNotMatch(next, /\n {2,}"name"/, '不应被改成空格缩进');
});

test('删除字段', () => {
  const text = JSON.stringify({ version: 7, name: 'x' }, null, 2);
  const next = apply(text, [{ path: ['name'], remove: true }], { insertSpaces: true, tabSize: 2 });
  assert.equal(JSON.parse(next).name, undefined);
  assert.equal(JSON.parse(next).version, 7);
});

test('数组末尾追加预设', () => {
  const text = JSON.stringify({ version: 7, configurePresets: [{ name: 'a' }] }, null, 2);
  const next = apply(text, [{ path: ['configurePresets', 1], value: { name: 'b' } }], {
    insertSpaces: true,
    tabSize: 2,
  });
  const parsed = JSON.parse(next);
  assert.equal(parsed.configurePresets.length, 2);
  assert.equal(parsed.configurePresets[1].name, 'b');
});

test('删除数组元素', () => {
  const text = JSON.stringify({ version: 7, configurePresets: [{ name: 'a' }, { name: 'b' }] }, null, 2);
  const next = apply(text, [{ path: ['configurePresets', 0], remove: true }], { insertSpaces: true, tabSize: 2 });
  const parsed = JSON.parse(next);
  assert.equal(parsed.configurePresets.length, 1);
  assert.equal(parsed.configurePresets[0].name, 'b');
});

test('删除 cacheVariables 里的单个键', () => {
  const text = JSON.stringify(
    { version: 7, configurePresets: [{ name: 'a', cacheVariables: { A: '1', B: '2' } }] },
    null,
    2
  );
  const next = apply(text, [{ path: ['configurePresets', 0, 'cacheVariables', 'A'], remove: true }], {
    insertSpaces: true,
    tabSize: 2,
  });
  assert.deepEqual(JSON.parse(next).configurePresets[0].cacheVariables, { B: '2' });
});

test('删除最后一个变量时移除整个 cacheVariables', () => {
  const text = JSON.stringify(
    { version: 7, configurePresets: [{ name: 'a', cacheVariables: { A: '1' } }] },
    null,
    2
  );
  const next = apply(text, [{ path: ['configurePresets', 0, 'cacheVariables'], remove: true }], {
    insertSpaces: true,
    tabSize: 2,
  });
  assert.equal(JSON.parse(next).configurePresets[0].cacheVariables, undefined);
});

test('批量 op 合并成一次替换', () => {
  const text = JSON.stringify({ version: 7, configurePresets: [{ name: 'a', generator: 'Ninja' }] }, null, 2);
  const next = apply(text, [
    { path: ['configurePresets', 0, 'generator'], value: 'Unix Makefiles' },
    { path: ['configurePresets', 0, 'binaryDir'], value: '${sourceDir}/linux_build' },
  ]);
  const preset = JSON.parse(next).configurePresets[0];
  assert.equal(preset.generator, 'Unix Makefiles');
  assert.equal(preset.binaryDir, '${sourceDir}/linux_build');
  assert.equal(preset.name, 'a');
});

test('空 op 不产生修改', () => {
  const text = '{\n  "version": 7\n}';
  assert.equal(computeReplacement(text, [], { insertSpaces: true, tabSize: 2 }), null);
});

test('缩进探测', () => {
  assert.equal(detectFormatting('{\n\t"a": 1\n}').insertSpaces, false);
  const spaces = detectFormatting('{\n    "a": 1\n}');
  assert.equal(spaces.insertSpaces, true);
  assert.equal(spaces.tabSize, 4);
});

test('最小替换区间', () => {
  const r = minimalReplace('abcXYZdef', 'abc123def');
  assert.deepEqual(r, { offset: 3, length: 3, text: '123' });
});

test('diff：修改 / 新增 / 删除', () => {
  const ops = diffModel(
    { a: 1, b: { c: 2 }, gone: true },
    { a: 1, b: { c: 3 }, added: 'x' }
  );
  const setC = ops.find((o) => o.path.join('.') === 'b.c');
  assert.equal(setC.value, 3);
  assert.ok(ops.some((o) => o.path.join('.') === 'added' && o.value === 'x'));
  assert.ok(ops.some((o) => o.path.join('.') === 'gone' && o.remove === true));
});

test('diff：数组长度不变时逐项比较', () => {
  const ops = diffModel([{ n: 1 }], [{ n: 2 }]);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].path, [0, 'n']);
});

test('diff：数组长度变化时整段替换', () => {
  const ops = diffModel([{ n: 1 }], [{ n: 1 }, { n: 2 }]);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].path, []);
  assert.equal(ops[0].value.length, 2);
});

test('diff：无变化返回空', () => {
  assert.deepEqual(diffModel({ a: [1, 2] }, { a: [1, 2] }), []);
});

test('解析 cmake --help 的生成器列表', () => {
  const help = [
    'Usage: cmake [options] <path-to-source>',
    '',
    'Generators',
    '',
    '* Visual Studio 17 2022        = Generates Visual Studio 2022 project files.',
    '* Ninja                        = Generates Ninja files.',
    '* Unix Makefiles               = Generates Unix makefiles.',
    '',
  ].join('\n');
  assert.deepEqual(parseGenerators(help), ['Visual Studio 17 2022', 'Ninja', 'Unix Makefiles']);
});

test('解析不到时回退到内置列表', () => {
  assert.ok(parseGenerators('nothing here').length > 0);
});
