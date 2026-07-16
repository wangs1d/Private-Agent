/**
 * 搜索增强模块：缓存 + RSS 健康检查 + 搜索意图识别 + 跨查询复用
 *
 * 四个独立能力，可单独或组合使用：
 *   1. SearchCache：内存 LRU + TTL，重复查询零成本
 *   2. RssHealthMonitor：RSS 源健康检查，连续失败自动降级
 *   3. SearchIntentClassifier：识别查询意图（对比/调研/价格/最新），影响搜索策略
 *   4. SessionSearchCache：同会话内跨查询复用结果片段
 */

import type { InfoSearchItem } from "./info-hub-service.js";

// ============================================================
// 1. SearchCache：内存 LRU + TTL
// ============================================================

type CacheEntry<T> = {
  value: T;
  expireAt: number; // 绝对过期时间戳
  createdAt: number;
};

export class SearchCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(opts: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = opts.maxSize ?? 200;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000; // 默认 5 分钟
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU：访问时移到末尾（Map 保持插入顺序）
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMsOverride?: number): void {
    const ttl = ttlMsOverride ?? this.ttlMs;
    // 容量淘汰
    while (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey === undefined) break;
      this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expireAt: Date.now() + ttl,
      createdAt: Date.now(),
    });
  }

  /** 命中统计（用于测试和监控） */
  stats(): { size: number; hitCount: number; missCount: number } {
    return {
      size: this.store.size,
      hitCount: this._hitCount,
      missCount: this._missCount,
    };
  }

  private _hitCount = 0;
  private _missCount = 0;

  /** 带统计的 get */
  getWithStats(key: string): T | undefined {
    const v = this.get(key);
    if (v !== undefined) this._hitCount++;
    else this._missCount++;
    return v;
  }

  clear(): void {
    this.store.clear();
    this._hitCount = 0;
    this._missCount = 0;
  }
}

// ============================================================
// 2. RssHealthMonitor：RSS 源健康检查 + 自动降级
// ============================================================

type SourceHealth = {
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 上次成功时间戳 */
  lastSuccessAt: number;
  /** 是否被降级（连续失败超过阈值后暂停使用） */
  degraded: boolean;
  /** 降级恢复时间戳（降级后冷却期过后自动恢复） */
  degradedUntil?: number;
};

export class RssHealthMonitor {
  private readonly health = new Map<string, SourceHealth>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3; // 连续失败 3 次降级
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000; // 降级 10 分钟
  }

  /** 记录成功 */
  recordSuccess(source: string): void {
    this.health.set(source, {
      consecutiveFailures: 0,
      lastSuccessAt: Date.now(),
      degraded: false,
      degradedUntil: undefined,
    });
  }

  /** 记录失败，返回是否触发降级 */
  recordFailure(source: string): boolean {
    const prev = this.health.get(source) ?? {
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      degraded: false,
    };
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const degraded = consecutiveFailures >= this.failureThreshold;
    this.health.set(source, {
      consecutiveFailures,
      lastSuccessAt: prev.lastSuccessAt,
      degraded,
      degradedUntil: degraded ? Date.now() + this.cooldownMs : undefined,
    });
    return degraded;
  }

  /** 判断源是否可用（未降级或冷却期已过） */
  isAvailable(source: string): boolean {
    const h = this.health.get(source);
    if (!h || !h.degraded) return true;
    // 冷却期过后自动恢复
    if (h.degradedUntil && Date.now() > h.degradedUntil) {
      h.degraded = false;
      h.consecutiveFailures = 0;
      h.degradedUntil = undefined;
      return true;
    }
    return false;
  }

  /** 过滤出可用的源列表 */
  filterAvailable<T extends { source: string; url: string }>(sources: T[]): T[] {
    return sources.filter((s) => this.isAvailable(s.source));
  }

  /** 健康状态快照（用于测试和监控） */
  snapshot(): Record<string, SourceHealth> {
    const out: Record<string, SourceHealth> = {};
    for (const [k, v] of this.health) out[k] = { ...v };
    return out;
  }
}

// ============================================================
// 3. SearchIntentClassifier：搜索意图识别
// ============================================================

export type SearchIntent =
  | "latest" // 最新/最近/今日/新闻
  | "compare" // 对比/VS
  | "research" // 调研/了解/分析/介绍
  | "price" // 价格/报价/多少钱
  | "definition" // 是什么/什么是/解释
  | "general"; // 通用

export type IntentAnalysis = {
  intent: SearchIntent;
  /** 提取的核心实体（用于搜索变体生成） */
  entities: string[];
  /** 建议的 limit */
  suggestedLimit?: number;
  /** 是否需要强制联网 */
  requiresFreshWeb: boolean;
};

