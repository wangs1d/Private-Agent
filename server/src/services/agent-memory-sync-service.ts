import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type SessionMemory = {
  revision: number;
  entries: Record<string, unknown>;
};

type PersistedShape = {
  sessions: Record<string, SessionMemory>;
};

/**
 * L4 记忆同步（MVP）：服务端 KV + 乐观并发 revision，供多客户端/Agent 实例对齐短期同步切片。
 */
export class AgentMemorySyncService {
  private readonly filePath: string;
  private data: PersistedShape = { sessions: {} };
  private persistChain: Promise<void> = Promise.resolve();
  private readonly writeQueues = new Map<string, Promise<boolean>>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.AGENT_MEMORY_SYNC_FILE ?? join(process.cwd(), "data", "agent-memory-sync.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed?.sessions && typeof parsed.sessions === "object") {
        this.data = parsed;
      }
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw e;
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }

  getSnapshot(
    sessionId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } {
    const s = this.data.sessions[sessionId] ?? { revision: 0, entries: {} };
    if (!keys?.length) {
      return { revision: s.revision, entries: { ...s.entries } };
    }
    const entries: Record<string, unknown> = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(s.entries, k)) {
        entries[k] = s.entries[k];
      }
    }
    return { revision: s.revision, entries };
  }

  applyPatch(
    sessionId: string,
    basisRevision: number,
    patches: Array<{ key: string; op: "put" | "delete"; value?: unknown }>,
  ): { ok: true; revision: number } | { ok: false; reason: string; currentRevision: number } {
    const cur = this.data.sessions[sessionId] ?? { revision: 0, entries: {} };
    if (cur.revision !== basisRevision) {
      return { ok: false, reason: "REVISION_MISMATCH", currentRevision: cur.revision };
    }
    const nextEntries = { ...cur.entries };
    for (const p of patches) {
      if (p.op === "delete") {
        delete nextEntries[p.key];
      } else {
        nextEntries[p.key] = p.value;
      }
    }
    const next: SessionMemory = { revision: cur.revision + 1, entries: nextEntries };
    this.data.sessions[sessionId] = next;
    this.schedulePersist();
    return { ok: true, revision: next.revision };
  }

  /**
   * 在 `memory_summary` 末尾追加一行带时间戳的履历（乐观并发重试）。
   * `actorId` 通常为 `userId`，与 UAP 记忆分桶键一致。
   */
  appendMemorySummaryLine(actorId: string, line: string): boolean {
    const existing = this.writeQueues.get(actorId) ?? Promise.resolve(true);
    const next = existing.then(() => this.doAppendMemorySummaryLine(actorId, line));
    this.writeQueues.set(actorId, next);
    next.finally(() => {
      if (this.writeQueues.get(actorId) === next) {
        this.writeQueues.delete(actorId);
      }
    });
    return true;
  }

  private doAppendMemorySummaryLine(actorId: string, line: string): boolean {
    const maxRaw = process.env.AGENT_MEMORY_SUMMARY_MAX_CHARS;
    const maxChars = maxRaw ? Math.max(1000, Number.parseInt(maxRaw, 10) || 16_000) : 16_000;
    const stamp = new Date().toISOString();
    const addition = `[${stamp}] ${line}`;
    for (let i = 0; i < 12; i++) {
      const { revision, entries } = this.getSnapshot(actorId, ["memory_summary"]);
      const prev = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      const next = `${prev}${prev ? "\n" : ""}${addition}`.slice(-maxChars);
      const r = this.applyPatch(actorId, revision, [
        { key: "memory_summary", op: "put", value: next },
      ]);
      if (r.ok) return true;
    }
    return false;
  }
}
