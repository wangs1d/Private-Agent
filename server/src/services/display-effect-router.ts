/**
 * 文本展示效果动态路由器（独立模块，纯程序层，无 LLM 参与）。
 *
 * 职责：给定一次结构化输出信号（toolName + title/items/footer），
 * 决定前端使用哪种「文本展示效果」（cardType）。
 *
 * 接线：
 *   - 服务端：agent-result-formatter.formatAgentResultForChat 在产出
 *     [AGENT_RESULT_CARD] 前调用 routeDisplayEffect 注入 cardType；
 *     tool-result-processor 对 markdown 引用块（> xxx）走 quote 提取。
 *   - 前端：features/chat/display_effects/ 模块按 cardType 渲染对应组件，
 *     分发表见 agent_result_card.dart 的 AgentResultCard.build。
 *
 * 架构（声明式动态评分，替代旧的固定优先级链）：
 *   收集候选 → 逐候选评分 → 最高分当选，全程数据驱动，无线性抢名额：
 *   - 候选来源一「工具路由表」：[TOOL_RULES] 一条规则一个效果，强工具
 *     （语义唯一场景）score=1，弱工具（宽泛关键字）score=0.5 只给倾向；
 *   - 候选来源二「内容评分器注册表」：[CONTENT_SCORERS] 每种内容效果
 *     一个独立 text 形态评分函数（0-1），互相竞争、各自可测；
 *   - 聚合：[scoreDisplayEffects] 按 [CANDIDATE_ORDER] 显式顺序产出每个
 *     候选的 (contentScore, toolScore, score) 明细分，score =
 *     contentScore×CONTENT_WEIGHT + toolScore×TOOL_WEIGHT（截断 1）；
 *   - 决策：[routeDisplayEffect] 在明细分上取最高分；得分相同（含浮点
 *     误差）保留先被评分的候选，即 CANDIDATE_ORDER 次序（平局兜底）。
 *
 *   语义约定：
 *   - 内容信号是主判据（权重 0.78）：文本形态决定效果；同一段内容可能
 *     同时长得像时间轴和数据面板，由得分定胜负而非规则先后顺序。
 *   - 工具信号是兜底/加成（权重 0.45）：无内容信号时强工具保证落在
 *     正确场景；弱工具只给倾向分，可被高置信内容压过——同一个 plan 工具，
 *     输出是 A/B 对比就落在 compare，输出是时间线才走 timeline。
 *
 * 新增展示效果的扩展步骤：
 *   1. DisplayEffectType 加类型名；
 *   2. 内容型效果：在 CONTENT_SCORERS 注册一个评分函数（含场景注释），
 *      并加入 CANDIDATE_ORDER；工具型效果：在 TOOL_RULES 加一条规则
 *      （强工具语义唯一，弱工具给倾向）；
 *   3. 前端 display_effects/ 加对应组件并在 AgentResultCard 分发表注册；
 *   4. test/display-effect-router.test.ts 补用例。
 */

import { LIST_ITEM_RE } from "./render-hint-service.js";

/** 全部展示效果类型；空串 = 通用列表卡（前端默认）。 */
export type DisplayEffectType =
  | "weather" // 天气卡（工具：weather.*）
  | "schedule" // 日程卡（工具：calendar/schedule）
  | "wallet" // 钱包卡（工具：wallet.*）
  | "order" // 订单卡（工具：order/payment/alipay）
  | "file" // 文件卡（工具：file）
  | "search_result" // 搜索结果卡（工具：search_web/info.*）
  | "media" // 媒体图廊卡（工具：search_images/search_videos 等）
  | "compare" // A/B 对比卡（工具：compare/pk；或内容含对比词）
  | "timeline" // 时间轴卡（工具：plan/timeline；或条目以时间开头）
  | "progress" // 文字进度条卡（内容：百分比/分数占多数）
  | "steps" // 数字步骤卡（内容：第X步/Step N/数字. 开头占多数）
  | "metric" // 数据面板卡（内容：全部为「标签：数值」）
  | "carousel" // 轮播横滑卡（内容：多数条目内嵌图片 URL）
  | "chips" // 标签/徽章行（内容：全部为短标签）
  | "fold_list" // 折叠列表卡（内容：≥8 条长清单）
  | "quote" // 引用强调卡（markdown 引用块 / 引用式单句结论）
  | "travel_itinerary" // 旅游行程双面板卡（工具：travel.*，前端展开为左右双栏规划界面并可全屏）
  | "";

