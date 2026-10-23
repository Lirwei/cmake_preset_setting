import * as vscode from 'vscode';
import { readCacheEntry } from './core/cmakeCache';

export interface ProjectBuildDir {
  /** 相对工作区的构建目录，例如 build */
  dir: string;
  generator: string;
  platform?: string;
  toolset?: string;
}

export interface ProjectInfo {
  /** 项目里已经配置过的生成器（去重） */
  generators: string[];
  buildDirs: ProjectBuildDir[];
}

export const EMPTY_PROJECT_INFO: ProjectInfo = { generators: [], buildDirs: [] };

/**
 * 扫描工作区里的 CMakeCache.txt，读出实际使用过的生成器。
 * 只是给下拉框加个「项目已用」标记，读不到也不影响主流程。
 */
export async function scanProjectGenerators(): Promise<ProjectInfo> {
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles('**/CMakeCache.txt', '**/node_modules/**', 20);
  } catch {
    return EMPTY_PROJECT_INFO;
  }

  const buildDirs: ProjectBuildDir[] = [];
  for (const uri of files) {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(raw).toString('utf8');
      const generator = readCacheEntry(text, 'CMAKE_GENERATOR');
      if (!generator) continue;

      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const dirUri = uri.with({ path: uri.path.replace(/\/CMakeCache\.txt$/, '') });
      const relative = folder ? vscode.workspace.asRelativePath(dirUri, false) : dirUri.fsPath;

      buildDirs.push({
        dir: relative,
        generator,
        platform: readCacheEntry(text, 'CMAKE_GENERATOR_PLATFORM'),
        toolset: readCacheEntry(text, 'CMAKE_GENERATOR_TOOLSET'),
      });
    } catch {
      /* 单个缓存读失败不影响其它 */
    }
  }

  return { generators: [...new Set(buildDirs.map((b) => b.generator))], buildDirs };
}
