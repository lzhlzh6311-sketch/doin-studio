/**
 * 助手会话：每个会话一个 JSON 文件（storage/agent/sessions/<id>.json），原子写。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, AgentSessionSummary } from "./types.js";

const ID = /^[0-9a-f-]{36}$/;

export class AgentSessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!ID.test(id)) throw new AgentSessionError(404, "会话不存在");
    return path.join(this.dir, `${id}.json`);
  }

  async create(): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), title: "新对话", createdAt: now, updatedAt: now, items: [] };
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<AgentSession> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as AgentSession;
    } catch (error) {
      if (error instanceof AgentSessionError) throw error;
      throw new AgentSessionError(404, "会话不存在或已被删除");
    }
  }

  async save(session: AgentSession) {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(session.id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(session), "utf8");
    await rename(temp, target);
  }

  async list(limit = 50): Promise<AgentSessionSummary[]> {
    let names: string[] = [];
    try { names = (await readdir(this.dir)).filter((n) => n.endsWith(".json")); } catch { return []; }
    const sessions = await Promise.all(names.map(async (name) => {
      try { return JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as AgentSession; } catch { return null; }
    }));
    return sessions
      .filter((s): s is AgentSession => !!s && s.items.length > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => {
        const last = [...s.items].reverse().find((i) => i.type === "assistant" && i.text) ?? s.items[s.items.length - 1];
        const preview = last && "text" in last ? last.text : last?.type === "tool" ? last.summary : "";
        return { id: s.id, title: s.title, updatedAt: s.updatedAt, preview: preview.replace(/\s+/g, " ").slice(0, 80) };
      });
  }

  async remove(id: string) {
    await rm(this.file(id), { force: true });
  }
}

export class AgentSessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentSessionError";
  }
}
