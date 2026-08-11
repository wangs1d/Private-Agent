import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { Bm25Index, buildToolSearchText, buildCharacterTrigrams, tokenize } from "./bm25.js";
import { isCoreToolRegistryName } from "./core-tool-library.js";
import { getToolSearchConfig } from "./env.js";
import { getToolIntentMetadata } from "./intent-metadata.js";
import { ToolEmbeddingIndex, rankAllByEmbedding, filterByDynamicThreshold } from "./tool-embedding-index.js";
import {
  buildEmbeddingInput,
  ensureToolEmbeddings,
  getToolEmbeddingsForCatalog,
  isEmbeddingSearchEnabled,
} from "./tool-embedding.js";
import {
  TOOL_CATEGORIES,
  type ToolCategoryDef,
  type ToolCategoryInfo,
  populateCategoryIndex,
  routeToCategory,
  getCategoryToolNames,
  getCategoryBm25Index,
} from "./tool-category.js";

function isFunctionTool(tool: ChatCompletionTool): tool is ChatCompletionTool & {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
} {
  return tool.type === "function" && Boolean(tool.function?.name);
}

export type DeferredToolEntry = {
  registryName: string;
  tool: ChatCompletionTool;
  searchText: string;
  parameterNames: string[];
  requiredParameters: string[];
  searchAliases: string[];
  negativeAliases: string[];
  examples: string[];
  negativeExamples: string[];
  /** 预先构建的字符 trigram 集合，避免每次 search 都重算 */
  trigramSet: Set<string>;
  /** 工具用于 embedding 召回的"语义输入"（与 searchText 不同，更聚焦语义） */
  embeddingInput: string;
};

/** 单轮对话内复用 BM25 索引与名称查找表，避免每次 tool_search 全量重建。 */
export type DeferredToolCatalog = {
  entries: DeferredToolEntry[];
  index: Bm25Index;
  byName: Map<string, DeferredToolEntry>;
  byApiName: Map<string, DeferredToolEntry>;
  /**
   * Embedding 向量索引（可能为空：API 未启用 / 无 key / 首次构建时 cache 全 miss）。
   * 即使为空 catalog 仍然可用——search 会自动降级为纯 BM25 召回。
   */
  embeddingIndex: ToolEmbeddingIndex;
  /**
   * catalog 构建时是否已尝试为所有 entry 算 embedding。
   * false 表示后台还有 in-flight 补全任务，第二次 search 时会更大。
   */
  embeddingReady: boolean;
  // ===== 两层架构：Level 1 类别路由 =====
  /** 类别向量索引（每个类别 = 该类工具 embedding 加权平均） */
  categoryIndex: ToolEmbeddingIndex;
  /** 类别元数据（类别名 → 工具名列表 + BM25 搜索文本） */
  categories: Map<string, ToolCategoryInfo>;
  /** 类别 BM25 索引（降级路由用） */
  categoryBm25: Bm25Index;
};

export type DeferredToolSearchMatch = {
  name: string;
  description: string;
  score: number;
  parameterNames: string[];
  requiredParameters: string[];
  parameters?: Record<string, unknown>;
};

export function splitCoreAndDeferredTools(
  tools: ChatCompletionTool[],
  _coreNames?: ReadonlySet<string>,
): { core: ChatCompletionTool[]; deferred: ChatCompletionTool[] } {
  const core: ChatCompletionTool[] = [];
  const deferred: ChatCompletionTool[] = [];

  for (const tool of tools) {
    if (!isFunctionTool(tool)) continue;
    if (isCoreToolRegistryName(tool.function.name)) core.push(tool);
    else deferred.push(tool);
  }

  return { core, deferred };
}

function extractParameterSummary(parameters: unknown): {
  parameterNames: string[];
  requiredParameters: string[];
} {
  if (!parameters || typeof parameters !== "object") {
    return { parameterNames: [], requiredParameters: [] };
  }
  const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
  const parameterNames =
    schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties)
      : [];
  const requiredParameters = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  return { parameterNames, requiredParameters };
}

