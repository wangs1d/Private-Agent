import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { filterChatToolsByRegistryNames } from "../services/master-agent-tool-filter.js";

/** 客户端 `chat.user_message.agentAccessMode`：默认沙箱，仅 `full` 时开放高权限工具。 */
export type AgentAccessMode = "sandbox" | "full";

const FULL_ACCESS_MODE: AgentAccessMode = "full";

/** 沙箱下禁止 Agent 调用的工具（精确名）。 */
const SANDBOX_BLOCKED_EXACT = new Set<string>([
  "desktop.visual.run_task",
  "vision.periodic_start",
  "vision.periodic_stop",
  "vision.periodic_stop_all",
  "vision.periodic_list",
  "vision.http_pull",
]);

/** 沙箱下禁止的工具前缀（如 self.* 自我编程）。钱包为宿主 Agent 常规能力，沙箱下仍可用。 */
const SANDBOX_BLOCKED_PREFIXES = ["self."] as const;

export function parseAgentAccessMode(raw: unknown): AgentAccessMode {
  return raw === FULL_ACCESS_MODE ? FULL_ACCESS_MODE : "sandbox";
}

export function isSandboxMode(mode: AgentAccessMode): boolean {
  return mode !== FULL_ACCESS_MODE;
}

export function isToolAllowedInAccessMode(toolName: string, mode: AgentAccessMode): boolean {
  if (!isSandboxMode(mode)) return true;
  if (SANDBOX_BLOCKED_EXACT.has(toolName)) return false;
  return !SANDBOX_BLOCKED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function sandboxDeniedToolMessage(toolName: string): string {
  return `当前为沙箱模式，无法调用「${toolName}」。请在对话输入框开启「完全访问」后再试。`;
}

export function filterChatToolsForAccessMode(
  tools: ChatCompletionTool[],
  mode: AgentAccessMode,
): ChatCompletionTool[] {
  if (!isSandboxMode(mode)) return tools;
  const allowed = new Set<string>();
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    const name = tool.function.name;
    if (isToolAllowedInAccessMode(name, mode)) {
      allowed.add(name);
    }
  }
  return filterChatToolsByRegistryNames(tools, allowed);
}
