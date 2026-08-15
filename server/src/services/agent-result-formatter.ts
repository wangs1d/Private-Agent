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
  /**
   * 工具专用卡片类型：
   * weather / schedule / wallet / order / file / carousel / compare / timeline / media；
   * 空串=通用列表卡。
   * compare=左右对比卡、timeline=时间轴卡、media=图片结果卡。
   */
  cardType?: string;
  /** 底部抉择按钮（客户端渲染为 AgentActionChoiceCard，点击经 chat.user_action 回传） */
  actions?: Array<{ id: string; label: string; variant: string; payload: Record<string, unknown> }>;
  /** 卡片唯一 ID（点击按钮回传，便于后端定位上下文） */
  cardId?: string;
  /**
   * 语音播报优先级：high=语音端优先朗读结论，low=可跳过次要内容；空串=默认。
   * 供语音输出端（agent.voice.*）决定取舍。
   */
  speak?: string;
}

export interface CardSegment {
  /** 卡片段（不含 marker 外壳） */
  title: string;
  items: string[];
  footer: string;
  /** 卡片在原文本中的起止行号（含前后空行） */
  startLine: number;
  endLine: number;
  /** 标题行行号（用于在 leadingLines 中跳过，避免与卡片标题重复） */
  titleLine: number;
  /** 结尾行行号（用于在 trailingLines 中跳过，避免与卡片 footer 重复） */
  footerLine: number;
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
  let titleLineIdx = -1;
  for (let k = startLine - 1; k >= Math.max(0, startLine - 3); k--) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    titleLines.unshift(ln);
    if (titleLineIdx === -1) titleLineIdx = k;
  }
  const title = titleLines[0] ?? "";

  // 在列表段之后找 footer：向后最多 2 行内的非空、非列表短句
  const footerLines: string[] = [];
  let footerLineIdx = -1;
  for (let k = endLine + 1; k < Math.min(lines.length, endLine + 3); k++) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    footerLines.push(ln);
    if (footerLineIdx === -1) footerLineIdx = k;
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
    titleLine: titleLineIdx,
    footerLine: footerLineIdx,
  };
}

/**
 * 根据工具名推断工具专用卡片类型。
 * 命中则客户端按类型渲染专用 UI（天气/日程/钱包/订单/文件/搜索轮播，
 * 以及对比/时间轴/媒体），未命中返回空串 → 客户端渲染通用列表卡。
 */
export function inferCardType(toolName?: string): string {
  if (!toolName) return "";
  if (toolName.startsWith("weather.")) return "weather";
  if (toolName.includes("calendar") || toolName.includes("schedule")) return "schedule";
  if (toolName.startsWith("wallet.")) return "wallet";
  if (
    toolName.includes("order") ||
    toolName.includes("payment") ||
    toolName.includes("pay") ||
    toolName.includes("alipay")
  ) {
    return "order";
  }
  if (toolName.includes("file")) return "file";
  if (toolName === "search_web" || toolName.startsWith("info.")) return "carousel";
  // 新增：对比类（商品/方案 pk）、时间轴类（行程/计划）、媒体类（识图/图片结果）
  if (
    toolName.toLowerCase().includes("compare") ||
    toolName.toLowerCase().includes("pk") ||
    toolName.toLowerCase().includes("对比")
  ) {
    return "compare";
  }
  if (
    toolName.toLowerCase().includes("timeline") ||
    toolName.toLowerCase().includes("plan") ||
    toolName.toLowerCase().includes("行程")
  ) {
    return "timeline";
  }
  if (
    toolName.toLowerCase().includes("image") ||
    toolName.toLowerCase().includes("photo") ||
    toolName.toLowerCase().includes("vision") ||
    toolName.toLowerCase().includes("识图") ||
    toolName.toLowerCase().includes("图片")
  ) {
    return "media";
  }
  return "";
}

/** 结尾是否属于「征求用户确认」的问句（用于注入抉择按钮） */
const CONFIRM_QUESTION_RE =
  /[？?]\s*$|吗\s*$|呢\s*$|要不要|是否|需要.*(调整|修改|继续|确认|下单)|想不想要/i;

