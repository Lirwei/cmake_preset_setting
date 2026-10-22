/**
 * 一次性移植脚本：把 docs/prototype/presets-editor.html 变成扩展的 webview。
 *
 * 做的事：
 *   1. 去掉 standalone 的 variables.js
 *   2. 注入 VS Code 桥（acquireVsCodeApi / postMessage / 差分提交）
 *   3. 把「直接改内存」改成「改内存 + 提交 op 给扩展」
 *   4. 处理非法 JSON 的只读降级
 *
 * 用法：node scripts/port-webview.mjs
 * 原型继续作为设计参考，扩展侧以生成的 media/editor.html 为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'docs', 'prototype', 'presets-editor.html');
const target = path.resolve(__dirname, '..', 'media', 'editor.html');

const BRIDGE = `
  /* ---------------- VS Code 桥 ---------------- */
  var vscode = acquireVsCodeApi();
  var pendingOps = [];
  var flushTimer = null;
  var beforeSnapshot = null;
  var parseBroken = false;

  function diffModel(before, after, base) {
    base = base || [];
    if (before === after) return [];
    var beforeIsArray = Array.isArray(before);
    var afterIsArray = Array.isArray(after);
    if (beforeIsArray !== afterIsArray) return [{ path: base, value: after }];
    if (beforeIsArray) {
      if (before.length !== after.length) return [{ path: base, value: after }];
      var arrOps = [];
      for (var i = 0; i < after.length; i++) arrOps = arrOps.concat(diffModel(before[i], after[i], base.concat(i)));
      return arrOps;
    }
    var beforeIsObject = before !== null && typeof before === 'object';
    var afterIsObject = after !== null && typeof after === 'object';
    if (!beforeIsObject || !afterIsObject) return [{ path: base, value: after }];
    var ops = [];
    var keys = Object.keys(after);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (!(key in before)) ops.push({ path: base.concat(key), value: after[key] });
      else ops = ops.concat(diffModel(before[key], after[key], base.concat(key)));
    }
    var oldKeys = Object.keys(before);
    for (var j = 0; j < oldKeys.length; j++) {
      if (!(oldKeys[j] in after)) ops.push({ path: base.concat(oldKeys[j]), remove: true });
    }
    return ops;
  }

  function post(ops) {
    if (!ops || !ops.length) return;
    pendingOps = pendingOps.concat(ops);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 350);
  }
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pendingOps.length) return;
    // 同一路径的连续修改只保留最后一次，避免逐字输入产生一串冗余 op
    var merged = [];
    var index = {};
    for (var i = 0; i < pendingOps.length; i++) {
      var op = pendingOps[i];
      var key = op.path.join('\\u0001') + (op.remove ? '!' : '');
      if (key in index) merged[index[key]] = op;
      else { index[key] = merged.length; merged.push(op); }
    }
    pendingOps = [];
    vscode.postMessage({ type: 'apply', ops: merged });
  }
  function beginEdit() {
    if (parseBroken) return false;
    beforeSnapshot = JSON.parse(JSON.stringify(state.data));
    return true;
  }
  function commitDiff() {
    if (!beforeSnapshot) return;
    var before = beforeSnapshot;
    beforeSnapshot = null;
    post(diffModel(before, state.data));
  }
  function commitOps(ops) {
    beforeSnapshot = null;
    post(ops);
  }

  function applyDocument(msg) {
    var parsed;
    try {
      parsed = JSON.parse(msg.text);
    } catch (err) {
      parseBroken = true;
      var bar = document.getElementById('parse-error');
      bar.style.display = 'inline';
      bar.textContent = 'JSON 语法错误：' + err.message + ' —— 请用「在 JSON 中打开」修复';
      document.getElementById('form').innerHTML =
        '<div class="empty">文件不是合法 JSON<br><span>修好之后切回来，编辑器会自动恢复</span></div>';
      document.getElementById('effective').innerHTML = '';
      return;
    }
    parseBroken = false;
    var bar2 = document.getElementById('parse-error');
    if (bar2) { bar2.style.display = 'none'; bar2.textContent = ''; }

    var prev = cur();
    var prevName = prev && prev.name;
    state.data = parsed;
    if (typeof msg.version === 'number') state.version = msg.version;
    if (msg.fileName) {
      state.fileName = msg.fileName;
      var nameEl = document.getElementById('file-name');
      if (nameEl) nameEl.textContent = msg.fileName;
    }
    if (Array.isArray(msg.catalog) && msg.catalog.length) VAR_CATALOG = msg.catalog;
    if (Array.isArray(msg.generators) && msg.generators.length) GENERATORS = msg.generators;

    var list = listOf(state.sel.kind);
    if (state.sel.index >= list.length) state.sel.index = Math.max(0, list.length - 1);
    if (prevName) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === prevName) { state.sel.index = i; break; }
      }
    }
    var vsel = document.getElementById('version');
    if (vsel) vsel.value = String(state.data.version || 7);
    document.getElementById('dirty').classList.toggle('on', !!msg.isDirty);
    renderAll();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'init' || msg.type === 'update') applyDocument(msg);
    else if (msg.type === 'state') document.getElementById('dirty').classList.toggle('on', !!msg.isDirty);
    else if (msg.type === 'error') toast('操作失败：' + msg.message);
  });
