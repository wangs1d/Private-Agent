import OpenAI from "openai";
import type { ASRProvider, AudioBuffer, ASRResult } from "../types.js";

export class OpenAIASRAdapter implements ASRProvider {
  name = "openai-whisper";

  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY?.trim();
    const url = baseURL ?? process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1";

    if (!key) {
      throw new Error("OpenAI API key is required for ASR");
    }

    this.client = new OpenAI({
      apiKey: key,
      baseURL: url,
    });
  }

  async transcribe(audio: AudioBuffer, options?: {
    language?: string;
    enablePunctuation?: boolean;
  }): Promise<ASRResult> {
    try {
      const transcription = await this.client.audio.transcriptions.create({
        model: "whisper-1",
        file: new File([audio.data], "audio.mp3", { type: `audio/${audio.format}` }),
        language: options?.language ?? "zh",
        response_format: "verbose_json",
      });

      return {
        text: transcription.text ?? "",
        confidence: 0.95,
        language: transcription.language ?? options?.language ?? "zh",
        isFinal: true,
      };
    } catch (error) {
      console.error("ASR transcription error:", error);
      return {
        text: "",
        confidence: 0,
        language: options?.language ?? "zh",
        isFinal: true,
      };
    }
  }
}
