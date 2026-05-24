import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { filterChatToolsForAccessMode, parseAgentAccessMode } from "../agent/agent-access-mode.js";
import { getBuiltinAgentChatTools } from "./openai-compatible-tool-loop.js";
import type { AgentStreamOptions } from "./types.js";

const _resolvedToolsCache = new Map<string, ChatCompletionTool[]>();
const MAX_RESOLVED_TOOLS_CACHE = 32;

function resolvedToolsCacheKey(streamOpts?: AgentStreamOptions): string {
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
  return `${builtinNames}|${extraNames}|${mode}`;
}

/** 合并内置与技能工具；子 Agent 可通过 `chatToolsBuiltin` 替换内置列表。带 LRU 风格缓存。 */
export function resolveChatToolsForStream(streamOpts?: AgentStreamOptions): ChatCompletionTool[] {
  const key = resolvedToolsCacheKey(streamOpts);
  const hit = _resolvedToolsCache.get(key);
  if (hit) return hit;

  const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extra = streamOpts?.chatToolsExtra ?? [];
  const merged = [...builtin, ...extra];
  const result = filterChatToolsForAccessMode(merged, parseAgentAccessMode(streamOpts?.agentAccessMode));

  if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
    const firstKey = _resolvedToolsCache.keys().next().value;
    if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
  }
  _resolvedToolsCache.set(key, result);

  return result;
}
