import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { API_TOKEN_HEADER, createLocalOriginGuard, isAllowedOrigin, isLoopbackHostHeader, type LocalOriginGuardOptions } from "./local-origin-guard.js";

test("Host 头只接受回环地址（挡 DNS rebinding）", () => {
  for (const host of ["localhost", "localhost:3100", "127.0.0.1:5173", "[::1]:3100", "[::1]", "LOCALHOST:1", undefined, ""]) {
    assert.equal(isLoopbackHostHeader(host), true, String(host));
  }
  for (const host of ["evil.example", "evil.example:3100", "127.0.0.1.evil.example", "localhost.evil.example", "192.168.1.5:3100", "[::2]:3100", "localhost:abc", "a:b:c"]) {
    assert.equal(isLoopbackHostHeader(host), false, host);
  }
});

test("Origin 只放行回环地址；不透明来源只在显式允许时放行", () => {
  for (const origin of [undefined, "", "http://localhost:5173", "http://127.0.0.1:3100", "http://[::1]:3100", "https://localhost"]) {
    assert.equal(isAllowedOrigin(origin), true, String(origin));
  }
  for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "file://", "chrome-extension://abc", "not a url"]) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
  assert.equal(isAllowedOrigin("null", true), true);
  assert.equal(isAllowedOrigin("file://", true), true);
});

async function serve(options: LocalOriginGuardOptions) {
  const app = express();
  app.use(createLocalOriginGuard(options));
  let hits = 0;
  app.all("/api/thing", (_req, res) => { hits++; res.json({ ok: true }); });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const request = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  return { request, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("跨站请求（含 no-cors 简单 POST）在到达路由前被拒，CORS 不再回 *", async () => {
  const fixture = await serve({});
  try {
    const evil = await fixture.request("/api/thing", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" } });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /forbidden_origin/);
    const rebinding = await fixture.request("/api/thing", { headers: { Host: "attacker.example:3100" } });
    assert.equal(rebinding.status, 403);
    assert.match(rebinding.body, /forbidden_host/);
    assert.equal(fixture.hits(), 0, "被拒的请求不能产生任何副作用");

    const local = await fixture.request("/api/thing", { method: "POST", headers: { Origin: "http://localhost:5173" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers["access-control-allow-origin"], "http://localhost:5173");
    const preflight = await fixture.request("/api/thing", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    assert.equal(preflight.status, 200);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /X-Doin-Token/);

    const noOrigin = await fixture.request("/api/thing");
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);

    // 没启用令牌时，不透明来源（沙箱 iframe 也会发 Origin: null）不放行，即便配置要求放行。
    const tokenless = await serve({ allowOpaqueOrigin: true });
    try {
      const opaque = await tokenless.request("/api/thing", { headers: { Origin: "null" } });
      assert.equal(opaque.status, 403);
    } finally {
      await tokenless.close();
    }
  } finally {
    await fixture.close();
  }
});

test("启用令牌后 /api/* 必须带令牌；GET 可用查询参数（给 <img>/<video>/EventSource）", async () => {
  const token = "t".repeat(64);
  const fixture = await serve({ apiToken: token, allowOpaqueOrigin: true });
  try {
    assert.equal((await fixture.request("/api/thing")).status, 401);
    assert.equal((await fixture.request("/api/thing", { headers: { [API_TOKEN_HEADER]: "wrong" } })).status, 401);
    assert.equal((await fixture.request("/api/thing", { method: "POST", headers: { [API_TOKEN_HEADER]: token, Origin: "null" } })).status, 200);
    assert.equal((await fixture.request(`/api/thing?doin_token=${token}`)).status, 200);
    assert.equal((await fixture.request(`/api/thing?doin_token=${token}`, { method: "POST" })).status, 401, "有副作用的方法不接受查询参数里的令牌");
    assert.equal((await fixture.request("/health")).status, 200, "健康检查不需要令牌");
    const preflight = await fixture.request("/api/thing", { method: "OPTIONS", headers: { Origin: "file://" } });
    assert.equal(preflight.status, 200, "预检不带自定义头，必须在令牌检查之前放行");
    assert.equal(preflight.headers["access-control-allow-origin"], "file://");
  } finally {
    await fixture.close();
  }
});
