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
 * 路由优先级（先命中先赢，顺序即优先级）：
 *   1. 工具强信号（weather/schedule/wallet/order/file/media/search_result/compare/timeline）
 *      ——工具语义唯一确定场景，最可靠；
 *   2. steps   数字步骤：多数条目带「第X步/Step N/数字.」标记，
 *      或原文是 1. 2. 3. 顺序编号列表（numberedItemRatio ≥0.8）；
 *   3. progress 进度条：多数条目带百分比或 x/总分；
 *   4. carousel 轮播：多数条目内嵌图片 URL；
 *   5. timeline 时间轴（内容判定）：多数条目以时间标记开头
 *      （先于 metric：`09:00 xxx` 形如「标签:数值」，但语义是日程）；
 *   6. metric  数据面板：条目全部是「短标签：数值+单位」（无百分比）；
 *   7. fold_list 折叠列表：条目 ≥8 条的长清单（先于 chips：长清单优先折叠）；
 *   8. chips   标签行：条目全部是 ≤10 字的短标签且不带数值；
 *   9. quote   引用强调：无条目且 title 是引用式单句（结构化载荷直发场景）；
 *   10. ""     通用列表卡（前端默认样式）。
 *
 * 新增展示效果的扩展步骤：
 *   1. DisplayEffectType 加类型名；
 *   2. 在 routeDisplayEffect 补一条判定规则（含场景注释）；
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
  | "compare" // A/B 对比卡（工具：compare/pk；或媒体侧标记）
  | "timeline" // 时间轴卡（工具：plan/timeline；或条目以时间开头）
  | "progress" // 文字进度条卡（内容：百分比/分数占多数）
  | "steps" // 数字步骤卡（内容：第X步/Step N/数字. 开头占多数）
  | "metric" // 数据面板卡（内容：全部为「标签：数值」）
  | "carousel" // 轮播横滑卡（内容：多数条目内嵌图片 URL）
  | "chips" // 标签/徽章行（内容：全部为短标签）
  | "fold_list" // 折叠列表卡（内容：≥8 条长清单）
  | "quote" // 引用强调卡（markdown 引用块 / 引用式单句结论）
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

/** chips 短标签上限（字符数），超过则不算标签。 */
const CHIP_MAX_LEN = 10;

/** fold_list 折叠门槛：条目数 ≥ 该值时长清单折叠展示。 */
const FOLD_MIN_ITEMS = 8;

/** 命中比例工具函数。 */
function ratio(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

/**
 * 工具强信号：按工具名推断展示效果（原 inferCardType 逻辑迁移于此）。
 * 工具语义唯一确定场景，优先级最高；未命中返回空串。
 */
function inferToolEffect(toolName: string): DisplayEffectType {
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
  if (toolName === "search_images" || toolName === "search_videos") return "media";
  if (toolName === "search_web" || toolName.startsWith("info.")) return "search_result";
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

/**
 * 展示效果动态路由主入口（纯函数）。
 *
 * 规则顺序即优先级，先命中先赢；详见文件头注释。
 * 所有判定只依赖结构化文本信号，不调用 LLM。
 */
export function routeDisplayEffect(input: DisplayRouteInput): DisplayEffectType {
  // 1) 工具强信号：工具语义最可靠，内容规则只做兜底
  const byTool = inferToolEffect((input.toolName ?? "").trim());
  if (byTool) return byTool;

  const items = input.items;
  const n = items.length;

  // 2) steps：多数条目带步骤标记；标题含教程/流程语义时门槛放宽到 0.4
  const stepHits = items.filter((it) => STEP_MARK_RE.test(it.text.trim())).length;
  if (
    n >= 3 &&
    (ratio(stepHits, n) >= 0.6 ||
      (STEP_TITLE_RE.test(input.title) && ratio(stepHits, n) >= 0.4))
  ) {
    return "steps";
  }
  // 2.5) steps（编号列表信号）：条目本身无步骤标记，但原文是
  //      `1. ` `2、` 顺序编号列表（前缀被 formatter 剥离）→ 仍是步骤语义
  if (n >= 3 && (input.numberedItemRatio ?? 0) >= 0.8) {
    return "steps";
  }

  // 3) progress：≥2 条命中百分比/分数且过半
  const valueHits = items.filter((it) => VALUE_RE.test(it.text)).length;
  if (n >= 2 && valueHits >= 2 && ratio(valueHits, n) >= 0.5) {
    return "progress";
  }

  // 4) carousel：多数条目内嵌图片 URL → 前端横滑轮播
  const imgHits = items.filter((it) => IMAGE_URL_RE.test(it.text)).length;
  if (n >= 2 && ratio(imgHits, n) >= 0.8) {
    return "carousel";
  }

  // 5) timeline（内容判定）：多数条目以时间标记开头 → 时间轴。
  //    先于 metric：`09:00 xxx` 也能匹配「标签:数值」，但语义是日程。
  const timeHits = items.filter((it) => TIME_MARK_RE.test(it.text.trim())).length;
  if (n >= 3 && ratio(timeHits, n) >= 0.6) {
    return "timeline";
  }

  // 6) metric：2-6 条全部为「短标签：数值(+单位)」——关键指标面板
  if (n >= 2 && n <= 6 && items.every((it) => METRIC_ITEM_RE.test(it.text.trim()))) {
    return "metric";
  }

  // 7) fold_list：长清单（≥8 条）折叠展示，避免刷屏。
  //    先于 chips：≥8 条即使全是短标签也优先折叠。
  if (n >= FOLD_MIN_ITEMS) {
    return "fold_list";
  }

  // 8) chips：≥4 条且全部是 ≤10 字的短标签。
  //    排除信号（结构化条目不是标签）：句末标点、百分比/分数、
  //    含数字（`清单条目 1`/`09:00 起床`）、时间前缀（`周一 开会`）。
  if (
    n >= 4 &&
    items.every((it) => {
      const t = it.text.trim();
      return (
        t.length > 0 &&
        t.length <= CHIP_MAX_LEN &&
        !/[。！？；，、：]/.test(t) &&
        !VALUE_RE.test(t) &&
        !/\d/.test(t) &&
        !TIME_MARK_RE.test(t)
      );
    })
  ) {
    return "chips";
  }

  // 9) quote：无条目且 title 是引用式单句（结构化载荷直发场景；
  //    markdown 引用块路径由 formatter 的 extractQuoteSegment 走，不经过这里）
  const t = input.title.trim();
  if (n === 0 && t && (QUOTE_TITLE_RE.test(t) || QUOTE_LEAD_RE.test(t))) {
    return "quote";
  }

  // 10) 通用列表卡
  return "";
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
