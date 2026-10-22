/**
 * 变量目录的业务规则：
 *   - 手工类型表（CMake 文档不写 cache 类型，只能靠这张表补）；
 *   - 常用变量（排序靠前）；
 *   - 「应该用预设字段而不是 cacheVariables」的黑名单。
 */

/** 常见变量 -> cache 类型。只收录有把握的。 */
export const TYPE_MAP = {
  BUILD_SHARED_LIBS: 'BOOL',
  CMAKE_ARCHIVE_OUTPUT_DIRECTORY: 'PATH',
  CMAKE_AUTOMOC: 'BOOL',
  CMAKE_AUTORCC: 'BOOL',
  CMAKE_AUTOUIC: 'BOOL',
  CMAKE_BUILD_TYPE: 'STRING',
  CMAKE_CXX_STANDARD: 'STRING',
  CMAKE_CXX_STANDARD_REQUIRED: 'BOOL',
  CMAKE_CXX_EXTENSIONS: 'BOOL',
  CMAKE_C_COMPILER: 'FILEPATH',
  CMAKE_C_COMPILER_LAUNCHER: 'STRING',
  CMAKE_C_FLAGS: 'STRING',
  CMAKE_COLOR_DIAGNOSTICS: 'BOOL',
  CMAKE_COMPILE_WARNING_AS_ERROR: 'BOOL',
  CMAKE_CONFIGURATION_TYPES: 'STRING',
  CMAKE_CUDA_ARCHITECTURES: 'STRING',
  CMAKE_CUDA_COMPILER: 'FILEPATH',
  CMAKE_CUDA_STANDARD: 'STRING',
  CMAKE_CXX_COMPILER: 'FILEPATH',
  CMAKE_CXX_COMPILER_LAUNCHER: 'STRING',
  CMAKE_CXX_FLAGS: 'STRING',
  CMAKE_DEBUG_POSTFIX: 'STRING',
  CMAKE_EXPORT_COMPILE_COMMANDS: 'BOOL',
  CMAKE_EXPORT_PACKAGE_REGISTRY: 'BOOL',
  CMAKE_FIND_PACKAGE_PREFER_CONFIG: 'BOOL',
  CMAKE_GENERATOR: 'STRING',
  CMAKE_GENERATOR_PLATFORM: 'STRING',
  CMAKE_GENERATOR_TOOLSET: 'STRING',
  CMAKE_INSTALL_PREFIX: 'PATH',
  CMAKE_INSTALL_RPATH: 'STRING',
  CMAKE_INTERPROCEDURAL_OPTIMIZATION: 'BOOL',
  CMAKE_LIBRARY_OUTPUT_DIRECTORY: 'PATH',
  CMAKE_LINKER: 'FILEPATH',
  CMAKE_MAKE_PROGRAM: 'FILEPATH',
  CMAKE_MODULE_PATH: 'PATH',
  CMAKE_MSVC_RUNTIME_LIBRARY: 'STRING',
  CMAKE_NINJA_OUTPUT_PATH_PREFIX: 'STRING',
  CMAKE_OSX_ARCHITECTURES: 'STRING',
  CMAKE_OSX_DEPLOYMENT_TARGET: 'STRING',
  CMAKE_PDB_OUTPUT_DIRECTORY: 'PATH',
  CMAKE_POLICY_VERSION_MINIMUM: 'STRING',
  CMAKE_POSITION_INDEPENDENT_CODE: 'BOOL',
  CMAKE_PREFIX_PATH: 'PATH',
  CMAKE_RUNTIME_OUTPUT_DIRECTORY: 'PATH',
  CMAKE_SKIP_RPATH: 'BOOL',
  CMAKE_SYSROOT: 'PATH',
  CMAKE_TOOLCHAIN_FILE: 'FILEPATH',
  CMAKE_UNITY_BUILD: 'BOOL',
  CMAKE_UNITY_BUILD_BATCH_SIZE: 'STRING',
  CMAKE_VERBOSE_MAKEFILE: 'BOOL',
  CMAKE_VISIBILITY_INLINES_HIDDEN: 'BOOL',
  CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS: 'BOOL',
  CMAKE_CXX_VISIBILITY_PRESET: 'STRING',
  CMAKE_C_VISIBILITY_PRESET: 'STRING',
  CMAKE_INSTALL_RPATH_USE_LINK_PATH: 'BOOL',
  CMAKE_BUILD_WITH_INSTALL_RPATH: 'BOOL',
};

