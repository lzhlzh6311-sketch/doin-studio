/**
 * 助手的一轮对话：纯 TypeScript 的工具调用循环（OpenAI 兼容接口，DeepSeek / 各类中转都能用）。
 *
 * 模型说话 → 流式推给界面；要调工具 → 只读的直接跑，会改数据的先问用户（或自动执行）；
 * 工具结果回填后再问模型，最多 MAX_ROUNDS 轮。每轮落盘，中途停止也不丢已说的内容。
 */
import { randomUUID } from "node:crypto";
import { diagnoseAiError } from "../ai-errors.js";
import { findTool, toolSpecs, type AgentToolDeps } from "./tools.js";
import type { AgentEvent, AgentItem, AgentPageContext, AgentPendingCall, AgentSession } from "./types.js";

const MAX_ROUNDS = 8;
const MAX_HISTORY_ITEMS = 40;
const MAX_RESULT_CHARS = 8000;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export interface AgentChatClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<StreamChunk>>;
    };
  };
}

export interface AgentTurnOptions {
  session: AgentSession;
  text: string;
  context?: AgentPageContext;
  autoApprove: boolean;
  signal: AbortSignal;
  client: AgentChatClient;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
  deps: AgentToolDeps;
  emit(event: AgentEvent): void;
  requestApproval(call: AgentPendingCall): Promise<boolean>;
  save(session: AgentSession): Promise<void>;
  now?: () => Date;
}

export function systemPrompt(context?: AgentPageContext, now = new Date()) {
  const page = context?.path
    ? `\n用户当前在「${context.title || context.path}」页面${context.jobId ? `，正在看作品 ${context.jobId}` : ""}${context.articleId ? `，正在看公众号文章 ${context.articleId}` : ""}。用户说「这条/这个」时指的就是它。`
    : "";
  return `你是 Doin Studio 里的创作助手，帮自媒体创作者做抖音视频二创、图文和公众号文章。
今天是 ${now.toISOString().slice(0, 10)}。${page}

工作方式：
- 始终用简体中文，口吻像靠谱的同事：先给结论，再给要点，不寒暄、不堆砌。
- 需要应用里的数据或要动手做事时调用工具；不要编造作品、热榜或进度。
- 改写文案、起标题、写脚本、列选题这类写作任务直接自己完成，必要时先用 get_job 读原文。
- 会改动数据的工具（新建作品、执行步骤、新建文章、收藏选题）由应用向用户确认，你照常调用即可；被取消就换个建议，别重复调用。
- 视频流程固定四步：视频转录 → AI 洗稿 → 生成分镜 → 生成视频，必须按顺序；长步骤在后台跑，告诉用户可以去作品页看进度。
- 工具报错时用一句话说清原因和下一步（例如去设置里扫码登录抖音），不要贴原始报错。
- 回答用 Markdown，列表别超过 7 条。`;
}

export function toChatMessages(items: AgentItem[]): ChatMessage[] {
  let start = Math.max(0, items.length - MAX_HISTORY_ITEMS);
  while (start < items.length && items[start].type !== "user") start += 1;
  const messages: ChatMessage[] = [];
  for (const item of items.slice(start)) {
    if (item.type === "user") messages.push({ role: "user", content: item.text });
    else if (item.type === "assistant") {
      messages.push({
        role: "assistant",
        content: item.text || null,
        ...(item.toolCalls?.length
          ? { tool_calls: item.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      });
    } else messages.push({ role: "tool", tool_call_id: item.callId, content: item.result });
  }
  return messages;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clip(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）` : text;
}

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)));

export async function runAgentTurn(o: AgentTurnOptions): Promise<AgentSession> {
  const now = () => (o.now?.() ?? new Date()).toISOString();
  const session = o.session;
  session.items.push({ type: "user", id: randomUUID(), text: o.text, ...(o.context ? { context: o.context } : {}), createdAt: now() });
  if (session.title === "新对话") session.title = o.text.replace(/\s+/g, " ").slice(0, 24) || "新对话";
  session.updatedAt = now();
  await o.save(session);

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let text = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      const stream = await o.client.chat.completions.create(
        {
          model: o.model,
          stream: true,
          temperature: 0.4,
          ...(o.maxOutputTokens ? { max_tokens: o.maxOutputTokens } : {}),
          tools: toolSpecs(),
          messages: [{ role: "system", content: systemPrompt(o.context, o.now?.()) }, ...toChatMessages(session.items)],
        },
        { signal: o.signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          o.emit({ type: "text", delta: delta.content });
        }
        for (const part of delta.tool_calls ?? []) {
          const current = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.name += part.function.name;
          if (part.function?.arguments) current.arguments += part.function.arguments;
          calls.set(part.index, current);
        }
      }
    } catch (error) {
      if (text) session.items.push({ type: "assistant", id: randomUUID(), text, createdAt: now() });
      session.updatedAt = now();
      await o.save(session);
      if (isAbort(error, o.signal)) return session;
      const diagnosis = await diagnoseAiError(error, { baseURL: o.baseURL, model: o.model });
      throw new Error(`AI 服务调用失败：${diagnosis.message}`);
    }

    const toolCalls = [...calls.values()].filter((c) => c.name).map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` }));
    session.items.push({ type: "assistant", id: randomUUID(), text, ...(toolCalls.length ? { toolCalls } : {}), createdAt: now() });
    session.updatedAt = now();
    await o.save(session);
    if (!toolCalls.length) return session;

    for (const call of toolCalls) {
      const tool = findTool(call.name);
      const args = parseArgs(call.arguments);
      const pending: AgentPendingCall = { callId: call.id, name: call.name, label: tool?.label(args) ?? call.name, risk: tool?.risk ?? "read" };
      let item: Extract<AgentItem, { type: "tool" }>;
      const base = { type: "tool" as const, id: randomUUID(), callId: call.id, name: call.name, label: pending.label, risk: pending.risk, createdAt: now() };
      if (o.signal.aborted) {
        item = { ...base, status: "denied", summary: "已停止", result: "用户停止了本次对话，没有执行。" };
      } else if (!tool) {
        item = { ...base, status: "error", summary: "未知操作", result: `没有名为 ${call.name} 的工具。` };
      } else {
        let allowed = true;
        if (tool.risk === "write" && !o.autoApprove) {
          o.emit({ type: "approval", call: pending });
          allowed = await o.requestApproval(pending);
        }
        if (!allowed) {
          item = { ...base, status: "denied", summary: "你取消了这个操作", result: "用户取消了这个操作，没有执行。" };
        } else {
          o.emit({ type: "tool_start", call: pending });
          try {
            const result = await tool.run(args, { deps: o.deps, page: o.context });
            item = { ...base, status: "done", summary: result.summary, ...(result.link ? { link: result.link } : {}), result: clip({ summary: result.summary, data: result.data }) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            item = { ...base, status: "error", summary: message, result: clip({ error: message }) };
          }
        }
      }
      session.items.push(item);
      o.emit({ type: "tool_end", item });
    }
    session.updatedAt = now();
    await o.save(session);
    if (o.signal.aborted) return session;
  }
  session.items.push({ type: "assistant", id: randomUUID(), text: "这一步需要的操作有点多，我先停在这里。你可以说「继续」让我接着做。", createdAt: now() });
  await o.save(session);
  return session;
}
