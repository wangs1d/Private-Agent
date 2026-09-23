/**
 * 静态双车道 Core 工具清单（2026-09-19 架构级工具暴露改造）。
 *
 * 根源问题：旧架构里"模型每轮看到哪些工具"由三个动态层叠加决定——
 * contextual 按关键词逐工具裁剪、前台 4 工具白名单 + 能力域关键词临时注入、
 * 任务面 per-turn LLM planner——同一输入每轮算出的可见集不同，行为不可复现，
 * 且每轮重算打爆前缀缓存。主流 agent（Claude Code / OpenAI Agents SDK / Manus）
 * 的稳定来自"选一种暴露模式然后不动"。
 *
 * 本模块是新的唯一事实源：
 *   - chat 车道：CHAT_LANE_CORE_NAMES 静态常驻（感知只读 + 单步轻动作 + 控制工具）
 *   - task 车道：TASK_LANE_CORE_NAMES 静态常驻 + 路由能力束（Tier-2 确定性增量注入）
 *   - 其余工具全部进延迟目录，经 tool_discover / tool_call / tool_request 到达
 *
 * 回滚：AGENT_TOOL_ARCH=legacy 恢复旧路径（见 isStaticToolArchEnabled）。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type LaneId = "chat" | "task";

/** 架构开关：默认静态双车道；AGENT_TOOL_ARCH=legacy 回退旧暴露链路。 */
export function isStaticToolArchEnabled(): boolean {
  const raw = process.env.AGENT_TOOL_ARCH?.trim().toLowerCase();
  return raw !== "legacy";
}

/**
 * chat 车道静态 Core。准入规则：感知类（只读）+ 单步轻动作（低副作用）+
 * 控制工具。写操作（转账/下单/智能家居控制）与多步流程（浏览器/代码/桌面）
 * 一律不进——安全边界，不只是省 token。
 *
 * 按名解析自注册表，注册表缺失的工具自动跳过（生产/测试环境差异容错）。
 * brain.recall 由 setMemoryChatTools 在 bootstrap 注入，测试环境缺省属正常。
 */
export const CHAT_LANE_CORE_NAMES: readonly string[] = [
  // 时间/位置（感知）
  "clock.get_current_time",
  "clock.get_user_location",
  // 联网信息（只读）
  "search_web",
  "fetch_web",
  "search_images",
  "search_videos",
  "hot_rankings",
  // 日程/提醒（轻动作）
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.list_tasks",
  // 通讯（轻动作）
  "phone.ensure_my_number",
  "messages.overview",
  "messages.reply",
  "agent.send_to_peer",
  // 记忆（感知）
  "brain.recall",
  // 持续感知回溯（只读，2026-09-19 P0-1）
  "perception.overview",
  // 自我/能力（模型自救入口）
  "agent.query_capabilities",
  "self.list_custom_skills",
  // 钱（只读）
  "wallet.get_balance",
  "wallet.get_transactions",
  // 表达/控制
  "surface.show",
  // 重活逃生门（委派后台）+ 委派闭环（查询/取消，2026-09-19 P0-2）
  "task.dispatch",
  "task.status",
  "task.cancel",
];

/**
 * task 车道静态 Core：在 chat Core 基础上替换进执行主力（深网/桌面/代码）。
 * 长尾（购物订单、智能家居、财务域、vision.periodic_* 等）留在延迟目录。
 */
export const TASK_LANE_CORE_NAMES: readonly string[] = [
  // 搜索全档
  "search_web",
  "fetch_web",
  "deep_search",
  "search_images",
  "search_videos",
  "hot_rankings",
  "internet.research",
  // 深读/站点导航
  "info.inspect_webpage",
  "info.navigate_site",
  "browser.session.list",
  // 感知
  "clock.get_current_time",
  "clock.get_user_location",
  "weather.get_local",
  // 日程/提醒
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.list_tasks",
  // 通讯
  "messages.overview",
  "messages.reply",
  "agent.send_to_peer",
  // 桌面（桥/本机视觉离线时由调用方过滤）
  "desktop.visual.screenshot",
  // 代码沙箱（self-programming 注册，缺失自动跳过）
  "code.run",
  "code.write_file",
  "code.read_file",
  // 记忆/能力
  "brain.recall",
  "agent.query_capabilities",
  "self.list_custom_skills",
  // 持续感知回溯（只读，2026-09-19 P0-1）
  "perception.overview",
  // 钱（只读）
  "wallet.get_balance",
  "wallet.get_transactions",
  // ObservationPack 读回（压缩补偿，常驻才有意义）
  "obs_recall",
  // 元工具桥 + 逃生门 + 委派闭环（2026-09-19 P0-2）
  "tool_discover",
  "tool_call",
  "task.dispatch",
  "task.status",
  "task.cancel",
];

/**
 * chat 车道保留完整 schema 的高频工具；其余 Core 工具做 schema 瘦身。
 * 瘦身 = description 压到首句（≤120 字符）+ 丢弃字段级描述；schema 仍在
 * tools 数组中（零往返直调），只是写得短——与"菜单式隐藏 schema"（需一次
 * discover 往返）有本质区别，后者已论证在 Core 规模下不划算。
 */
const CHAT_FULL_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  "task.dispatch",
  "task.status",
  "task.cancel",
  "search_web",
  "reminder.plan",
  "calendar.create_from_text",
  "clock.get_current_time",
  "messages.reply",
]);

/** task 车道 schema 全保留（仅 core 模式回滚时使用；router-first 下不进 prompt）。 */
const TASK_FULL_SCHEMA_NAMES: ReadonlySet<string> | null = null;

