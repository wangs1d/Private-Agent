import { Bm25LiteIndex } from "../agent/retrieval/bm25-lite.js";
import { reciprocalRankFusion } from "../agent/retrieval/rrf.js";
import { fetchOpenAiCompatibleEmbedding } from "../services/openai-embedding-client.js";
import { QdrantNarrativeStore } from "../services/qdrant-narrative-store.js";
import { stableUuidFromChunkId } from "../services/narrative-hybrid-retrieval-service.js";
import type { MemoryTreeStore } from "./store.js";
import type { MemoryTreeRetrievalQuery } from "./types.js";
import {
  getMemoryTreeBm25Top,
  getMemoryTreeFuseTop,
  getMemoryTreeRrfK,
  getMemoryTreeVecTop,
} from "./env.js";

export type MemoryTreeRecallHit = {
  chunkId: string;
  text: string;
  sourceId: string;
  scope: string;
};

/**
 * Memory Tree 检索门面：BM25 + Qdrant + RRF，支持 search / drill_down / global_digest / fetch。
 */
export class MemoryTreeRetrievalService {
  private readonly bmByActor = new Map<string, Bm25LiteIndex>();
  private readonly chunkTexts = new Map<string, string>();
  private readonly bmRefreshAt = new Map<string, number>();
  private readonly embeddingModel: string;
  private readonly embeddingKey: string | null;

  constructor(
    private readonly store: MemoryTreeStore,
    private readonly qdrant: QdrantNarrativeStore,
  ) {
    this.embeddingModel = process.env.AGENT_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    this.embeddingKey =
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
      null;
  }

  private bm(actorId: string): Bm25LiteIndex {
    let idx = this.bmByActor.get(actorId);
    if (!idx) {
      idx = new Bm25LiteIndex(4000);
      this.bmByActor.set(actorId, idx);
    }
    return idx;
  }

  refreshBm25Index(actorId: string): void {
    const idx = this.bm(actorId);
    const rows = this.store.listChunksForActor(actorId, 1500);
    for (const row of rows) {
      const preview =
        row.body.length > 12_000 ? `${row.body.slice(0, 12_000)}…` : row.body;
      this.chunkTexts.set(row.chunkId, preview);
      idx.upsert(row.chunkId, preview);
    }
    this.bmRefreshAt.set(actorId, Date.now());
  }

  private ensureBm25Index(actorId: string): void {
    const last = this.bmRefreshAt.get(actorId) ?? 0;
    // 优化：从 30s 延长到 120s，减少频繁重建索引的开销
    if (Date.now() - last < 120_000) return;
    this.refreshBm25Index(actorId);
  }

  async indexChunkVector(
    actorId: string,
    chunkId: string,
    text: string,
    sourceId: string,
    lifecycle: string,
  ): Promise<void> {
    if (!this.qdrant.isEnabled() || !this.embeddingKey) return;
    try {
      const { vector } = await fetchOpenAiCompatibleEmbedding({
        apiKey: this.embeddingKey,
        model: this.embeddingModel,
        input: text,
      });
      await this.qdrant.upsertPoint(vector, stableUuidFromChunkId(chunkId), {
        actorId,
        text,
        source: sourceId,
        chunkId,
        createdAt: new Date().toISOString(),
        scope: "source",
        sourceId,
        lifecycle,
      });
    } catch (e) {
      console.warn(
        "[memory-tree] vector index skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  async buildRecall(actorId: string, queryText: string): Promise<string> {
    return this.query({ actorId, text: queryText, mode: "search" });
  }

  async query(q: MemoryTreeRetrievalQuery): Promise<string> {
    const mode = q.mode ?? "search";
    if (mode === "fetch" && q.chunkId) {
      const c = this.store.getChunk(q.chunkId);
      if (!c) return "";
      return `[fetch/${c.sourceId}/${c.chunkId}]\n${c.body}`;
    }

    if (mode === "global_digest") {
      const day = new Date().toISOString().slice(0, 10);
      const sums = this.store.listSummaries("_global", "global", day, 1);
      if (sums.length) {
        return `【全局日摘要 ${day}】\n${sums[0]!.body}`;
      }
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const prev = this.store.listSummaries("_global", "global", yesterday, 1);
      if (prev.length) return `【全局日摘要 ${yesterday}】\n${prev[0]!.body}`;
      return "";
    }

    if (mode === "drill_down" && q.sourceId) {
      const sums = this.store.listSummaries(q.actorId, q.scope ?? "source", q.sourceId, 3);
      if (sums.length) {
        return sums
          .map((s, i) => `[L${s.level} summary ${i + 1}]\n${s.body}`)
          .join("\n\n");
      }
    }

    const query = q.text.trim().replace(/\s+/g, " ");
    if (!query) return "";

    this.ensureBm25Index(q.actorId);
    const bmHits = this.bm(q.actorId).search(query, getMemoryTreeBm25Top());

    let vecIds: { id: string }[] = [];
    const fuseTop = getMemoryTreeFuseTop();
    if (
      bmHits.length < fuseTop &&
      this.qdrant.isEnabled() &&
      this.embeddingKey
    ) {
      try {
        const { vector } = await fetchOpenAiCompatibleEmbedding({
          apiKey: this.embeddingKey,
          model: this.embeddingModel,
          input: query,
        });
        const hits = await this.qdrant.search(vector, q.actorId, getMemoryTreeVecTop());
        for (const h of hits) {
          this.chunkTexts.set(h.payload.chunkId, h.payload.text);
          vecIds.push({ id: h.payload.chunkId });
        }
      } catch {
        vecIds = [];
      }
    }

    const fused = reciprocalRankFusion(
      [bmHits.map((h) => ({ id: h.id })), vecIds].filter((l) => l.length > 0),
      getMemoryTreeRrfK(),
      getMemoryTreeFuseTop(),
    );

    const parts: string[] = [];
    for (let i = 0; i < fused.length; i++) {
      const id = fused[i]!.id;
      const row = this.store.getChunk(id);
      const txt = this.chunkTexts.get(id) ?? row?.body;
      if (txt) {
        const tag = row ? `[source/${row.sourceId}/${id}]` : `[${id}]`;
        parts.push(`${tag}\n${txt}`);
      }
    }

    if (!parts.length) return "";
    return `以下为 Memory Tree 检索摘录（BM25+Qdrant+RRF）：\n${parts.join("\n\n")}`;
  }
}
