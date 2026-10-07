import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WhisperModelManager } from "./whisper-model.js";

const payload = Buffer.from("fake ggml model bytes ".repeat(1000));
const sha1 = createHash("sha1").update(payload).digest("hex");

function fakeFetch(handler: (url: string, headers: Record<string, string>) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    return handler(url, headers);
  };
  return { impl, calls };
}

const ok = (body: Buffer, status = 200) => new Response(new Uint8Array(body), { status, headers: { "content-length": String(body.length) } });

async function tempModelPath() {
  const dir = await mkdtemp(path.join(tmpdir(), "whisper-model-"));
  return path.join(dir, "models", "ggml-small.bin");
}

test("缺模型时下载、校验并原子改名", async () => {
  const modelPath = await tempModelPath();
  const { impl, calls } = fakeFetch(() => ok(payload));
  const manager = new WhisperModelManager({ modelPath, urls: ["https://mirror.test/m.bin"], sha1, fetchImpl: impl });
  assert.equal((await manager.status()).state, "missing");
  assert.equal(await manager.ensure(), modelPath);
  assert.deepEqual(await readFile(modelPath), payload);
  assert.equal(calls.length, 1);
  assert.equal((await manager.status()).state, "ready");
  await stat(`${modelPath}.part`).then(() => assert.fail("part 文件应已改名"), () => {});
});

test("已就绪时不发请求；旧安装包自带的模型优先", async () => {
  const modelPath = await tempModelPath();
  const bundled = path.join(path.dirname(modelPath), "bundled.bin");
  await mkdir(path.dirname(bundled), { recursive: true });
  await writeFile(bundled, payload);
  const { impl, calls } = fakeFetch(() => ok(payload));
  const manager = new WhisperModelManager({ modelPath, bundledPath: bundled, urls: ["https://x.test/m"], sha1, fetchImpl: impl });
  assert.equal(await manager.ensure(), bundled);
  assert.equal(calls.length, 0);
});

test("镜像失败时回落到下一个地址", async () => {
  const modelPath = await tempModelPath();
  const { impl, calls } = fakeFetch((url) => url.includes("mirror") ? new Response("nope", { status: 503 }) : ok(payload));
  const manager = new WhisperModelManager({ modelPath, urls: ["https://mirror.test/m", "https://origin.test/m"], sha1, fetchImpl: impl });
  await manager.ensure();
  assert.deepEqual(calls.map(c => new URL(c.url).host), ["mirror.test", "origin.test"]);
});

test("断点续传：带 Range 请求并追加写入", async () => {
  const modelPath = await tempModelPath();
  await mkdir(path.dirname(modelPath), { recursive: true });
  const half = 5000;
  await writeFile(`${modelPath}.part`, payload.subarray(0, half));
  const { impl, calls } = fakeFetch((_url, headers) => {
    assert.equal(headers.Range, `bytes=${half}-`);
    return ok(payload.subarray(half), 206);
  });
  const manager = new WhisperModelManager({ modelPath, urls: ["https://m.test/m"], sha1, fetchImpl: impl });
  await manager.ensure();
  assert.deepEqual(await readFile(modelPath), payload);
  assert.equal(calls.length, 1);
});

test("校验不通过时删掉半成品并报中文错误", async () => {
  const modelPath = await tempModelPath();
  const { impl } = fakeFetch(() => ok(Buffer.from("corrupted")));
  const manager = new WhisperModelManager({ modelPath, urls: ["https://m.test/m"], sha1, fetchImpl: impl });
  await assert.rejects(manager.ensure(), /语音模型下载失败.*校验不通过/);
  const status = await manager.status();
  assert.equal(status.state, "failed");
  assert.equal(status.downloadedBytes, 0);
});

test("并发调用共享同一次下载", async () => {
  const modelPath = await tempModelPath();
  const { impl, calls } = fakeFetch(() => ok(payload));
  const manager = new WhisperModelManager({ modelPath, urls: ["https://m.test/m"], sha1, fetchImpl: impl });
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});