export function buildDeferredCatalog(deferredTools: ChatCompletionTool[]): DeferredToolCatalog {
  const entries: DeferredToolEntry[] = deferredTools.filter(isFunctionTool).map((tool) => {
    const fn = tool.function;
    const { parameterNames, requiredParameters } = extractParameterSummary(fn.parameters);
    const { text, aliases } = buildToolSearchText({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    });
    const metadata = getToolIntentMetadata(fn.name);
    return {
      registryName: fn.name,
      tool,
      searchText: text,
      parameterNames,
      requiredParameters,
      searchAliases: aliases,
      negativeAliases: metadata.negativeAliases ?? [],
      examples: metadata.examples ?? [],
      negativeExamples: metadata.negativeExamples ?? [],
      trigramSet: buildCharacterTrigrams(text),
      embeddingInput: buildEmbeddingInput(tool),
    };
  });

  const byName = new Map(entries.map((e) => [e.registryName, e]));
  const byApiName = new Map(
    entries.map((e) => [e.registryName.replace(/\./g, "_"), e] as const),
  );
  const index = new Bm25Index(
    entries.map((entry) => ({ id: entry.registryName, text: entry.searchText })),
  );

  // === Embedding 索引：默认尝试从磁盘 cache 加载 ===
  // 是否启用由 env 决定（auto/on/off）+ 是否 OPENAI_API_KEY 可用
  // 小工具集（< embeddingMinTools）跳过 embedding，节省 RTT
  const cfg = getToolSearchConfig();
  const embeddingIndex = new ToolEmbeddingIndex();
  let embeddingReady = false;

  if (
    isEmbeddingSearchEnabled() &&
    entries.length >= cfg.embeddingMinTools
  ) {
    const cached = getToolEmbeddingsForCatalog(entries.map((e) => e.registryName));
    embeddingIndex.ingestMany(cached.entries());
    embeddingReady = cached.size === entries.length;

    // 缺 key 之外如果还有 entry 没缓存 → 触发后台批量补全（fire-and-forget）
    // 注意：API 失败会被 ensureToolEmbeddings 内部吞掉，下一次 build 仍会重试
    if (!embeddingReady) {
      const missing = entries
        .filter((e) => !getToolEmbeddingsForCatalog([e.registryName]).size)
        .map((e) => ({ registryName: e.registryName, searchText: e.embeddingInput || e.searchText }));
      if (missing.length > 0) {
        void ensureToolEmbeddings(missing).then((stats) => {
          if (stats.computed > 0) {
            // 补完后把新算的 vector 灌进 catalog 的索引，下一次 searchDeferredTools 立刻可用
            const refreshed = getToolEmbeddingsForCatalog(
              missing.map((m) => m.registryName),
            );
            for (const [name, vec] of refreshed.entries()) {
              embeddingIndex.ingest(name, vec);
            }
          }
        });
      }
    }
  }

  // === 类别索引（Level 1 路由） ===
  // 任何时候都构建：有 embedding 时用向量路由，无时用 BM25 降级
  const categoryBm25 = getCategoryBm25Index(TOOL_CATEGORIES);
  const { categoryIndex, categories: catInfo } = populateCategoryIndex(
    TOOL_CATEGORIES,
    entries.map((e) => ({
      registryName: e.registryName,
      embeddingInput: e.embeddingInput,
      searchText: e.searchText,
    })),
    (name) => {
      const vec = getToolEmbeddingsForCatalog([name]).get(name);
      return vec ? new Float32Array(vec) : null;
    },
  );

  return { entries, index, byName, byApiName, embeddingIndex, embeddingReady, categoryIndex, categories: catInfo, categoryBm25 };
}

export function estimateToolsSchemaTokens(tools: ChatCompletionTool[]): number {
  if (tools.length === 0) return 0;
  const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  return Math.ceil(bytes / 4);
}

