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
  state.projectGenerators = state.projectGenerators || [];
  state.projectBuildDirs = state.projectBuildDirs || [];

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
    if (msg.generator_platforms) generator_platforms = msg.generator_platforms;
    if (Array.isArray(msg.projectGenerators)) state.projectGenerators = msg.projectGenerators;
    if (Array.isArray(msg.projectBuildDirs)) state.projectBuildDirs = msg.projectBuildDirs;

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
    else if (msg.type === 'project') {
      state.projectGenerators = msg.projectGenerators || [];
      state.projectBuildDirs = msg.projectBuildDirs || [];
      if (!parseBroken) renderForm();
    }
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

// select 支持 { value, label }，用于给「项目已用」的生成器加标记
html = replaceOnce(
  html,
  "  function select(field, value, options, placeholder) {\n    var html = '<select data-field=\"' + field + '\"><option value=\"\">' +\n      esc(placeholder || '（未设置）') + '</option>';\n    options.forEach(function (o) {\n      html += '<option value=\"' + esc(o) + '\"' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>';\n    });\n    html += '</select>';\n    return html;\n  }",
  [
    '  function select(field, value, options, placeholder) {',
    "    var html = '<select data-field=\"' + field + '\"><option value=\"\">' +",
    "      esc(placeholder || '（未设置）') + '</option>';",
    '    options.forEach(function (o) {',
    "      var val = (o && typeof o === 'object') ? o.value : o;",
    "      var label = (o && typeof o === 'object') ? o.label : o;",
    "      html += '<option value=\"' + esc(val) + '\"' + (val === value ? ' selected' : '') + '>' + esc(label) + '</option>';",
    '    });',
    "    html += '</select>';",
    '    return html;',
    '  }',
  ].join('\n'),
  'select-options'
);

