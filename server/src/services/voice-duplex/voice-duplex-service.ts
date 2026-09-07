import type { LLMMessage } from "../voice-dialogue/types.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";
import { DuplexVoiceSession } from "./duplex-session.js";
import { parseClientMessage, type DuplexServerMessage } from "./protocol.js";

/**
 * 全双工实时语音 —— 会话管理 + WS 接入层（抽象层主体）。
 *
 * 职责：
 *   - 一条 WS 连接 = 一个 DuplexVoiceSession（连接关闭即销毁）
 *   - ASR/TTS/LLM provider 从 VoiceDialogueService 注册表解析
 *     （FunASR 流式 ASR + SiliconFlow/OpenAI TTS + OpenAI 流式 LLM）
 *   - LLM 流优先 chatStream；provider 未实现时回退一次性 chat
 *     （把整段文本作为一个 delta 下发，管线其余部分不变）
 *
 * 客户端只需实现 protocol.ts 的 JSON 帧协议（参考
 * client/flutter_app/lib/core/services/voice_duplex_service.dart）。
 */

/** 最小 socket 面（fastify-websocket 的 ws socket 结构兼容）。 */
export interface DuplexSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface VoiceDuplexServiceDeps {
  voiceDialogueService: VoiceDialogueService;
  /** VoiceDialogueService 里的 provider 名（缺省默认 provider） */
  providerName?: string;
  /** 会话默认 system prompt（管家口语化短回复风格） */
  systemPrompt?: string;
  maxSessions?: number;
}

const DEFAULT_SYSTEM_PROMPT =
  "你是用户的私人管家，正在与用户进行实时语音对话。要求：回复口语化、简短（通常一两句话）、直接给出行动和结论，不要列表和标题；听不懂就简短追问。";

export class VoiceDuplexService {
  private readonly sessions = new Map<DuplexSocketLike, DuplexVoiceSession>();

  constructor(private readonly deps: VoiceDuplexServiceDeps) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 接入一条 WS 连接（/ws/voice-duplex 路由回调里调用）。 */
  attach(socket: DuplexSocketLike): void {
    const max = this.deps.maxSessions ?? 16;
    if (this.sessions.size >= max) {
      socket.send(JSON.stringify({ type: "error", message: "语音会话数已达上限", recoverable: false } satisfies DuplexServerMessage));
      socket.close(1013, "max_sessions");
      return;
    }

    const sink = (msg: DuplexServerMessage): void => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        // 连接已断：忽略
      }
    };

    let session: DuplexVoiceSession | null = null;
    socket.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data ?? "");
      const msg = parseClientMessage(raw);
      if (!msg) {
        sink({ type: "error", message: "未知消息格式（应为 JSON 协议帧）", recoverable: true });
        return;
      }
      if (msg.type === "session.start") {
        if (session) {
          session.dispose();
          this.sessions.delete(socket);
        }
        session = this.createSession(sink, msg.systemPrompt);
        this.sessions.set(socket, session);
      }
      if (session) {
        void session.handle(msg).catch((err) => {
          sink({ type: "error", message: err instanceof Error ? err.message : String(err), recoverable: true });
        });
      }
    });
    const cleanup = (): void => {
      const s = this.sessions.get(socket);
      if (s) {
        s.dispose();
        this.sessions.delete(socket);
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private createSession(sink: (msg: DuplexServerMessage) => void, systemPromptOverride?: string): DuplexVoiceSession {
    const provider = this.deps.voiceDialogueService.getProvider(this.deps.providerName);
    const llmStream = createLlmStream(provider.llm);
    return new DuplexVoiceSession(
      `vds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sink,
      {
        asr: provider.asr,
        tts: provider.tts,
        llmStream,
        systemPrompt: systemPromptOverride || this.deps.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        historyLimit: 20,
      },
    );
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      void session.stop();
    }
    this.sessions.clear();
  }
}

/** provider.llm.chatStream 存在则直接用；否则一次性 chat 模拟流。 */
function createLlmStream(llm: { chat: (m: LLMMessage[]) => Promise<string>; chatStream?: (m: LLMMessage[], o?: { onToken?: (t: string) => void }) => Promise<string> }): (
  messages: LLMMessage[],
  onToken: (t: string) => void,
) => Promise<string> {
  if (typeof llm.chatStream === "function") {
    return async (messages, onToken) => llm.chatStream!(messages, { onToken });
  }
  return async (messages, onToken) => {
    const text = await llm.chat(messages);
    if (text) onToken(text);
    return text;
  };
}
