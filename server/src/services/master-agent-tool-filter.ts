import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildMasterSubAgentDelegateChatTools } from "../agent/master-subagent-delegate-tools.js";
import { getBuiltinAgentChatTools } from "../external-model/openai-compatible-tool-loop.js";
import type { SubAgentCapability } from "./master-agent-types.js";
import { filterLifeCapabilityTools } from "./subagent-life-tool-filter.js";
import {
  buildSubAgentAllowedRegistryNames,
  SUBAGENT_SHARED_REGISTRY_TOOLS,
} from "./subagent-chat-tool-allowlists.js";

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
 * 按子 Agent 能力白名单生成 LLM tools（显式 allowlist + 共享 clock）。
 * life 类型会按 taskText 二次过滤；general 暴露全量内置工具。
 */
export function buildSubAgentChatTools(
  capability: SubAgentCapability,
  taskText = "",
  chatToolsExtra: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  if (capability.type === "general") {
    return [...getBuiltinAgentChatTools(), ...chatToolsExtra];
  }

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

  // 兜底：至少保留联网搜索，避免子 Agent 完全无工具
  return filterChatToolsByRegistryNames(
    getBuiltinAgentChatTools(),
    new Set([...SUBAGENT_SHARED_REGISTRY_TOOLS, "search_web", "fetch_web"]),
  );
}

/**
 * 主 Agent 对话工具：全量内置工具 + 子 Agent 委派（master_invoke_sub_agent / master_list_sub_agents）。
 */
export function buildMasterAgentChatTools(
  capabilities: Iterable<SubAgentCapability>,
  chatToolsExtra: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  return [
    ...getBuiltinAgentChatTools(),
    ...buildMasterSubAgentDelegateChatTools(capabilities),
    ...chatToolsExtra,
  ];
}
