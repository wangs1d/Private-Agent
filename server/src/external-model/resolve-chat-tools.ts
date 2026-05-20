import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { getBuiltinAgentChatTools } from "./openai-compatible-tool-loop.js";
import type { AgentStreamOptions } from "./types.js";

/** 合并内置与技能工具；子 Agent 可通过 `chatToolsBuiltin` 替换内置列表。 */
export function resolveChatToolsForStream(streamOpts?: AgentStreamOptions): ChatCompletionTool[] {
  const builtin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extra = streamOpts?.chatToolsExtra ?? [];
  return [...builtin, ...extra];
}
