import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMenuTemplate, buildContextMenuTemplate } from './menu-template';

const labels = (items: { label?: string; type?: string }[]) => items.filter(i => i.type !== 'separator').map(i => i.label);
const hasLatin = (s: string) => /[A-Za-z]/.test(s.replace(/Doin Studio/g, ''));

test('Windows 菜单全中文，无 macOS 应用菜单', () => {
  const tpl = buildAppMenuTemplate('win32', 'Doin Studio');
  assert.deepEqual(tpl.map(m => m.label), ['文件', '编辑', '视图', '窗口', '帮助']);
  for (const top of tpl) {
    for (const item of (top.submenu as { label?: string; type?: string }[])) {
      if (item.type === 'separator') continue;
      assert.ok(item.label && !hasLatin(item.label), `菜单项含英文：${item.label}`);
    }
  }
});

test('macOS 额外带应用菜单', () => {
  const tpl = buildAppMenuTemplate('darwin', 'Doin Studio');
  assert.equal(tpl[0].label, 'Doin Studio');
  assert.equal(tpl[1].label, '文件');
});

test('输入框右键菜单含剪切复制粘贴', () => {
  const tpl = buildContextMenuTemplate({
    isEditable: true,
    selectionText: '',
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false },
  });
  assert.deepEqual(labels(tpl), ['撤销', '重做', '剪切', '复制', '粘贴', '粘贴为纯文本', '全选']);
});

test('普通文字只在有选区时给复制', () => {
  const flags = { canCut: false, canCopy: true, canPaste: false, canSelectAll: true, canUndo: false, canRedo: false };
  assert.deepEqual(buildContextMenuTemplate({ isEditable: false, selectionText: '  ', editFlags: flags }), []);
  assert.deepEqual(labels(buildContextMenuTemplate({ isEditable: false, selectionText: '选中', editFlags: flags })), ['复制']);
});
