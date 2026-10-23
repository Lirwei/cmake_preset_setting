import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PresetsEditorProvider } from './editorProvider';
import { CatalogEntry, FALLBACK_CATALOG, FALLBACK_GENERATORS, slimCatalog } from './core/catalog';
import { parseGenerators, parse_generator_platforms, GeneratorPlatform } from './core/generators';
import { EMPTY_PROJECT_INFO, ProjectInfo, scanProjectGenerators } from './projectInfo';

let output: vscode.OutputChannel;
let projectInfo: ProjectInfo = EMPTY_PROJECT_INFO;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('CMake Presets 编辑器');
  context.subscriptions.push(output);

  const catalog = loadCatalog(context);
  const cmake = readCMake();
  output.appendLine(`变量目录：${catalog.length} 条`);
  output.appendLine(`CMake：${cmake.version ?? '未找到'}，生成器 ${cmake.generators.length} 个`);

  const refreshProjectInfo = async (): Promise<void> => {
    projectInfo = await scanProjectGenerators();
    output.appendLine(
      projectInfo.buildDirs.length
        ? `项目构建目录：${projectInfo.buildDirs.map((b) => `${b.dir} → ${b.generator}`).join('，')}`
        : '项目里还没有 CMakeCache.txt'
    );
    PresetsEditorProvider.broadcast({
      type: 'project',
      projectGenerators: projectInfo.generators,
      projectBuildDirs: projectInfo.buildDirs,
    });
  };

  void refreshProjectInfo();

  // CMakeCache.txt 变了（重新 configure）就刷新「项目已用」标记
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshProjectInfo();
    }, 1200);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/CMakeCache.txt');
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher, {
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
    },
  });

  context.subscriptions.push(
    PresetsEditorProvider.register(context, {
      catalog,
      generators: cmake.generators,
      generator_platforms: cmake.generator_platforms,
      cmakeVersion: cmake.version,
      getProjectInfo: () => projectInfo,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cmakePresets.openEditor', async () => {
      const target = await pickPresetFile();
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, PresetsEditorProvider.viewType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cmakePresets.createFile', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage('请先打开一个文件夹。');
        return;
      }
      const uri = vscode.Uri.joinPath(folder.uri, 'CMakePresets.json');
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand('vscode.openWith', uri, PresetsEditorProvider.viewType);
        return;
      } catch {
        /* 不存在则创建 */
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(TEMPLATE, 'utf8'));
      await vscode.commands.executeCommand('vscode.openWith', uri, PresetsEditorProvider.viewType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cmakePresets.installCatalog', async () => {
      const lines = [
        `变量目录：${catalog.length} 条`,
        `CMake：${cmake.version ?? '未找到'}（${cmake.generators.length} 个生成器）`,
        '',
        '重新生成目录：在仓库根目录运行',
        '  node tools/var-catalog/index.mjs build',
        '  cd extension && node esbuild.mjs',
      ];
      output.show(true);
      output.appendLine(lines.join('\n'));
      void vscode.window.showInformationMessage(
        `变量目录 ${catalog.length} 条（CMake ${cmake.version ?? '未知'}）`
      );
    })
  );
}

export function deactivate(): void {
  /* 无需清理 */
}

const TEMPLATE = `${JSON.stringify(
  {
    version: 7,
    cmakeMinimumRequired: { major: 3, minor: 27, patch: 0 },
    configurePresets: [
      {
        name: 'default',
        displayName: 'Default',
        generator: 'Ninja',
        binaryDir: '${sourceDir}/build',
      },
    ],
    buildPresets: [{ name: 'default', configurePreset: 'default' }],
  },
  null,
  2
)}\n`;

function loadCatalog(context: vscode.ExtensionContext): CatalogEntry[] {
  const file = path.join(context.extensionPath, 'media', 'catalog.json');
  try {
    const list = slimCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
    return list.length > 0 ? list : FALLBACK_CATALOG;
  } catch {
    return FALLBACK_CATALOG;
  }
}

function readCMake(): { version: string | null; generators: string[]; generator_platforms: Record<string, GeneratorPlatform> } {
  try {
    const versionOut = execFileSync('cmake', ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const version = /version\s+([0-9][\w.\-+]*)/i.exec(versionOut)?.[1] ?? null;

    const help = execFileSync('cmake', ['--help'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    let generator_platforms: Record<string, GeneratorPlatform> = {};
    try {
      generator_platforms = parse_generator_platforms(execFileSync('cmake', ['-E', 'capabilities'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }));
    } catch {
      // 获取能力失败不应丢掉已成功发现的生成器列表。
    }
    return { version, generators: parseGenerators(help), generator_platforms };
  } catch {
    return { version: null, generators: FALLBACK_GENERATORS, generator_platforms: {} };
  }
}

/** 从 `cmake --help` 的 Generators 段落里取生成器名字（已移到 core 便于单测）。 */

async function pickPresetFile(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && /CMake(Presets|UserPresets)\.json$/i.test(active.fsPath)) return active;

  const found = await vscode.workspace.findFiles(
    '**/{CMakePresets,CMakeUserPresets}.json',
    '**/node_modules/**',
    20
  );
  if (found.length === 0) {
    const create = await vscode.window.showInformationMessage(
      '工作区里没有找到 CMakePresets.json，要新建一个吗？',
      '新建',
      '取消'
    );
    if (create === '新建') {
      await vscode.commands.executeCommand('cmakePresets.createFile');
    }
    return undefined;
  }
  if (found.length === 1) return found[0];

  const picked = await vscode.window.showQuickPick(
    found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: '选择要编辑的预设文件' }
  );
  return picked?.uri;
}
