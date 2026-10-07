import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

/**
 * Electron 默认菜单与输入框右键菜单都是英文的。这里给出中文菜单模板，
 * 并给可编辑区域、选中文字补上「剪切 / 复制 / 粘贴 / 全选」右键菜单。
 * 纯函数，不直接依赖 electron 运行时，方便单测。
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  openExternal: (url: string) => void = () => {},
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: [
        {
          label: '新建视频任务',
          accelerator: 'CmdOrCtrl+N',
          // 快捷键本身由页面里的监听处理（输入框里按 Ctrl+N 不触发）；菜单这里只显示提示。
          registerAccelerator: false,
          click: (_item, window) => {
            void (window as BrowserWindow | undefined)?.webContents.executeJavaScript(
              "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }))",
            );
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴为纯文本' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front', label: '全部置于顶层' } as MenuItemConstructorOptions]
          : [{ role: 'close', label: '关闭' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页',
          click: () => { openExternal('https://github.com/lzhlzh6311-sketch/doin-studio'); },
        },
        {
          label: '反馈问题',
          click: () => { openExternal('https://github.com/lzhlzh6311-sketch/doin-studio/issues'); },
        },
      ],
    },
  );
  return template;
}

export interface ContextMenuParamsLike {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean; canUndo: boolean; canRedo: boolean };
  misspelledWord?: string;
  dictionarySuggestions?: string[];
}

/** 右键菜单：可编辑区域给完整编辑菜单，普通页面只在选中文字时给「复制」。 */
export function buildContextMenuTemplate(params: ContextMenuParamsLike): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: '粘贴为纯文本', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll },
    ];
  }
  if (params.selectionText.trim()) {
    return [{ role: 'copy', label: '复制' }];
  }
  return [];
}

