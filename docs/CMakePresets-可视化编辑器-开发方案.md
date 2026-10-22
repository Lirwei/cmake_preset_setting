# CMakePresets 可视化编辑器：需求评估与开发方案

> 版本：v1.0　日期：2026-10-22　范围：VSCode 内的 CMake Presets 图形化编辑能力
> 参考对象：本仓库 `demo/CMakePresets.json`（version 7）

---

## 0. 结论先行（TL;DR）

| 问题 | 结论 |
|---|---|
| 技术上可行吗 | 可行，且**没有高风险依赖**。VSCode 自定义编辑器 + 官方 schema 驱动表单即可覆盖 100% 字段 |
| 推荐形态 | **VSCode 扩展**（`CustomTextEditorProvider`）+ Webview 前端；不做独立桌面端 |
| 核心难点 | 不在 UI，而在**三件事**：① 继承（`inherits`）语义与有效值计算；② 文本级增量编辑（不能破坏格式/未知字段/git diff）；③ schema 版本演进（v1–v12） |
| MVP 工期 | **22 人日（单人 4–5 周，双人 3 周）**：configure + build 预设的增删改查闭环 |
| 完整 V1 工期 | **约 66 人日（单人 15–17 周，双人 7–8 周）** |
| 最大风险 | CMake Tools 官方哪天自己做了 UI；以及"表单表达力不如 JSON"带来的用户抵触 |
| 建议 | 先做 3 周 MVP（双人）在真实项目里试用，再决定是否投入 V1；同时保留"一键切回 JSON"作为兜底 |

本方案同时附带一个**可点击的交互原型**：`docs/prototype/presets-editor.html`（双击用浏览器打开即可，无需构建）。原型用于对齐交互与信息架构，不是最终实现。

---

## 1. 现状分析：从你的 demo 文件说起

### 1.1 文件概览

`demo/CMakePresets.json` 共 51 行、`version: 7`，包含：

| 类型 | 名称 | 关键配置 |
|---|---|---|
| configure | `VS2022` | `Visual Studio 17 2022` / `x64` / `${sourceDir}/build` |
| configure | `linux` | `Unix Makefiles` / `linux_build` / 附带 `CMAKE_GENERATOR_PLATFORM`、MSVC toolchain |
| build | `Release` / `RelWithDebInfo` / `Debug` | 均挂在 `VS2022` 下，仅 `configuration` 不同 |

### 1.2 手改 JSON 的真实痛点（每条都能在 demo 里找到证据）

| # | 痛点 | demo 中的证据 | UI 能怎么解 |
|---|---|---|---|
| 1 | **继承链不可见**：改一个 base 预设，不知道会影响谁 | 三个 build preset 都隐式依赖 `VS2022` 的 generator/binaryDir | 继承树 + "谁继承了我" + 有效值预览（灰显值标明来源） |
| 2 | **交叉引用全是裸字符串** | `"configurePreset": "VS2022"` 写错一个字母，只有等 `cmake --preset` 报错 | 下拉选择 + 重命名时自动改写引用 |
| 3 | **重复配置靠复制粘贴** | 三个 build preset 只差 `configuration` | 复制预设 / 提取公共字段为 base / 矩阵批量生成 |
| 4 | **键值对表格在 JSON 里最难读** | `cacheVariables` 里 3 个变量、类型各异 | 表格编辑（名称/类型/值/删除），支持 `null` 表示"取消继承" |
| 5 | **版本与字段错配** | `version: 7`，但没人拦着你写 v10 的 `$comment`、v8 的 `$schema` | 按 `version` 动态裁剪字段，越级字段直接不显示/提示升级 |
| 6 | **宏写错不报错** | `${sourceDir}`、`${presetName}`、`$env{PATH}` 全靠手打 | 宏自动补全 + 语法校验 + 实时展开预览 |
| 7 | **生成器/架构/工具集是自由文本** | `"generator": "Visual Studio 17 2022"`，`architecture: "x64"` | 从本机 `cmake --help` 解析生成器列表；VS 生成器联动架构下拉 |
| 8 | **项目预设 / 用户预设分不清** | 只有 `CMakePresets.json`，个人配置无处安放 | 双文件视角，支持"提升到项目 / 下沉到用户" |
| 9 | **格式化噪音** | 文件用 Tab 缩进；手改容易变成空格，整文件 diff | 文本级最小编辑，只动该动的那几行 |

### 1.3 顺手做的一次"体检"（说明语义校验的价值）

对照 CMake 4.4 官方文档检查你的 demo，发现 4 个值得修的点：

1. **`linux` 预设自相矛盾**：生成器是 `Unix Makefiles`，却设置了 `CMAKE_GENERATOR_PLATFORM`（只有 Visual Studio 生成器识别）并指向 `${sourceDir}/toolchain/msvc/toolchain.cmake`（MSVC 工具链）。在 Linux 上这条预设大概率配置失败，看起来是从 VS 预设复制后忘了改。
2. **toolchain 文件不存在**：`demo/` 下没有 `toolchain/msvc/toolchain.cmake`，也没有 `CMakeLists.txt`，所以这些预设目前只能"格式上成立"。
3. **`linux` 没有配套 build preset**：三个 build preset 全部指向 `VS2022`。
4. **`CMAKE_POLICY_VERSION_MINIMUM: "3.5"`** 是 CMake 4.x 打开旧工程兼容的策略开关，属于"临时脚手架"，建议在 UI 里归入"兼容性开关"分组并给出说明，避免新人误以为是项目需求。

> 这四条正是"表单 + 规则校验"相对"裸 JSON"的直接收益：**不依赖人工记忆 CMake 的语义规则**。

---

## 2. 需求分析

### 2.1 目标用户与场景