/** 常用变量：补全列表里排最前。 */
export const HOT = [
  'CMAKE_BUILD_TYPE',
  'CMAKE_INSTALL_PREFIX',
  'CMAKE_TOOLCHAIN_FILE',
  'CMAKE_CXX_STANDARD',
  'CMAKE_CXX_STANDARD_REQUIRED',
  'CMAKE_EXPORT_COMPILE_COMMANDS',
  'CMAKE_PREFIX_PATH',
  'CMAKE_C_COMPILER',
  'CMAKE_CXX_COMPILER',
  'BUILD_SHARED_LIBS',
  'CMAKE_MSVC_RUNTIME_LIBRARY',
  'CMAKE_POSITION_INDEPENDENT_CODE',
];

/**
 * 这些变量有对应的预设字段，写进 cacheVariables 是坏味道。
 * value 是替代建议。
 */
export const PREFER_PRESET_FIELD = {
  CMAKE_GENERATOR: 'generator',
  CMAKE_GENERATOR_PLATFORM: 'architecture',
  CMAKE_GENERATOR_TOOLSET: 'toolset',
  CMAKE_TOOLCHAIN_FILE: 'toolchainFile',
};

/** 给单个变量补上类型/常用标记/黑名单提示。 */
export function enrich(v) {
  const type = TYPE_MAP[v.name] || inferType(v);
  const prefer = PREFER_PRESET_FIELD[v.name] || null;
  return {
    ...v,
    type: type || null,
    hot: HOT.includes(v.name),
    preferField: prefer,
    values: v.values && v.values.length ? v.values : defaultValues(v.name, type),
  };
}

function inferType(v) {
  const s = (v.summary || '').toLowerCase();
  if (/\bboolean\b/.test(s)) return 'BOOL';
  if (/\bon\b.*\boff\b|\boff\b.*\bon\b/.test(s)) return 'BOOL';
  return null;
}

function defaultValues(name, type) {
  if (type === 'BOOL') return ['ON', 'OFF'];
  switch (name) {
    case 'CMAKE_BUILD_TYPE':
      return ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'];
    case 'CMAKE_CXX_STANDARD':
    case 'CMAKE_C_STANDARD':
      return ['98', '11', '14', '17', '20', '23', '26'];
    case 'CMAKE_MSVC_RUNTIME_LIBRARY':
      return ['MultiThreaded', 'MultiThreadedDLL', 'MultiThreadedDebug', 'MultiThreadedDebugDLL'];
    case 'CMAKE_CXX_VISIBILITY_PRESET':
    case 'CMAKE_C_VISIBILITY_PRESET':
      return ['default', 'hidden'];
    default:
      return [];
  }
}

/** 校验一条记录是否可用（名称合法、有说明）。 */
export function isUsable(entry) {
  return (
    entry &&
    typeof entry.name === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) &&
    !entry.template
  );
}

const LANG_VARIANTS = [
  ['C', 'C'],
  ['CXX', 'C++'],
];

/**
 * CMake 把 CMAKE_<LANG>_XXX 写成一个模板文档（如 CMAKE_LANG_COMPILER.rst），
 * 这里实例化成真实变量名（C / C++），否则 CMAKE_CXX_COMPILER 这类常用变量永远补不出来。
 */
export function instantiateLangTemplates(list) {
  const realNames = new Set(list.filter((v) => !v.template).map((v) => v.name));
  const out = [];

  for (const v of list) {
    if (!v.template) {
      out.push(v);
      continue;
    }
    const m = /^CMAKE_<LANG>_([A-Za-z0-9_]+)$/.exec(v.name || '');
    if (!m) continue;

    for (const [tag, label] of LANG_VARIANTS) {
      const name = `CMAKE_${tag}_${m[1]}`;
      if (realNames.has(name)) continue;
      // <LANG>_XXX 是标识符的一部分，用 C/CXX；单独出现的 <LANG> / LANG 是叙述文字，用 C/C++
      const summary = (v.summary || '')
        .replace(/<LANG>_/g, tag + '_')
        .replace(/<LANG>/g, label)
        .replace(/\bLANG\b/g, label);
      if (!summary) continue;
      out.push({ ...v, name, summary, template: false, values: [] });
    }
  }
  return out;
}