`;

function replaceOnce(html, from, to, label) {
  const index = html.indexOf(from);
  if (index === -1) throw new Error('port-webview: 找不到锚点「' + label + '」');
  if (html.indexOf(from, index + 1) !== -1) throw new Error('port-webview: 锚点不唯一「' + label + '」');
  return html.slice(0, index) + to + html.slice(index + from.length);
}

let html = fs.readFileSync(source, 'utf8');

// 样式以 scripts/editor.css 为准（主题变量在这里维护），内联进 webview
const css = fs.readFileSync(path.join(__dirname, 'editor.css'), 'utf8');
html = html.replace(/<style>[\s\S]*?<\/style>/, '<style>\n' + css + '\n</style>');

html = replaceOnce(html, '<title>CMake Presets 编辑器 · 交互原型</title>', '<title>CMake Presets 编辑器</title>', 'title');
html = replaceOnce(html, '\n<script src="variables.js"></script>', '', 'variables.js');
html = replaceOnce(html, '<span class="file">CMakePresets.json</span>', '<span class="file" id="file-name">CMakePresets.json</span>', 'file-name');
html = replaceOnce(
  html,
  '<span class="note">交互原型 · 不读写真实文件</span>',
  '<span class="note" id="parse-error" style="display:none;color:#f14c4c"></span>',
  'parse-error'
);
html = replaceOnce(
  html,
  '<div class="side-foot">点击预设编辑 · 悬停行可复制/删除 · 变量名支持补全</div>',
  '<div class="side-foot">点击预设编辑 · 悬停行可复制/删除 · 输入 CMAKE_ 补全变量</div>',
  'side-foot'
);

// 空模型启动，等扩展 init 再渲染
html = html.replace(
  /  var initialData = \{[\s\S]*?\n  \};\n\n  var state = \{/,
  '  var initialData = { version: 7, configurePresets: [], buildPresets: [] };\n\n  var state = {'
);

html = replaceOnce(
  html,
  "  var $ = function (id) { return document.getElementById(id); };",
  "  var $ = function (id) { return document.getElementById(id); };\n" + BRIDGE,
  'bridge'
);

// 字段输入：包装成 快照 → 修改 → 差分提交
html = replaceOnce(
  html,
  "  $('form').addEventListener('input', function (e) {",
  '  function handleFieldInput(e) {',
  'input-handler-open'
);
html = replaceOnce(
  html,
  "    if (field === 'generator') renderForm();\n  });",
  "    if (field === 'generator') renderForm();\n  }\n\n" +
    "  $('form').addEventListener('input', function (e) {\n" +
    '    if (parseBroken) return;\n' +
    '    if (!beginEdit()) return;\n' +
    '    handleFieldInput(e);\n' +
    '    commitDiff();\n' +
    '  });',
  'input-handler-close'
);

// 版本切换也要提交
html = replaceOnce(
  html,
  "  $('version').addEventListener('change', function (e) {\n    state.data.version = Number(e.target.value);",
  "  $('version').addEventListener('change', function (e) {\n" +
    '    if (parseBroken) return;\n' +
    '    beginEdit();\n' +
    '    state.data.version = Number(e.target.value);',
  'version-open'
);
html = replaceOnce(
  html,
  "    toast('已切换 preset 版本到 ' + state.data.version + '（字段按版本裁剪）');\n  });",
  "    toast('已切换 preset 版本到 ' + state.data.version + '（字段按版本裁剪）');\n    commitDiff();\n  });",
  'version-close'
);

// 变量表的增删走 click 事件，同样要包装（这里曾经漏掉，导致删除不落盘）
html = replaceOnce(
  html,
  "  $('form').addEventListener('click', function (e) {",
  '  function handleFormClick(e) {',
  'click-handler-open'
);
html = replaceOnce(
  html,
  "    if (field === '__env-del') {\n      if (!p.environment) return;\n      var ekeys = Object.keys(p.environment);\n      delete p.environment[ekeys[rowIndex]];\n      if (!Object.keys(p.environment).length) delete p.environment;\n      renderForm();\n      updateDerived();\n    }\n  });",
  "    if (field === '__env-del') {\n      if (!p.environment) return;\n      var ekeys = Object.keys(p.environment);\n      delete p.environment[ekeys[rowIndex]];\n      if (!Object.keys(p.environment).length) delete p.environment;\n      renderForm();\n      updateDerived();\n    }\n  }\n\n" +
    "  $('form').addEventListener('click', function (e) {\n" +
    '    if (parseBroken) return;\n' +
    '    if (!beginEdit()) return;\n' +
    '    handleFormClick(e);\n' +
    '    commitDiff();\n' +
    '  });',
  'click-handler-close'
);

// 补全采纳也要提交（它绕过了 input 事件）
html = replaceOnce(
  html,
  "    input.value = item.label;\n    hideSuggest();\n    var p = cur();\n    if (!p) return;\n    var rowIndex = Number(input.dataset.row);",
  "    input.value = item.label;\n    hideSuggest();\n    var p = cur();\n    if (!p) return;\n    beginEdit();\n    var rowIndex = Number(input.dataset.row);",
  'accept-suggest-open'
);
html = replaceOnce(
  html,
  '    syncCacheVar(p, rowIndex);\n    updateDerived();\n    input.focus();\n  }',
  '    syncCacheVar(p, rowIndex);\n    updateDerived();\n    commitDiff();\n    input.focus();\n  }',
  'accept-suggest-close'
);

// CRUD 用显式 op（数组增删不能走差分）
html = replaceOnce(
  html,
  "    list.push(p);\n    state.sel = { kind: kind, index: list.length - 1 };\n    markDirty();\n    renderAll();\n    toast('已新增预设，可继续修改名称');",
  "    list.push(p);\n    state.sel = { kind: kind, index: list.length - 1 };\n    markDirty();\n    renderAll();\n" +
    '    commitOps([{ path: [ARRAYS[kind], list.length - 1], value: JSON.parse(JSON.stringify(p)) }]);\n' +
    "    toast('已新增预设，可继续修改名称');",
  'add-preset'
);
html = replaceOnce(
  html,
  "    list.splice(index + 1, 0, copy);\n    state.sel = { kind: kind, index: index + 1 };\n    markDirty();\n    renderAll();\n    toast('已复制为 ' + name);",
  "    list.splice(index + 1, 0, copy);\n    state.sel = { kind: kind, index: index + 1 };\n    markDirty();\n    renderAll();\n" +
    '    commitOps([{ path: [ARRAYS[kind], index + 1], value: JSON.parse(JSON.stringify(copy)) }]);\n' +
    "    toast('已复制为 ' + name);",
  'duplicate-preset'
);
html = replaceOnce(
  html,
  "    list.splice(index, 1);\n    if (state.sel.kind === kind) {",
  "    list.splice(index, 1);\n" +
    '    commitOps([{ path: [ARRAYS[kind], index], remove: true }]);\n' +
    '    if (state.sel.kind === kind) {',
  'delete-preset'
);

// 保存 / 打开文本
html = replaceOnce(
  html,
  "  $('btn-save').addEventListener('click', function () {\n    state.dirty = false;\n    $('dirty').classList.remove('on');\n    toast('原型不写文件；真实扩展会保存到 CMakePresets.json');\n  });",
  "  $('btn-save').addEventListener('click', function () {\n    flush();\n    vscode.postMessage({ type: 'save' });\n  });",
  'save-button'
);
html = replaceOnce(
  html,
  "  $('btn-json').addEventListener('click', function () {\n    var el = $('json');\n    el.scrollIntoView({ block: 'nearest' });\n    el.classList.remove('flash');\n    void el.offsetWidth;\n    el.classList.add('flash');\n  });",
  "  $('btn-json').addEventListener('click', function () {\n    flush();\n    vscode.postMessage({ type: 'openText' });\n  });",
  'json-button'
);

html = replaceOnce(
  html,
  '  renderAll();\n})();',
  "  renderAll();\n  vscode.postMessage({ type: 'ready' });\n})();",
  'boot'
);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html, 'utf8');
console.log('port-webview: 已生成 ' + path.relative(root, target) + '（' + html.length + ' 字节）');