/**
 * task 车道暴露模式（2026-09-23 token 优化）：router-first（默认）。
 *
 * 背景：task Core 36 个全量 schema ≈ 5.1k token/轮，占 light 档单次输入
 * （API 实测均值 8.2k）的一半以上，而 light 档 2-3 波的编排深度根本用不满
 * 36 个工具。router-first 下可见集只留桥工具（tool_discover/tool_call 由
 * prepareToolsWithToolSearch 自动注入），全量语料进 BM25 延迟目录按需召回；
 * 质量护栏：意图预召回（top-1 高置信工具免 discover 直转正）+ <tool_request>
 * 请求卡 + 高频调用自动晋升（PROMOTE_THRESHOLD=3）。chat 车道不受影响。
 *
 * 回滚：AGENT_TASK_LANE=core 恢复静态 Core 全量注入。
 */
export function isTaskLaneRouterFirst(): boolean {
  const raw = process.env.AGENT_TASK_LANE?.trim().toLowerCase();
  return raw !== "core";
}

function firstSentence(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const m = /^.{1,200}?[。！？.!?\n]/.exec(trimmed);
  const head = m ? m[0] : trimmed;
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

/** 确定性 schema 瘦身：同输入恒同输出，不引入任何每轮变化。 */
export function slimToolSchema(tool: ChatCompletionTool): ChatCompletionTool {
  if (tool.type !== "function") return tool;
  const fn = tool.function;
  const slimParams = (() => {
    const params = fn.parameters as
      | { type?: string; properties?: Record<string, unknown>; required?: unknown }
      | undefined;
    if (!params || typeof params !== "object" || !params.properties) return fn.parameters;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params.properties)) {
      if (value && typeof value === "object" && "description" in (value as Record<string, unknown>)) {
        const { description: _drop, ...rest } = value as Record<string, unknown>;
        properties[key] = rest;
      } else {
        properties[key] = value;
      }
    }
    return { ...params, properties };
  })();
  return {
    type: "function",
    function: {
      ...fn,
      description: firstSentence(fn.description ?? "", 120),
      parameters: slimParams,
    },
  };
}

export function dedupeToolsByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

/**
 * 按静态清单解析车道 Core 工具。extraDefinitions 用于注册表外单独注入的
 * 定义（如 task.dispatch 在 agent-core 晚绑定）。清单外工具一律不进。
 */
export function buildLaneCoreTools(
  lane: LaneId,
  source: ChatCompletionTool[],
  extraDefinitions: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  const names = lane === "chat" ? CHAT_LANE_CORE_NAMES : TASK_LANE_CORE_NAMES;
  const wanted = new Set<string>(names);
  const pool = [...source, ...extraDefinitions];
  const resolved: ChatCompletionTool[] = [];
  for (const tool of pool) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || !wanted.has(name)) continue;
    const fullSchema =
      lane === "chat"
        ? CHAT_FULL_SCHEMA_NAMES.has(name)
        : TASK_FULL_SCHEMA_NAMES === null || TASK_FULL_SCHEMA_NAMES.has(name);
    resolved.push(fullSchema ? tool : slimToolSchema(tool));
  }
  return dedupeToolsByName(resolved);
}

/**
 * 能力束 → 工具名/命名空间前缀映射（Tier-2 确定性增量注入）。
 * 由路由层 TurnPlan.capabilities 驱动——同一声明恒同一集合，属于"路由决策
 * 的确定性投影"，不是按 userText 关键词的每轮重算。自 resolve-chat-tools
 * 迁移至此作为唯一事实源。
 */
export const CAPABILITY_TOOL_PREFIXES: Record<string, string[]> = {
  search: [
    "search_web",
    "search",
    "fetch_web",
    "deep_search",
    "hot_rankings",
    "info.",
    "weather.",
    "clock.",
  ],
  media: ["search_images", "search_videos", "photo", "vision.", "media", "image"],
  write: [
    "calendar.",
    "reminder",
    "voice.",
    "phone.",
    "shopping.",
    "commitment.",
    "wallet.",
    "agent.",
    "surface.",
    // 设备/家电控制是有副作用的写动作（2026-09-19 live 验证补充）：
    // "把空调调到26度"路由到 task 面 write 束时，smart_home 必须确定性可达。
    "smart_home.",
  ],
  desktop: ["desktop", "agent_browser", "shared_browser", "screen"],
};

/** 元工具/能力查询桥：任何集合都保留，保证延迟目录可达。 */
export const CAPABILITY_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "tool_call",
  "agent.query_capabilities",
]);

export function toolMatchesCapability(toolName: string, capability: string): boolean {
  const prefixes = CAPABILITY_TOOL_PREFIXES[capability];
  if (!prefixes) return false;
  return prefixes.some((p) => toolName === p || toolName.startsWith(p));
}

/**
 * Tier-2：从语料中取出路由能力束覆盖的工具（增量注入用，不做减法）。
 * capabilities 含 "full" 或为空时返回空数组（Core 已够，不扩）。
 */
export function toolsMatchingCapabilityBeam(
  corpus: ChatCompletionTool[],
  capabilities: string[] | undefined,
): ChatCompletionTool[] {
  const caps = (capabilities ?? []).map((c) => c?.trim()).filter(Boolean);
  if (caps.length === 0 || caps.includes("full")) return [];
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of corpus) {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    if (!name || seen.has(name)) continue;
    if (CAPABILITY_BRIDGE_TOOLS.has(name)) continue;
    if (caps.some((cap) => toolMatchesCapability(name, cap))) {
      seen.add(name);
      out.push(tool);
    }
  }
  return out;
}
