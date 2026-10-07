/**
 * 语音转录模型（whisper.cpp ggml-small，约 466 MB）按需下载。
 *
 * 安装包不再携带模型：第一次转录时（或在设置里点「下载」）才下载，
 * 优先走国内镜像 hf-mirror.com，失败再回落 huggingface.co。
 * 下载写到 `<目标>.part`，支持断点续传；完成后校验 SHA-1 再原子改名，
 * 半截文件永远不会被当成可用模型。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

export const WHISPER_MODEL_NAME = "ggml-small";
/** whisper.cpp models/README.md 公布的 ggml-small.bin SHA-1。 */
export const WHISPER_MODEL_SHA1 = "55356645c2b361a969dfd0ef2c5a50d530afd8d5";
/** 约 466 MiB，下载前给界面展示用；实际以服务器 Content-Length 为准。 */
export const WHISPER_MODEL_APPROX_BYTES = 487_601_967;

export const DEFAULT_WHISPER_MODEL_URLS = [
  "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
];

export type WhisperModelState = "ready" | "missing" | "downloading" | "failed";

export interface WhisperModelStatus {
  state: WhisperModelState;
  model: string;
  path: string;
  /** 已下载字节数（下载中或断点残留时有意义）。 */
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface WhisperModelManagerOptions {
  /** 最终模型文件路径（可写位置，例如 userData/models/ggml-small.bin）。 */
  modelPath: string;
  /** 旧版安装包随带的模型；存在就直接用，不再下载。 */
  bundledPath?: string;
  urls?: string[];
  sha1?: string | null;
  fetchImpl?: FetchLike;
}

export class WhisperModelManager {
  private readonly modelPath: string;
  private readonly bundledPath?: string;
  private readonly urls: string[];
  private readonly sha1: string | null;
  private readonly fetchImpl: FetchLike;
  private inflight: Promise<string> | null = null;
  private progress = { downloaded: 0, total: WHISPER_MODEL_APPROX_BYTES };
  private lastError: string | undefined;

  constructor(options: WhisperModelManagerOptions) {
    this.modelPath = options.modelPath;
    this.bundledPath = options.bundledPath;
    const envUrl = process.env.WHISPER_MODEL_URL?.trim();
    this.urls = options.urls ?? (envUrl ? [envUrl] : DEFAULT_WHISPER_MODEL_URLS);
    this.sha1 = options.sha1 === undefined ? WHISPER_MODEL_SHA1 : options.sha1;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** 已就绪的模型路径；没有返回 null（不触发下载）。 */
  async readyPath(): Promise<string | null> {
    if (this.bundledPath && (await isNonEmptyFile(this.bundledPath))) return this.bundledPath;
    if (await isNonEmptyFile(this.modelPath)) return this.modelPath;
    return null;
  }

  async status(): Promise<WhisperModelStatus> {
    const ready = await this.readyPath();
    if (ready) {
      const size = (await stat(ready)).size;
      return { state: "ready", model: WHISPER_MODEL_NAME, path: ready, downloadedBytes: size, totalBytes: size };
    }
    const partial = await fileSize(`${this.modelPath}.part`);
    const base = { model: WHISPER_MODEL_NAME, path: this.modelPath, totalBytes: this.progress.total };
    if (this.inflight) return { ...base, state: "downloading", downloadedBytes: this.progress.downloaded };
    if (this.lastError) return { ...base, state: "failed", downloadedBytes: partial, error: this.lastError };
    return { ...base, state: "missing", downloadedBytes: partial };
  }

  /** 后台开始下载（已在下载或已就绪时什么也不做），立即返回。 */
  start(): void {
    void this.ensure().catch(() => { /* 错误记录在 status().error */ });
  }

  /** 确保模型可用：已就绪直接返回路径，否则下载（并发调用共享同一次下载）。 */
  async ensure(): Promise<string> {
    const ready = await this.readyPath();
    if (ready) return ready;
    if (!this.inflight) {
      this.lastError = undefined;
      this.inflight = this.download()
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async download(): Promise<string> {
    await mkdir(path.dirname(this.modelPath), { recursive: true });
    const partPath = `${this.modelPath}.part`;
    const failures: string[] = [];
    for (const url of this.urls) {
      try {
        await this.downloadFrom(url, partPath);
        if (this.sha1) {
          const actual = await sha1File(partPath);
          if (actual !== this.sha1) {
            await rm(partPath, { force: true });
            throw new Error("文件校验不通过，已删除，请重试");
          }
        }
        await rename(partPath, this.modelPath);
        return this.modelPath;
      } catch (error) {
        failures.push(`${new URL(url).host}：${describe(error)}`);
      }
    }
    throw new Error(`语音模型下载失败（${failures.join("；")}）。请检查网络后在「设置 → 语音转录」重试。`);
  }

  private async downloadFrom(url: string, partPath: string) {
    const existing = await fileSize(partPath);
    const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const resumed = response.status === 206 && existing > 0;
    const length = Number(response.headers.get("content-length") ?? 0);
    const start = resumed ? existing : 0;
    this.progress = { downloaded: start, total: length > 0 ? start + length : WHISPER_MODEL_APPROX_BYTES };

    const counter = new TransformCounter((n) => { this.progress.downloaded += n; });
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      counter,
      createWriteStream(partPath, { flags: resumed ? "a" : "w" }),
    );
    if (length > 0 && this.progress.downloaded < start + length) throw new Error("连接中断");
  }
}

class TransformCounter extends Transform {
  constructor(private readonly onBytes: (n: number) => void) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
    this.onBytes(chunk.length);
    done(null, chunk);
  }
}

async function sha1File(filePath: string) {
  const hash = createHash("sha1");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fileSize(filePath: string) {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

async function isNonEmptyFile(filePath: string) {
  try { const info = await stat(filePath); return info.isFile() && info.size > 0; } catch { return false; }
}

function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network/i.test(message)) return "网络连接失败";
  if (/timeout|timed out/i.test(message)) return "连接超时";
  return message;
}
