import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../../agent/prompt-builder.js";
import {
  streamCompletionWithTools,
} from "../openai-compatible-tool-loop.js";
import { resolveChatToolsForStream } from "../resolve-chat-tools.js";
import { openAiUserContentFromTurn } from "../build-user-message-content.js";
import { getChatThreadStore } from "../chat-thread-store.js";
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
    const startLen = msgs.length;

    const overrideSys = streamOpts?.systemPromptOverride?.trim();
    const baseContent = overrideSys
      ? overrideSys
      : buildLayeredSystemPrompt(SYSTEM_PROMPT, streamOpts?.promptContext?.memory);
    const sysContent = finalizeChatSystemPrompt(baseContent, {
      tools: Boolean(tools && !overrideSys),
      masterSubAgentDelegate: streamOpts?.masterSubAgentDelegate,
      agentAccessMode: streamOpts?.agentAccessMode,
      desktopBridgeOnline: streamOpts?.desktopBridgeOnline,
    });
    if (ephemeral || msgs.length === 0) {
      msgs.push({ role: "system", content: sysContent });
    } else {
      msgs[0] = { role: "system", content: sysContent };
    }
    msgs.push({ role: "user", content: openAiUserContentFromTurn(userTurn) });
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages);
    }

    const model = streamOpts?.modelOverride?.trim() || this.model;

    const effectiveStreamOpts: AgentStreamOptions = {
      ...(streamOpts ?? {}),
      disableThinking: kimiThinkingDisabled(streamOpts),
    };

    if (tools) {
      let completed = false;
      try {
          const mergedTools = resolveChatToolsForStream(userTurn.text, effectiveStreamOpts);
        const full = await streamCompletionWithTools(
          this.client,
          model,
          msgs,
          onDelta,
          tools,
          {
            onAfterToolBatch: effectiveStreamOpts?.toolLoop?.onAfterToolBatch,
            tools: mergedTools,
            maxRounds: effectiveStreamOpts?.toolLoop?.maxRounds,
            extraBody: kimiExtraBody(effectiveStreamOpts),
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
          msgs.length = startLen;
        }
        throw e;
      }
    }

    let stream;
    try {
      stream = await this.client.chat.completions.create({
        model,
        messages: msgs,
        stream: true,
        ...(kimiExtraBody(effectiveStreamOpts) ? { extra_body: kimiExtraBody(effectiveStreamOpts) } : {}),
      });
    } catch (e) {
      msgs.length = startLen;
      throw e;
    }

    let full = "";
    try {
      for await (const part of stream) {
        const delta = part.choices[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    } catch (e) {
      msgs.length = startLen;
      throw e;
    }

    msgs.push({ role: "assistant", content: full });
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages);
      this.threads.afterTurnCompleted(sessionId, msgs);
    }
    return full;
  }
}
