/**
 * 工具 embedding 召回（hybrid: BM25 + 余弦相似度 → RRF 融合）。
 *
 * 关键设计：
 *   - 工具 description 变化时才重新算 embedding（按 text hash 缓存）
 *   - 磁盘 JSON 缓存（data/tool-embeddings.json），避免服务重启后全量重算
 *   - 启动时按需懒加载：首次 searchDeferredTools 时尝试加载 cache，缺失的工具 background 预计算
 *   - 缺 OPENAI_API_KEY / API 失败时降级纯 BM25（不报错）
 *
 * 流程：
 *   buildDeferredCatalog → 标记每个 entry 预计算状态
 *   searchDeferredTools → 若任一 entry 待 embedding → 触发后台批量补全
 *                       → 下一次 search 即可用 hybrid
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { fetchOpenAiCompatibleEmbedding } from "../../services/openai-embedding-client.js";
import { getToolSearchConfig } from "./env.js";

/** 工具 embedding cache 项 */
export type ToolEmbeddingCacheEntry = {
  /** 工具的 searchText 内容的 SHA-256 hash（用于检测 description 变化） */
  contentHash: string;
  /** 1536 维 embedding 向量 */
  vector: number[];
  /** embedding 模型名（防止不同模型混用） */
  model: string;
  /** 写入时间戳（ms） */
  updatedAt: number;
};

export type ToolEmbeddingCache = {
  /** key = 工具 registryName */
  entries: Record<string, ToolEmbeddingCacheEntry>;
  /** cache 整体元数据 */
  meta: {
    model: string;
    dimension: number;
    builtAt: number;
  };
};

const DEFAULT_CACHE_PATH = resolve(process.cwd(), "data", "tool-embeddings.json");

let _cache: ToolEmbeddingCache | null = null;
let _cacheLoaded = false;
let _pendingComputePromise: Promise<{ computed: number; reused: number; failed: number }> | null = null;

function getCachePath(): string {
  const override = getToolSearchConfig().embeddingCachePath;
  return override ? resolve(override) : DEFAULT_CACHE_PATH;
}

function getApiKey(): string | null {
  return (
    process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    null
  );
}

function getModel(): string {
  return getToolSearchConfig().embeddingModel;
}

/** 工具 searchText 的内容指纹（description / aliases / examples 任何变化都会让 hash 变） */
export function hashSearchText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function loadCacheFromDisk(): ToolEmbeddingCache {
  const path = getCachePath();
  if (!existsSync(path)) {
    return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ToolEmbeddingCache;
    if (!parsed?.entries || !parsed?.meta) {
      return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[tool-embedding] Failed to read cache, starting fresh:",
      error instanceof Error ? error.message : String(error),
    );
    return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
  }
}

