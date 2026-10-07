import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * 本机 API 的来源守卫。
 *
 * 背景（2026-10-07 安全审计）：后端此前对所有请求回 `Access-Control-Allow-Origin: *`，
 * 本机会话 `/api/local-sessions/auto` 又不需要 PIN —— 用户在浏览器里打开的**任意网页**
 * 都能找到本机端口、拿到会话、读取 `/api/config` 里的 AI Key，或触发转录/发布等副作用；
 * 独立后端还监听在所有网卡上。这里把三道门放在路由之前：
 *
 * 1. **Host 必须是回环地址**（localhost / 127.0.0.1 / [::1]）—— 挡 DNS rebinding；
 * 2. **浏览器带来的 Origin 必须是回环地址**（桌面端 file:// 页面的不透明来源只在启用令牌时放行）——
 *    挡跨站请求，包括 `no-cors` 的「简单请求」CSRF；CORS 头只回显被允许的来源，不再是 `*`；
 * 3. **桌面端每次启动生成一次性 API 令牌**，`/api/*` 必须带 `X-Doin-Token` 头
 *   （`<img>/<video>/EventSource` 这类无法加头的 GET 用 `?doin_token=`）。
 *    独立后端可通过环境变量 `DOIN_API_TOKEN` 启用；未配置时只靠 1、2 两道门。
 */
export const API_TOKEN_HEADER = "X-Doin-Token";
export const API_TOKEN_QUERY = "doin_token";

export interface LocalOriginGuardOptions {
  /** 设置后，`/api/*` 必须携带该令牌。 */
  apiToken?: string;
  /**
   * 是否放行不透明来源（`Origin: null` / `file://`）。Electron 生产包从 file:// 加载页面，需要它；
   * 但沙箱 iframe 也会发出 `Origin: null`，所以**只在启用令牌时**才生效。
   */
  allowOpaqueOrigin?: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Host 头（可能带端口）是否指向本机回环地址。缺失 Host 的非浏览器请求放行。 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  const value = host.trim().toLowerCase();
  let hostname: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return false;
    hostname = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/u.test(rest)) return false;
  } else {
    const parts = value.split(":");
    if (parts.length > 2) return false;
    hostname = parts[0] ?? "";
    if (parts.length === 2 && !/^\d{1,5}$/u.test(parts[1] ?? "")) return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** 浏览器 Origin 是否允许访问本机 API。没有 Origin（同源 GET、非浏览器客户端）视为允许。 */
export function isAllowedOrigin(origin: string | undefined, allowOpaqueOrigin = false): boolean {
  if (origin === undefined || origin === "") return true;
  if (origin === "null" || origin === "file://") return allowOpaqueOrigin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createLocalOriginGuard(options: LocalOriginGuardOptions = {}): RequestHandler {
  const apiToken = options.apiToken?.trim() || undefined;
  const allowOpaque = Boolean(apiToken && options.allowOpaqueOrigin);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.status(403).json({ code: "forbidden_host", message: "只接受来自本机的请求" });
      return;
    }

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isAllowedOrigin(origin, allowOpaque)) {
      res.status(403).json({ code: "forbidden_origin", message: "该来源无权访问本机服务" });
      return;
    }

    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", `Content-Type, Authorization, X-Local-Session, Last-Event-ID, ${API_TOKEN_HEADER}`);
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }

    if (apiToken && req.path.startsWith("/api/")) {
      const fromHeader = req.get(API_TOKEN_HEADER);
      const fromQuery = req.method === "GET" || req.method === "HEAD" ? req.query[API_TOKEN_QUERY] : undefined;
      if (!tokenMatches(apiToken, fromHeader) && !tokenMatches(apiToken, fromQuery)) {
        res.status(401).json({ code: "api_token_required", message: "缺少或无效的本机访问令牌，请重启应用" });
        return;
      }
    }
    next();
  };
}
