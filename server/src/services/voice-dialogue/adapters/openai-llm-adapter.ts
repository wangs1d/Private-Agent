import OpenAI from "openai";
import type { LLMProvider, LLMMessage } from "../types.js";

export class OpenAILLMAdapter implements LLMProvider {
  name = "openai-llm";

  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY?.trim();
    const url = baseURL ?? process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1";

    if (!key) {
      throw new Error("OpenAI API key is required");
    }

    this.client = new OpenAI({
      apiKey: key,
      baseURL: url,
    });
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    },
  ): Promise<string> {
    const finalMessages: LLMMessage[] = [];

    if (options?.systemPrompt) {
      finalMessages.push({
        role: "system",
        content: options.systemPrompt,
      });
    }

    finalMessages.push(...messages);

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
      messages: finalMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
    });

    return response.choices[0]?.message?.content ?? "";
  }

  /** 流式补全（全双工语音用：边生成边吐 token，驱动分句 TTS）。 */
  async chatStream(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      onToken?: (token: string) => void;
    },
  ): Promise<string> {
    const finalMessages: LLMMessage[] = [];
    if (options?.systemPrompt) {
      finalMessages.push({ role: "system", content: options.systemPrompt });
    }
    finalMessages.push(...messages);

    const stream = await this.client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
      messages: finalMessages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
      stream: true,
    });

    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) continue;
      full += delta;
      options?.onToken?.(delta);
    }
    return full;
  }
}
