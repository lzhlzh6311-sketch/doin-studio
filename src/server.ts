import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createExpressApp } from "./app.js";
import type { AiProvider } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

/** 与桌面端口径一致：未设置或只有空白都视为“没配”。 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const configuredProvider = env("AI_PROVIDER");
const aiProvider: AiProvider = configuredProvider === "openai" || configuredProvider === "custom" || configuredProvider === "deepseek"
  ? configuredProvider
  : "deepseek";
const aiApiKey =
  env("AI_API_KEY")
  ?? (aiProvider === "deepseek"
    ? env("DEEPSEEK_API_KEY") ?? env("OPENAI_API_KEY")
    : env("OPENAI_API_KEY"));

const app = await createExpressApp({
  storagePath: path.join(rootDir, "storage"),
  rootDir,
  aiProvider,
  aiModel: env("AI_MODEL") ?? "deepseek-v4-pro",
  aiApiKey,
  aiBaseURL: env("AI_BASE_URL") ?? (aiProvider === "deepseek" ? "https://api.deepseek.com" : undefined),
  ytDlpBinary: env("YTDLP_BINARY"),
  ffmpegBinary: env("FFMPEG_BINARY"),
  ffprobeBinary: env("FFPROBE_BINARY") ?? "ffprobe",
  cookiesFile: env("YTDLP_COOKIES_FILE"),
  cookiesFromBrowser: env("YTDLP_COOKIES_FROM_BROWSER"),
  whisperCliPath: env("WHISPER_CLI_BINARY"),
  whisperModelPath: env("WHISPER_MODEL_PATH"),
  hyperframesNpxBinary: env("HYPERFRAMES_NPX_BINARY"),
  // 抖音图文自动发布的外部引擎（social-auto-upload）；未配置时该通路给出明确安装指引
  sauBinary: env("SAU_BINARY"),
  sauBaseDir: env("SAU_BASE_DIR"),
  // 今日头条：浏览器路径与会话目录（与 SAU_* 同一套 env 契约）
  toutiaoBrowserBinary: env("TOUTIAO_BROWSER_BINARY"),
  wechatMp: { appId: env("WECHAT_MP_APP_ID"), appSecret: env("WECHAT_MP_APP_SECRET"), author: env("WECHAT_MP_AUTHOR") },
  toutiaoProfileDir: env("TOUTIAO_PROFILE_DIR"),
  // 小红书：同一套 env 契约（浏览器解析链缺省就能找到打包进来的 headless shell）
  xhsBrowserBinary: env("XHS_BROWSER_BINARY"),
  xhsProfileDir: env("XHS_PROFILE_DIR"),
  // 可选：设置后 `/api/*` 必须带 `X-Doin-Token`（见 src/lib/local-origin-guard.ts）
  apiToken: env("DOIN_API_TOKEN")
});

const port = Number(env("PORT") ?? 3100);

// 只监听本机回环：这是单机工作台，不应暴露到局域网（早先不传 host 会监听所有网卡）。
const host = "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}`);
});

// 漏网的 Promise 拒绝只记日志，不让整个后端随之退出（Node 默认会因此崩溃）。
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason);
});

// 设置全局超时：10 分钟（generate-skill 等路由需要较长时间）
server.timeout = 600_000;
