/**
 * AgentResultCard 标记生成器
 *
 * 把 LLM 的小汇报场景输出（对话 + 列表 + 追问）切成：
 *   [前导对话] [AGENT_RESULT_CARD 标记] [追问/结尾]
 * 三段拼接。卡片在中间，前后的对话正文保留。
 *
 * 前端 parser 见 client/flutter_app/lib/core/utils/agent_result_parser.dart
 * 卡片 UI   见 client/flutter_app/lib/features/chat/agent_result_card.dart
 *
 * 协议输出示例：
 * ```
 * 好的，耳机已下单，预计周六送达。
 *
 * [AGENT_RESULT_CARD_START]
 * {"title":"周末行程已为你规划","items":[{"type":"check","text":"周六上午：...勾...新店探店"}],"footer":"需要调整吗？"}
 * [AGENT_RESULT_CARD_END]
 *
 * 需要调整吗？
 * ```
 *
 * 设计要点：
 *   - 整段 ≤300 字，且列表段（连续列表行）长度符合 3-7 条
 *   - 解析失败（拿不到可切列表段）时返回 null，调用方回退到 plain
 *   - LLM 主动声明锚点的升级点：把 `findExtractableCardSegment` 换成锚点识别即可
 */

import { LIST_ITEM_RE } from "./render-hint-service.js";

/** 列表项类型推断 */
const CHECK_HINT_RE = /已完成|已为你|已帮你|已设置|已创建|已规划|✓|✔|成功/i;
const WARN_HINT_RE = /警告|注意|失败|异常|未完成|pending|⚠|!/i;

/** 卡片最大列表条数（超过不切，避免和小汇报场景冲突） */
const MAX_CARD_ITEMS = 7;
/** 卡片最小列表条数 */
const MIN_CARD_ITEMS = 3;

interface AgentResultPayload {
  avatar: string;
  avatarStyle: string;
  title: string;
  items: Array<{ type: string; text: string }>;
  footer: string;
}

export interface CardSegment {
  /** 卡片段（不含 marker 外壳） */
  title: string;
  items: string[];
  footer: string;
  /** 卡片在原文本中的起止行号（含前后空行） */
  startLine: number;
  endLine: number;
}

/**
 * 探测文本中是否存在可切出的列表汇报段。
 * 要求：连续 3-7 条列表行（中间允许至多 1 行非列表短句作为列表标题/说明）
 */
export function findExtractableCardSegment(text: string): CardSegment | null {
  const lines = text.split(/\r?\n/);
  const listLineIdx: number[] = [];
  lines.forEach((raw, i) => {
    if (LIST_ITEM_RE.test(raw.trim())) listLineIdx.push(i);
  });

  if (listLineIdx.length < MIN_CARD_ITEMS || listLineIdx.length > MAX_CARD_ITEMS) {
    return null;
  }

  // 找出最长的"连续列表行窗口"，中间允许 ≤1 行非列表短句（≤20 字）作为过渡
  let bestStart = -1;
  let bestEnd = -1;
  let i = 0;
  while (i < listLineIdx.length) {
    let j = i;
    let lastListLine = listLineIdx[i];
    while (j + 1 < listLineIdx.length) {
      const cur = listLineIdx[j];
      const next = listLineIdx[j + 1];
      const gap = next - cur - 1;
      // 连续（gap=0）必然继续
      if (gap === 0) {
        lastListLine = next;
        j++;
        continue;
      }
      // gap=1 且中间那行是短过渡（≤20 字非列表）→ 跳过
      if (gap === 1) {
        const midLine = lines[cur + 1]?.trim() ?? "";
        if (midLine && midLine.length <= 20 && !LIST_ITEM_RE.test(midLine)) {
          lastListLine = next;
          j++;
          continue;
        }
      }
      break;
    }
    const windowLen = j - i + 1;
    const bestLen = bestEnd - bestStart + 1;
    if (windowLen > bestLen) {
      bestStart = i;
      bestEnd = j;
    }
    i = j + 1;
  }

  if (bestStart === -1) return null;

  const startLine = listLineIdx[bestStart];
  const endLine = listLineIdx[bestEnd];

  // 在列表段之前找 title：向前最多 3 行内的非空、非列表短句
  const titleLines: string[] = [];
  for (let k = startLine - 1; k >= Math.max(0, startLine - 3); k--) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    titleLines.unshift(ln);
  }
  const title = titleLines[0] ?? "";

  // 在列表段之后找 footer：向后最多 2 行内的非空、非列表短句
  const footerLines: string[] = [];
  for (let k = endLine + 1; k < Math.min(lines.length, endLine + 3); k++) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    footerLines.push(ln);
  }
  const footer = footerLines[0] ?? "";

  // 提取 items 文本（剥前缀）
  const items: string[] = [];
  for (let k = startLine; k <= endLine; k++) {
    const raw = lines[k]?.trim() ?? "";
    const m = raw.match(LIST_ITEM_RE);
    if (m) {
      items.push(raw.slice(m[0].length).trim());
    }
  }

  if (items.length < MIN_CARD_ITEMS) return null;

  return {
    title,
    items,
    footer,
    startLine,
    endLine,
  };
}

/**
 * 把小汇报场景文本切成「前导 + 卡片标记 + 追问」三段。
 * @returns 拼接后的字符串；若无法切出卡片返回 null
 */
export function formatAgentResultForChat(text: string): string | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return null;

  const segment = findExtractableCardSegment(trimmed);
  if (!segment) return null;

  const lines = trimmed.split(/\r?\n/);

  // 1) 前导：startLine 之前的所有非空行
  const leadingLines: string[] = [];
  for (let k = 0; k < segment.startLine; k++) {
    const ln = lines[k]?.trim() ?? "";
    if (ln) leadingLines.push(ln);
  }

  // 2) 追问：endLine 之后的所有非空行
  const trailingLines: string[] = [];
  for (let k = segment.endLine + 1; k < lines.length; k++) {
    const ln = lines[k]?.trim() ?? "";
    if (ln) trailingLines.push(ln);
  }

  // items 类型推断
  const items = segment.items.map((itemText) => {
    let type = "num";
    if (CHECK_HINT_RE.test(itemText)) {
      type = "check";
    } else if (WARN_HINT_RE.test(itemText)) {
      type = "warn";
    }
    return { type, text: itemText };
  });

  const payload: AgentResultPayload = {
    avatar: "NB",
    avatarStyle: "default",
    title: segment.title,
    items,
    footer: segment.footer,
  };

  const json = JSON.stringify(payload);
  const cardBlock = `[AGENT_RESULT_CARD_START]\n${json}\n[AGENT_RESULT_CARD_END]`;

  const parts: string[] = [];
  if (leadingLines.length) parts.push(leadingLines.join("\n"));
  parts.push(cardBlock);
  if (trailingLines.length) parts.push(trailingLines.join("\n"));

  return parts.join("\n\n");
}
