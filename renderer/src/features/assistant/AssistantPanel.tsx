import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowUp, Check, ChevronRight, History, Loader2, Plus, Sparkles, Square, Trash2, X, XCircle, CircleSlash } from 'lucide-react';
import type { AgentItem, AgentPageContext } from '../../services/api';
import { getPageContext } from '../../components/studio/navigation';
import { Markdown } from './Markdown';
import { useAssistant } from './store';

/** 从当前路由推出页面上下文，让「这条」「这篇」有所指。 */
export function pageContextOf(pathname: string): AgentPageContext {
  const job = /^\/jobs\/([^/]+)/.exec(pathname)?.[1];
  const article = /^\/articles\/(?!benchmarks)([^/]+)/.exec(pathname)?.[1];
  return { path: pathname, title: getPageContext(pathname).title, ...(job ? { jobId: job } : {}), ...(article ? { articleId: article } : {}) };
}

/** 空对话时的一键提问：随页面变化。 */
export function suggestionsFor(context: AgentPageContext): string[] {
  if (context.jobId) return ['这条进行到哪一步了？', '帮这条视频起 5 个爆款标题', '继续做下一步', '把洗稿后的文案改成更口语的版本'];
  if (context.articleId) return ['这篇文章现在缺什么？', '给这篇想 5 个公众号标题', '帮我写一段开头'];
  if (context.path === '/hotspots') return ['今天抖音热榜里有哪些适合做视频的？', '从知乎热榜挑 3 个适合写公众号的选题', '把第一条收藏为选题'];
  return ['看看今天的热榜，推荐 3 个能做的选题', '我最近的作品都进行到哪了？', '检查一下环境有没有问题', '帮我导入一个抖音视频'];
}

