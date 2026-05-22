import { createHash } from "node:crypto";

import type { MemoryTreeRetrievalService } from "./retrieval.js";
import type { MemoryTreeStore } from "./store.js";
import { getMemoryTreeBufferMaxLeaves } from "./env.js";

const ENTITY_RE = /[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9_-]{2,24}/g;
const HOTNESS_ROUTE_MIN = 3;

function extractiveSummary(bodies: string[], maxChars = 1200): string {
  const joined = bodies.map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!joined.length) return "";
  const text = joined.join(" | ");
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(-Math.floor(maxChars * 0.25));
  return `${head} … ${tail}`;
}

function extractEntities(text: string): string[] {
  const found = text.match(ENTITY_RE) ?? [];
  const stop = new Set(["the", "and", "this", "that", "with", "from", "用户", "助手"]);
  const out = new Set<string>();
  for (const w of found) {
    const k = w.trim();
    if (k.length < 2 || stop.has(k.toLowerCase())) continue;
    out.add(k);
    if (out.size >= 12) break;
  }
  return [...out];
}

export class MemoryTreeWorkerPool {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly store: MemoryTreeStore,
    private readonly workerCount: number,
    private readonly bufferMax: number,
    private readonly retrieval?: MemoryTreeRetrievalService | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.workerCount; i++) {
      const t = setInterval(() => void this.tick(), 400 + i * 120);
      this.timers.push(t);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  wake(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.store.releaseExpiredLeases();
    const job = this.store.claimNextJob(30_000);
    if (!job) return;
    try {
      await this.processJob(job.kind, job.payload);
      this.store.completeJob(job.id);
    } catch {
      this.store.failJob(job.id, 2000);
    }
  }

  private async processJob(
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (kind) {
      case "extract_chunk":
        await this.handleExtract(payload);
        break;
      case "append_buffer":
        await this.handleAppendBuffer(payload);
        break;
      case "seal":
        await this.handleSeal(payload);
        break;
      case "topic_route":
        await this.handleTopicRoute(payload);
        break;
      case "digest_daily":
        await this.handleDigestDaily(payload);
        break;
      case "flush_stale":
        await this.handleFlushStale(payload);
        break;
      default:
        break;
    }
  }

  private async handleExtract(payload: Record<string, unknown>): Promise<void> {
    const chunkId = String(payload.chunkId ?? "");
    const actorId = String(payload.actorId ?? "");
    const sourceId = String(payload.sourceId ?? "");
    if (!chunkId || !actorId) return;

    const chunk = this.store.getChunk(chunkId);
    if (!chunk || chunk.lifecycle !== "pending_extraction") return;

    const deep =
      chunk.fastScore +
      Math.min(0.4, chunk.tokenCount / 2000) +
      (chunk.body.length > 40 ? 0.1 : 0);
    const admitted = deep >= 0.35;

    if (!admitted) {
      this.store.updateChunkLifecycle(chunkId, "dropped", deep);
      return;
    }

    this.store.updateChunkLifecycle(chunkId, "admitted", deep);
    const preview =
      chunk.body.length > 12_000 ? `${chunk.body.slice(0, 12_000)}…` : chunk.body;
    void this.retrieval
      ?.indexChunkVector(actorId, chunkId, preview, sourceId, "admitted")
      .catch(() => {});
    for (const ent of extractEntities(chunk.body)) {
      this.store.bumpEntityHotness(actorId, ent, 0.5);
    }

    this.store.enqueueJob("append_buffer", `buf:${chunkId}`, {
      actorId,
      sourceId,
      chunkId,
      treeType: "source",
      treeKey: sourceId,
    });
    this.store.enqueueJob("topic_route", `topic:${chunkId}`, { actorId, chunkId });
  }

  private async handleAppendBuffer(payload: Record<string, unknown>): Promise<void> {
    const actorId = String(payload.actorId ?? "");
    const chunkId = String(payload.chunkId ?? "");
    const treeType = String(payload.treeType ?? "source");
    const treeKey = String(payload.treeKey ?? payload.sourceId ?? "default");
    if (!actorId || !chunkId) return;

    const chunk = this.store.getChunk(chunkId);
    if (!chunk) return;

    const buf = this.store.getBuffer(actorId, treeType, treeKey);
    if (!buf.includes(chunkId)) buf.push(chunkId);
    this.store.updateChunkLifecycle(chunkId, "buffered");
    this.store.setBuffer(actorId, treeType, treeKey, buf);

    if (buf.length >= this.bufferMax) {
      this.store.enqueueJob("seal", `seal:${actorId}:${treeType}:${treeKey}:${buf.length}`, {
        actorId,
        treeType,
        treeKey,
        level: 1,
      });
    }
  }

  private async handleSeal(payload: Record<string, unknown>): Promise<void> {
    const actorId = String(payload.actorId ?? "");
    const treeType = String(payload.treeType ?? "source");
    const treeKey = String(payload.treeKey ?? "");
    const level = Number(payload.level ?? 1);
    if (!actorId || !treeKey) return;

    const buf = this.store.getBuffer(actorId, treeType, treeKey);
    if (!buf.length) return;

    const bodies: string[] = [];
    for (const id of buf) {
      const c = this.store.getChunk(id);
      if (c) bodies.push(c.body);
      this.store.updateChunkLifecycle(id, "sealed");
    }

    const summaryBody = extractiveSummary(bodies);
    const summaryId = createHash("sha256")
      .update(`${actorId}:${treeType}:${treeKey}:L${level}:${buf.join(",")}`)
      .digest("hex")
      .slice(0, 32);
    this.store.insertSummary(summaryId, actorId, treeType, treeKey, level, summaryBody, buf);
    this.store.setBuffer(actorId, treeType, treeKey, []);
  }

  private async handleTopicRoute(payload: Record<string, unknown>): Promise<void> {
    const actorId = String(payload.actorId ?? "");
    const chunkId = String(payload.chunkId ?? "");
    if (!actorId || !chunkId) return;

    const chunk = this.store.getChunk(chunkId);
    if (!chunk || chunk.lifecycle === "dropped") return;

    const hot = this.store.hotEntities(actorId, HOTNESS_ROUTE_MIN, 4);
    if (!hot.length) return;

    for (const entity of hot.slice(0, 2)) {
      this.store.enqueueJob("append_buffer", `topicbuf:${chunkId}:${entity}`, {
        actorId,
        chunkId,
        treeType: "topic",
        treeKey: entity,
      });
    }
  }

  private async handleDigestDaily(payload: Record<string, unknown>): Promise<void> {
    const actorId = String(payload.actorId ?? "_global");
    const day = String(payload.day ?? new Date().toISOString().slice(0, 10));
    const chunks =
      actorId === "_global" ?
        this.store.listRecentChunks(200)
      : this.store.listChunksForActor(actorId, 200);
    const bodies = chunks.slice(0, 40).map((c) => c.body);
    const summary = extractiveSummary(bodies, 2000);
    const summaryId = `global:${day}`;
    this.store.insertSummary(summaryId, "_global", "global", day, 0, summary, chunks.map((c) => c.chunkId));
  }

  private async handleFlushStale(payload: Record<string, unknown>): Promise<void> {
    const broadcast = String(payload.actorId ?? "") === "_broadcast";
    const actorIds = broadcast ? this.store.listDistinctActorIds() : [String(payload.actorId ?? "")];
    for (const actorId of actorIds) {
      if (!actorId) continue;
    const sources = new Set(
      this.store.listChunksForActor(actorId, 500).map((c) => c.sourceId),
    );
      for (const sourceId of sources) {
        const buf = this.store.getBuffer(actorId, "source", sourceId);
        if (buf.length > 0) {
          this.store.enqueueJob("seal", `flush:${actorId}:${sourceId}`, {
            actorId,
            treeType: "source",
            treeKey: sourceId,
            level: 1,
          });
        }
      }
    }
  }
}

export function createMemoryTreeWorkerPool(
  store: MemoryTreeStore,
  retrieval?: MemoryTreeRetrievalService | null,
): MemoryTreeWorkerPool {
  return new MemoryTreeWorkerPool(
    store,
    Number(process.env.AGENT_MEMORY_TREE_WORKERS ?? 3) || 3,
    getMemoryTreeBufferMaxLeaves(),
    retrieval,
  );
}
