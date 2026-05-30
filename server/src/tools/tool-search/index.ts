import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildToolSearchBridgeTools } from "./bridge-tools.js";
import {
  buildDeferredCatalog,
  shouldActivateToolSearch,
  splitCoreAndDeferredTools,
  type DeferredToolEntry,
} from "./catalog.js";
import { TOOL_SEARCH_CORE_REGISTRY_NAMES } from "./core-tools.js";
import { getToolSearchConfig } from "./env.js";

export type ToolSearchPreparedTurn = {
  visibleTools: ChatCompletionTool[];
  deferredCatalog: DeferredToolEntry[];
  toolSearchActive: boolean;
};

/**
 * Hermes 风格渐进式工具披露：核心工具 + 桥接三件套直接暴露，其余工具进入 BM25 目录按需加载。
 */
export function prepareToolsWithToolSearch(allTools: ChatCompletionTool[]): ToolSearchPreparedTurn {
  const cfg = getToolSearchConfig();
  const { core, deferred } = splitCoreAndDeferredTools(allTools, TOOL_SEARCH_CORE_REGISTRY_NAMES);
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
      deferredCatalog: [],
      toolSearchActive: false,
    };
  }

  const bridgeTools = buildToolSearchBridgeTools(deferredCatalog.length);
  return {
    visibleTools: [...core, ...bridgeTools],
    deferredCatalog,
    toolSearchActive: true,
  };
}

export {
  TOOL_SEARCH_CORE_REGISTRY_NAMES,
  isToolSearchBridgeName,
} from "./core-tools.js";
export { executeToolSearchBridge, type ToolSearchBridgeResult } from "./handlers.js";
