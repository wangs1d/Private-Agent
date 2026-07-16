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
import { estimateToolsSchemaTokens } from "../tools/tool-search/catalog.js";

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
  const rankingKey = (streamOpts?.toolRankingHint?.preferredNamespaces ?? []).join(",");
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
    const found = extras.find((t) => t.type === "function" && t.function?.name === name);
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
  const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
  const bridge = streamOpts?.desktopBridgeOnline === true;
  const phoneBridge = streamOpts?.phoneBridgeOnline === true;
  const fullAccess = mode === "full";
  if (bridge || phoneBridge || fullAccess) {
    for (const name of DESKTOP_VISUAL_PINNED_TOOLS) pinned.add(name);
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
  if (preferred.length === 0) return tools;
  const rank = new Map(preferred.map((ns, index) => [ns, index]));
  return [...tools].sort((a, b) => {
    const nameA = a.type === "function" ? a.function?.name ?? "" : "";
    const nameB = b.type === "function" ? b.function?.name ?? "" : "";
    const scoreA = rank.get(pickNamespace(nameA)) ?? Number.MAX_SAFE_INTEGER;
    const scoreB = rank.get(pickNamespace(nameB)) ?? Number.MAX_SAFE_INTEGER;
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
  if (profile === "full" || profile === "delegate" || profile === "scoped") return tools;
  if (!userText?.trim()) return tools;

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

export function resolveChatToolPlanForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ResolvedChatToolPlan {
  const key = resolvedToolsCacheKey(userText, streamOpts);
  const hit = _resolvedToolsCache.get(key);
  if (hit) {
    const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
    const extra = streamOpts?.chatToolsExtra ?? [];
    const merged = [...builtin, ...extra];
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

  const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extra = streamOpts?.chatToolsExtra ?? [];
  const merged = [...builtin, ...extra];
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
  const ranked = pinSpecifiedTools(
    pinDesktopVisualTools(applyToolRankingHint(result, streamOpts), streamOpts),
    streamOpts,
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