/** 路由输入：一次结构化输出的全部信号。 */
export interface DisplayRouteInput {
  /** 最近调用的工具名（可为空——纯文本路径没有工具信号）。 */
  toolName?: string;
  /** 卡片标题。 */
  title: string;
  /** 结构化条目（text 为剥掉列表前缀后的正文）。 */
  items: ReadonlyArray<{ text: string; type?: string }>;
  /**
   * 原始全文（未切分）。提供后，「内容语义」成为主判据：
   * 即使 LLM 没用 `-`/`1.` 列表语法，也能按语义掐出条目（分层叙述、
   * 一是…二是…、首先…最后…、顿号列举等），不再强依赖列表格式。
   * 语义条目数 ≥ items 时以语义条目为准（max 不降级）。
   */
  fullText?: string;
  /** 卡片 footer（追问/补充说明）。 */
  footer?: string;
  /**
   * 原文列表行的顺序编号占比（0-1）：列表前缀 `1. ` `2、` 被剥离后
   * 步骤信号会丢失，formatter 在剥离前统计编号行比例并传入。
   * ≥0.8 视为顺序步骤列表。
   */
  numberedItemRatio?: number;
}

/** 单个候选的评分明细（路由决策可观测、可测试、可审计）。 */
export interface DisplayEffectScore {
  type: DisplayEffectType;
  /** 文本形态分（0-1），未命中为 0。 */
  contentScore: number;
  /** 工具场景分（0-1），强工具 1 / 弱工具 0.5 / 无 0。 */
  toolScore: number;
  /** 聚合分 = contentScore×CONTENT_WEIGHT + toolScore×TOOL_WEIGHT（截断 1）。 */
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合权重（内容为主判据，工具为兜底）
// ─────────────────────────────────────────────────────────────────────────────

/** 内容形态分权重：内容信号是主判据，README 见文件头语义约定。 */
const CONTENT_WEIGHT = 0.78;
/** 工具场景分权重：无内容信号时保证落到正确场景，弱工具只是倾向。 */
const TOOL_WEIGHT = 0.45;

// ─────────────────────────────────────────────────────────────────────────────
// 工具路由表（数据驱动；强工具=语义唯一场景，弱工具=宽泛倾向）
// ─────────────────────────────────────────────────────────────────────────────

/** 工具信号强度：与 TOOL_SCORE 关联，决定工具分权重。 */
type ToolStrength = "strong" | "weak";

/** 工具信号强度 → 工具分。弱工具只给倾向，可被高置信内容压过。 */
const TOOL_SCORE: Record<ToolStrength, number> = { strong: 1, weak: 0.5 };

/** 一条工具路由规则：工具名命中 → 该效果获得对应强度的工具分。 */
interface ToolRule {
  effect: DisplayEffectType;
  strength: ToolStrength;
  test: (toolName: string) => boolean;
}

/** 工具路由规则表；命中顺序即规则顺序，首个命中生效（等价于旧的先判先赢）。 */
const TOOL_RULES: ReadonlyArray<ToolRule> = [
  // ── 强工具（语义唯一场景，无内容信号时保底）──
  // 旅游行程：独立于 plan/行程 等宽泛关键字，务必置于弱工具之前。
  { effect: "travel_itinerary", strength: "strong", test: (t) => t.startsWith("travel.") },
  { effect: "weather", strength: "strong", test: (t) => t.startsWith("weather.") },
  {
    effect: "schedule",
    strength: "strong",
    test: (t) => t.includes("calendar") || t.includes("schedule"),
  },
  { effect: "wallet", strength: "strong", test: (t) => t.startsWith("wallet.") },
  {
    effect: "order",
    strength: "strong",
    test: (t) =>
      t.includes("order") || t.includes("payment") || t.includes("pay") || t.includes("alipay"),
  },
  { effect: "file", strength: "strong", test: (t) => t.includes("file") },
  {
    effect: "media",
    strength: "strong",
    test: (t) => t === "search_images" || t === "search_videos",
  },
  {
    effect: "search_result",
    strength: "strong",
    test: (t) => t === "search_web" || t.startsWith("info."),
  },
  // ── 弱工具（宽泛关键字命中，只给倾向分）──
  { effect: "compare", strength: "weak", test: (t) => /compare|pk|对比/i.test(t) },
  { effect: "timeline", strength: "weak", test: (t) => /timeline|plan|行程/i.test(t) },
  { effect: "media", strength: "weak", test: (t) => /image|photo|vision|识图|图片/i.test(t) },
];

/** 匹配工具路由表：首个命中规则生效；未命中返回 null。 */
function matchToolSignal(
  toolName: string,
): { effect: DisplayEffectType; score: number } | null {
  if (!toolName) return null;
  for (const rule of TOOL_RULES) {
    if (rule.test(toolName)) return { effect: rule.effect, score: TOOL_SCORE[rule.strength] };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容信号正则（每条规则独立可测）
// ─────────────────────────────────────────────────────────────────────────────

/** 步骤标记：第X步 / 第X阶段 / 第X部分 / Step N / 「数字.」「数字、」「数字)」开头。 */
const STEP_MARK_RE =
  /^(?:第\s*[一二三四五六七八九十百\d]+\s*[步阶段部]|step\s*\d+|\d{1,2}\s*[.、)）]\s*\S)/i;

/** 步骤语义标题：标题含教程/流程等词时降低步骤标记的命中门槛。 */
const STEP_TITLE_RE = /(教程|步骤|流程|怎么弄|怎么操作|怎么设置|怎么用|操作指南|攻略|安装|配置|入门)/i;

/** 数值信号：百分比（45%）或分数（90/100）。 */
const VALUE_RE = /(?:\d+(?:\.\d+)?)\s*%|(?:\d+(?:\.\d+)?)\s*\/\s*(?:\d+(?:\.\d+)?)/;

/** metric 条目：短标签 + 冒号 + 数值（可带 ≤6 字符单位），无百分比。 */
const METRIC_ITEM_RE = /^[^：:，,。！？\n]{1,14}[：:]\s*[+-]?\d[\d,.，]*\s*\S{0,6}$/;

/** 图片 URL（用于 carousel 内容判定）。 */
const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#]\S*)?/i;

/** 时间标记：HH:mm / HH:mm-HH:mm / 周X / 今天明天后天 / X月X日 / MM-dd。 */
const TIME_MARK_RE =
  /^(?:(?:早上|上午|中午|下午|傍晚|晚上|凌晨|夜里)\s*)?(?:\d{1,2}[:：]\d{2}(?:[-~]\d{1,2}[:：]\d{2})?|\d{1,2}点(?:半|钟|半钟)?)|周[一二三四五六日天]|今天|明天|后天|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2}/;

/** 引用式标题：含引号或结论性引导词。 */
const QUOTE_TITLE_RE = /[“”「『]|一句话|结论|重点|提醒|注意|金句/;
const QUOTE_LEAD_RE = /^(总之|总而言之|核心|简单说|说白了)/;

/** 对比内容标记：条目内含 vs/PK/对比 等明确对比词（纯文本 A/B 对比识别）。 */
const COMPARE_MARK_RE = /(?:^|\s)(?:vs\.?|pk)\b|对比/i;

/** chips 短标签上限（字符数），超过则不算标签。 */
const CHIP_MAX_LEN = 10;

/** fold_list 折叠门槛：条目数 ≥ 该值时长清单折叠展示。 */
const FOLD_MIN_ITEMS = 8;

/** 命中比例工具函数。 */
function ratio(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

/** 归一到 [0,1]。 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容评分器注册表（一个效果一个独立评分函数，互相竞争、各自可测）
// ─────────────────────────────────────────────────────────────────────────────

type ContentScorer = (input: DisplayRouteInput) => number;

/**
 * 内容评分器注册表：效果 → 其文本形态评分函数（0-1，0=不匹配）。
 * 新增内容型效果在此注册，并在 CANDIDATE_ORDER 加入该效果。
 */
const CONTENT_SCORERS: Readonly<Partial<Record<Exclude<DisplayEffectType, "">, ContentScorer>>> = {
  steps: scoreSteps,
  progress: scoreProgress,
  carousel: scoreCarousel,
  timeline: scoreTimeline,
  metric: scoreMetric,
  fold_list: scoreFoldList,
  chips: scoreChips,
  quote: scoreQuote,
  compare: scoreCompare,
};

/**
 * 候选效果显式顺序：既是评分遍历顺序，也是得分并列（含浮点误差）时的
 * 平局兜底次序——先被评分的候选在 score 相同时胜出。
 */
const CANDIDATE_ORDER: ReadonlyArray<DisplayEffectType> = [
  "steps",
  "progress",
  "carousel",
  "timeline",
  "metric",
  "fold_list",
  "chips",
  "quote",
  "compare",
];

/** steps：多数条目带步骤标记；标题含教程/流程语义时门槛放宽到 0.4；编号列表也算。 */
function scoreSteps(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 3) return 0;
  const stepHits = items.filter((it) => STEP_MARK_RE.test(it.text.trim())).length;
  const r = ratio(stepHits, n);
  let score = 0;
  if (r >= 0.6) score = r;
  else if (STEP_TITLE_RE.test(input.title) && r >= 0.4) score = Math.min(r + 0.1, 0.8);
  // 条目前缀被剥离的纯顺序编号列表（numberedItemRatio ≥0.8）也是步骤语义
  if ((input.numberedItemRatio ?? 0) >= 0.8) score = Math.max(score, 1);
  return score;
}

/** progress：≥2 条命中百分比/分数且过半 → 按命中比例给分。 */
function scoreProgress(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const valueHits = items.filter((it) => VALUE_RE.test(it.text)).length;
  const r = ratio(valueHits, n);
  return valueHits >= 2 && r >= 0.5 ? r : 0;
}

/** carousel：多数条目内嵌图片 URL → 前端横滑轮播。 */
function scoreCarousel(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const imgHits = items.filter((it) => IMAGE_URL_RE.test(it.text)).length;
  const r = ratio(imgHits, n);
  return r >= 0.8 ? r : 0;
}

/**
 * timeline（内容判定）：多数条目以时间标记开头 → 时间轴。
 * 与 metric 并行评分：`09:00 xxx` 也能匹配「标签:数值」，由得分决胜负。
 */
function scoreTimeline(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 3) return 0;
  const timeHits = items.filter((it) => TIME_MARK_RE.test(it.text.trim())).length;
  const r = ratio(timeHits, n);
  return r >= 0.6 ? r : 0;
}

