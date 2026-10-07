import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { catchAsyncRouteErrors } from "./async-routes.js";

test("a rejected async route reaches the error handler instead of hanging the request", async () => {
  const app = express();
  catchAsyncRouteErrors(app);
  app.set("answer", 42);
  assert.equal(app.get("answer"), 42, "app.get(setting) still reads settings");
  app.delete("/boom", async () => { throw new Error("disk gone"); });
  app.get("/sync-boom", () => { throw new Error("sync"); });
  app.get("/ok", async (_req, res) => { res.json({ ok: true }); });
  const seen: string[] = [];
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    seen.push(error.message);
    res.status(500).json({ code: "internal_error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const boom = await fetch(`${base}/boom`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
    assert.equal(boom.status, 500);
    assert.equal((await fetch(`${base}/sync-boom`)).status, 500);
    assert.equal((await fetch(`${base}/ok`)).status, 200);
    assert.deepEqual(seen, ["disk gone", "sync"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
