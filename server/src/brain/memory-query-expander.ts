/**
 * 召回查询扩展器（Recall Query Expander）
 *
 * 解决"单窗口长会话"下的召回失焦问题：
 * 用户在同一会话里聊得越久，query 越依赖上下文（"那个呢？""它怎么样？""继续"），
 * 直接拿原始 query 去检索记忆会 miss。
 *
 * 三件事（纯规则，毫秒级，不调 LLM，不增延迟）：
 *   1. 指代消解：query 含指代词（那个/它/刚才/上面）或过短时，
 *      从最近对话历史提取实体补全 query（"它" → "上轮提到的 K3 模型 性能"）。
 *   2. 话题扩展：query 与上轮话题共享关键词时，把上轮话题词拼进 query，
 *      让记忆检索覆盖"话题延续"场景。
 *   3. 多意图拆分：query 用连接词串起多个独立主题时（"Python 和 Rust 的对比"），
 *      拆成多个子 query 供并行召回，避免单一 embedding 被两个主题平均稀释。
 *
 * 使用位置：BrainCenter.cognize 阶段 1（recall 之前）。
 * 输入 query 原文 + 最近对话历史（thread store 拉取）。
 */

/** 指代词（出现即说明 query 需要上下文消解） */
const ANAPHORA_RE =
  /(那个|这个|它们|他俩|刚才|上面说的|前面说|之前说的|上次说的|刚刚说|你说的|我说的|你提到|你刚才)/;

/** 纯追问/续接词（query 几乎没有检索价值，必须靠上下文） */
const CONTINUATION_RE = /^(继续|接着说|然后呢|还有呢|怎么说|怎么说呢|然后|继续说|go on|continue|more|还有吗|没了|就这些)$/i;

/** 多意图连接词 */
const INTENT_SPLIT_RE = /(.{2,}?)(?:和|与|还有|以及|对比一下|比较一下)(.{2,}?)(?:的)?(?:对比|比较|区别|差异|性能)/;

/** 停用词（与 MemoryManagerService 保持一致的精简版） */
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "这", "那", "有", "不", "就",
  "都", "也", "还", "又", "要", "会", "能", "把", "给", "让", "被", "和", "与", "或", "但",
  "今天", "昨天", "明天", "现在", "之前", "以后", "可以", "什么", "怎么", "为什么", "帮我",
  "请问", "一下", "说说", "看看", "觉得", "知道", "这个", "那个", "这些", "那些",
  "the", "a", "an", "is", "are", "was", "were", "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "do", "does", "did", "will", "would", "can", "could", "should", "and", "the",
]);

/** 虚词/口语高频字符：中文候选子串含任一个即视为"非实体"（动词短语/完整句）剔除。
 *  解决旧实现 `[\u4e00-\u9fa5]{2,6}` 贪婪吞长句导致"刘浩存"被切碎为"刘"+"浩存"的问题：
 *  保留的是"刘浩存/照片/写真/火锅"这类不掺杂口语虚词的名词性片段。 */
const NON_ENTITY_CHARS = new Set(
  "的了我在你去帮找搜看看想想说说问给被让和与或是就在都有还要能会把怎么什么为什么请问一下你我他她它们再给想是",
);

/** 工具/状态类杂讯行：这些行来自 tool 回显/状态文本，不承载话题实体，跳过提取 */
const META_NOISE_RE =
  /工具调|tool_|调用尚未|尚未完成|未完成|已保存|已收到|处理中|请稍候|正在(搜索|查询|处理)|完成即|超时/;

/** 从文本提取英文实体词（全小写、≥2 字符、非停用词） */
function extractEnglishWords(text: string): string[] {
  const out: string[] = [];
  const enMatches = text.toLowerCase().match(/[a-z][a-z0-9.+#-]{1,15}/g) ?? [];
  for (const w of enMatches) {
    if (!STOP_WORDS.has(w) && w.length >= 2) out.push(w);
  }
  return out;
}

/** 从中文段提取 2-4 字候选子串（滑窗），过滤含虚词字符的碎片 */
function extractChineseGrams(text: string): string[] {
  const segs = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const out: string[] = [];
  for (const seg of segs) {
    const maxLen = Math.min(4, seg.length);
    for (let n = maxLen; n >= 2; n--) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n);
        if (STOP_WORDS.has(g)) continue;
        // 含虚词/口语动词字符 → 不可靠实体（"帮我搜一下刘"这类长碎片被剔除）
        if ([...g].some((c) => NON_ENTITY_CHARS.has(c))) continue;
        out.push(g);
      }
    }
  }
  return out;
}

/** 从最近对话历史提取"上轮话题实体"：跨行高频聚合 2-4 字名词性片段。
 *  专名（刘浩存/K3/火锅）在几句里重复出现 → 频率高 → 排在杂讯之前。 */
function extractRecentTopicEntities(history: string, maxWords = 6): string[] {
  if (!history) return [];
  const lines = history.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // 取最近 6 行（约 3 轮对话），比旧的 slice(-4) 更能覆盖关键 user 原话
  const recentLines = lines.slice(-6);
  const freq = new Map<string, number>();
  for (const line of recentLines) {
    const body = line.replace(/^\s*(用户|助手|user|assistant)\s*[:：]\s*/i, "").trim();
    if (!body) continue;
    if (META_NOISE_RE.test(body)) continue; // 工具/状态杂讯行不贡献实体
    const words = [...extractEnglishWords(body), ...extractChineseGrams(body)];
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  // 频率降序；同频长度降序（保留更完整实体）；去重保序
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w);
  const seen = new Set<string>();
  return ranked
    .filter((w) => {
      if (seen.has(w)) return false;
      seen.add(w);
      return true;
    })
    .slice(0, maxWords);
}

