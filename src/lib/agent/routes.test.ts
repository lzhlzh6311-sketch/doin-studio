import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerAgentRoutes } from "./routes.js";
import { AgentSessionStore } from "./sessions.js";
import type { AgentChatClient } from "./runner.js";
import type { AgentEvent } from "./types.js";

const fakeSessions = { resolve: async () => ({ id: "u", displayName: "我", role: "admin" }) } as never;

async function serve(rounds: unknown[][]) {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-routes-"));
  const app = express();
  app.use(express.json());
  let started = 0;
  const client: AgentChatClient = { chat: { completions: { create: async () => {
    const chunks = rounds.shift() ?? [];
    return (async function* () { for (const c of chunks) yield c as never; })();
  } } } };
  registerAgentRoutes(app, {
    sessions: fakeSessions,
    store: new AgentSessionStore(dir),
    resolveAiConfig: async () => ({ model: "m", apiKey: "k" }),
    createClient: () => client,
    tools: {
      listJobs: async () => [], getJob: async () => undefined, readCleaned: async () => null, readTranscript: async () => null,
      createJob: async () => ({ id: "j1", topic: "新作品" }) as never, startJobStep: async () => { started += 1; },
      hotspots: async () => [], saveHotspot: async () => ({}) as never, listArticles: async () => [], getArticle: async () => ({}) as never,
      createArticle: async () => ({}) as never, runtimeStatus: async () => [],
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent`;
  return { base, server, started: () => started };
}

async function* events(response: Response): AsyncGenerator<AgentEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6)) as AgentEvent;
    }
  }
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("发消息 → SSE 流式回复 → 写操作经确认后执行 → 会话落盘可列出", async () => {
  const link = "https://v.douyin.com/abc/";
  const { base, server } = await serve([
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "create_video_job", arguments: JSON.stringify({ link }) } }] } }] }],
    [{ choices: [{ delta: { content: "已经建好了。" } }] }],
  ]);
  try {
    const { session } = await (await post(`${base}/sessions`, {})).json() as { session: { id: string } };
    const response = await post(`${base}/sessions/${session.id}/messages`, { text: "帮我导入这个视频 " + link });
    assert.equal(response.status, 200);
    let runId = "";
    const seen: string[] = [];
    for await (const event of events(response)) {
      seen.push(event.type);
      if (event.type === "run") runId = event.runId;
      if (event.type === "approval") {
        assert.equal(event.call.label, "新建视频作品");
        assert.equal((await post(`${base}/runs/${runId}/approvals/${event.call.callId}`, { approve: true })).status, 200);
      }
      if (event.type === "done") assert.equal(event.session.items.at(-1)?.type, "assistant");
    }
    assert.deepEqual(seen.filter((t) => t !== "text"), ["run", "approval", "tool_start", "tool_end", "done"]);
    const { sessions } = await (await fetch(`${base}/sessions`)).json() as { sessions: Array<{ title: string; preview: string }> };
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].preview, "已经建好了。");
  } finally {
    server.close();
  }
});

test("没配 AI 密钥时给出中文指引", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-routes-"));
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { sessions: fakeSessions, store: new AgentSessionStore(dir), resolveAiConfig: async () => null, createClient: () => { throw new Error("x"); }, tools: {} as never });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent`;
    const { session } = await (await post(`${base}/sessions`, {})).json() as { session: { id: string } };
    const response = await post(`${base}/sessions/${session.id}/messages`, { text: "你好" });
    assert.equal(response.status, 422);
    assert.match((await response.json() as { message: string }).message, /AI 模型与密钥/);
  } finally {
    server.close();
  }
});
