/**
 * realtime 轮搜索词的确定性构造器（2026-09-13 根修）。
 *
 * 契约：realtime_lookup 轮必须有含实体的可执行搜索词，且这一点不能依赖模型
 * 自觉——路由器结构化输出里的 search_query 只是首选来源；模型缺省、或输出
 * 「我老婆 最近 在哪」这类代词查询词时（真实测试实证），由本模块**纯代码**
 * 消解指代：
 *   1. 用户当前消息剥停用词后仍有实体 → 原话即查询词（当前消息实体最优先）；
 *   2. 否则在上下文行（最近对话 + 记忆档案/profile 行）里做**候选实体频次
 *      统计**：剥离停用词后的 CJK 词串（2-4 字）与拉丁词，出现次数最多者
 *      胜出（人名/地名在真实记忆与对话里天然重复出现，频次压过偶发噪声），
 *      拼「实体 + 查询词」；
 *   3. 上下文也没有实体 → 查询词原样兜底（仍是可执行搜索词）。
 * 构造质量只影响搜索召回，不影响「是否真搜」——搜索触发由 agent-core 的
 * 前置检索门禁按「searchQuery 非空」确定性执行，与模型输出无关。
 */

/** 剥离后不应作为搜索实体的词：代词/疑问/时间/泛话题/口语/角色称谓/高频动词。 */
const ENTITY_STOPWORDS: string[] = [
  // 人称代词与角色称谓（指代词，不是实体本身）
  "我", "你", "他", "她", "它", "咱", "俺", "我们", "你们", "他们", "她们", "它们", "自己", "大家", "人家",
  "老公", "老婆", "女朋友", "男朋友", "对象", "媳妇", "哥哥", "姐姐", "弟弟", "妹妹", "用户", "本人", "人家",
  // 语气/助词/单字功能词
  "的", "了", "吗", "呢", "吧", "啊", "呀", "哦", "噢", "喔", "嘛", "么", "哈", "喂", "欸", "诶",
  "是", "有", "在", "去", "说", "要", "想", "看", "问", "跟", "和", "与", "就", "也", "都", "很",
  "挺", "不", "没", "还", "又", "才", "只", "被", "把", "让", "给", "对", "从", "到", "会", "能",
  "及", "并", "曾", "称", "等", "个", "这", "那",
  // 疑问/方位词
  "什么", "怎么", "怎样", "怎么样", "如何", "多少", "为什么", "为啥", "在哪", "哪里", "那儿", "那里", "哪儿", "哪些",
  // 时间词
  "最近", "近期", "近来", "今天", "昨天", "前天", "明天", "现在", "目前", "当前", "这两天", "这几天", "那天", "最近几天",
  "周日", "周一", "周二", "周三", "周四", "周五", "周六", "星期天", "星期六", "上午", "下午", "中午", "凌晨", "早上", "晚上",
  // 泛话题词（无实体区分度）
  "消息", "新闻", "动态", "近况", "情况", "状态", "行踪", "行程", "照片", "图片", "视频", "八卦", "爆料", "热搜", "瓜",
  // 高频动词/泛词（记忆 profile 行的谓语，不是实体）
  "知道", "告诉", "看看", "查查", "查一下", "搜搜", "搜一下", "搜索", "打听", "了解", "说说", "讲讲", "聊聊", "找找",
  "有没有", "是不是", "好不好", "行不行", "能不能", "还是", "就是", "然后", "一下", "这个", "那个",
  "关注", "关心", "喜欢", "主动", "要求", "查看", "使用", "倾向", "经常", "常", "偏", "高频",
  // 线程/recap 结构词（英文标签，会以高词频污染拉丁候选）
  "assistant", "user", "system", "session", "recap", "tool", "tools", "agent", "device",
];