/** metric：2-6 条全部为「短标签：数值(+单位)」——关键指标面板。 */
function scoreMetric(input: DisplayRouteInput): number {
  const n = input.items.length;
  if (n < 2 || n > 6) return 0;
  return input.items.every((it) => METRIC_ITEM_RE.test(it.text.trim())) ? 1 : 0;
}

/** fold_list：长清单（≥8 条）折叠展示，避免刷屏；条数越多分越高。 */
function scoreFoldList(input: DisplayRouteInput): number {
  const n = input.items.length;
  return n >= FOLD_MIN_ITEMS ? clamp01(0.6 + (n - FOLD_MIN_ITEMS) / 20) : 0;
}

/**
 * chips：≥4 条且全部是 ≤10 字的短标签。
 * 排除信号（结构化条目不是标签）：句末标点、百分比/分数、
 * 含数字（`清单条目 1`/`09:00 起床`）、时间前缀（`周一 开会`）。
 */
function scoreChips(input: DisplayRouteInput): number {
  const n = input.items.length;
  if (n < 4) return 0;
  return input.items.every((it) => isShortTag(it.text.trim())) ? 1 : 0;
}

function isShortTag(t: string): boolean {
  return (
    t.length > 0 &&
    t.length <= CHIP_MAX_LEN &&
    !/[。！？；，、：]/.test(t) &&
    !VALUE_RE.test(t) &&
    !/\d/.test(t) &&
    !TIME_MARK_RE.test(t)
  );
}

