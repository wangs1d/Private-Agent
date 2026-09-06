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

/**
 * BM25 别名扩展条目（与 bm25.ts 的 SearchAliasEntry 结构一致）：
 * 携带工具的中文/多语言 searchAliases 与预计算 trigramSet，让关键词通道
 * 具备同义词扩展 + 字符级模糊匹配能力——这是中文口语表达能否命中的关键信号。
 */
export type HybridAliasEntry = {
  registryName: string;
  searchAliases?: string[];
  trigramSet?: Set<string>;
};

export type HybridRetrievalInput = {
  query: string;
  candidates: ResourceRecord[];
  queryVector?: number[] | Float32Array;
  limit?: number;
  prebuiltIndex?: Bm25Index; // 预构建 BM25 索引，复用避免每次新建
  /** 传给 BM25 的别名条目（缺省则退化为纯词面匹配，中文召回明显变差） */
  aliasEntries?: HybridAliasEntry[];
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
    const hasQueryVector = Boolean(input.queryVector && input.queryVector.length > 0);
    const weights = weightsForQuery(input.query, hasQueryVector);
    const keywordScores = scoreKeywords(
      input.query,
      candidates,
      input.prebuiltIndex,
      input.aliasEntries,
    );

    const out: HybridRetrievedResource[] = [];
    for (const record of candidates) {
      const history = await this.historyStore.getScore(record.level1.resource_id);
      const components: HybridScoreComponents = {
        embedding_score: hasQueryVector
          ? scoreEmbedding(record, input.queryVector as number[] | Float32Array)
          : 0,
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

/**
 * 权重档位：
 *   - 有真实 query 向量：语义通道主导（长句 0.6 / 短关键词 0.25）；
 *   - 无 query 向量：embedding 权重归零、关键词主导。
 *     此前无向量时用 hashTextToVector(query) 与工具哈希向量做 cosine——两个独立哈希的
 *     相似度是噪声，却在中文 bigram 分词把 token 数抬高后按"长句"拿 0.6 权重，
 *     直接把 surface.dismiss / shopping.suggest 之类无关工具顶到 top-1。
 *     legacy 通道（catalog.ts）从来只在真实向量存在时才启用 embedding，这里对齐。
 */
export function weightsForQuery(query: string, hasQueryVector = true): HybridRetrievalWeights {
  const history = envFloat("AGENT_TOOL_SEARCH_HISTORY_WEIGHT", 0.2, 0, 1);
  const latency = envFloat("AGENT_TOOL_SEARCH_LATENCY_WEIGHT", 0.1, 0, 1);
  const failure = envFloat("AGENT_TOOL_SEARCH_FAILURE_WEIGHT", 0.2, 0, 1);
  if (!hasQueryVector) {
    return normalizeWeights({
      embedding: 0,
      keyword: 0.7,
      history,
      latency,
      failure,
    });
  }
  const tokenCount = tokenize(query).length;
  const isShortKeyword = tokenCount <= 3;
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
  aliasEntries?: HybridAliasEntry[],
): Map<string, number> {
  // 极短 query（1-2 token）跳过 BM25：lexicalToolBoost 已覆盖 token 重叠
  if (tokenize(query).length <= 2) return new Map();

  if (prebuiltIndex) {
    const candidateIds = new Set(candidates.map((r) => r.level1.resource_id));
    // 放大 limit：全量索引里其他域的工具会挤占名额，候选集是子集时需多取再过滤
    const bm25Limit = Math.max(candidates.length * 2, 20);
    const hits = prebuiltIndex.search(query, bm25Limit, aliasEntries);
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
  const hits = index.search(query, Math.max(candidates.length, 1), aliasEntries);
  const max = Math.max(...hits.map((h) => h.score), 0);
  const out = new Map<string, number>();
  for (const hit of hits) {
    out.set(hit.id, max > 0 ? clamp01(hit.score / max) : 0);
  }
  return out;
}

function scoreEmbedding(
  record: ResourceRecord,
  queryVector: number[] | Float32Array,
): number {
  const docVector = record.level1.embedding;
  if (!docVector.length || queryVector.length !== docVector.length) return 0;
  const cosine = cosineSimilarity(Array.from(queryVector), docVector);
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
