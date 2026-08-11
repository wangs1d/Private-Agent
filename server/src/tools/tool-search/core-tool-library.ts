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
      "internet.research",
      "internet.live_check",
      "internet.verify",
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
      "voice.",
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
  /**
   * Fast 模式工具分组：只读查询 + 轻量交互（TTS 推送/号码查询）。
   * 新增工具时声明到此分组即可自动被 Fast 模式收编，无需改其他代码。
   * 未声明的工具默认走 Complex 模式（全量工具集 + tool search 桥接）。
   *
   * 2026-08-03 修复：fastLane 原本只有只读的 calendar.list_tasks，用户设置提醒
   * 被路由到 fast 模式时 LLM 看不到任何创建工具 → 只能口头答应"已设置"却未真正写入日程。
   * 把 reminder.plan / calendar.create_from_text / calendar.create_task / calendar.delete_task
   * 加入 fastLane：设置/删除提醒是轻量交互，fast 模式可直接落地（工具执行后走 summary 兜底生成回复）。
   */
  fastLane: {
    label: "Fast 模式轻量工具",
    names: [
      "clock.get_current_time",
      "clock.get_user_location",
      "clock.get_date",
      "clock.format_timestamp",
      "weather.get_local",
      "calendar.list_tasks",
      "calendar.create_from_text",
      "calendar.create_task",
      "calendar.delete_task",
      "reminder.plan",
      "internet.research",
      "internet.live_check",
      "internet.verify",
      "search_web",
      "fetch_web",
      "browser.session.list",
      "agent.query_capabilities",
      "phone.ensure_my_number",
      "phone.virtual_call",
      "phone.call_user",
      "voice.speak",
      "voice.send_message",
      "voice.transcribe",
      "budget.calculate",
      "shopping.suggest",
      "self.list_custom_skills",
    ],
    prefixes: ["clock."],
  },
} as const;

const CORE_EXACT_NAMES = new Set<string>([
  ...CORE_TOOL_LIBRARY.essential.names,
  ...CORE_TOOL_LIBRARY.dialogue.names,
]);

const CORE_PREFIXES: readonly string[] = [
  ...CORE_TOOL_LIBRARY.dialogue.prefixes,
  ...CORE_TOOL_LIBRARY.embodiment.prefixes,
  ...CORE_TOOL_LIBRARY.desktop.prefixes,
  ...CORE_TOOL_LIBRARY.browser.prefixes,
  "master.",
];

// ---- Fast 模式工具判定（单一数据源：CORE_TOOL_LIBRARY.fastLane + 动态名单） ----

const FAST_LANE_EXACT_NAMES = new Set<string>(CORE_TOOL_LIBRARY.fastLane.names);
const FAST_LANE_PREFIXES: readonly string[] = CORE_TOOL_LIBRARY.fastLane.prefixes;

/**
 * 动态 fastLane 工具名名单。
 *
 * 用于自我进化（EvolutionCortex + SkillGenerator）生成的动态 Skill：
 * 装载后若 SkillMetadata.tags 包含 "fast_lane"（或 "fast"），则把 skill 名
 * 注册到此集合，isFastLaneTool 即对其返回 true，自动被 Fast 模式收编。
 *
 * 与静态 CORE_TOOL_LIBRARY.fastLane 并列，互不影响：
 *  - 静态名单：编译期确定的内置工具
 *  - 动态名单：运行时自我进化生成的轻量查询类 Skill
 */
const _dynamicFastLaneNames = new Set<string>();

/** 注册一个动态 fastLane 工具名（自我进化装载 Skill 后调用） */
export function registerDynamicFastLaneName(name: string): void {
  if (name) _dynamicFastLaneNames.add(name);
}

/** 批量注册动态 fastLane 工具名 */
export function registerDynamicFastLaneNames(names: string[]): void {
  for (const n of names) {
    if (n) _dynamicFastLaneNames.add(n);
  }
}

/** 清空动态 fastLane 名单（卸载 Skill / 测试重置时调用） */
export function clearDynamicFastLaneNames(): void {
  _dynamicFastLaneNames.clear();
}

/** 返回当前动态 fastLane 名单快照（调试/自省用） */
export function listDynamicFastLaneNames(): string[] {
  return Array.from(_dynamicFastLaneNames);
}

/**
 * 判断工具是否属于 Fast 模式工具集。
 *
 * 判定优先级：
 *  1. 静态名单 {@link CORE_TOOL_LIBRARY}.fastLane（编译期内置工具）
 *  2. 动态名单 {@link _dynamicFastLaneNames}（自我进化生成的轻量 Skill）
 *
 * 新增内置工具时在 CORE_TOOL_LIBRARY.fastLane 里声明即可自动收编；
 * 自我进化生成的 Skill 通过 registerDynamicFastLaneName() 注册后自动收编。
 */
export function isFastLaneTool(registryName: string): boolean {
  if (FAST_LANE_EXACT_NAMES.has(registryName)) return true;
  if (FAST_LANE_PREFIXES.some((p) => registryName.startsWith(p))) return true;
  if (_dynamicFastLaneNames.has(registryName)) return true;
  return false;
}

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
      CORE_TOOL_LIBRARY.desktop.label,
    ],
  };
}
