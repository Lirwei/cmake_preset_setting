# CMake Presets Editor

在 VS Code 里用**表单**编辑 `CMakePresets.json` / `CMakeUserPresets.json`，不用手写 JSON。

## 用法

1. 在资源管理器里右键 `CMakePresets.json` → **打开方式…** → **CMake Presets 编辑器**；
   或命令面板执行 `CMake Presets: 用可视化编辑器打开`。
2. 左侧选预设 → 中间改字段 → 右侧实时看 JSON 与问题。
3. `Ctrl+S` 保存（和普通文本编辑器一致），撤销 `Ctrl+Z` 一步回退。

默认**不劫持**文件：直接双击仍然用文本编辑器打开（`priority: option`）。

## 功能（MVP）

- 预设树：配置 / 构建分组，复制、删除、新建；
- 表单：name / displayName / description / hidden / inherits / generator / architecture / binaryDir / toolchainFile / installDir；
  - generator 下拉来自本机 `cmake --help` 的 Generators 段（已过滤 deprecated），**项目里已经配置过的会标「项目已用」**（读 `CMakeCache.txt`，configure 后自动刷新）；
  - **architecture 跟随有效 generator（含继承）联动**：通过 `cmake -E capabilities` 读取平台能力及架构候选，获取失败时按生成器名称兜底；无 architecture 的 Ninja / Makefiles 预设隐藏该字段，残留不兼容值会显示醒目的冲突卡片，可直接「清空架构配置」或改为「仅供 IDE 使用」，继承值只在当前预设覆盖、不修改父预设；保留合法的 `architecture: { value, strategy: "external" }` 对象；
  - `cmakePresets.openEditor` 使用「预设文档 + 调节滑杆」图标，分别适配浅色 / 深色主题；
  - `cmake` 不在 PATH 时用内置兜底列表；
- 缓存变量与环境变量：表格编辑，**名称补全**（本机 CMake 变量目录，带说明与类型），选中的已知变量会**自动补类型**；`BOOL` 给 `ON/OFF`，常见枚举给建议值；
- 有效配置预览：展开 `inherits` 链，标出每个值来自哪个预设；
- 校验：重名、断链引用、缺 generator、`binaryDir` 冲突、`CMAKE_GENERATOR_PLATFORM` 误用等；
- 改 `name` 会自动改写引用它的 `inherits` / `configurePreset`；
- JSON 语法错误时自动只读，并提示切回文本编辑器修复；
- **界面跟随 VS Code 主题**：所有颜色取自 `--vscode-*` 主题变量，浅色 / 深色 / 高对比度都能用（见下方截图）。

## 编辑方式（为什么不会打乱格式）

每次操作只把**变化的部分**作为 JSON 路径 op 发给扩展，扩展用 `jsonc-parser` 做最小文本编辑：

- 只改目标字段，Tab 缩进、键顺序、`vendor` 等未知字段原样保留；
- 一次操作 = 一次 `WorkspaceEdit` = 一步撤销；
- 保存后 `git diff` 只有真正改动的那几行。

## 变量目录

扩展内置 `media/catalog.json`，由仓库里的 `tools/var-catalog` 从**本机 CMake 安装目录**的官方变量文档生成（默认 CMake 4.4 下有 839 条）。重新生成：
```bash
node tools/var-catalog/index.mjs build
cd extension && node esbuild.mjs   # 会把 variables.json 拷进 media/catalog.json
```

没有生成过时回退到内置的 8 个常用变量，功能不受影响。

## 已知限制

- 暂不支持 `include` 多文件合并、`condition` 可视化编辑（会原样保留，不破坏）；
- 预设类型目前是 configure / build（test / package / workflow 后续补）；
- 校验在 webview 内完成，还没有接到 Problems 面板；
- 需要 `cmake` 在 PATH 里才能拿到生成器列表，否则用内置静态列表。

## 开发

```bash
npm install
npm run build          # esbuild → dist/extension.js，并拷贝变量目录
npm run watch          # 开发时增量构建
npm test               # 37 个用例：核心编辑 + webview 端到端 + 扩展激活
npm run package        # 产出 build/cmake-presets-editor.vsix
```

发布流程会执行 `npm audit`。构建工具的 `@azure/identity` 暂时固定为未受当前认证依赖漏洞影响的 `4.13.0`，其 MSAL 依赖使用已修复边界检查的 `uuid@11.1.1`；上游依赖修复后可移除这些 override。该依赖不随 VSIX 分发。

调试：VS Code 打开本目录，按 `F5`（需要 `.vscode/launch.json`，见仓库说明），或直接安装 VSIX。
