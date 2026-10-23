import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeReplacement, detectFormatting, Op } from './core/edits';
import { CatalogEntry } from './core/catalog';
import { ProjectInfo } from './projectInfo';
import { GeneratorPlatform } from './core/generators';

export interface ProviderDeps {
  catalog: CatalogEntry[];
  generators: string[];
  generator_platforms?: Record<string, GeneratorPlatform>;
  cmakeVersion: string | null;
  getProjectInfo: () => ProjectInfo;
}

interface ApplyMessage {
  type: 'apply';
  ops: Op[];
}

export class PresetsEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'cmakePresets.editor';

  private static readonly panels = new Set<vscode.WebviewPanel>();

  /** 向所有打开的可视化编辑器广播消息（例如项目构建目录变化）。 */
  public static broadcast(message: unknown): void {
    for (const panel of PresetsEditorProvider.panels) {
      void panel.webview.postMessage(message);
    }
  }

  private applying = 0;
  private htmlCache: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: ProviderDeps
  ) {}

  public static register(context: vscode.ExtensionContext, deps: ProviderDeps): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PresetsEditorProvider.viewType,
      new PresetsEditorProvider(context, deps),
      { webviewOptions: { retainContextWhenHidden: true } }
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview);
    PresetsEditorProvider.panels.add(panel);

    const uri = document.uri.toString();
    const post = (message: unknown): void => {
      void panel.webview.postMessage(message);
    };

    const sendInit = (): void => {
      const project = this.deps.getProjectInfo();
      post({
        type: 'init',
        text: document.getText(),
        version: document.version,
        isDirty: document.isDirty,
        fileName: path.basename(document.fileName),
        catalog: this.deps.catalog,
        generators: this.deps.generators,
        generator_platforms: this.deps.generator_platforms ?? {},
        cmakeVersion: this.deps.cmakeVersion,
        projectGenerators: project.generators,
        projectBuildDirs: project.buildDirs,
      });
    };

    const disposables: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage(async (message: ApplyMessage | { type: string }) => {
        try {
          switch (message && message.type) {
            case 'ready':
              sendInit();
              break;
            case 'apply':
              await this.apply(document, (message as ApplyMessage).ops);
              break;
            case 'save':
              await document.save();
              post({ type: 'state', isDirty: document.isDirty });
              break;
            case 'openText':
              await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
              break;
            default:
              break;
          }
        } catch (err) {
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          sendInit();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== uri) return;
        if (this.applying > 0) return;
        post({
          type: 'update',
          text: document.getText(),
          version: document.version,
          isDirty: document.isDirty,
        });
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.toString() !== uri) return;
        post({ type: 'state', isDirty: saved.isDirty });
      }),
    ];

    panel.onDidDispose(() => {
      PresetsEditorProvider.panels.delete(panel);
      for (const disposable of disposables) disposable.dispose();
    }, null, disposables);
  }

  private async apply(document: vscode.TextDocument, ops: unknown): Promise<void> {
    if (!Array.isArray(ops) || ops.length === 0) return;

    const clean: Op[] = ops
      .filter((op): op is Op => !!op && Array.isArray((op as Op).path))
      .map((op) => ({ path: op.path, value: op.value, remove: !!op.remove }));
    if (clean.length === 0) return;

    const text = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const replacement = computeReplacement(text, clean, detectFormatting(text, eol));
    if (!replacement) return;

    const range = new vscode.Range(
      document.positionAt(replacement.offset),
      document.positionAt(replacement.offset + replacement.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, replacement.text);

    this.applying++;
    try {
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error('文档修改被拒绝（可能在别处被同时编辑）');
    } finally {
      setTimeout(() => {
        this.applying = Math.max(0, this.applying - 1);
      }, 0);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    if (!this.htmlCache) {
      const file = path.join(this.context.extensionPath, 'media', 'editor.html');
      this.htmlCache = fs.readFileSync(file, 'utf8');
    }
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return this.htmlCache
      .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace('<script>', `<script nonce="${nonce}">`);
  }
}
