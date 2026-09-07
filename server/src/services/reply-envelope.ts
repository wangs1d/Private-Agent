/**
 * 回复信封（reply blocks）—— A 阶段协议层。
 *
 * 把 finalText 里的 [AGENT_RESULT_CARD_START/END] 标记**在服务端**确定性拆成
 * 结构化块序列，随 chat.assistant_done 的可选 `blocks` 字段下发：
 *
 *   blocks: [
 *     { type: "text", text: "好的，耳机已下单，预计周六送达。" },
 *     { type: "card", card: { title, items, footer, cardType, actions, ... } },
 *     { type: "text", text: "需要调整吗？" }
 *   ]
 *
 * 设计要点：
 *   - **text 仍是唯一事实源**：blocks 是标记文本的确定性派生视图（同一份内容
 *     两种编码），不做双写、不会分叉。旧客户端忽略 blocks、照旧解析文本标记；
 *     新客户端优先 blocks，文本标记成为惰性备份——解析漂移与标记泄漏双消除。
 *   - **降级判定**（返回 null → 不下发 blocks，前端走既有文本解析）：
 *     · 纯文本（无卡片标记）——无增益，省字节；
 *     · 含 v1 未支持的标记（RENDER_AS / DATA_BRIEF / VIDEO / CHAT_MEDIA /
 *       CONTENT_SUMMARY_V2）——这些形态前端文本解析已正确工作，宁可不下发
 *       也不半拆；
 *     · 任一卡片 JSON 解析失败——整体降级，不 partially 下发。
 *   - 历史消息无需迁移：blocks 可从已存的 text 重新派生，客户端对历史消息
 *     走既有文本解析路径。
 *
 * 前端消费：message.replyBlocks（见 message_body_renderer.dart 的 blocks 分支）。
 */

/** 文本块：一段普通正文（内联 markdown，前端按既有正文样式渲染） */
export interface ReplyTextBlock {
  type: "text";
  text: string;
}

/** 卡片块：card 即 AgentResultFormatter 的 AgentResultPayload（前端直接建卡） */
export interface ReplyCardBlock {
  type: "card";
  card: Record<string, unknown>;
}

export type ReplyBlock = ReplyTextBlock | ReplyCardBlock;

const CARD_START = "[AGENT_RESULT_CARD_START]";
const CARD_END = "[AGENT_RESULT_CARD_END]";

/** v1 信封不支持的标记：命中任一 → 整体降级为文本解析 */
const UNSUPPORTED_MARKERS = [
  "[RENDER_AS:",
  "[DATA_BRIEF_START]",
  "[VIDEO_MEDIA_START]",
  "[CHAT_MEDIA_START]",
  "[CONTENT_SUMMARY_V2_START]",
];

/**
 * 把带卡片标记的回复文本拆成结构化块序列。
 * 返回 null 表示本轮不下发 blocks（前端回退文本解析），见文件头降级判定。
 */
export function buildReplyBlocks(finalText: string): ReplyBlock[] | null {
  const text = finalText ?? "";
  if (!text.includes(CARD_START)) return null;
  if (UNSUPPORTED_MARKERS.some((m) => text.includes(m))) return null;

  const blocks: ReplyBlock[] = [];
  let cursor = 0;
  while (true) {
    const start = text.indexOf(CARD_START, cursor);
    if (start === -1) break;
    const end = text.indexOf(CARD_END, start + CARD_START.length);
    if (end === -1) return null; // 残缺标记 → 整体降级

    const before = text.slice(cursor, start).trim();
    if (before) blocks.push({ type: "text", text: before });

    const rawJson = text.slice(start + CARD_START.length, end).trim();
    let card: unknown;
    try {
      card = JSON.parse(rawJson);
    } catch {
      return null; // 卡片 JSON 不可解析 → 整体降级，不 partially 下发
    }
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    blocks.push({ type: "card", card: card as Record<string, unknown> });

    cursor = end + CARD_END.length;
  }

  const tail = text.slice(cursor).trim();
  if (tail) blocks.push({ type: "text", text: tail });

  return blocks.length > 0 ? blocks : null;
}
