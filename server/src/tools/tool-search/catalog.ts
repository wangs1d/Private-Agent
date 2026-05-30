import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { Bm25Index, buildToolSearchText } from "./bm25.js";
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
};

export function splitCoreAndDeferredTools(
  tools: ChatCompletionTool[],
  coreNames: ReadonlySet<string>,
): { core: ChatCompletionTool[]; deferred: ChatCompletionTool[] } {
  const core: ChatCompletionTool[] = [];
  const deferred: ChatCompletionTool[] = [];

  for (const tool of tools) {
    if (!isFunctionTool(tool)) continue;
    if (coreNames.has(tool.function.name)) core.push(tool);
    else deferred.push(tool);
  }

  return { core, deferred };
}

export function buildDeferredCatalog(deferredTools: ChatCompletionTool[]): DeferredToolEntry[] {
  return deferredTools.filter(isFunctionTool).map((tool) => {
    const fn = tool.function;
    return {
      registryName: fn.name,
      tool,
      searchText: buildToolSearchText({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      }),
    };
  });
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
  catalog: DeferredToolEntry[],
  query: string,
  limit: number,
): Array<{ name: string; description: string; score: number }> {
  const index = new Bm25Index(
    catalog.map((entry) => ({ id: entry.registryName, text: entry.searchText })),
  );
  const hits = index.search(query, limit);
  const byName = new Map(catalog.map((e) => [e.registryName, e]));

  return hits
    .map((hit) => {
      const entry = byName.get(hit.id);
      if (!entry || !isFunctionTool(entry.tool)) return null;
      return {
        name: entry.registryName,
        description: entry.tool.function.description ?? "",
        score: Math.round(hit.score * 1000) / 1000,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v != null);
}

export function describeDeferredTool(
  catalog: DeferredToolEntry[],
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
  catalog: DeferredToolEntry[],
  rawName: string,
): DeferredToolEntry | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  const direct = catalog.find((e) => e.registryName === trimmed);
  if (direct) return direct;

  const apiNormalized = trimmed.replace(/\./g, "_");
  return (
    catalog.find((e) => e.registryName.replace(/\./g, "_") === apiNormalized) ??
    catalog.find((e) => e.registryName === apiNormalized) ??
    null
  );
}