export interface QueryExpansionInput {
  /** 用户原始输入 */
  query: string;
  /** 最近对话历史（每行一条，如 "用户: xxx" / "助手: xxx"） */
  recentConversationHistory?: string;
}

export interface QueryExpansionResult {
  /** 主检索 query（消解+扩展后；无需扩展时等于原 query） */
  primaryQuery: string;
  /** 多意图拆分出的子 query（含 primaryQuery，供并行召回；单一意图时仅 1 条） */
  subQueries: string[];
  /** 是否发生了扩展 */
  expanded: boolean;
}

/** 计算 query 与历史的词重合度（0-1），用于话题延续判断 */
function topicOverlap(query: string, entities: string[]): number {
  if (entities.length === 0) return 0;
  const queryWords = new Set([
    ...extractEnglishWords(query),
    ...extractChineseGrams(query),
  ]);
  if (queryWords.size === 0) return 0;
  let hit = 0;
  for (const e of entities) {
    if (queryWords.has(e)) hit++;
  }
  return hit / entities.length;
}

/**
 * 展开多意图：如 "Python 和 Rust 的并发性能对比" → ["Python 并发性能", "Rust 并发性能"]。
 * 仅在明显是"A 和 B 对比"句式时拆分，避免误拆。
 */
function splitMultiIntent(query: string): string[] | null {
  const m = query.match(INTENT_SPLIT_RE);
  if (!m) return null;
  const [, left, right] = m;
  const l = left?.trim();
  const r = right?.trim();
  if (!l || !r || l.length < 2 || r.length < 2) return null;
  // 共享尾部主题（如"的并发性能"）挂到两个子意图上
  const tailMatch = query.match(/的(并发|性能|内存|生态|语法|速度|安全|对比|区别)/);
  const tail = tailMatch ? tailMatch[1] : "";
  return [
    tail ? `${l} ${tail}` : l,
    tail ? `${r} ${tail}` : r,
  ].slice(0, 3);
}

/** 纯规则 query 扩展主入口（同步、零延迟） */
export function expandRecallQuery(input: QueryExpansionInput): QueryExpansionResult {
  const query = (input.query ?? "").trim();
  if (!query) return { primaryQuery: "", subQueries: [], expanded: false };

  const history = input.recentConversationHistory ?? "";
  // 排除当前 query 行：brain-center 会把当前 user 消息追加进 history，
  // 若不去掉，"好想她"会把自己扩展成"好想她 好想她"，污染召回 query。
  const filteredHistory = history
    .split("\n")
    .filter((l) => {
      const body = l.replace(/^\s*(用户|助手|user|assistant)\s*[:：]\s*/i, "").trim();
      return body !== query;
    })
    .join("\n");
  const entities = extractRecentTopicEntities(filteredHistory);
  const needsContext =
    ANAPHORA_RE.test(query) || CONTINUATION_RE.test(query.trim()) || query.length <= 6;

  // 拼接扩展 query：原 query + 上轮话题实体（最多 4 个，控制 embedding 噪声）
  let primaryQuery = query;
  let expanded = false;
  if (needsContext && entities.length > 0) {
    const contextWords = entities.slice(0, 4).join(" ");
    primaryQuery = `${query} ${contextWords}`;
    expanded = true;
  } else {
    // 话题延续：query 与上轮话题有重合但没含全部实体 → 补齐缺失实体
    const overlap = topicOverlap(query, entities);
    if (overlap > 0 && overlap < 0.6 && entities.length > 1) {
      const missing = entities.filter((e) => !query.includes(e)).slice(0, 2);
      if (missing.length > 0) {
        primaryQuery = `${query} ${missing.join(" ")}`;
        expanded = true;
      }
    }
  }

  // 多意图拆分（仅在扩展后的主 query 上做，子意图继承上下文词）
  const split = splitMultiIntent(query);
  if (split && split.length >= 2) {
    const subQueries = [primaryQuery, ...split.slice(1)];
    return { primaryQuery, subQueries: dedupeQueries(subQueries), expanded: true };
  }

  return { primaryQuery, subQueries: [primaryQuery], expanded };
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries.filter((q) => {
    const k = q.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 轻量可测门面：供 BrainCenter 直接调用。
 * 未来若要接 LLM 精细消解，在此处加 opt-in 开关，规则路径保持默认。
 */
export class RecallQueryExpander {
  private readonly enabled: boolean;

  constructor() {
    const raw = process.env.MEMORY_QUERY_EXPANDER_ENABLED;
    this.enabled = raw === undefined ? true : !(raw === "0" || raw.toLowerCase() === "false");
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  expand(input: QueryExpansionInput): QueryExpansionResult {
    if (!this.enabled) {
      const q = (input.query ?? "").trim();
      return { primaryQuery: q, subQueries: q ? [q] : [], expanded: false };
    }
    return expandRecallQuery(input);
  }
}
