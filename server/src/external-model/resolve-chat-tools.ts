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

const _resolvedToolsCache = new Map<string, ChatCompletionTool[]>();
const MAX_RESOLVED_TOOLS_CACHE = 32;

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
  const profile = resolveToolExposureProfile(streamOpts);
  const textKey = contextualTextKey(userText, profile);
  const rankingKey = (streamOpts?.toolRankingHint?.preferredNamespaces ?? []).join(",");
  return `${builtinNames}|${extraNames}|${mode}|${bridge}|${profile}|${textKey}|${rankingKey}`;
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
] as const;

/** 桥接在线或完全访问时，桌面工具不得被 contextual 筛选掉。 */
function pinDesktopVisualTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
  const bridge = streamOpts?.desktopBridgeOnline === true;
  const fullAccess = mode === "full";
  if (!bridge && !fullAccess) return tools;

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
): ChatCompletionTool[] {
  if (profile === "none") return [];
  if (profile === "full" || profile === "delegate" || profile === "scoped") return tools;
  if (!userText?.trim()) return tools;

  if (profile === "light") {
    return selectRelevantTools(userText, tools, {
      minTools: 3,
      maxTools: 8,
      includeAlwaysIncluded: false,
    });
  }

  return selectRelevantTools(userText, tools, {
    minTools: 4,
    maxTools: 14,
    includeAlwaysIncluded: true,
  });
}

export function resolveChatToolsForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const key = resolvedToolsCacheKey(userText, streamOpts);
  const hit = _resolvedToolsCache.get(key);
  if (hit) return hit;

  const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extra = streamOpts?.chatToolsExtra ?? [];
  const merged = [...builtin, ...extra];
  const accessCtx: ChatToolsAccessContext = {
    desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
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
  );
  const ranked = pinDesktopVisualTools(applyToolRankingHint(result, streamOpts), streamOpts);

  if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
    const firstKey = _resolvedToolsCache.keys().next().value;
    if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
  }
  _resolvedToolsCache.set(key, ranked);

  return ranked;
}
