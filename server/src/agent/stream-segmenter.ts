/**
 * StreamSegmenter —— 主回复流式的"同源短句分段器"
 *
 * 设计动机（GPT live 式真人节奏）：
 * - 垫词不再由独立 LLM 生成（避免与正文脱节、重复），而是主回复流式输出的一部分。
 * - 主回复流式 delta 先累积进缓冲，按自然语义短句边界（。！？；\n 等）切分，
 *   每收集到一个完整句子就作为一段推送给前端（同一气泡 messageId 追加），
 *   像真人一句一句蹦出来，而不是整段一次性吐完。
 * - 句间做轻微停顿（pauseMs），模仿真人说话节奏，聊天感更强。
 * - 与主回复同源：分段内容就是 LLM 输出的正文本身，天然连续、不重复。
 *
 * 关键正确性约束（杜绝"垫词 + 正文 + done 全文"三者重复）：
 * 1. 每个完整分句单独成段，绝不允许把多个句子并成一个段（否则整段会全落到
 *    interim 垫词气泡，正文气泡为空，done 时又补一份全文 → 整段重复）。
 * 2. 首个分句先"按住"（heldFirst），不立即分发：只有当确认主回复还有后续内容时，
 *    才把它作为垫词(interim)独立气泡发出；若整段回复只有这一句，则把它作为普通
 *    正文(stream)单个气泡发出——避免"垫词气泡 + done 全文气泡"双份重复。
 */
export type StreamSegmenterOptions = {
  /** 句间停顿（毫秒），用于模拟真人说话节奏。默认 100ms。 */
  pauseMs?: number;
  /** 最小句子长度（字符），低于该长度的碎片不单独成段，留待合并。默认 6。 */
  minSegmentChars?: number;
  /** 垫词(interim)气泡与真实回复正文之间的间隔（毫秒），
   *  模拟真人先应一句、稍作停顿再开口细说的节奏。默认 800ms。 */
  interimReplyGapMs?: number;
  /**
   * 是否启用短句分段。默认 true。
   * - true：按自然句边界切分，逐句推送（带句间停顿），模拟真人聊天节奏。
   * - false：不透传分段，全部内容累积后在 flushFinal 一次性推为 stream 段。
   */
  segmentationEnabled?: boolean;
};

