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

function pageScript(body) {
  return (
    '<script>\n' +
    'var DEMO_TEXT = ' + JSON.stringify(DEMO_TEXT) + ';\n' +
    'setTimeout(function () {\n' +
    '  window.dispatchEvent(new MessageEvent("message", { data: {\n' +
    '    type: "init", text: DEMO_TEXT, version: 1, isDirty: false, fileName: "CMakePresets.json",\n' +
    '    catalog: [{ name: "CMAKE_BUILD_TYPE", type: "STRING", desc: "build type", values: ["Debug"], hot: true }],\n' +
    '    generators: ["Ninja"]\n' +
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

function runScenario(body, t) {
  const browser = findBrowser();
  if (!browser || !fs.existsSync(EDITOR)) {
    t.skip('没有浏览器或未生成 media/editor.html');
    return null;
  }

  const temp = path.join(EXT_ROOT, 'media', '__webview-test.html');
  let html = fs.readFileSync(EDITOR, 'utf8');
  html = html.replace('<script>', FAKE_API + '<script>');
  html = html.replace('</body>', pageScript(body) + '</body>');
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

function applyOps(ops) {
  const replacement = computeReplacement(DEMO_TEXT, ops, { insertSpaces: false, tabSize: 1, eol: '\n' });
  assert.ok(replacement, 'ops 应产生文本修改');
  return (
    DEMO_TEXT.slice(0, replacement.offset) +
    replacement.text +
    DEMO_TEXT.slice(replacement.offset + replacement.length)
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
