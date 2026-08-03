import type { DeferredToolCatalog } from "./catalog.js";
import { describeDeferredTool, resolveCatalogToolName, searchDeferredTools } from "./catalog.js";
import { getToolSearchConfig } from "./env.js";
import { getQueryEmbedding } from "./tool-embedding.js";

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
 * 异步执行桥接工具。tool_search / tool_discover 在执行时会同步尝试拉取 query 的
 * embedding（命中 LRU 内存缓存就零成本），若有则走 BM25 + embedding hybrid RRF 召回；
 * 无 key / API 失败 / 工具集过小 → 静默降级纯 BM25，不影响返回。
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
    const queryVector = await safeQueryEmbedding(query, catalog);
    const matches = searchDeferredTools(catalog, query, limit, {
      includeSchema,
      queryVector: queryVector ?? undefined,
    });
    return { kind: "search", ok: true, result: { matches, query, count: matches.length } };
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
    const parsedArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    return {
      kind: "call",
      ok: true,
      registryToolName: entry.registryName,
      parsedArgs,
    };
  }

  return { kind: "search", ok: false, result: { error: `未知桥接工具: ${bridgeName}` } };
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
    const queryVector = await safeQueryEmbedding(query, catalog);
    result.search = searchDeferredTools(catalog, query, limit, { queryVector: queryVector ?? undefined });
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
  const queryVector = await safeQueryEmbedding(query, catalog);
  let matches = searchDeferredTools(catalog, query, limit, {
    includeSchema: includeAllSchema,
    queryVector: queryVector ?? undefined,
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
      hint: "首选 matches[0]；已含 schema 时可直接 tool_call。",
    },
  };
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
