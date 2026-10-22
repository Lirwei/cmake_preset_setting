export interface CatalogEntry {
  name: string;
  type?: string | null;
  desc?: string;
  values?: string[];
  hot?: boolean;
  preferField?: string | null;
}

interface RawCatalog {
  variables?: unknown;
}

/** 把 tools/var-catalog 生成的 JSON 压成 webview 需要的最小结构。 */
export function slimCatalog(raw: unknown): CatalogEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as RawCatalog).variables;
  if (!Array.isArray(list)) return [];
  return list
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string')
    .map((v) => ({
      name: String(v.name),
      type: (v.type as string) || null,
      desc: typeof v.desc === 'string' ? v.desc : typeof v.summary === 'string' ? (v.summary as string) : '',
      values: Array.isArray(v.values) ? (v.values as string[]) : [],
      hot: !!v.hot,
      preferField: (v.preferField as string) || null,
    }));
}

/** 内置兜底：没有生成目录时至少能补全最常用的几个。 */
export const FALLBACK_CATALOG: CatalogEntry[] = [
  { name: 'CMAKE_BUILD_TYPE', type: 'STRING', desc: '单配置生成器的构建类型', values: ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'], hot: true },
  { name: 'CMAKE_INSTALL_PREFIX', type: 'PATH', desc: '安装根目录', hot: true },
  { name: 'CMAKE_TOOLCHAIN_FILE', type: 'FILEPATH', desc: '工具链文件路径', hot: true, preferField: 'toolchainFile' },
  { name: 'CMAKE_CXX_STANDARD', type: 'STRING', desc: 'C++ 标准版本', values: ['98', '11', '14', '17', '20', '23'], hot: true },
  { name: 'CMAKE_EXPORT_COMPILE_COMMANDS', type: 'BOOL', desc: '导出 compile_commands.json', hot: true },
  { name: 'CMAKE_PREFIX_PATH', type: 'PATH', desc: 'find_package 依赖前缀', hot: true },
  { name: 'BUILD_SHARED_LIBS', type: 'BOOL', desc: '默认构建动态库', hot: true },
  { name: 'CMAKE_GENERATOR_PLATFORM', type: 'STRING', desc: '改用预设的 architecture 字段', hot: false, preferField: 'architecture' },
];

/** 常见生成器兜底列表（优先用本机 cmake --help 解析出来的）。 */
export const FALLBACK_GENERATORS = [
  'Ninja',
  'Ninja Multi-Config',
  'Unix Makefiles',
  'MinGW Makefiles',
  'Visual Studio 17 2022',
  'Visual Studio 16 2019',
];
