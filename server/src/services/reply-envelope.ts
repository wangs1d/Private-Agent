/**
 * 回复信封（reply blocks）—— A 阶段协议层。
 *
 * 把 finalText 里的 [AGENT_RESULT_CARD_START/END] 标记**在服务端**确定性拆成
 * 结构化块序列，随 chat.assistant_done 的可选 `blocks` 字段下发：
 *
 *   blocks: [
 *     { type: "text", text: "好的，耳机已下单，预计周六送达。" },
 *     { type: "card", card: { title, items, footer, cardType, actions, ... } },
 *     { type: "media", groupTitle, sideA, sideB, cards: [ 媒体卡同构 ] },
 *     { type: "text", text: "需要调整吗？" }
 *   ]
 *
 * 设计要点：
 *   - **text 仍是唯一事实源**：blocks 是标记文本的确定性派生视图（同一份内容
 *     两种编码），不做双写、不会分叉。旧客户端忽略 blocks、照旧解析文本标记；
 *     新客户端优先 blocks，文本标记成为惰性备份——解析漂移与标记泄漏双消除。
 *   - **媒体块统一编入（v2，2026-09-18）**：blocks 原先只承载 text/card，照片走
 *     独立的 renderBlocks/mediaCards 字段——同一回复两套互不知情的版式视图，
 *     客户端按优先级取其一，必然丢另一份的内容（「带卡回复照片消失」的根源）。
 *     现在 media 块按既有交错锚定编入 blocks，一条序列承载全部版式语义。
 *     兼容性：v1 客户端对未知块类型静默跳过，其表现与升级前一致（带卡回复本就
 *     丢照片），无回归；renderBlocks/mediaCards 字段照常下发，供旧客户端与
 *     历史消息（blocks 不落盘）回退。
 *   - **降级判定**（返回 null → 不下发 blocks，前端走既有文本解析）：
 *     · 纯文本（无卡片标记且无媒体）——无增益，省字节；
 *     · 含 v1 未支持的标记（RENDER_AS / DATA_BRIEF / VIDEO / CHAT_MEDIA /
 *       CONTENT_SUMMARY_V2）——这些形态前端文本解析已正确工作，宁可不下发
 *       也不半拆；
 *     · 任一卡片 JSON 解析失败——整体降级，不 partially 下发。
 *   - 历史消息无需迁移：blocks 可从已存的 text 重新派生，客户端对历史消息
 *     走既有文本解析路径。
 *
 * 前端消费：message.replyBlocks（见 message_body_renderer.dart 的 blocks 分支）。
 */

import type { MediaCardItem, RenderBlock } from "./tool-result-processor.js";

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

/**
 * 媒体块（v2）：与 renderBlocks 的 media 块同构——一组照片/视频及其分组元数据。
 * groupTitle/sideA/sideB 缺省表示无维度的小簇照片（前端走轻量内联行渲染）。
 */
export interface ReplyMediaBlock {
  type: "media";
  groupTitle?: string;
  sideA?: string;
  sideB?: string;
  cards: MediaCardItem[];
}


export type ReplyBlock = ReplyTextBlock | ReplyCardBlock | ReplyMediaBlock;

const CARD_START = "[AGENT_RESULT_CARD_START]";
const CARD_END = "[AGENT_RESULT_CARD_END]";

/** v1 信封不支持的标记：命中任一 → 整体降级为文本解析 */
const UNSUPPORTED_MARKERS = [
  "[RENDER_AS:",
  "[DATA_BRIEF_START]",
  "[VIDEO_MEDIA_START]",
  "[CHAT_MEDIA_START]",
  "[CONTENT_SUMMARY_V2_START]",
  "[IMAGE_RESULT_START]",
];

/**
 * 剥模型输出的 [RENDER_HINT:xxx] 声明（根源收口，2026-09-17）。
 *
 * RENDER_HINT 是「模型→服务器」的展示形态信号：服务器在 processAssistantText
 * 消费它做渲染路由后，它就不该再存在于任何下发文本里——客户端没有它的
 * 消费者，残留只会被当字面文本漏到用户屏幕（历史教训：任务面/HTTP 重答等
 * 不走 processAssistantText 的路径曾经漏出）。渲染令牌（RENDER_AS 等）由
 * 服务器权威注入，此处不动。
 */
