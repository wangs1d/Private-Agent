import OpenAI from "openai";
import { SiliconFlowTTSAdapter } from "./voice-dialogue/adapters/siliconflow-tts-adapter.js";

/**
 * 文本转语音服务：
 * - 优先使用硅基流动 TTS（中文语音质量更佳，OpenAI 兼容接口）
 * - 回退到 OpenAI TTS
 * - 均未配置时仅返回文本供前端本地播报
 */
export class TtsService {
  private readonly openai: OpenAI | null;
  private readonly siliconflow: SiliconFlowTTSAdapter | null;

  constructor() {
    // OpenAI TTS
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
    this.openai = apiKey ? new OpenAI({ apiKey, baseURL }) : null;

    // 硅基流动 TTS
    this.siliconflow = new SiliconFlowTTSAdapter();
    if (!this.siliconflow.isEnabled()) {
      // 无 API Key 时静默，后续回退到 OpenAI
    }
  }

  isEnabled(): boolean {
    return this.siliconflow?.isEnabled() ?? this.openai !== null;
  }

  /**
   * 获取当前使用的 TTS 提供商名称
   */
  getProvider(): string {
    if (this.siliconflow?.isEnabled()) return "siliconflow";
    if (this.openai) return "openai";
    return "none";
  }

  /**
   * 生成为 mp3 的 base64；未配置密钥或失败时 ok=false，语音通话仍可以仅靠 transcript。
   * 优先使用硅基流动 TTS，失败后回退到 OpenAI TTS
   */
  async synthesizeMp3Base64(text: string): Promise<
    | { ok: true; format: "mp3"; base64: string; provider?: string }
    | { ok: false; reason: string }
  > {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty text" };
    const clipped = trimmed.length > 450 ? `${trimmed.slice(0, 447)}…` : trimmed;

    // 1. 尝试硅基流动 TTS（中文语音质量更佳）
    if (this.siliconflow?.isEnabled()) {
      try {
        const result = await this.siliconflow.synthesize(clipped);
        console.log(`[TtsService] 使用硅基流动 TTS 合成成功 (${result.data.length} bytes)`);
        return {
          ok: true,
          format: "mp3",
          base64: result.data.toString("base64"),
          provider: "siliconflow",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[TtsService] 硅基流动 TTS 失败，回退到 OpenAI: ${msg}`);
      }
    }

    // 2. 回退到 OpenAI TTS
    if (this.openai) {
      try {
        const res = await this.openai.audio.speech.create({
          model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
          voice: (process.env.OPENAI_TTS_VOICE?.trim() || "alloy") as "alloy",
          input: clipped,
          response_format: "mp3",
        });
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, format: "mp3", base64: buf.toString("base64"), provider: "openai" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `OpenAI TTS 错误: ${msg}` };
      }
    }

    return { ok: false, reason: "未配置任何 TTS 服务（SILICONFLOW_API_KEY 或 OPENAI_API_KEY）" };
  }
}
