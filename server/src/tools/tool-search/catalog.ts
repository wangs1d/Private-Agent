import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { Bm25Index, buildToolSearchText } from "./bm25.js";
import { isCoreToolRegistryName } from "./core-tool-library.js";
import { getToolSearchConfig } from "./env.js";

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
};

/** 单轮对话内复用 BM25 索引与名称查找表，避免每次 tool_search 全量重建。 */
export type DeferredToolCatalog = {
  entries: DeferredToolEntry[];
  index: Bm25Index;
  byName: Map<string, DeferredToolEntry>;
  byApiName: Map<string, DeferredToolEntry>;
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
    return {
      registryName: fn.name,
      tool,
      searchText: buildToolSearchText({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      }),
      parameterNames,
      requiredParameters,
    };
  });

  const byName = new Map(entries.map((e) => [e.registryName, e]));
  const byApiName = new Map(
    entries.map((e) => [e.registryName.replace(/\./g, "_"), e] as const),
  );
  const index = new Bm25Index(
    entries.map((entry) => ({ id: entry.registryName, text: entry.searchText })),
  );

  return { entries, index, byName, byApiName };
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

  const deferrableTokens = estimateToolsSchemaTokens(deferredTools);
  return deferrableTokens / contextTokens >= thresholdPct / 100;
}

export function searchDeferredTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: { includeSchema?: boolean },
): DeferredToolSearchMatch[] {
  const hits = catalog.index.search(query, limit);

  return hits
    .map((hit) => {
      const entry = catalog.byName.get(hit.id);
      if (!entry || !isFunctionTool(entry.tool)) return null;

      const match: DeferredToolSearchMatch = {
        name: entry.registryName,
        description: entry.tool.function.description ?? "",
        score: Math.round(hit.score * 1000) / 1000,
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
    .filter((v): v is DeferredToolSearchMatch => v != null);
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
