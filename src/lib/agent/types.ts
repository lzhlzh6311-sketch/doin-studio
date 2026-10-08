/**
 * 创作助手（Agent）的数据形状。前后端共用，渲染层只 import type。
 */

/** 工具风险：只读的直接执行；会改动数据 / 发起长任务的需要用户点「执行」（或开了自动执行）。 */
export type AgentToolRisk = "read" | "write";

export interface AgentLink {
  label: string;
  /** 应用内路由，例如 /jobs/xxx */
  to: string;
}

export interface AgentToolResult {
  /** 给用户看的一句话结果（中文）。 */
  summary: string;
  /** 给模型看的结构化结果（会被 JSON 序列化并截断）。 */
  data?: unknown;
  link?: AgentLink;
}

/** 当前页面上下文：让「帮我改写这条」这类指代能落到具体对象。 */
export interface AgentPageContext {
  path?: string;
  jobId?: string;
  articleId?: string;
  title?: string;
}

export type AgentItem =
  | { type: "user"; id: string; text: string; context?: AgentPageContext; createdAt: string }
  | {
      type: "assistant";
      id: string;
      text: string;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      createdAt: string;
    }
  | {
      type: "tool";
      id: string;
      callId: string;
      name: string;
      label: string;
      risk: AgentToolRisk;
      status: "done" | "error" | "denied";
      summary: string;
      link?: AgentLink;
      /** 给模型的完整结果（已截断）。 */
      result: string;
      createdAt: string;
    };

export interface AgentSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: AgentItem[];
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export interface AgentPendingCall {
  callId: string;
  name: string;
  label: string;
  risk: AgentToolRisk;
}

/** SSE 事件。 */
export type AgentEvent =
  | { type: "run"; runId: string; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; call: AgentPendingCall }
  | { type: "approval"; call: AgentPendingCall }
  | { type: "tool_end"; item: Extract<AgentItem, { type: "tool" }> }
  | { type: "done"; session: AgentSession }
  | { type: "error"; message: string };
