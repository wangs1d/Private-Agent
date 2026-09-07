/**
 * 语音端点检测（能量 VAD，零依赖）。
 *
 * 服务端对上行 16-bit PCM 做 RMS 能量检测：
 *   - 能量超过 speechThreshold 记为说话，累计语音
 *   - 说话状态下连续 silenceMs 低于阈值 → 端点（一句话说完）
 *   - 单句最长 maxUtteranceMs 强制端点（防止环境噪声把静音判爆）
 *
 * 仅在「非流式 ASR 回退路径」使用：FunASR 流式可用时以它的 partial/final
 * 为准，本检测器只做说话开始的辅助判断。
 */

export interface EndpointDetectorOptions {
  /** 语音能量阈值（RMS，0-32767；缺省 350，环境嘈杂可调高） */
  speechThreshold?: number;
  /** 判定说完的静音时长（毫秒，缺省 700） */
  silenceMs?: number;
  /** 单句最长（毫秒，缺省 15000） */
  maxUtteranceMs?: number;
  /** 每块音频对应的毫秒数（按 chunk 实际样本数计算，不需要传） */
}

export type EndpointEvent = "idle" | "speaking" | "endpoint";

export class EndpointDetector {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly maxUtteranceMs: number;

  private inSpeech = false;
  private silentMs = 0;
  private speechMs = 0;

  constructor(options: EndpointDetectorOptions = {}) {
    this.threshold = options.speechThreshold ?? 350;
    this.silenceMs = options.silenceMs ?? 700;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 15_000;
  }

  /**
   * 喂入一块 16-bit LE 单声道 PCM；返回本块之后的状态：
   *   speaking  — 正在说话（继续收集）
   *   endpoint  — 一句话结束（调用方应取出缓冲做 ASR）
   *   idle      — 无人说话
   */
  feed(pcm: Buffer, sampleRate: number): EndpointEvent {
    const samples = pcm.length >> 1;
    if (samples === 0) return this.inSpeech ? "speaking" : "idle";
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const v = pcm.readInt16LE(i * 2);
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / samples);
    const chunkMs = (samples / sampleRate) * 1000;

    if (rms >= this.threshold) {
      this.inSpeech = true;
      this.silentMs = 0;
      this.speechMs += chunkMs;
    } else if (this.inSpeech) {
      this.silentMs += chunkMs;
      this.speechMs += chunkMs;
    }

    if (this.inSpeech && (this.silentMs >= this.silenceMs || this.speechMs >= this.maxUtteranceMs)) {
      return "endpoint";
    }
    return this.inSpeech ? "speaking" : "idle";
  }

  /** 是否已检测到语音（用于丢弃纯噪声缓冲）。 */
  get hasSpeech(): boolean {
    return this.inSpeech;
  }

  reset(): void {
    this.inSpeech = false;
    this.silentMs = 0;
    this.speechMs = 0;
  }
}

/** 把裸 PCM 包装成最小 WAV 容器（非流式 ASR 回退路径用）。 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample >> 3);
  const blockAlign = channels * (bitsPerSample >> 3);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