| 角色 | 场景 | 关键诉求 |
|---|---|---|
| 日常开发者 | 切 Debug/Release、改 `binaryDir`、加一个业务开关宏 | 少记语法，改完立刻能编译 |
| 项目维护者 | 给团队加一条 CI 用预设、调整公共 base | 改继承不炸其他人，diff 可审 |
| 新人 | 首次接手项目，看不懂 `inherits` 链 | 一眼看清"最终生效的配置是什么" |
| CI/构建工程师 | 预设要能被 `cmake --preset` 复现 | 保存即合法，最好能在 UI 里直接跑一次 |

### 2.2 功能需求（MoSCoW + 优先级）

> P0 = MVP 必须；P1 = V1；P2 = 后续增强。工时为人日估算（含自测）。

| 编号 | 功能 | 优先级 | 说明 / 验收标准 | 工时 |
|---|---|---|---|---|
| F-01 | 以图形编辑器打开 `CMakePresets.json` / `CMakeUserPresets.json` | P0 | 右键"打开方式…"或命令面板；未保存标记、撤销/重做、保存语义与普通文本编辑器一致 | 4 |
| F-02 | 预设列表（按类型分组 + 隐藏标记 + 搜索） | P0 | 点击切换，当前项高亮；显示 `displayName || name` | 3 |
| F-03 | 基础字段表单（name/displayName/description/hidden/inherits） | P0 | 与 JSON 双向同步，非法值即时标红 | 3 |
| F-04 | configure 预设表单（generator/architecture/toolset/binaryDir/installDir/toolchainFile） | P0 | 生成器从本机 CMake 解析；VS 生成器联动架构下拉 | 4 |
| F-05 | `cacheVariables` 表格编辑 | P0 | 增删行、类型下拉（STRING/BOOL/PATH/FILEPATH/INTERNAL）、`null` 语义、宏补全 | 4 |
| F-06 | 新增 / 复制 / 删除 / 重命名预设 | P0 | 重命名自动改写 `inherits`、`configurePreset`、workflow `steps`；删除前提示引用者 | 5 |
| F-07 | 实时 JSON 预览（只读 + 定位） | P0 | 与表单同步滚动/高亮；一键切到原生编辑器 | 2 |
| F-08 | 校验：语法 + schema + 引用完整性 | P0 | 问题面板可点击跳转；保存不因 lint 被阻止 | 4 |
| F-09 | build / test / package / workflow 预设编辑 | P1 | 五类全覆盖，字段按 version 裁剪 | 6 |
| F-10 | 继承可视化与有效值计算 | P1 | 树形展示；继承值灰显并标注来源；环检测；`hidden` 提示 | 6 |
| F-11 | `include` 多文件与用户预设合并视图 | P1 | 解决隐式包含 `CMakeUserPresets.json`；跨文件重名检测 | 5 |
| F-12 | `condition` 可视化构建器 | P1 | `const/equals/matches/inList/anyOf/allOf/not` 树编辑；实时求值预览（已知宏） | 4 |
| F-13 | `environment` 表格 + `$penv{}`/`$env{}` 提示 | P1 | 与 `cacheVariables` 共用表格组件 | 3 |
| F-14 | 新建预设向导 / 从现有配置派生 | P1 | 模板：VS 多配置、Ninja、CI；命名冲突即时提示 | 4 |
| F-15 | 与 CMake Tools 联动（Configure/Build/Test） | P1 | 保存后在 UI 内直接跑一次校验式 Configure；失败输出回填 | 3 |
| F-16 | 语义 lint（超出 schema 的规则） | P1 | 见 §4.6 规则表：二义配置、跨平台字段冲突、`binaryDir` 冲突、孤儿预设等 | 4 |
| F-17 | 提升/下沉预设（项目 ↔ 用户文件） | P2 | 迁移时保留 `vendor` 未知字段 | 3 |
| F-18 | 矩阵批量生成（Debug/Release × x64/ARM64 …） | P2 | 生成后仍可在表单里逐条微调 | 5 |
| F-19 | 版本迁移（v7 → v10 等）与变更说明 | P2 | 只做"逐条提示 + 显式确认"，不静默改写 | 3 |
| F-20 | 团队模板库 / 片段收藏 | P2 | 从 `.vscode/cmake-presets-snippets` 读取 | 4 |
| F-21 | `cacheVariables` 名称/取值智能提示 | P1 | 输入 `CMAKE_` 列出内置变量并带类型与说明；选中后自动补 `type`；`BOOL` 与常见枚举给出取值建议（详见 §4.12） | 5 |

### 2.3 非功能需求

| 维度 | 要求 |
|---|---|
| 格式保真 | 保存后**只有被修改的行发生变化**；缩进风格（Tab/空格）、键顺序、`vendor`/`$schema`/未知键、`$comment` 全部保留 |
| 撤销 | 一次 UI 操作 = 一次 `editor.edit()` = 一次 Ctrl+Z |
| 外部修改 | 用户在 JSON 里改、`git checkout`、其他扩展改文件时，UI 自动重载且不覆盖用户输入 |
| 性能 | 5000 行 / 200 个预设的文件，首屏 < 1s，单次编辑重渲染 < 16ms |
| 国际化 | 中（简）/ 英双语，走 VSCode `nls` 机制，跟随编辑器语言 |
| 兼容性 | VSCode ≥ 1.85；CMake ≥ 3.19（按文件 `version` 决定可用字段）；Win/macOS/Linux |
| 安全 | Webview 严格 CSP + nonce，不加载远程资源；不采集任何遥测/项目内容 |
| 降级 | JSON 语法错误时 UI 只读并给出错误定位，不阻塞用户改回文本 |

### 2.4 明确的非目标（防止范围蔓延）

