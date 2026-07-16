/**
 * 渲染形态判断中心
 *
 * 把 LLM 的隐式输出形态（清单/长文/对话）显式化为渲染提示，
 * 供 `ToolResultProcessor.processAssistantText` 决定注入哪种卡片标记。
 *
 * 三层优先级（简短汇报优先）：
 *   1. result_card  小汇报场景（≤300 字 + 含可切列表）→ AgentResultCard 小卡片
 *                     把 LLM 输出整段保留为：[对话前导][卡片][追问/结尾]
 *   2. summary_card 长内容（≥800 字 + 可折叠）→ ContentSummaryCard 摘要卡片
 *                     ⚠️ 仅在调用了搜索/网页类工具（search_web、fetch_web、info.*）
 *                     的语境下才会触发；普通对话/桌面控制等场景即使文本很长，
 *                     也保持 plain 走正文，不要错误折叠成"内容详情"。
 *   3. plain        其余 → 普通正文
 *
 * 设计要点：
 *   - 不让 LLM 输出 renderHint 元数据（会污染正文且不可靠）
 *   - LLM 通过输出结构本身声明意图，本模块做显式化识别
 *   - 纯规则判断，无 LLM 调用，延迟 <1ms
 */

export type RenderHintType = "plain" | "result_card" | "summary_card";

export interface RenderHint {
  type: RenderHintType;
  /** 命中原因，便于日志排查 */
  reason: string;
}

export interface RenderHintContext {
  /** 最近一次调用的工具名，用于增强判断（如 weather.get_local 强制走小卡片） */
  toolName?: string;
  /** 用户原话，辅助判断是否为对话式回复 */
  userText?: string;
}

/** result_card 字数上限：超过则不算"小汇报"场景（整段对话 + 列表 + 追问） */
const RESULT_CARD_MAX_CHARS = 300;
/** summary_card 字数下限：低于则不折叠 */
const SUMMARY_CARD_MIN_CHARS = 800;

/** 列表行正则：- / * / • / 1. / 1) / 1、 */
export const LIST_ITEM_RE = /^(?:[-*•]\s+|\d+[.)、]\s+)/u;

/** 天气汇报特征词 */
const WEATHER_HINT_RE = /°C|°|摄氏|气温|温度|天气|晴|阴|雨|雪|风\s*力|湿度/i;

/** 任务完成汇报关键词 */
const TASK_DONE_RE =
  /已为你|已完成|已规划|已创建|已设置|已整理|已安排|已添加|已删除|已更新|已帮你|已发/i;

/** 工具能力 dump（如「当前可用工具列表」），不应走卡片 */
const CAPABILITY_DUMP_RE =
  /当前可用.*工具|【宿主能力|【Agent World】|wallet\.|search_web|master_invoke/i;

/** summary_card 仅在搜索/网页类工具的结果里触发，其他场景一律走 plain */
const SUMMARY_ELIGIBLE_TOOLS = new Set([
  "search_web",
  "fetch_web",
  "info.search",
  "info.read_webpage",
  "info.inspect_webpage",
  "info.navigate_site",
]);

function isSummaryEligibleToolName(toolName?: string): boolean {
  return !!toolName && SUMMARY_ELIGIBLE_TOOLS.has(toolName);
}

/**
 * 判断一段 assistant 文本应使用何种渲染形态。
 *
 * @param text LLM 最终输出文本（未经标记注入）
 * @param ctx  上下文（工具名、用户原话等）
 */
export function classifyRenderHint(
  text: string,
  ctx?: RenderHintContext,
): RenderHint {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { type: "plain", reason: "empty" };
  }

  // 已带标记的直接放行（理论上不会进来，兜底）
  if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) {
    return { type: "plain", reason: "already-marked-summary" };
  }
  if (trimmed.includes("[AGENT_RESULT_CARD_START]")) {
    return { type: "plain", reason: "already-marked-result" };
  }

  // 工具能力 dump 强制走纯文本
  if (CAPABILITY_DUMP_RE.test(trimmed) && trimmed.split("\n").length >= 8) {
    return { type: "plain", reason: "capability-dump" };
  }

  // === 优先级 1：result_card 简短汇报 ===
  if (trimmed.length <= RESULT_CARD_MAX_CHARS) {
    const listResult = analyzeListStructure(trimmed);
    // (a) 工具上下文是天气 → 强制小卡片
    if (ctx?.toolName && ctx.toolName.startsWith("weather.")) {
      if (listResult.itemCount >= 2 || WEATHER_HINT_RE.test(trimmed)) {
        return {
          type: "result_card",
          reason: `weather-tool(items=${listResult.itemCount})`,
        };
      }
    }
    // (b) 列表结构 3-7 条
    if (listResult.itemCount >= 3 && listResult.itemCount <= 7) {
      return {
        type: "result_card",
        reason: `list-structure(items=${listResult.itemCount})`,
      };
    }
    // (c) 任务完成汇报 + 至少 2 条列表项
    if (TASK_DONE_RE.test(trimmed) && listResult.itemCount >= 2) {
      return {
        type: "result_card",
        reason: `task-done(items=${listResult.itemCount})`,
      };
    }
  }

  // === 优先级 2：summary_card 长内容（仅搜索/网页类工具的结果）===
  if (trimmed.length >= SUMMARY_CARD_MIN_CHARS) {
    if (isSummaryEligibleToolName(ctx?.toolName)) {
      return {
        type: "summary_card",
        reason: `long-content+search-tool(len=${trimmed.length},tool=${ctx?.toolName})`,
      };
    }
    // 普通对话/桌面控制等长文本：保持 plain 正文，不折叠成"内容详情"
  }

  // === 优先级 3：plain 普通正文 ===
  return {
    type: "plain",
    reason: `default(len=${trimmed.length})`,
  };
}

/**
 * 分析文本的列表结构，返回列表行与非列表行。
 */
export interface ListAnalysis {
  itemCount: number;
  /** 非列表行（可能作为 title / footer） */
  nonListLines: string[];
  /** 列表项文本（已去掉前缀符号） */
  items: string[];
}

export function analyzeListStructure(text: string): ListAnalysis {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: string[] = [];
  const nonListLines: string[] = [];

  for (const line of lines) {
    const match = line.match(LIST_ITEM_RE);
    if (match) {
      items.push(line.slice(match[0].length).trim());
    } else {
      nonListLines.push(line);
    }
  }

  return {
    itemCount: items.length,
    nonListLines,
    items,
  };
}
