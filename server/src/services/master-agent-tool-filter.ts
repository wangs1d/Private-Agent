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
 * 主 Agent 基本工具白名单。
 * 原则：主 agent 只拥有基本能力，复杂操作委派给专业子 agent。
 */
const MASTER_BASIC_TOOL_NAMES = new Set([
  "clock.get_current_time",
  "clock.get_date",
  "clock.get_user_location",
  "clock.format_timestamp",
  "weather.get_local",
  "calendar.create_from_text",
  "calendar.create_task",
  "calendar.list_tasks",
  "calendar.delete_task",
  "search_web",
  "fetch_web",
  "wallet.get_balance",
  "wallet.get_transactions",
  "phone.ensure_my_number",
  "phone.virtual_call",
  "phone.call_user",
  "agent.link.list_friends",
  "agent.link.list_friend_requests",
  "agent.link.send_friend_request",
  "agent.link.respond_friend_request",
  "agent.send_to_peer",
  "agent.register_account",
  "agent.query_capabilities",
  "care.set_important_date",
  "care.get_important_dates",
  "care.delete_important_date",
  "budget.calculate",
  "reminder.plan",
  "protocol.unified.quota_adjust",
  "protocol.unified.memory_patch",
  "protocol.unified.memory_get",
  "protocol.unified.human_directive",
  "protocol.unified.governance_probe",
  "aip.dispatch",
  "aip.list_my_state",
  "aip.get_proposal",
  "self.list_custom_skills",
]);

/**
 * 主 Agent 基本工具过滤 — 只保留基础能力。
 * 排除：life 专有 (wallet.write/desktop/video游戏)
 *       tech 专有 (vision/self.write)
 *       creative 专有 (info.deep/shopping)
 */
function filterMasterBasicTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return tools.filter((t) => {
    if (t.type !== "function" || !t.function?.name) return false;
    return MASTER_BASIC_TOOL_NAMES.has(t.function.name);
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
 * 主 Agent 对话工具：仅基本工具 + 子 Agent 委派。
 * 复杂操作（钱包写/桌面操控/深度RPA/专业创作）必须通过子 agent 完成。
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
