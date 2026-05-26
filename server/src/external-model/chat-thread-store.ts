import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { adoptLegacyMasterDelegateThread } from "./chat-thread-adopt.js";
import type { ChatThreadPersistence } from "./chat-thread-persist.js";
import { getChatThreadPersistence } from "./chat-thread-persist.js";
import type { ChatUserTurn } from "./types.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";

const DEFAULT_MAX_TURN_MESSAGES = 48;

/**
 * 智能消息历史裁剪配置
 * 预期效果：Token 消耗 -50%，保持关键上下文
 */
interface SmartTrimConfig {
  maxMessages: number;
  maxTokens: number; // 基于估算的 token 上限
  preserveRecentTurns: number; // 始终保留最近的 N 轮对话
}

const DEFAULT_SMART_TRIM_CONFIG: SmartTrimConfig = {
  maxMessages: parseInt(process.env.MAX_THREAD_MESSAGES ?? '20'),
  maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '8000'),
  preserveRecentTurns: 4,
};

function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // 粗略估算：中文约1.5 token/字符，英文约0.25 token/单词
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.25);
}

function estimateMessageTokens(msg: ChatCompletionMessageParam): number {
  let tokens = 0;
  
  // role token
  tokens += 2;
  
  // content tokens
  if (typeof msg.content === 'string') {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') {
        tokens += estimateTokens((part as { text?: string })?.text);
      } else if (part.type === 'image_url') {
        tokens += 500; // 图像通常消耗较多token
      }
    }
  }
  
  // tool_calls tokens
  if ('tool_calls' in msg && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
    tokens += 50 * (msg as { tool_calls: unknown[] }).tool_calls.length;
  }
  
  // tool result tokens
  if (msg.role === 'tool' && typeof msg.content === 'string') {
    tokens += Math.min(estimateTokens(msg.content), 1000); // 工具结果限制最大1000 tokens
  }
  
  return tokens;
}

export class ChatThreadStore {
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();

  constructor(private readonly persistence: ChatThreadPersistence | null) {}

  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.persistence?.deleteSession(sessionId);
  }

  thread(sessionId: string, defaultSystemPrompt: string): ChatCompletionMessageParam[] {
    let t = this.history.get(sessionId);
    if (!t) {
      t = adoptLegacyMasterDelegateThread(this.history, sessionId);
    }
    if (!t && this.persistence) {
      const restored = this.persistence.loadRestoredMessages(sessionId);
      if (restored?.length) {
        t = [{ role: "system", content: defaultSystemPrompt }, ...restored];
        this.history.set(sessionId, t);
      }
    }
    if (!t) {
      t = [{ role: "system", content: defaultSystemPrompt }];
      this.history.set(sessionId, t);
    }
    return t;
  }

  /**
   * 智能裁剪消息历史（性能优化版）
   * 支持基于消息数量和 Token 数量的双重限制
   */
  trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number): void {
    const config = {
      ...DEFAULT_SMART_TRIM_CONFIG,
      maxMessages: maxMessages ?? DEFAULT_SMART_TRIM_CONFIG.maxMessages,
    };
    
    if (msgs.length <= 1 + config.maxMessages) {
      // 即使消息数量在限制内，也要检查 token 数量
      const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (totalTokens <= config.maxTokens) return;
      
      // Token 超限，执行智能裁剪
      this.smartTrimByTokens(msgs, config);
      return;
    }
    
    const sys = msgs[0];
    const rest = msgs.slice(1);
    const trimmed = trimPreservingToolPairs(rest, config.maxMessages);
    msgs.length = 0;
    msgs.push(sys, ...trimmed);
    
    // 二次检查 token 数量
    const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens > config.maxTokens) {
      this.smartTrimByTokens(msgs, config);
    }
  }

  /**
   * 基于 Token 数量的智能裁剪
   * 保留最近对话 + 关键工具调用上下文
   */
  private smartTrimByTokens(msgs: ChatCompletionMessageParam[], config: SmartTrimConfig): void {
    if (msgs.length <= 2) return; // 至少保留 system + 1条消息
    
    const sys = msgs[0];
    const rest = msgs.slice(1);
    
    // 分离出最近的消息（始终保留）
    const recentMessages = rest.slice(-config.preserveRecentTurns * 2); // 每轮包含 user + assistant
    const olderMessages = rest.slice(0, -config.preserveRecentTurns * 2);
    
    // 计算当前 token 消耗
    let currentTokens = estimateMessageTokens(sys) + 
      recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    
    // 从旧消息中智能选择保留的内容
    const preservedOlder: ChatCompletionMessageParam[] = [];
    for (let i = olderMessages.length - 1; i >= 0 && currentTokens < config.maxTokens; i--) {
      const msg = olderMessages[i];
      const msgTokens = estimateMessageTokens(msg);
      
      // 优先保留包含工具调用的消息（它们通常携带重要上下文）
      const hasToolContext = msg.role === 'assistant' && 'tool_calls' in msg &&
        Array.isArray((msg as { tool_calls?: unknown }).tool_calls) &&
        (msg as { tool_calls: unknown[] }).tool_calls.length > 0;
      
      const isToolResult = msg.role === 'tool';
      
      if (hasToolContext || isToolResult || currentTokens + msgTokens <= config.maxTokens) {
        preservedOlder.unshift(msg);
        currentTokens += msgTokens;
      }
    }
    
    // 组装最终结果
    msgs.length = 0;
    msgs.push(sys, ...preservedOlder, ...recentMessages);
  }

  appendTurn(
    sessionId: string,
    defaultSystemPrompt: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
  ): void {
    const trimmed = assistantText.trim();
    if (!trimmed) return;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    msgs.push({ role: "user", content: openAiUserContentFromTurn(userTurn) });
    msgs.push({ role: "assistant", content: trimmed });
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  afterTurnCompleted(sessionId: string, msgs: ChatCompletionMessageParam[]): void {
    this.persistence?.scheduleSave(sessionId, msgs);
  }
}

let sharedStore: ChatThreadStore | null = null;

export function getChatThreadStore(): ChatThreadStore {
  if (!sharedStore) {
    sharedStore = new ChatThreadStore(getChatThreadPersistence());
  }
  return sharedStore;
}

export function resetChatThreadStoreForTests(): void {
  sharedStore = null;
}

function trimPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) return messages;

  const groups: ChatCompletionMessageParam[][] = [];
  let i = messages.length - 1;

  while (i >= 0) {
    const msg = messages[i];
    if (msg.role === "tool") {
      const group: ChatCompletionMessageParam[] = [];
      while (i >= 0 && messages[i].role === "tool") {
        group.unshift(messages[i]);
        i--;
      }
      if (i >= 0 && messages[i].role === "assistant") {
        const assistantMsg = messages[i];
        const hasToolCalls = Array.isArray(
          (assistantMsg as { tool_calls?: unknown }).tool_calls,
        );
        if (hasToolCalls) {
          group.unshift(assistantMsg);
          i--;
        }
      }
      groups.unshift(group);
    } else {
      groups.unshift([msg]);
      i--;
    }
  }

  const result: ChatCompletionMessageParam[] = [];
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g].length > maxMessages) continue;
    result.unshift(...groups[g]);
    total += groups[g].length;
  }

  return result;
}