/** 结尾是否属于「多选/勾选」类（用于注入可选型按钮，variant=select） */
const SELECT_QUESTION_RE = /选哪|勾选|多选|任选|挑几个|要哪些|哪些合适|想要哪些|选几个/i;

/**
 * 当卡片结尾是确认问句时，注入通用抉择按钮（好的 / 不用了）。
 * 用户点击后 label 作为 user message 经 chat.user_action 回传，
 * Agent 据此衔接上下文继续执行。
 */
function inferConfirmActions(footer: string): Array<{
  id: string;
  label: string;
  variant: string;
  payload: Record<string, unknown>;
}> {
  if (!footer || !CONFIRM_QUESTION_RE.test(footer)) {
    return [];
  }
  return [
    { id: "confirm", label: "好的", variant: "primary", payload: {} },
    { id: "decline", label: "不用了", variant: "secondary", payload: {} },
  ];
}

/**
 * 当卡片结尾是「多选/勾选」类问句时，注入可选型按钮（variant=select）。
 * 客户端渲染为可勾选的多选框，用户可多项选择后提交（经 chat.user_action 回传）。
 */
function inferSelectActions(footer: string): Array<{
  id: string;
  label: string;
  variant: string;
  payload: Record<string, unknown>;
}> {
  if (!footer || !SELECT_QUESTION_RE.test(footer)) {
    return [];
  }
  return [
    { id: "select_confirm", label: "确认选择", variant: "primary", payload: { multiSelect: true } },
    { id: "select_cancel", label: "再想想", variant: "secondary", payload: { multiSelect: true } },
  ];
}

/**
 * 把小汇报场景文本切成「前导 + 卡片标记 + 追问」三段。
 * @param toolName 最近调用的工具名，用于推断专用卡片类型（cardType）
 * @returns 拼接后的字符串；若无法切出卡片返回 null
 */
export function formatAgentResultForChat(
  text: string,
  toolName?: string,
): string | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return null;

  const segment = findExtractableCardSegment(trimmed);
  if (!segment) return null;

  const lines = trimmed.split(/\r?\n/);

  // 1) 前导：startLine 之前的所有非空行
  //    跳过已经被卡片消费的 title 行，避免与卡片标题重复显示
  const leadingLines: string[] = [];
  for (let k = 0; k < segment.startLine; k++) {
    if (k === segment.titleLine) continue;
    const ln = lines[k]?.trim() ?? "";
    if (ln) leadingLines.push(ln);
  }

  // 2) 追问：endLine 之后的所有非空行
  //    跳过已经被卡片消费的 footer 行，避免与卡片 footer 重复显示
  const trailingLines: string[] = [];
  for (let k = segment.endLine + 1; k < lines.length; k++) {
    if (k === segment.footerLine) continue;
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

  const cardType = inferCardType(toolName);
  const confirmActions = inferConfirmActions(segment.footer);
  // 多选/勾选类：优先用可选型按钮替代确认按钮（两者互斥，Select 优先）
  const selectActions = inferSelectActions(segment.footer);
  const actions = selectActions.length ? selectActions : confirmActions;

  // 语音播报优先级：追问/结论句（问句或含"建议/注意/总之"）标记 high，语音端优先朗读
  const speak = /[？?]\s*$|吗\s*$|建议|推荐|注意|警告|总之|结论|提醒/i.test(
    `${segment.title} ${segment.footer}`,
  )
    ? "high"
    : "";

  const payload: AgentResultPayload = {
    avatar: "NB",
    avatarStyle: "default",
    title: segment.title,
    items,
    footer: segment.footer,
    cardType,
    actions,
    speak,
    cardId: actions.length > 0 || cardType ? `card_${Date.now()}_${Math.random().toString(36).substr(2, 6)}` : undefined,
  };

  const json = JSON.stringify(payload);
  const cardBlock = `[AGENT_RESULT_CARD_START]\n${json}\n[AGENT_RESULT_CARD_END]`;

  const parts: string[] = [];
  if (leadingLines.length) parts.push(leadingLines.join("\n"));
  parts.push(cardBlock);
  if (trailingLines.length) parts.push(trailingLines.join("\n"));

  return parts.join("\n\n");
}
