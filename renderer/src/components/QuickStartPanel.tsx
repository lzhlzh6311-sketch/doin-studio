import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Circle, Clapperboard, FileText, Image as ImageIcon, Sparkles, X } from 'lucide-react';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { buildSetupItems, setupProgress, type SetupItem } from '../utils/quickStart';

const DISMISS_KEY = 'doin-studio.quickstart-dismissed';

function readDismissed(): boolean {
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/**
 * 首页「开始之前」面板：把散落在设置页各分组里的准备工作收成一张清单，
 * 每项一键跳到对应设置分组；下面再给三条最常用的创作入口（视频 / 图文 / 公众号）。
 *
 * - 必需项没做完时一直显示（可以收起，但会留一条细提示）；
 * - 全部完成后自动只剩创作入口；用户关掉后不再出现。
 */
export function QuickStartPanel({ onCreateVideo }: { onCreateVideo: () => void }) {
  const [items, setItems] = useState<SetupItem[]>(() => buildSetupItems({ hasAiKey: null, runtime: null }));
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [key, runtime] = await Promise.allSettled([hasValidApiKey(), apiClient.getRuntimeStatus()]);
      if (!alive) return;
      setItems(buildSetupItems({
        hasAiKey: key.status === 'fulfilled' ? key.value : null,
        runtime: runtime.status === 'fulfilled' ? [...runtime.value.channels, ...runtime.value.dependencies] : null,
      }));
    })();
    return () => { alive = false; };
  }, []);

  const progress = setupProgress(items);
  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 本次仍生效 */ }
  };

  if (dismissed && progress.requiredMissing === 0) return null;

  if (dismissed) {
    const missing = items.filter(item => item.required && !item.done && !item.unknown);
    return (
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-warning-line bg-warning-soft px-4 py-2.5 text-sm text-warning" data-testid="quickstart-reminder">
        <span>还差 {missing.length} 项准备：</span>
        {missing.map(item => <Link key={item.id} to={`/settings?section=${item.section}`} className="font-medium underline">{item.label}</Link>)}
      </div>
    );
  }

  const entries = [
    { icon: Clapperboard, title: '做视频', text: '贴抖音链接，自动转录、改写、出分镜和竖版视频', action: onCreateVideo },
    { icon: FileText, title: '写公众号', text: '输入关键词或从热榜挑选题，AI 选题、查证、成稿', to: '/articles' },
    { icon: ImageIcon, title: '做图文', text: '用原视频字幕拼成整套图集，直接备好抖音图文', to: '/galleries' },
  ];

  return (
    <section className="mb-6 rounded-xl border border-line bg-panel p-5" aria-labelledby="quickstart-title" data-testid="quickstart-panel">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="quickstart-title" className="flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <Sparkles size={18} className="text-accent" aria-hidden="true" />
            {progress.allDone ? '一切就绪，开始创作' : '开始之前'}
          </h2>
          {!progress.allDone && <p className="mt-1 text-sm text-ink-muted">已完成 {progress.done} / {progress.total}。前三项是必需的，后两项用于一键发布。</p>}
        </div>
        <button type="button" onClick={dismiss} aria-label="收起开始面板" className="rounded-lg p-1.5 text-ink-muted hover:bg-elevated hover:text-ink"><X size={16} /></button>
      </div>

      {!progress.allDone && (
        <>
          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden="true">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
          <ul className="mb-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {items.map(item => (
              <li key={item.id}>
                <Link to={`/settings?section=${item.section}`} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${item.done ? 'border-line bg-canvas' : 'border-line-ui hover:border-accent-line hover:bg-accent-soft'}`}>
                  {item.done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-label="已完成" /> : <Circle size={18} className={`mt-0.5 shrink-0 ${item.required ? 'text-warning' : 'text-ink-subtle'}`} aria-label={item.unknown ? '未检测' : '未完成'} />}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium ${item.done ? 'text-ink-muted line-through' : 'text-ink'}`}>{item.label}{!item.required && <span className="ml-1.5 text-xs font-normal text-ink-subtle">可选</span>}</span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{item.purpose}</span>
                  </span>
                  {!item.done && <ChevronRight size={16} className="mt-0.5 shrink-0 text-ink-subtle" aria-hidden="true" />}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {entries.map(entry => {
          const body = <>
            <entry.icon size={20} className="mb-2 text-accent" aria-hidden="true" />
            <span className="block text-sm font-semibold text-ink">{entry.title}</span>
            <span className="mt-1 block text-xs leading-5 text-ink-muted">{entry.text}</span>
          </>;
          const className = 'block rounded-lg border border-line bg-canvas p-4 text-left transition-colors hover:border-accent-line hover:bg-accent-soft';
          return entry.to
            ? <Link key={entry.title} to={entry.to} className={className}>{body}</Link>
            : <button key={entry.title} type="button" onClick={entry.action} className={`${className} w-full`}>{body}</button>;
        })}
      </div>
      <p className="mt-3 text-xs text-ink-subtle">小技巧：在抖音里点「复制链接」，切回 Doin Studio 会自动提示导入；按 Ctrl+N（Mac 为 ⌘N）随时新建视频任务；按 Ctrl+J 呼出创作助手，直接说要做什么。</p>
    </section>
  );
}
