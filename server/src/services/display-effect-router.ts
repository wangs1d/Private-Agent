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
  /^(?:\d{1,2}[:：]\d{2}(?:[-~]\d{1,2}[:：]\d{2})?|周[一二三四五六日天]|今天|明天|后天|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2})/;

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
// 聚合与决策
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对所有候选效果并行评分，返回评分明细分（按 CANDIDATE_ORDER 排序，
 * 仅含 contentScore 或 toolScore 任一 >0 的候选）。
 * 独立导出：路由决策可观测、可测试；也是 routeDisplayEffect 的唯一数据源。
 */
export function scoreDisplayEffects(input: DisplayRouteInput): DisplayEffectScore[] {
  const toolSignal = matchToolSignal((input.toolName ?? "").trim());
  const results: DisplayEffectScore[] = [];

  const addCandidate = (type: DisplayEffectType) => {
    // 收紧类型：""（通用卡）没有评分器；其余效果查注册表
    const contentScore = (type !== "" ? CONTENT_SCORERS[type]?.(input) : 0) ?? 0;
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

/**
 * 展示效果动态路由主入口（纯函数）。
 *
 * 在 [scoreDisplayEffects] 明细分上取最高分当选；得分相同（含浮点误差）
 * 时保留顺序靠前者（CANDIDATE_ORDER 兜底）。全部候选 0 分 → 通用列表卡（""）。
 */
export function routeDisplayEffect(input: DisplayRouteInput): DisplayEffectType {
  let best: DisplayEffectType = "";
  let bestScore = 0;
  for (const d of scoreDisplayEffects(input)) {
    // 严格大于：首个同分者保留
    if (d.score > bestScore + 1e-9) {
      bestScore = d.score;
      best = d.type;
    }
  }
  return best;
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