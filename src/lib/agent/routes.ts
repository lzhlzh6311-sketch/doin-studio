/**
 * 助手的 HTTP 接口。发消息走 SSE 流式返回；会改数据的工具在流里发 approval 事件，
 * 界面点「执行 / 取消」后调 approvals 接口把这一步放行或拒绝。
 */
import { randomUUID } from "node:crypto";
import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { LocalAuthError, requireActor, type LocalSessionStore } from "../local-auth.js";
import { runAgentTurn, type AgentChatClient } from "./runner.js";
import { AgentSessionError, type AgentSessionStore } from "./sessions.js";
import type { AgentToolDeps } from "./tools.js";
import type { AgentEvent, AgentPageContext } from "./types.js";

export interface AgentAiConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
  maxOutputTokens?: number;
}

export interface AgentRouteDeps {
  sessions: LocalSessionStore;
  store: AgentSessionStore;
  tools: AgentToolDeps;
  resolveAiConfig(): Promise<AgentAiConfig | null>;
  createClient(config: AgentAiConfig): AgentChatClient;
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  approvals: Map<string, (ok: boolean) => void>;
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

function pageContext(value: unknown): AgentPageContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const ctx: AgentPageContext = {
    ...(str(v.path, 300) ? { path: str(v.path, 300) } : {}),
    ...(str(v.jobId, 100) ? { jobId: str(v.jobId, 100) } : {}),
    ...(str(v.articleId, 100) ? { articleId: str(v.articleId, 100) } : {}),
    ...(str(v.title, 100) ? { title: str(v.title, 100) } : {}),
  };
  return Object.keys(ctx).length ? ctx : undefined;
}

export function registerAgentRoutes(app: Express, deps: AgentRouteDeps) {
  const router = Router();
  const auth = requireActor(deps.sessions);
  const runs = new Map<string, ActiveRun>();
  const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);

  router.get("/agent/sessions", auth, route(async (_req, res) => { res.json({ sessions: await deps.store.list() }); }));
  router.post("/agent/sessions", auth, route(async (_req, res) => { res.status(201).json({ session: await deps.store.create() }); }));
  router.get("/agent/sessions/:id", auth, route(async (req, res) => {
    const session = await deps.store.get(String(req.params.id));
    const running = [...runs.entries()].find(([, run]) => run.sessionId === session.id)?.[0];
    res.json({ session, runId: running ?? null });
  }));
  router.delete("/agent/sessions/:id", auth, route(async (req, res) => {
    const id = String(req.params.id);
    for (const run of runs.values()) if (run.sessionId === id) run.controller.abort();
    await deps.store.remove(id);
    res.json({ ok: true });
  }));

  router.post("/agent/sessions/:id/messages", auth, route(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = str(body.text, 8000)?.trim();
    if (!text) throw new AgentSessionError(400, "请输入内容");
    const session = await deps.store.get(String(req.params.id));
    if ([...runs.values()].some((run) => run.sessionId === session.id)) throw new AgentSessionError(409, "这个对话还在回复中，请稍等或先停止");
    const config = await deps.resolveAiConfig();
    if (!config?.apiKey) throw new AgentSessionError(422, "还没有配置 AI 密钥：请到「设置 → AI 模型与密钥」添加后再用助手");

    const runId = randomUUID();
    const run: ActiveRun = { sessionId: session.id, controller: new AbortController(), approvals: new Map() };
    runs.set(runId, run);

    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (event: AgentEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": heartbeat\n\n"); }, 15_000);
    // 窗口关掉 / 切走导致连接断开 → 停止本轮，未确认的操作一律视为取消
    res.on("close", () => { if (!res.writableFinished) run.controller.abort(); });
    run.controller.signal.addEventListener("abort", () => { for (const resolve of run.approvals.values()) resolve(false); run.approvals.clear(); });

    emit({ type: "run", runId, sessionId: session.id });
    try {
      const done = await runAgentTurn({
        session,
        text,
        context: pageContext(body.context),
        autoApprove: body.autoApprove === true,
        signal: run.controller.signal,
        client: deps.createClient(config),
        model: config.model,
        baseURL: config.baseURL,
        maxOutputTokens: config.maxOutputTokens,
        deps: deps.tools,
        emit,
        requestApproval: (call) => new Promise<boolean>((resolve) => {
          if (run.controller.signal.aborted) { resolve(false); return; }
          run.approvals.set(call.callId, (ok) => { run.approvals.delete(call.callId); resolve(ok); });
        }),
        save: (s) => deps.store.save(s),
      });
      emit({ type: "done", session: done });
    } catch (error) {
      emit({ type: "error", message: error instanceof Error ? error.message : "助手出错了，请重试" });
    } finally {
      clearInterval(heartbeat);
      runs.delete(runId);
      res.end();
    }
  }));

  router.post("/agent/runs/:runId/cancel", auth, route(async (req, res) => {
    runs.get(String(req.params.runId))?.controller.abort();
    res.json({ ok: true });
  }));

  router.post("/agent/runs/:runId/approvals/:callId", auth, route(async (req, res) => {
    const run = runs.get(String(req.params.runId));
    const resolve = run?.approvals.get(String(req.params.callId));
    if (!resolve) throw new AgentSessionError(404, "这个操作已经结束或已取消");
    resolve((req.body as { approve?: unknown } | undefined)?.approve === true);
    res.json({ ok: true });
  }));

  app.use("/api", router);
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/agent")) { next(error); return; }
    if (error instanceof LocalAuthError || error instanceof AgentSessionError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    console.error("[agent]", error);
    res.status(500).json({ message: error instanceof Error ? error.message : "助手出错了" });
  });
}
