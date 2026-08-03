/**
 * Embedding 召回：基于余弦相似度对工具描述排序。
 *
 * 动态筛选策略（非固定 top-K）：
 *   1. 计算全部工具与 query 的余弦相似度
 *   2. 按 score 降序排列
 *   3. 保留 score >= max(absoluteFloor, maxScore * relativeRatio) 的结果
 *   4. 上限 maxKeep 防止极端宽泛 query 导致候选爆炸
 *
 * 这样：
 *   - 宽泛 query（多个工具都高相关）→ 保留更多候选
 *   - 精确 query（只有一个明确目标）→ 保留更少候选
 *   - 避免 top-K 截断导致"差一点"的候选被丢弃
 *
 * 性能：113 工具 × 1536 维 = ~700KB 内存，单次余弦计算 < 1ms。
 */

/** 余弦相似度（已归一化向量时等价于点积） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 预归一化向量（避免每次相似度计算都开方） */
export function preNormalizeVector(v: number[]): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return out;
}

/** 动态筛选参数 */
export type DynamicThreshold = {
  /** 绝对下限：cosine 低于此值的直接丢弃（避免噪声） */
  absoluteFloor: number;
  /** 相对比例：仅保留 score >= maxScore * ratio 的结果（跟随 query 宽窄自适应） */
  relativeRatio: number;
  /** 安全上限：无论阈值通过多少个，最多保留 N 个（防止极宽 query 爆炸） */
  maxKeep: number;
};

/**
 * 计算全部工具的余弦相似度并降序排列（不做截断）。
 * 调用方拿到完整排序后自行做动态阈值筛选。
 */
export function rankAllByEmbedding(
  queryVector: number[] | Float32Array,
  docVectors: Map<string, Float32Array>,
): Array<{ id: string; score: number }> {
  if (queryVector.length === 0 || docVectors.size === 0) return [];

  let q: Float32Array;
  if (queryVector instanceof Float32Array) {
    q = queryVector;
  } else {
    q = preNormalizeVector(queryVector as number[]);
  }

  const hits: Array<{ id: string; score: number }> = [];
  for (const [id, vec] of docVectors) {
    if (vec.length !== q.length) continue;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i]! * vec[i]!;
    hits.push({ id, score: dot });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * 动态阈值筛选：从完整排序结果中按 absoluteFloor / relativeRatio 截断。
 *
 * 算法：
 *   threshold = max(absoluteFloor, maxScore * relativeRatio)
 *   保留所有 score >= threshold 的结果，上限 maxKeep 个。
 *
 * 边界处理：
 *   - 空列表 → 返回空
 *   - maxScore < absoluteFloor → 返回空（所有工具都不够相关）
 *   - maxScore >= absoluteFloor → 至少保留 top-1
 */
export function filterByDynamicThreshold(
  sortedHits: Array<{ id: string; score: number }>,
  threshold: DynamicThreshold,
): Array<{ id: string; score: number }> {
  if (sortedHits.length === 0) return [];
  const maxScore = sortedHits[0]!.score;
  const dynamicThreshold = Math.max(threshold.absoluteFloor, maxScore * threshold.relativeRatio);

  const kept: Array<{ id: string; score: number }> = [];
  for (const hit of sortedHits) {
    if (kept.length >= threshold.maxKeep) break;
    if (hit.score < dynamicThreshold) break; // 已降序，后续只会更低
    kept.push(hit);
  }
  return kept;
}

/**
 * 工具向量索引：在 catalog 构建时一次性预归一化所有工具向量。
 * 搜索时直接 dot product，省去 sqrt。
 */
export class ToolEmbeddingIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private dimension = 0;

  ingest(registryName: string, vector: number[]): void {
    if (vector.length === 0) return;
    this.dimension = vector.length;
    this.vectors.set(registryName, preNormalizeVector(vector));
  }

  ingestMany(entries: Iterable<[string, number[] | undefined | null]>): void {
    for (const [name, vec] of entries) {
      if (vec) this.ingest(name, vec);
    }
  }

  /**
   * 动态筛选搜索：计算全部相似度 → 按动态阈值截断。
   * 不固定 top-K，而是根据 score 分布自适应保留候选数量。
   */
  searchDynamic(
    queryVector: number[] | Float32Array,
    threshold: DynamicThreshold,
  ): Array<{ id: string; score: number }> {
    const all = rankAllByEmbedding(queryVector, this.vectors);
    return filterByDynamicThreshold(all, threshold);
  }

  /**
   * 返回全部余弦相似度排序（不截断），用于 Level 1 类别路由。
   */
  rankAll(queryVector: number[] | Float32Array): Array<{ id: string; score: number }> {
    return rankAllByEmbedding(queryVector, this.vectors);
  }

  get size(): number {
    return this.vectors.size;
  }

  get dim(): number {
    return this.dimension;
  }
}
