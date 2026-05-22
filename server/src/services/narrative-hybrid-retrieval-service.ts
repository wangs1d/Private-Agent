import { createHash } from "node:crypto";

import { Bm25LiteIndex } from "../agent/retrieval/bm25-lite.js";
import { reciprocalRankFusion } from "../agent/retrieval/rrf.js";
import { fetchOpenAiCompatibleEmbedding } from "./openai-embedding-client.js";
import type { NarrativePointPayload } from "./qdrant-narrative-store.js";
import { QdrantNarrativeStore } from "./qdrant-narrative-store.js";

/** 将任意 chunkId 稳定映射为 RFC UUID（Qdrant 点 id）。 */
export function stableUuidFromChunkId(chunkId: string): string {
  const digest = createHash("sha256").update(chunkId).digest();
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * BM25（进程内）+ Qdrant 向量检索 + RRF 融合 → 拼装进 Prompt 的长期叙事摘录。
 *
 * ENV:
 * - `AGENT_QDRANT_URL`、`AGENT_QDRANT_API_KEY?`、`AGENT_QDRANT_COLLECTION?`
 * - `OPENAI_API_KEY` 或沿用对话 Key 做 embeddings；`AGENT_EMBEDDING_MODEL`（默认 text-embedding-3-small）
 * - `OPENAI_EMBEDDINGS_URL` 可选，自定义兼容端点
 * - `AGENT_NARRATIVE_MAX_DOCS_PER_ACTOR`、`AGENT_NARRATIVE_*_TOP` 可调
 */
export class NarrativeHybridRetrievalService {
  private seq = 0;
  private readonly chunkTexts = new Map<string, string>();
  private readonly bmByActor = new Map<string, Bm25LiteIndex>();
  private readonly maxDocsPerActor: number;
  private readonly bmTop: number;
  private readonly vecTop: number;
  private readonly rrfK: number;
  private readonly fuseTop: number;
  private readonly embeddingModel: string;
  private readonly embeddingKey: string | null;

  constructor(private readonly qdrant: QdrantNarrativeStore) {
    this.maxDocsPerActor = envPositiveInt("AGENT_NARRATIVE_MAX_DOCS_PER_ACTOR", 800);
    this.bmTop = envPositiveInt("AGENT_NARRATIVE_BM25_TOP", 24);
    this.vecTop = envPositiveInt("AGENT_NARRATIVE_VEC_TOP", 24);
    this.rrfK = envPositiveInt("AGENT_NARRATIVE_RRF_K", 60);
    this.fuseTop = envPositiveInt("AGENT_NARRATIVE_FUSE_TOP", 8);
    this.embeddingModel = process.env.AGENT_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    this.embeddingKey =
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
      null;
  }

  private bm(actorId: string): Bm25LiteIndex {
    let idx = this.bmByActor.get(actorId);
    if (!idx) {
      idx = new Bm25LiteIndex(this.maxDocsPerActor);
      this.bmByActor.set(actorId, idx);
    }
    return idx;
  }

  /** ingest 单行叙事（Hermes observe、轨迹摘要等）；向量索引在 Qdrant + Key 齐备时异步写入。 */
  async ingest(actorId: string, text: string, source: string): Promise<void> {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || t.length < 4) return;
    const chunkId = `${actorId}:${source}:${Date.now().toString(36)}:${(this.seq++).toString(36)}`;

    const body = t.length > 12_000 ? `${t.slice(0, 12_000)}…` : t;
    this.chunkTexts.set(chunkId, body);
    this.bm(actorId).upsert(chunkId, body);

    if (!this.qdrant.isEnabled() || !this.embeddingKey) return;

    try {
      const { vector } = await fetchOpenAiCompatibleEmbedding({
        apiKey: this.embeddingKey,
        model: this.embeddingModel,
        input: body,
      });
      const payload: NarrativePointPayload = {
        actorId,
        text: body,
        source,
        chunkId,
        createdAt: new Date().toISOString(),
      };
      await this.qdrant.upsertPoint(vector, stableUuidFromChunkId(chunkId), payload);
    } catch (e) {
      console.warn(
        "[narrative-hybrid] vector ingest skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  /** 格式化融合结果，注入 system 叙事块 */
  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    const q = query.trim().replace(/\s+/g, " ");
    if (!q) return "";

    const bmHits = this.bm(actorId).search(q, this.bmTop);
    let vecChunkIds: { id: string }[] = [];
    if (bmHits.length < this.fuseTop && this.qdrant.isEnabled() && this.embeddingKey) {
      try {
        const { vector } = await fetchOpenAiCompatibleEmbedding({
          apiKey: this.embeddingKey,
          model: this.embeddingModel,
          input: q,
        });
        const hits = await this.qdrant.search(vector, actorId, this.vecTop);
        for (const h of hits) {
          this.chunkTexts.set(h.payload.chunkId, h.payload.text);
        }
        vecChunkIds = hits.map((h) => ({ id: h.payload.chunkId })).filter((x) => x.id);
      } catch {
        vecChunkIds = [];
      }
    }

    const fused = reciprocalRankFusion(
      [
        bmHits.map((h) => ({ id: h.id })),
        vecChunkIds,
      ].filter((l) => l.length > 0),
      this.rrfK,
      this.fuseTop,
    );

    const parts: string[] = [];
    for (let i = 0; i < fused.length; i++) {
      const txt = this.chunkTexts.get(fused[i]!.id);
      if (txt) {
        parts.push(`[${i + 1}] ${txt}`);
      }
    }
    if (!parts.length) return "";
    return `以下为与当前问题相关的「长期叙事 / 履历」摘录（BM25+Qdrant向量+RRF 融合）：\n${parts.join("\n\n")}`;
  }
}

export function createNarrativeHybridRetrievalDefault(): NarrativeHybridRetrievalService | null {
  const disabled = process.env.AGENT_MEMORY_HYBRID_DISABLED?.trim().toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "yes") return null;

  const store = new QdrantNarrativeStore();
  return new NarrativeHybridRetrievalService(store);
}
