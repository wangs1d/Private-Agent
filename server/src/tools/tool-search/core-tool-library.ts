import {
  MASTER_INVOKE_SUB_AGENT_REGISTRY,
  MASTER_LIST_SUB_AGENTS_REGISTRY,
  MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
} from "../../agent/master-subagent-delegate-tools.js";

/**
 * 核心工具库：与「延迟工具目录」分离，每轮直接注入 LLM `tools` 列表。
 *
 * - **essential**：时间、联网、能力查询、子 Agent 委派（几乎每轮都可能用到）
 * - **dialogue**：主对话高频（日程/通讯/只读钱包/关怀/协议等）
 * - **embodiment / games**：按前缀整族暴露，避免中文检索与多轮桥接
 *
 * 未列入核心库的工具进入 BM25 延迟目录，经 `tool_discover` + `tool_call` 按需加载。
 *
 * **主 Agent** 内置工具与核心库对齐（见 {@link isMasterAgentBuiltinTool}）；
 * `master.*` 委派工具由 `buildMasterSubAgentDelegateChatTools` 单独注入，不在此判定内。
 */
export const CORE_TOOL_LIBRARY = {
  essential: {
    label: "会话基础设施",
    names: [
      "clock.get_current_time",
      "clock.get_user_location",
      "clock.get_date",
      "clock.format_timestamp",
      "agent.query_capabilities",
      MASTER_INVOKE_SUB_AGENT_REGISTRY,
      MASTER_LIST_SUB_AGENTS_REGISTRY,
      MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
      "search_web",
      "fetch_web",
      "browser.session.list",
      "weather.get_local",
    ],
  },
  dialogue: {
    label: "主对话高频",
    names: [
      "calendar.create_from_text",
      "calendar.create_task",
      "calendar.list_tasks",
      "calendar.delete_task",
      "reminder.plan",
      "phone.ensure_my_number",
      "phone.virtual_call",
      "phone.call_user",
      "agent.send_to_peer",
      "agent.register_account",
      "budget.calculate",
      "shopping.suggest",
      "self.list_custom_skills",
    ],
    prefixes: [
      "calendar.",
      "phone.",
      "agent.link.",
      "care.",
      "wallet.get_",
      "protocol.unified.",
      "aip.",
    ],
  },
  embodiment: {
    label: "具身身体",
    prefixes: ["embodiment."],
  },
  games: {
    label: "游戏大厅",
    prefixes: [
      "gomoku.",
      "world.gomoku.",
      "world.doudizhu.",
      "world.zhajinhua.",
      "world.blackjack.",
      "world.game_center.",
    ],
  },
  desktop: {
    label: "桌面截图与键鼠",
    prefixes: ["desktop.visual."],
  },
  browser: {
    label: "电商 Cookie 读价",
    prefixes: ["browser."],
  },
  mcp: {
    label: "MCP 外部工具（动态注册）",
    prefixes: ["mcp."],
  },
} as const;

const CORE_EXACT_NAMES = new Set<string>([
  ...CORE_TOOL_LIBRARY.essential.names,
  ...CORE_TOOL_LIBRARY.dialogue.names,
]);

const CORE_PREFIXES: readonly string[] = [
  ...CORE_TOOL_LIBRARY.dialogue.prefixes,
  ...CORE_TOOL_LIBRARY.embodiment.prefixes,
  ...CORE_TOOL_LIBRARY.games.prefixes,
  ...CORE_TOOL_LIBRARY.desktop.prefixes,
  ...CORE_TOOL_LIBRARY.browser.prefixes,
  "master.",
];

/** 主 Agent 过滤用：与核心库一致，但不包含 master.*（委派工具另附）。 */
const MASTER_AGENT_EXCLUDED_PREFIXES: readonly string[] = ["master."];

export type ToolExposureTier = "core" | "deferred";

export function classifyToolExposureTier(registryName: string): ToolExposureTier {
  return isCoreToolRegistryName(registryName) ? "core" : "deferred";
}

export function isCoreToolRegistryName(name: string): boolean {
  if (CORE_EXACT_NAMES.has(name)) return true;
  return CORE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * 主 Agent 内置 builtin 工具判定（单一数据源：{@link CORE_TOOL_LIBRARY}）。
 * 用于 `filterMasterBasicTools`；`master.invoke_sub_agent` 等由委派模块单独追加。
 */
export function isMasterAgentBuiltinTool(registryName: string): boolean {
  if (MASTER_AGENT_EXCLUDED_PREFIXES.some((p) => registryName.startsWith(p))) {
    return false;
  }
  return isCoreToolRegistryName(registryName);
}

/** @deprecated 使用 {@link isCoreToolRegistryName}；保留别名供旧 import。 */
export const isToolSearchCoreRegistryName = isCoreToolRegistryName;

export const TOOL_SEARCH_CORE_REGISTRY_NAMES = CORE_EXACT_NAMES;

export const TOOL_SEARCH_CORE_REGISTRY_PREFIXES = CORE_PREFIXES;

export function summarizeCoreToolLibrary(): {
  exactNameCount: number;
  prefixCount: number;
  tierLabels: string[];
} {
  return {
    exactNameCount: CORE_EXACT_NAMES.size,
    prefixCount: CORE_PREFIXES.length,
    tierLabels: [
      CORE_TOOL_LIBRARY.essential.label,
      CORE_TOOL_LIBRARY.dialogue.label,
      CORE_TOOL_LIBRARY.embodiment.label,
      CORE_TOOL_LIBRARY.games.label,
      CORE_TOOL_LIBRARY.desktop.label,
    ],
  };
}