- 不做 CMake 语言服务（语法高亮、跳转、变量补全）——CMake Tools 已有。
- 不做通用的 `CMakeLists.txt` 可视化编辑。
- 不做编译器/Kit 探测与工具链管理——那是 CMake Tools 的职责。
- 不做远程/容器内的预设编辑（走 VSCode Remote 自然可用，但不额外适配）。
- 不追求"表单覆盖一切"：**任何字段都必须能通过"打开原始 JSON"编辑**，这是硬性兜底。

---

## 3. 形态选型

### 3.1 候选方案对比

| 方案 | 集成度 | 开发成本 | 关键风险 | 结论 |
|---|---|---|---|---|
| **A. VSCode 扩展 + 自定义编辑器（CustomTextEditor）** | ★★★★★ 原生撤销/脏标记/保存/diff | 中 | 需自己实现双向同步 | **推荐** |
| B. VSCode 扩展 + 侧边 Webview 面板 | ★★★★ | 中 | 面板与文档是两份状态，易不同步；无脏标记 | 备选（可作为"停靠式"形态） |
| C. 本地 Web 应用（Node 起服务 + 浏览器打开） | ★★ 无撤销、无编辑器联动 | 低 | 端口/文件监听/权限；与 VSCode 割裂 | 适合做原型，不适合日常用 |
| D. 独立桌面端（Tauri/Electron） | ★ | 高 | 重复实现编辑器能力，维护成本翻倍 | 不推荐 |
| E. 直接给 CMake Tools 提 PR | ★★★★★ | 极高（上游评审周期不可控） | 排期不可控 | 长期可选 |

**选 A 的理由**：预设编辑的本质是"改一个文本文件"，而 VSCode 已经把这套（脏标记、撤销栈、热退出、多人协作、git 集成）做到了极致。自定义编辑器能完整继承这些能力，UI 只是"另一个视图"。

### 3.2 和 CMake Tools 的关系

CMake Tools（本机已装 `ms-vscode.cmake-tools@1.24.42`）已经提供了：

- Presets 的读取、执行（Configure/Build/Test/Package/Workflow）；
- 编辑器内的 schema 补全与悬停（`schemas/CMakePresets-v*-schema.json`，本机到 v11）；
- 侧边栏的预设树与状态栏切换。

它**没有**的是"结构化编辑"：改 preset 仍然只能手写 JSON。所以本扩展的定位是 **CMake Tools 的编辑层补充**，而不是替代：

```
CMake Tools：发现 → 解析 → 执行 → 状态展示
本扩展    ：结构化编辑 → 校验 → 保存（交给 CMake Tools 去执行）
```

需要注意：CMake Tools 1.24.42 自带的 schema 只到 **v11**，而本机 CMake 4.4 已支持 **v12**。这正好是本扩展要补的洞——schema 应优先从**本机 CMake 安装目录**读取（见 §4.3）。

### 3.3 现成方案调研（build vs buy）

| 方案 | 能否结构化编辑 | 结论 |
|---|---|---|
| CMake Tools（官方） | ✗ 只有 schema 补全/悬停 | 无法满足 |
| CLion | ✓ 设置面板里可视化编辑 presets | **最好的参考对象**，功能对标它即可（不在 VSCode 生态内） |
| Marketplace 第三方扩展 | 未检索到成熟的专门方案 | 动手前再确认一次，避免重复造轮子 |
| 通用 JSON Schema 表单工具（如 vanilla-jsoneditor） | △ 能生成表单，但不懂继承/引用/宏 | 可作为"高级字段"兜底，不适合做主界面 |

