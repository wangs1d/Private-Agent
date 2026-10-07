import OpenAI from "openai";
import { MiniMaxTTSAdapter } from "./voice-dialogue/adapters/minimax-tts-adapter.js";

/**
 * 文本转语音服务：
 * - 优先使用 MiniMax TTS（speech-2.5，中文拟真度最佳，按字符计费）
 * - 回退到 OpenAI TTS
 * - 均未配置时仅返回文本供前端本地播报
 */
export class TtsService {
  private openai: OpenAI | null = null;
  private minimax: MiniMaxTTSAdapter | null = null;
  private openaiFingerprint = "";
  private minimaxFingerprint = "";

  /**
   * 按 env 指纹惰性解析客户端：密钥/网关变化时重建（服务接入页保存密钥后
   * PUT /api/service-config 写 env 即热生效，无需重启——与 mutable-chat-provider
   * 的主对话热替换同一时序语义）。
   */
  private resolveClients(): void {
    // OpenAI TTS
    const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
    const openaiFp = `${apiKey}@${baseURL}`;
    if (openaiFp !== this.openaiFingerprint) {
      this.openaiFingerprint = openaiFp;
      this.openai = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
    }
    // MiniMax TTS（speech-2.5）
    const minimaxKey = process.env.MINIMAX_API_KEY?.trim() ?? "";
    if (minimaxKey !== this.minimaxFingerprint) {
      this.minimaxFingerprint = minimaxKey;
      this.minimax = new MiniMaxTTSAdapter();
    }
  }

  isEnabled(): boolean {
    this.resolveClients();
    return this.minimax?.isEnabled() || this.openai !== null;
  }

  /**
   * 获取当前使用的 TTS 提供商名称
   */
  getProvider(): string {
    this.resolveClients();
    if (this.minimax?.isEnabled()) return "minimax";
    if (this.openai) return "openai";
    return "none";
  }

  /**
   * 生成为 mp3 的 base64；未配置密钥或失败时 ok=false，语音通话仍可以仅靠 transcript。
   * 优先 MiniMax TTS，失败后回退 OpenAI TTS
   */
  async synthesizeMp3Base64(text: string): Promise<
    | { ok: true; format: "mp3"; base64: string; provider?: string }
    | { ok: false; reason: string }
  > {
    const result = await this.synthesizeMp3Buffer(text);
    if (!result.ok) return result;
    return { ok: true, format: "mp3", base64: result.buffer.toString("base64"), provider: result.provider };
  }

  /**
   * 生成为 mp3 的 Buffer（用于落地为可重播语音消息文件）。
   * 与 `synthesizeMp3Base64` 同源，但不做 base64 编码，便于直接写盘。
   */
  async synthesizeMp3Buffer(text: string): Promise<
    | { ok: true; format: "mp3"; buffer: Buffer; provider?: string }
    | { ok: false, reason: string }
  > {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty text" };
    const clipped = trimmed.length > 450 ? `${trimmed.slice(0, 447)}…` : trimmed;
    this.resolveClients();

    // 1. 尝试 MiniMax TTS（speech-2.5，中文拟真度最佳）
    if (this.minimax?.isEnabled()) {
      try {
        const result = await this.minimax.synthesize(clipped);
        console.log(`[TtsService] 使用 MiniMax TTS 合成成功 (${result.data.length} bytes)`);
        return { ok: true, format: "mp3", buffer: result.data, provider: "minimax" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[TtsService] MiniMax TTS 失败，回退到 OpenAI: ${msg}`);
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
        return { ok: true, format: "mp3", buffer: buf, provider: "openai" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `OpenAI TTS 错误: ${msg}` };
      }
    }

    return { ok: false, reason: "未配置任何 TTS 服务（MINIMAX_API_KEY / OPENAI_API_KEY）" };
  }
}
