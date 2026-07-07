import type { ASRProvider, AudioBuffer, ASRResult } from "../types.js";

/**
 * FunASR 自托管 ASR Adapter（HTTP 调用本地/远端 funasr_server.py）。
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
 *
 * 返回字段：ASRResult { text, confidence, language, isFinal }
 *
 * 设计说明：
 *   - 仅实现非流式 transcribe（一次性上传音频文件）。
 *   - 流式 startStreamingTranscribe 暂未实现，需要 FunASR WebSocket runtime，未来扩展。
 *   - 失败时返回 ok=false 的退化结果（与 OpenAIASRAdapter 行为一致），不抛异常。
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
}