const INTENT_PATTERNS: Array<{ intent: SearchIntent; re: RegExp }> = [
  { intent: "latest", re: /最新|最近|今日|今天|现在|目前|刚刚|新闻|事件|发生|breaking|news|event|latest|recent|current|today/i },
  { intent: "compare", re: /对比|比较|VS|vs|哪个好|区别|差异|优缺点/i },
  { intent: "price", re: /价格|报价|多少钱|价位|售价|费用|cost|price|how much/i },
  // definition 必须在 research 之前判断（"什么是X"是定义查询，不是调研）
  { intent: "definition", re: /是什么|什么是|什么意思|定义|含义|definition|meaning/i },
  { intent: "research", re: /调研|了解|分析|介绍|怎么样|如何|解释|百科|review|introduce|explain|what is/i },
];

export function classifySearchIntent(query: string): IntentAnalysis {
  const q = query.trim();

  // 识别意图
  let intent: SearchIntent = "general";
  for (const { intent: i, re } of INTENT_PATTERNS) {
    if (re.test(q)) {
      intent = i;
      break;
    }
  }

  // 提取核心实体
  const entities: string[] = [];

  // 1. 移除时效性词汇，剩余部分作为核心实体
  const cleaned = q.replace(/最新|最近|今日|今天|现在|目前|刚刚|新闻|消息|资讯|事件|发生|怎么样|如何|是什么|什么是|什么意思|breaking|news|event|latest|recent|current|today/gi, " ");

  // 2. 中文连续段（2 字以上，降低阈值提高召回）
  const cnRuns = [...cleaned.matchAll(/[\u4e00-\u9fff]{2,10}/gu)].map((m) => m[0]);
  for (const run of cnRuns.sort((a, b) => b.length - a.length).slice(0, 3)) {
    if (!/^(最新|最近|今日|今天|什么|怎么|为什么|怎么样|了解|调研|分析|介绍|发生|事件)$/u.test(run)) {
      entities.push(run);
    }
  }

  // 3. 中英混合词（如 A股、B股、H股、AI芯片）— 关键实体
  const mixedRuns = [...cleaned.matchAll(/[a-zA-Z]{1,3}[\u4e00-\u9fff]{1,4}/gu)].map((m) => m[0]);
  for (const run of mixedRuns) {
    entities.push(run);
  }

  // 4. 英文实体（大写开头的词组，如 OpenAI、iPhone）
  const enRuns = [...cleaned.matchAll(/\b[A-Z][a-zA-Z]{2,}\b/g)].map((m) => m[0]);
  entities.push(...enRuns.slice(0, 2));

  // 5. 英文小写词（如 ai、gpt）
  const enLower = [...cleaned.matchAll(/\b[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase())
    .filter((w) => !/^(the|and|for|with|how|what|when|where|why)$/i.test(w));
  entities.push(...enLower.slice(0, 2));

  // 建议参数
  const suggestedLimit =
    intent === "latest" ? 8 :
    intent === "compare" ? 10 :
    intent === "research" ? 6 :
    intent === "price" ? 5 :
    undefined;

  const requiresFreshWeb =
    intent === "latest" ||
    intent === "price" ||
    /最新|最近|今日|现在|价格|报价|news|latest|price/i.test(q);

  return { intent, entities, suggestedLimit, requiresFreshWeb };
}

// ============================================================
// 4. SessionSearchCache：同会话内跨查询复用
// ============================================================

type SessionEntry = {
  query: string;
  items: InfoSearchItem[];
  fetchedAt: number;
  /** 提取的关键词，用于后续相似查询匹配 */
  keywords: string[];
};

export class SessionSearchCache {
  private readonly sessions = new Map<string, SessionEntry[]>();
  private readonly maxEntriesPerSession: number;
  private readonly maxAgeMs: number;
  private readonly similarityThreshold: number;

  constructor(opts: { maxEntriesPerSession?: number; maxAgeMs?: number; similarityThreshold?: number } = {}) {
    this.maxEntriesPerSession = opts.maxEntriesPerSession ?? 10;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1000; // 30 分钟
    this.similarityThreshold = opts.similarityThreshold ?? 0.3; // 较低阈值，只要有一个核心实体相同就复用
  }

  /** 记录一次搜索结果 */
  record(sessionId: string, query: string, items: InfoSearchItem[]): void {
    const entries = this.sessions.get(sessionId) ?? [];
    const keywords = extractKeywords(query);
    entries.push({ query, items, fetchedAt: Date.now(), keywords });

    // 容量淘汰 + 过期清理
    const now = Date.now();
    const kept = entries
      .filter((e) => now - e.fetchedAt < this.maxAgeMs)
      .slice(-this.maxEntriesPerSession);
    this.sessions.set(sessionId, kept);
  }

  /** 查找可复用的结果：相似度 >= 阈值时返回 */
  findReusable(sessionId: string, query: string): InfoSearchItem[] | undefined {
    const entries = this.sessions.get(sessionId);
    if (!entries || entries.length === 0) return undefined;

    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0) return undefined;

    let bestMatch: { items: InfoSearchItem[]; score: number } | undefined;
    for (const entry of entries) {
      const score = jaccardSimilarity(queryKeywords, entry.keywords);
      if (score >= this.similarityThreshold) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { items: entry.items, score };
        }
      }
    }
    return bestMatch?.items;
  }

  clear(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId);
    else this.sessions.clear();
  }
}

