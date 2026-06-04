import type { SubAgentType } from "./master-agent-types.js";

/** 各子 Agent 均可用的 clock 工具（注册名）。 */
export const SUBAGENT_SHARED_REGISTRY_TOOLS = [
  "clock.get_current_time",
  "clock.get_date",
  "clock.get_user_location",
  "clock.format_timestamp",
] as const;

/**
 * 各子 Agent 可用的宿主工具注册名（精确列表，须与 ChatCompletionTool.function.name 一致）。
 * life / general 由 coordinator 动态填充，不在此表。
 */
export const SUB_AGENT_TOOL_ALLOWLISTS: Partial<Record<SubAgentType, readonly string[]>> = {
  info: [
    "search_web",
    "fetch_web",
    "info.search",
    "info.read_webpage",
    "info.inspect_webpage",
    "info.navigate_site",
    "shopping.suggest",
    "budget.calculate",
    "browser.session.list",
    "browser.fetch_page",
    "desktop.visual.screenshot",
    "desktop.visual.run_task",
  ],
  creative: [
    "search_web",
    "fetch_web",
    "info.search",
    "info.read_webpage",
    "info.inspect_webpage",
    "info.navigate_site",
    "shopping.suggest",
    "weather.get_local",
    "care.get_important_dates",
    "self.list_custom_skills",
    "self.create_skill",
    "self.update_skill",
    "self.generate_skill",
    "self.generate_from_example",
    "self.generate_tool_template",
    "self.analyze_capabilities",
  ],
  tech: [
    "desktop.visual.screenshot",
    "desktop.visual.run_task",
    "vision.http_pull",
    "vision.periodic_start",
    "vision.periodic_stop",
    "vision.periodic_list",
    "self.list_custom_skills",
    "self.analyze_capabilities",
    "self.create_skill",
    "self.update_skill",
    "self.generate_skill",
    "self.generate_from_example",
    "self.generate_tool_template",
    "search_web",
    "fetch_web",
  ],
  security: [
    "wallet.get_balance",
    "wallet.get_transactions",
    "agent.query_capabilities",
  ],
};

export function getSubAgentToolAllowlist(type: SubAgentType): readonly string[] | null {
  if (type === "life") return null;
  return SUB_AGENT_TOOL_ALLOWLISTS[type] ?? [];
}

export function buildSubAgentAllowedRegistryNames(
  type: SubAgentType,
  dynamicTools: readonly string[],
  taskText = "",
  lifeFilter?: (tools: readonly string[], taskText: string) => string[],
): Set<string> {
  const shared = [...SUBAGENT_SHARED_REGISTRY_TOOLS];
  if (type === "life") {
    const filtered = lifeFilter ? lifeFilter(dynamicTools, taskText) : [...dynamicTools];
    return new Set([...shared, ...filtered]);
  }
  const explicit = getSubAgentToolAllowlist(type) ?? [];
  return new Set([...shared, ...explicit]);
}
