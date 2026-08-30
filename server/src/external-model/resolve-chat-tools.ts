import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  mergeChatToolsForAccessMode,
  parseAgentAccessMode,
  type ChatToolsAccessContext,
} from "../agent/agent-access-mode.js";
import { DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS } from "../tools/desktop-visual-chat-tools.js";
import {
  getBuiltinAgentChatTools,
  selectRelevantTools,
} from "./openai-compatible-tool-loop.js";
import type { AgentStreamOptions, ToolExposureProfile } from "./types.js";
import { estimateToolsSchemaTokens } from "../gateway/index.js";

export type ResolvedChatToolPlan = {
  visibleTools: ChatCompletionTool[];
  searchableTools: ChatCompletionTool[];
};

const _resolvedToolsCache = new Map<string, ChatCompletionTool[]>();
const MAX_RESOLVED_TOOLS_CACHE = 32;

function resolveExposureTokenBudget(profile: ToolExposureProfile): number | null {
  // 工具 schema token 预算：在工具覆盖度和 token 消耗间取平衡。
  // light 1000：简单对话只需少量工具（clock/weather/search_web）
  // contextual 2200：工具任务需覆盖主要工具类别，确保 LLM 能选对工具
  // 可通过环境变量覆盖。
  const fallback =
    profile === "light"
      ? 1000
      : profile === "contextual"
        ? 2200
        : null;
  if (fallback == null) return null;
  const envName =
    profile === "light"
      ? "AGENT_TOOL_EXPOSURE_LIGHT_TOKENS"
      : "AGENT_TOOL_EXPOSURE_CONTEXTUAL_TOKENS";
  const raw = process.env[envName]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 200 ? parsed : fallback;
}

function trimToolsToTokenBudget(
  tools: ChatCompletionTool[],
  minTools: number,
  tokenBudget: number | null,
  pinnedToolNames?: Set<string>,
): ChatCompletionTool[] {
  if (!tokenBudget || tokenBudget <= 0) return tools;
  const pinned = pinnedToolNames ?? new Set<string>();
  const out: ChatCompletionTool[] = [];
  let used = 0;
  // Pinned tools go first and keep full schema. They are NOT exempt from the
  // budget cap (spec SHALL): if a pinned tool would push the total over budget
  // it is dropped, never trimmed, so any pinned tool that remains stays intact.
  for (const tool of tools) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || !pinned.has(name)) continue;
    const delta = estimateToolsSchemaTokens([tool]);
    if (used + delta > tokenBudget) continue;
    out.push(tool);
    used += delta;
  }
  // Non-pinned tools fill the remaining budget; once minTools is reached the
  // budget is enforced strictly, otherwise the minTools guarantee still applies.
  for (const tool of tools) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (name && pinned.has(name)) continue;
    const delta = estimateToolsSchemaTokens([tool]);
    if (out.length >= minTools && used + delta > tokenBudget) continue;
    out.push(tool);
    used += delta;
  }
  return out.length > 0 ? out : tools.slice(0, Math.min(minTools, tools.length));
}

function resolvedToolsCacheKey(userText?: string, streamOpts?: AgentStreamOptions): string {
  const builtinNames = (streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools())
    .map((t) => (t.type === "function" ? t.function?.name ?? "" : t.type))
    .filter(Boolean)
    .sort()
    .join(",");
  const extraNames = (streamOpts?.chatToolsExtra ?? [])
    .map((t) => (t.type === "function" ? t.function?.name ?? "" : t.type))
    .filter(Boolean)
    .sort()
    .join(",");
  const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
  const bridge = streamOpts?.desktopBridgeOnline === true ? "1" : "0";
  const phoneBridge = streamOpts?.phoneBridgeOnline === true ? "1" : "0";
  const profile = resolveToolExposureProfile(streamOpts);
  const textKey = contextualTextKey(userText, profile);
  const rankingKey = [
    (streamOpts?.toolRankingHint?.preferredNamespaces ?? []).join(","),
    (streamOpts?.toolRankingHint?.cautiousNamespaces ?? []).join(","),
  ].join("|");
  const pinnedKey = (streamOpts?.pinnedToolNames ?? []).slice().sort().join(",");
  return `${builtinNames}|${extraNames}|${mode}|${bridge}|${phoneBridge}|${profile}|${textKey}|${rankingKey}|${pinnedKey}`;
}

