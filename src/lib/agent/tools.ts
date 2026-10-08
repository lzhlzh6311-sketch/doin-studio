/**
 * 助手可调用的工具：全部包在已有服务外面，不另起一套业务逻辑。
 * 只读工具直接执行；会改数据或起长任务的（risk: write）先给用户确认。
 */
import type { JobOverview, JobRecord, PipelineStep } from "../../types.js";
import type { HotspotBoard, HotspotFavorite } from "../hotspots.js";
import type { ArticleRecord } from "../article-types.js";
import type { AgentPageContext, AgentToolResult, AgentToolRisk } from "./types.js";

export interface AgentToolDeps {
  listJobs(): Promise<JobOverview[]>;
  getJob(id: string): Promise<JobRecord | undefined>;
  /** 洗稿结果（标题、文稿等）；没有返回 null。 */
  readCleaned(id: string): Promise<Record<string, unknown> | null>;
  /** 转录全文；没有返回 null。 */
  readTranscript(id: string): Promise<string | null>;
  createJob(input: { sourceUrl?: string; shareText?: string; topic?: string }): Promise<JobRecord>;
  /** 后台开始一个步骤（不等待完成）。 */
  startJobStep(id: string, step: PipelineStep): Promise<void>;
  hotspots(): Promise<HotspotBoard[]>;
  saveHotspot(sourceId: string, itemId: string): Promise<HotspotFavorite>;
  listArticles(): Promise<ArticleRecord[]>;
  getArticle(id: string): Promise<ArticleRecord>;
  createArticle(input: { keyword?: string; hotspot?: { sourceId: string; itemId: string } }): Promise<ArticleRecord>;
  runtimeStatus(): Promise<Array<{ label: string; state: string; detail: string }>>;
}

export interface AgentToolContext {
  deps: AgentToolDeps;
  page?: AgentPageContext;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: AgentToolRisk;
  /** 工具卡片上的中文标题，例如「新建视频任务」。 */
  label(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: AgentToolContext): Promise<AgentToolResult>;
}

const STEP_LABELS: Record<PipelineStep, string> = {
  transcribe: "视频转录",
  clean: "AI 洗稿",
  generate_video_prompts: "生成分镜",
  generate_video: "生成视频",
};
const STEP_STATUS: Record<string, string> = { pending: "未开始", running: "进行中", succeeded: "已完成", failed: "失败", paused: "已暂停" };
const PIPELINE: PipelineStep[] = ["transcribe", "clean", "generate_video_prompts", "generate_video"];

const str = (value: unknown, max = 2000) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const num = (value: unknown, fallback: number, min: number, max: number) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function jobTitle(job: JobOverview | JobRecord) {
  return ("preview" in job && job.preview?.displayTitle) || job.topic || "未命名作品";
}

function stepSummary(job: JobRecord) {
  return PIPELINE.map((step) => {
    const state = job.steps?.[step];
    return { step, name: STEP_LABELS[step], status: STEP_STATUS[state?.status ?? "pending"] ?? state?.status, error: state?.lastError };
  });
}