export function stripRenderHintDeclarations(text: string): string {
  if (!text.includes("[RENDER_HINT:")) return text ?? "";
  const kept: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const stripped = line.replace(/\[RENDER_HINT:[A-Za-z_]+\]/g, "");
    // 声明独占一行 → 整行删除；行内嵌声明 → 就地剥离保留其余文本
    if (!stripped.trim() && line.trim()) continue;
    kept.push(stripped);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 卡片版式归一化：总览卡置首、行程卡置尾、正文居中（2026-09-17 用户需求）。
 * 同时作为回复文本的出口收口之一：先剥 RENDER_HINT 声明，再重排卡片。
 *
 * 回复含卡片时的版式固定为：
 *   [模型总览卡（Day 概览/要点等，首位）] → [正文散文（原顺序）] → [travel_itinerary 行程卡（尾部）]
 *
 * 行为：
 *   - 剥全部 [RENDER_HINT:xxx] 声明（独占行整行删、行内就地剥）；
 *   - 非行程卡稳定提到最前（首位总览卡），散文按原顺序居中，
 *     行程卡稳定放在最后（尾部独立规划卡）；
 *   - 卡块 JSON 解析失败或标记残缺时不重组（原样返回声明剥离后的文本，
 *     交由既有降级路径）；
 *   - 无卡片块时仅返回声明剥离后的文本（零额外开销）。
 */
export function normalizeReplyCardLayout(text: string): string {
  const source = stripRenderHintDeclarations(text ?? "");
  if (!source.includes(CARD_START)) return source;

  const proseSegments: string[] = [];
  const genericCards: string[] = [];
  const travelCards: string[] = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(CARD_START, cursor);
    if (start === -1) break;
    const end = source.indexOf(CARD_END, start + CARD_START.length);
    if (end === -1) return source; // 残缺标记：不重组

    const before = source.slice(cursor, start).trim();
    if (before) proseSegments.push(before);
    const rawBlock = source.slice(start, end + CARD_END.length);
    const rawJson = source.slice(start + CARD_START.length, end).trim();
    let card: unknown;
    try {
      card = JSON.parse(rawJson);
    } catch {
      return source; // JSON 不可解析：不重组
    }
    if (!card || typeof card !== "object" || Array.isArray(card)) return source;
    if ((card as Record<string, unknown>).cardType === "travel_itinerary") {
      travelCards.push(rawBlock);
    } else {
      genericCards.push(rawBlock);
    }
    cursor = end + CARD_END.length;
  }
  const tail = source.slice(cursor).trim();
  if (tail) proseSegments.push(tail);
  if (genericCards.length + travelCards.length === 0) return source;

  return [...genericCards, ...proseSegments, ...travelCards].join("\n\n").trim();
}

/**
 * 把带卡片标记的回复文本拆成结构化块序列（v2 统一序列）。
 * 返回 null 表示本轮不下发 blocks（前端回退文本解析），见文件头降级判定。
 *
 * @param finalText 归一化后的回复正文（卡片标记嵌在文本里）
 * @param mediaSegments 可选；同一 finalText 构建出的「文字+媒体」交错序列
 *   （即 renderBlocks，其 text 段里仍嵌着卡片标记）。传入时以它为基底：
 *   media 段原样编入，text 段再析出卡片——一条序列同时承载 文字/卡片/照片
 *   的版式语义，客户端不再需要跨字段拼接（「带卡回复照片消失」的根治）。
 *   缺省时退化为 v1 纯 text/card 拆分（无媒体回复，行为不变）。
 */
export function buildReplyBlocks(
  finalText: string,
  mediaSegments?: RenderBlock[],
): ReplyBlock[] | null {
  const text = finalText ?? "";

  // v2：媒体在场 → 以交错序列为基底层析卡片标记
  if (mediaSegments && mediaSegments.length > 0) {
    const blocks: ReplyBlock[] = [];
    for (const seg of mediaSegments) {
      if (seg.type === "media") {
        blocks.push({
          type: "media",
          ...(seg.groupTitle ? { groupTitle: seg.groupTitle } : {}),
          ...(seg.sideA ? { sideA: seg.sideA } : {}),
          ...(seg.sideB ? { sideB: seg.sideB } : {}),
          cards: seg.cards,
        });
        continue;
      }
      // text 段：扫卡片标记；残缺标记/坏 JSON → 整体降级（与 v1 同口径）
      const scanned = scanCardSegments(seg.text);
      if (scanned === null) return null;
      blocks.push(...scanned);
    }
    return blocks.length > 0 ? blocks : null;
  }

  // v1：无媒体的纯 text/card 拆分
  if (!text.includes(CARD_START)) return null;
  const blocks = scanCardSegments(text);
  return blocks && blocks.length > 0 ? blocks : null;
}

/**
 * 把一段文本按卡片标记切成 text/card 块序列。
 * 含 v1 未支持的标记（RENDER_AS/DATA_BRIEF/…）或卡片 JSON 不可解析时返回
 * null——调用方整体降级，绝不 partially 下发。
 */
