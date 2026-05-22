import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../../agent/prompt-builder.js";
import {
  streamCompletionWithDoudizhuTools,
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

function kimiExtraBody(streamOpts?: AgentStreamOptions): Record<string, unknown> | undefined {
  return streamOpts?.disableThinking ? { thinking: { type: "disabled" } } : undefined;
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
    this.model = (process.env.MOONSHOT_MODEL ?? "moonshot-v1-8k").trim();
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

    if (tools) {
      try {
        const mergedTools = resolveChatToolsForStream(streamOpts);
        const full = await streamCompletionWithDoudizhuTools(
          this.client,
          model,
          msgs,
          onDelta,
          tools,
          {
            onAfterToolBatch: streamOpts?.toolLoop?.onAfterToolBatch,
            tools: mergedTools,
            maxRounds: streamOpts?.toolLoop?.maxRounds,
            extraBody: kimiExtraBody(streamOpts),
          },
        );
        if (!ephemeral) {
          this.trimThread(msgs, streamOpts?.maxThreadMessages);
          this.threads.afterTurnCompleted(sessionId, msgs);
        }
        return full;
      } catch (e) {
        if (!ephemeral) {
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
        ...(kimiExtraBody(streamOpts) ? { extra_body: kimiExtraBody(streamOpts) } : {}),
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
