/**
 * 渲染形态判断中心
 *
 * 把 LLM 的隐式输出形态显式化为渲染提示，
 * 供 `ToolResultProcessor.processAssistantText` 决定注入哪种卡片标记。
 *
 * 六层优先级（动态路由，谁合适谁用）：
 *   1. image_text    图片识别/OCR 场景 → 结构化富文本（前端无标记时走 StructuredAssistantMessageBody）
 *   2. search_result 搜索工具结果（3+ 条列表项）→ 专用搜索结果卡片
 *   3. result_card   小汇报场景（≤300 字 + 含可切列表）→ AgentResultCard 小卡片
 *   4. summary_card  长内容（≥800 字 + 搜索工具）→ ContentSummaryCard 摘要卡片
 *   5. long_text     长内容（≥800 字 + 非搜索工具）→ 结构化富文本
 *   6. plain         其余 → 普通正文
 *
 * 设计要点：
 *   - 不让 LLM 输出 renderHint 元数据（会污染正文且不可靠）
 *   - LLM 通过输出结构本身声明意图，本模块做显式化识别
 *   - 纯规则判断，无 LLM 调用，延迟 <1ms
 */

export type RenderHintType = "plain" | "result_card" | "summary_card" | "search_result" | "long_text" | "image_text" | "brief";

export interface RenderHint {
  type: RenderHintType;
  /** 命中原因，便于日志排查 */
  reason: string;
  /** 是否因意图关键词触发结构化 */
  intent?: boolean;
}

export interface RenderHintContext {
  /** 最近一次调用的工具名，用于增强判断（如 weather.get_local 强制走小卡片） */
  toolName?: string;
  /** 用户原话，辅助判断是否为对话式回复 */
  userText?: string;
}

/** result_card 字数上限：超过则不算"小汇报"场景（整段对话 + 列表 + 追问） */
const RESULT_CARD_MAX_CHARS = 300;
/** 结构化富文本字数下限：>300 字符倾向输出 Markdown 富文本 */
const STRUCTURED_TEXT_MIN_CHARS = 300;
/** 意图语义关键词：用户提问携带这些词 → 无视短字数，强制结构化富文本 */
const INTENT_KEYWORDS_RE =
  /整理|对比|总结|方案|清单|步骤|脑图|表格|分析|比较|规划|计划|推荐|排行|排名|区别|异同|优缺点|攻略|分类|归纳|梳理|教程/i;

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

/** 图片/视觉类工具正则 */
const IMAGE_TOOL_RE = /vision|image|photo|识图|图片|ocr|screenshot|capture/i;

const MEDIA_SEARCH_TOOLS = new Set(["search_images", "search_videos"]);

/** 搜索工具集合 */
const SEARCH_ELIGIBLE_TOOLS = new Set([
  "search_web",
  "fetch_web",
  "info.search",
  "info.read_webpage",
  "info.inspect_webpage",
  "info.navigate_site",
]);

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

function isSearchTool(toolName?: string): boolean {
  return !!toolName && SEARCH_ELIGIBLE_TOOLS.has(toolName);
}

function isImageTool(toolName?: string): boolean {
  if (toolName && MEDIA_SEARCH_TOOLS.has(toolName)) return false;
  return !!toolName && IMAGE_TOOL_RE.test(toolName);
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

  // === 优先级 0：image_text 图片识别/OCR → 直接走结构化富文本 ===
  if (isImageTool(ctx?.toolName)) {
    return {
      type: "image_text",
      reason: `image-tool(tool=${ctx?.toolName})`,
    };
  }

  if (ctx?.toolName && MEDIA_SEARCH_TOOLS.has(ctx.toolName)) {
    const listResult = analyzeListStructure(trimmed);
    if (listResult.itemCount >= 3 && listResult.itemCount <= 12) {
      return {
        type: "result_card",
        reason: `media-search-tool+list(items=${listResult.itemCount})`,
      };
    }
  }

  // === 优先级 1：search_result 搜索工具结果（3-10 列表项）→ 专用搜索结果卡片 ===
  if (isSearchTool(ctx?.toolName)) {
    const listResult = analyzeListStructure(trimmed);
    if (listResult.itemCount >= 3 && listResult.itemCount <= 10) {
      return {
        type: "search_result",
        reason: `search-tool+list(items=${listResult.itemCount})`,
      };
    }
    // 搜索结果但 item 太少 或 item 太多 → fall through
  }

  // === 优先级 2：result_card 简短汇报 ===
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

  // === 优先级 3+：brief 简报增强 ===
  // 短文本 + 引导行 + 列表项，典型晨间简报/资讯汇总结构
  if (trimmed.length <= RESULT_CARD_MAX_CHARS) {
    const listResult = analyzeListStructure(trimmed);
    const hasLeadLine = listResult.nonListLines.some(
      (l) => (l.length <= 30 && /[:：]$/.test(l)) || /^关于|提醒|补充|备注/i.test(l),
    );
    if (listResult.itemCount >= 2 && hasLeadLine) {
      return { type: "brief", reason: `lead+list(items=${listResult.itemCount})` };
    }
    if (listResult.itemCount >= 3 && listResult.nonListLines.length >= 2) {
      return { type: "brief", reason: `list+context(items=${listResult.itemCount})` };
    }
  }

  // === 优先级 4：判断长内容 ===
  // 内容长度因子：>300 字符 → 倾向结构化富文本（标题、列表、表格、折叠块）
  // 意图语义判断（权重更高）：特定关键词 → 无视短字数，强制结构化
  // 闲聊短句（无意图关键词 + 短文本）→ 即使 400 字也走纯段落
  const hasIntent = !!ctx?.userText && INTENT_KEYWORDS_RE.test(ctx.userText);
  if (trimmed.length >= STRUCTURED_TEXT_MIN_CHARS || hasIntent) {
    if (isSummaryEligibleToolName(ctx?.toolName)) {
      return {
        type: "summary_card",
        reason: `long-content+search-tool(len=${trimmed.length},tool=${ctx?.toolName},intent=${hasIntent})`,
        intent: hasIntent,
      };
    }
    return {
      type: "long_text",
      reason: `long-content+non-search(len=${trimmed.length},tool=${ctx?.toolName},intent=${hasIntent})`,
      intent: hasIntent,
    };
  }

  // === 优先级 4：plain 普通正文 ===
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