export function shouldActivateToolSearch(
  deferredTools: ChatCompletionTool[],
  mode: ReturnType<typeof getToolSearchConfig>["enabled"],
  thresholdPct: number,
  contextTokens: number,
): boolean {
  if (deferredTools.length === 0) return false;
  if (mode === "off") return false;
  if (mode === "on") return true;

  // 小工具集（≤15 个延迟工具）：BM25 索引极小，搜索几乎零延迟，始终激活。
  // 这让 Fast 模式（≤12 工具，3-6 visible + 6-9 deferred）也能走 tool search 召回。
  if (deferredTools.length <= 15) return true;

  // 大工具集：按 token 阈值判定（延迟工具 schema token / 上下文 token ≥ 阈值）
  const deferrableTokens = estimateToolsSchemaTokens(deferredTools);
  return deferrableTokens / contextTokens >= thresholdPct / 100;
}

export type SearchDeferredOptions = {
  includeSchema?: boolean;
  /**
   * 查询的 embedding 向量（已归一化或未归一化均可）。
   * 提供时启用 hybrid 召回：BM25/overlap/trigram/registryName 4 路 + embedding 第 5 路 RRF 融合。
   * 不提供时降级为纯 BM25 召回。
   */
  queryVector?: number[] | Float32Array;
};

export function searchDeferredTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: SearchDeferredOptions,
): DeferredToolSearchMatch[] {
  const cfg = getToolSearchConfig();

  // ===== Level 1: 路由到类别 =====
  const categoryNames = routeToCategory(
    query,
    (options?.queryVector as Float32Array | undefined) ?? null,
    catalog.categoryIndex,
    catalog.categoryBm25,
    catalog.categories,
  );
  if (categoryNames.length === 0) {
    // 无命中类别 → 降级到全量 BM25（兜底）
    return searchWithinTools(catalog, query, limit, catalog.entries, options);
  }

  // ===== Level 2: 类别内搜索 =====
  // 多类别路由时（gap < 0.1 触发 top-2）→ 并行搜两个类别后 RRF 合并
  let results: DeferredToolSearchMatch[];
  if (categoryNames.length > 1) {
    results = searchMultiCategory(catalog, query, limit, categoryNames, options);
  } else {
    const catName = categoryNames[0]!;
    const toolNames = catalog.categories.get(catName)?.toolNames ?? [];
    const categoryEntries = toolNames
      .map((n) => catalog.byName.get(n))
      .filter((e): e is DeferredToolEntry => e != null);

    if (categoryEntries.length === 0) {
      // 类别为空 → 降级全量搜索
      results = searchWithinTools(catalog, query, limit, catalog.entries, options);
    } else {
      results = searchWithinTools(catalog, query, limit, categoryEntries, options);
    }
  }

  // ===== Level 3: 全量兜底（杜绝漏检）=====
  // 类别路由只是"倾向"，不是硬排除：
  //   1. 未分类 / 新注册工具（如 misc）可能不在任何命中类别内
  //   2. 路由到错类别时，类别内结果要么不足 limit、要么 top-1 分数很低
  // 此时合并全量召回，按分数取 top-limit，任何工具都不会被永久排除在检索之外。
  if (results.length < limit || results[0]?.score < MIN_CATEGORY_TOP_SCORE) {
    const fullResults = searchWithinTools(catalog, query, limit, catalog.entries, options);
    results = mergeToolMatches(results, fullResults, limit);
  }

  return results;
}

/**
 * 类别内结果 top-1 的最低可接受分数（rrf 融合后的综合分）。
 * 低于该值视为"类别路由不自信"，触发全量兜底合并。
 */
const MIN_CATEGORY_TOP_SCORE = 0.02;

/**
 * 合并两批匹配：类别内结果(a)优先保序，全量兜底结果(b)只补位去重。
 * 这样类别路由命中"强相关"永远排前面，兜底只填充类别内没有的工具，
 * 不会把无关工具（如 wallet）插进类别结果前排造成干扰。
 */
function mergeToolMatches(
  a: DeferredToolSearchMatch[],
  b: DeferredToolSearchMatch[],
  limit: number,
): DeferredToolSearchMatch[] {
  const seen = new Set(a.map((m) => m.name));
  const merged = [...a];
  for (const m of b) {
    if (merged.length >= limit) break;
    if (!seen.has(m.name)) {
      merged.push(m);
      seen.add(m.name);
    }
  }
  return merged;
}

