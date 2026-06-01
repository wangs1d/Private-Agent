export {
  CORE_TOOL_LIBRARY,
  TOOL_SEARCH_CORE_REGISTRY_NAMES,
  TOOL_SEARCH_CORE_REGISTRY_PREFIXES,
  classifyToolExposureTier,
  isCoreToolRegistryName,
  isMasterAgentBuiltinTool,
  isToolSearchCoreRegistryName,
  summarizeCoreToolLibrary,
  type ToolExposureTier,
} from "./core-tool-library.js";

/** 桥接工具注册名（merged=2 枚；legacy=三件套，仍可在执行层解析）。 */
export const TOOL_SEARCH_BRIDGE_MERGED = ["tool_discover", "tool_call"] as const;

export const TOOL_SEARCH_BRIDGE_LEGACY = ["tool_search", "tool_describe", "tool_call"] as const;

export const TOOL_SEARCH_BRIDGE_REGISTRY_NAMES = new Set<string>([
  ...TOOL_SEARCH_BRIDGE_MERGED,
  ...TOOL_SEARCH_BRIDGE_LEGACY,
  "tool_resolve",
]);

export function isToolSearchBridgeName(name: string): boolean {
  return TOOL_SEARCH_BRIDGE_REGISTRY_NAMES.has(name);
}
