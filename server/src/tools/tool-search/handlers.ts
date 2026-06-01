import type { DeferredToolCatalog } from "./catalog.js";
import { describeDeferredTool, resolveCatalogToolName, searchDeferredTools } from "./catalog.js";
import { getToolSearchConfig } from "./env.js";

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

export function executeToolSearchBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
): ToolSearchBridgeResult {
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
    const matches = searchDeferredTools(catalog, query, limit, { includeSchema });
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
): ToolSearchBridgeResult {
  const name = String(args.name ?? "").trim();
  const query = String(args.query ?? "").trim();

  if (name) {
    const schema = describeDeferredTool(catalog, name);
    if (!schema) {
      return { kind: "discover", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    const result: Record<string, unknown> = { mode: "describe", tool: schema };
    if (query) {
      const limit = resolveSearchLimit(args.limit, cfg);
      result.search = searchDeferredTools(catalog, query, limit);
    }
    return { kind: "discover", ok: true, result };
  }

  if (!query) {
    return {
      kind: "discover",
      ok: false,
      result: { error: "请提供 query（搜索）或 name（直接加载 schema）" },
    };
  }

  const limit = resolveSearchLimit(args.limit, cfg);
  const includeAllSchema = args.include_schema === true;
  let matches = searchDeferredTools(catalog, query, limit, {
    includeSchema: includeAllSchema,
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
