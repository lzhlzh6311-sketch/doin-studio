import { create } from 'zustand';
import { apiClient, parseApiError, type AgentItem, type AgentPageContext, type AgentSessionSummary } from '../../services/api';

const LAST_SESSION_KEY = 'doin-studio.assistant-session';
const AUTO_APPROVE_KEY = 'doin-studio.assistant-auto-approve';
/** 流式接口抛的是普通 Error（已是中文）；其余接口抛 axios/发布错误，走 parseApiError。 */
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && !('response' in error) && error.name !== 'PublishingApiError' && error.name !== 'AxiosError'
    ? error.message || fallback
    : parseApiError(error).message || fallback;
const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* 本次仍生效 */ }
};

export interface PendingApproval { callId: string; label: string }
export interface RunningTool { callId: string; label: string }

interface AssistantState {
  open: boolean;
  sessionId: string | null;
  title: string;
  items: AgentItem[];
  /** 正在流式输出、还没落盘的回复文字。 */
  streaming: string;
  running: boolean;
  runId: string | null;
  approval: PendingApproval | null;
  tool: RunningTool | null;
  error: string;
  autoApprove: boolean;
  history: AgentSessionSummary[];
  setOpen(open: boolean): void;
  toggle(): void;
  setAutoApprove(value: boolean): void;
  ensureLoaded(): Promise<void>;
  newSession(): void;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  refreshHistory(): Promise<void>;
  send(text: string, context?: AgentPageContext): Promise<void>;
  stop(): Promise<void>;
  answer(approve: boolean): Promise<void>;
}

let controller: AbortController | null = null;

/** 模型先说一句再调工具时，把已流出的文字固定成一条消息，免得工具卡片出现时它消失。 */
function flushStreaming(state: { streaming: string; items: AgentItem[] }) {
  if (!state.streaming) return { streaming: '', items: state.items };
  const item: AgentItem = { type: 'assistant', id: `local-a-${Date.now()}`, text: state.streaming, createdAt: new Date().toISOString() };
  return { streaming: '', items: [...state.items, item] };
}
let loaded = false;

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  sessionId: null,
  title: '新对话',
  items: [],
  streaming: '',
  running: false,
  runId: null,
  approval: null,
  tool: null,
  error: '',
  autoApprove: read(AUTO_APPROVE_KEY) === '1',
  history: [],

  setOpen: (open) => { set({ open }); if (open) void get().ensureLoaded(); },
  toggle: () => get().setOpen(!get().open),
  setAutoApprove: (value) => { write(AUTO_APPROVE_KEY, value ? '1' : '0'); set({ autoApprove: value }); },

  async ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const last = read(LAST_SESSION_KEY);
    if (last) await get().openSession(last).catch(() => { write(LAST_SESSION_KEY, null); });
  },

  newSession() {
    if (get().running) return;
    write(LAST_SESSION_KEY, null);
    set({ sessionId: null, title: '新对话', items: [], streaming: '', error: '', approval: null, tool: null });
  },

  async openSession(id) {
    if (get().running) return;
    const { session } = await apiClient.getAgentSession(id);
    write(LAST_SESSION_KEY, session.id);
    set({ sessionId: session.id, title: session.title, items: session.items, streaming: '', error: '', approval: null, tool: null });
  },

  async deleteSession(id) {
    await apiClient.deleteAgentSession(id);
    if (get().sessionId === id) get().newSession();
    await get().refreshHistory();
  },

  async refreshHistory() {
    try { set({ history: await apiClient.listAgentSessions() }); } catch { /* 历史读不到不影响对话 */ }
  },

  async send(text, context) {
    const trimmed = text.trim();
    if (!trimmed || get().running) return;
    controller = new AbortController();
    const optimistic: AgentItem = { type: 'user', id: `local-${Date.now()}`, text: trimmed, createdAt: new Date().toISOString() };
    set(state => ({ running: true, error: '', streaming: '', items: [...state.items, optimistic] }));
    try {
      let sessionId = get().sessionId;
      if (!sessionId) {
        const session = await apiClient.createAgentSession();
        sessionId = session.id;
        write(LAST_SESSION_KEY, sessionId);
        set({ sessionId });
      }
      await apiClient.streamAgentMessage(sessionId, { text: trimmed, context, autoApprove: get().autoApprove }, (event) => {
        switch (event.type) {
          case 'run': set({ runId: event.runId }); break;
          case 'text': set(state => ({ streaming: state.streaming + event.delta })); break;
          case 'approval': set(state => ({ ...flushStreaming(state), approval: { callId: event.call.callId, label: event.call.label } })); break;
          case 'tool_start': set(state => ({ ...flushStreaming(state), approval: null, tool: { callId: event.call.callId, label: event.call.label } })); break;
          case 'tool_end': set(state => { const flushed = flushStreaming(state); return { ...flushed, approval: null, tool: null, items: [...flushed.items, event.item] }; }); break;
          case 'done': set({ items: event.session.items, title: event.session.title, streaming: '' }); break;
          case 'error': set({ error: event.message }); break;
        }
      }, controller.signal);
    } catch (error) {
      if (!controller?.signal.aborted) set({ error: messageOf(error, '助手暂时不可用') });
    } finally {
      controller = null;
      const id = get().sessionId;
      set({ running: false, runId: null, approval: null, tool: null });
      // 以落盘内容为准（停止时也能拿到已说完的部分）
      if (id) {
        try { const { session } = await apiClient.getAgentSession(id); set({ items: session.items, title: session.title, streaming: '' }); }
        catch { /* 保留界面上的内容 */ }
      }
      void get().refreshHistory();
    }
  },

  async stop() {
    const runId = get().runId;
    if (runId) await apiClient.cancelAgentRun(runId).catch(() => undefined);
    controller?.abort();
  },

  async answer(approve) {
    const { runId, approval } = get();
    if (!runId || !approval) return;
    set({ approval: null });
    try { await apiClient.answerAgentApproval(runId, approval.callId, approve); }
    catch (error) { set({ error: messageOf(error, '操作已失效') }); }
  },
}));
