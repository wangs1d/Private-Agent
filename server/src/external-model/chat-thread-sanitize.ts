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

function extractToolCallIds(msg: ChatCompletionMessageParam): string[] {
  if (!isAssistantWithToolCalls(msg)) return [];
  return (msg as { tool_calls: Array<{ id?: string }> }).tool_calls
    .map((tc) => tc.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * 按 OpenAI/Kimi 协议顺序校验 tool 链：
 * assistant(tool_calls) 必须紧接对应 tool 结果，不允许孤立 tool 或缺结果的 tool_calls。
 * 防止 API 返回 "tool_call_id is not found"。
 */
export function sanitizeToolCallMessageChain(
  messages: ChatCompletionMessageParam[],
  logPrefix = "[tool-chain-sanitize]",
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "tool") {
      const tcId = (msg as { tool_call_id?: string }).tool_call_id ?? "";
      console.warn(
        `${logPrefix} Dropping orphan tool message at index ${i}: tool_call_id=${tcId || "(empty)"}`,
      );
      i++;
      continue;
    }

    if (isAssistantWithToolCalls(msg)) {
      const expectedIds = extractToolCallIds(msg);
      if (expectedIds.length === 0) {
        console.warn(`${logPrefix} Dropping assistant tool_calls with empty ids at index ${i}`);
        i++;
        continue;
      }

      const toolResults: ChatCompletionMessageParam[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        toolResults.push(messages[j]);
        j++;
      }

      const receivedById = new Map<string, ChatCompletionMessageParam>();
      for (const tr of toolResults) {
        const id = (tr as { tool_call_id?: string }).tool_call_id;
        if (id) receivedById.set(id, tr);
      }

      const allPresent = expectedIds.every((id) => receivedById.has(id));
      const noUnexpected = toolResults.every((tr) => {
        const id = (tr as { tool_call_id?: string }).tool_call_id;
        return !!id && expectedIds.includes(id);
      });
      const countMatches = toolResults.length === expectedIds.length;

      if (allPresent && noUnexpected && countMatches) {
        result.push(msg);
        for (const id of expectedIds) {
          const tr = receivedById.get(id);
          if (tr) result.push(tr);
        }
      } else {
        console.warn(
          `${logPrefix} Dropping incomplete tool chain at index ${i}: ` +
          `expected=[${expectedIds.join(",")}] got=[${toolResults.map((t) => (t as { tool_call_id?: string }).tool_call_id ?? "").join(",")}]`,
        );
      }
      i = j;
      continue;
    }

    result.push(msg);
    i++;
  }

  return result;
}

/** Moonshot/OpenAI 在 tool 链损坏时返回的 400 错误片段。 */
export function isToolCallIdNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /tool_call_id\s+is\s+not\s+found/i.test(msg);
}

export function sanitizeChatMessagesForApi(
  messages: ChatCompletionMessageParam[],
  opts?: { stripReasoning?: boolean; logPrefix?: string },
): ChatCompletionMessageParam[] {
  let filtered = compactValidChatMessages(messages);
  filtered = sanitizeToolCallMessageChain(filtered, opts?.logPrefix ?? "[chat-sanitize]");
  if (opts?.stripReasoning) {
    filtered = filtered.map((msg) => {
      if (isAssistantWithToolCalls(msg)) {
        const rc = (msg as { reasoning_content?: string }).reasoning_content;
        if (typeof rc === "string" && rc.trim()) return msg;
        return { ...msg, reasoning_content: " " } as unknown as ChatCompletionMessageParam;
      }
      if (!("reasoning_content" in msg)) return msg;
      const { reasoning_content: _removed, ...rest } = msg as ChatCompletionMessageParam & {
        reasoning_content?: string;
      };
      return rest;
    });
  } else {
    filtered = repairKimiAssistantToolCallReasoning(filtered);
  }

  // 过滤 content 为空的 assistant 消息（OpenAI API 要求 assistant 消息 content 不能为空，
  // 除非同时携带 tool_calls）。流式响应仅返回 tool_calls / 最终回复为空时会产生此类脏数据。
  filtered = filtered.filter((msg) => {
    if (msg.role !== "assistant") return true;
    if (isAssistantWithToolCalls(msg)) return true;
    const c = msg.content;
    return typeof c === "string" && c.trim().length > 0;
  });

  return filtered;
}
