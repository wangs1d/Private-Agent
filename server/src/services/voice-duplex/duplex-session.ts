import type { ASRProvider, AudioBuffer, LLMMessage, TTSProvider } from "../voice-dialogue/types.js";
import { EndpointDetector, pcmToWav } from "./endpoint-detector.js";
import type { DuplexClientMessage, DuplexServerMessage, DuplexSessionConfig, DuplexSessionState } from "./protocol.js";

/**
 * 全双工语音会话（单连接单会话）—— 状态机 + 管线编排。
 *
 *   listening  上行音频进入：流式 ASR 可用 → 直接喂流（partial/final 驱动）；
 *              否则能量 VAD 端点检测 → 整句 transcribe
 *   thinking   asr.final → LLM 流式生成（assistant.delta 边生成边下发）
 *   speaking   分句 TTS：每个完整句 synthesize → tts.chunk 下发；
 *              用户插话（audio.chunk / interrupt）→ 打断：代次 +1，
 *              旧代次的 token/合成结果全部丢弃，回到 listening
 *
 * 打断语义（barge-in）：以「代次（generation）」为界——interrupt 或说话
 * 态收到音频时 generation++，所有挂起的 LLM/TTS 回调先比对代次再下发，
 * 天然丢弃过期输出。设备端需开启回声消除（AEC），否则扬声器播放的
 * 语音会被麦克风当成插话。
 */

export interface DuplexSessionDeps {
  asr: ASRProvider;
  tts: TTSProvider;
  /** 流式 LLM：onToken 逐 token 回调；返回完整文本 */
  llmStream: (messages: LLMMessage[], onToken: (t: string) => void) => Promise<string>;
  language?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 会话历史条数上限（user+assistant 消息数，不含 system） */
  historyLimit?: number;
  /** 端点检测静音时长（毫秒） */
  endpointSilenceMs?: number;
}

/** 分句缓冲：遇句末标点成句，超长强制切分。 */
class SentenceSegmenter {
  private buffer = "";
  constructor(
    private readonly emit: (sentence: string) => void,
    private readonly maxChars = 60,
  ) {}

  feed(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const match = /[。！？!?；;\n]/.exec(this.buffer);
      const idx = match ? match.index : -1;
      if (idx >= 0) {
        const sentence = this.buffer.slice(0, idx + 1).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (sentence.length >= 2) this.emit(sentence);
        continue;
      }
      if (this.buffer.length >= this.maxChars) {
        const sentence = this.buffer.slice(0, this.maxChars).trim();
        this.buffer = this.buffer.slice(this.maxChars);
        if (sentence.length >= 2) this.emit(sentence);
        continue;
      }
      break;
    }
  }

  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length >= 2) this.emit(rest);
  }
}

export class DuplexVoiceSession {
  readonly id: string;
  private state: DuplexSessionState = "idle";
  private config: DuplexSessionConfig;
  private readonly history: LLMMessage[] = [];
  private generation = 0;

  // 上行缓冲（非流式 ASR 回退路径）
  private readonly pcmBuffers: Buffer[] = [];
  private pcmBytes = 0;
  private readonly detector: EndpointDetector;

  // 流式 ASR：懒开流 + 打断/结束后重开。FunASR 一条流一轮话，
  // stop 信号（无参 feed）结束本轮后必须重开，否则后续音频被静默丢弃。
  private streamingAsrSupported = true;
  private asrFeed: ((audio?: Buffer | AudioBuffer) => void) | null = null;
  private asrOpening = false;
  private readonly pendingPcm: Buffer[] = [];

  // 轮次控制
  private ttsSeq = 0;
  private ttsPending = 0;

  constructor(
    id: string,
    private readonly sink: (msg: DuplexServerMessage) => void,
    private readonly deps: DuplexSessionDeps,
  ) {
    this.id = id;
    this.config = { sampleRate: 16000, language: deps.language ?? "zh" };
    this.detector = new EndpointDetector({ silenceMs: deps.endpointSilenceMs ?? 700 });
  }

  getState(): DuplexSessionState {
    return this.state;
  }

  getConfig(): DuplexSessionConfig {
    return { ...this.config };
  }

  isStreamingAsr(): boolean {
    return this.asrFeed != null;
  }

  // ------------------------------------------------------------------ //
  // 客户端消息入口
  // ------------------------------------------------------------------ //

