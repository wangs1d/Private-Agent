import type { ASRProvider, AudioBuffer, ASRResult } from "../types.js";

/**
 * FunASR 自托管 ASR Adapter（HTTP + WebSocket 调用本地/远端 funasr_server.py）。
 *
 * 部署方式：
 *   pip install funasr modelscope torch torchaudio fastapi "uvicorn[standard]" python-multipart
 *   python server/scripts/funasr_server.py  # 监听 0.0.0.0:8001
 *
 * 环境变量：
 *   FUNASR_BASE_URL=http://127.0.0.1:8001   # 必填
 *   FUNASR_MODEL=paraformer-zh              # 可选，默认 paraformer-zh（带标点）
 *   FUNASR_VAD_MODEL=fsmn-vad                # 可选，VAD 模型
 *   FUNASR_PUNC_MODEL=ct-punc                # 可选，标点恢复模型
 *   FUNASR_TIMEOUT_MS=60000                  # 可选，非流式超时
 *
 * 返回字段：ASRResult { text, confidence, language, isFinal }
 *
 * 设计说明：
 *   - 非流式 transcribe：一次性上传音频文件 (POST /api/asr)
 *   - 流式 startStreamingTranscribe：通过 WebSocket /ws/asr 分块发送音频
 *   - 失败时返回空文本的退化结果，不抛异常。
 */
export class FunAsrAdapter implements ASRProvider {
  name = "funasr";

  private readonly baseUrl: string;
  private readonly defaultLanguage: string;
  private readonly requestTimeoutMs: number;
  /** 复用 fetch 全局实现，Node 18+ 原生支持 */

  constructor() {
    this.baseUrl = (process.env.FUNASR_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
    this.defaultLanguage = process.env.FUNASR_LANGUAGE?.trim() ?? "zh";
    this.requestTimeoutMs = Number(process.env.FUNASR_TIMEOUT_MS?.trim() ?? "60000");
  }

  /** 是否已配置 baseUrl（即视为启用）。 */
  isEnabled(): boolean {
    return !!this.baseUrl;
  }

  async transcribe(
    audio: AudioBuffer,
    options?: { language?: string; enablePunctuation?: boolean },
  ): Promise<ASRResult> {
    const language = options?.language ?? this.defaultLanguage;

    if (!this.isEnabled()) {
      return {
        text: "",
        confidence: 0,
        language,
        isFinal: true,
      };
    }

    try {
      // 用 multipart/form-data 上传音频字节
      const ext = this.guessExtension(audio.format);
      const filename = `audio.${ext}`;
      const mime = this.guessMime(audio.format);

      const form = new FormData();
      const blob = new Blob([new Uint8Array(audio.data)], { type: mime });
      form.append("file", blob, filename);
      form.append("language", language);
      if (options?.enablePunctuation != null) {
        form.append("enable_punctuation", options.enablePunctuation ? "true" : "false");
      }

      const url = `${this.baseUrl}/api/asr`;
      const response = await fetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        console.error(`[FunAsrAdapter] HTTP ${response.status}: ${errText}`);
        return {
          text: "",
          confidence: 0,
          language,
          isFinal: true,
        };
      }

      const json = (await response.json()) as {
        text?: string;
        confidence?: number;
        language?: string;
        error?: string;
      };

      if (json.error) {
        console.error(`[FunAsrAdapter] server error: ${json.error}`);
        return {
          text: "",
          confidence: 0,
          language,
          isFinal: true,
        };
      }

      return {
        text: json.text ?? "",
        // FunASR 不一定返回置信度，缺省给 0.9 表示「模型已落地」
        confidence: typeof json.confidence === "number" ? json.confidence : 0.9,
        language: json.language ?? language,
        isFinal: true,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[FunAsrAdapter] transcribe error: ${msg}`);
      return {
        text: "",
        confidence: 0,
        language,
        isFinal: true,
      };
    }
  }

  private guessExtension(format: AudioBuffer["format"]): string {
    switch (format) {
      case "mp3": return "mp3";
      case "wav": return "wav";
      case "ogg": return "ogg";
      case "pcm": return "pcm";
      default: return "wav";
    }
  }

  private guessMime(format: AudioBuffer["format"]): string {
    switch (format) {
      case "mp3": return "audio/mpeg";
      case "wav": return "audio/wav";
      case "ogg": return "audio/ogg";
      case "pcm": return "audio/pcm";
      default: return "audio/wav";
    }
  }

  /**
   * #8: 流式 ASR — 通过 WebSocket /ws/asr 分块发送音频
   *
   * 返回一个控制函数：
   *   control()       → 发送 stop 信号，触发最终推理
   *   control(audio)  → 推送音频块（Buffer 或 AudioBuffer）
   *
   * 调用方可通过 onFinalResult 回调获取最终识别结果。
   */
  async startStreamingTranscribe(options?: {
    language?: string;
    onPartialResult?: (result: ASRResult) => void;
    onFinalResult?: (result: ASRResult) => void;
    onError?: (error: Error) => void;
  }): Promise<(audio?: AudioBuffer | Buffer) => void> {
    const language = options?.language ?? this.defaultLanguage;
    const onPartial = options?.onPartialResult ?? (() => {});
    const onFinal = options?.onFinalResult ?? (() => {});
    const onError = options?.onError ?? (() => {});

    if (!this.isEnabled()) {
      onError(new Error("FunASR base URL not configured"));
      return () => {};
    }

    // 构造 WS URL：http:// → ws://，https:// → wss://
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws/asr";

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
      return () => {};
    }

    let stopped = false;

    return new Promise<(audio?: AudioBuffer | Buffer) => void>((resolve) => {
      ws.addEventListener("open", () => {
        // 发送配置
        ws.send(JSON.stringify({
          type: "config",
          language,
          enable_punctuation: true,
        }));
        // 返回控制函数：有参数 → 推音频，无参数 → stop
        resolve((audio?: AudioBuffer | Buffer) => {
          if (stopped || ws.readyState !== WebSocket.OPEN) return;
          if (audio) {
            // 推送音频块
            const chunk = Buffer.isBuffer(audio)
              ? audio
              : audio.data;
            ws.send(JSON.stringify({
              type: "audio",
              data: chunk.toString("base64"),
            }));
          } else {
            // 停止并触发最终推理
            stopped = true;
            ws.send(JSON.stringify({ type: "stop" }));
          }
        });
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            text?: string;
            is_final?: boolean;
            confidence?: number;
            language?: string;
            message?: string;
          };

          if (msg.type === "final") {
            onFinal({
              text: msg.text ?? "",
              confidence: typeof msg.confidence === "number" ? msg.confidence : 0.9,
              language: msg.language ?? language,
              isFinal: true,
            });
            // 最终结果已返回，关闭连接
            if (ws.readyState === WebSocket.OPEN) ws.close();
          } else if (msg.type === "partial") {
            onPartial({
              text: msg.text ?? "",
              confidence: 0.5,
              language: msg.language ?? language,
              isFinal: false,
            });
          } else if (msg.type === "error") {
            onError(new Error(msg.message ?? "unknown ASR error"));
          }
          // type === "ready" / "ack" 不需要回调
        } catch {
          // 忽略解析错误
        }
      });

      ws.addEventListener("error", () => {
        onError(new Error("WebSocket connection error"));
      });

      ws.addEventListener("close", () => {
        // 连接关闭时如果没有收到 final，发一个空结果
        if (!stopped) {
          onFinal({ text: "", confidence: 0, language, isFinal: true });
        }
      });
    });
  }
}
