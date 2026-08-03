/**
 * 分次回复控制器
 *
 * 把一段完整文本按语义边界（段落 / 句号 / 换行）自适应切成 1~N 段，
 * 段间随机停顿推送，模拟真人"边想边说"的节奏。
 *
 * 设计要点：
 *  - 切分纯规则（不调 LLM），按字数 + 标点边界决策
 *  - 第一段立即推（用户已等够久了），后续段随机停顿 800~2500ms
 *  - 停顿期间检测 isCancelled（用户发了新消息打断）→ 立即停止后续段
 *  - 短消息（≤20 字）不切，直接 1 段发出，避免碎段
 */

/** 段落类型：interim（垫词首段）/ stream（主回复后续段） */
export type ReplyPhase = "interim" | "stream";

export interface PhasedReplyConfig {
  /** 推送单段文本的回调（复用现有 sendAssistantChunk 路径） */
  sendChunk: (text: string, phase: ReplyPhase) => void;
  /** 是否被取消（用户发新消息打断、turn 过期等） */
  isCancelled: () => boolean;
}

/** 段间停顿区间 */
const PAUSE_MIN_MS = 800;
const PAUSE_MAX_MS = 2500;

/** 短消息阈值：≤ 此字数直接 1 段发出 */
const SHORT_TEXT_THRESHOLD = 20;

/** 中等消息阈值：≤ 此字数最多切 2 段 */
const MEDIUM_TEXT_THRESHOLD = 60;

/** 每段最短字数，避免碎得太零散 */
const MIN_SEGMENT_CHARS = 15;

/** 最多段数上限，防止极端长文本被切得太碎 */
const MAX_SEGMENTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按语义边界把文本切成多段。
 * 规则：
 *  - ≤20 字：1 段
 *  - ≤60 字：按首个句末标点切 2 段
 *  - >60 字：按段落（\n\n）/ 句号边界切 2~4 段
 */
function splitIntoSegments(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 短消息不切
  if (trimmed.length <= SHORT_TEXT_THRESHOLD) {
    return [trimmed];
  }

  // 中等消息：按首个句末标点切 2 段
  if (trimmed.length <= MEDIUM_TEXT_THRESHOLD) {
    const match = trimmed.match(/^(.+?[。！？!?])/u);
    if (match && match[1].length >= MIN_SEGMENT_CHARS) {
      const rest = trimmed.slice(match[1].length).trim();
      return rest ? [match[1], rest] : [trimmed];
    }
    return [trimmed];
  }

  // 长消息：先按段落切，再按句号细分
  const paragraphs = trimmed.split(/\n{2,}/u).filter((p) => p.trim().length > 0);

  const segments: string[] = [];
  for (const para of paragraphs) {
    if (segments.length >= MAX_SEGMENTS) break;

    // 段落较短直接整段
    if (para.length <= MIN_SEGMENT_CHARS * 2) {
      segments.push(para.trim());
      continue;
    }

    // 段落较长按句号切
    const sentences = para
      .split(/(?<=[。！？!?])/u)
      .map((s) => s.trim())
      .filter(Boolean);

    // 把句子合并成满足最短长度的段
    let buffer = "";
    for (const sentence of sentences) {
      buffer += sentence;
      if (buffer.length >= MIN_SEGMENT_CHARS) {
        segments.push(buffer);
        buffer = "";
        if (segments.length >= MAX_SEGMENTS) break;
      }
    }
    if (buffer.trim()) {
      // 最后剩的句子并到上一段或单独成段
      if (segments.length > 0 && segments.length < MAX_SEGMENTS) {
        segments[segments.length - 1] += buffer;
      } else {
        segments.push(buffer.trim());
      }
    }
  }

  // 兜底：如果切不出来（无标点），整段返回
  return segments.length > 0 ? segments : [trimmed];
}

/**
 * 把一段完整文本按语义边界分次推送。
 * 第一段立即推，后续段随机停顿后推。
 * 停顿期间若 isCancelled 返回 true，立即停止后续段。
 */
export async function emitPhasedReply(
  fullText: string,
  config: PhasedReplyConfig,
): Promise<void> {
  const segments = splitIntoSegments(fullText);
  if (segments.length === 0) return;

  // 第一段立即推
  config.sendChunk(segments[0], "stream");

  // 后续段停顿后推
  for (let i = 1; i < segments.length; i++) {
    if (config.isCancelled()) return;

    const pause =
      PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
    await sleep(pause);

    if (config.isCancelled()) return;
    config.sendChunk(segments[i], "stream");
  }
}