/**
 * 在指定工具子集内搜索（BM25 + embedding 动态阈值 → RRF 融合）。
 * 与原有逻辑相同，但限制搜索空间。
 */
function searchWithinTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  entries: DeferredToolEntry[],
  options?: SearchDeferredOptions,
): DeferredToolSearchMatch[] {
  // 子集搜索时增大 BM25 limit，避免其他类工具挤占本类工具排名
  const isSubset = entries.length < catalog.entries.length;
  const bm25Limit = isSubset ? Math.max(limit * 4, 20) : limit;
  const bm25Hits = catalog.index.search(query, bm25Limit, catalog.entries);
  const useEmbedding =
    options?.queryVector &&
    catalog.embeddingIndex.size > 0 &&
    getToolSearchConfig().embedding !== "off";

  let hits: Bm25HitLike[] = bm25Hits;

  if (useEmbedding) {
    const cfg = getToolSearchConfig();
    // 先全量排序，再按 entry 子集过滤 + 动态阈值
    const allEmb = catalog.embeddingIndex.rankAll(options!.queryVector!);
    // 只保留在子集内的
    const subsetNames = new Set(entries.map((e) => e.registryName));
    const filteredEmb = allEmb.filter((h) => subsetNames.has(h.id));
    const embHits = filterByDynamicThreshold(filteredEmb, {
      absoluteFloor: cfg.embeddingDynamicFloor,
      relativeRatio: cfg.embeddingDynamicRatio,
      maxKeep: cfg.embeddingDynamicMaxKeep,
    });
    hits = fuseHybridRankings(bm25Hits, embHits, cfg.embeddingRankWeight, Math.max(limit * 4, 12));
  }

  return hits
    .map((hit) => {
      const entry = catalog.byName.get(hit.id);
      if (!entry || !isFunctionTool(entry.tool)) return null;
      // 如果不在 entries 子集内，跳过
      if (!entries.includes(entry)) return null;

      const match: DeferredToolSearchMatch = {
        name: entry.registryName,
        description: entry.tool.function.description ?? "",
        score: Math.round(applyIntentPrior(entry, query, hit.score) * 1000) / 1000,
        parameterNames: entry.parameterNames,
        requiredParameters: entry.requiredParameters,
      };

      if (options?.includeSchema && isFunctionTool(entry.tool)) {
        match.parameters =
          (entry.tool.function.parameters as Record<string, unknown> | undefined) ?? {
            type: "object",
            properties: {},
          };
      }

      return match;
    })
    .filter((v): v is DeferredToolSearchMatch => v != null)
    .slice(0, limit);
}

/**
 * 多类别搜索：并行搜两个类别后 RRF 合并。
 */
function searchMultiCategory(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  categoryNames: string[],
  options?: SearchDeferredOptions,
): DeferredToolSearchMatch[] {
  const allResults: Array<{ name: string; score: number; rank: number; categoryRank: number }> = [];
  let rank = 0;

  for (const catName of categoryNames) {
    const toolNames = catalog.categories.get(catName)?.toolNames ?? [];
    const catEntries = toolNames
      .map((n) => catalog.byName.get(n))
      .filter((e): e is DeferredToolEntry => e != null);

    if (catEntries.length === 0) continue;

    const catResults = searchWithinTools(catalog, query, limit, catEntries, options);
    for (const r of catResults) {
      allResults.push({
        name: r.name,
        score: r.score,
        rank: rank++,
        categoryRank: rank,
      });
    }
  }

  // RRF 融合：按类别内 score 降序做 rank 归一
  const scoreById = new Map<string, number>();
  const catGroups = new Map<string, Array<{ name: string; score: number }>>();
  for (const r of allResults) {
    const group = catGroups.get(r.name) ?? [];
    group.push(r);
    catGroups.set(r.name, group);
  }

  for (const [, group] of catGroups) {
    // 按 score 降序，取所属类别内 rank
    group.sort((a, b) => b.score - a.score);
    group.forEach((item, idx) => {
      const rrf = 1 / (60 + idx + 1);
      scoreById.set(item.name, (scoreById.get(item.name) ?? 0) + rrf);
    });
  }

  return [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => {
      const entry = catalog.byName.get(name);
      if (!entry) return null;
      const desc = isFunctionTool(entry.tool) ? (entry.tool.function.description ?? "") : "";
      return {
        name: entry.registryName,
        description: desc,
        score: 0,
        parameterNames: entry.parameterNames,
        requiredParameters: entry.requiredParameters,
      } as DeferredToolSearchMatch;
    })
    .filter((v): v is DeferredToolSearchMatch => v != null);
}

