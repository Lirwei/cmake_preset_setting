/**
 * 交互层端到端测试：用无头 Edge/Chrome 打开原型，模拟一次变量补全。
 *
 *   node test/prototype-smoke.mjs
 *
 * 断言：
 *   1. 页面脚本没有运行时错误
 *   2. 缓存变量名输入 CMAKE_BUILD 会弹出候选
 *   3. 第 1 条是 CMAKE_BUILD_TYPE
 *   4. 按 Enter 采纳后，名称变成 CMAKE_BUILD_TYPE、类型自动填 STRING、右侧 JSON 同步
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const PAGE = path.resolve(ROOT, '..', '..', 'docs', 'prototype', 'presets-editor.html');
const TMP_PAGE = path.join(path.dirname(PAGE), '__ui-smoke.html');

function findBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['msedge', 'google-chrome', 'chromium', 'chromium-browser'];
  if (process.platform !== 'win32') return candidates.find((c) => c && !c.includes('\\')) || null;
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const ERROR_CAPTURE =
  '<script>window.__errs=[];window.addEventListener("error",function(e){' +
  'window.__errs.push((e.message||"")+" @"+(e.filename||"")+":"+e.lineno)});</script>';

const TEST_SCRIPT = `
<script>
setTimeout(function () {
  var out = {};
  try {
    out.errs = (window.__errs || []).slice(0, 3);
    out.catalog = (window.CMAKE_VARIABLES || []).length;
    var el = document.querySelector('#form [data-field="__cv-name"]');
    out.hasInput = !!el;
    if (el) {
      el.focus();
      el.value = 'CMAKE_BUILD';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      var box = document.getElementById('suggest');
      out.open = box.classList.contains('on');
      out.items = box.querySelectorAll('.sg').length;
      var first = box.querySelector('.sg .n');
      out.first = first ? first.textContent : null;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      out.valueAfter = el.value;
      var typeEl = document.querySelector('#form [data-field="__cv-type"]');
      out.typeAfter = typeEl ? typeEl.value : null;
      out.jsonHasName = document.getElementById('json').textContent.indexOf('CMAKE_BUILD_TYPE') >= 0;
    }
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  var d = document.createElement('div');
  d.id = 'smoke-result';
  d.textContent = 'SMOKE ' + JSON.stringify(out);
  document.body.appendChild(d);
}, 600);
</script>`;

function buildPage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  let out = html.replace('<script src="variables.js"></script>', ERROR_CAPTURE + '<script src="variables.js"></script>');
  out = out.replace('</body>', TEST_SCRIPT + '</body>');
  fs.writeFileSync(TMP_PAGE, out, 'utf8');
}

function runHeadless(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'varcat-ui-'));
  try {
    const stdout = execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=5000',
        '--dump-dom',
        pathToFileURL(TMP_PAGE).href,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }
    );
    return stdout;
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profile 清理失败不影响结论 */
    }
  }
}

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

const browser = findBrowser();
if (!browser) {
  console.log('找不到 Edge/Chrome，跳过交互层测试（数据层请运行 node test/smoke.mjs）');
  process.exit(0);
}

console.log(`\n浏览器: ${browser}`);
buildPage();

let dom = '';
try {
  dom = runHeadless(browser);
} catch (err) {
  console.log('  FAIL  无头浏览器执行失败: ' + (err.message || err));
  failed++;
}

const m = /SMOKE (\{[\s\S]*?\})<\/div>/.exec(dom);
let r = null;
try {
  r = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null;
} catch {
  r = null;
}

if (!r) {
  console.log('  FAIL  页面里没有拿到测试结果（脚本可能没执行）');
  failed++;
} else {
  check('页面无运行时错误', Array.isArray(r.errs) && r.errs.length === 0, r.errs && r.errs.join(' | '));
  check('variables.js 已加载', r.catalog > 500, `${r.catalog} 条`);
  check('找到缓存变量名输入框', r.hasInput === true);
  check('输入 CMAKE_BUILD 弹出候选', r.open === true, `${r.items} 条候选`);
  check('首条候选是 CMAKE_BUILD_TYPE', r.first === 'CMAKE_BUILD_TYPE', String(r.first));
  check('回车采纳后名称正确', r.valueAfter === 'CMAKE_BUILD_TYPE', String(r.valueAfter));
  check('类型自动填充为 STRING', r.typeAfter === 'STRING', String(r.typeAfter));
  check('JSON 预览已同步', r.jsonHasName === true);
}

try {
  fs.unlinkSync(TMP_PAGE);
} catch {
  /* ignore */
}

console.log(failed ? `\n交互层测试失败：${failed} 项` : '\n交互层测试全部通过');
if (failed) process.exitCode = 1;