function ToolCard({ item, onOpen }: { item: Extract<AgentItem, { type: 'tool' }>; onOpen: (to: string) => void }) {
  const Icon = item.status === 'done' ? Check : item.status === 'denied' ? CircleSlash : XCircle;
  const tone = item.status === 'done' ? 'text-success' : item.status === 'denied' ? 'text-ink-subtle' : 'text-warning';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs" data-testid="assistant-tool">
      <Icon size={14} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">{item.label}</p>
        <p className="mt-0.5 text-ink-muted">{item.summary}</p>
      </div>
      {item.link && item.status === 'done' && (
        <button type="button" onClick={() => onOpen(item.link!.to)} className="flex shrink-0 items-center gap-0.5 text-accent hover:underline">
          {item.link.label}<ChevronRight size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function AssistantPanel() {
  const state = useAssistant();
  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const context = useMemo(() => pageContextOf(location.pathname), [location.pathname]);

  useEffect(() => { if (state.open) setTimeout(() => input.current?.focus(), 50); }, [state.open]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [state.items.length, state.streaming, state.approval, state.tool]);
  useEffect(() => { if (showHistory) void state.refreshHistory(); }, [showHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state.open) return null;

  const submit = (text = draft) => {
    if (!text.trim() || state.running) return;
    setDraft('');
    void state.send(text, context);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    if (event.key === 'Escape') state.setOpen(false);
  };
  const openLink = (to: string) => { navigate(to); if (window.innerWidth < 768) state.setOpen(false); };

  return (
    <aside aria-label="创作助手" data-testid="assistant-panel"
      className="fixed inset-0 z-50 flex flex-col border-l border-studio-border bg-studio-panel shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:top-16 md:w-[420px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-studio-border px-3">
        <Sparkles size={16} className="shrink-0 text-accent" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{state.title}</p>
        <button type="button" onClick={() => setShowHistory(v => !v)} aria-label="历史对话" aria-expanded={showHistory} className="rounded-lg p-1.5 text-ink-muted hover:bg-elevated hover:text-ink"><History size={16} /></button>
        <button type="button" onClick={() => { state.newSession(); setShowHistory(false); input.current?.focus(); }} disabled={state.running} aria-label="新对话" className="rounded-lg p-1.5 text-ink-muted hover:bg-elevated hover:text-ink disabled:opacity-40"><Plus size={16} /></button>
        <button type="button" onClick={() => state.setOpen(false)} aria-label="关闭助手" className="rounded-lg p-1.5 text-ink-muted hover:bg-elevated hover:text-ink"><X size={16} /></button>
      </div>

      {showHistory ? (
        <div className="flex-1 overflow-y-auto p-2" data-testid="assistant-history">
          {state.history.length === 0 && <p className="p-4 text-center text-sm text-ink-muted">还没有历史对话</p>}
          {state.history.map(h => (
            <div key={h.id} className={`group flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-elevated ${h.id === state.sessionId ? 'bg-elevated' : ''}`}>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { void state.openSession(h.id); setShowHistory(false); }}>
                <p className="truncate text-sm text-ink">{h.title}</p>
                <p className="truncate text-xs text-ink-muted">{h.preview || '　'}</p>
              </button>
              <button type="button" aria-label={`删除对话：${h.title}`} onClick={() => { void state.deleteSession(h.id); }} className="rounded p-1 text-ink-subtle opacity-0 hover:text-warning group-hover:opacity-100 focus:opacity-100"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
          {state.items.length === 0 && !state.running && (
            <div className="pt-6">
              <p className="text-sm font-semibold text-ink">想做点什么？</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">我能查作品进度、看热榜找选题、导入抖音视频、按步骤推进流程，也能直接帮你改文案、起标题。会改动数据的操作都会先问你。</p>
              <div className="mt-4 space-y-2">
                {suggestionsFor(context).map(s => (
                  <button key={s} type="button" onClick={() => submit(s)} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-sm text-ink hover:border-accent-line hover:bg-accent-soft">{s}</button>
                ))}
              </div>
            </div>
          )}
          {state.items.map(item => {
            if (item.type === 'user') return <div key={item.id} className="ml-8 rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm leading-6 text-on-accent whitespace-pre-wrap break-words">{item.text}</div>;
            if (item.type === 'tool') return <ToolCard key={item.id} item={item} onOpen={openLink} />;
            return item.text ? <div key={item.id} className="mr-4"><Markdown text={item.text} /></div> : null;
          })}
          {state.streaming && <div className="mr-4"><Markdown text={state.streaming} /></div>}
          {state.tool && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-muted"><Loader2 size={14} className="animate-spin text-accent" />正在{state.tool.label}…</div>
          )}
          {state.approval && (
            <div className="rounded-lg border border-accent-line bg-accent-soft p-3" data-testid="assistant-approval">
              <p className="text-sm text-ink">要执行「{state.approval.label}」吗？</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => { void state.answer(true); }} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover">执行</button>
                <button type="button" onClick={() => { void state.answer(false); }} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-elevated">取消</button>
              </div>
            </div>
          )}
          {state.running && !state.streaming && !state.tool && !state.approval && (
            <div className="flex items-center gap-2 text-xs text-ink-muted"><Loader2 size={14} className="animate-spin" />思考中…</div>
          )}
          {state.error && <p className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning" role="alert">{state.error}</p>}
        </div>
      )}

      <div className="shrink-0 border-t border-studio-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-canvas px-3 py-2 focus-within:border-accent-line">
          <textarea ref={input} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} rows={1}
            aria-label="给助手发消息" placeholder={context.jobId ? '问问这条作品，或让我继续下一步…' : '输入需求，Enter 发送，Shift+Enter 换行'}
            className="assistant-input max-h-40 min-h-[24px] flex-1 resize-none border-0 bg-transparent text-sm leading-6 text-ink shadow-none outline-none ring-0 placeholder:text-ink-subtle focus:outline-none focus:ring-0 focus-visible:outline-none"
            style={{ height: `${Math.min(160, 24 * Math.max(1, draft.split('\n').length))}px` }} />
          {state.running
            ? <button type="button" onClick={() => { void state.stop(); }} aria-label="停止" className="rounded-lg bg-elevated p-1.5 text-ink hover:bg-line"><Square size={16} /></button>
            : <button type="button" onClick={() => submit()} disabled={!draft.trim()} aria-label="发送" className="rounded-lg bg-accent p-1.5 text-on-accent disabled:opacity-40"><ArrowUp size={16} /></button>}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
          <input type="checkbox" checked={state.autoApprove} onChange={e => state.setAutoApprove(e.target.checked)} className="accent-[var(--color-accent)]" />
          自动执行（不再逐个确认新建、执行步骤等操作）
        </label>
      </div>
    </aside>
  );
}