// 生成器：标记「项目已用」；architecture 只在 Visual Studio 生成器下显示
html = replaceOnce(
  html,
  `    if (kind === 'configure') {
      var isVS = /Visual Studio/i.test(p.generator || '');
      parts.push(group('生成器与目录', [
        row('generator', select('generator', p.generator, withCurrent(GENERATORS, p.generator), '（由 CMake 自动发现）'),
          '列表来自本机 <code>cmake --help</code>（原型为静态列表）'),
        row('architecture', select('architecture', p.architecture, ARCHS, '（默认）'),
          isVS ? 'Visual Studio 生成器专用' : '仅 Visual Studio 生成器识别，非 VS 生成器请留空'),
        row('binaryDir', txt('binaryDir', p.binaryDir, '\${sourceDir}/build'),
          '支持 \${sourceDir} / \${presetName} / $env{} 等宏'),
        row('toolchainFile', txt('toolchainFile', p.toolchainFile, '（可选）')),
        row('installDir', txt('installDir', p.installDir, '（可选）'))
      ]));
    } else {`,
  `    if (kind === 'configure') {
      var resolved_configure = resolveConfigure(p);
      var generator_name = resolved_configure.eff.generator || '';
      var platform_info = generator_platform(generator_name);
      var project_generators = state.projectGenerators || [];
      var generator_options = withCurrent(GENERATORS, p.generator).map(function (generator_name) {
        var generator_label = generator_name;
        if (project_generators.indexOf(generator_name) >= 0) generator_label += '（项目已用）';
        if (GENERATORS.indexOf(generator_name) < 0) generator_label += '（当前 CMake 未列出）';
        return { value: generator_name, label: generator_label };
      });
      var generator_hint = '来自本机 <code>cmake --help</code>，共 ' + GENERATORS.length + ' 项；仅表示 CMake 支持，不代表对应工具链已安装';
      var build_dirs = state.projectBuildDirs || [];
      if (build_dirs.length) {
        generator_hint += '；构建目录：' + build_dirs.map(function (build_dir) {
          return esc(build_dir.dir) + ' → ' + esc(build_dir.generator);
        }).join('，');
      }
      var generator_placeholder = !p.generator && generator_name ? '（继承：' + generator_name + '）' : '（由 CMake 自动发现）';
      var genRows = [
        row('generator', select('generator', p.generator, generator_options, generator_placeholder), generator_hint)
      ];
      var effective_architecture = resolved_configure.eff.architecture;
      var architecture_suppressed = architecture_external(effective_architecture) && !architecture_value(effective_architecture);
      if (platform_info.platform_support || (effective_architecture !== undefined && !architecture_suppressed)) {
        var current_architecture = architecture_value(p.architecture);
        var inherited_architecture = p.architecture === undefined ? architecture_value(effective_architecture) : '';
        var architecture_placeholder = inherited_architecture ? '（继承：' + inherited_architecture + '）' : '（由 CMake 决定）';
        var architecture_options = platform_info.supported_platforms || (/^Visual Studio /i.test(generator_name) ? ARCHS : undefined);
        var architecture_control = architecture_options && architecture_options.length
          ? select('architecture', current_architecture, withCurrent(architecture_options, current_architecture), architecture_placeholder)
          : txt('architecture', current_architecture, architecture_placeholder);
        var architecture_hint = architecture_external(effective_architecture)
          ? '仅供 IDE 准备编译环境；CMake 不接收此架构设置'
          : platform_info.platform_support ? '跟随有效 generator（含继承），对应 -A'
          : '尚未指定 generator；请先选择生成器';
        if (generator_name && !platform_info.platform_support && !architecture_external(effective_architecture)) {
          architecture_control = architecture_control.replace('data-field="architecture"',
            'data-field="architecture" aria-invalid="true" aria-describedby="architecture-conflict"');
          var architecture_source = resolved_configure.sources.architecture;
          architecture_control += '<div class="architecture-conflict" id="architecture-conflict" role="alert">' +
            '<strong>架构设置与生成器不兼容</strong>' +
            '<p><code>' + esc(generator_name) + '</code> 不接受单独的架构参数。保留当前设置会导致 CMake 配置失败。</p>' +
            (architecture_source && architecture_source !== p.name
              ? '<p>此架构继承自「' + esc(architecture_source) + '」。以下操作只覆盖当前预设，不修改父预设。</p>' : '') +
            '<div class="architecture-actions">' +
            '<button type="button" class="primary" data-field="__architecture_clear">清空架构配置</button>' +
            '<button type="button" data-field="__architecture_external">仅供 IDE 使用</button></div>' +
            '<p class="hint">通常选择「清空架构配置」；如果需要 IDE 按此架构准备编译环境，请选择「仅供 IDE 使用」。</p></div>';
          architecture_hint = '';
        } else if (platform_info.platform_support && architecture_external(effective_architecture)) {
          architecture_control += '<div class="architecture-actions"><button type="button" data-field="__architecture_set">改由 CMake 指定架构</button></div>';
        }
        genRows.push(row('architecture', architecture_control, architecture_hint));
      }
      genRows.push(row('binaryDir', txt('binaryDir', p.binaryDir, '\${sourceDir}/build'),
        '支持 \${sourceDir} / \${presetName} / $env{} 等宏'));
      genRows.push(row('toolchainFile', txt('toolchainFile', p.toolchainFile, '（可选）')));
      genRows.push(row('installDir', txt('installDir', p.installDir, '（可选）')));
      parts.push(group('生成器与目录', genRows));
    } else {`,
  'generator-architecture'
);

