import OpenAI from "openai";

/**
 * 文本转语音：在配置了 OpenAI API 时使用官方 TTS，否则仅返回文本供前端本地播报。
 */
export class TtsService {
  private readonly openai: OpenAI | null;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
    this.openai = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
  }

  isEnabled(): boolean {
    return this.openai !== null;
  }

  /**
   * 生成为 mp3 的 base64；未配置密钥或失败时 ok=false，语音通话仍可以仅靠 transcript。
   */
  async synthesizeMp3Base64(text: string): Promise<
    | { ok: true; format: "mp3"; base64: string }
    | { ok: false; reason: string }
  > {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty text" };
    const clipped = trimmed.length > 450 ? `${trimmed.slice(0, 447)}…` : trimmed;
    if (!this.openai) {
      return { ok: false, reason: "OPENAI_API_KEY 未设置，跳过服务端 TTS" };
    }
    try {
      const res = await this.openai.audio.speech.create({
        model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
        voice: (process.env.OPENAI_TTS_VOICE?.trim() || "alloy") as "alloy",
        input: clipped,
        response_format: "mp3",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, format: "mp3", base64: buf.toString("base64") };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: msg };
    }
  }
}
