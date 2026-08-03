import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildToolSearchBridgeTools } from "./bridge-tools.js";
import {
  buildDeferredCatalog,
  shouldActivateToolSearch,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
import { getToolSearchConfig } from "./env.js";

export type ToolSearchPreparedTurn = {
  visibleTools: ChatCompletionTool[];
  deferredCatalog: DeferredToolCatalog;
  toolSearchActive: boolean;
  coreToolCount: number;
  deferredToolCount: number;
};

function isFunctionName(tool: ChatCompletionTool): string | null {
  return tool.type === "function" && tool.function?.name ? tool.function.name : null;
}

function uniqueTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    const name = isFunctionName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

/**
 * 全量 BM25 索引跨轮缓存。
 *
 * deferred 工具集每轮随 contextual 筛选结果变化（visible 变 → deferred 变），
 * 但 searchableSourceTools（通常是全量 builtin 工具）在运行时几乎不变，
 * 只有 MCP 动态注册 / self-programming 生成 skill 时才会变。
 *
 * 因此把"全量 searchable 的 BM25 索引"缓存起来，每轮只做 O(n) 的 entries 过滤
 * （过滤出 deferred 子集 + 重建 byName/byApiName 两个 Map），不再每轮重建 Bm25Index。
 *
 * 失效策略：按 searchable 工具名签名（排序后 join）做 key，签名变化即重建。
 * 重建后会覆盖旧缓存，保证 MCP / self-programming 新增工具可见。
 */
type FullCatalogCache = {
  signature: string;
  full: DeferredToolCatalog;
  createdAt: number;
};

let _fullCatalogCache: FullCatalogCache | null = null;
const FULL_CATALOG_TTL_MS = 5 * 60 * 1000; // 5 分钟 TTL，防止长期持有过期引用

function computeToolsSignature(tools: ChatCompletionTool[]): string {
  const names = tools
    .map((t) => (t.type === "function" && t.function?.name ? t.function.name : ""))
    .filter(Boolean)
    .sort();
  return names.join(",");
}

/**
 * 取（或构建）全量 catalog。命中缓存时直接返回，否则重建并写入缓存。
 */
function getOrCreateFullCatalog(searchableTools: ChatCompletionTool[]): DeferredToolCatalog {
  const signature = computeToolsSignature(searchableTools);
  const now = Date.now();
  if (
    _fullCatalogCache &&
    _fullCatalogCache.signature === signature &&
    now - _fullCatalogCache.createdAt < FULL_CATALOG_TTL_MS
  ) {
    return _fullCatalogCache.full;
  }
  const full = buildDeferredCatalog(searchableTools);
  _fullCatalogCache = { signature, full, createdAt: now };
  return full;
}

/**
 * 从全量 catalog 派生 deferred catalog：复用全量 Bm25Index（IDF 基于全量更准确），
 * 只过滤 entries / byName / byApiName 为 deferred 子集。
 *
 * 搜索时 `searchDeferredTools` 用 `catalog.index.search` 返回全量 hit，
 * 再通过 `catalog.byName.get(hit.id)` 查找——visible 工具不在 byName 中，
 * 自然被 `filter((v) => v != null)` 过滤掉，不影响结果正确性。
 */
function deriveDeferredCatalog(
  full: DeferredToolCatalog,
  visibleNames: Set<string>,
): DeferredToolCatalog {
  const entries = full.entries.filter((e) => !visibleNames.has(e.registryName));
  const byName = new Map(entries.map((e) => [e.registryName, e]));
  const byApiName = new Map(
    entries.map((e) => [e.registryName.replace(/\./g, "_"), e] as const),
  );
  return {
    entries,
    index: full.index,
    byName,
    byApiName,
    embeddingIndex: full.embeddingIndex,
    embeddingReady: full.embeddingReady,
    // 两层架构：类别路由字段（由全量 catalog 构建，每轮共享）
    categoryIndex: full.categoryIndex,
    categories: full.categories,
    categoryBm25: full.categoryBm25,
  };
}

/**
 * 核心工具库 + 延迟目录：核心工具直接暴露；其余工具 BM25 索引，经合并桥接按需加载。
 */
export function prepareToolsWithToolSearch(
  visibleCandidateTools: ChatCompletionTool[],
  searchableSourceTools: ChatCompletionTool[] = visibleCandidateTools,
): ToolSearchPreparedTurn {
  const cfg = getToolSearchConfig();
  const visibleTools = uniqueTools(visibleCandidateTools);
  const visibleNames = new Set(
    visibleTools
      .map((tool) => isFunctionName(tool))
      .filter((name): name is string => Boolean(name)),
  );
  const searchableTools = uniqueTools(searchableSourceTools);
  const deferred = searchableTools.filter((tool) => {
    const name = isFunctionName(tool);
    return Boolean(name) && !visibleNames.has(name as string);
  });
  // 复用全量 BM25 索引（跨轮缓存），每轮只过滤 entries
  const fullCatalog = getOrCreateFullCatalog(searchableTools);
  const deferredCatalog = deriveDeferredCatalog(fullCatalog, visibleNames);
  const active = shouldActivateToolSearch(
    deferred,
    cfg.enabled,
    cfg.thresholdPct,
    cfg.contextTokens,
  );

  if (!active) {
    return {
      visibleTools,
      deferredCatalog: buildDeferredCatalog([]),
      toolSearchActive: false,
      coreToolCount: visibleTools.length,
      deferredToolCount: 0,
    };
  }

  const bridgeTools = buildToolSearchBridgeTools(deferredCatalog.entries.length, cfg.bridgeMode);
  return {
    visibleTools: uniqueTools([...visibleTools, ...bridgeTools]),
    deferredCatalog,
    toolSearchActive: true,
    coreToolCount: visibleTools.length,
    deferredToolCount: deferred.length,
  };
}

/** 测试/调试用：手动清空全量 catalog 缓存（MCP 重连等场景） */
export function invalidateFullCatalogCache(): void {
  _fullCatalogCache = null;
}

export {
  CORE_TOOL_LIBRARY,
  classifyToolExposureTier,
  isCoreToolRegistryName,
  isFastLaneTool,
  isMasterAgentBuiltinTool,
  registerDynamicFastLaneName,
  registerDynamicFastLaneNames,
  clearDynamicFastLaneNames,
  listDynamicFastLaneNames,
  summarizeCoreToolLibrary,
  type ToolExposureTier,
} from "./core-tool-library.js";
export {
  TOOL_SEARCH_CORE_REGISTRY_NAMES,
  TOOL_SEARCH_CORE_REGISTRY_PREFIXES,
  TOOL_SEARCH_BRIDGE_MERGED,
  TOOL_SEARCH_BRIDGE_LEGACY,
  isToolSearchCoreRegistryName,
  isToolSearchBridgeName,
} from "./core-tools.js";
export {
  buildDeferredCatalog,
  estimateToolsSchemaTokens,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
export { executeToolSearchBridge, type ToolSearchBridgeResult } from "./handlers.js";
