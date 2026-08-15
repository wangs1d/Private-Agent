import type { DeferredToolCatalog } from "./catalog.js";
import { describeDeferredTool, resolveCatalogToolName, searchDeferredTools } from "./catalog.js";
import {
  adaptiveSearchDeferredTools,
  type AdaptiveDeferredToolSearchMatch,
} from "./adaptive-catalog.js";
import { getToolSearchConfig } from "./env.js";
import { searchDeferredToolsViaToolRouter } from "./tool-router-adapter.js";
import { getQueryEmbedding, peekQueryEmbedding } from "./tool-embedding.js";
import { HistoryScoreStore } from "./retrieval/history-score.js";
import { ResourceType } from "./registry/models.js";
import { isRegisteredSkillChatToolName } from "../../skills/skill-openai-bridge.js";

const historyStore = new HistoryScoreStore();
const EMBED_GRACE_MS = 150;

const ADAPTIVE_AGENT_SEARCH_PATH = [
  "intent_router",
  "hierarchical_router",
  "hybrid_retrieval",
  "adaptive_top_p",
  "knowledge_graph_expansion",
  "tool_reranking",
] as const;

export type ToolSearchBridgeResult =
  | {
      kind: "search" | "describe" | "discover";
      ok: boolean;
      result: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: true;
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: false;
      result: Record<string, unknown>;
    };

/**
 * Agent 延迟工具桥接入口。
 *
 * tool_search / tool_discover 的主搜索路径统一迁移到 adaptive pipeline：
 * Intent Router → Hierarchical Router → Hybrid Retrieval → Adaptive Top-P →
 * Knowledge Graph Expansion → Tool Reranking。
 *
 * Legacy BM25 只在 adaptive pipeline 异常时兜底。
 */
export async function executeToolSearchBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
): Promise<ToolSearchBridgeResult> {
  const normalized = normalizeBridgeName(bridgeName);
  const cfg = getToolSearchConfig();

  if (normalized === "tool_discover") {
    return executeToolDiscover(args, catalog, cfg);
  }

  if (normalized === "tool_search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { kind: "search", ok: false, result: { error: "query 不能为空", matches: [] } };
    }
    const limit = resolveSearchLimit(args.limit, cfg);
    const includeSchema = args.include_schema === true;
    const matches = await searchAdaptiveAgentPath(catalog, query, limit, {
      includeSchema,
      tenantId: resolveTenantArg(args),
      agentContextHash: resolveContextHashArg(args),
    });
    return {
      kind: "search",
      ok: true,
      result: {
        matches,
        query,
        count: matches.length,
        search_path: ADAPTIVE_AGENT_SEARCH_PATH,
      },
    };
  }

  if (normalized === "tool_describe") {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { kind: "describe", ok: false, result: { error: "name 不能为空" } };
    }
    const schema = describeDeferredTool(catalog, name);
    if (!schema) {
      return { kind: "describe", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    return { kind: "describe", ok: true, result: schema };
  }

  if (normalized === "tool_call") {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { kind: "call", ok: false, result: { error: "name 不能为空" } };
    }
    const entry = resolveCatalogToolName(catalog, name);
    if (!entry) {
      return { kind: "call", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    const parsedArgs = resolveCallArguments(args.arguments);
    recordToolCallFeedback(catalog, entry.registryName);
    return {
      kind: "call",
      ok: true,
      registryToolName: entry.registryName,
      parsedArgs,
    };
  }

  return { kind: "search", ok: false, result: { error: `未知桥接工具: ${bridgeName}` } };
}

/**
 * 解析 tool_call 的 arguments。
 *
 * LLM 偶尔会把 arguments 序列化成 JSON 字符串回传（而非按 schema 传对象），
 * 若直接丢弃会导致工具以空参数执行——比报错更隐蔽。因此对字符串做 JSON.parse 兜底：
 *  - 对象（非数组）→ 直接使用
 *  - JSON 字符串且解析后为对象 → 使用解析结果
 *  - 其余（数组/数字/布尔/null/非法 JSON）→ 保持空参数，不抛错
 */
function resolveCallArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非法 JSON 字符串：保持空参数，不抛错
    }
  }
  return {};
}

function normalizeBridgeName(name: string): string {
  if (name === "tool_resolve") return "tool_discover";
  return name;
}

function resolveSearchLimit(
  raw: unknown,
  cfg: ReturnType<typeof getToolSearchConfig>,
): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), cfg.maxSearchLimit)
    : cfg.searchDefaultLimit;
}

function resolveTenantArg(args: Record<string, unknown>): string {
  return String(args.tenant_id ?? args.tenantId ?? "default");
}

function resolveContextHashArg(args: Record<string, unknown>): string {
  return String(args.agent_context_hash ?? args.context_hash ?? "tool-search-bridge");
}

