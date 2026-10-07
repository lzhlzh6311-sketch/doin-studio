import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaxOutputTokens, resolveUpdatedMaxOutputTokens } from "./config-server.js";

test("normalizeMaxOutputTokens accepts automatic and custom modes", () => {
  assert.equal(normalizeMaxOutputTokens(undefined), undefined);
  assert.equal(normalizeMaxOutputTokens(16384), 16384);
});

test("normalizeMaxOutputTokens rejects invalid HTTP configuration", () => {
  assert.throws(() => normalizeMaxOutputTokens(0), /至少为 256/);
  assert.throws(() => normalizeMaxOutputTokens(512.25), /整数/);
});

test("resolveUpdatedMaxOutputTokens distinguishes omitted and cleared values", () => {
  assert.equal(resolveUpdatedMaxOutputTokens(8192, {}), 8192);
  assert.equal(resolveUpdatedMaxOutputTokens(8192, { maxOutputTokens: null }), undefined);
  assert.equal(resolveUpdatedMaxOutputTokens(undefined, { maxOutputTokens: 16384 }), 16384);
});

test("GET /api/config never returns plaintext keys, and saving the masked copy back keeps the real key", async () => {
  const { maskSecret, publicConfig, mergeIncomingConfig } = await import("./config-server.js");
  const real = "fake-secret-key-for-masking-test";
  const existing = {
    storagePath: "/s",
    asrApiKey: "asr-secret-0123456789",
    aiKeys: [{ id: "k1", name: "n", provider: "deepseek" as const, apiKey: real, model: "m", isActive: true }],
    app: { firstRun: false, theme: "system" as const },
  };
  const shown = publicConfig(existing);
  assert.notEqual(shown.aiKeys[0].apiKey, real);
  assert.equal(shown.aiKeys[0].apiKey.slice(0, 8), real.slice(0, 8), "界面仍能显示首 8 位");
  assert.equal(shown.aiKeys[0].apiKey.slice(-4), real.slice(-4), "界面仍能显示末 4 位");
  assert.doesNotMatch(JSON.stringify(shown), /secret-key-for-mask|asr-secret-0123456789/);
  assert.equal(maskSecret("short"), "•••••");

  const saved = mergeIncomingConfig(existing, { ...shown, app: { firstRun: false, theme: "dark" } });
  assert.equal(saved.aiKeys[0].apiKey, real, "回传打码值不能覆盖真实 Key");
  assert.equal(saved.asrApiKey, existing.asrApiKey);
  assert.equal(saved.app.theme, "dark");

  const replaced = mergeIncomingConfig(existing, { ...shown, aiKeys: [{ ...shown.aiKeys[0], apiKey: "fake-secret-replacement" }] });
  assert.equal(replaced.aiKeys[0].apiKey, "fake-secret-replacement", "用户真的换了 Key 时要生效");
});
