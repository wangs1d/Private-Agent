import type { TTSProvider, AudioBuffer } from "../types.js";
import type { TtsService } from "../../tts-service.js";

export class OpenAITTSAdapter implements TTSProvider {
  name = "openai-tts";

  constructor(private ttsService: TtsService) {}

  async synthesize(text: string, options?: {
    voiceId?: string;
    speed?: number;
    pitch?: number;
    volume?: number;
  }): Promise<AudioBuffer> {
    const result = await this.ttsService.synthesizeMp3Base64(text);

    if (!result.ok) {
      throw new Error(`TTS synthesis failed: ${result.reason}`);
    }

    return {
      data: Buffer.from(result.base64, "base64"),
      format: "mp3",
    };
  }

  async getAvailableVoices() {
    return [
      { id: "alloy", name: "Alloy", language: "en-US", gender: "neutral" },
      { id: "echo", name: "Echo", language: "en-US", gender: "male" },
      { id: "fable", name: "Fable", language: "en-US", gender: "neutral" },
      { id: "onyx", name: "Onyx", language: "en-US", gender: "male" },
      { id: "nova", name: "Nova", language: "en-US", gender: "female" },
      { id: "shimmer", name: "Shimmer", language: "en-US", gender: "female" },
    ] as Array<{ id: string; name: string; language: string; gender: "neutral" | "male" | "female" }>;
  }
}