function contextualTextKey(userText: string | undefined, profile: ToolExposureProfile): string {
  if (profile === "full" || profile === "delegate" || profile === "scoped" || profile === "none") {
    return "-";
  }
  const normalized = (userText ?? "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 96) || "-";
}

function resolveToolExposureProfile(streamOpts?: AgentStreamOptions): ToolExposureProfile {
  return streamOpts?.toolExposureProfile ?? "contextual";
}

function filterScopedTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const pinned = new Set((streamOpts?.pinnedToolNames ?? []).filter(Boolean));
  if (pinned.size === 0) return tools;
  const scoped = tools.filter((tool) => {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    return Boolean(name && pinned.has(name));
  });
  return scoped.length > 0 ? scoped : tools;
}

function pickNamespace(toolName: string): string {
  const idx = toolName.indexOf(".");
  if (idx > 0) return toolName.slice(0, idx);
  const underscoreIdx = toolName.indexOf("_");
  if (underscoreIdx > 0) return toolName.slice(0, underscoreIdx);
  return "misc";
}

const DESKTOP_VISUAL_PINNED_TOOLS = [
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
  // 2026-07-13：完整暴露底层桌面工具，避免 contextual 漏命中时被裁掉
  "desktop.open",
  "desktop.run_preset",
  "desktop.run_shell",
  "desktop.uia_query",
  // 2026-07-14：新增 UIA 原生控件操作 + 桌面端联网工具
  "desktop.run_automation",
  "desktop.http_get",
  "desktop.web_search",
  "desktop.web_fetch",
] as const;

/** 桥接在线或完全访问时，桌面工具不得被 contextual 筛选掉。 */
function pinDesktopVisualTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  // 2026-07-30 修复：Fast 模式（contextual 暴露策略）不注入桌面工具。
  // 否则 LLM 在简单查询（如"现在几点"）时会被 11 个桌面工具（截屏/shell/UIA/http_get）污染，
  // 倾向于调 desktop.visual.screenshot 等重路径工具而非 clock 轻量工具，
  // 导致响应慢 + 频繁触发"shell 被拦截""系统敏感文件不让读"等错误。
  // 桌面工具仅在 Complex/delegate 模式或显式 scoped 暴露时由用户主动 pin 进来。
  if (streamOpts?.toolExposureProfile === "contextual" || streamOpts?.toolExposureProfile === "light") {
    return tools;
  }
  const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
  const bridge = streamOpts?.desktopBridgeOnline === true;
  const phoneBridge = streamOpts?.phoneBridgeOnline === true;
  const fullAccess = mode === "full";
  if (!bridge && !phoneBridge && !fullAccess) return tools;

  const present = new Set(
    tools
      .map((t) => (t.type === "function" ? t.function?.name : undefined))
      .filter((n): n is string => Boolean(n)),
  );
  const allBuiltin = streamOpts?.chatToolsBuiltin ?? [];
  const extras = [...allBuiltin, ...(streamOpts?.chatToolsExtra ?? []), ...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS];
  const toAdd: ChatCompletionTool[] = [];
  for (const name of DESKTOP_VISUAL_PINNED_TOOLS) {
    if (present.has(name)) continue;
    const found = extras.find((t) => t.type === "function" && t.function.name === name);
    if (found) toAdd.push(found);
  }
  if (toAdd.length === 0) return tools;
  return [...tools, ...toAdd];
}

/**
 * 强制保留 streamOpts.pinnedToolNames 指定的工具(绕过 contextual 筛选)。
 * 从 builtin + extra + desktop-visual 定义中查找缺失的工具并补入。
 */
function pinSpecifiedTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const names = streamOpts?.pinnedToolNames;
  if (!names || names.length === 0) return tools;

  const present = new Set(
    tools
      .map((t) => (t.type === "function" ? t.function?.name : undefined))
      .filter((n): n is string => Boolean(n)),
  );
  const allBuiltin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extras = [...allBuiltin, ...(streamOpts?.chatToolsExtra ?? []), ...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS];
  const toAdd: ChatCompletionTool[] = [];
  for (const name of names) {
    if (present.has(name)) continue;
    const found = extras.find((t) => t.type === "function" && t.function?.name === name);
    if (found) toAdd.push(found);
  }
  if (toAdd.length === 0) return tools;
  return [...tools, ...toAdd];
}

/**
 * 计算当前请求中应被视作 pinned 的工具名集合（desktop 桥接/完全访问时的桌面工具
 * + streamOpts.pinnedToolNames）。与 {@link pinDesktopVisualTools} /
 * {@link pinSpecifiedTools} 的注入条件保持一致，用于在统一 token 预算核算中
 * 标记哪些工具优先保留完整 schema。
 */
