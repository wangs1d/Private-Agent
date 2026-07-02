import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  streamCompletionWithTools,
} from "../openai-compatible-tool-loop.js";
import {
  applyPromptCacheMessages,
  preparePromptCachePlan,
} from "../prefix-cache.js";
import { resolveChatToolPlanForStream } from "../resolve-chat-tools.js";
import { prepareToolsWithToolSearch } from "../../tools/tool-search/index.js";
import { openAiUserContentFromTurn } from "../build-user-message-content.js";
import { annotateUserContentForLlm, getChatThreadStore, tagUserMessageClientId } from "../chat-thread-store.js";
import {
  adaptOpenAiChatCompletionStream,
  consumeNormalizedStream,
  pickVisibleText,
} from "../stream-chat-helpers.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "../types.js";

const SYSTEM_PROMPT =
  "You are Kimi, an AI assistant provided by Moonshot AI. You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. You will reject any requests involving terrorism, racism, or explicit content. Moonshot AI is a proper noun and should not be translated.";

function kimiThinkingDisabled(streamOpts?: AgentStreamOptions): boolean {
  return streamOpts?.disableThinking !== false;
}

function kimiExtraBody(streamOpts?: AgentStreamOptions): Record<string, unknown> | undefined {
  return kimiThinkingDisabled(streamOpts) ? { thinking: { type: "disabled" } } : undefined;
}

/**
 * Moonshot OpenAI 兼容 API（Kimi 模型）。
 * 环境变量：`MOONSHOT_API_KEY`（必填以启用）、`MOONSHOT_MODEL`、`MOONSHOT_BASE_URL`。
 * @see https://platform.moonshot.ai/docs/guide/start-using-kimi-api
 */
export class MoonshotKimiProvider implements ExternalChatProvider {
  readonly id = "moonshot-kimi";
  readonly displayLabel = "Kimi (Moonshot)";

  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly threads = getChatThreadStore();

