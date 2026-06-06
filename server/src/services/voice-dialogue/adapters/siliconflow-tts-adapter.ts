import type { TTSProvider, AudioBuffer } from "../types.js";

/**
 * 硅基流动 TTS 适配器（OpenAI 兼容接口）
 * 文档: https://docs.siliconflow.cn/cn/api-reference/audio/create-speech
 *
 * 使用 /v1/audio/speech 接口，支持多种中文语音模型：
 * - FunAudioLLM/CosyVoice2-0.5B  （推荐，中文效果好）
 * - fishaudio/fish-speech-1.5
 * - etc.
 */
export class SiliconFlowTTSAdapter implements TTSProvider {
  name = "siliconflow-tts";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  /** 支持的中文发音人列表 */
  private static readonly VOICES = [
    { id: "FunAudioLLM/CosyVoice2-0.5B:alex", name: "Alex（男）", language: "zh-CN", gender: "male" as const },
    { id: "FunAudioLLM/CosyVoice2-0.5B:bella", name: "Bella（女）", language: "zh-CN", gender: "female" as const },
    { id: "fishaudio/fish-speech-1.5:200", name: "FishSpeech 中文女声", language: "zh-CN", gender: "female" as const },
    { id: "fishaudio/fish-speech-1.5:300", name: "FishSpeech 中文男声", language: "zh-CN", gender: "male" as const },
  ];

  constructor() {
    this.apiKey = process.env.SILICONFLOW_API_KEY?.trim() ?? "";
    this.baseUrl = (process.env.SILICONFLOW_BASE_URL?.trim() ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    this.model = process.env.SILICONFLOW_TTS_MODEL?.trim() ?? "FunAudioLLM/CosyVoice2-0.5B";
  }

  /**
   * 检查是否已配置有效的 API Key
   */
  isEnabled(): boolean {
    return !!this.apiKey;
  }

  async synthesize(text: string, options?: {
    voiceId?: string;
    speed?: number;
    pitch?: number;
    volume?: number;
  }): Promise<AudioBuffer> {
    if (!this.isEnabled()) {
      throw new Error("硅基流动 TTS 未配置：请设置 SILICONFLOW_API_KEY");
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("TTS 文本不能为空");
    }

    // 单次请求最大长度限制
    const clipped = trimmed.length > 2000 ? `${trimmed.slice(0, 1997)}…` : trimmed;

    // voiceId 映射：直接传给硅基流动 API 的 voice 参数
    const voice = options?.voiceId || "FunAudioLLM/CosyVoice2-0.5B:alex";

    const url = `${this.baseUrl}/audio/speech`;

    const body: Record<string, unknown> = {
      model: this.model,
      input: clipped,
      voice,
      response_format: "mp3",
    };

    // 可选参数映射
    if (options?.speed != null) {
      // 硅基流动 speed 范围 0.25 ~ 4.0，将 1-100 映射到合理范围
      body.speed = Math.max(0.25, Math.min(4.0, options.speed / 25));
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), // 30 秒超时
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`硅基流动 TTS 错误 (${response.status}): ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    if (data.length === 0) {
      throw new Error("硅基流动 TTS 未返回任何音频数据");
    }

    return {
      data,
      format: "mp3",
    };
  }

  async getAvailableVoices(): Promise<Array<{
    id: string;
    name: string;
    language: string;
    gender: "male" | "female" | "neutral";
  }>> {
    return SiliconFlowTTSAdapter.VOICES;
  }
}
