import type { TTSProvider, AudioBuffer } from "../types.js";

/**
 * MiniMax TTS 适配器（speech-2.5 系列，t2a_v2 接口）
 * 文档: https://platform.minimaxi.com/document/t2a_v2
 *
 * - 国内端点 https://api.minimaxi.com（注意双 i，国际站 key 不通用）；国际端点 api.minimax.io
 * - 响应里 data.audio 为 hex 编码，这里统一解码成 Buffer
 * - 计费按字符（extra_info.usage_characters，含标点）
 */
export interface MiniMaxTTSOptions {
  voiceId?: string;
  /** 语速倍率，MiniMax 取值 0.5 ~ 2 */
  speed?: number;
  /** 音调，-12 ~ 12 */
  pitch?: number;
  /** 音量 0 ~ 10，默认 1 */
  volume?: number;
  /** 输出采样率，默认 32000 */
  sampleRate?: number;
  /** 输出格式，默认 mp3（realtime 探针链路用 wav 直取 PCM） */
  format?: "mp3" | "wav" | "pcm" | "flac";
}

export class MiniMaxTTSAdapter implements TTSProvider {
  name = "minimax-tts";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly defaultSpeed: number;

  /** 实测可用的系统音色 */
  private static readonly VOICES = [
    { id: "female-shaonv", name: "少女音（女）", language: "zh-CN", gender: "female" as const },
    { id: "female-yujie", name: "御姐音（女）", language: "zh-CN", gender: "female" as const },
    { id: "presenter_female", name: "主持人（女）", language: "zh-CN", gender: "female" as const },
    { id: "male-qn-qingse", name: "青涩青年（男，realtime 默认音色）", language: "zh-CN", gender: "male" as const },
  ];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.MINIMAX_API_KEY?.trim() ?? "";
    this.baseUrl = (env.MINIMAX_BASE_URL?.trim() ?? "https://api.minimaxi.com").replace(/\/+$/, "");
    this.model = env.MINIMAX_TTS_MODEL?.trim() ?? "speech-2.5-turbo-preview";
    this.defaultVoice = env.MINIMAX_TTS_VOICE?.trim() ?? "female-shaonv";
    this.defaultSpeed = Number(env.MINIMAX_TTS_SPEED?.trim() ?? "1") || 1;
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  async synthesize(text: string, options?: MiniMaxTTSOptions): Promise<AudioBuffer> {
    if (!this.isEnabled()) {
      throw new Error("MiniMax TTS 未配置：请设置 MINIMAX_API_KEY");
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("TTS 文本不能为空");
    }
    // t2a_v2 单次上限 10000 字符，裁到 9000（含省略号）
    const clipped = trimmed.length > 9000 ? `${trimmed.slice(0, 8999)}…` : trimmed;

    const voiceSetting: Record<string, unknown> = {
      voice_id: options?.voiceId || this.defaultVoice,
      speed: Math.min(2, Math.max(0.5, options?.speed ?? this.defaultSpeed)),
      vol: Math.min(10, Math.max(0.1, options?.volume ?? 1)),
      pitch: Math.min(12, Math.max(-12, options?.pitch ?? 0)),
    };

    const format = options?.format ?? "mp3";
    const sampleRate = options?.sampleRate ?? 32000;

    const response = await fetch(`${this.baseUrl}/v1/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        text: clipped,
        stream: false,
        voice_setting: voiceSetting,
        audio_setting: {
          sample_rate: sampleRate,
          bitrate: 128000,
          format,
          channel: 1,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`MiniMax TTS 错误 (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      data?: { audio?: string };
      base_resp?: { status_code?: number; status_msg?: string };
      extra_info?: { usage_characters?: number };
    };

    // 业务失败时 HTTP 仍可能 200，必须看 base_resp
    const status = payload.base_resp;
    if (!status || status.status_code !== 0) {
      throw new Error(`MiniMax TTS 失败 (${status?.status_code}): ${status?.status_msg ?? "unknown"}`);
    }
    if (!payload.data?.audio) {
      throw new Error("MiniMax TTS 未返回音频数据");
    }

    const data = Buffer.from(payload.data.audio, "hex");
    if (data.length === 0) {
      throw new Error("MiniMax TTS 音频数据为空");
    }

    return {
      data,
      format: format as AudioBuffer["format"],
      sampleRate,
      channels: 1,
    };
  }

  async getAvailableVoices(): Promise<Array<{
    id: string;
    name: string;
    language: string;
    gender: "male" | "female" | "neutral";
  }>> {
    return MiniMaxTTSAdapter.VOICES;
  }
}