function resolvePinnedToolNames(streamOpts?: AgentStreamOptions): Set<string> {
  const pinned = new Set<string>();
  // 2026-07-30 修复：Fast 模式（contextual/light 暴露策略）不把桌面工具视为 pinned。
  // 否则 token 预算核算会把 11 个桌面工具的 schema 优先保留，污染 LLM 视野。
  const isFastProfile =
    streamOpts?.toolExposureProfile === "contextual" ||
    streamOpts?.toolExposureProfile === "light";
  if (!isFastProfile) {
    const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
    const bridge = streamOpts?.desktopBridgeOnline === true;
    const phoneBridge = streamOpts?.phoneBridgeOnline === true;
    const fullAccess = mode === "full";
    if (bridge || phoneBridge || fullAccess) {
      for (const name of DESKTOP_VISUAL_PINNED_TOOLS) pinned.add(name);
    }
  }
  const names = streamOpts?.pinnedToolNames;
  if (names && names.length > 0) {
    for (const name of names) pinned.add(name);
  }
  return pinned;
}

/** 合并 pinned 工具（desktop 桥接 + 用户指定）到 contextual 选中工具列表。 */
function mergePinnedTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  return pinSpecifiedTools(pinDesktopVisualTools(tools, streamOpts), streamOpts);
}

function applyToolRankingHint(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const preferred = streamOpts?.toolRankingHint?.preferredNamespaces?.filter(Boolean) ?? [];
  const cautious = streamOpts?.toolRankingHint?.cautiousNamespaces?.filter(Boolean) ?? [];
  if (preferred.length === 0 && cautious.length === 0) return tools;
  const rank = new Map(preferred.map((ns, index) => [ns, index]));
  const cautiousSet = new Set(cautious);
  return [...tools].sort((a, b) => {
    const nameA = a.type === "function" ? a.function?.name ?? "" : "";
    const nameB = b.type === "function" ? b.function?.name ?? "" : "";
    const nsA = pickNamespace(nameA);
    const nsB = pickNamespace(nameB);
    const scoreA =
      (rank.get(nsA) ?? 1000) * 10 +
      (cautiousSet.has(nsA) ? 5 : 0);
    const scoreB =
      (rank.get(nsB) ?? 1000) * 10 +
      (cautiousSet.has(nsB) ? 5 : 0);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return nameA.localeCompare(nameB);
  });
}

function applyToolExposureProfile(
  tools: ChatCompletionTool[],
  userText: string | undefined,
  profile: ToolExposureProfile,
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  if (profile === "none") return [];
  if (profile === "full" || profile === "delegate") return tools;
  if (profile === "scoped") return filterScopedTools(tools, streamOpts);
  if (!userText?.trim()) return tools;

  // 2026-08-01 性能优化：Fast 模式工具集小（≤ 12 个）时跳过 contextual 过滤，
  // 直接全量返回。理由：contextual 过滤在 ≤12 工具时节省的 schema token 不到 500，
  // 但每次都要跑关键词提取 + 分类匹配 + 兜底补充，徒增延迟且容易裁掉对 Fast 模式
  // 重要的 weather/calendar 工具。Complex 模式走 delegate/full 不进此分支。
  if ((profile === "contextual" || profile === "light") && tools.length <= 12) {
    const merged = mergePinnedTools(tools, streamOpts);
    const budget = resolveExposureTokenBudget(profile);
    if (!budget) return merged;
    const pinnedNames = resolvePinnedToolNames(streamOpts);
    return trimToolsToTokenBudget(merged, 3, budget, pinnedNames);
  }

  // Pinned 工具（desktop 桥接 + 用户指定）必须纳入统一 token 预算核算，
  // 不得绕过 contextual 筛选与预算上限（spec SHALL）。先合并 pinned 工具到
  // contextual 选中集合，再统一过 trimToolsToTokenBudget：pinned 工具优先
  // 保留完整 schema，超预算时丢弃非 pinned 工具，pinned 仍超预算则按顺序丢弃。
  const pinnedNames = resolvePinnedToolNames(streamOpts);
  const budget = resolveExposureTokenBudget(profile);

  if (profile === "light") {
    const selected = selectRelevantTools(userText, tools, {
      minTools: 3,
      maxTools: tools.length,
      includeAlwaysIncluded: false,
      tokenBudget: budget ?? undefined,
    });
    const merged = mergePinnedTools(selected, streamOpts);
    return trimToolsToTokenBudget(merged, 3, budget, pinnedNames);
  }

  const selected = selectRelevantTools(userText, tools, {
    minTools: 4,
    maxTools: tools.length,
    includeAlwaysIncluded: true,
    tokenBudget: budget ?? undefined,
  });
  const merged = mergePinnedTools(selected, streamOpts);
  return trimToolsToTokenBudget(merged, 4, budget, pinnedNames);
}

export function resolveChatToolsForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  return resolveChatToolPlanForStream(userText, streamOpts).visibleTools;
}

