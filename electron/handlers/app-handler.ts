import { app, shell, Notification, clipboard } from 'electron';
import path from 'path';
import { getServerPort } from '../main';
import { getApiToken } from '../server';
import { handleTrusted } from '../ipc-guard';
import { isSafeExternalUrl } from '../utils/window-security';

// 注册应用相关的 IPC 处理器（只响应应用自己的页面，见 ipc-guard.ts）
export function registerAppHandlers(): void {
  // 获取应用版本
  handleTrusted('get-version', () => {
    return app.getVersion();
  });

  // 获取 Express 服务器端口
  handleTrusted('get-server-port', () => {
    return getServerPort();
  });

  // 本机 API 令牌：渲染进程每个请求都要带上（见 src/lib/local-origin-guard.ts）
  handleTrusted('get-api-token', () => {
    return getApiToken();
  });

  // 在外部浏览器打开链接：只放行 http/https/mailto，file:、自定义协议等可能直接执行本机程序。
  handleTrusted('open-external', async (_, url: unknown) => {
    if (!isSafeExternalUrl(url)) throw new Error('只能打开 http/https 链接');
    await shell.openExternal(url);
  });

  // 在文件管理器中显示文件
  handleTrusted('show-item-in-folder', (_, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      throw new Error('无效的文件路径');
    }
    shell.showItemInFolder(path.normalize(filePath));
  });

  // 读剪贴板文本：只给应用自己的页面（handleTrusted 校验发送方），用于「复制抖音链接后自动提示导入」。
  // 截断到 4000 字，渲染端只在里面找抖音链接，不上传、不保存。
  handleTrusted('read-clipboard-text', () => clipboard.readText().slice(0, 4000));

  // 显示系统通知
  handleTrusted('show-notification', (_, title: unknown, body: unknown) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    if (Notification.isSupported()) {
      new Notification({
        title: title.slice(0, 200),
        body: body.slice(0, 1000),
      }).show();
    }
  });
}
