import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { isTrustedRendererUrl, type TrustedRendererOptions } from './utils/window-security';

/** 应用自己的页面在哪（打包后的 index.html；开发模式下另有 Vite 地址）。与 main.ts 加载的是同一处。 */
export function rendererTrustOptions(): TrustedRendererOptions {
  return {
    rendererIndexPath: path.join(__dirname, '../dist-renderer/index.html'),
    ...(process.env.NODE_ENV === 'development'
      ? { devServerUrl: process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173' }
      : {}),
  };
}

/**
 * 只响应来自应用自己页面的 IPC。preload 暴露的接口能读到解密后的 API Key、改配置、打开外链，
 * 万一有别的页面进了某个窗口（导航守卫是第一道门，这里是第二道），也调不动它们。
 */
export function handleTrusted(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url, rendererTrustOptions())) {
      throw new Error(`Untrusted IPC sender for ${channel}`);
    }
    return listener(event, ...args);
  });
}