function resolveJobId(args: Record<string, unknown>, ctx: AgentToolContext) {
  const id = str(args.jobId, 100) || ctx.page?.jobId || "";
  if (!id) throw new Error("没有指定作品：请先打开某个作品，或说清楚是哪一条");
  return id;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "list_jobs",
    description: "列出最近的视频作品（标题、进度、ID）。可按关键词筛选。",
    parameters: schema({ query: { type: "string", description: "标题关键词，可选" }, limit: { type: "number", description: "最多返回几条，默认 10" } }),
    risk: "read",
    label: () => "查看作品列表",
    async run(args, { deps }) {
      const query = str(args.query, 100);
      const limit = num(args.limit, 10, 1, 30);
      const jobs = (await deps.listJobs()).filter((job) => !job.deletedAt && (!query || jobTitle(job).includes(query)));
      const rows = jobs.slice(0, limit).map((job) => ({
        id: job.id,
        title: jobTitle(job),
        createdAt: job.createdAt,
        steps: Object.fromEntries(PIPELINE.map((step) => [STEP_LABELS[step], STEP_STATUS[job.steps?.[step]?.status ?? "pending"]])),
      }));
      return { summary: jobs.length ? `共 ${jobs.length} 个作品，列出 ${rows.length} 个` : "还没有作品", data: rows, link: { label: "打开作品列表", to: "/" } };
    },
  },
  {
    name: "get_job",
    description: "查看一个作品的详情：各步骤进度、失败原因、洗稿后的标题与文稿、转录摘录。jobId 省略时用当前打开的作品。",
    parameters: schema({ jobId: { type: "string" } }),
    risk: "read",
    label: () => "查看作品详情",
    async run(args, ctx) {
      const id = resolveJobId(args, ctx);
      const job = await ctx.deps.getJob(id);
      if (!job || job.deletedAt) throw new Error("作品不存在或已被删除");
      const [cleaned, transcript] = await Promise.all([ctx.deps.readCleaned(id), ctx.deps.readTranscript(id)]);
      return {
        summary: `「${jobTitle(job)}」：${stepSummary(job).map((s) => `${s.name}${s.status}`).join("、")}`,
        data: {
          id,
          title: jobTitle(job),
          sourceUrl: job.sourceUrl,
          steps: stepSummary(job),
          cleaned: cleaned ?? undefined,
          transcriptExcerpt: transcript ? transcript.slice(0, 3000) : undefined,
        },
        link: { label: "打开作品", to: `/jobs/${id}` },
      };
    },
  },
  {
    name: "create_video_job",
    description: "用抖音视频链接或整段分享口令新建视频作品（之后可依次执行转录、洗稿、分镜、生成视频）。",
    parameters: schema({ link: { type: "string", description: "抖音链接或分享口令" }, topic: { type: "string", description: "作品备注标题，可选" } }, ["link"]),
    risk: "write",
    label: () => "新建视频作品",
    async run(args, { deps }) {
      const link = str(args.link, 4000);
      if (!link) throw new Error("缺少抖音链接");
      const isUrl = /^https?:\/\/\S+$/.test(link);
      const job = await deps.createJob({ ...(isUrl ? { sourceUrl: link } : { shareText: link }), ...(str(args.topic) ? { topic: str(args.topic, 200) } : {}) });
      return { summary: `已新建作品「${jobTitle(job)}」`, data: { id: job.id, title: jobTitle(job) }, link: { label: "打开作品", to: `/jobs/${job.id}` } };
    },
  },
  {
    name: "run_job_step",
    description: "在后台执行作品的一个步骤：transcribe=视频转录，clean=AI 洗稿，generate_video_prompts=生成分镜，generate_video=生成视频。步骤必须按顺序，前一步成功后才能执行下一步。立即返回，不等完成。",
    parameters: schema({ jobId: { type: "string" }, step: { type: "string", enum: PIPELINE } }, ["step"]),
    risk: "write",
    label: (args) => `执行「${STEP_LABELS[args.step as PipelineStep] ?? "步骤"}」`,
    async run(args, ctx) {
      const id = resolveJobId(args, ctx);
      const step = args.step as PipelineStep;
      if (!PIPELINE.includes(step)) throw new Error("未知步骤");
      await ctx.deps.startJobStep(id, step);
      return { summary: `已在后台开始「${STEP_LABELS[step]}」，完成后会有通知`, data: { id, step, started: true }, link: { label: "查看进度", to: `/jobs/${id}` } };
    },
  },
  {
    name: "get_hotspots",
    description: "读取实时热榜（抖音、头条、百度、知乎、B站等），用于找选题。",
    parameters: schema({ source: { type: "string", description: "榜单名关键词，如 抖音、知乎；省略则全部" }, limit: { type: "number", description: "每个榜单取前几条，默认 10" } }),
    risk: "read",
    label: () => "查看热榜",
    async run(args, { deps }) {
      const source = str(args.source, 40);
      const limit = num(args.limit, 10, 1, 30);
      const boards = (await deps.hotspots()).filter((b) => !source || b.source.name.includes(source) || b.source.label.includes(source) || b.source.id.includes(source));
      return {
        summary: boards.length ? `读取了 ${boards.map((b) => b.source.label || b.source.name).join("、")}` : "没有找到这个榜单",
        data: boards.map((b) => ({ sourceId: b.source.id, board: b.source.label || b.source.name, status: b.status, items: b.items.slice(0, limit).map((i) => ({ itemId: i.itemId, rank: i.rank, title: i.title, heat: i.heat })) })),
        link: { label: "打开热榜", to: "/hotspots" },
      };
    },
  },
  {
    name: "favorite_hotspot",
    description: "把一条热榜收藏为选题（需要 get_hotspots 返回的 sourceId 与 itemId）。",
    parameters: schema({ sourceId: { type: "string" }, itemId: { type: "string" } }, ["sourceId", "itemId"]),
    risk: "write",
    label: () => "收藏选题",
    async run(args, { deps }) {
      const saved = await deps.saveHotspot(str(args.sourceId, 100), str(args.itemId, 2048));
      return { summary: `已收藏「${saved.title}」`, data: { id: saved.id, title: saved.title }, link: { label: "查看收藏", to: "/hotspots" } };
    },
  },
  {
    name: "list_articles",
    description: "列出公众号文章（标题/关键词、进度、ID）。",
    parameters: schema({ limit: { type: "number" } }),
    risk: "read",
    label: () => "查看公众号文章",
    async run(args, { deps }) {
      const list = await deps.listArticles();
      const rows = list.slice(0, num(args.limit, 10, 1, 30)).map((a) => ({ id: a.id, keyword: a.keyword, updatedAt: a.updatedAt, steps: a.steps }));
      return { summary: list.length ? `共 ${list.length} 篇文章` : "还没有公众号文章", data: rows, link: { label: "打开公众号", to: "/articles" } };
    },
  },
  {
    name: "create_article",
    description: "按关键词（或热榜条目）新建一篇公众号文章，之后在文章页逐步完成选题、查证、成稿。",
    parameters: schema({ keyword: { type: "string" }, sourceId: { type: "string", description: "来自热榜时填" }, itemId: { type: "string", description: "来自热榜时填" } }),
    risk: "write",
    label: () => "新建公众号文章",
    async run(args, { deps }) {
      const sourceId = str(args.sourceId, 100);
      const itemId = str(args.itemId, 2048);
      const keyword = str(args.keyword, 500);
      if (!keyword && !(sourceId && itemId)) throw new Error("缺少关键词");
      const article = await deps.createArticle(sourceId && itemId ? { hotspot: { sourceId, itemId }, ...(keyword ? { keyword } : {}) } : { keyword });
      return { summary: `已新建文章「${article.keyword}」`, data: { id: article.id, keyword: article.keyword }, link: { label: "打开文章", to: `/articles/${article.id}` } };
    },
  },
  {
    name: "check_environment",
    description: "检查运行环境：抖音/头条/小红书登录态、视频引擎、存储目录。排查「为什么下载/发布失败」时用。",
    parameters: schema({}),
    risk: "read",
    label: () => "检查运行环境",
    async run(_args, { deps }) {
      const items = await deps.runtimeStatus();
      const bad = items.filter((i) => i.state !== "ready");
      return { summary: bad.length ? `${bad.length} 项需要处理：${bad.map((i) => i.label).join("、")}` : "环境全部就绪", data: items, link: { label: "打开设置", to: "/settings?section=runtime" } };
    },
  },
];

export function findTool(name: string) {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

export function toolSpecs() {
  return AGENT_TOOLS.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
