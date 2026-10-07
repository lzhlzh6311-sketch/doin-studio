import { app, Menu, shell, type WebContents } from 'electron';
import { buildAppMenuTemplate, buildContextMenuTemplate } from './utils/menu-template';

export function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(process.platform, app.getName(), (url) => { void shell.openExternal(url); })));
}

export function attachContextMenu(contents: WebContents) {
  contents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup();
  });
}
