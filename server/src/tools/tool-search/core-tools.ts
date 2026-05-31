import { MASTER_INVOKE_SUB_AGENT_REGISTRY, MASTER_POLL_SUB_AGENT_TASKS_REGISTRY } from "../../agent/master-subagent-delegate-tools.js";

/**
 * 高频核心工具：始终直接暴露给模型，不参与延迟加载（对齐 Hermes _HERMES_CORE_TOOLS）。
 */
export const TOOL_SEARCH_CORE_REGISTRY_NAMES = new Set<string>([
  "clock.get_current_time",
  "clock.get_user_location",
  "clock.get_date",
  "clock.format_timestamp",
  "agent.query_capabilities",
  MASTER_INVOKE_SUB_AGENT_REGISTRY,
  MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
  "search_web",
  "fetch_web",
  "weather.get_local",
  "calendar.create_from_text",
  "calendar.create_task",
  "calendar.list_tasks",
  "phone.ensure_my_number",
  "embodiment.observe",
  "embodiment.window_place",
  "embodiment.set_state",
  "embodiment.move",
  "embodiment.roam",
]);

export const TOOL_SEARCH_BRIDGE_REGISTRY_NAMES = new Set<string>([
  "tool_search",
  "tool_describe",
  "tool_call",
]);

export function isToolSearchBridgeName(name: string): boolean {
  return TOOL_SEARCH_BRIDGE_REGISTRY_NAMES.has(name);
}