function extractKeywords(query: string): string[] {
  const q = query.trim().toLowerCase();
  // 1. 按空格和标点切分
  const words = q
    .split(/[\s,，、。；;:：/|?？!！]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  // 2. 中文连续段（2-6 字，更细粒度，提高相似查询匹配率）
  const cnRuns = [...q.matchAll(/[\u4e00-\u9fff]{2,6}/gu)].map((m) => m[0]);
  // 3. 英文词
  const enWords = [...q.matchAll(/\b[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase());
  return [...new Set([...words, ...cnRuns, ...enWords])];
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// 5. 搜索结果质量评分（相关性 + 权威度 + 时效性）
// ============================================================

// 来源权威度评分（0-1）
const SOURCE_AUTHORITY: Record<string, number> = {
  // 官方媒体（最高）
  "中国新闻网滚动": 0.95,
  "中国新闻网要闻": 0.95,
  "中国新闻网国内": 0.93,
  "中国新闻网国际": 0.93,
  "中国新闻网财经": 0.94,
  "中国新闻网社会": 0.92,
  "人民网时政": 0.94,
  "人民网国际": 0.92,
  "人民网科技": 0.92,
  "央视网": 0.95,
  "环球网": 0.90,
  "联合早报": 0.88,
  "参考消息": 0.90,
  // 科技媒体（中等）
  "36氪": 0.80,
  "IT之家": 0.78,
  // 搜索引擎（通用）
  "必应中国": 0.70,
  "GDELT": 0.65,
};

/**
 * 计算搜索结果的综合质量评分。
 * 评分公式：0.5 * 相关性 + 0.3 * 权威度 + 0.2 * 时效性
 *
 * @param item 搜索结果
 * @param query 原始查询（用于相关性计算）
 * @returns 0-1 之间的评分，越高越优
 */
export function scoreSearchItem(item: InfoSearchItem, query: string): number {
  // 1. 相关性（标题/摘要包含查询关键词的程度）
  const queryKeywords = extractKeywords(query);
  let relevance = 0;
  if (queryKeywords.length > 0) {
    const hay = `${item.title}\n${item.snippet}`.toLowerCase();
    const matched = queryKeywords.filter((k) => hay.includes(k)).length;
    relevance = matched / queryKeywords.length;
    // 标题命中加权
    const titleLower = item.title.toLowerCase();
    const titleMatched = queryKeywords.filter((k) => titleLower.includes(k)).length;
    if (titleMatched > 0) {
      relevance = Math.min(1, relevance + 0.2 * (titleMatched / queryKeywords.length));
    }
  } else {
    relevance = 0.5; // 无关键词时给中等分
  }

  // 2. 权威度
  const authority = SOURCE_AUTHORITY[item.source] ?? 0.6;

  // 3. 时效性（越新越高分，1小时内=1.0，1天内=0.8，7天内=0.5，更早=0.3，未知=0.4）
  let freshness = 0.4;
  if (item.publishedAt) {
    const ts = parseDateMs(item.publishedAt);
    if (ts) {
      const ageMin = (Date.now() - ts) / 60000;
      if (ageMin <= 60) freshness = 1.0;
      else if (ageMin <= 1440) freshness = 0.8;
      else if (ageMin <= 10080) freshness = 0.5;
      else freshness = 0.3;
    }
  }

  return 0.5 * relevance + 0.3 * authority + 0.2 * freshness;
}

/** 按质量评分排序搜索结果 */
export function sortByQuality(items: InfoSearchItem[], query: string): InfoSearchItem[] {
  return items
    .map((item) => ({ item, score: scoreSearchItem(item, query) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

// 解析日期为时间戳（复用 search-freshness 的逻辑，避免循环依赖）
function parseDateMs(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const text = raw.trim();
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  const cn = text.match(/(\d{1,2})\s*(\d{1,2})月\s*(\d{4})/);
  if (cn) {
    const d = new Date(Number(cn[3]), Number(cn[2]) - 1, Number(cn[1]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  const cn2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (cn2) {
    const d = new Date(Number(cn2[1]), Number(cn2[2]) - 1, Number(cn2[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  return undefined;
}

// ============================================================
// 6. 带重试的异步执行（指数退避）
// ============================================================

/**
 * 带指数退避的重试执行。
 * 网络波动导致单次失败时自动重试，提升稳定性。
 *
 * @param fn 要执行的异步函数
 * @param opts 重试配置
 * @returns 函数返回值
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 2000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= maxRetries) break;
      // 指数退避：200ms, 400ms, 800ms... 上限 maxDelayMs
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
