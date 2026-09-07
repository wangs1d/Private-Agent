/**
 * 全双工实时语音 —— WS 协议定义。
 *
 * 传输：单条 WebSocket（/ws/voice-duplex），全部为 JSON 文本帧
 * （音频以 base64 编码，16-bit 单声道 PCM；服务端 TTS 输出 mp3 base64）。
 * 选 JSON 文本帧而非二进制分帧：实现简单、Flutter/桌面端无歧义，
 * 音频块默认 100ms（16kHz 下约 3.2KB，base64 后 ~4.3KB）开销可接受。
 *
 * 交互模型（半双工轮流 + 打断）：
 *   client                              server
 *   session.start ────────────────────▶ session.ready（进入 listening）
 *   audio.chunk* ─────────────────────▶ （VAD / 流式 ASR）
 *     │  asr.partial* ◀────────────────│
 *   audio.end 或静音端点检测 ─────────▶ asr.final → thinking
 *     │  assistant.delta* ◀────────────│ （LLM 流式）
 *     │  tts.start / tts.chunk* ◀──────│ （分句 TTS）
 *   （speaking 期间 audio.chunk/interrupt）▶ 打断：丢弃后续合成 → listening
 *     │  tts.end / turn.completed ◀────│
 *   session.stop ─────────────────────▶ session.ended
 */

/** 会话状态机：idle → listening → thinking → speaking（→ listening…）。 */
export type DuplexSessionState = "idle" | "listening" | "thinking" | "speaking";

export interface DuplexSessionConfig {
  /** 客户端上行音频采样率（缺省 16000） */
  sampleRate: number;
  /** ASR 语言（缺省 zh） */
  language: string;
  /** TTS 音色 */
  voiceId?: string;
  /** 会话 ID（关联主对话线程；缺省由服务端生成） */
  sessionId?: string;
}

export type DuplexClientMessage =
  | {
      type: "session.start";
      sampleRate?: number;
      language?: string;
      voiceId?: string;
      sessionId?: string;
      /** 可选会话级 system prompt 覆盖 */
      systemPrompt?: string;
    }
  | { type: "audio.chunk"; pcm: string }
  | { type: "audio.end" }
  | { type: "interrupt" }
  | { type: "session.stop" };

export type DuplexServerMessage =
  | { type: "session.ready"; config: DuplexSessionConfig; streamingAsr: boolean }
  | { type: "state"; state: DuplexSessionState }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.completed"; text: string }
  | { type: "tts.start" }
  | { type: "tts.chunk"; seq: number; audio: string; format: "mp3" | "wav" }
  | { type: "tts.end" }
  | { type: "turn.completed"; userText: string; assistantText: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "session.ended" };

export function parseClientMessage(raw: string): DuplexClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const msg = parsed as { type?: string };
    switch (msg.type) {
      case "session.start":
      case "audio.chunk":
      case "audio.end":
      case "interrupt":
      case "session.stop":
        return parsed as DuplexClientMessage;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
