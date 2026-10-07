/**
 * 后端配置管理（独立运行模式，替代 Electron IPC）。
 * 读取和写入 ~/.douyin-ai-video/config.json。
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AiProvider } from "../types.js";

const CONFIG_DIR = path.join(homedir(), ".douyin-ai-video");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export interface AIKeyConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxOutputTokens?: number;
  isActive: boolean;
  isValid?: boolean;
  lastTested?: string;
}

export type AIKeyInput = Omit<AIKeyConfig, "id" | "isActive" | "isValid" | "lastTested">;

export type AiErrorCode = "dns" | "tls" | "timeout" | "auth" | "endpoint" | "model" | "quota" | "upstream" | "unknown";

export interface AIKeyTestResult {
  valid: boolean;
  code?: AiErrorCode;
  error?: string;
  testedAt?: string;
}

export interface AppConfig {
  storagePath: string;
  aiKeys: AIKeyConfig[];
  asrProvider?: string;
  asrApiKey?: string;
  asrBaseURL?: string;
  asrModel?: string;
  app: {
    firstRun: boolean;
    theme: "light" | "dark" | "system";
  };
}

function getDefaultConfig(): AppConfig {
  return {
    storagePath: path.join(homedir(), ".douyin-ai-video", "storage"),
    aiKeys: [],
    app: {
      firstRun: true,
      theme: "system",
    },
  };
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return getDefaultConfig();
    }
    const data = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(data) as AppConfig;
  } catch {
    return getDefaultConfig();
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  // 配置里有 API Key：目录与文件只给当前用户读写（Windows 上 mode 会被忽略）。
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600).catch(() => undefined);
}

/**
 * 给界面看的密钥：只保留首 8 位与末 4 位（界面本来就只显示这两段），中间打码。
 * 早先 `GET /api/config` 原样返回明文 Key。
 */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 8)}${"•".repeat(Math.min(value.length - 12, 24))}${value.slice(-4)}`;
}

export function publicConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    aiKeys: (config.aiKeys ?? []).map((key) => ({ ...key, apiKey: maskSecret(key.apiKey) ?? "" })),
    ...(config.asrApiKey ? { asrApiKey: maskSecret(config.asrApiKey) } : {}),
  };
}

/**
 * 把界面回传的整份配置合进现有配置：回传的密钥若仍是打码值（或为空），保留原密钥，
 * 避免「读一遍再存一遍」把真实 Key 覆盖成打码串。
 */
export function mergeIncomingConfig(existing: AppConfig, incoming: AppConfig): AppConfig {
  const keep = (next: string | undefined, current: string | undefined) =>
    !next || (current !== undefined && next === maskSecret(current)) ? current : next;
  const byId = new Map((existing.aiKeys ?? []).map((key) => [key.id, key]));
  return {
    ...incoming,
    aiKeys: (Array.isArray(incoming.aiKeys) ? incoming.aiKeys : existing.aiKeys ?? []).map((key) => ({
      ...key,
      apiKey: keep(key.apiKey, byId.get(key.id)?.apiKey) ?? "",
    })),
    ...(incoming.asrApiKey !== undefined || existing.asrApiKey !== undefined
      ? { asrApiKey: keep(incoming.asrApiKey, existing.asrApiKey) }
      : {}),
  };
}

function normalizeBaseURL(baseURL?: string): string {
  if (!baseURL) return "";
  return baseURL.replace(/\/+$/, "");
}

export function normalizeMaxOutputTokens(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error("输出 Token 上限必须为整数");
  if (value < 256) throw new Error("输出 Token 上限至少为 256");
  return value;
}

export function resolveUpdatedMaxOutputTokens(
  existing: number | undefined,
  changes: { maxOutputTokens?: number | null }
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(changes, "maxOutputTokens")) return existing;
  return normalizeMaxOutputTokens(changes.maxOutputTokens ?? undefined);
}

function defaultBaseURL(provider: AIKeyConfig["provider"]): string {
  if (provider === "deepseek") return "https://api.deepseek.com";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

export async function testApiKey(keyConfig: AIKeyInput): Promise<AIKeyTestResult> {
  const testedAt = new Date().toISOString();
  const baseURL = normalizeBaseURL(keyConfig.baseURL) || defaultBaseURL(keyConfig.provider);
  if (!baseURL) {
    return { valid: false, code: "endpoint", error: `请填写自定义 API 地址`, testedAt };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keyConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: keyConfig.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true, testedAt };
    }

    const errData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = errData?.error?.message || `HTTP ${response.status}`;
    return { valid: false, code: "auth", error: msg, testedAt };
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { valid: false, code: "timeout", error: "连接超时", testedAt };
    }
    return { valid: false, code: "dns", error: msg, testedAt };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 配置管理路由 ──────────────────────────────────────────

import type { Express } from "express";

export function registerConfigRoutes(app: Express): void {
  // 获取配置
  app.get("/api/config", async (_req, res) => {
    try {
      const config = await loadConfig();
      res.json(publicConfig(config));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 保存配置
  app.put("/api/config", async (req, res) => {
    try {
      const incoming = req.body as AppConfig;
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        res.status(400).json({ message: "配置格式无效" });
        return;
      }
      await saveConfig(mergeIncomingConfig(await loadConfig(), incoming));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 测试 API Key
  app.post("/api/config/ai-keys/test", async (req, res) => {
    try {
      const result = await testApiKey(req.body as AIKeyInput);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  });

  // 添加 API Key
  app.post("/api/config/ai-keys", async (req, res) => {
    try {
      const config = await loadConfig();
      const keyInput = req.body as AIKeyInput;
      // 先测试
      const result = await testApiKey(keyInput);
      if (!result.valid) {
        res.status(400).json({ message: result.error || "API 配置测试失败", result });
        return;
      }

      const normalizedLimit = normalizeMaxOutputTokens(keyInput.maxOutputTokens);
      const id = randomUUID();
      const newKey: AIKeyConfig = {
        ...keyInput,
        ...(normalizedLimit === undefined ? {} : { maxOutputTokens: normalizedLimit }),
        baseURL: normalizeBaseURL(keyInput.baseURL) || defaultBaseURL(keyInput.provider),
        id,
        isActive: config.aiKeys.length === 0,
        isValid: true,
        lastTested: result.testedAt,
      };

      config.aiKeys.push(newKey);
      await saveConfig(config);
      res.json({ ok: true, id, key: { ...newKey, apiKey: maskSecret(newKey.apiKey) ?? "" } });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 测试已有 Key
  app.post("/api/config/ai-keys/:id/test", async (req, res) => {
    try {
      const config = await loadConfig();
      const key = config.aiKeys.find((k) => k.id === req.params.id);
      if (!key) { res.status(404).json({ message: "API 配置不存在" }); return; }

      const result = await testApiKey(key);
      key.isValid = result.valid;
      key.lastTested = result.testedAt;
      if (!result.valid) key.isActive = false;
      await saveConfig(config);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  });

  // 更新 API Key
  app.put("/api/config/ai-keys/:id", async (req, res) => {
    try {
      const config = await loadConfig();
      const idx = config.aiKeys.findIndex((k) => k.id === req.params.id);
      if (idx < 0) { res.status(404).json({ message: "API 配置不存在" }); return; }

      const changes = req.body as Partial<AIKeyInput>;
      const existing = config.aiKeys[idx];
      const maxOutputTokens = resolveUpdatedMaxOutputTokens(existing.maxOutputTokens, changes);
      const merged: AIKeyInput = {
        name: changes.name ?? existing.name,
        provider: changes.provider ?? existing.provider,
        apiKey: changes.apiKey || existing.apiKey,
        baseURL: changes.baseURL ?? existing.baseURL,
        model: changes.model ?? existing.model,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      };

      const result = await testApiKey(merged);
      if (!result.valid) {
        res.status(400).json({ message: result.error || "API 配置测试失败", result });
        return;
      }

      config.aiKeys[idx] = { ...existing, ...merged, isValid: true, lastTested: result.testedAt };
      if (maxOutputTokens === undefined) {
        delete config.aiKeys[idx].maxOutputTokens;
      }
      await saveConfig(config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 删除 API Key
  app.delete("/api/config/ai-keys/:id", async (req, res) => {
    try {
      const config = await loadConfig();
      config.aiKeys = config.aiKeys.filter((k) => k.id !== req.params.id);
      await saveConfig(config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 设为活跃
  app.post("/api/config/ai-keys/:id/activate", async (req, res) => {
    try {
      const config = await loadConfig();
      const key = config.aiKeys.find((k) => k.id === req.params.id);
      if (!key) { res.status(404).json({ message: "API 配置不存在" }); return; }

      const result = await testApiKey(key);
      if (!result.valid) {
        key.isValid = false;
        key.lastTested = result.testedAt;
        await saveConfig(config);
        res.status(400).json({ message: result.error || "API 测试失败，无法设为当前" });
        return;
      }

      config.aiKeys.forEach((k) => (k.isActive = k.id === req.params.id));
      key.isValid = true;
      key.lastTested = result.testedAt;
      await saveConfig(config);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // 获取应用路径信息
  app.get("/api/config/paths", async (_req, res) => {
    res.json({
      storagePath: path.join(homedir(), ".douyin-ai-video", "storage"),
      configPath: CONFIG_PATH,
    });
  });
}