// 非 VS 生成器写了 architecture 也要报警
html = replaceOnce(
  html,
  "      if (p.generator && !/Visual Studio/i.test(p.generator) && p.cacheVariables &&\n          p.cacheVariables.CMAKE_GENERATOR_PLATFORM !== undefined) {\n        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + p.generator + '，但设置了仅 VS 生成器识别的 CMAKE_GENERATOR_PLATFORM', target: { kind: 'configure', index: i } });\n      }",
  "      if (p.generator && !/Visual Studio/i.test(p.generator) && p.cacheVariables &&\n          p.cacheVariables.CMAKE_GENERATOR_PLATFORM !== undefined) {\n        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + p.generator + '，但设置了仅 VS 生成器识别的 CMAKE_GENERATOR_PLATFORM', target: { kind: 'configure', index: i } });\n      }\n      if (p.generator && !/Visual Studio/i.test(p.generator) && p.architecture) {\n        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + p.generator + '，architecture 会被忽略', target: { kind: 'configure', index: i } });\n      }",
  'architecture-lint'
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


// 生成器能力、对象格式及继承联动。
html = replaceOnce(
  html,
  `  var ARCHS = ['x64', 'Win32', 'ARM', 'ARM64'];`,
  `  var generator_platforms = {};
  var ARCHS = ['x64', 'Win32', 'ARM', 'ARM64'];`,
  'generator-platform-1'
);
html = replaceOnce(
  html,
  `  function cacheRows(p) {`,
  `  function generator_platform(generator_name) {
    return generator_platforms[generator_name] || {
      platform_support: /^(Visual Studio |Green Hills MULTI$)/i.test(generator_name || ''),
      supported_platforms: /^Visual Studio /i.test(generator_name || '') ? ARCHS : undefined
    };
  }
  function architecture_value(architecture) {
    return architecture && typeof architecture === 'object' ? architecture.value : architecture;
  }
  function architecture_external(architecture) {
    return !!architecture && typeof architecture === 'object' && architecture.strategy === 'external';
  }

  function cacheRows(p) {`,
  'generator-platform-2'
);
html = replaceOnce(
  html,
  `  function resolveConfigure(p) {
    var chain = [];
    var seen = {};
    var node = p;
    while (node && !seen[node.name]) {
      seen[node.name] = true;
      chain.unshift(node);
      node = node.inherits ? findIn('configure', node.inherits) : null;
    }
    var eff = {}, sources = {}, cv = {}, cvFrom = {};
    chain.forEach(function (n) {
      ['generator', 'architecture', 'toolset', 'binaryDir', 'installDir', 'toolchainFile'].forEach(function (k) {
        if (n[k] !== undefined && n[k] !== '') { eff[k] = n[k]; sources[k] = n.name; }
      });
      var vars = n.cacheVariables || {};
      Object.keys(vars).forEach(function (k) {
        cv[k] = vars[k];
        cvFrom[k] = n.name;
      });
    });
    return { chain: chain, eff: eff, sources: sources, cv: cv, cvFrom: cvFrom };
  }

`,
  `  function resolveConfigure(p) {
    var chain = [], seen = Object.create(null);
    var eff = {}, sources = {}, cv = {}, cvFrom = {};
    function visit_configure(node) {
      if (!node || seen[node.name]) return;
      seen[node.name] = true;
      chain.unshift(node);
      ['generator', 'architecture', 'toolset', 'binaryDir', 'installDir', 'toolchainFile'].forEach(function (field_name) {
        if (eff[field_name] === undefined && node[field_name] !== undefined && node[field_name] !== '') {
          eff[field_name] = node[field_name];
          sources[field_name] = node.name;
        }
      });
      Object.keys(node.cacheVariables || {}).forEach(function (variable_name) {
        if (!Object.prototype.hasOwnProperty.call(cv, variable_name)) {
          cv[variable_name] = node.cacheVariables[variable_name];
          cvFrom[variable_name] = node.name;
        }
      });
      var parent_names = Array.isArray(node.inherits) ? node.inherits : node.inherits ? [node.inherits] : [];
      parent_names.forEach(function (parent_name) { visit_configure(findIn('configure', parent_name)); });
    }
    visit_configure(p);
    return { chain: chain, eff: eff, sources: sources, cv: cv, cvFrom: cvFrom };
  }

`,
  'generator-platform-3'
);
html = replaceOnce(
  html,
  `      if (p.generator && !/Visual Studio/i.test(p.generator) && p.cacheVariables &&
          p.cacheVariables.CMAKE_GENERATOR_PLATFORM !== undefined) {
        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + p.generator + '，但设置了仅 VS 生成器识别的 CMAKE_GENERATOR_PLATFORM', target: { kind: 'configure', index: i } });
      }
      if (p.generator && !/Visual Studio/i.test(p.generator) && p.architecture) {
        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + p.generator + '，architecture 会被忽略', target: { kind: 'configure', index: i } });
      }
`,
  `      var effective_configure = resolveConfigure(p);
      var generator_name = effective_configure.eff.generator;
      var platform_info = generator_platform(generator_name);
      if (generator_name && !platform_info.platform_support &&
          effective_configure.cv.CMAKE_GENERATOR_PLATFORM !== undefined) {
        out.push({ level: 'warn', msg: '「' + p.name + '」使用 ' + generator_name + '，不支持 CMAKE_GENERATOR_PLATFORM', target: { kind: 'configure', index: i } });
      }
      if (generator_name && !platform_info.platform_support && effective_configure.eff.architecture !== undefined &&
          !architecture_external(effective_configure.eff.architecture)) {
        out.push({ level: 'error', msg: '「' + p.name + '」的架构设置与 ' + generator_name + ' 不兼容，配置会失败。请在表单中选择「清空架构配置」或「仅供 IDE 使用」', target: { kind: 'configure', index: i } });
      }
`,
  'generator-platform-4'
);
html = replaceOnce(
  html,
  `    var val = el.value.trim();
    if (val === '') delete p[field]; else p[field] = val;
    updateDerived();
    if (field === 'generator') renderForm();`,
  `    var val = el.value.trim();
    if (field === 'architecture' && val !== '' && p.architecture && typeof p.architecture === 'object') {
      p.architecture.value = val;
    } else if (field === 'architecture' && val !== '' && p.architecture === undefined &&
        typeof resolveConfigure(p).eff.architecture === 'object') {
      p.architecture = Object.assign({}, resolveConfigure(p).eff.architecture, { value: val });
    } else if (val === '') delete p[field]; else p[field] = val;
    updateDerived();
    if (field === 'generator' || field === 'inherits' || (field === 'architecture' && val === '')) renderForm();`,
  'generator-platform-5'
);
html = replaceOnce(
  html,
  `esc(v)) +`,
  `esc(v && typeof v === 'object' ? JSON.stringify(v) : v)) +`,
  'generator-platform-6'
);
html = replaceOnce(
  html,
  `      if (p.inherits && !findIn('configure', p.inherits)) {`,
  `      if (p.inherits && (Array.isArray(p.inherits) ? p.inherits : [p.inherits]).some(function (parent_name) { return !findIn('configure', parent_name); })) {`,
  'generator-platform-7'
);
html = replaceOnce(
  html,
  `        if (!p.generator) out.push(`,
  `        if (!resolveConfigure(p).eff.generator) out.push(`,
  'generator-platform-8'
);
html = replaceOnce(
  html,
  `        if (!p.binaryDir) out.push(`,
  `        if (!resolveConfigure(p).eff.binaryDir) out.push(`,
  'generator-platform-9'
);
html = replaceOnce(
  html,
  `row('inherits', select('inherits', p.inherits, inheritOptions, '（不继承）'),`,
  `row('inherits', select('inherits', Array.isArray(p.inherits) ? p.inherits.join(', ') : p.inherits,
        withCurrent(inheritOptions, Array.isArray(p.inherits) ? p.inherits.join(', ') : p.inherits), '（不继承）'),`,
  'generator-platform-10'
);


// 架构冲突提供直接修复按钮，不要求用户切换到 JSON。
html = replaceOnce(
  html,
  `  function handleFormClick(e) {
    var btn = e.target.closest('button[data-field]');
    if (!btn) return;
    var p = cur();
    if (!p) return;
    var field = btn.dataset.field;
    var rowIndex = Number(btn.dataset.row);
`,
  `  function handleFormClick(e) {
    var btn = e.target.closest('button[data-field]');
    if (!btn) return;
    var p = cur();
    if (!p) return;
    var field = btn.dataset.field;
    var rowIndex = Number(btn.dataset.row);

    if (field === '__architecture_clear') {
      var inherited_preset = Object.assign({}, p);
      delete inherited_preset.architecture;
      var parent_architecture = resolveConfigure(inherited_preset).eff.architecture;
      if (parent_architecture !== undefined) {
        // 显式覆盖继承的值和策略，避免删除本地字段后再次继承不兼容的架构。
        p.architecture = { value: '', strategy: 'external' };
      } else {
        delete p.architecture;
      }
      renderForm();
      updateDerived();
      toast(parent_architecture !== undefined ? '已在当前预设停用继承的架构，父预设未修改' : '已清空架构配置，交由生成器决定');
      return;
    }
    if (field === '__architecture_external' || field === '__architecture_set') {
      var effective_architecture = resolveConfigure(p).eff.architecture;
      p.architecture = effective_architecture && typeof effective_architecture === 'object'
        ? Object.assign({}, effective_architecture) : { value: effective_architecture };
      p.architecture.strategy = field === '__architecture_external' ? 'external' : 'set';
      renderForm();
      updateDerived();
      toast(field === '__architecture_external' ? '已保留架构供 IDE 使用，不再传给 CMake' : '已改由 CMake 指定架构');
      return;
    }
`,
  'architecture-actions-1'
);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html, 'utf8');
console.log('port-webview: 已生成 ' + path.relative(root, target) + '（' + html.length + ' 字节）');