const CJK_ENTITY_RE = /[\u4e00-\u9fff]{2,}/g;
const LATIN_ENTITY_RE = /\b[A-Za-z][A-Za-z0-9]{1,}\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 长词优先的停用词剥离正则（防「在哪里」被「在哪」先吃掉剩「里」）。 */
const STOPWORD_RE = new RegExp(
  [...ENTITY_STOPWORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
  "g",
);

/** 查询词规范化：仅折叠空白（格式化，非截断）——长度对齐主流 agent 交由模型
 * 自决与搜索后端自限，代码层不做任何字符切除（静默切半句破坏查询语义）。 */
function normalizeQuery(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 回复是否「宣称做过搜索/检索」（2026-09-13 搜索宣称一致性闸的词面半边）。
 *
 * 判据一半是服务端已知事实（本轮有没有真实搜索执行过/证据注入过——代码
 * 确定知道），词面只负责识别「宣称」行为本身，不做话题判定：系统没搜过而
 * 回复宣称搜过 = 确定性违约，与回复聊什么话题无关。
 */
const SEARCH_CLAIM_RE =
  /搜出来|搜到|搜过|搜了|搜了一圈|搜一遍|翻了|翻遍|查了|查过|查不到|查一圈|检索到|检索过|联网(?:搜索|查询|检索)|网上(?:查|搜)|各大?(?:平台|渠道)(?:都)?(?:翻|查|搜)|公开渠道/;

export function claimsWebSearch(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 2000) return false;
  return SEARCH_CLAIM_RE.test(t);
}

function stripStopwords(text: string): string {
  return (text ?? "").replace(STOPWORD_RE, " ");
}

/**
 * 剥行首称呼语（「王哥，…」）：assistant 回复恒以对用户的称呼开头，被称呼者
 * 是受话人不是所指实体，但词频极高（每条回复一次），频次统计里会压过真名
 * （真实测试实证「王哥 她最近在哪」）。称谓段 = 行首 1-4 个非标点字符 + 逗号。
 */
function stripLeadingVocative(line: string): string {
  return (line ?? "").replace(/^\s*[^\s，。；！？、]{1,4}[,，]/, " ");
}

/** 用户当前消息剥停用词后的首个实体：有则当前消息实体最优先。 */
function pickEntityFromText(text: string): string | null {
  const cleaned = stripStopwords(text);
  const cjk = [...cleaned.matchAll(CJK_ENTITY_RE)].map((m) => m[0]);
  if (cjk.length > 0) return cjk[0];
  const latin = [...cleaned.matchAll(LATIN_ENTITY_RE)].map((m) => m[0]);
  return latin.length > 0 ? latin[0] : null;
}

/** 角色/指代词表（用于识别「实体映射行」，如「称『老婆』→刘浩存」）。 */
const ROLE_WORD_RE = /她|他|老婆|老公|女朋友|男朋友|对象|媳妇/;

/**
 * 上下文行频次选实体。三个确定性判别信号（真实测试多轮打磨）：
 *   1. 频次：候选在各行出现次数；
 *   2. 角色同现加权 ×2：行内含用户消息同款角色词（她/老婆…）的行是「实体映射
 *      行」（如「关注演员刘浩存（称『老婆』）」），其候选更可能是所指实体；
 *   3. 长度加权 ×2：≥3 字候选（中文人名典型长度）压过 2 字称呼/泛词
 *      （王哥/用户/周日这类高频非实体词）。
 * CJK 候选严格优先于拉丁候选（recap 英文虚词 the/assistant 词频高但全是噪声）。
 * 返回 null 表示上下文无任何实体。
 */
function pickEntityFromContext(
  lines: string[],
): string | null {
  type Entry = { display: string; n: number; len: number; first: number; score: number };
  const cjk = new Map<string, Entry>();
  const latin = new Map<string, Entry>();
  let order = 0;
  const bump = (map: Map<string, Entry>, display: string, lineWeight: number): void => {
    const key = display.toLowerCase();
    const hit = map.get(key);
    if (hit) {
      hit.n += 1;
      hit.score += lineWeight;
    } else {
      map.set(key, { display, n: 1, len: display.length, first: order, score: lineWeight });
    }
    order += 1;
  };
  for (const line of lines) {
    const cleaned = stripStopwords(stripLeadingVocative(line));
    // 角色行判定用完整角色词表（不要求与用户消息同词）：用户说「她」，记忆里写
    // 的是「称『老婆』」——同一所指在不同语料里用词不同，任一角色词在行内即
    // 视为「实体映射行」（真实测试实证：按同词匹配会让映射行拿不到加权）。
    const lineWeight = ROLE_WORD_RE.test(line) ? 2 : 1;
    for (const m of cleaned.matchAll(CJK_ENTITY_RE)) {
      const run = m[0];
      if (run.length <= 4) {
        bump(cjk, run, lineWeight * (run.length >= 3 ? 2 : 1));
      } else {
        // 无分词的长串（修饰语+实体粘连）：只取头/尾 2-4 字滑窗作候选，
        // 长串整体不当候选（同频时 len 优先会让它压过真名）。
        for (const w of [2, 3, 4]) {
          bump(cjk, run.slice(0, w), lineWeight * (w >= 3 ? 2 : 1));
          bump(cjk, run.slice(-w), lineWeight * (w >= 3 ? 2 : 1));
        }
      }
    }
    for (const m of cleaned.matchAll(LATIN_ENTITY_RE)) bump(latin, m[0], lineWeight);
  }
  const bestOf = (counts: Map<string, Entry>): Entry | null => {
    let best: Entry | null = null;
    for (const e of counts.values()) {
      if (!best) {
        best = e;
        continue;
      }
      if (e.score !== best.score) {
        if (e.score > best.score) best = e;
        continue;
      }
      // 同分：长度最接近 3 字者优先（中文人名典型长度；4 字滑窗伪影/2 字称呼词退位）
      const eNameFit = Math.abs(e.len - 3);
      const bNameFit = Math.abs(best.len - 3);
      if (eNameFit < bNameFit || (eNameFit === bNameFit && e.first < best.first)) best = e;
    }
    return best;
  };
  return bestOf(cjk)?.display ?? bestOf(latin)?.display ?? null;
}

/**
 * 构造 realtime 轮的搜索词（确定性，无 LLM 参与）。
 * contextLines：最近对话（最旧在前）+ 记忆档案/profile 行——实体频次统计语料。
 */
export function composeRealtimeSearchQuery(
  userText: string,
  contextLines: string[] = [],
): string {
  const text = (userText ?? "").trim();
  if (!text) return "";
  // 当前消息自带实体 → 原话即查询词（实体已在其中，不重复拼接）
  if (pickEntityFromText(text)) return normalizeQuery(text);
  // 纯指代消息 → 上下文频次选实体，拼「实体 + 查询词」
  const entity = pickEntityFromContext(contextLines);
  if (entity) return normalizeQuery(`${entity} ${text}`);
  // 无任何实体 → 查询词兜底（仍是可执行的搜索词）
  return normalizeQuery(text);
}
