import path from 'path';
import { fileURLToPath } from 'url';

/**
 * 主进程的窗口/IPC 安全判定（纯函数，便于用例守）。
 *
 * - 只有 http/https/mailto 链接可以交给系统打开（`shell.openExternal` 遇到 file:、自定义协议等
 *   可能直接执行本机程序）；
 * - 应用窗口只允许停留在自己的页面上（打包后的 index.html 或开发服务器），
 *   其他导航与 `target="_blank"` 一律拦下、改由系统浏览器打开 —— 否则远程网页会在一个
 *   带 preload（`window.electron`：读配置、改配置、打开外链）的窗口里运行；
 * - IPC 只响应来自自己页面的调用。
 */
export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
}

export interface TrustedRendererOptions {
  /** 打包后渲染进程入口（绝对路径）。 */
  rendererIndexPath: string;
  /** 开发模式下的 Vite 地址；生产模式不传。 */
  devServerUrl?: string;
}

/** 这个地址是否是应用自己的页面（用于导航守卫与 IPC 发送方校验）。 */
export function isTrustedRendererUrl(value: unknown, options: TrustedRendererOptions): boolean {
  if (typeof value !== 'string' || !value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'file:') {
    try {
      return path.resolve(fileURLToPath(url)) === path.resolve(options.rendererIndexPath);
    } catch {
      return false;
    }
  }
  if (!options.devServerUrl) return false;
  try {
    return url.origin === new URL(options.devServerUrl).origin;
  } catch {
    return false;
  }
}
