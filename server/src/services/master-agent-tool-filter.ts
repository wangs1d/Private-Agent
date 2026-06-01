import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildMasterSubAgentDelegateChatTools } from "../agent/master-subagent-delegate-tools.js";
import { getBuiltinAgentChatTools } from "../external-model/openai-compatible-tool-loop.js";
import { isMasterAgentBuiltinTool } from "../tools/tool-search/core-tool-library.js";
import type { SubAgentCapability } from "./master-agent-types.js";
import { filterLifeCapabilityTools } from "./subagent-life-tool-filter.js";
import {
  buildSubAgentAllowedRegistryNames,
  SUBAGENT_SHARED_REGISTRY_TOOLS,
} from "./subagent-chat-tool-allowlists.js";

export { isMasterAgentBuiltinTool } from "../tools/tool-search/core-tool-library.js";
export { SUBAGENT_SHARED_REGISTRY_TOOLS };

export function filterChatToolsByRegistryNames(
  tools: ChatCompletionTool[],
  allowedRegistryNames: ReadonlySet<string>,
): ChatCompletionTool[] {
  return tools.filter((t) => {
    if (t.type !== "function" || !t.function?.name) return false;
    return allowedRegistryNames.has(t.function.name);
  });
}

/**
 * 主 Agent 基本工具过滤 — 白名单来自 {@link isMasterAgentBuiltinTool}（核心工具库单一数据源）。
 * 排除：life 专有写操作、tech 视觉/桌面、creative 深度 RPA 等延迟目录工具。
 * 保留：核心库中的日程/通讯/游戏/具身；`master.*` 委派工具由下方单独追加。
 */
function filterMasterBasicTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return tools.filter((t) => {
    if (t.type !== "function" || !t.function?.name) return false;
    return isMasterAgentBuiltinTool(t.function.name);
  });
}

/**
 * 按子 Agent 能力白名单生成 LLM tools（显式 allowlist + 共享 clock）。
 * life 类型会按 taskText 二次过滤。
 */
export function buildSubAgentChatTools(
  capability: SubAgentCapability,
  taskText = "",
  chatToolsExtra: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  const allowed = buildSubAgentAllowedRegistryNames(
    capability.type,
    capability.tools,
    taskText,
    filterLifeCapabilityTools,
  );
  const builtins = filterChatToolsByRegistryNames(getBuiltinAgentChatTools(), allowed);
  const extra = filterChatToolsByRegistryNames(chatToolsExtra, allowed);
  const merged = [...builtins, ...extra];
  if (merged.length > 0) return merged;

  return filterChatToolsByRegistryNames(
    getBuiltinAgentChatTools(),
    new Set([...SUBAGENT_SHARED_REGISTRY_TOOLS, "search_web", "fetch_web"]),
  );
}

/**
 * 主 Agent 对话工具：核心库内置 + 子 Agent 委派。
 * 复杂操作（钱包写/桌面操控/深度 RPA/专业创作）在延迟目录，须委派子 agent。
 */
export function buildMasterAgentChatTools(
  capabilities: Iterable<SubAgentCapability>,
  chatToolsExtra: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  return [
    ...filterMasterBasicTools(getBuiltinAgentChatTools()),
    ...buildMasterSubAgentDelegateChatTools(capabilities),
    ...chatToolsExtra,
  ];
}