  constructor() {
    const apiKey = process.env.MOONSHOT_API_KEY?.trim();
    const baseURL = (process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1").trim();
    this.model = (process.env.MOONSHOT_MODEL ?? "kimi-k2.5").trim();
    this.client = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  clearSession(sessionId: string): void {
    this.threads.clearSession(sessionId);
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
  ): void {
    this.threads.appendTurn(sessionId, SYSTEM_PROMPT, userTurn, assistantText, maxThreadMessages);
  }

  private thread(sessionId: string): ChatCompletionMessageParam[] {
    return this.threads.thread(sessionId, SYSTEM_PROMPT);
  }

  private trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number): void {
    this.threads.trimThread(msgs, maxMessages);
  }

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    if (!this.client) {
      throw new Error("MOONSHOT_API_KEY is not set");
    }
    const ephemeral = streamOpts?.ephemeralTurn === true;
    const msgs: ChatCompletionMessageParam[] = ephemeral ? [] : this.thread(sessionId);

    const overrideSys = streamOpts?.systemPromptOverride?.trim();
    const promptMemory = streamOpts?.promptContext?.memory;
    const model = streamOpts?.modelOverride?.trim() || this.model;
    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model,
      baseSystemPrompt: overrideSys || SYSTEM_PROMPT,
      memory: overrideSys ? undefined : promptMemory,
      finalizeOptions: {
        tools: Boolean(tools && !overrideSys),
        masterSubAgentDelegate: streamOpts?.masterSubAgentDelegate,
        agentAccessMode: streamOpts?.agentAccessMode,
        desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
        phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
      },
      variant: tools ? "chat-tools" : "chat",
    });
    const sysContent = promptPlan.fullSystemPrompt;
    if (ephemeral || msgs.length === 0) {
      msgs.push({ role: "system", content: sysContent });
    } else {
      msgs[0] = { role: "system", content: sysContent };
    }
    // 支持「编辑同 clientMessageId 的 user 消息并重发」：先把该消息及其后续内容删掉。
    // 截断后再重算 turnStartLen，确保异常回滚到本轮开始时的真实状态。
    if (!ephemeral && userTurn.clientMessageId) {
      this.threads.removeUserMessageAndAfter(sessionId, userTurn.clientMessageId);
    }
    const turnStartLen = msgs.length;
    const userMsg = {
      role: "user",
      content: annotateUserContentForLlm(openAiUserContentFromTurn(userTurn)),
    } as ChatCompletionMessageParam;
    tagUserMessageClientId(userMsg, userTurn.clientMessageId);
    msgs.push(userMsg);
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages);
    }
    const effectiveStreamOpts: AgentStreamOptions = {
      ...(streamOpts ?? {}),
      disableThinking: kimiThinkingDisabled(streamOpts),
    };

    if (tools) {
      let completed = false;
      try {
        const toolPlan = resolveChatToolPlanForStream(userTurn.text, effectiveStreamOpts);
        const toolSearchPrepared = prepareToolsWithToolSearch(toolPlan.visibleTools, toolPlan.searchableTools);
        const toolPromptPlan = preparePromptCachePlan({
          providerId: this.id,
          model,
          baseSystemPrompt: overrideSys || SYSTEM_PROMPT,
          memory: overrideSys ? undefined : promptMemory,
          finalizeOptions: {
            tools: Boolean(tools && !overrideSys),
            masterSubAgentDelegate: streamOpts?.masterSubAgentDelegate,
            agentAccessMode: streamOpts?.agentAccessMode,
            desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
            phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
          },
          tools: toolSearchPrepared.visibleTools,
          variant: "chat-tools",
        });
        const full = await streamCompletionWithTools(
          this.client,
          model,
          msgs,
          onDelta,
          tools,
          {
            onAfterToolBatch: effectiveStreamOpts?.toolLoop?.onAfterToolBatch,
            tools: toolPlan.visibleTools,
            toolSearchSourceTools: toolPlan.searchableTools,
            maxRounds: effectiveStreamOpts?.toolLoop?.maxRounds,
            extraBody: kimiExtraBody(effectiveStreamOpts),
            promptCache: toolPromptPlan.promptCache,
            requestSystemMessages: toolPromptPlan.requestSystemMessages,
          },
        );
        completed = true;
        if (!ephemeral) {
          this.trimThread(msgs, streamOpts?.maxThreadMessages);
          this.threads.afterTurnCompleted(sessionId, msgs);
        }
        return full;
      } catch (e) {
        if (!completed && !ephemeral) {
          msgs.length = turnStartLen;
        }
        throw e;
      }
    }

    let stream;
    try {
      const request = {
        model,
        messages: applyPromptCacheMessages(msgs, promptPlan.requestSystemMessages),
        stream: true,
        ...(promptPlan.promptCache ?? {}),
        // ⚠️ OpenAI Node SDK v6 不识别 Python 风格的 `extra_body`，会把 `thinking`
        // 埋到一层下导致 Moonshot 收不到。直接 spread 到顶层。
        ...(kimiExtraBody(effectiveStreamOpts) ?? {}),
      };
      stream = await this.client.chat.completions.create(
        request as Parameters<typeof this.client.chat.completions.create>[0],
      ) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (e) {
      msgs.length = turnStartLen;
      throw e;
    }

    // 流式消费统一走 provider-agnostic helper：自动累积 content + reasoning_content + tool_calls。
    // 适配层（adaptOpenAiChatCompletionStream）只负责把 OpenAI ChatCompletionChunk 映射到 NormalChatChunk；
    // 核心 consumer 不关心具体 provider —— 后续接入 Anthropic/Google 时只需换 adapter。
    let full = "";
    let visible = "";
    try {
      const result = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => onDelta(d),
          providerId: this.id,
          model,
        },
      );
      full = result.content;
      visible = pickVisibleText(result.content, result.reasoning);
      // content 为空但 reasoning 有内容时，把 reasoning 补发给客户端（一次性）
      if (!full.trim() && visible) {
        onDelta(visible);
      }
    } catch (e) {
      msgs.length = turnStartLen;
      throw e;
    }

    if (visible.trim()) {
      msgs.push({ role: "assistant", content: visible });
    }
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages);
      this.threads.afterTurnCompleted(sessionId, msgs);
    }
    return visible;
  }
}
