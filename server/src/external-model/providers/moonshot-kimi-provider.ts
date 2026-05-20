import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  appendAgentToolCallingSystemSuffix,
  buildLayeredSystemPrompt,
} from "../../agent/prompt-builder.js";
import {
  streamCompletionWithDoudizhuTools,
} from "../openai-compatible-tool-loop.js";
import { resolveChatToolsForStream } from "../resolve-chat-tools.js";
import { openAiUserContentFromTurn } from "../build-user-message-content.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "../types.js";

const SYSTEM_PROMPT =
  "You are Kimi, an AI assistant provided by Moonshot AI. You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. You will reject any requests involving terrorism, racism, or explicit content. Moonshot AI is a proper noun and should not be translated.";

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
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();
  private readonly maxTurnMessages = 48;

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
    this.history.delete(sessionId);
  }

  private thread(sessionId: string): ChatCompletionMessageParam[] {
    let t = this.history.get(sessionId);
    if (!t) {
      t = [{ role: "system", content: SYSTEM_PROMPT }];
      this.history.set(sessionId, t);
    }
    return t;
  }

  private trimThread(msgs: ChatCompletionMessageParam[]): void {
    if (msgs.length <= 1 + this.maxTurnMessages) return;
    const sys = msgs[0];
    const rest = msgs.slice(1).slice(-this.maxTurnMessages);
    msgs.length = 0;
    msgs.push(sys, ...rest);
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
    const msgs = this.thread(sessionId);
    let sysContent = buildLayeredSystemPrompt(SYSTEM_PROMPT, streamOpts?.promptContext?.memory);
    if (tools) {
      sysContent = appendAgentToolCallingSystemSuffix(sysContent);
    }
    msgs[0] = { role: "system", content: sysContent };
    const startLen = msgs.length;
    msgs.push({ role: "user", content: openAiUserContentFromTurn(userTurn) });
    this.trimThread(msgs);

    if (tools) {
      try {
        const mergedTools = resolveChatToolsForStream(streamOpts);
        const full = await streamCompletionWithDoudizhuTools(
          this.client,
          this.model,
          msgs,
          onDelta,
          tools,
          {
            onAfterToolBatch: streamOpts?.toolLoop?.onAfterToolBatch,
            tools: mergedTools,
          },
        );
        this.trimThread(msgs);
        return full;
      } catch (e) {
        msgs.length = startLen;
        throw e;
      }
    }

    let stream;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages: msgs,
        stream: true,
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
    this.trimThread(msgs);
    return full;
  }
}
