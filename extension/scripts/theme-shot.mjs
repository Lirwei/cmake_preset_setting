/**
 * 生成两张主题截图，用于检查浅色/深色下的对比度。
 *
 *   node scripts/theme-shot.mjs light ../../docs/prototype/theme-light.png
 *   node scripts/theme-shot.mjs dark  ../../docs/prototype/theme-dark.png
 *
 * 做法：把 media/editor.html 加上假的 vscode API + 一份 init 数据 + 主题变量，
 * 再用无头 Edge 截图。只在开发时用，不参与打包。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const EDITOR = path.join(EXT, 'media', 'editor.html');
const DEMO = path.resolve(EXT, '..', 'demo', 'CMakePresets.json');

const LIGHT = {
  'editor-background': '#ffffff',
  foreground: '#3b3b3b',
  'sideBar-background': '#f8f8f8',
  'editorWidget-background': '#f8f8f8',
  'panel-border': '#e5e5e5',
  descriptionForeground: '#717171',
  focusBorder: '#005fb8',
  'list-activeSelectionBackground': '#0060c0',
  'list-activeSelectionForeground': '#ffffff',
  'list-hoverBackground': '#e8e8e8',
  'input-background': '#ffffff',
  'input-foreground': '#3b3b3b',
  'input-border': '#cecece',
  'button-secondaryBackground': '#e5e5e5',
  'button-secondaryForeground': '#3b3b3b',
  'button-secondaryHoverBackground': '#d8d8d8',
  'button-background': '#005fb8',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#0258a8',
  errorForeground: '#e51400',
  'editorWarning-foreground': '#bf8803',
  'editorInfo-foreground': '#1a85ff',
  'testing-iconPassed': '#388a34',
  'textPreformat-foreground': '#a31515',
  'symbolIcon-classForeground': '#267f99',
  'symbolIcon-variableForeground': '#007acc',
  'badge-background': '#c4c4c4',
  'badge-foreground': '#3b3b3b',
  'textCodeBlock-background': '#f5f5f5',
  'editorSuggestWidget-background': '#f8f8f8',
  'editorSuggestWidget-border': '#e5e5e5',
  'editorSuggestWidget-selectedBackground': '#0060c0',
  'editorSuggestWidget-selectedForeground': '#ffffff',
  'sideBarSectionHeader-background': '#f8f8f8',
  'scrollbarSlider-background': '#c4c4c4',
  'scrollbarSlider-hoverBackground': '#a8a8a8',
  'widget-shadow': 'rgba(0,0,0,.16)',
  'font-size': '13px',
  'editor-font-size': '12px',
};

const DARK = {
  'editor-background': '#1f1f1f',
  foreground: '#cccccc',
  'sideBar-background': '#181818',
  'editorWidget-background': '#202020',
  'panel-border': '#2b2b2b',
  descriptionForeground: '#9d9d9d',
  focusBorder: '#0078d4',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'list-hoverBackground': '#2a2d2e',
  'input-background': '#313131',
  'input-foreground': '#cccccc',
  'input-border': '#3c3c3c',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  errorForeground: '#f85149',
  'editorWarning-foreground': '#cca700',
  'editorInfo-foreground': '#3794ff',
  'testing-iconPassed': '#73c991',
  'textPreformat-foreground': '#d7ba7d',
  'symbolIcon-classForeground': '#4ec9b0',
  'symbolIcon-variableForeground': '#75beff',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  'textCodeBlock-background': '#1f1f1f',
  'editorSuggestWidget-background': '#202020',
  'editorSuggestWidget-border': '#454545',
  'editorSuggestWidget-selectedBackground': '#04395e',
  'editorSuggestWidget-selectedForeground': '#ffffff',
  'sideBarSectionHeader-background': '#181818',
  'scrollbarSlider-background': '#424242',
  'scrollbarSlider-hoverBackground': '#4f4f4f',
  'widget-shadow': 'rgba(0,0,0,.36)',
  'font-size': '13px',
  'editor-font-size': '12px',
};

const theme = (process.argv[2] || 'dark').toLowerCase() === 'light' ? LIGHT : DARK;
const out = path.resolve(process.argv[3] || path.join(EXT, '..', 'docs', 'prototype', 'theme-' + (theme === LIGHT ? 'light' : 'dark') + '.png'));

const vars = Object.entries(theme)
  .map(([key, value]) => `  --vscode-${key}: ${value};`)
  .join('\n');

const FAKE_API = `<script>
window.acquireVsCodeApi = function () {
  return { postMessage: function () {}, getState: function () { return null; }, setState: function () {} };
};
</script>`;

const INIT = `<script>
var DEMO = ${JSON.stringify(fs.readFileSync(DEMO, 'utf8'))};
setTimeout(function () {
  window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', text: DEMO, version: 1, isDirty: true, fileName: 'CMakePresets.json',
    catalog: [
      { name: 'CMAKE_BUILD_TYPE', type: 'STRING', desc: 'Specifies the build type on single-configuration generators', values: ['Debug','Release','RelWithDebInfo','MinSizeRel'], hot: true },
      { name: 'CMAKE_BUILD_TOOL', type: 'STRING', desc: 'This variable exists only for backwards compatibility', values: [], hot: false },
      { name: 'CMAKE_BUILD_RPATH', type: 'STRING', desc: 'Semicolon-separated list specifying runtime path entries', values: [], hot: false },
      { name: 'CMAKE_BUILD_WITH_INSTALL_RPATH', type: 'BOOL', desc: 'Use the install path for the RPATH', values: ['ON','OFF'], hot: false },
      { name: 'CMAKE_BUILD_WITH_INSTALL_NAME_DIR', type: 'BOOL', desc: 'Whether to use INSTALL_NAME_DIR on targets', values: ['ON','OFF'], hot: false }
    ],
    generators: ['Visual Studio 17 2022','Ninja','Unix Makefiles'],
    projectGenerators: ['Visual Studio 17 2022'],
    projectBuildDirs: [{ dir: 'build', generator: 'Visual Studio 17 2022' }]
  } }));
  function poke() {
    var el = document.querySelector('#form [data-field="__cv-name"]');
    if (!el) return;
    el.focus();
    el.value = 'CMAKE_BUILD';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  setTimeout(poke, 2200);
  setTimeout(poke, 3600);
  // 截图时 headless 可能触发一次 resize，会把补全弹窗收起，这里重新打开
  window.addEventListener('resize', poke);
}, 300);
</script>`;

function findBrowser() {
  if (process.platform !== 'win32') return ['msedge', 'google-chrome', 'chromium'].find(Boolean);
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((p) => fs.existsSync(p));
}

const browser = findBrowser();
if (!browser) {
  console.error('找不到 Edge/Chrome');
  process.exit(2);
}

let html = fs.readFileSync(EDITOR, 'utf8');
html = html.replace('<script>', FAKE_API + '<script>');
html = html.replace(
  '</head>',
  `<style>\n:root {\n${vars}\n}\n</style>\n</head>`
);
html = html.replace('<body>', `<body class="${theme === LIGHT ? 'vscode-light' : 'vscode-dark'}">`);
html = html.replace('</body>', INIT + '</body>');

const temp = path.join(EXT, 'media', '__theme-shot.html');
fs.writeFileSync(temp, html, 'utf8');
fs.mkdirSync(path.dirname(out), { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-shot-'));
try {
  const baseArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    '--virtual-time-budget=4000',
  ];
  if (process.argv.includes('--dump')) {
    const dom = execFileSync(browser, [...baseArgs, '--dump-dom', pathToFileURL(temp).href], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
    });
    const box = /<div id="suggest"([^>]*)>([\s\S]*?)<\/div>/.exec(dom);
    console.log('suggest attrs:', box ? box[1] : '(not found)');
    console.log('suggest children:', box ? (box[2].match(/class="sg/g) || []).length : 0);
    console.log('edit dialog present:', /id="form"/.test(dom));
    process.exit(0);
  }
  execFileSync(
    browser,
    [...baseArgs, '--screenshot=' + out, pathToFileURL(temp).href],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
  );
} finally {
  fs.rmSync(temp, { force: true });
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`${theme === LIGHT ? 'light' : 'dark'} → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
