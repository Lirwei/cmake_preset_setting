/**
 * webview 端到端测试：无头浏览器加载 media/editor.html，
 * 用假的 acquireVsCodeApi 捕获消息，模拟真实操作，
 * 再把产生的 ops 交给扩展侧的 computeReplacement，验证真的落到 JSON 文本上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { computeReplacement } = require('../out/core/edits.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.dirname(__dirname);
const EDITOR = path.join(EXT_ROOT, 'media', 'editor.html');
const DEMO = path.resolve(EXT_ROOT, '..', 'demo', 'CMakePresets.json');
const DEMO_TEXT = fs.readFileSync(DEMO, 'utf8');

function findBrowser() {
  if (process.platform !== 'win32') return ['msedge', 'google-chrome', 'chromium'].find(Boolean);
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((p) => fs.existsSync(p));
}

const FAKE_API = `<script>
window.__sent = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (m) { window.__sent.push(m); },
    getState: function () { return null; },
    setState: function () {}
  };
};
</script>`;

function pageScript(body, scenario_data) {
  return (
    '<script>\n' +
    'var DEMO_TEXT = ' + JSON.stringify(scenario_data ? JSON.stringify(scenario_data) : DEMO_TEXT) + ';\n' +
    'setTimeout(function () {\n' +
    '  window.dispatchEvent(new MessageEvent("message", { data: {\n' +
    '    type: "init", text: DEMO_TEXT, version: 1, isDirty: false, fileName: "CMakePresets.json",\n' +
    '    catalog: [{ name: "CMAKE_BUILD_TYPE", type: "STRING", desc: "build type", values: ["Debug"], hot: true }],\n' +
    '    generators: ["Visual Studio 17 2022", "Visual Studio 16 2019", "Unix Makefiles", "Ninja", "Green Hills MULTI"],\n' +
    '    generator_platforms: {\n' +
    '      "Visual Studio 17 2022": { platform_support: true, supported_platforms: ["x64", "Win32", "ARM64EC"] },\n' +
    '      "Visual Studio 16 2019": { platform_support: true, supported_platforms: ["Win32", "x64"] },\n' +
    '      "Ninja": { platform_support: false }, "Unix Makefiles": { platform_support: false },\n' +
    '      "Green Hills MULTI": { platform_support: true }\n' +
    '    },\n' +
    '    projectGenerators: ["Visual Studio 17 2022"],\n' +
    '    projectBuildDirs: [{ dir: "build", generator: "Visual Studio 17 2022" }]\n' +
    '  } }));\n' +
    '  setTimeout(function () {\n' +
    '    var out = { errors: [], sent: [] };\n' +
    '    try {\n' +
    body +
    '\n    } catch (e) { out.errors.push(String((e && e.message) || e)); }\n' +
    '    setTimeout(function () {\n' +
    '      out.sent = window.__sent || [];\n' +
    '      var d = document.createElement("div");\n' +
    '      d.id = "result";\n' +
    '      d.textContent = "RESULT " + JSON.stringify(out);\n' +
    '      document.body.appendChild(d);\n' +
    '    }, 700);\n' +
    '  }, 350);\n' +
    '}, 450);\n' +
    '</script>'
  );
}

function runScenario(body, t, scenario_data) {
  const browser = findBrowser();
  if (!browser || !fs.existsSync(EDITOR)) {
    t.skip('没有浏览器或未生成 media/editor.html');
    return null;
  }

  const temp = path.join(EXT_ROOT, 'media', '__webview-test.html');
  let html = fs.readFileSync(EDITOR, 'utf8');
  html = html.replace('<script>', FAKE_API + '<script>');
  html = html.replace('</body>', pageScript(body, scenario_data) + '</body>');
  fs.writeFileSync(temp, html, 'utf8');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-'));
  let dom = '';
  try {
    dom = execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profile,
        '--virtual-time-budget=6000',
        '--dump-dom',
        pathToFileURL(temp).href,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }
    );
  } finally {
    fs.rmSync(temp, { force: true });
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const match = /RESULT (\{[\s\S]*?\})<\/div>/.exec(dom);
  assert.ok(match, '页面没有输出测试结果');
  return JSON.parse(match[1]);
}

function applyOps(ops, initial_text = DEMO_TEXT) {
  const replacement = computeReplacement(initial_text, ops, { insertSpaces: false, tabSize: 1, eol: '\n' });
  assert.ok(replacement, 'ops 应产生文本修改');
  return (
    initial_text.slice(0, replacement.offset) +
    replacement.text +
    initial_text.slice(replacement.offset + replacement.length)
  );
}

test('webview：补全 → 回车 → 产生可应用的 ops', (t) => {
  const result = runScenario(
    [
      '      var el = document.querySelector("#form [data-field=\\"__cv-name\\"]");',
      '      el.value = "CMAKE_BUILD";',
      '      el.dispatchEvent(new Event("input", { bubbles: true }));',
      '      out.items = document.getElementById("suggest").querySelectorAll(".sg").length;',
      '      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));',
      '      out.value = el.value;',
      '      out.type = document.querySelector("#form [data-field=\\"__cv-type\\"]").value;',
    ].join('\n'),
    t
  );
  if (!result) return;

  assert.deepEqual(result.errors, [], 'webview 运行时错误');
  assert.ok(result.items >= 1, '应弹出补全候选');
  assert.equal(result.value, 'CMAKE_BUILD_TYPE');
  assert.equal(result.type, 'STRING', '类型应自动填充');

  assert.equal(result.sent[0].type, 'ready', '第一条消息应是 ready');
  const apply = result.sent.filter((m) => m.type === 'apply').pop();
  assert.ok(apply, '应发出 apply 消息');

  const parsed = JSON.parse(applyOps(apply.ops));
  const vars = parsed.configurePresets[0].cacheVariables || {};
  assert.ok(vars.CMAKE_BUILD_TYPE, '新变量应写入 JSON');
  assert.equal(vars.CMAKE_BUILD_TYPE.type, 'STRING');
  assert.equal(vars.CMAKE_TOOLCHAIN_FILE, undefined, '被改名的旧变量应移除');
  assert.equal(parsed.configurePresets.length, 2, '其它预设不应受影响');
});

test('webview：生成器标记「项目已用」，architecture 只对 VS 生成器显示', (t) => {
  const result = runScenario(
    [
      '      out.archBefore = !!document.querySelector("#form [data-field=\\"architecture\\"]");',
      '      out.hasProjectMark = Array.from(document.querySelectorAll("#form [data-field=\\"generator\\"] option"))',
      '        .some(function (o) { return o.textContent.indexOf("（项目已用）") >= 0; });',
      '      var item = document.querySelector(".tree-item[data-kind=\\"configure\\"][data-index=\\"1\\"]");',
      '      out.hasLinuxItem = !!item;',
      '      if (item) item.click();',
      '      out.archAfter = !!document.querySelector("#form [data-field=\\"architecture\\"]");',
      '      out.generatorValue = document.querySelector("#form [data-field=\\"generator\\"]").value;',
      '      out.issues = Array.from(document.querySelectorAll("#issues .issue")).map(function (n) { return n.textContent; });',
    ].join('\n'),
    t
  );
  if (!result) return;

  assert.deepEqual(result.errors, [], 'webview 运行时错误');
  assert.equal(result.archBefore, true, 'VS2022 应显示 architecture');
  assert.equal(result.hasProjectMark, true, '项目用过的生成器应标记');
  assert.equal(result.hasLinuxItem, true, '应能选中 linux 预设');
  assert.equal(result.generatorValue, 'Unix Makefiles');
  assert.equal(result.archAfter, false, '非 VS 生成器不应显示 architecture');
});

test('webview：删除缓存变量会真的写回文档', (t) => {
  const result = runScenario(
    [
      '      out.before = document.querySelectorAll("#form [data-field=\\"__cv-name\\"]").length;',
      '      var btn = document.querySelector("#form [data-field=\\"__cv-del\\"][data-row=\\"0\\"]");',
      '      out.hasButton = !!btn;',
      '      if (btn) btn.click();',
      '      out.after = document.querySelectorAll("#form [data-field=\\"__cv-name\\"]").length;',
    ].join('\n'),
    t
  );
  if (!result) return;

  assert.deepEqual(result.errors, [], 'webview 运行时错误');
  assert.equal(result.hasButton, true, '应找到删除按钮');
  assert.equal(result.before, 3, 'demo 第一个预设应有 3 个变量');
  assert.equal(result.after, 2, '界面应立即少一行');

  const apply = result.sent.filter((m) => m.type === 'apply').pop();
  assert.ok(apply, '删除必须发出 apply 消息（这正是之前的 bug）');
  const removeOp = apply.ops.find((op) => op.remove && op.path.join('.') === 'configurePresets.0.cacheVariables.CMAKE_TOOLCHAIN_FILE');
  assert.ok(removeOp, 'ops 应包含删除 CMAKE_TOOLCHAIN_FILE');

  const next = applyOps(apply.ops);
  const vars = JSON.parse(next).configurePresets[0].cacheVariables || {};
  assert.equal(vars.CMAKE_TOOLCHAIN_FILE, undefined, '文件里应删除');
  assert.ok(vars.CMAKE_POLICY_VERSION_MINIMUM, '其它变量保留');
  assert.ok(vars.LIBRARIES_DIR, '其它变量保留');
  assert.match(next, /\n\t+"version": 7/, '缩进不受影响');
});

test('webview：显示完整宿主生成器列表，保留未被本机列出的当前值', (t) => {
  const scenario_data = { version: 7, configurePresets: [{ name: 'custom', generator: 'Future IDE' }] };
  const result = runScenario(`
      out.options = Array.from(document.querySelectorAll('#form [data-field="generator"] option'))
        .map(function (option) { return { value: option.value, label: option.textContent }; });
      out.generator_value = document.querySelector('#form [data-field="generator"]').value;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.options.map((option) => option.value), [
    '', 'Visual Studio 17 2022', 'Visual Studio 16 2019', 'Unix Makefiles', 'Ninja', 'Green Hills MULTI', 'Future IDE',
  ]);
  assert.equal(result.generator_value, 'Future IDE');
  assert.match(result.options.at(-1).label, /当前 CMake 未列出/);
});

test('webview：architecture 候选来自能力数据，切换继承的 generator 会即时联动', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'child', inherits: 'vs_base' },
    { name: 'vs_base', hidden: true, generator: 'Visual Studio 16 2019', binaryDir: '${sourceDir}/build' },
    { name: 'ninja_base', hidden: true, generator: 'Ninja' },
  ] };
  const result = runScenario(`
      out.options_before = Array.from(document.querySelectorAll('#form [data-field="architecture"] option'))
        .map(function (option) { return option.value; });
      out.generator_placeholder = document.querySelector('#form [data-field="generator"] option').textContent;
      var inherits_select = document.querySelector('#form [data-field="inherits"]');
      inherits_select.value = 'ninja_base';
      inherits_select.dispatchEvent(new Event('input', { bubbles: true }));
      out.architecture_after = !!document.querySelector('#form [data-field="architecture"]');
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.options_before, ['', 'Win32', 'x64']);
  assert.match(result.generator_placeholder, /继承：Visual Studio 16 2019/);
  assert.equal(result.architecture_after, false);
});

test('webview：多重继承按第一个父预设优先，继承的架构参与兼容性校验', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'child', inherits: ['vs_base', 'ninja_base'] },
    { name: 'vs_base', hidden: true, generator: 'Visual Studio 16 2019', architecture: 'Win32', binaryDir: '${sourceDir}/build' },
    { name: 'ninja_base', hidden: true, generator: 'Ninja' },
  ] };
  const result = runScenario(`
      out.architecture_placeholder = document.querySelector('#form [data-field="architecture"] option').textContent;
      out.issues_before = document.getElementById('issues').textContent;
      var generator_select = document.querySelector('#form [data-field="generator"]');
      generator_select.value = 'Ninja';
      generator_select.dispatchEvent(new Event('input', { bubbles: true }));
      out.issues_after = document.getElementById('issues').textContent;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.match(result.architecture_placeholder, /继承：Win32/);
  assert.doesNotMatch(result.issues_before, /child」.*(?:缺少 generator|缺少 binaryDir|inherits 指向不存在)/);
  assert.match(result.issues_after, /child」的架构设置与 Ninja 不兼容/);
  assert.doesNotMatch(result.issues_after, /architecture 会被忽略/);
});

test('webview：切到 Ninja 不静默删除架构，清空后立即隐藏并写回删除 op', (t) => {
  const result = runScenario(`
      var generator_select = document.querySelector('#form [data-field="generator"]');
      generator_select.value = 'Ninja';
      generator_select.dispatchEvent(new Event('input', { bubbles: true }));
      var architecture_input = document.querySelector('#form [data-field="architecture"]');
      out.retained_architecture = architecture_input.value;
      out.issues_before = document.getElementById('issues').textContent;
      architecture_input.value = '';
      architecture_input.dispatchEvent(new Event('input', { bubbles: true }));
      out.architecture_after = !!document.querySelector('#form [data-field="architecture"]');
  `, t);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.retained_architecture, 'x64');
  assert.match(result.issues_before, /架构设置.*不兼容/);
  assert.equal(result.architecture_after, false);
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  const preset = JSON.parse(applyOps(apply_message.ops)).configurePresets[0];
  assert.equal(preset.generator, 'Ninja');
  assert.equal(preset.architecture, undefined);
});

test('webview：Ninja 的 external 架构合法，编辑后仍保留对象及 strategy', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'ninja', generator: 'Ninja', architecture: { value: 'x64', strategy: 'external' } },
  ] };
  const result = runScenario(`
      var architecture_input = document.querySelector('#form [data-field="architecture"]');
      out.architecture_before = architecture_input.value;
      out.issues_before = document.getElementById('issues').textContent;
      architecture_input.value = 'ARM64';
      architecture_input.dispatchEvent(new Event('input', { bubbles: true }));
      out.effective = document.getElementById('effective').textContent;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.architecture_before, 'x64');
  assert.doesNotMatch(result.issues_before, /架构设置.*不兼容/);
  assert.match(result.effective, /"strategy":"external"/);
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  const preset = JSON.parse(applyOps(apply_message.ops, JSON.stringify(scenario_data))).configurePresets[0];
  assert.deepEqual(preset.architecture, { value: 'ARM64', strategy: 'external' });
});

test('webview：覆盖继承的 external 架构时保留 strategy，支持无枚举的平台生成器', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'child', inherits: 'base' },
    { name: 'base', hidden: true, generator: 'Green Hills MULTI', architecture: { value: 'arm', strategy: 'external' },
      cacheVariables: { CMAKE_GENERATOR_PLATFORM: 'arm' } },
  ] };
  const result = runScenario(`
      var architecture_input = document.querySelector('#form [data-field="architecture"]');
      out.control_type = architecture_input.tagName;
      out.issues = document.getElementById('issues').textContent;
      architecture_input.value = 'ppc';
      architecture_input.dispatchEvent(new Event('input', { bubbles: true }));
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.control_type, 'INPUT');
  assert.doesNotMatch(result.issues, /架构设置.*不兼容|不支持 CMAKE_GENERATOR_PLATFORM/);
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  const presets = JSON.parse(applyOps(apply_message.ops, JSON.stringify(scenario_data))).configurePresets;
  assert.deepEqual(presets[0].architecture, { value: 'ppc', strategy: 'external' });
  assert.deepEqual(presets[1].architecture, { value: 'arm', strategy: 'external' });
});

test('webview：能力数据不可用时保留 VS 架构候选及当前自定义值', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'vs', generator: 'Visual Studio 17 2022', architecture: 'custom-platform' },
  ] };
  const result = runScenario(`
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text: DEMO_TEXT, version: 1, isDirty: false, generator_platforms: {}
      } }));
      out.options = Array.from(document.querySelectorAll('#form [data-field="architecture"] option'))
        .map(function (option) { return option.value; });
      out.architecture_value = document.querySelector('#form [data-field="architecture"]').value;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.options, ['', 'x64', 'Win32', 'ARM', 'ARM64', 'custom-platform']);
  assert.equal(result.architecture_value, 'custom-platform');
});

test('webview：架构冲突显示醒目说明，可一键清空本地架构并写回文档', (t) => {
  const result = runScenario(`
      var generator_select = document.querySelector('#form [data-field="generator"]');
      generator_select.value = 'Ninja';
      generator_select.dispatchEvent(new Event('input', { bubbles: true }));
      var conflict_card = document.getElementById('architecture-conflict');
      out.conflict_role = conflict_card.getAttribute('role');
      out.conflict_text = conflict_card.textContent;
      out.invalid = document.querySelector('#form [data-field="architecture"]').getAttribute('aria-invalid');
      out.actions = Array.from(conflict_card.querySelectorAll('button')).map(function (button) { return button.textContent; });
      document.querySelector('#form [data-field="__architecture_clear"]').click();
      out.architecture_after = !!document.querySelector('#form [data-field="architecture"]');
      out.conflict_after = !!document.getElementById('architecture-conflict');
      out.issues_after = document.getElementById('issues').textContent;
  `, t);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.conflict_role, 'alert');
  assert.equal(result.invalid, 'true');
  assert.match(result.conflict_text, /Ninja.*配置失败/);
  assert.doesNotMatch(result.conflict_text, /在 JSON 中/);
  assert.deepEqual(result.actions, ['清空架构配置', '仅供 IDE 使用']);
  assert.equal(result.architecture_after, false);
  assert.equal(result.conflict_after, false);
  assert.doesNotMatch(result.issues_after, /架构设置.*不兼容/);
  const apply_messages = result.sent.filter((message) => message.type === 'apply');
  assert.equal(apply_messages.length, 1, '连续操作应合并为一次 apply');
  const presets = JSON.parse(applyOps(apply_messages[0].ops)).configurePresets;
  assert.equal(presets[0].generator, 'Ninja');
  assert.equal(presets[0].architecture, undefined);
  assert.deepEqual(presets[1], JSON.parse(DEMO_TEXT).configurePresets[1]);
});

test('webview：一键改为仅供 IDE 使用，保留架构值并立即解除冲突', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'ninja', generator: 'Ninja', architecture: { value: 'ARM64', strategy: 'set' } },
  ] };
  const result = runScenario(`
      document.querySelector('#form [data-field="__architecture_external"]').click();
      out.architecture_value = document.querySelector('#form [data-field="architecture"]').value;
      out.invalid = document.querySelector('#form [data-field="architecture"]').getAttribute('aria-invalid');
      out.conflict_after = !!document.getElementById('architecture-conflict');
      out.issues_after = document.getElementById('issues').textContent;
      out.form_text = document.getElementById('form').textContent;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.architecture_value, 'ARM64');
  assert.equal(result.invalid, null);
  assert.equal(result.conflict_after, false);
  assert.match(result.form_text, /仅供 IDE 准备编译环境/);
  assert.doesNotMatch(result.issues_after, /架构设置.*不兼容/);
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  const preset = JSON.parse(applyOps(apply_message.ops, JSON.stringify(scenario_data))).configurePresets[0];
  assert.deepEqual(preset.architecture, { value: 'ARM64', strategy: 'external' });
});

test('webview：清空继承架构时只覆盖当前预设，不再继承不兼容值', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'child', inherits: 'base', generator: 'Ninja' },
    { name: 'base', hidden: true, generator: 'Visual Studio 17 2022', architecture: 'x64' },
  ] };
  const result = runScenario(`
      out.conflict_before = document.getElementById('architecture-conflict').textContent;
      document.querySelector('#form [data-field="__architecture_clear"]').click();
      out.architecture_after = !!document.querySelector('#form [data-field="architecture"]');
      out.conflict_after = !!document.getElementById('architecture-conflict');
      out.issues_after = document.getElementById('issues').textContent;
      out.toast_text = document.getElementById('toast').textContent;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.match(result.conflict_before, /继承自「base」/);
  assert.match(result.conflict_before, /不修改父预设/);
  assert.equal(result.architecture_after, false);
  assert.equal(result.conflict_after, false);
  assert.doesNotMatch(result.issues_after, /架构设置.*不兼容/);
  assert.match(result.toast_text, /父预设未修改/);
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  assert.ok(apply_message.ops.every((operation) => operation.path[1] === 0), '只允许修改当前子预设');
  const presets = JSON.parse(applyOps(apply_message.ops, JSON.stringify(scenario_data))).configurePresets;
  assert.deepEqual(presets[0].architecture, { value: '', strategy: 'external' });
  assert.deepEqual(presets[1], scenario_data.configurePresets[1]);
});

test('webview：继承架构可直接改为 IDE 使用，切回 VS 后可改由 CMake 指定', (t) => {
  const scenario_data = { version: 7, configurePresets: [
    { name: 'child', inherits: 'base', generator: 'Ninja' },
    { name: 'base', hidden: true, generator: 'Visual Studio 17 2022', architecture: { value: 'x64', strategy: 'set' } },
  ] };
  const result = runScenario(`
      document.querySelector('#form [data-field="__architecture_external"]').click();
      out.architecture_after_external = document.querySelector('#form [data-field="architecture"]').value;
      out.conflict_after_external = !!document.getElementById('architecture-conflict');
      var generator_select = document.querySelector('#form [data-field="generator"]');
      generator_select.value = 'Visual Studio 17 2022';
      generator_select.dispatchEvent(new Event('input', { bubbles: true }));
      out.has_set_action = !!document.querySelector('#form [data-field="__architecture_set"]');
      document.querySelector('#form [data-field="__architecture_set"]').click();
      out.set_action_after = !!document.querySelector('#form [data-field="__architecture_set"]');
      out.architecture_after_set = document.querySelector('#form [data-field="architecture"]').value;
  `, t, scenario_data);
  if (!result) return;
  assert.deepEqual(result.errors, []);
  assert.equal(result.architecture_after_external, 'x64');
  assert.equal(result.conflict_after_external, false);
  assert.equal(result.has_set_action, true);
  assert.equal(result.set_action_after, false);
  assert.equal(result.architecture_after_set, 'x64');
  const apply_message = result.sent.filter((message) => message.type === 'apply').at(-1);
  const presets = JSON.parse(applyOps(apply_message.ops, JSON.stringify(scenario_data))).configurePresets;
  assert.deepEqual(presets[0].architecture, { value: 'x64', strategy: 'set' });
  assert.deepEqual(presets[1], scenario_data.configurePresets[1]);
});
