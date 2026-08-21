import { stripSentencesAlreadySaid } from "../utils/text.js";

/**
 * StreamSegmenter —— 主回复统一分段器（垫词 + 信息块分段 + 增量去重）
 *
 * 设计动机（GPT live 式真人节奏，2026-08-20 合并为单一模块）：
 * - 垫词不再由独立 LLM / 独立控制器生成（避免与正文脱节、重复），而是主回复
 *   流式输出的一部分：首个分句被"按住"为垫词(interim)候选，确认有后续内容时
 *   才作为独立气泡发出；若整段只有一句则作普通正文(stream)单个气泡。
 * - 按"信息块"（同话题连贯短句）分段，而非机械逐句分段：能在一 个气泡里放完的
 *   内容不强拆，避免内容冗余；只有话题转换 / 段落换行 / 列表编号 / 达到目标长度
 *   时才切新块。
 * - 段落间增量去重：每个块在推送前剔除与已推送句级重复的内容，保证层层递进不重复。
 * - 重量上限：正文块数封顶，超限内容并入一个尾部块，防止分段过多造成"刷屏"。
 * - 首段做结论锚：开头的第一个信息块承载直接回应/结论，不因细碎切分被打散；
 *   后续块才展开细节——先结论后论据，天然递进。
 *
 * 关键正确性约束（杜绝"垫词 + 正文 + done 全文"三者重复）：
 * 1. 首个分句独立成垫词候选，只有确认主回复还有后续时才发；否则并入正文单气泡。
 * 2. 每次发射前用累积的已推送文本做句级去重，残留重复句直接剔除。
 */
export type StreamSegmenterOptions = {
  /** 块间停顿（毫秒），用于模拟真人说话节奏。默认 100ms。 */
  pauseMs?: number;
  /** 最小句子长度（字符），低于该长度的纯标点碎片不单独成块。默认 6。 */
  minSegmentChars?: number;
  /** 垫词(interim)气泡与真实回复正文之间的间隔（毫秒），
   *  模拟真人先应一句、稍作停顿再开口细说的节奏。默认 800ms。 */
  interimReplyGapMs?: number;
  /**
   * 是否启用信息块分段。默认 true。
   * - true：按信息块切分（同话题短句合并），逐块推送（带块间停顿），模拟真人聊天节奏。
   * - false：不透传分段，全部内容累积后在 flushFinal 一次性推为 stream 段。
   */
  segmentationEnabled?: boolean;
  /** 信息块目标字符数：同话题短句一直累积到接近该长度才切新块。默认 56。 */
  blockCharTarget?: number;
  /** 正文信息块数量上限（重量上限）：超出后剩余内容并入尾部块。默认 4。 */
  maxStreamSegments?: number;
};

/** 句子 / 段落边界：中文/英文句末标点与换行。 */
const SEGMENT_BOUNDARY_RE = /[。！？!?；;\n]/u;

/** 话题转换连词：句首命中则视为开启新的信息块。 */
const TOPIC_SHIFT_RE =
  /^(而|但|另|不过|然而|且|同时|另外|此外|还有|至于|再|继而|接着|然后|随后|最后|首先|其次|总之|综上|因此|所以|于是|结果|关于|对于|说到|回到|总而言之|换句话说)/u;

