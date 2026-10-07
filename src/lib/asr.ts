import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import type { TranscriptSegment, TranscriptWord } from "../types.js";
import type { WhisperModelManager } from "./whisper-model.js";

export interface AsrServiceConfig {
  rootDir?: string;
  whisperCliPath?: string;
  whisperModelPath?: string;
  /** 提供时模型按需下载：第一次转录前自动拉取，不再要求安装包自带。 */
  modelManager?: WhisperModelManager;
  commandRunner?: AsrCommandRunner;
}

export interface AsrCommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      captureStdout?: boolean;
      captureStderr?: boolean;
    }
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface TranscriptResult {
  text: string;
  model: string;
  provider: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  duration?: number;
  language?: string;
  raw?: unknown;
}

const PROVIDER = "whisper.cpp";
const MODEL = "ggml-small";

export class AsrService {
  private readonly whisperCliPath: string;
  private readonly whisperModelPath: string;
  private readonly runner: AsrCommandRunner;
  private readonly modelManager?: WhisperModelManager;

  constructor(config: AsrServiceConfig = {}) {
    const whisperRoot = getWhisperRoot(config.rootDir);
    this.whisperCliPath =
      firstNonBlank(config.whisperCliPath, process.env.WHISPER_CLI_BINARY) ??
      path.join(whisperRoot, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
    this.whisperModelPath =
      firstNonBlank(config.whisperModelPath, process.env.WHISPER_MODEL_PATH) ??
      path.join(whisperRoot, "models", `${MODEL}.bin`);
    this.modelManager = config.modelManager;
    this.runner = config.commandRunner ?? {
      run: runCommand
    };
  }

  /** 模型默认路径（未配置按需下载时也用它判断是否就绪）。 */
  get defaultModelPath() {
    return this.whisperModelPath;
  }

  async transcribe(audioPath: string): Promise<TranscriptResult | null> {
    const modelPath = this.modelManager ? await this.modelManager.ensure() : this.whisperModelPath;
    await this.assertResources(audioPath, modelPath);

    const workDir = await mkdtemp(path.join(tmpdir(), "douyin-whisper-"));
    const outputPrefix = path.join(workDir, "transcript");
    try {
      await this.runner
        .run(
          this.whisperCliPath,
          [
            "-m",
            modelPath,
            "-f",
            audioPath,
            "-l",
            "zh",
            "-ojf",
            "-of",
            outputPrefix,
            "-np"
          ],
          {
            captureStdout: true,
            captureStderr: true
          }
        )
        .catch((error) => {
          throw decorateWhisperError(error);
        });

      const payload = await readWhisperJson(outputPrefix);
      const segments = extractSegments(payload);
      const text = extractText(payload, segments);
      if (!text) {
        return null;
      }

      return {
        text,
        model: MODEL,
        provider: PROVIDER,
        segments: segments.length ? segments : [{ text }],
        words: extractWords(payload),
        duration: extractDuration(payload, segments),
        language: extractLanguage(payload) ?? "zh",
        raw: payload
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async assertResources(audioPath: string, modelPath: string) {
    const missing: string[] = [];
    await access(this.whisperCliPath).catch(() => missing.push(`whisper-cli: ${this.whisperCliPath}`));
    await access(modelPath).catch(() => missing.push(`ggml-small: ${modelPath}`));
    await access(audioPath).catch(() => missing.push(`audio: ${audioPath}`));

    if (missing.length) {
      throw new Error(
        [
          "语音转录组件缺失或损坏，无法执行本地转录。",
          ...missing,
          "请重新安装应用；若是语音模型缺失，可在「设置 → 语音转录」重新下载。"
        ].join("\n")
      );
    }
  }
}

async function readWhisperJson(outputPrefix: string) {
  const jsonPath = `${outputPrefix}.json`;
  try {
    return JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
  } catch (error) {
    if (!isMissingFileError(error)) {
      const message = error instanceof Error ? error.message : "JSON 格式无效";
      throw new Error(`语音转录失败：JSON 输出格式无效。\n${message}`);
    }
  }

  try {
    return JSON.parse(await readFile(outputPrefix, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "没有生成转录结果文件";
    throw new Error(`语音转录失败：未生成 JSON 输出。\n${message}`);
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function extractText(payload: unknown, segments: TranscriptSegment[]) {
  const direct = firstNonBlank((payload as { text?: unknown })?.text);
  if (direct) {
    return direct;
  }
  return segments.map((segment) => segment.text).filter(Boolean).join("\n").trim();
}

function extractSegments(payload: unknown): TranscriptSegment[] {
  const source = getSegmentSource(payload);
  return source
    .map((segment): TranscriptSegment | null => {
      const row = segment as {
        start?: unknown;
        end?: unknown;
        text?: unknown;
        offsets?: { from?: unknown; to?: unknown };
        timestamps?: { from?: unknown; to?: unknown };
      };
      const text = firstNonBlank(row.text);
      if (!text) {
        return null;
      }
      return {
        start: toSeconds(row.start ?? row.offsets?.from ?? row.timestamps?.from),
        end: toSeconds(row.end ?? row.offsets?.to ?? row.timestamps?.to),
        text
      };
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function getSegmentSource(payload: unknown): unknown[] {
  const value = payload as { segments?: unknown; transcription?: unknown };
  if (Array.isArray(value.segments)) {
    return value.segments;
  }
  if (Array.isArray(value.transcription)) {
    return value.transcription;
  }
  return [];
}

function extractWords(payload: unknown): TranscriptWord[] | undefined {
  const words = (payload as { words?: unknown })?.words;
  if (!Array.isArray(words)) {
    return undefined;
  }

  const result = words
    .map((word): TranscriptWord | null => {
      const row = word as { start?: unknown; end?: unknown; word?: unknown; text?: unknown; probability?: unknown };
      const text = firstNonBlank(row.word, row.text);
      if (!text) {
        return null;
      }
      return {
        start: toSeconds(row.start),
        end: toSeconds(row.end),
        word: text,
        probability: toFiniteNumber(row.probability)
      };
    })
    .filter((word): word is TranscriptWord => Boolean(word));

  return result.length ? result : undefined;
}

function extractDuration(payload: unknown, segments: TranscriptSegment[]) {
  const direct = toFiniteNumber((payload as { duration?: unknown })?.duration);
  if (direct !== undefined) {
    return direct;
  }
  const end = Math.max(...segments.map((segment) => segment.end ?? 0));
  return Number.isFinite(end) && end > 0 ? end : undefined;
}

function extractLanguage(payload: unknown) {
  const direct = firstNonBlank((payload as { language?: unknown })?.language);
  if (direct) {
    return direct;
  }
  const result = (payload as { result?: { language?: unknown }; params?: { language?: unknown } });
  return firstNonBlank(result.result?.language, result.params?.language);
}

function toSeconds(value: unknown) {
  if (typeof value === "string" && /^\d{2}:\d{2}:\d{2}[,.]\d{3}$/.test(value.trim())) {
    const [hours = "0", minutes = "0", rest = "0"] = value.trim().replace(",", ".").split(":");
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
  }

  const numberValue = toFiniteNumber(value);
  if (numberValue === undefined) {
    return undefined;
  }
  return Math.abs(numberValue) >= 1000 ? numberValue / 1000 : numberValue;
}

function toFiniteNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function decorateWhisperError(error: unknown) {
  if (error instanceof CommandError) {
    const detail = firstNonBlank(error.stderr, error.stdout, error.message) ?? "转录程序异常退出";
    return new Error(`语音转录失败：${detail}`);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`语音转录失败：${message}`);
}

function getWhisperRoot(rootDir?: string) {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return firstNonBlank(
    process.env.WHISPER_DIR,
    resourcesPath ? path.join(resourcesPath, "whisper") : undefined,
    rootDir ? path.join(rootDir, "vendor", "whisper") : undefined,
    path.join(process.cwd(), "vendor", "whisper")
  )!;
}

function firstNonBlank(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