/**
 * quote：无条目且 title 是引用式单句（结构化载荷直发场景；
 * markdown 引用块路径由 formatter 的 extractQuoteSegment 走，不经过这里）。
 */
function scoreQuote(input: DisplayRouteInput): number {
  const t = input.title.trim();
  return input.items.length === 0 && t && (QUOTE_TITLE_RE.test(t) || QUOTE_LEAD_RE.test(t)) ? 1 : 0;
}

/** compare 内容形态：多数条目带明确对比词——纯文本 A/B 对比即使无工具信号也能被识别。 */
function scoreCompare(input: DisplayRouteInput): number {
  const items = input.items;
  const n = items.length;
  if (n < 2) return 0;
  const cmpHits = items.filter((it) => COMPARE_MARK_RE.test(it.text)).length;
  const r = ratio(cmpHits, n);
  return r >= 0.6 ? r : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容语义提取与意图评分（不依赖列表语法，兑现「内容信号为主判据」）
// ─────────────────────────────────────────────────────────────────────────────

/** 语义条目有效性：非标题引导行、非问句、非纯语气、长度适中。 */
function isValidSemanticEntry(entry: string): boolean {
  const t = entry.trim();
  if (t.length < 2 || t.length > 80) return false;
  // 标题/列表引导行（如「屏幕参数：」「你的兴趣标签：」）不当作条目
  if (/[：:]\s*$/.test(t)) return false;
  if (/^(?:[一二三四五六七八九十]{1,3}[、.．]|#+\s+)\S+$/.test(t)) return false;
  if (/[？?]\s*$|们?\s*(呢|啊|哦)\s*$|^(好的|好的呀|嗯|好的呢|好滴|没问题)\b/.test(t)) return false;
  return true;
}

/** 分项引导词：句内出现「一是X，二是Y」/「首先X，其次Y」时可再拆。 */
const SEMANTIC_SEQUENCE_RE =
  /(?:一是|二是|三是|四是|五是|首先|其次|再次|最后|然后|接着|之后|第一步|第二步|第三步|其一|其二|其三)/;

/** 分项引导词切分点（在逗号前一个引导词处断开）。 */
const SEMANTIC_SPLIT_RE =
  /[，,](?=一是|二是|三是|四是|五是|首先|其次|再次|最后|然后|接着|其一|其二|其三|第一|第二)/;

/** 句/短句切分点：逗号、句号、分号后的位置（仅作用于非列表行，不拆列表条目）。 */
const SEMANTIC_CLAUSE_RE = /(?<=[。；;，,])\s*/;

/**
 * 从原始全文掐出语义条目，不依赖 `-`/`1.` 列表符号。
 *
 * 按「行 → 分项引导词 → 句号/分号」逐级切分，再过滤无效片段（问句、
 * 纯语气、过长/过短行）。适合 LLM 用分层叙述、一是…二是…、首先…最后…、
 * 顿号列举等自然表达时，仍然能提取出可评分的条目集。
 *
 * @param text 原始全文
 * @returns 语义条目正文数组（已剥列表前缀、不含编号）
 */
export function extractSemanticItems(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const out: string[] = [];

  for (const raw of lines) {
    // 已是列表行 → 剥前缀作为单条目，不继续拆
    const listMatch = raw.match(LIST_ITEM_RE);
    if (listMatch) {
      const text_ = raw.slice(listMatch[0].length).trim();
      if (isValidSemanticEntry(text_)) out.push(text_);
      continue;
    }
    // 序号标题行（一、二、 / 1. / #）：本身是条目
    if (/^(?:[一二三四五六七八九十]{1,3}[、.．]|#+\s+)\S+/.test(raw)) {
      const text_ = raw.replace(/^(?:[一二三四五六七八九十]{1,3}[、.．]|#+\s+)/, "").trim();
      if (isValidSemanticEntry(text_)) out.push(text_);
      continue;
    }
    // 只取有实质句子的行（过滤纯标题短句、过渡语）
    let segments = raw.split(SEMANTIC_SPLIT_RE);
    if (segments.length === 1 && SEMANTIC_SEQUENCE_RE.test(raw)) {
      // 数值/短标题行不拆；其余保留整行后按句号再切
    }
    for (const seg of segments) {
      const clauses = seg.split(SEMANTIC_CLAUSE_RE).map((s) => s.trim()).filter(Boolean);
      for (const clause of clauses) {
        if (isValidSemanticEntry(clause)) out.push(clause);
      }
    }
  }
  return out;
}

/** 全文语义意图信号：给对应效果一个内容分加成（0 = 无信号）。 */
const SEMANTIC_INTENT_SCORERS: Readonly<
  Partial<Record<Exclude<DisplayEffectType, "">, (fullText: string) => number>>
> = {
  // steps：单个连接词（"然后"）或单个教程词（"怎么弄"）在对话里太常见，
  // 不足以支撑上卡（真实误判案例："先落地歇脚…然后飞巴厘岛…"、"报名到底要
  // 怎么弄" 都被切成碎片卡）。要求 ≥2 个不同的顺序引导词才给意图分；
  // 真教程/流程几乎必带列表语法或编号，由形态评分器（scoreSteps）承接。
  steps: (t) => {
    const markers = new Set(
      t.match(/(?:首先|其次|再次|然后|接着|最后|第[一二三四五六七八九十]+步)/g) ?? [],
    );
    return markers.size >= 2 ? 0.62 : 0;
  },
  compare: (t) =>
    /(?:vs\.?|对比|区别|哪个(更好|更合适|更值得)|跟.*比|和.*比|怎么选|优缺点)\b/i.test(t)
      ? 0.62
      : 0,
  timeline: (t) =>
    /(?:周[一二三四五六日天]|今天|明天|后天|昨天|\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}|先后|之后|安排|日程)/i.test(t)
      ? 0.45
      : 0,
  // metric：只认「标签 + 冒号 + 数值」结构，避免「9点开会/2本书/50元」等闲聊被误判成数据卡
  metric: (t) => {
    const pairs = (t.match(/[^：:\n，。,]{1,14}[：:]\s*[+\-−±]?\d[\d,.，]*\s*\S{0,6}/g) ?? []).length;
    return pairs >= 2 ? 0.5 : 0;
  },
};

/**
 * 依据 fullText 构建「内容语义优先」的生效输入：
 * 语义条目数 ≥ 原列表 items 时，用语义条目替代表 list items（max 不降级），
 * 使形态评分器能基于真实内容打分，而不是被列表语法绑死。
 */
function buildEffectiveInput(input: DisplayRouteInput): DisplayRouteInput {
  if (!input.fullText) return input;
  const semantic = extractSemanticItems(input.fullText).map((text) => ({ text, type: "num" }));
  if (semantic.length < input.items.length) return input;
  return { ...input, items: semantic };
}

/**
 * 全文语义意图分：对指定效果查询 fullText 的意图信号。
 * 形态分不足但语义意图明确时，作为 contentScore 的兜底加成。
 */
function semanticIntentScore(type: Exclude<DisplayEffectType, "">, input: DisplayRouteInput): number {
  if (!input.fullText) return 0;
  return SEMANTIC_INTENT_SCORERS[type]?.(input.fullText) ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合与决策
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对所有候选效果并行评分，返回评分明细分（按 CANDIDATE_ORDER 排序，
 * 仅含 contentScore 或 toolScore 任一 >0 的候选）。
 * 独立导出：路由决策可观测、可测试；也是 routeDisplayEffect 的唯一数据源。
 */
export function scoreDisplayEffects(
  input: DisplayRouteInput,
  opts: { semanticIntent?: boolean } = {},
): DisplayEffectScore[] {
  const { semanticIntent = true } = opts;
  const toolSignal = matchToolSignal((input.toolName ?? "").trim());
  const results: DisplayEffectScore[] = [];
  // 内容语义优先：fullText 提供时用语义条目替代表 items（max 不降级）
  const effective = buildEffectiveInput(input);

  const addCandidate = (type: DisplayEffectType) => {
    if (type === "") return;
    // 收紧类型：形态评分器走「内容语义优先」的生效输入
    let contentScore = CONTENT_SCORERS[type]?.(effective) ?? 0;
    // 全文语义意图兜底（默认开启）：形态不足但意图明确（如"对比/怎么选/首先然后"）
    if (semanticIntent) {
      const intent = semanticIntentScore(type, effective);
      contentScore = clamp01(Math.max(contentScore, intent));
    }
    const toolScore = toolSignal && toolSignal.effect === type ? toolSignal.score : 0;
    if (contentScore <= 0 && toolScore <= 0) return;
    results.push({
      type,
      contentScore,
      toolScore,
      score: clamp01(contentScore * CONTENT_WEIGHT + toolScore * TOOL_WEIGHT),
    });
  };

  // 1) 内容型候选：全部并行评分（CANDIDATE_ORDER 顺序即平局兜底次序）
  for (const type of CANDIDATE_ORDER) addCandidate(type);
  // 2) 纯工具型候选（travel/weather/schedule/wallet/order/file/search_result/media 等，
  //   无内容评分器）：工具命中时追加为候选
  if (toolSignal && !CANDIDATE_ORDER.includes(toolSignal.effect)) addCandidate(toolSignal.effect);

  return results;
}

/** 在评分明细上取最高分当选（用于 route* 主入口与语义卡片构造）。 */
function pickBest(scores: DisplayEffectScore[]): DisplayEffectType {
  let best: DisplayEffectType = "";
  let bestScore = 0;
  for (const d of scores) {
    // 严格大于：首个同分者保留
    if (d.score > bestScore + 1e-9) {
      bestScore = d.score;
      best = d.type;
    }
  }
  return best;
}

/**
 * 展示效果动态路由主入口（纯函数）。
 *
 * 在 [scoreDisplayEffects] 明细分上取最高分当选；得分相同（含浮点误差）
 * 时保留顺序靠前者（CANDIDATE_ORDER 兜底）。全部候选 0 分 → 通用列表卡（""）。
 */
export function routeDisplayEffect(input: DisplayRouteInput): DisplayEffectType {
  return pickBest(scoreDisplayEffects(input));
}

/**
 * 纯形态路由：关闭全文语义意图加成，仅凭条目形态/结构判定。
 * 用于「普通文本/长文 → 内容卡片」路径的守门——只有显而易见的结构化内容
 * （步骤/指标/折叠/时序/对比标签等）才上卡，避免闲聊因弱意图被误判成卡片。
 */
export function routeDisplayEffectByForm(input: DisplayRouteInput): DisplayEffectType {
  return pickBest(scoreDisplayEffects(input, { semanticIntent: false }));
}

/**
 * 是否存在 markdown 引用块（> 开头且剥掉标记后仍有实质内容的行）。
 * 供 tool-result-processor 决定是否走引用卡提取（纯程序路由，无 LLM）。
 */
export function hasBlockquote(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((raw) => {
      const t = raw.trim();
      if (!t.startsWith(">")) return false;
      return t.replace(/^>\s*/, "").trim().length >= 4;
    });
}