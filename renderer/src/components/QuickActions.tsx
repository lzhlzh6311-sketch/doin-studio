import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clipboard, X } from 'lucide-react';
import { apiClient } from '../services/api';
import { desktop } from '../electron-bridge';
import { clipboardOffer, diffJobEvents, snapshotJobs, type JobSnapshot } from '../utils/quickStart';

const CLIPBOARD_LAST_KEY = 'doin-studio.clipboard-last-offered';
const CLIPBOARD_OFF_KEY = 'doin-studio.clipboard-prompt-off';
const NOTIFY_INTERVAL_MS = 15_000;

const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* 本次仍生效 */ } };

const isEditable = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/**
 * 全局「省事」小功能，挂在工作台外壳里，所有页面都生效：
 * 1. 复制抖音链接后切回应用 → 右下角提示「导入为视频任务」；
 * 2. Ctrl/⌘+N → 新建视频任务；
 * 3. 转录 / 渲染等长任务跑完 → 系统通知（窗口在前台且正看着时不打扰）。
 */
export function QuickActions() {
  const navigate = useNavigate();
  const [offer, setOffer] = useState<string | null>(null);

  // ---- 剪贴板提示 ----
  const checkClipboard = useCallback(async () => {
    const text = await desktop.readClipboardText();
    const link = clipboardOffer(text, read(CLIPBOARD_LAST_KEY), read(CLIPBOARD_OFF_KEY) === '1');
    if (link) setOffer(link);
  }, []);

  useEffect(() => {
    void checkClipboard();
    const onFocus = () => { void checkClipboard(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [checkClipboard]);

  const settle = (link: string) => { write(CLIPBOARD_LAST_KEY, link); setOffer(null); };
  const importLink = () => {
    if (!offer) return;
    settle(offer);
    navigate(`/?create=${encodeURIComponent(offer)}`);
  };
  const turnOff = () => { if (offer) settle(offer); write(CLIPBOARD_OFF_KEY, '1'); };

  // ---- 快捷键 ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'n' || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      navigate('/?create=1');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // ---- 任务完成通知 ----
  const previous = useRef<Map<string, JobSnapshot> | null>(null);
  useEffect(() => {
    if (!desktop.capabilities.showNotification) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const jobs = await apiClient.getJobOverviews();
        if (stopped) return;
        const events = diffJobEvents(previous.current, jobs);
        previous.current = snapshotJobs(jobs);
        const watching = document.visibilityState === 'visible' && document.hasFocus();
        if (!watching) for (const event of events.slice(0, 3)) await desktop.showNotification(`Doin Studio · ${event.title}`, event.body);
      } catch { /* 下一拍再试 */ }
      if (!stopped) timer = setTimeout(() => { void tick(); }, NOTIFY_INTERVAL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  if (!offer) return null;
  return (
    <div role="status" aria-live="polite" data-testid="clipboard-import-prompt"
      className="fixed bottom-20 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-4 shadow-lg md:bottom-6">
      <div className="flex items-start gap-3">
        <Clipboard size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">检测到复制的抖音链接</p>
          <p className="mt-1 truncate text-xs text-ink-muted" title={offer}>{offer}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={importLink} className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-hover">导入为视频任务</button>
            <button type="button" onClick={() => settle(offer)} className="h-8 rounded-lg px-3 text-xs text-ink-muted hover:bg-elevated hover:text-ink">忽略</button>
            <button type="button" onClick={turnOff} className="ml-auto text-xs text-ink-subtle hover:text-ink-muted hover:underline">不再提示</button>
          </div>
        </div>
        <button type="button" onClick={() => settle(offer)} aria-label="关闭提示" className="rounded p-0.5 text-ink-muted hover:text-ink"><X size={14} /></button>
      </div>
    </div>
  );
}
