/**
 * 「省事」功能的纯逻辑：剪贴板链接识别、准备清单、任务完成通知的状态比对。
 * 全部是纯函数，界面组件只负责取数和展示，便于单测。
 */

// ---------- 剪贴板里的抖音链接 ----------

const DOUYIN_URL = /https?:\/\/(?:v\.douyin\.com|(?:www\.)?douyin\.com|(?:www\.)?iesdouyin\.com)\/[^\s，。！？、"'<>）)】]+/i;

/**
 * 从任意文本（抖音「复制链接」得到的整段分享口令，或纯链接）里取出抖音链接。
 * 取不到返回 null。用户主页链接（/user/）不算视频，交给「主页批量采集」。
 */
export function extractDouyinVideoLink(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.slice(0, 4000);
  const match = DOUYIN_URL.exec(trimmed);
  if (!match) return null;
  const url = match[0].replace(/[.,;:!?]+$/, '');
  if (/douyin\.com\/user\//i.test(url)) return null;
  return url;
}

/** 剪贴板内容是否值得提示：有抖音链接、和上次提示过的不同、用户没关掉提示。 */
export function clipboardOffer(text: string | null | undefined, lastOffered: string | null, disabled: boolean): string | null {
  if (disabled) return null;
  const link = extractDouyinVideoLink(text);
  if (!link || link === lastOffered) return null;
  return link;
}

// ---------- 准备清单 ----------

export type SetupItemId = 'ai' | 'douyin' | 'toutiao' | 'xiaohongshu' | 'ffmpeg';

export interface SetupItem {
  id: SetupItemId;
  label: string;
  /** 这一项影响什么（让用户知道为什么要做）。 */
  purpose: string;
  done: boolean;
  /** 未知 = 还没取到状态，不催用户。 */
  unknown: boolean;
  /** 设置页分组。 */
  section: 'models' | 'douyin' | 'toutiao' | 'xhs' | 'runtime';
  /** 是否必需：不做就用不了核心功能。 */
  required: boolean;
}

type RuntimeLike = { id: string; state: 'ready' | 'degraded' | 'blocked' | 'unknown' };

export function buildSetupItems(input: { hasAiKey: boolean | null; runtime: RuntimeLike[] | null }): SetupItem[] {
  const state = (id: string) => input.runtime?.find(item => item.id === id)?.state;
  const runtimeItem = (id: SetupItemId, runtimeId: string, label: string, purpose: string, section: SetupItem['section'], required: boolean): SetupItem => {
    const s = state(runtimeId);
    return { id, label, purpose, section, required, done: s === 'ready', unknown: input.runtime === null || s === undefined || s === 'unknown' };
  };
  return [
    { id: 'ai', label: '配置 AI 密钥', purpose: '改写文案、写公众号文章、生成分镜都靠它', section: 'models', required: true, done: input.hasAiKey === true, unknown: input.hasAiKey === null },
    runtimeItem('douyin', 'douyin', '登录抖音', '导入、下载抖音视频需要登录态', 'douyin', true),
    runtimeItem('ffmpeg', 'ffmpeg', '视频引擎就绪', '转录和成片需要视频引擎', 'runtime', true),
    runtimeItem('toutiao', 'toutiao', '登录今日头条', '一键发布头条文章 / 图文', 'toutiao', false),
    runtimeItem('xiaohongshu', 'xiaohongshu', '登录小红书', '一键发布小红书笔记', 'xhs', false),
  ];
}

export function setupProgress(items: SetupItem[]): { done: number; total: number; requiredMissing: number; allDone: boolean } {
  const done = items.filter(item => item.done).length;
  const requiredMissing = items.filter(item => item.required && !item.done && !item.unknown).length;
  return { done, total: items.length, requiredMissing, allDone: done === items.length };
}

// ---------- 任务完成通知 ----------

export const STEP_LABELS: Record<string, string> = {
  transcribe: '转录',
  clean: '文案整理',
  generate_video_prompts: '分镜生成',
  generate_video: '视频渲染',
};

type JobLike = {
  id: string;
  status: string;
  topic?: string;
  steps?: Record<string, { status?: string } | undefined>;
  preview?: { displayTitle?: string };
};

/** 一个任务在某一刻的状态快照：整体状态 + 各步骤状态。 */
export type JobSnapshot = { status: string; steps: Record<string, string> };

export function snapshotJobs(jobs: JobLike[]): Map<string, JobSnapshot> {
  const map = new Map<string, JobSnapshot>();
  for (const job of jobs) {
    const steps: Record<string, string> = {};
    for (const [key, value] of Object.entries(job.steps ?? {})) if (value?.status) steps[key] = value.status;
    map.set(job.id, { status: job.status, steps });
  }
  return map;
}

export interface JobEvent { jobId: string; title: string; body: string; ok: boolean }

const titleOf = (job: JobLike) => job.preview?.displayTitle || job.topic || '作品';

/**
 * 比较前后两次快照，找出「刚刚跑完」的事情：某一步从 running 变成成功/失败，
 * 或整体从 queued/processing 变成 done/failed。第一次快照（previous 为 null）不报，避免启动时刷屏。
 */
export function diffJobEvents(previous: Map<string, JobSnapshot> | null, jobs: JobLike[]): JobEvent[] {
  if (!previous) return [];
  const events: JobEvent[] = [];
  for (const job of jobs) {
    const before = previous.get(job.id);
    if (!before) continue;
    const title = titleOf(job).slice(0, 60);
    let reported = false;
    for (const [key, value] of Object.entries(job.steps ?? {})) {
      const was = before.steps[key];
      const now = value?.status;
      if (was !== 'running' || !now || now === 'running') continue;
      const label = STEP_LABELS[key] ?? '处理';
      if (now === 'succeeded') { events.push({ jobId: job.id, ok: true, title: `${label}完成`, body: title }); reported = true; }
      else if (now === 'failed') { events.push({ jobId: job.id, ok: false, title: `${label}失败`, body: `${title}：打开作品查看原因` }); reported = true; }
    }
    if (reported) continue;
    const active = before.status === 'queued' || before.status === 'processing';
    if (active && job.status === 'done') events.push({ jobId: job.id, ok: true, title: '视频已导入', body: title });
    else if (active && job.status === 'failed') events.push({ jobId: job.id, ok: false, title: '任务失败', body: `${title}：打开作品查看原因` });
  }
  return events;
}
