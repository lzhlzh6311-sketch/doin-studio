import { useEffect, useRef, type ComponentType } from 'react';
import { RouterProvider, Outlet } from 'react-router-dom';
import { createAppRouter } from './utils/appRouter';
import { JobListPage } from './pages/JobListPage';
import { PublishingDuePoller } from './components/PublishingDuePoller';
import { StudioShell } from './components/studio/StudioShell';
import { useOperatorStore } from './store/operator';

/**
 * 除首页外的页面都按需加载：启动只解析首页需要的代码，其余页面第一次打开时再取，
 * 各自一个小文件（打包后均在本机，切换几乎无感）。
 */
const pageLoaders: Array<() => Promise<unknown>> = [];
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  pageLoaders.push(load);
  return async () => ({ Component: (await load())[name] });
}

/** 首页画完后趁空闲把其余页面预取进缓存，之后切页不用等。 */
function prefetchPages() {
  const run = () => { for (const load of pageLoaders) void load().catch(() => { /* 真正打开时再试 */ }); };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (idle) idle(run); else setTimeout(run, 1500);
}

const router = createAppRouter([{
  element: <StudioShell><Outlet /></StudioShell>,
  children: [
    { path: '/', element: <JobListPage /> },
    { path: '/articles', lazy: page(() => import('./pages/ArticlesPage'), 'ArticlesPage') },
    { path: '/articles/benchmarks', lazy: page(() => import('./pages/WechatBenchmarksPage'), 'WechatBenchmarksPage') },
    { path: '/articles/:id', lazy: page(() => import('./pages/ArticleDetailPage'), 'ArticleDetailPage') },
    { path: '/hotspots', lazy: page(() => import('./pages/HotspotsPage'), 'HotspotsPage') },
    { path: '/jobs/:id', lazy: page(() => import('./pages/JobDetailPage'), 'JobDetailPage') },
    { path: '/galleries', lazy: page(() => import('./pages/GalleriesPage'), 'GalleriesPage') },
    { path: '/galleries/:id', lazy: page(() => import('./pages/GalleryDetailPage'), 'GalleryDetailPage') },
    { path: '/collections', lazy: page(() => import('./pages/CollectionListPage'), 'CollectionListPage') },
    { path: '/collections/:id', lazy: page(() => import('./pages/CollectionDetailPage'), 'CollectionDetailPage') },
    { path: '/skills', lazy: page(() => import('./pages/SkillListPage'), 'SkillListPage') },
    { path: '/assets', lazy: page(() => import('./pages/AssetsPage'), 'AssetsPage') },
    { path: '/publishing', lazy: page(() => import('./pages/PublishingPage'), 'PublishingPage') },
    { path: '/trash', lazy: page(() => import('./pages/TrashPage'), 'TrashPage') },
    { path: '/settings', lazy: page(() => import('./pages/SettingsPage'), 'SettingsPage') },
  ],
}]);

function AppContent() {
  const initialize = useOperatorStore((state) => state.initialize);
  const initialized = useOperatorStore((state) => state.initialized);
  const initializationStarted = useRef(false);

  useEffect(() => {
    if (initializationStarted.current) return;
    initializationStarted.current = true;
    prefetchPages();
    // 本机操作者会话失败时 store 会降级为「未就绪」，不会 reject，
    // 因此这里不再有初始化失败分支：应用照常进入，缺会话的操作会各自提示重试。
    void initialize();
  }, [initialize]);

  if (!initialized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm rounded-lg border border-line bg-panel px-5 py-4 text-sm text-ink-muted shadow-sm" role="status">
          正在准备本机操作者...
        </div>
      </main>
    );
  }

  return (
    <RouterProvider router={router} />
  );
}

function App() {
  return (
    <>
      <PublishingDuePoller />
      <AppContent />
    </>
  );
}

export default App;