const SEGMENT_BOUNDARY_RE = /[。！？!?；;\n]/u;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StreamSegmenter {
  private buffer = "";
  private minSegmentChars: number;
  private pauseMs: number;
  /** 垫词与真实回复正文之间的间隔 */
  private interimReplyGapMs: number;
  /** 是否启用短句分段 */
  private segmentationEnabled: boolean;
  /** 串行队列：保证 feed 的异步停顿不交错、乱序 */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 是否已收到任何流式 delta（用于判定"有无流式内容"，替代不可靠的 streamedChunks 标记）。 */
  private hasReceived = false;
  /** 首个完整分句：先按住，等判定主回复是否还有其他内容再决定如何分发。 */
  private heldFirst: string | null = null;
  /** 是否已把首个分句作为垫词(interim)发出（此后所有分句一律走 stream）。 */
  private firstHandled = false;

  constructor(
    private readonly emit: (segment: string, phase: "interim" | "stream") => void,
    opts: StreamSegmenterOptions = {},
  ) {
    this.pauseMs = opts.pauseMs ?? 100;
    this.minSegmentChars = opts.minSegmentChars ?? 6;
    this.interimReplyGapMs = opts.interimReplyGapMs ?? 400;
    this.segmentationEnabled = opts.segmentationEnabled ?? true;
  }

  /**
   * 喂入新的流式 delta，累积并按短句边界切分，逐句推送给 emit。
   * 未闭合的半截文本留在缓冲，等待后续 delta 或 flushFinal。
   * 异步串行：句间停顿走 setTimeout，不阻塞事件循环。
   */
  feed(delta: string): void {
    if (!delta || this.disposed) return;
    this.hasReceived = true;
    this.buffer += delta;
    this.chain = this.chain
      .then(() => this.flushCompleteSegments())
      .catch((err) => {
        console.error("[StreamSegmenter] feed 异常:", err);
      });
  }

  /** 主回复是否已有流式 delta 被喂入（用于上层决定是否还需兜底喂入完整文本）。 */
  get hasStreamedContent(): boolean {
    return this.hasReceived;
  }

  /**
   * 主回复流结束时调用：把缓冲中剩余的文本作为最后一段推送。
   * - 启用分段时：按句边界裁决首句 + 推送剩余缓冲
   * - 禁用分段时：整个缓冲作为 single stream 段直接推送
   */
  async flushFinal(): Promise<void> {
    await this.chain;
    if (this.disposed) return;
    const rest = this.buffer.trim();
    this.buffer = "";

    if (!this.segmentationEnabled) {
      // 不分段模式：整个缓冲作为一段 stream 发出，无首句裁决
      if (rest) this.emit(rest, "stream");
      return;
    }

    // 分段模式：裁决首句 + 推送剩余缓冲
    if (this.heldFirst !== null) {
      if (this.firstHandled) {
        // 首批后续分句已作为正文发出，此时才补发首个分句为垫词(interim)
        this.emit(this.heldFirst, "interim");
      } else if (rest) {
        // 有首个分句 + 剩余未闭合内容 → 首个作垫词，间隔后剩余作正文
        this.emit(this.heldFirst, "interim");
        if (this.interimReplyGapMs > 0) {
          await sleep(this.interimReplyGapMs);
          if (this.disposed) return;
        }
        if (rest) this.emit(rest, "stream");
      } else {
        // 整段回复只有这一句：作为单个正文气泡发出，避免"垫词 + done 全文"重复
        this.emit(this.heldFirst, "stream");
      }
      this.heldFirst = null;
      this.firstHandled = true;
    } else if (rest) {
      this.emit(rest, "stream");
    }
  }

  /** 丢弃缓冲并停止后续推送（例如 turn 过期）。 */
  discard(): void {
    this.disposed = true;
    this.buffer = "";
    this.heldFirst = null;
  }

  /** 逐句分发：每个完整分句单独作为一段，串行、带句间停顿。
   *  禁用分段时直接返回，不分句。 */
  private async flushCompleteSegments(): Promise<void> {
    if (!this.segmentationEnabled) return;
    while (!this.disposed) {
      const brk = this.findBoundary(this.buffer);
      if (brk < 0) break; // 暂无完整句子
      const complete = this.buffer.slice(0, brk + 1).trim();
      this.buffer = this.buffer.slice(brk + 1);
      if (!complete) continue;
      // 纯标点/无实际内容的碎片（如单个"。"或"！"）不单独成段，直接跳过；
      // 含汉字/字母/数字的短句（如"好的。"）是真实短句，照常成段，避免被并进正文。
      if (
        complete.length < this.minSegmentChars &&
        !/[A-Za-z0-9\u4e00-\u9fa5]/.test(complete)
      ) {
        continue;
      }
      if (this.pauseMs > 0) {
        await sleep(this.pauseMs);
        if (this.disposed) return;
      }
      await this.dispatchSegment(complete);
    }
  }

  /** 首个完整分句按"是否还有后续"裁决，其余一律 stream。
   *  异步：垫词(interim)与真实回复正文之间留一个可感知的间隔。 */
  private async dispatchSegment(complete: string): Promise<void> {
    if (!this.firstHandled && this.heldFirst === null) {
      // 这是整段回复的第一个完整分句：先按住，等后续内容再决定是否作垫词
      this.heldFirst = complete;
      return;
    }
    if (this.heldFirst !== null) {
      // 已有被按住的首句 + 现在来了后续分句 → 首句补发为垫词(interim)，
      // 中间停顿一下，再开始逐字输出真实回复正文（模拟真人先应一句再开口）。
      this.emit(this.heldFirst, "interim");
      this.heldFirst = null;
      this.firstHandled = true;
      if (this.interimReplyGapMs > 0) {
        await sleep(this.interimReplyGapMs);
        if (this.disposed) return;
      }
      this.emit(complete, "stream");
      return;
    }
    // 首句已裁决 → 后续分句一律走正文
    this.emit(complete, "stream");
  }

  /** 从缓冲中找第一个完整句子的边界下标（不含则 -1）。
   *
   * 硬边界：句号/感叹号/问号/分号/换行（。！？!?；;\n）—— 命中即切。
   * 软边界：当缓冲长度 > COMMA_SOFT_LEN、且前缀里已有 >= COMMA_SOFT_COUNT 个逗号时，
   * 逗号（，,）也算边界。真人说话会在长句中间换气，逗号软边界能把超长并列、
   * 列表说明（"1.xxx，2.yyy，3.zzz"）等更自然地拆开，而不是一口气吞下几十字。
   */
  private findBoundary(buf: string): number {
    const COMMA_SOFT_LEN = 40;
    const COMMA_SOFT_COUNT = 2;
    let commaCount = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (SEGMENT_BOUNDARY_RE.test(ch)) return i;
      if (ch === "，" || ch === ",") {
        commaCount += 1;
        if (i + 1 >= COMMA_SOFT_LEN && commaCount >= COMMA_SOFT_COUNT) return i;
      }
    }
    return -1;
  }
}