  async handle(msg: DuplexClientMessage): Promise<void> {
    switch (msg.type) {
      case "session.start": {
        this.config = {
          sampleRate: clampInt(msg.sampleRate ?? 16000, 8000, 48000),
          language: msg.language?.trim() || this.deps.language || "zh",
          voiceId: msg.voiceId?.trim() || undefined,
          sessionId: msg.sessionId?.trim() || undefined,
        };
        const systemPrompt = msg.systemPrompt?.trim() || this.deps.systemPrompt;
        this.deps.systemPrompt = systemPrompt;
        // 探测式开流：provider 未配置/不可用会在 onError（同步）里暴露，
        // 探测失败自动落到「端点检测 + 整句 transcribe」回退路径
        this.streamingAsrSupported = true;
        this.asrFeed = null;
        this.pendingPcm.length = 0;
        await this.ensureAsrStream();
        this.setState("listening");
        this.sink({ type: "session.ready", config: this.config, streamingAsr: this.asrFeed != null });
        return;
      }
      case "audio.chunk":
        this.feedAudio(msg.pcm);
        return;
      case "audio.end":
        await this.forceEndpoint();
        return;
      case "interrupt":
        this.interrupt();
        return;
      case "session.stop":
        await this.stop();
        return;
      default:
        return;
    }
  }

  /** 上行音频（base64 16-bit LE mono PCM）。 */
  feedAudio(pcmBase64: string): void {
    const pcm = Buffer.from(pcmBase64, "base64");
    if (pcm.length === 0) return;

    // speaking/thinking 态收到音频 = 插话（barge-in）
    if (this.state === "speaking" || this.state === "thinking") {
      this.interrupt();
    }
    if (this.state === "idle") return;

    // 流式路径：流已开直接喂；开流中先积压（封顶 ~5s），开好后补送
    if (this.asrFeed) {
      try {
        this.asrFeed(pcm);
      } catch {
        this.asrFeed = null; // 流异常：回落缓冲路径
      }
      return;
    }
    if (this.streamingAsrSupported) {
      this.pendingPcm.push(pcm);
      if (this.pendingPcm.length > 50) this.pendingPcm.shift();
      void this.ensureAsrStream();
      return;
    }

    // 非流式回退：缓冲 + 端点检测
    this.pcmBuffers.push(pcm);
    this.pcmBytes += pcm.length;
    const event = this.detector.feed(pcm, this.config.sampleRate);
    if (event === "endpoint") {
      void this.transcribeBuffered().catch(() => {});
    }
  }

  /** audio.end / 端点强制触发。 */
  async forceEndpoint(): Promise<void> {
    if (this.state !== "listening") return;
    if (this.asrFeed) {
      // 结束本轮：stop 信号触发 final（onFinalResult 接 completeTurn）；
      // 流已结束，下一句话由 feedAudio 懒重开
      const feed = this.asrFeed;
      this.asrFeed = null;
      this.pendingPcm.length = 0;
      try {
        feed();
      } catch {
        // ignore
      }
      return;
    }
    if (this.streamingAsrSupported) {
      // 流尚未开起来就收到 audio.end：丢弃残块，等下一句
      this.pendingPcm.length = 0;
      return;
    }
    await this.transcribeBuffered();
  }

