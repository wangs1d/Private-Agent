import { createHash } from "node:crypto";

import { Bm25Index, tokenize } from "../bm25.js";
import { cosineSimilarity } from "../tool-embedding-index.js";
import type { ResourceRecord } from "../registry/models.js";
import { HistoryScoreStore, type ResourceHistoryScore } from "./history-score.js";

export type HybridScoreComponents = {
  embedding_score: number;
  keyword_score: number;
  history_success_score: number;
  latency_score: number;
  failure_penalty: number;
  base_score: number;
};

export type HybridRetrievedResource = {
  resource: ResourceRecord;
  final_score: number;
  components: HybridScoreComponents;
};

export type HybridRetrievalInput = {
  query: string;
  candidates: ResourceRecord[];
  queryVector?: number[] | Float32Array;
  limit?: number;
  prebuiltIndex?: Bm25Index; // 预构建 BM25 索引，复用避免每次新建
};

export type HybridRetrievalWeights = {
  embedding: number;
  keyword: number;
  history: number;
  latency: number;
  failure: number;
};

export type HybridRetrievalOptions = {
  historyStore?: HistoryScoreStore;
};

/**
 * Phase-3 Hybrid Retrieval Engine.
 *
 * final_score =
 *   embedding*w1 + keyword*w2 + history_success*w3 + latency*w4 - failure_penalty*w5
 *
 * 所有分量都归一到 0~1；调用方必须传入分层路由后的 candidates。
 */
export class HybridRetrievalEngine {
  private readonly historyStore: HistoryScoreStore;

  constructor(options?: HybridRetrievalOptions) {
    this.historyStore = options?.historyStore ?? new HistoryScoreStore();
  }

  async search(input: HybridRetrievalInput): Promise<HybridRetrievedResource[]> {
    const candidates = input.candidates.filter((r) => r.level1.status === "online");
    if (candidates.length === 0) return [];
    const limit = Math.max(1, Math.min(100, input.limit ?? candidates.length));
    const weights = weightsForQuery(input.query);
    const keywordScores = scoreKeywords(input.query, candidates, input.prebuiltIndex);

    const out: HybridRetrievedResource[] = [];
    for (const record of candidates) {
      const history = await this.historyStore.getScore(record.level1.resource_id);
      const components: HybridScoreComponents = {
        embedding_score: scoreEmbedding(input.query, record, input.queryVector),
        keyword_score: keywordScores.get(record.level1.resource_id) ?? 0,
        history_success_score: applyColdStartBase(history, record.level1.base_score),
        latency_score: history.latency_score,
        failure_penalty: history.failure_penalty,
        base_score: record.level1.base_score,
      };
      const raw =
        components.embedding_score * weights.embedding +
        components.keyword_score * weights.keyword +
        components.history_success_score * weights.history +
        components.latency_score * weights.latency -
        components.failure_penalty * weights.failure;
      out.push({
        resource: record,
        final_score: round4(clamp01(raw)),
        components,
      });
    }

    out.sort((a, b) => b.final_score - a.final_score);
    return out.slice(0, limit);
  }

  getHistoryStore(): HistoryScoreStore {
    return this.historyStore;
  }
}

export function weightsForQuery(query: string): HybridRetrievalWeights {
  const tokenCount = tokenize(query).length;
  const isShortKeyword = tokenCount <= 3;
  const history = envFloat("AGENT_TOOL_SEARCH_HISTORY_WEIGHT", 0.2, 0, 1);
  const latency = envFloat("AGENT_TOOL_SEARCH_LATENCY_WEIGHT", 0.1, 0, 1);
  const failure = envFloat("AGENT_TOOL_SEARCH_FAILURE_WEIGHT", 0.2, 0, 1);
  if (isShortKeyword) {
    return normalizeWeights({
      embedding: 0.25,
      keyword: 0.4,
      history,
      latency,
      failure,
    });
  }
  return normalizeWeights({
    embedding: 0.6,
    keyword: 0.2,
    history,
    latency,
    failure,
  });
}

function scoreKeywords(
  query: string,
  candidates: ResourceRecord[],
  prebuiltIndex?: Bm25Index,
): Map<string, number> {
  // 极短 query（1-2 token）跳过 BM25：lexicalToolBoost 已覆盖 token 重叠
  if (tokenize(query).length <= 2) return new Map();

  if (prebuiltIndex) {
    const candidateIds = new Set(candidates.map((r) => r.level1.resource_id));
    const hits = prebuiltIndex.search(query, candidates.length);
    const max = Math.max(...hits.map((h) => h.score), 0);
    const out = new Map<string, number>();
    for (const hit of hits) {
      if (!candidateIds.has(hit.id)) continue;
      out.set(hit.id, max > 0 ? clamp01(hit.score / max) : 0);
    }
    return out;
  }
  const docs = candidates.map((record) => ({
    id: record.level1.resource_id,
    text: searchableText(record),
  }));
  const index = new Bm25Index(docs);
  const hits = index.search(query, Math.max(candidates.length, 1));
  const max = Math.max(...hits.map((h) => h.score), 0);
  const out = new Map<string, number>();
  for (const hit of hits) {
    out.set(hit.id, max > 0 ? clamp01(hit.score / max) : 0);
  }
  return out;
}

function scoreEmbedding(
  query: string,
  record: ResourceRecord,
  queryVector?: number[] | Float32Array,
): number {
  const docVector = record.level1.embedding;
  if (!docVector.length) return 0;
  const qVector =
    queryVector && queryVector.length === docVector.length
      ? Array.from(queryVector)
      : hashTextToVector(query, docVector.length);
  const cosine = cosineSimilarity(qVector, docVector);
  return clamp01((cosine + 1) / 2);
}

function searchableText(record: ResourceRecord): string {
  return [
    record.level1.name,
    record.level1.description,
    ...record.level1.domain,
    ...record.level1.capability,
    ...record.level1.tags,
    record.level2.input_type,
    record.level2.output_type,
    ...record.level2.use_cases,
    ...record.level2.limitations,
    ...record.level2.preconditions,
  ].join(" ");
}

function applyColdStartBase(
  history: ResourceHistoryScore,
  baseScore: number,
): number {
  if (history.sample_count === 0) return clamp01(baseScore);
  return clamp01(Math.max(history.history_success_score, baseScore * 0.35));
}

function normalizeWeights(weights: HybridRetrievalWeights): HybridRetrievalWeights {
  const positive = weights.embedding + weights.keyword + weights.history + weights.latency;
  if (positive <= 0) return weights;
  return {
    embedding: weights.embedding / positive,
    keyword: weights.keyword / positive,
    history: weights.history / positive,
    latency: weights.latency / positive,
    failure: weights.failure,
  };
}

function hashTextToVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens.length ? tokens : [text]) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < dim; i++) {
      const byte = hash[i % hash.length] ?? 0;
      out[i] += byte / 127.5 - 1;
    }
  }
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? out.map((v) => v / norm) : out;
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