function executeToolDiscover(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
): Promise<ToolSearchBridgeResult> {
  const name = String(args.name ?? "").trim();
  const query = String(args.query ?? "").trim();

  if (name) {
    return executeToolDiscoverByName(args, catalog, cfg, name, query);
  }
  if (!query) {
    return Promise.resolve({
      kind: "discover",
      ok: false,
      result: { error: "请提供 query（搜索）或 name（直接加载 schema）" },
    });
  }
  return executeToolDiscoverByQuery(args, catalog, cfg, query);
}

async function executeToolDiscoverByName(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
  name: string,
  query: string,
): Promise<ToolSearchBridgeResult> {
  const schema = describeDeferredTool(catalog, name);
  if (!schema) {
    return { kind: "discover", ok: false, result: { error: `未找到延迟工具: ${name}` } };
  }
  const result: Record<string, unknown> = { mode: "describe", tool: schema };
  if (query) {
    const limit = resolveSearchLimit(args.limit, cfg);
    result.search = await searchAdaptiveAgentPath(catalog, query, limit, {
      tenantId: resolveTenantArg(args),
      agentContextHash: resolveContextHashArg(args),
    });
  }
  return { kind: "discover", ok: true, result };
}

async function executeToolDiscoverByQuery(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
  query: string,
): Promise<ToolSearchBridgeResult> {
  const limit = resolveSearchLimit(args.limit, cfg);
  const includeAllSchema = args.include_schema === true;
  let matches = await searchAdaptiveAgentPath(catalog, query, limit, {
    includeSchema: includeAllSchema,
    tenantId: resolveTenantArg(args),
    agentContextHash: resolveContextHashArg(args),
  });

  if (
    cfg.discoverAutoSchemaTop1 &&
    !includeAllSchema &&
    matches.length > 0 &&
    matches[0].parameters == null
  ) {
    const topSchema = describeDeferredTool(catalog, matches[0].name);
    if (topSchema) {
      matches = [
        {
          ...matches[0],
          parameters:
            (topSchema.parameters as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
            },
        },
        ...matches.slice(1),
      ];
    }
  }

  return {
    kind: "discover",
    ok: true,
    result: {
      mode: "search",
      query,
      count: matches.length,
      matches,
      search_path: ADAPTIVE_AGENT_SEARCH_PATH,
      hint: "首选 matches[0]；已含 schema 时可直接 tool_call。",
    },
  };
}