  /** 打断：丢弃当前轮次的生成与合成。 */
  interrupt(): void {
    if (this.state === "thinking" || this.state === "speaking") {
      this.generation += 1;
      this.setState("listening");
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.closeAsrStream();
    this.setState("idle");
    this.sink({ type: "session.ended" });
  }

  dispose(): void {
    this.generation += 1;
    this.closeAsrStream();
  }

  // ------------------------------------------------------------------ //
  // 内部管线
  // ------------------------------------------------------------------ //

  private closeAsrStream(): void {
    if (this.asrFeed) {
      try {
        this.asrFeed();
      } catch {
        // ignore
      }
    }
    this.asrFeed = null;
    this.streamingAsrSupported = false; // 会话结束：不再重开
    this.pendingPcm.length = 0;
  }

  /** 懒开流（含积压补送）；探测失败永久回落整句识别路径。 */
  private async ensureAsrStream(): Promise<void> {
    if (this.asrFeed || this.asrOpening || !this.streamingAsrSupported) return;
    this.asrOpening = true;
    let probeFailed = false;
    try {
      const control = await this.deps.asr.startStreamingTranscribe?.({
        language: this.config.language,
        onPartialResult: (r) => {
          if (r.text?.trim()) this.sink({ type: "asr.partial", text: r.text });
        },
        onFinalResult: (r) => {
          void this.completeTurn(r.text ?? "").catch(() => {});
        },
        onError: () => {
          // 运行中断流（网络断/服务下线）：回落整句路径，会话不断
          probeFailed = true;
          this.asrFeed = null;
          this.streamingAsrSupported = false;
        },
      });
      if (!control || probeFailed) {
        this.streamingAsrSupported = false;
        return;
      }
      this.asrFeed = control;
      // 开流期间的积压音频补送（按顺序）
      for (const buf of this.pendingPcm.splice(0, this.pendingPcm.length)) {
        try {
          this.asrFeed?.(buf);
        } catch {
          break;
        }
      }
    } catch {
      this.streamingAsrSupported = false;
    } finally {
      this.asrOpening = false;
    }
  }

  private setState(state: DuplexSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.sink({ type: "state", state });
  }

  private resetListeningBuffers(): void {
    this.pcmBuffers.length = 0;
    this.pcmBytes = 0;
    this.detector.reset();
    this.pendingPcm.length = 0;
  }

  private async transcribeBuffered(): Promise<void> {
    if (this.pcmBytes === 0) return;
    const pcm = Buffer.concat(this.pcmBuffers.splice(0, this.pcmBuffers.length));
    const sampleRate = this.config.sampleRate;
    this.pcmBytes = 0;
    this.detector.reset();
    // 过短（<0.3s）大概率是噪声
    if (pcm.length < sampleRate * 2 * 0.3) return;
    try {
      const audio: AudioBuffer = { data: pcmToWav(pcm, sampleRate), format: "wav", sampleRate };
      const result = await this.deps.asr.transcribe(audio, { language: this.config.language });
      await this.completeTurn(result.text ?? "");
    } catch (err) {
      this.sink({ type: "error", message: `语音识别失败：${errText(err)}`, recoverable: true });
      this.setState("listening");
    }
  }

  private async completeTurn(userText: string): Promise<void> {
    const text = (userText ?? "").trim();
    if (this.state === "speaking" || this.state === "thinking") return; // 过期 final
    if (!text) {
      this.resetListeningBuffers();
      this.setState("listening");
      return;
    }

    const gen = ++this.generation;
    this.setState("thinking");
    this.sink({ type: "asr.final", text });
    this.resetListeningBuffers();

    this.history.push({ role: "user", content: text });
    this.trimHistory();

    const assistantText = { value: "" };
    let llmDone = false;
    const ttsTasks: Array<Promise<void>> = [];
    this.ttsSeq = 0;
    this.ttsPending = 0;
    let ttsStarted = false;

    const synthSentence = async (sentence: string): Promise<void> => {
      this.ttsPending += 1;
      try {
        const audio = await this.deps.tts.synthesize(sentence, { voiceId: this.config.voiceId });
        if (gen !== this.generation) return; // 已被打断
        if (!ttsStarted) {
          ttsStarted = true;
          this.setState("speaking");
          this.sink({ type: "tts.start" });
        }
        this.sink({
          type: "tts.chunk",
          seq: ++this.ttsSeq,
          audio: audio.data.toString("base64"),
          format: audio.format === "mp3" ? "mp3" : "wav",
        });
      } catch (err) {
        if (gen === this.generation) {
          this.sink({ type: "error", message: `语音合成失败：${errText(err)}`, recoverable: true });
        }
      } finally {
        this.ttsPending -= 1;
      }
    };

    const segmenter = new SentenceSegmenter((sentence) => {
      ttsTasks.push(synthSentence(sentence));
    });

    const messages: LLMMessage[] = [
      ...(this.deps.systemPrompt ? [{ role: "system" as const, content: this.deps.systemPrompt }] : []),
      ...this.history,
    ];

    try {
      const full = await this.deps.llmStream(messages, (token) => {
        if (gen !== this.generation) return; // 已被打断：丢弃 token
        assistantText.value += token;
        this.sink({ type: "assistant.delta", text: token });
        segmenter.feed(token);
      });
      if (gen !== this.generation) return;
      segmenter.flush();
      llmDone = true;

      if (assistantText.value.trim()) {
        this.history.push({ role: "assistant", content: assistantText.value });
        this.trimHistory();
      }
      this.sink({ type: "assistant.completed", text: assistantText.value });

      // 等全部句子合成完毕（被打断的句子在 synthSentence 内部丢弃）
      while (ttsTasks.length > 0) {
        await Promise.all(ttsTasks.splice(0, ttsTasks.length));
      }
      if (gen !== this.generation) return;

      if (llmDone) {
        if (ttsStarted) this.sink({ type: "tts.end" });
        this.sink({ type: "turn.completed", userText: text, assistantText: assistantText.value });
      }
      this.setState("listening");
    } catch (err) {
      if (gen !== this.generation) return;
      this.sink({ type: "error", message: `对话生成失败：${errText(err)}`, recoverable: true });
      this.setState("listening");
    }
  }

  private trimHistory(): void {
    const limit = (this.deps.historyLimit ?? 20) * 2;
    while (this.history.length > limit) {
      this.history.shift();
    }
  }
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(Number.isFinite(v) ? v : min);
  return Math.max(min, Math.min(max, n));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