结论：**自研有空间**，但要接受"官方补齐后价值下降"的风险（见 §6）；CLion 的预设面板可以直接当作功能清单来对标（[CLion: CMake presets](https://www.jetbrains.com/help/clion/cmake-presets.html)）。

---

## 4. 技术方案

### 4.1 总体架构

```
┌ VSCode 扩展宿主（Node 进程）
│  CMakePresetsEditorProvider（CustomTextEditorProvider）
│    ├─ DocumentStore      持有 TextDocument —— 唯一真相
│    ├─ EditApplier        jsonc-parser → TextEditor.edit()（最小文本编辑）
│    ├─ PresetResolver     include 链 / inherits 展开 / 有效值 / 环检测
│    ├─ Validator          L1 语法 → L2 schema(ajv) → L3 语义 → L4 cmake 实测
│    └─ CmakeBridge        cmake --help 生成器列表、--list-presets、CMake Tools API
└──────────┬───────────────────────────────────────────────▲──────────
           │ postMessage: init / update / apply / validate   │
           ▼                                                 │
┌ Webview（React + Vite）
│  不可变 Model → 选择器 → 表单渲染器（schema 驱动 + 手写 widget 覆盖）
│  ├─ 左：预设树（分组、搜索、隐藏标记）
│  ├─ 中：表单（基础 / 生成器 / 变量表 / 环境 / 条件 / 高级折叠）
│  └─ 右：JSON 预览 + 问题列表
└──────────────────────────────────────────────────────────
```

### 4.2 关键决策一：单一真相 = `TextDocument`（文本级增量编辑）

这是整个方案里最重要的一个决定。**不要让 UI 状态和文件内容各存一份**。

流程：

```
用户改一个字段
   → webview 发送 { type:'apply', baseVersion: 12, ops:[{path:['configurePresets',0,'binaryDir'], value:'…'}] }
   → 扩展校验 baseVersion（过期则忽略并回推最新文档）
   → jsonc.modify(text, path, value, { formattingOptions })  // 只产出局部 edits
   → 把每个 edit 映射成 vscode.Range 替换
   → editor.edit(b => 逐个 replace)                            // 一次 edit = 一个撤销步
   → onDidChangeTextDocument 回来，带上新 version 与解析结果
   → webview 局部重渲染
```

好处：

- 撤销/重做、脏标记、热退出、`git diff` 全部免费；
- 用户的 `vendor` 字段、未知键、缩进、键顺序**原样保留**（`jsonc.modify` 只改目标路径）；
- 用户在 JSON 里同时编辑（分屏）也不会丢数据，最多"以最后一次文本为准"。

关键实现细节（这些坑要在 M0 里验证）：

1. 用 `TextEditor.edit()` 而不是 `WorkspaceEdit`，才能进**该编辑器**的撤销栈。
2. `formattingOptions` 从 `editor.options`（`insertSpaces`/`tabSize`）读取，demo 文件是 Tab 缩进，必须识别。
3. 每个 op 携带 `baseVersion`；`document.version` 不匹配就丢弃（避免"撤销后 UI 又改回去"的鬼畜现象）。
4. 批量操作（如"重命名 + 改写 3 处引用"）要合并成**一次** `editor.edit()`，否则用户要按 4 次撤销。
5. `text` 长度大时（>1MB）改用 `WorkspaceEdit` 分片，避免单次替换卡顿（后续优化）。

### 4.3 关键决策二：schema 驱动表单，而不是手写表单

CMake 官方提供机器可读 schema（本机路径见文末），结构形如：

```json
{ "oneOf": [ { "properties": { "version": { "const": 1 }, … } }, … ] }
```

并且每个版本分支通过 `$ref: "#/definitions/configurePresets@v3..v6"` 指向字段定义——**天然带版本区间**。

三种利用方式：

| 用途 | 做法 |
|---|---|
| 表单生成 | 构建期脚本把 schema 归一化成"UI 模型"（字段、类型、版本区间、描述、枚举），产物提交到仓库 `src/schema/ui-model.json` |
| 校验 | 运行时用 `ajv` 直接跑官方 schema，错误定位到 `instancePath` |
| 兜底 | 未知/新字段用通用 JSON 编辑器（键值树）渲染，保证不丢字段 |

**schema 三级来源**（优先级从高到低）：

1. 本机 CMake 安装目录：`<cmake>/share/cmake-*/Help/manual/presets/schema.json`（随 CMake 版本自动升级，本机 4.4 已到 v12）；
2. 扩展内置副本（打包时从 CI 的 CMake 抓取，离线可用）；
3. 用户配置项覆盖路径（企业内网/特殊分支）。

**注意**：官方 schema 的 `oneOf` 是按 `version` 分叉的，运行时必须先读根 `version` 再选分支；v12 之后还可能继续增加，所以 `ui-model` 生成脚本要放进 CI，每周跑一次 diff 报警。

### 4.4 数据模型（节选）

```ts
type PresetKind = 'configure' | 'build' | 'test' | 'package' | 'workflow';

interface FieldMeta {
  key: string;
  label: string;
  kind: 'string' | 'bool' | 'enum' | 'path' | 'list' | 'map' | 'object';
  since: number;            // 引入该字段的 preset version
  widget?: 'generator' | 'architecture' | 'cacheVars' | 'env' | 'condition';
  inherited: boolean;       // 是否可被 inherits 继承
  advanced?: boolean;       // 默认折叠
}

interface PresetNode {
  kind: PresetKind;
  index: number;            // 在数组中的位置（编辑用）
  raw: Record<string, unknown>;
  jsonPointer: string;      // 如 /configurePresets/0
  file: vscode.Uri;
}
```

### 4.5 继承解析器（核心算法）

语义要点（全部来自官方文档，实现时逐条写单测）：

1. `inherits` 可以是字符串或数组；**数组里靠前的优先**。
2. `name`、`hidden`、`inherits`、`description`、`displayName` **不继承**。
3. `cacheVariables` / `environment` 是**并集**：子预设覆盖父预设；值为 `null` 表示"取消设置"（即使父级有值）。
4. `condition` 为 `null` 时预设可用，但**不向下继承** `null`；子条件里不允许 `null`。
5. `hidden` 预设可以没有 `generator` / `binaryDir`。
6. 只能继承**同文件或 include 链内**的预设；`CMakeUserPresets.json` 隐式包含 `CMakePresets.json`，反之不行。
7. 宏在**使用该预设的上下文**里展开（`${presetName}` 取当前预设名，不是父预设名）；`${fileDir}` 在 v12 起改为按宏所在文件展开。
8. include 环、继承环都必须检测并报错。

伪代码：

```
resolve(kind, name):
  node = lookup(kind, name)            // 跨 include 链
  if visiting(node) → error 环
  acc = {}
  for parent in node.inherits (从左到右):
      if acc 已有该键 → 跳过（先出现者优先）
      acc[key] = resolve(parent)[key]
  merge(node.raw, acc)                 // cacheVariables/environment 特判并集+null
  evaluateCondition(node.condition)
  return acc
```

UI 层：每个字段旁边显示"来自 `VS2022`"或"本预设覆盖"，并提供"恢复继承值"按钮。

### 4.6 校验分层

| 层 | 时机 | 内容 | 依赖 |
|---|---|---|---|
| L1 语法 | 输入即校验 | JSON 合法性、重复键、尾逗号、`//` 注释（CMake **不支持** `//` 注释，v10 起用 `$comment` 字段，要专门提示） | `jsonc-parser` |
| L2 schema | 输入即校验（防抖 300ms） | 官方 schema + `version` 分支；未知字段、类型错误、版本越级 | `ajv` |
| L3 语义 | 保存后 / 手动 | 见下表 | `PresetResolver` |
| L4 实测 | 手动"验证"按钮 / 保存后可选 | `cmake --list-presets=all`（能捕获 CMake 自己的解析错误，不需要 `CMakeLists.txt`） | 本机 `cmake` |

L3 语义规则（这些是"schema 管不到、CMake 只会在运行时报错"的）：

| 规则 | 级别 |
|---|---|
| configure 预设名在同一目录下（两份文件合并后）重复 | error |
| `inherits` / `configurePreset` / `steps[].name` 指向不存在的预设 | error |
| 非 `hidden` 且缺 `generator` 或 `binaryDir`：version < 3 为 error，v3+ 仅 info（CMake 自动推导） | error / info |
| include 环、继承环 | error |
| 两个可见 configure 预设 `binaryDir` 相同且 generator 不同 | warning（会互相覆盖缓存） |
| 生成器与字段不匹配（如 `Unix Makefiles` 配 `CMAKE_GENERATOR_PLATFORM`） | warning |
| `hidden` 预设没有任何子预设引用（孤儿） | info |
| `toolchainFile` 指向的文件不存在 | warning |
| 宏语法错误（`${sourceDir` 缺右括号） | error |
| 预设版本高于本机 CMake 支持的最大版本 | warning（换机器会失败） |

### 4.7 交互设计

三栏布局（与原型一致）：

```
┌ 顶栏：文件 · version · 校验 · 运行 Configure · 在 JSON 中打开
├ 左栏（预设树）           ├ 中栏（表单）                    ├ 右栏
│ · 配置预设               │ 名称 / 显示名 / 隐藏 / 继承自     │ JSON 预览
│   · VS2022               │ 生成器 / 架构 / 输出目录          │
│   · linux                │ ── 缓存变量（表格）──             │ 问题列表
│ · 构建预设               │ ── 环境变量（表格）──             │
│   · Release / Debug      │ 有效配置（含继承，只读）           │
│ + 新建预设               │                                  │
```

交互细节（容易被忽略、但决定好不好用）：

1. **重命名联动**：改 `name` 时，扫描 `inherits`、`configurePreset`、`steps[]`，弹确认"将同时更新 3 处引用"。不联动就一定会产生断链。
2. **删除保护**：删除被引用预设时，列出引用者，提供"一并删除/先解除引用"。
3. **继承字段只读化**：从父级继承来的值灰显 + 来源标签 + "覆盖"按钮；避免用户误以为改的是父级。
4. **`null` 的专门表达**：`cacheVariables` 里"取消设置"是合法且常见的，UI 要给明确的"不设置（null）"选项，而不是空字符串。
5. **宏补全**：输入 `$` 弹出 `${sourceDir}`、`${presetName}`、`$env{…}`、`$penv{…}` 等，并显示展开后的示例值（变量名补全见 §4.12）。
6. **高级字段折叠**：`warnings`/`errors`/`debug`/`trace`/`vendor`/`graphviz` 默认收进"高级"，保证首屏清爽，同时 100% 可达。
7. **键盘优先**：`Ctrl+N` 新建、`F2` 重命名、`Delete` 删除、`Ctrl+Z` 撤销、`Ctrl+Shift+P` 命令面板。
8. **空态与错误态**：文件不存在 → 提供"创建 CMakePresets.json 模板"；文件非法 → 只读 + 跳到错误行。

### 4.8 命令与入口

| 命令 ID | 标题（中） | 说明 |
|---|---|---|
| `cmakePresets.openEditor` | CMake Presets: 打开可视化编辑器 | 命令面板 / 资源管理器右键 |
| `cmakePresets.createFile` | CMake Presets: 新建预设文件… | 生成含 `version`/`cmakeMinimumRequired` 的最小文件 |
| `cmakePresets.addPreset` | CMake Presets: 新增预设… | 按类型向导 |
| `cmakePresets.validate` | CMake Presets: 校验当前文件 | 触发 L1–L4 |
| `cmakePresets.runConfigure` | CMake Presets: 用当前预设 Configure | 走 CMake Tools API 或 `cmake --preset` |
| `cmakePresets.switchToJson` | CMake Presets: 在 JSON 编辑器中打开 | 兜底入口 |

`contributes.customEditors` 的 `priority` 建议设为 `"option"`（不抢默认打开方式），避免打扰只想看文本的用户。

### 4.9 可靠性与性能

- **编辑冲突**：`baseVersion` 机制 + 文档变化时回推全量快照；webview 重置选择状态而不是重置滚动位置。
- **大文件**：预设列表虚拟滚动；表单只渲染当前预设；JSON 预览超过 2000 行时降级为"摘要 + 打开原文"。
- **崩溃隔离**：webview 挂了不影响文档；扩展重启后按打开的文件恢复。
- **不可用环境**：没装 CMake 时，生成器下拉退化为内置静态列表，L4 校验禁用并提示。

### 4.10 目录结构与技术栈

```
cmake-presets-editor/
├── package.json                 # 扩展清单：commands / customEditors / configuration
├── src/
│   ├── extension.ts
│   ├── editorProvider.ts        # CustomTextEditorProvider
│   ├── documentStore.ts         # 文档同步 + 版本守卫
│   ├── editApplier.ts           # jsonc-parser → TextEditor.edit
│   ├── resolver/                # include 链、继承、有效值、环检测
│   ├── validator/               # L1–L4
│   ├── schema/ui-model.json     # 由 scripts/gen-ui-model.ts 生成
│   └── cmake/                   # 生成器列表、--list-presets、CMake Tools API 桥
├── webview/                     # React + Vite（复用原型的信息架构）
│   ├── components/PresetTree.tsx
│   ├── components/Form.tsx
│   ├── components/CacheVarsTable.tsx
│   ├── components/ConditionBuilder.tsx
│   └── components/JsonPreview.tsx
├── scripts/gen-ui-model.ts
└── test/
    ├── unit/                    # 解析器 / 校验 / 编辑应用
    ├── e2e/                     # vscode-test
    └── fixtures/                # 各版本样例（v2 … v12）
```

技术栈：TypeScript + React 18 + Vite + `jsonc-parser` + `ajv` + `vscode-test`；UI 不引入重型组件库（体积与主题适配），用 CSS 变量对接 VSCode 主题色（`--vscode-editor-background` 等）。

### 4.11 关键代码骨架

自定义编辑器注册（`package.json`）：

```json
"contributes": {
  "customEditors": [{
    "viewType": "cmakePresets.editor",
    "displayName": "CMake Presets 编辑器",
    "selector": [{ "filenamePattern": "**/{CMakePresets,CMakeUserPresets}.json" }],
    "priority": "option"
  }]
}
```

最小编辑应用：

```ts
import * as jsonc from 'jsonc-parser';
import * as vscode from 'vscode';

export async function applyOp(
  editor: vscode.TextEditor,
  path: jsonc.JSONPath,
  value: unknown
): Promise<boolean> {
  const doc = editor.document;
  const text = doc.getText();
  const opts: jsonc.FormattingOptions = {
    insertSpaces: editor.options.insertSpaces as boolean,
    tabSize: Number(editor.options.tabSize) || 4,
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
  };
  const edits = jsonc.modify(text, path, value, { formattingOptions: opts });
  const next = jsonc.applyEdits(text, edits);
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
  // 用编辑器自己的 edit，才能进撤销栈
  return editor.edit((b) => b.replace(full, next));
}
```

> 注意：上面为了可读性用了"整篇替换"，但 `jsonc.modify` 返回的 edits 是精确到字符范围的。生产实现应逐个 edit 应用（或按行合并），这样才会出现"只改了一行"的 git diff。

### 4.12 变量智能提示（`cacheVariables` 的名称与取值）

这是"能不能替代手写 JSON"的关键体验：**敲 `CMAKE_` 就要能补全，并且告诉我这个变量是干什么的、什么类型、有哪些常见取值**。

#### 数据源（按优先级合并、去重后排序）

| 优先级 | 来源 | 能拿到什么 | 实现要点 |
|---|---|---|---|
| 1 | 项目现有的 `CMakeCache.txt`（`<binaryDir>/CMakeCache.txt`） | 变量名、类型、help 注释、是否 advanced | 解析 `//help` 注释 + `NAME:TYPE=VALUE`，代码量很小；也可以读 CMake File API 的 `cache-v1.json` |
| 2 | 项目 `CMakeLists.txt` / `*.cmake` 里的 `set(... CACHE ...)` 与 `option()` | 项目自定义变量（例如 `LIBRARIES_DIR`、`APP_LANGUAGE`） | 轻量正则扫描，不追求完整解析语义，够用即可 |
| 3 | 当前文件 / `CMakeUserPresets.json` 已出现的变量 | 团队约定与常用变量 | 直接遍历 `cacheVariables` |
| 4 | CMake 内置变量文档 | 变量名 + 一句话说明 | 读 `<cmake>/share/cmake-*/Help/variable/*.rst`（本机 810 个），或 `cmake --help-variable-list` + `cmake --help-variable <name>` |
| 5 | CMake 模块产生的变量（`OpenCV_DIR`、`Boost_ROOT` 等） | 依赖相关变量 | 无法静态枚举，靠第 1 项与 `--help-module` 补充 |

> 官方文档不给"cache 类型"，需要一张约 60 条的手工映射表，把常见变量映射到 `BOOL/STRING/PATH/FILEPATH`，用于自动填充类型列。

#### 交互设计

- 名称输入 ≥1 个字符即弹出候选，排序为"常用 → 项目自定义 → 本文件已用 → 内置"，最多 8 条；
- 每条显示：名称、类型徽标、一句话说明（中文，缺翻译时回退英文原文）；
- 选中后：填入名称、**自动补 `type`**（如 `CMAKE_INSTALL_PREFIX` → `PATH`）、焦点保持；
- 取值输入：`BOOL` 给 `ON/OFF`；`CMAKE_BUILD_TYPE` 给四类标准配置；`CMAKE_CXX_STANDARD` 给标准版本；`CMAKE_*_COMPILER_LAUNCHER` 给 `ccache/sccache`；
- 输入 `$` 自动切换到宏补全（`${sourceDir}`、`${presetName}`、`$env{}`、`$penv{}`）；
- 键盘：↑↓ 选择、Enter 采纳、Esc 关闭、Tab 跳到下一格。

**不建议写进 `cacheVariables` 的变量**：`CMAKE_GENERATOR`、`CMAKE_GENERATOR_PLATFORM`、`CMAKE_GENERATOR_TOOLSET`、`CMAKE_TOOLCHAIN_FILE`——它们分别有预设字段 `generator` / `architecture` / `toolset` / `toolchainFile` 对应。补全列表里应把它们标注为"改用预设字段"，而不是只给个名字。你 demo 里 `linux` 预设的 `CMAKE_GENERATOR_PLATFORM` 正是这类写法。

#### 降级与性能

- 没装 CMake 或找不到文档目录：只用内置静态表 + 文件内已用变量，功能不报错；
- 数据在内存缓存，`CMakeCache.txt` 用文件监听失效；839 条全量解析 < 200ms，单次补全查询 < 5ms；
- 只读本地文件，不上传任何内容。

> 交互原型里已经实现了简化版：名称补全、类型自动填充、`BOOL`/枚举取值建议、键盘操作（数据来自下面的真实生成结果）。

#### 已实测的数据质量（本机 CMake 4.4.0-rc2）

不是估算，是已经跑出来的：`tools/var-catalog` 解析了本机 CMake 自带的全部变量文档。

| 指标 | 结果 |
|---|---|
| 文档文件 | 810 |
| 可用变量 | **839**（其中 `CMAKE_<LANG>_*` 实例化成 C/C++ 共 172 条） |
| 有 cache 类型 | 64 |
| 常用变量 | 12 |
| 空说明 | 0 |

```bash
node tools/var-catalog/index.mjs build --prototype docs/prototype/variables.js
node tools/var-catalog/index.mjs serve --port 4848   # 浏览器里搜 CMAKE_
```

解析时踩到的四类坑，工具里都已处理：`.. include::` 公共片段、`|FIND_XXX|` 占位替换、`CMAKE_<LANG>_*` 模板实例化、RST 角色清洗（详见 `tools/var-catalog/README.md`）。

> 这一步也验证了**类型覆盖率是最大短板**（64/839）：官方文档不写 cache 类型，只能靠那张约 60 条的手工映射表。所以 UI 必须接受"没有类型"这个状态，而不是硬猜——猜错会让自动填充把用户带沟里。

---

## 5. 实施计划

### 5.1 WBS 与工时

| 阶段 | 模块 | 内容 | 人日 |
|---|---|---|---|
| M0 | 技术验证 | webview CSP/消息、`jsonc.modify` 保真度、撤销栈行为、CMake Tools API 探测、schema 解析 spike | 3 |
| M1 | 扩展骨架 | 清单、激活、自定义编辑器、命令、配置项、i18n 管道、日志 | 4 |
| M1 | 文档同步层 | 双向同步、版本守卫、外部修改、非法 JSON 降级、错误定位 | 4 |
| M1 | 表单与列表（MVP 子集） | configure/build 常用字段 + 缓存变量表 + CRUD | 8 |
| M1 | 校验（MVP 子集） | L1/L2 + 引用完整性 | 3 |
| M2 | schema 层 | UI 模型生成、三级来源、CI 一致性检查 | 5 |
| M2 | 继承解析 | include 链、隐式用户文件、优先级/`null`/`hidden`/`condition`、环检测、有效值 | 6 |
| M2 | 全类型表单 | build/test/package/workflow + 条件构建器 + 环境表 | 8 |
| M2 | 预设 CRUD 增强 | 向导、重命名联动、删除保护、提升/下沉、版本迁移 | 5 |
| M2 | 语义 lint（L3）与实测（L4） | 规则表实现、问题面板、快速修复 | 4 |
| M2 | 变量智能提示 | 变量目录生成（CMake 文档 / CMakeCache / CMakeLists 扫描）+ 补全 UI + 类型联动 | 5 |
| M3 | CMake Tools 集成 | Configure/Build/Test 触发、生成器列表、从当前配置反推预设 | 3 |
| M3 | 测试 | 单测（解析/校验/同步）、e2e、黄金用例、跨版本 fixture | 6 |
| M3 | 文档与发布 | README、使用手册、示例工程、打包、内测反馈 | 2 |
| | **合计** | | **66** |

含 15% 缓冲 ≈ **76 人日**；按 1 人 4.5 有效人日/周 ≈ **15–17 周**，双人并行 ≈ **7–8 周**。

> 如果你是单人业余推进，建议只做表中 M0 + M1 + M2 的"schema 层 + 继承解析 + 全类型表单 + 变量提示"，约 **46 人日**（单人约 10 周），其余靠后续迭代。
>
> 说明：§2.2 的功能级工时是按功能拆分的粗估，与 §5.1 的模块级 WBS 已做合并去重，两者不逐项相等。

### 5.2 里程碑与演示脚本

| 里程碑 | 时间（双人） | 交付物 | 演示脚本 |
|---|---|---|---|
| M0 | 第 1 周 | 交互原型 + 技术验证报告 | 打开 demo，改 `binaryDir`，`git diff` 只有一行变化；Ctrl+Z 一次回退 |
| M1 | 第 2–4 周 | 可安装 VSIX（MVP） | 新建 `Ninja-Debug`、复制 `VS2022`、删除 `linux`、保存后 CMake Tools 能列出新预设 |
| M2 | 第 5–8 周 | V1 | 打开含 `include` + `inherits` 的工程，看到有效值来源；`condition` 可视化编辑；语义问题一键定位 |
| M3 | 第 9–10 周 | 正式版 + 文档 | 全新机器安装 → 5 分钟上手；CI 跑通全部测试 |

### 5.3 测试策略

- **单元**：解析器用"输入 JSON + 期望有效值"表驱动；编辑应用断言"输出文本的 diff 只落在目标区间"。
- **黄金用例**：直接借鉴 CMake 源码 `Tests/RunCMake/presets/*` 的用例结构（含错误场景），避免自己臆造语义。
- **属性测试**：随机生成预设树 → 我们的解析结果 vs `cmake --list-presets=all` 的可列举集合，保证不"发明"CMake 没有的行为。
- **e2e**：`vscode-test` 打开 fixture → 点击表单 → 保存 → 断言文件字节级 diff。
- **兼容矩阵**：Windows / macOS / Linux × CMake 3.20 / 3.27 / 4.4 × 文件版本 v2–v12。

### 5.4 发布

- 内部：`vsce package` 出 `.vsix`，走内网共享盘或私有扩展库；
- 公开：Marketplace（需 publisher、图标、README、CHANGELOG、LICENSE），可选 Open VSX；
- 版本策略：扩展主版本跟随支持的 schema 最高版本，例如 `2.x` 支持到 v12。

---

## 6. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| CMake Tools 官方后续自己做 UI | 中 | 高 | 定位为"编辑层"，即使被取代，解析器/校验层仍可复用；先内部自用验证价值 |
| 继承语义实现偏差、"以为对其实错" | 中 | 高 | 黄金用例 + `cmake --list-presets` 交叉验证；拿不准的语义宁可只展示不自动改 |
| 破坏用户格式 / 丢字段 | 中 | 高 | 文本级最小编辑 + 未知字段原样保留 + 字节级 diff 测试 |
| schema 持续演进（已到 v12） | 高 | 中 | 运行时读本机 schema + CI 周检 |
| 用户嫌表单不如 JSON 灵活 | 中 | 高 | 高级字段折叠、随时切 JSON、不阻塞保存 |
| 双源冲突（分屏同时编辑） | 中 | 中 | 版本守卫 + 冲突时以文本为准 + 明确提示 |
| 范围蔓延成"CMake IDE" | 高 | 高 | §2.4 非目标清单 + 里程碑卡点 |
| 大工程预设数量多导致卡顿 | 低 | 中 | 虚拟列表、按需渲染、性能预算（首屏 1s） |
| 变量说明的翻译/维护成本 | 中 | 低 | 说明优先沿用 CMake 原文，中文做覆盖表；缺翻译时只显示名称与类型 |
| 跨平台路径/大小写差异 | 中 | 低 | 路径比较统一 `path.win32/posix` 分支，测试覆盖 |

---

## 7. 成本汇总与建议

| 方案 | 内容 | 工期 | 适合 |
|---|---|---|---|
| 轻量 | 只做"预设列表 + configure/build 表单 + 校验"，不做继承/条件 | 22 人日 | 先解决"改配置要翻文档"的痛点 |
| **推荐** | MVP → V1（全类型 + 继承 + 校验 + 变量提示 + CMake Tools 联动） | 66–76 人日 | 团队长期使用 |
| 完整 | V1 + 矩阵生成 + 模板库 + 版本迁移 | 85+ 人日 | 平台/工具链团队 |

**建议路径**：

1. 本周：用附带原型和团队对一次交互（30 分钟），确认字段优先级；
2. 第 1 周：做 M0 技术验证（重点验证"格式保真 + 撤销"这两个生死点）；
3. 第 2–4 周：MVP（双人），先在自己项目（含这个 demo）里日用；
4. 用 2 周真实反馈决定是否投入 V1。

**判断是否值得做的标准**：如果团队里"改预设"的频率低于每人每月 1 次，直接给 JSON 加 schema 补全（CMake Tools 已具备）就够了，不必开发。

---

## 8. 验收标准（V1）

- [ ] 打开 `demo/CMakePresets.json` 默认不劫持，但右键可进可视化编辑器。
- [ ] 修改 `binaryDir` 后保存，`git diff` 只显示该行；Tab 缩进不变。
- [ ] 重命名 `VS2022` → 三个 build preset 的 `configurePreset` 同步更新，一次撤销可回退。
- [ ] 删除被引用的预设时，明确列出引用者并阻止误删。
- [ ] 继承值在表单中灰显并标注来源；`null` 取消继承有专门控件。
- [ ] 手写坏 JSON 后 UI 只读且能定位到行，不丢用户内容。
- [ ] 保存后 CMake Tools 的预设列表立即出现新预设，`cmake --list-presets=all` 无报错。
- [ ] v7 文件里不出现 v10 字段选项；升级版本时给出字段变更提示。
- [ ] 在缓存变量名输入 `CMAKE_` 能列出内置变量与说明，选中后类型自动填好；`BOOL` 值列给出 `ON/OFF`。
- [ ] 5000 行 / 200 预设的文件首屏 < 1s。
- [ ] 中英文界面完整，无硬编码中文。

---

## 9. 参考资料

- CMake Presets 官方手册（本机 4.4 版）：[cmake-presets.7.rst](<C:/Program Files/CMake/share/cmake-4.4/Help/manual/cmake-presets.7.rst>)
- 官方机器可读 schema（本机，已含 v12）：[schema.json](<C:/Program Files/CMake/share/cmake-4.4/Help/manual/presets/schema.json>)
- 完整示例文件：[example.json](<C:/Program Files/CMake/share/cmake-4.4/Help/manual/presets/example.json>)
- 在线文档：<https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html>
- CMake Tools 扩展（本机 1.24.42，自带 v3–v11 schema）：[ms-vscode.cmake-tools-1.24.42](<C:/Users/awe/.vscode/extensions/ms-vscode.cmake-tools-1.24.42>)
- 交互原型：[presets-editor.html](prototype/presets-editor.html)
- 变量目录工具（已实现，可独立运行）：[tools/var-catalog/README.md](../tools/var-catalog/README.md)

---

## 附录 A：交互原型说明

`docs/prototype/presets-editor.html` 是一个**零依赖、单文件**的可点击原型（双击用浏览器打开），刻意还原了本方案的三栏信息架构：

- 左侧：预设树（配置/构建分组、隐藏标记、搜索、新建）；
- 中间：表单（基础信息、生成器、缓存变量表格、环境变量表格、有效值预览）；
- 右侧：实时 JSON 预览 + 校验问题列表；
- 支持：新增、复制、重命名（联动引用）、删除、改字段、`hidden`、继承选择；
- 变量补全：缓存变量名输入 `CMAKE_` 弹出候选（带类型与说明），选中后自动补类型；值列给出 `ON/OFF`、`Debug/Release` 等建议，支持 ↑↓/Enter/Esc；
- 变量数据来自同目录的 `variables.js`（由 `tools/var-catalog` 生成，839 条本机 CMake 文档），缺失时回退到内置的 40 条示例。

原型用内存对象模拟，**不读写真实文件**，也不保证与最终实现一致；其价值在于确认"字段分组、继承呈现方式、问题提示位置"这些设计决策。

## 附录 B：给 demo 的修复建议

建议把 `linux` 改成下面这样（Unix Makefiles 不应带 MSVC 工具链和 VS 专属字段）：

```json
{
  "name": "linux",
  "displayName": "gcc",
  "generator": "Unix Makefiles",
  "binaryDir": "${sourceDir}/linux_build",
  "cacheVariables": {
    "APP_LANGUAGE": "CH",
    "LIBRARIES_DIR": "${sourceDir}"
  }
}
```

另建议补两条 build preset（`linux-Debug`/`linux-Release`），或直接用 workflow preset 把 configure+build 串起来。
