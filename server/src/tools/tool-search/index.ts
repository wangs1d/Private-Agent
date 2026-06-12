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
  const deferredCatalog = buildDeferredCatalog(deferred);
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

export {
  CORE_TOOL_LIBRARY,
  classifyToolExposureTier,
  isCoreToolRegistryName,
  isMasterAgentBuiltinTool,
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