function scanCardSegments(text: string): ReplyBlock[] | null {
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

  return blocks;
}

/**
 * 纯文本渠道编码器（能力协商的 plain 端）。
 *
 * 根因修正：此前微信桥等纯文本渠道走"整条链路 plainTextMode 禁卡"，与富文本
 * 渠道是两套处理逻辑（chat-turn-runner 双重处理）。现在统一为一条富管线出卡，
 * 纯文本渠道在出口处降级序列化：
 *   - [RENDER_HINT:xxx] / [RENDER_AS:xxx] 标记行 → 剥掉；
 *   - [AGENT_RESULT_CARD_START]{json}[END] → 还原为「标题 + 条目 + 脚注」纯文本；
 *   - [IMAGE_RESULT_START]{json}[END] → 还原为「· 描述」逐行文本（照片 URL 不透出）；
 *   - DATA_BRIEF / VIDEO / CHAT_MEDIA / CONTENT_SUMMARY 块 → 尽量取可读字段，
 *     解析失败整块丢弃（绝不透出原始 JSON）。
 */
export function stripMarkersToPlainText(text: string): string {
  let out = text ?? "";

  // 1. 卡片块 → 可读纯文本
  const cardRe =
    /\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g;
  out = out.replace(cardRe, (_m, rawJson: string) => cardToPlainText(String(rawJson)));

  // 1.5 识图照片卡 → 只留每张的描述行（URL 对纯文本端无意义）
  const photoRe = /\[IMAGE_RESULT_START\]([\s\S]*?)\[IMAGE_RESULT_END\]/g;
  out = out.replace(photoRe, (_m, rawJson: string) => {
    try {
      const parsed = JSON.parse(String(rawJson).trim()) as { items?: unknown };
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const lines: string[] = [];
      for (const it of items) {
        const cap = it && typeof it === "object" ? (it as Record<string, unknown>).caption : "";
        if (typeof cap === "string" && cap.trim()) lines.push(`· ${cap.trim()}`);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  });

  // 2. 其他 JSON 块（data_brief/video/summary/chat_media）→ 可读字段或丢弃
  const blockRe = /\[(?:DATA_BRIEF_START|VIDEO_MEDIA_START|CHAT_MEDIA_START|CONTENT_SUMMARY_V2_START)\]([\s\S]*?)\[(?:DATA_BRIEF_END|VIDEO_MEDIA_END|CHAT_MEDIA_END|CONTENT_SUMMARY_V2_END)\]/g;
  out = out.replace(blockRe, (_m, rawJson: string) => blockToPlainText(String(rawJson)));

  // 3. 标记行剥除（RENDER_HINT / RENDER_AS / 残留孤立标记）
  out = out
    .split("\n")
    .filter((line) => !/^[ \t]*\[(?:RENDER_HINT:[A-Za-z_]+|RENDER_AS:[A-Za-z_]+)\][ \t]*$/.test(line))
    .join("\n");
  out = out.replace(
    /\[(?:RENDER_HINT:[A-Za-z_]+|RENDER_AS:[A-Za-z_]+|AGENT_RESULT_CARD_START|AGENT_RESULT_CARD_END|DATA_BRIEF_START|DATA_BRIEF_END|VIDEO_MEDIA_START|VIDEO_MEDIA_END|CHAT_MEDIA_START|CHAT_MEDIA_END|CONTENT_SUMMARY_V2_START|CONTENT_SUMMARY_V2_END|IMAGE_RESULT_START|IMAGE_RESULT_END)\]/g,
    "",
  );

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 卡片 JSON → 「标题 / 条目 / 脚注」纯文本；解析失败返回空串（整块丢弃） */
function cardToPlainText(rawJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const obj = parsed as Record<string, unknown>;
  const lines: string[] = [];
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (title) lines.push(title);
  if (Array.isArray(obj.items)) {
    for (const it of obj.items) {
      if (typeof it === "string" && it.trim()) {
        lines.push(`· ${it.trim()}`);
        continue;
      }
      if (!it || typeof it !== "object") continue;
      const text = (it as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) lines.push(`· ${text.trim()}`);
    }
  }
  const footer = typeof obj.footer === "string" ? obj.footer.trim() : "";
  if (footer) lines.push(footer);
  return lines.join("\n");
}

/** 其他结构化块 → 尽量取 title/text/notes 可读字段；解析失败丢弃 */
function blockToPlainText(rawJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["title", "summary", "content", "text"] as const) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  if (Array.isArray(obj.notes)) {
    for (const n of obj.notes) {
      if (typeof n === "string" && n.trim()) parts.push(n.trim());
    }
  }
  return parts.join("\n");
}