async function searchAdaptiveAgentPath(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options: {
    includeSchema?: boolean;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const queryVector =
    peekQueryEmbedding(query) ??
    (await raceWithTimeout(safeQueryEmbedding(query, catalog), EMBED_GRACE_MS));
  const matches = await searchWithAdaptiveFallback(catalog, query, limit, {
    includeSchema: options.includeSchema,
    queryVector: queryVector ?? undefined,
    tenantId: options.tenantId,
    agentContextHash: options.agentContextHash,
  });
  recordSearchContext(catalog, query, matches);
  return matches;
}

function recordSearchContext(
  catalog: DeferredToolCatalog,
  query: string,
  matches: Array<{ name: string }>,
): void {
  const ctx = catalog as DeferredToolCatalog & {
    lastSearchQuery?: string;
    lastSearchMatches?: string[];
  };
  ctx.lastSearchQuery = query;
  ctx.lastSearchMatches = matches.slice(0, 5).map((m) => m.name);
}

function recordToolCallFeedback(catalog: DeferredToolCatalog, chosen: string): void {
  const ctx = catalog as DeferredToolCatalog & {
    lastSearchQuery?: string;
    lastSearchMatches?: string[];
  };
  if (!ctx.lastSearchQuery || !ctx.lastSearchMatches || ctx.lastSearchMatches.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  void historyStore.record({
    resource_id: chosen,
    success: true,
    latency_ms: 0,
    result_quality_score: 0.8,
    call_timestamp: now,
  });
  const top1 = ctx.lastSearchMatches[0];
  if (top1 && top1 !== chosen && ctx.lastSearchMatches.includes(chosen)) {
    void historyStore.record({
      resource_id: top1,
      success: false,
      latency_ms: 0,
      result_quality_score: 0,
      call_timestamp: now,
    });
  }
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function searchWithAdaptiveFallback(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options: {
    includeSchema?: boolean;
    queryVector?: number[] | Float32Array;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const cfg = getToolSearchConfig();
  if (cfg.backend === "tool_router") {
    const [toolRouterResult, adaptiveResult] = await Promise.allSettled([
      searchDeferredToolsViaToolRouter(catalog, query, limit, {
        includeSchema: options.includeSchema,
        tenantId: options.tenantId,
        agentContextHash: options.agentContextHash,
      }),
      adaptiveSearchDeferredTools(catalog, query, limit, options),
    ]);

    if (toolRouterResult.status === "fulfilled" && adaptiveResult.status === "fulfilled") {
      return mergeBackendMatches(adaptiveResult.value, toolRouterResult.value, limit);
    }
    if (adaptiveResult.status === "fulfilled") {
      if (toolRouterResult.status === "rejected") {
        console.warn("[tool-search:bridge] tool-router backend failed, fallback to adaptive TS path", toolRouterResult.reason);
      }
      return adaptiveResult.value;
    }
    if (toolRouterResult.status === "fulfilled") {
      console.warn("[tool-search:bridge] adaptive TS path failed, fallback to tool-router backend");
      return toolRouterResult.value;
    }
    console.warn("[tool-search:bridge] both tool-router and adaptive search failed", {
      toolRouterError: toolRouterResult.reason,
      adaptiveError: adaptiveResult.reason,
    });
    const fallback = searchDeferredTools(catalog, query, limit, {
      includeSchema: options.includeSchema,
      queryVector: options.queryVector,
    });
    return fallback.map((match) => {
      const resourceType = inferFallbackResourceType(match.name);
      const domain = inferFallbackDomain(match.name, resourceType);
      const domainGroups = inferFallbackDomainGroups(domain, resourceType);
      return {
        ...match,
        resource_type: resourceType,
        domain,
        capability: domain.map((item) => `${item}.general`),
        routing: {
          intent: query,
          confidence: 0.5,
          top_p: 0.95,
          domain_groups: domainGroups,
          domain_candidates: domain,
          primary_capability: `${domain[0] ?? "misc"}.general`,
        },
      } satisfies AdaptiveDeferredToolSearchMatch;
    });
  }
  try {
    return await adaptiveSearchDeferredTools(catalog, query, limit, options);
  } catch (e) {
    console.warn("[tool-search:bridge] adaptive search failed, fallback to legacy BM25", e);
    const fallback = searchDeferredTools(catalog, query, limit, {
      includeSchema: options.includeSchema,
      queryVector: options.queryVector,
    });
    return fallback.map((match) => {
      const resourceType = inferFallbackResourceType(match.name);
      const domain = inferFallbackDomain(match.name, resourceType);
      const domainGroups = inferFallbackDomainGroups(domain, resourceType);
      return {
        ...match,
        resource_type: resourceType,
        domain,
        capability: domain.map((item) => `${item}.general`),
        routing: {
          intent: query,
          confidence: 0.5,
          top_p: 0.95,
          domain_groups: domainGroups,
          domain_candidates: domain,
          primary_capability: `${domain[0] ?? "misc"}.general`,
        },
      } satisfies AdaptiveDeferredToolSearchMatch;
    });
  }
}

function mergeBackendMatches(
  adaptive: AdaptiveDeferredToolSearchMatch[],
  toolRouter: AdaptiveDeferredToolSearchMatch[],
  limit: number,
): AdaptiveDeferredToolSearchMatch[] {
  const merged = new Map<string, AdaptiveDeferredToolSearchMatch>();
  for (const match of adaptive) merged.set(match.name, match);
  for (const match of toolRouter) {
    if (!merged.has(match.name)) {
      merged.set(match.name, match);
      continue;
    }
    const current = merged.get(match.name);
    if (current && match.score > current.score) {
      merged.set(match.name, { ...current, score: match.score });
    }
  }
  return [...merged.values()].slice(0, Math.max(1, limit));
}

function inferFallbackResourceType(name: string): ResourceType {
  if (name.startsWith("mcp.")) return ResourceType.McpServer;
  if (isRegisteredSkillChatToolName(name)) return ResourceType.Skill;
  return ResourceType.Tool;
}

function inferFallbackDomain(name: string, resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["mcp"];
  if (resourceType === ResourceType.Skill) return ["self"];
  if (name === "search_web" || name === "fetch_web") return ["search"];
  return [name.split(/[._-]/)[0]?.toLowerCase() || "misc"];
}

function inferFallbackDomainGroups(domains: string[], resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["integration"];
  if (resourceType === ResourceType.Skill) return ["productivity"];
  const first = domains[0] ?? "general";
  switch (first) {
    case "search":
    case "browser":
      return ["information"];
    case "calendar":
    case "reminder":
    case "self":
      return ["productivity"];
    case "phone":
    case "agent":
      return ["communication"];
    case "world":
    case "aip":
      return ["coordination"];
    case "wallet":
    case "budget":
    case "shopping":
      return ["commerce"];
    case "desktop":
    case "embodiment":
    case "device":
    case "smart_home":
    case "vision":
      return ["execution"];
    case "weather":
    case "clock":
      return ["signals"];
    default:
      return ["general"];
  }
}

/**
 * 安全拉取 query embedding：超时 / 失败 / 工具集过小 → 返回 null（静默降级）。
 *
 * 性能：缓存命中 0 RTT；未命中 + 走 API 通常 80~200ms，所以仅在 catalog 有
 * embedding 索引时尝试拉，避免无意义开销。
 */
async function safeQueryEmbedding(
  query: string,
  catalog: DeferredToolCatalog,
): Promise<Float32Array | null> {
  // 没有 embedding 索引就别白跑 API（catalog 一定 fallback 到纯 BM25）
  if (catalog.embeddingIndex.size === 0) return null;
  try {
    return await getQueryEmbedding(query);
  } catch {
    return null;
  }
}
