import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export function isValidChatMessage(
  msg: ChatCompletionMessageParam | null | undefined,
): msg is ChatCompletionMessageParam {
  return msg != null && typeof msg === "object" && typeof msg.role === "string";
}

export function compactValidChatMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.filter(isValidChatMessage);
}

export function isAssistantWithToolCalls(msg: ChatCompletionMessageParam): boolean {
  if (msg.role !== "assistant") return false;
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/**
 * Kimi k2.5 要求带 tool_calls 的 assistant 消息含 reasoning_content；
 * 旧会话或未开启 thinking 流时可能缺失，补占位避免 400。
 */
export function repairKimiAssistantToolCallReasoning(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (!isAssistantWithToolCalls(msg)) return msg;
    const rc = (msg as { reasoning_content?: string }).reasoning_content;
    if (typeof rc === "string" && rc.trim()) return msg;
    return { ...msg, reasoning_content: " " } as unknown as ChatCompletionMessageParam;
  });
}
