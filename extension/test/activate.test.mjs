/**
 * 用假的 vscode 模块加载打包产物，确认：
 *   1. dist/extension.js 能被 require（没有缺失依赖 / 顶层错误）
 *   2. activate() 能跑通（读取变量目录、调用 cmake --help、注册命令）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = Module.createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.dirname(__dirname);

function makeVscodeStub() {
  const state = { commands: [], editors: [], output: [] };
  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
      this.scheme = 'file';
      this.path = fsPath;
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
    Position: class {},
    Range: class {},
    WorkspaceEdit: class {
      replace() {}
    },
    window: {
      createOutputChannel(name) {
        state.output.push(name);
        return { appendLine() {}, show() {} };
      },
      registerCustomEditorProvider(viewType, provider) {
        state.editors.push({ viewType, provider });
        return { dispose() {} };
      },
      showErrorMessage() {
        return Promise.resolve();
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showQuickPick() {
        return Promise.resolve();
      },
      get activeTextEditor() {
        return undefined;
      },
    },
    commands: {
      registerCommand(id, handler) {
        state.commands.push({ id, handler });
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    workspace: {
      workspaceFolders: undefined,
      findFiles() {
        return Promise.resolve([]);
      },
      onDidChangeTextDocument() {
        return { dispose() {} };
      },
      onDidSaveTextDocument() {
        return { dispose() {} };
      },
      createFileSystemWatcher() {
        const disposable = { dispose() {} };
        return {
          onDidCreate: () => disposable,
          onDidChange: () => disposable,
          onDidDelete: () => disposable,
          dispose() {},
        };
      },
      getWorkspaceFolder() {
        return undefined;
      },
      asRelativePath(p) {
        return String(p);
      },
      fs: {
        stat: () => Promise.reject(new Error('nope')),
        writeFile: () => Promise.resolve(),
        readFile: () => Promise.resolve(Buffer.from('')),
      },
    },
  };
  return { vscode, state };
}

test('打包产物能在扩展宿主里激活', async () => {
  const { vscode, state } = makeVscodeStub();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const bundle = path.join(EXT_ROOT, 'dist', 'extension.js');
    delete require.cache[require.resolve(bundle)];
    const mod = require(bundle);
    assert.equal(typeof mod.activate, 'function', '应导出 activate');

    const context = {
      subscriptions: [],
      extensionPath: EXT_ROOT,
      extensionUri: vscode.Uri.file(EXT_ROOT),
    };
    mod.activate(context);

    assert.ok(state.editors.length >= 1, '应注册自定义编辑器');
    assert.equal(state.editors[0].viewType, 'cmakePresets.editor');

    const ids = state.commands.map((c) => c.id);
    assert.ok(ids.includes('cmakePresets.openEditor'));
    assert.ok(ids.includes('cmakePresets.createFile'));

    const deps = state.editors[0].provider.deps;
    assert.ok(deps, 'provider 应拿到依赖');
    assert.ok(deps.catalog.length >= 8, `变量目录条数异常: ${deps.catalog.length}`);
    assert.ok(deps.generators.length > 0, '生成器列表不应为空');

    mod.deactivate();
  } finally {
    Module._load = originalLoad;
  }
});
