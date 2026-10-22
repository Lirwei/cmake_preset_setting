# CMake 变量目录（var-catalog）

把**本机 CMake 安装目录里的官方变量文档**变成可查询的数据和本地补全服务，用来验证「`cacheVariables` 智能提示」的数据质量，也给 VSCode 扩展和交互原型提供数据源。

零依赖，Node ≥ 18（本机 Node 24）。不联网、不执行项目构建。

## 快速开始

```bash
node index.mjs build          # 解析本机 CMake 文档 → dist/variables.json + dist/report.md
node index.mjs selftest       # 解析器自测
node index.mjs serve          # 打开 http://127.0.0.1:4848 的搜索页
node index.mjs search CMAKE_CXX_STANDARD   # 命令行查
```

生成给交互原型用的数据（会写进 `docs/prototype/variables.js`）：

```bash
node index.mjs build --prototype ../../docs/prototype/variables.js
```

扫描工程里的自定义变量与真实 cache：

```bash
node index.mjs project --dir /path/to/project
# 读 <dir>/CMakeCache.txt + CMakeLists.txt / *.cmake 里的 set(... CACHE ...) 与 option()
node index.mjs serve --project dist/project-vars.json
```

## 测试

三层，按成本从低到高：

| 层 | 命令 | 覆盖内容 | 通过标准 |
|---|---|---|---|
| 解析器自测 | `node index.mjs selftest` | RST 解析、`CMakeCache.txt` 解析、项目变量合并 | 4 项 PASS |
| 数据 + API | `node test/smoke.mjs` | 读真实文档建目录、数据质量、HTTP 三个接口、原型数据文件 | 12 项 PASS |
| 交互层 | `node test/prototype-smoke.mjs` | 无头 Edge/Chrome 真跑原型：输入 → 补全 → Esc/Enter → 类型自动填充 → JSON 同步 | 8 项 PASS |

一键全跑：

```bash
node index.mjs selftest && node test/smoke.mjs && node test/prototype-smoke.mjs
# 或
npm.cmd test
```

> Windows 上 `npm` 是 `npm.ps1`，默认执行策略会拦；用 `npm.cmd`，或直接 `node`。
> 交互层找不到浏览器时自动跳过（退出码 0），数据层仍然有效。

### 手动测试原型

1. 双击 `../../docs/prototype/presets-editor.html`（改了数据文件后 `Ctrl+F5` 强刷）；
2. 选中左侧 `VS2022`，在「缓存变量 → 名称」里输入 `CMAKE_`；
3. 应弹出候选（带类型徽标 + 英文说明），`↑↓` 选择、`Enter` 采纳；
4. 采纳 `CMAKE_BUILD_TYPE` 后，类型列自动变成 `STRING`，右侧 JSON 同步更新；
5. 右下「问题」应报出 `linux` 预设的 `CMAKE_GENERATOR_PLATFORM` 警告。

截图：`../../docs/prototype/preview.png`。

### 用自己的工程验证

```bash
node index.mjs project --dir D:\your\project
node index.mjs serve --project dist/project-vars.json
# 搜你的自定义变量名，看来源标记是不是 CMakeCache / CMakeLists
```

## 输出

| 文件 | 内容 |
|---|---|
| `dist/variables.json` | `{ meta, variables[] }`：名称、说明、类型、取值建议、是否常用、是否应改用预设字段、来源 |
| `dist/report.md` | 生成统计、抽样、解析告警 |
| `dist/project-vars.json` | 工程扫描结果（cache 条目、自定义变量、源文件清单） |
| `docs/prototype/variables.js` | `window.CMAKE_VARIABLES = [...]`，供原型通过 `<script src>` 加载 |

## 解析时处理了什么

CMake 的 `.rst` 并不是干净的纯文本，实际踩到的坑：

1. **标题式 vs 指令式**：99% 是 `NAME` + 下划线标题；少量文件用 `.. variable:: NAME` 分段。
2. **`.. include::` 公共片段**：如 `CMAKE_FIND_ROOT_PATH_MODE_PROGRAM` 的正文全在 `include/` 里，不展开就只剩空说明。
3. **`.. |FIND_XXX| replace::` 占位替换**：父文件定义、子片段使用，必须「先展开 include，再替换占位」。
4. **`CMAKE_<LANG>_*` 模板**：`CMAKE_CXX_COMPILER` 根本没有独立文档，必须从模板实例化（本工具生成 C / C++ 两套）。
5. **RST 角色**：`:variable:`、`:command:`、`:ref:`、``code``、`**bold**` 全部压成纯文本。
6. **只有指令没有正文**：如 `CTEST_CVS_CHECKOUT` 把说明写在 `.. deprecated::` 的缩进块里。

## 类型与常用变量

- `CMAKE_<LANG>_*` 实例化后，说明里的 `<LANG>_XXX` 用 `C/CXX`（标识符要准确），单独的 `<LANG>` 用 `C/C++`（读起来自然）。
- cache 类型官方文档不写，只有约 60 条手工映射（`lib/catalog.mjs` 的 `TYPE_MAP`）；剩余条目不猜类型，UI 显示为无类型。
- `HOT` 是排序用的常用表；`PREFER_PRESET_FIELD` 标记那些应该用预设字段（`generator`/`architecture`/`toolset`/`toolchainFile`）而不是写进 `cacheVariables` 的变量。

## 本机实测（CMake 4.4.0-rc2）

| 指标 | 结果 |
|---|---|
| 文档文件 | 810 |
| 可用变量 | 839 |
| `CMAKE_<LANG>_*` 实例化 | 172（C / C++） |
| 有 cache 类型 | 64 |
| 常用变量 | 12 |
| 空说明 | 0 |

## 已知边界

- 说明是 CMake 英文原文；中文需要另做覆盖表（扩展里做）。
- 类型覆盖率只有 64/839，这是**当前最大短板**，不是解析问题，而是官方文档本身不写类型。
- 模块变量（`OpenCV_DIR`、`Boost_ROOT`）无法静态枚举，只能从 `CMakeCache.txt` 或 `--help-module` 拿到。
- 只取第一段说明，个别长文档（如 `CMAKE_<LANG>_FLAGS_<CONFIG>`）不实例化。

## 目录

```
tools/var-catalog/
├── index.mjs              # CLI：build / project / serve / selftest / search
├── lib/rst.mjs            # RST 解析与清洗
├── lib/cmake-docs.mjs     # 定位 cmake 与文档目录、展开 include/占位
├── lib/catalog.mjs        # 类型表、常用表、黑名单、<LANG> 实例化
├── lib/project.mjs        # CMakeCache.txt 解析、CMakeLists 扫描
├── lib/server.mjs         # 本机搜索 API
├── public/index.html      # 验证页面
└── dist/                  # 生成物（已 gitignore）
```
