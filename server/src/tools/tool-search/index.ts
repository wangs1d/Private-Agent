import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildToolSearchBridgeTools } from "./bridge-tools.js";
import {
  buildDeferredCatalog,
  shouldActivateToolSearch,
  splitCoreAndDeferredTools,
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

/**
 * 核心工具库 + 延迟目录：核心工具直接暴露；其余工具 BM25 索引，经合并桥接按需加载。
 */
export function prepareToolsWithToolSearch(allTools: ChatCompletionTool[]): ToolSearchPreparedTurn {
  const cfg = getToolSearchConfig();
  const { core, deferred } = splitCoreAndDeferredTools(allTools);
  const deferredCatalog = buildDeferredCatalog(deferred);
  const active = shouldActivateToolSearch(
    deferred,
    cfg.enabled,
    cfg.thresholdPct,
    cfg.contextTokens,
  );

  if (!active) {
    return {
      visibleTools: allTools,
      deferredCatalog: buildDeferredCatalog([]),
      toolSearchActive: false,
      coreToolCount: allTools.length,
      deferredToolCount: 0,
    };
  }

  const bridgeTools = buildToolSearchBridgeTools(deferredCatalog.entries.length, cfg.bridgeMode);
  return {
    visibleTools: [...core, ...bridgeTools],
    deferredCatalog,
    toolSearchActive: true,
    coreToolCount: core.length,
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
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
export { executeToolSearchBridge, type ToolSearchBridgeResult } from "./handlers.js";
