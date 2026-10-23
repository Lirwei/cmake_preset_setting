import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const extension_root = new URL('../', import.meta.url);

test('openEditor 命令配置深浅色 SVG 图标，并保留编辑器标题入口', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('package.json', extension_root), 'utf8'));
  const open_editor = manifest.contributes.commands.find((command) => command.command === 'cmakePresets.openEditor');
  assert.ok(open_editor);
  const icons = ['light', 'dark'].map((theme) => {
    const icon = fs.readFileSync(new URL(open_editor.icon[theme], extension_root), 'utf8');
    assert.match(icon, /viewBox="0 0 16 16"/);
    assert.match(icon, /<path /);
    return icon;
  });
  assert.notEqual(icons[0], icons[1], '深浅主题应使用各自的前景色');
  assert.ok(manifest.contributes.menus['editor/title'].some((entry) => entry.command === open_editor.command));
});
