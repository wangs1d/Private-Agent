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

  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";



/**

 * OpenAI 官方 Chat Completions（流式）。

 * 环境变量：`OPENAI_API_KEY`（必填以启用）、`OPENAI_MODEL`、`OPENAI_BASE_URL`（可选，默认官方端点）。

 */

export class OpenAiOfficialProvider implements ExternalChatProvider {

  readonly id = "openai";

  readonly displayLabel = "OpenAI";



  private readonly client: OpenAI | null;

  private readonly model: string;

  private readonly threads = getChatThreadStore();



  constructor() {

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();

    this.model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();

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

      throw new Error("OPENAI_API_KEY is not set");

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

            extraBody: streamOpts?.disableThinking

              ? { thinking: { type: "disabled" } }

              : undefined,

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

    if (!ephemeral) {

      this.trimThread(msgs, streamOpts?.maxThreadMessages);

      this.threads.afterTurnCompleted(sessionId, msgs);

    }

    return full;

  }

}