/**
 * 桌面桥明确离线时，把 desktop.* 从可见工具中剔除（2026-08-29 真实链路测试发现）。
 * 桥离线的 desktop.* 是"必然执行失败的工具"——模型会优先尝试它（pinned 权重高），
 * 连续失败耗尽工具波次后才有概率回退 search_web，浪费 10s+ 延迟甚至整轮查不了。
 * 仅在 desktopBridgeOnline === false（明确离线）时剔除；undefined（未知）保持原行为。
 */
function dropOfflineDesktopTools(
  tools: ChatCompletionTool[],
  accessCtx?: ChatToolsAccessContext,
): ChatCompletionTool[] {
  if (accessCtx?.desktopBridgeOnline !== false) return tools;
  return tools.filter(
    (tool) => tool.type !== "function" || !/^desktop\./.test(tool.function?.name ?? ""),
  );
}

export function resolveChatToolPlanForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ResolvedChatToolPlan {  // 2026-08-01 性能优化：Fast 模式小工具集短路。
  // 当调用方显式传入 chatToolsBuiltin 且总工具数 ≤ 12 时，调用方明确声明
  // "我只要这 N 个工具"，跳过 access-mode 合并 + contextual 过滤 + ranking。
  // 这些步骤是给 Complex 模式（几十上百工具）准备的，Fast 模式套用反而会：
  //   1. 把 desktop/visual/self-programming 工具合并进来污染 LLM 视野
  //   2. contextual 过滤误裁 weather/calendar 等对 Fast 重要的工具
  //   3. 跑一遍关键词提取 + 分类匹配 ≈ 2-5ms × 每请求
  const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extra = streamOpts?.chatToolsExtra ?? [];
  const merged = [...builtin, ...extra];
  // Fast 模式：不全暴露，只选相关工具，其余走 tool search 延迟召回。
  // selectRelevantTools 基于用户文本做关键词匹配 + 分类映射，微秒级。
  // 未选中的工具通过 prepareToolsWithToolSearch 进入 deferred catalog，
  // LLM 可通过 bridge tool（tool_discover）BM25 搜索即时召回。
  const explicitFastLane =
    streamOpts?.chatToolsBuiltin !== undefined && merged.length <= 12;
  if (explicitFastLane) {
    const selected = selectRelevantTools(userText ?? "", merged, {
      minTools: 3,
      maxTools: 6,
      includeAlwaysIncluded: true,
    });
    // 排序 hint（经验学习循环的 cautiousNamespaces 降权等）不参与短路：
    // 有 hint 时仍需一次微秒级排序，否则学到的高危工具降权在 Fast 模式下失效。
    const hasRankingHint =
      (streamOpts?.toolRankingHint?.preferredNamespaces?.filter(Boolean).length ?? 0) > 0 ||
      (streamOpts?.toolRankingHint?.cautiousNamespaces?.filter(Boolean).length ?? 0) > 0;
    return {
      visibleTools: hasRankingHint ? applyToolRankingHint(selected, streamOpts) : selected,
      searchableTools: merged,
    };
  }

  const key = resolvedToolsCacheKey(userText, streamOpts);
  const hit = _resolvedToolsCache.get(key);
  if (hit) {
    const accessCtx: ChatToolsAccessContext = {
      desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
      phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
    };
    const searchableTools = mergeChatToolsForAccessMode(
      merged,
      parseAgentAccessMode(streamOpts?.agentAccessMode),
      accessCtx,
    );
    return { visibleTools: hit, searchableTools };
  }

  const accessCtx: ChatToolsAccessContext = {
    desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
    phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
  };
  const accessFiltered = mergeChatToolsForAccessMode(
    merged,
    parseAgentAccessMode(streamOpts?.agentAccessMode),
    accessCtx,
  );
  const result = applyToolExposureProfile(
    accessFiltered,
    userText,
    resolveToolExposureProfile(streamOpts),
    streamOpts,
  );
  if (resolveToolExposureProfile(streamOpts) === "scoped") {
    if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
      const firstKey = _resolvedToolsCache.keys().next().value;
      if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
    }
    const scopedVisible = dropOfflineDesktopTools(result, accessCtx);
    _resolvedToolsCache.set(key, scopedVisible);
    return {
      visibleTools: scopedVisible,
      searchableTools: accessFiltered,
    };
  }
  const ranked = dropOfflineDesktopTools(
    pinSpecifiedTools(
      pinDesktopVisualTools(applyToolRankingHint(result, streamOpts), streamOpts),
      streamOpts,
    ),
    accessCtx,
  );

  if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
    const firstKey = _resolvedToolsCache.keys().next().value;
    if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
  }
  _resolvedToolsCache.set(key, ranked);

  return {
    visibleTools: ranked,
    searchableTools: accessFiltered,
  };
}