/** 列表 / 编号起始：句首命中则视为独立信息块。 */
const LIST_ITEM_BREAK_RE =
  /^\s*(?:[（(]?\d+[\.、)）]|[一二三四五六七八九十]+[\.、)）]|[-*•])\s*/u;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StreamSegmenter {
  private buffer = "";
  /** 当前正在累积的信息块（同话题连贯内容，尚未到切块时机）。 */
  private blockBuffer = "";
  /** 超出重量上限后并入的尾部块（最后一次性输出）。 */
  private tailBuffer = "";
  private minSegmentChars: number;
  private pauseMs: number;
  /** 垫词与真实回复正文之间的间隔 */
  private interimReplyGapMs: number;
  /** 是否启用信息块分段 */
  private segmentationEnabled: boolean;
  /** 信息块目标字符数 */
  private blockCharTarget: number;
  /** 正文信息块数量上限 */
  private maxStreamSegments: number;
  /** 串行队列：保证 feed 的异步停顿不交错、乱序 */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 首个分句：先按住，等判定主回复是否还有其他内容再决定如何分发（垫词候选）。 */
  private heldFirst: string | null = null;
  /** 垫词是否已裁决并消耗。保证整条回复只产生一个垫词：
   *  首句按为空后，后续信息块的句首不再被重复当成垫词候选。 */
  private interimDone = false;
  /** 已推送正文块的数量（用于重量上限）。 */
  private streamBlockCount = 0;
  /** 累积的已推送文本，用于句级增量去重。 */
  private emittedText = "";

  constructor(
    private readonly emit: (segment: string, phase: "interim" | "stream") => void,
    opts: StreamSegmenterOptions = {},
  ) {
    this.pauseMs = opts.pauseMs ?? 100;
    this.minSegmentChars = opts.minSegmentChars ?? 6;
    this.interimReplyGapMs = opts.interimReplyGapMs ?? 800;
    this.segmentationEnabled = opts.segmentationEnabled ?? true;
    this.blockCharTarget = opts.blockCharTarget ?? 56;
    this.maxStreamSegments = opts.maxStreamSegments ?? 4;
  }

  /**
   * 喂入新的流式 delta，累积并按信息块切分，逐块推送给 emit。
   * 未闭合的半截文本留在缓冲/当前块中，等待后续 delta 或 flushFinal。
   * 异步串行：块间停顿走 setTimeout，不阻塞事件循环。
   */
  feed(delta: string): void {
    if (!delta || this.disposed) return;
    this.buffer += delta;
    this.chain = this.chain
      .then(() => this.flushCompleteBlocks())
      .catch((err) => {
        console.error("[StreamSegmenter] feed 异常:", err);
      });
  }

  /**
   * 主回复流结束时调用：把缓冲中剩余的文本（含当前块与尾部块）作为最后内容推送。
   * - 启用分段时：裁决首句垫词 + 推送剩余正文
   * - 禁用分段时：整个缓冲作为 single stream 段直接推送
   * 这里是"垫词 + done 全文"重复的最后防线，统一做句级去重。
   */
  async flushFinal(): Promise<void> {
    await this.chain;
    if (this.disposed) return;
    const rest = (this.buffer + this.blockBuffer).trim();
    this.buffer = "";
    this.blockBuffer = "";

    const combined = (rest + this.tailBuffer).trim();
    this.tailBuffer = "";

    if (!this.segmentationEnabled) {
      // 不分段模式：整个缓冲作为一段 stream 发出，无首句裁决
      if (combined) this.emit(combined, "stream");
      return;
    }

    // 分段模式：裁决首句 + 推送剩余正文
    if (this.heldFirst !== null) {
      const first = this.heldFirst;
      this.heldFirst = null;
      this.interimDone = true;
      if (first === combined) {
        // 整段回复只有这一句：作为单个正文气泡发出，避免"垫词 + done 全文"重复
        this.trackEmitted(first);
        this.emit(first, "stream");
      } else {
        // 有首个分句 + 剩余内容 → 首个作垫词，间隔后剩余作正文（再做句级去重）
        const body = stripSentencesAlreadySaid(first, combined).trim();
        this.trackEmitted(first);
        this.emit(first, "interim");
        if (this.interimReplyGapMs > 0) {
          await sleep(this.interimReplyGapMs);
          if (this.disposed) return;
        }
        if (body) {
          this.trackEmitted(body);
          this.emit(body, "stream");
        }
      }
      return;
    }

    if (combined) {
      const deduped = stripSentencesAlreadySaid(this.emittedText, combined).trim();
      if (deduped) {
        this.trackEmitted(deduped);
        this.emit(deduped, "stream");
      }
    }
  }

  /** 丢弃缓冲并停止后续推送（例如 turn 过期）。 */
  discard(): void {
    this.disposed = true;
    this.buffer = "";
    this.blockBuffer = "";
    this.tailBuffer = "";
    this.heldFirst = null;
    this.interimDone = false;
  }

  /** 按信息块逐块分发：每个完整语义块单独作为一段，串行、带块间停顿。
   *  禁用分段时直接返回，不切块。 */
  private async flushCompleteBlocks(): Promise<void> {
    if (!this.segmentationEnabled) return;
    while (!this.disposed) {
      const brk = this.findBoundary(this.buffer);
      if (brk < 0) break; // 暂无完整句子
      const sentence = this.buffer.slice(0, brk + 1);
      this.buffer = this.buffer.slice(brk + 1);
      const raw = sentence.trim();
      if (!raw) continue;
      // 纯标点/无实际内容的碎片（如单个"。"或"！"）不单独成块，直接跳过；
      // 含汉字/字母/数字的短句（如"好的。"）是真实短句，照常参与信息块。
      if (
        raw.length < this.minSegmentChars &&
        !/[A-Za-z0-9\u4e00-\u9fa5]/.test(raw)
      ) {
        continue;
      }
      // 首个分句按住为垫词候选（仅整条回复第一次：垫词恰好一个）
      if (this.heldFirst === null && !this.interimDone) {
        this.heldFirst = raw;
        continue;
      }
      // 判定是否切新块（话题转换 / 段落换行 / 列表编号 / 块已达到目标长度）
      const shouldBreak = this.shouldBreakBlock(this.blockBuffer, raw);
      if (shouldBreak) {
        await this.emitCurrentBlock();
        if (this.disposed) return;
        this.blockBuffer = raw;
      } else {
        this.blockBuffer += raw;
      }
      // 块达到目标长度 → 提前终结当前块（同话题内容也控制单块体量）
      if (this.blockBuffer.length >= this.blockCharTarget) {
        await this.emitCurrentBlock();
        if (this.disposed) return;
      }
    }
  }

  /** 判断是否应开启新的信息块。 */
  private shouldBreakBlock(acc: string, next: string): boolean {
    if (!acc) return false;
    // 段落换行
    if (/^\s*\n/.test(next)) return true;
    // 列表项 / 编号起始
    if (LIST_ITEM_BREAK_RE.test(next)) return true;
    // 话题转换连词起始
    if (TOPIC_SHIFT_RE.test(next)) return true;
    return false;
  }

  /** 把当前累积的信息块发射出去（去重 + 重量上限裁决 + 停顿）。 */
  private async emitCurrentBlock(): Promise<void> {
    const raw = this.blockBuffer.trim();
    this.blockBuffer = "";
    if (!raw) return;
    const deduped = stripSentencesAlreadySaid(this.emittedText, raw).trim();
    if (!deduped) return;
    if (this.pauseMs > 0) {
      await sleep(this.pauseMs);
      if (this.disposed) return;
    }
    await this.dispatchSegment(deduped);
  }

  /**
   * 分发一个信息块：
   * - 首个分句（heldFirst）在首个信息块到来时补发为垫词(interim)，间隔后再发正文；
   * - 其余信息块按顺序发为正文(stream)；
   * - 超过重量上限的正文并入尾部块，最后一次性输出（防刷屏）。
   */
  private async dispatchSegment(segment: string): Promise<void> {
    // 有被按住的首句 → 先发垫词，停顿后再发当前正文块
    if (this.heldFirst !== null) {
      const first = this.heldFirst;
      this.heldFirst = null;
      this.interimDone = true;
      this.trackEmitted(first);
      this.emit(first, "interim");
      if (this.interimReplyGapMs > 0) {
        await sleep(this.interimReplyGapMs);
        if (this.disposed) return;
      }
      this.trackEmitted(segment);
      this.emit(segment, "stream");
      this.streamBlockCount++;
      return;
    }
    // 重量上限：正文块数已达上限 → 并入尾部块，不再单开气泡
    if (this.streamBlockCount >= this.maxStreamSegments) {
      this.tailBuffer += segment;
      return;
    }
    this.trackEmitted(segment);
    this.emit(segment, "stream");
    this.streamBlockCount++;
  }

  /** 从缓冲中找第一个完整句子的边界下标（不含则 -1）。
   *
   * 硬边界：句号/感叹号/问号/分号/换行（。！？!?；;\n）—— 命中即切。
   * 软边界：当缓冲长度 > COMMA_SOFT_LEN、且前缀里已有 >= COMMA_SOFT_COUNT 个逗号时，
   * 逗号（，,）也算边界。真人说话会在长句中间换气，逗号软边界能把超长并列、
   * 列表说明（"1.xxx，2.yyy，3.zzz"）等更自然地拆开，而不是一口气吞下几十字。
   */

  /** 把新文本并入已推送文本，用于句级增量去重。 */
  private trackEmitted(text: string): void {
    if (!text) return;
    this.emittedText = this.emittedText ? `${this.emittedText} ${text}` : text;
  }

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