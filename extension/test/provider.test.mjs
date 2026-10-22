/**
 * 扩展宿主侧集成测试：用假的 vscode 模块把 editorProvider 完整跑一遍。
 * 覆盖 resolveCustomTextEditor → ready → init → apply → 文档真的被最小修改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = Module.createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.dirname(__dirname);
const DEMO = path.resolve(EXT_ROOT, '..', 'demo', 'CMakePresets.json');

function installVscodeStub() {
  const applied = [];
  class Uri {
    constructor(p) {
      this.fsPath = p;
      this.path = p;
      this.scheme = 'file';
    }
    static file(p) {
      return new Uri(p);
    }
    static joinPath(base, ...parts) {
      return new Uri(path.join(base.fsPath, ...parts));
    }
    toString() {
      return 'file://' + this.fsPath.replace(/\\/g, '/');
    }
  }
  const vscode = {
    Uri,
    EndOfLine: { LF: 1, CRLF: 2 },
    Position: class {
      constructor(offset) {
        this.offset = offset;
      }
    },
    Range: class {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    WorkspaceEdit: class {
      constructor() {
        this.ops = [];
      }
      replace(uri, range, text) {
        this.ops.push({ uri, range, text });
      }
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      registerCustomEditorProvider: () => ({ dispose() {} }),
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
    workspace: {
      applyEdit: async (edit) => {
        for (const op of edit.ops) applied.push(op);
        return true;
      },
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidSaveTextDocument: () => ({ dispose() {} }),
    },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return original.call(this, request, parent, isMain);
  };
  return { applied, restore: () => (Module._load = original) };
}

function makeDocument(text) {
  let content = text;
  return {
    uri: { toString: () => 'file:///demo/CMakePresets.json', fsPath: 'D:\\demo\\CMakePresets.json' },
    fileName: 'D:\\demo\\CMakePresets.json',
    version: 1,
    isDirty: false,
    eol: 1,
    getText: () => content,
    positionAt: (offset) => ({ offset }),
    save: async () => {},
    setContent(next) {
      content = next;
      this.version++;
      this.isDirty = true;
    },
  };
}

function makePanel() {
  const state = { html: '', posted: [], handler: null };
  return {
    state,
    panel: {
      webview: {
        options: {},
        cspSource: 'vscode-webview://test',
        get html() {
          return state.html;
        },
        set html(value) {
          state.html = value;
        },
        onDidReceiveMessage(cb) {
          state.handler = cb;
          return { dispose() {} };
        },
        postMessage(msg) {
          state.posted.push(msg);
          return Promise.resolve(true);
        },
      },
      onDidDispose() {
        return { dispose() {} };
      },
    },
  };
}

test('provider：init → apply → 文档最小修改', async () => {
  const stub = installVscodeStub();
  try {
    const { PresetsEditorProvider } = require('../out/editorProvider.js');
    const document = makeDocument(fs.readFileSync(DEMO, 'utf8'));
    const { panel, state } = makePanel();

    const provider = new PresetsEditorProvider(
      { extensionUri: { fsPath: EXT_ROOT }, extensionPath: EXT_ROOT },
      { catalog: [{ name: 'CMAKE_BUILD_TYPE', type: 'STRING', desc: 'x', values: ['Debug'], hot: true }], generators: ['Ninja'], cmakeVersion: '4.4' }
    );

    await provider.resolveCustomTextEditor(document, panel);

    // 1. HTML 注入了 CSP + nonce
    assert.match(state.html, /Content-Security-Policy/);
    assert.match(state.html, /<script nonce="[^"]+">/);
    assert.match(state.html, /acquireVsCodeApi/);

    // 2. ready → init
    await state.handler({ type: 'ready' });
    const init = state.posted.find((m) => m.type === 'init');
    assert.ok(init, '应回 init');
    assert.equal(init.fileName, 'CMakePresets.json');
    assert.equal(init.catalog.length, 1);
    assert.deepEqual(init.generators, ['Ninja']);

    // 3. apply：改 binaryDir
    await state.handler({
      type: 'apply',
      ops: [{ path: ['configurePresets', 0, 'binaryDir'], value: '${sourceDir}/out' }],
    });

    assert.equal(stub.applied.length, 1, '应产生一次 WorkspaceEdit');
    const op = stub.applied[0];
    const before = fs.readFileSync(DEMO, 'utf8');
    const next = before.slice(0, op.range.start.offset) + op.text + before.slice(op.range.end.offset);
    document.setContent(next);

    const parsed = JSON.parse(next);
    assert.equal(parsed.configurePresets[0].binaryDir, '${sourceDir}/out');
    assert.equal(parsed.configurePresets[1].name, 'linux', '其它预设不受影响');
    assert.match(next, /\n\t+"name": "VS2022"/, 'Tab 缩进保留');

    // 4. 删除字段
    await state.handler({ type: 'apply', ops: [{ path: ['configurePresets', 0, 'architecture'], remove: true }] });
    const op2 = stub.applied[1];
    const text2 = document.getText();
    const next2 = text2.slice(0, op2.range.start.offset) + op2.text + text2.slice(op2.range.end.offset);
    assert.equal(JSON.parse(next2).configurePresets[0].architecture, undefined);
  } finally {
    stub.restore();
  }
});
