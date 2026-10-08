import test from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn, toChatMessages, type AgentChatClient } from "./runner.js";
import type { AgentToolDeps } from "./tools.js";
import type { AgentEvent, AgentSession } from "./types.js";

type Chunk = { choices: Array<{ delta: Record<string, unknown> }> };
const textChunk = (content: string): Chunk => ({ choices: [{ delta: { content } }] });
const callChunk = (id: string, name: string, args: string): Chunk => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] });

function scriptedClient(rounds: Chunk[][]) {
  const requests: Array<Record<string, unknown>> = [];
  const client: AgentChatClient = {
    chat: { completions: { create: async (params) => {
      requests.push(params);
      const chunks = rounds.shift() ?? [textChunk("（没有更多脚本）")];
      return (async function* () { for (const c of chunks) yield c; })();
    } } },
  };
  return { client, requests };
}

const job = { id: "job-1", topic: "测试作品", sourceUrl: "https://v.douyin.com/x/", status: "done", stage: "transcribed", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", storagePath: "", steps: { transcribe: { status: "succeeded", attempts: 1 }, clean: { status: "pending", attempts: 0 }, generate_video_prompts: { status: "pending", attempts: 0 }, generate_video: { status: "pending", attempts: 0 } } };

function deps(overrides: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    listJobs: async () => [{ ...job, preview: { displayTitle: "测试作品", subtitle: "", sourcePlatform: "抖音", hasTranscript: true, hasRewrite: false, hasVideoPrompts: false, hasVideo: false } }] as never,
    getJob: async () => job as never,
    readCleaned: async () => null,
    readTranscript: async () => "原视频讲了三件事",
    createJob: async () => job as never,
    startJobStep: async () => undefined,
    hotspots: async () => [],
    saveHotspot: async () => ({ id: "f", title: "t" }) as never,
    listArticles: async () => [],
    getArticle: async () => ({}) as never,
    createArticle: async () => ({ id: "a", keyword: "k" }) as never,
    runtimeStatus: async () => [],
    ...overrides,
  };
}

const newSession = (): AgentSession => ({ id: "00000000-0000-0000-0000-000000000000", title: "新对话", createdAt: "", updatedAt: "", items: [] });

test("只读工具直接执行，结果回填后模型给出最终回答", async () => {
  const { client, requests } = scriptedClient([[callChunk("c1", "get_job", "{}")], [textChunk("这条已转录，"), textChunk("下一步是 AI 洗稿。")]]);
  const events: AgentEvent[] = [];
  const session = await runAgentTurn({
    session: newSession(), text: "这条进行到哪了", context: { path: "/jobs/job-1", jobId: "job-1" }, autoApprove: false,
    signal: new AbortController().signal, client, model: "m", deps: deps(), emit: (e) => events.push(e),
    requestApproval: async () => { throw new Error("只读工具不该要确认"); }, save: async () => undefined,
  });
  assert.equal(session.title, "这条进行到哪了");
  const tool = session.items.find((i) => i.type === "tool");
  assert.ok(tool && tool.type === "tool" && tool.status === "done" && tool.link?.to === "/jobs/job-1");
  assert.equal(session.items.at(-1)?.type === "assistant" && session.items.at(-1)?.type === "assistant" ? (session.items.at(-1) as { text: string }).text : "", "这条已转录，下一步是 AI 洗稿。");
  assert.ok(events.some((e) => e.type === "text"));
  // 第二轮请求里带上了 tool 结果
  const second = requests[1].messages as Array<{ role: string; content?: string }>;
  assert.ok(second.some((m) => m.role === "tool" && m.content?.includes("原视频讲了三件事")));
  assert.match(String((requests[0].messages as Array<{ content: string }>)[0].content), /正在看作品 job-1/);
});

test("会改数据的工具要用户确认；拒绝后不执行", async () => {
  let started = false;
  const { client } = scriptedClient([[callChunk("c1", "run_job_step", '{"step":"clean"}')], [textChunk("好的，先不执行。")]]);
  const events: AgentEvent[] = [];
  const session = await runAgentTurn({
    session: newSession(), text: "洗稿", context: { jobId: "job-1" }, autoApprove: false,
    signal: new AbortController().signal, client, model: "m",
    deps: deps({ startJobStep: async () => { started = true; } }), emit: (e) => events.push(e),
    requestApproval: async (call) => { assert.equal(call.label, "执行「AI 洗稿」"); return false; }, save: async () => undefined,
  });
  assert.equal(started, false);
  assert.ok(events.some((e) => e.type === "approval"));
  const tool = session.items.find((i) => i.type === "tool");
  assert.ok(tool && tool.type === "tool" && tool.status === "denied");
});

test("开了自动执行时直接执行写操作", async () => {
  let started = "";
  const { client } = scriptedClient([[callChunk("c1", "run_job_step", '{"step":"clean"}')], [textChunk("已开始。")]]);
  await runAgentTurn({
    session: newSession(), text: "洗稿", context: { jobId: "job-1" }, autoApprove: true,
    signal: new AbortController().signal, client, model: "m",
    deps: deps({ startJobStep: async (_id, step) => { started = step; } }), emit: () => undefined,
    requestApproval: async () => { throw new Error("不该询问"); }, save: async () => undefined,
  });
  assert.equal(started, "clean");
});

test("工具报错以中文回填，不中断对话", async () => {
  const { client } = scriptedClient([[callChunk("c1", "get_job", "{}")], [textChunk("请先打开一个作品。")]]);
  const session = await runAgentTurn({
    session: newSession(), text: "看看这条", autoApprove: false, signal: new AbortController().signal, client, model: "m",
    deps: deps(), emit: () => undefined, requestApproval: async () => true, save: async () => undefined,
  });
  const tool = session.items.find((i) => i.type === "tool");
  assert.ok(tool && tool.type === "tool" && tool.status === "error" && /没有指定作品/.test(tool.summary));
});

test("历史裁剪从用户消息开始，不会以孤立的工具结果开头", () => {
  const items = [
    { type: "assistant", id: "1", text: "", toolCalls: [{ id: "c", name: "x", arguments: "{}" }], createdAt: "" },
    { type: "tool", id: "2", callId: "c", name: "x", label: "", risk: "read", status: "done", summary: "", result: "{}", createdAt: "" },
    { type: "user", id: "3", text: "你好", createdAt: "" },
  ] as AgentSession["items"];
  const messages = toChatMessages(items);
  assert.equal(messages[0].role, "user");
});