/** 与 Bm25Index 输出一致的 hit 形态 */
type Bm25HitLike = { id: string; score: number };

/**
 * Hybrid 召回 RRF 融合：把 BM25 综合 ranking 与 embedding ranking 按权重合并。
 *
 * 与 catalog.index.search 内部的多路 RRF 不同——这里 embedding 是独立通道，
 * 权重由 cfg.embeddingRankWeight 决定。权重越高，embedding 通道在最终 ranking
 * 中占比越大。
 *
 * @param bm25Hits  BM25 + overlap + trigram + registryName 4 路 RRF 融合后的结果（含 rrf-like score）
 * @param embHits   Embedding 余弦 top-20
 * @param weight    embedding 通道权重（0~1），剩余权重给 BM25
 * @param topN      融合后保留 top-N（默认 limit*4，足够 RRF 排序后取 limit 个）
 */
function fuseHybridRankings(
  bm25Hits: Bm25HitLike[],
  embHits: Bm25HitLike[],
  weight: number,
  topN: number,
): Bm25HitLike[] {
  const bm25Weight = 1 - weight;
  const scoreById = new Map<string, number>();

  // BM25 综合 ranking：按原 score 算 rank（score 越高 rank 越前）
  const bm25Sorted = [...bm25Hits].sort((a, b) => b.score - a.score);
  bm25Sorted.forEach((h, rank) => {
    const rrf = 1 / (60 + rank + 1);
    scoreById.set(h.id, (scoreById.get(h.id) ?? 0) + rrf * bm25Weight);
  });

  // Embedding ranking：直接按相似度排序
  embHits.forEach((h, rank) => {
    const rrf = 1 / (60 + rank + 1);
    scoreById.set(h.id, (scoreById.get(h.id) ?? 0) + rrf * weight);
  });

  return [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, score]) => ({ id, score }));
}

function applyIntentPrior(
  entry: DeferredToolEntry,
  query: string,
  baseScore: number,
): number {
  const queryTokens = new Set(tokenize(query));
  let score = baseScore;

  for (const phrase of [...entry.searchAliases, ...entry.examples]) {
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((token) => queryTokens.has(token)).length;
    if (overlap > 0) score += Math.min(1.2, overlap * 0.18);
  }

  for (const phrase of [...entry.negativeAliases, ...entry.negativeExamples]) {
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((token) => queryTokens.has(token)).length;
    if (overlap > 0) score -= Math.min(1.5, overlap * 0.3);
  }

  return score;
}

export function describeDeferredTool(
  catalog: DeferredToolCatalog,
  name: string,
): Record<string, unknown> | null {
  const resolved = resolveCatalogToolName(catalog, name);
  if (!resolved || !isFunctionTool(resolved.tool)) return null;
  const fn = resolved.tool.function;
  return {
    name: resolved.registryName,
    description: fn.description ?? "",
    parameters: fn.parameters ?? { type: "object", properties: {} },
  };
}

export function resolveCatalogToolName(
  catalog: DeferredToolCatalog,
  rawName: string,
): DeferredToolEntry | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  const direct = catalog.byName.get(trimmed);
  if (direct) return direct;

  const apiNormalized = trimmed.replace(/\./g, "_");
  return (
    catalog.byApiName.get(apiNormalized) ??
    catalog.byName.get(apiNormalized) ??
    null
  );
}
