import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { getBuiltinAgentChatTools } from "../external-model/openai-compatible-tool-loop.js";

/** 各子 Agent 均可用的基础工具（注册名，带点号） */
export const SUBAGENT_SHARED_REGISTRY_TOOLS = [
  "clock.get_current_time",
  "clock.get_date",
] as const;

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
 * 按子 Agent 能力白名单生成 LLM tools（仅暴露 capability.tools + 共享 clock）。
 */
export function buildSubAgentChatTools(
  capabilityToolNames: readonly string[],
  chatToolsExtra: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  const allowed = new Set<string>([
    ...SUBAGENT_SHARED_REGISTRY_TOOLS,
    ...capabilityToolNames,
  ]);
  const builtins = filterChatToolsByRegistryNames(getBuiltinAgentChatTools(), allowed);
  const extra = filterChatToolsByRegistryNames(chatToolsExtra, allowed);
  const merged = [...builtins, ...extra];
  if (merged.length > 0) return merged;
  return filterChatToolsByRegistryNames(
    getBuiltinAgentChatTools(),
    new Set([...SUBAGENT_SHARED_REGISTRY_TOOLS, "search_web"]),
  );
}