function saveCacheToDisk(cache: ToolEmbeddingCache): void {
  const path = getCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (error) {
    console.warn(
      "[tool-embedding] Failed to write cache:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function getToolEmbeddingCache(): ToolEmbeddingCache {
  if (!_cache) {
    _cache = loadCacheFromDisk();
    _cacheLoaded = true;
  }
  return _cache;
}

/** 检查是否启用了 embedding 召回（且有可用 key） */
export function isEmbeddingSearchEnabled(): boolean {
  const cfg = getToolSearchConfig();
  if (cfg.embedding === "off") return false;
  if (cfg.embedding === "on") return Boolean(getApiKey());
  // auto：有 key 就用，没有就降级
  return Boolean(getApiKey());
}

/**
 * 为一组工具批量补全 embedding（懒加载入口）。
 *
 * 内部对每个工具判断：
 *   - 已有 cache 且 hash 匹配 → 跳过
 *   - 没有 cache 或 hash 不匹配 → 调用 API 重算
 *
 * 并发：批量 8 个并发避免触发限流。
 *
 * 不抛错：API 失败仅记录 warning，下一次 search 仍可走纯 BM25。
 */
export async function ensureToolEmbeddings(
  tools: Array<{ registryName: string; searchText: string }>,
): Promise<{ computed: number; reused: number; failed: number }> {
  if (!isEmbeddingSearchEnabled() || tools.length === 0) {
    return { computed: 0, reused: 0, failed: 0 };
  }
  if (_pendingComputePromise) {
    await _pendingComputePromise;
  }

  _pendingComputePromise = (async () => {
    const cache = getToolEmbeddingCache();
    const model = getModel();
    const apiKey = getApiKey()!;
    let computed = 0;
    let reused = 0;
    let failed = 0;

    // 找出需要重算的（没有 cache 或 hash 不匹配）
    const toCompute: typeof tools = [];
    for (const t of tools) {
      const h = hashSearchText(t.searchText);
      const existing = cache.entries[t.registryName];
      if (existing && existing.contentHash === h && existing.model === model) {
        reused += 1;
        continue;
      }
      toCompute.push(t);
    }

    // 批量并发 8 个
    const CONCURRENCY = 8;
    for (let i = 0; i < toCompute.length; i += CONCURRENCY) {
      const batch = toCompute.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (t) => {
          const h = hashSearchText(t.searchText);
          const { vector } = await fetchOpenAiCompatibleEmbedding({
            apiKey,
            model,
            input: t.searchText.slice(0, 8000),
          });
          return { registryName: t.registryName, contentHash: h, vector, model };
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          cache.entries[r.value.registryName] = {
            contentHash: r.value.contentHash,
            vector: r.value.vector,
            model: r.value.model,
            updatedAt: Date.now(),
          };
          computed += 1;
        } else {
          failed += 1;
        }
      }
    }

    if (computed > 0) {
      // 更新 meta
      const dim = Object.values(cache.entries)[0]?.vector.length ?? 0;
      cache.meta = { model, dimension: dim, builtAt: Date.now() };
      saveCacheToDisk(cache);
    }

    return { computed, reused, failed };
  })();

  const result = await _pendingComputePromise;
  _pendingComputePromise = null;
  return result;
}

/** 取单个工具的 embedding（可能为 null，未缓存 / 计算失败） */
export function getToolEmbedding(registryName: string): number[] | null {
  const cache = getToolEmbeddingCache();
  return cache.entries[registryName]?.vector ?? null;
}

/** 取批量 embedding（用于构建 catalog 时建索引） */
export function getToolEmbeddingsForCatalog(
  registryNames: string[],
): Map<string, number[]> {
  const cache = getToolEmbeddingCache();
  const out = new Map<string, number[]>();
  for (const name of registryNames) {
    const v = cache.entries[name]?.vector;
    if (v) out.set(name, v);
  }
  return out;
}

/**
 * 把工具 searchText 拼成「语义搜索输入」——给 embedding 模型最有区分度的形式。
 *
 * 优先：name + description + aliases（多语言拼一起）。
 * 不重复 description 全文，避免长 description 主导向量。
 */
export function buildEmbeddingInput(tool: ChatCompletionTool): string {
  if (tool.type !== "function" || !tool.function) return "";
  const fn = tool.function;
  const parts: string[] = [];
  parts.push(`[${fn.name}]`);
  if (fn.description) parts.push(fn.description.slice(0, 1500));
  // 把 parameterNames 也带上（schema 关键词）
  const { parameterNames } = (() => {
    try {
      const params = fn.parameters as
        | { properties?: Record<string, unknown> }
        | undefined;
      const pNames = params?.properties ? Object.keys(params.properties) : [];
      return { parameterNames: pNames };
    } catch {
      return { parameterNames: [] as string[] };
    }
  })();
  if (parameterNames.length > 0) parts.push(`params: ${parameterNames.join(", ")}`);
  return parts.filter(Boolean).join("\n");
}

/** 清空内存缓存（自我进化装载 Skill 后调用，让新工具的 embedding 重新计算） */
export function invalidateEmbeddingCache(): void {
  _cache = null;
  _cacheLoaded = false;
  _pendingComputePromise = null;
}

// === Query embedding 缓存 + 预计算 ===
// LRU 上限 128 个 query；过期 5 分钟。
// 避免同一 query 重复算 embedding（LLM 多轮场景下常见）

type QueryVectorEntry = {
  vector: Float32Array;
  expiresAt: number;
};

const QUERY_LRU_MAX = 128;
const QUERY_TTL_MS = 5 * 60 * 1000;

const _queryVectorCache = new Map<string, QueryVectorEntry>();
const _queryVectorInflight = new Map<string, Promise<Float32Array | null>>();

function trimQueryCache(): void {
  if (_queryVectorCache.size <= QUERY_LRU_MAX) return;
  // Map 保持插入顺序，删除最早的
  const toDelete = _queryVectorCache.size - QUERY_LRU_MAX;
  let i = 0;
  for (const key of _queryVectorCache.keys()) {
    if (i >= toDelete) break;
    _queryVectorCache.delete(key);
    i++;
  }
}

/** 同步查 query embedding cache；过期或 miss 返回 null */
export function peekQueryEmbedding(query: string): Float32Array | null {
  const entry = _queryVectorCache.get(query);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    _queryVectorCache.delete(query);
    return null;
  }
  return entry.vector;
}

/**
 * 异步获取 query embedding（命中 cache 直接返回，miss 则调用 API）。
 *
 * 并发安全：同 query 的多次请求会复用同一个 in-flight promise。
 */
export async function getQueryEmbedding(query: string): Promise<Float32Array | null> {
  const cached = peekQueryEmbedding(query);
  if (cached) return cached;
  if (!isEmbeddingSearchEnabled()) return null;

  const inflight = _queryVectorInflight.get(query);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const apiKey = getApiKey()!;
      const model = getModel();
      const { vector } = await fetchOpenAiCompatibleEmbedding({
        apiKey,
        model,
        input: query.slice(0, 2000),
      });
      const normalized = new Float32Array(vector.length);
      let norm = 0;
      for (let i = 0; i < vector.length; i++) {
        normalized[i] = vector[i] ?? 0;
        norm += (vector[i] ?? 0) ** 2;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < vector.length; i++) normalized[i] = normalized[i]! / norm;
      }
      _queryVectorCache.set(query, {
        vector: normalized,
        expiresAt: Date.now() + QUERY_TTL_MS,
      });
      trimQueryCache();
      return normalized;
    } catch (error) {
      console.warn(
        "[tool-embedding] query embedding failed, fall back to BM25:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    } finally {
      _queryVectorInflight.delete(query);
    }
  })();

  _queryVectorInflight.set(query, promise);
  return promise;
}

/** 预热 query embedding（fire-and-forget，让后续 search 命中 cache） */
export function primeQueryEmbedding(query: string): void {
  if (peekQueryEmbedding(query)) return;
  if (!isEmbeddingSearchEnabled()) return;
  void getQueryEmbedding(query);
}
