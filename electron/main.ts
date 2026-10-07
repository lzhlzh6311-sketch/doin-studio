import { app, BrowserWindow, session, shell, type WebContents } from 'electron';
import path from 'path';
import { startServer, stopServer } from './server';
import { registerConfigHandlers } from './handlers/config-handler';
import { registerStorageHandlers } from './handlers/storage-handler';
import { registerAppHandlers } from './handlers/app-handler';
import { rendererTrustOptions } from './ipc-guard';
import { isSafeExternalUrl, isTrustedRendererUrl } from './utils/window-security';
import { attachContextMenu, installAppMenu } from './menu';

// 禁用硬件加速，避免某些系统的兼容性问题
app.disableHardwareAcceleration();
app.setName('Doin Studio');
if (process.env.DOIN_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DOIN_USER_DATA_DIR));

// 主进程里漏网的 Promise 拒绝只记日志，不让它悄悄吞掉或拖垮整个应用。
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled promise rejection:', reason);
});

// 注册所有 IPC 处理器
registerConfigHandlers();
registerStorageHandlers();
registerAppHandlers();

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

/**
 * 窗口只停留在应用自己的页面上：其它导航与 `target="_blank"` 一律拦下，
 * http/https/mailto 交给系统浏览器 —— 远程网页绝不能在带 preload 的窗口里运行。
 */
function hardenWebContents(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (isTrustedRendererUrl(url, rendererTrustOptions())) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  attachContextMenu(contents);
}

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

async function createWindow() {
  console.log('[Main] Starting createWindow...');

  // 启动嵌入式 Express 服务器
  try {
    serverPort = await startServer();
    console.log(`[Main] Express server started on port ${serverPort}`);
  } catch (error) {
    console.error('[Main] Failed to start server:', error);
    throw error;
  }

  // 创建主窗口
  console.log('[Main] Creating BrowserWindow...');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Doin Studio',
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 contextBridge/ipcRenderer，可以在沙箱里跑。
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
    titleBarStyle: 'default',
    show: false, // 等待加载完成后再显示
  });
  console.log('[Main] BrowserWindow created');

  // 开发环境：加载 Vite 开发服务器
  // 生产环境：加载构建后的文件
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

  try {
    if (process.env.NODE_ENV === 'development') {
      console.log('[Main] Loading URL:', devUrl);
      await mainWindow.loadURL(devUrl);
      console.log('[Main] URL loaded');

      if (process.env.OPEN_DEVTOOLS === '1') {
        console.log('[Main] Opening DevTools...');
        mainWindow.webContents.openDevTools();
      }
    } else {
      const rendererPath = path.join(__dirname, '../dist-renderer/index.html');
      console.log('[Main] Loading file:', rendererPath);
      await mainWindow.loadFile(rendererPath);
      console.log('[Main] File loaded');
    }
  } catch (error) {
    console.error('[Main] Failed to load window content:', error);
    throw error;
  }

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready-to-show event fired');
    mainWindow?.show();
    mainWindow?.focus();
    console.log('[Main] Window should be visible now');

  });

  // 超时后强制显示窗口（调试用）
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('[Main] Timeout: forcing window to show');
      mainWindow.show();
    }
  }, 3000);

  // 监听加载失败
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Window failed to load:', errorCode, errorDescription);
  });

  // 窗口关闭时清理
  mainWindow.on('closed', () => {
    console.log('[Main] Window closed');
    mainWindow = null;
  });

  console.log('[Main] createWindow completed');
}

// 应用准备就绪
app.whenReady().then(() => {
  installAppMenu();
  // 本应用不需要摄像头、麦克风、定位等权限；只放行复制按钮与视频全屏用到的两项。
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
  void createWindow().catch(error => { console.error('[Main] Startup failed', error); app.exit(1); });

  // macOS：点击 Dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(error => { console.error('[Main] Window startup failed', error); app.exit(1); });
    }
  });
});

app.on('before-quit', () => { void stopServer(); });

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 导出 serverPort，供 preload 使用
export function getServerPort(): number {
  return serverPort || 3100;
}
