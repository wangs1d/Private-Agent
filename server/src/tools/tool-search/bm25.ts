import { reciprocalRankFusion } from "../../agent/retrieval/rrf.js";
import { getToolIntentMetadata } from "./intent-metadata.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "and", "or", "is", "are",
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "这", "那", "有", "和", "中",
]);

function pushToken(tokens: string[], raw: string): void {
  const t = raw.trim();
  if (!t || STOP_WORDS.has(t)) return;
  if (/[\u4e00-\u9fa5]/.test(t)) {
    if (t.length >= 2) tokens.push(t);
    for (let i = 0; i < t.length - 1; i++) {
      const bg = t.slice(i, i + 2);
      if (!STOP_WORDS.has(bg)) tokens.push(bg);
    }
    return;
  }
  if (t.length >= 2) tokens.push(t);
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(/[\u4e00-\u9fa5]+|[a-z0-9_.-]+/g)) {
    const t = match[0]?.trim();
    if (!t) continue;
    if (/[\u4e00-\u9fa5]/.test(t)) {
      pushToken(tokens, t);
      continue;
    }
    pushToken(tokens, t);
    for (const part of t.split(/[._-]/)) {
      pushToken(tokens, part);
    }
  }

  return tokens;
}

export type Bm25Document = {
  id: string;
  text: string;
};

type SearchAliasEntry = {
  registryName: string;
  searchAliases?: string[];
  /** 可选：catalog 构建时预计算的字符 trigram 集合，用于 trigram 排名加速 */
  trigramSet?: Set<string>;
};

export type Bm25Hit = {
  id: string;
  score: number;
};

export class Bm25Index {
  private readonly docs: Bm25Document[];
  private readonly docTokens: string[][];
  private readonly avgDl: number;
  private readonly df = new Map<string, number>();
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(docs: Bm25Document[]) {
    this.docs = docs;
    this.docTokens = docs.map((d) => tokenize(d.text));
    let totalLen = 0;
    for (const tokens of this.docTokens) {
      totalLen += tokens.length;
      const seen = new Set<string>();
      for (const t of tokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
    this.avgDl = docs.length > 0 ? totalLen / docs.length : 0;
  }

  search(query: string, limit: number, aliasEntries?: SearchAliasEntry[]): Bm25Hit[] {
    const queries = expandSearchQueries(query, aliasEntries);
    if (queries.length === 0 || this.docs.length === 0) return [];

    const bm25Ranking = rankByBm25(
      this.docs,
      this.docTokens,
      this.df,
      this.avgDl,
      queries,
      this.k1,
      this.b,
    );
    const overlapRanking = rankByTokenOverlap(this.docs, queries);
    const fuzzyRanking = rankByTrigramSimilarity(this.docs, queries);
    const registryRanking = rankByRegistryName(this.docs, queries);

    const fused = reciprocalRankFusion(
      [bm25Ranking, overlapRanking, fuzzyRanking, registryRanking],
      40,
      Math.max(limit * 4, 12),
    );
    const boosted = applySearchRankingBoosts(
      fused.map((hit) => ({ id: hit.id, score: hit.rrf })),
      query,
      this.docs,
    );
    boosted.sort((a, b) => b.score - a.score);
    if (boosted.length > 0) return boosted.slice(0, limit);

    return rankBySubstringFallback(this.docs, queries, query).slice(0, limit);
  }
}

function rankByBm25(
  docs: Bm25Document[],
  docTokens: string[][],
  df: Map<string, number>,
  avgDl: number,
  queries: string[],
  k1: number,
  b: number,
): Array<{ id: string }> {
  const N = docs.length;
  const scoreById = new Map<string, number>();

  for (const query of queries) {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) continue;

    for (let i = 0; i < docs.length; i++) {
      const tokens = docTokens[i];
      const dl = tokens.length;
      if (dl === 0) continue;

      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);

      let score = 0;
      for (const qToken of qTokens) {
        const freq = tf.get(qToken) ?? 0;
        if (freq === 0) continue;
        const docFreq = df.get(qToken) ?? 0;
        const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
        const denom = freq + k1 * (1 - b + b * (dl / (avgDl || 1)));
        score += idf * ((freq * (k1 + 1)) / denom);
      }

      if (score > 0) {
        scoreById.set(docs[i].id, Math.max(scoreById.get(docs[i].id) ?? 0, score));
      }
    }
  }

  return sortRanking(scoreById);
}

function rankByTokenOverlap(docs: Bm25Document[], queries: string[]): Array<{ id: string }> {
  const scoreById = new Map<string, number>();

  for (const query of queries) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) continue;

    for (const doc of docs) {
      const docTokens = new Set(tokenize(doc.text));
      if (docTokens.size === 0) continue;
      let shared = 0;
      for (const token of queryTokens) {
        if (docTokens.has(token)) shared += 1;
      }
      if (shared === 0) continue;
      const score = shared / Math.sqrt(queryTokens.size * docTokens.size);
      scoreById.set(doc.id, Math.max(scoreById.get(doc.id) ?? 0, score));
    }
  }

  return sortRanking(scoreById);
}

function rankByTrigramSimilarity(
  docs: Bm25Document[],
  queries: string[],
  aliasEntries?: SearchAliasEntry[],
): Array<{ id: string }> {
  const scoreById = new Map<string, number>();
  // 优先从 aliasEntries 拿预计算的 trigramSet（catalog 构建时已缓存），
  // 避免每次 search 都重算 O(D × L)。仅当 aliasEntries 缺失时才回退到原始重算。
  const docGramsCache =
    aliasEntries?.length && aliasEntries[0]?.trigramSet
      ? new Map(aliasEntries.map((e) => [e.registryName, e.trigramSet!]))
      : null;

  for (const query of queries) {
    const queryGrams = buildCharacterTrigrams(query);
    if (queryGrams.size === 0) continue;

    for (const doc of docs) {
      const docGrams =
        docGramsCache?.get(doc.id) ??
        (docGramsCache == null ? buildCharacterTrigrams(doc.text) : null);
      if (!docGrams || docGrams.size === 0) continue;
      let shared = 0;
      for (const gram of queryGrams) {
        if (docGrams.has(gram)) shared += 1;
      }
      if (shared === 0) continue;
      const score = shared / Math.sqrt(queryGrams.size * docGrams.size);
      scoreById.set(doc.id, Math.max(scoreById.get(doc.id) ?? 0, score));
    }
  }

  return sortRanking(scoreById);
}

function rankByRegistryName(docs: Bm25Document[], queries: string[]): Array<{ id: string }> {
  const scoreById = new Map<string, number>();
  const queryTokens = Array.from(new Set(queries.flatMap((query) => tokenize(query))));

  for (const doc of docs) {
    const idLower = doc.id.toLowerCase();
    const idNorm = idLower.replace(/\./g, "_");
    let score = 0;
    for (const token of queryTokens) {
      if (token.length < 2) continue;
      if (idLower === token || idNorm === token) score += 5;
      else if (idLower.startsWith(token) || idNorm.startsWith(token)) score += 2.5;
      else if (idLower.includes(token) || idNorm.includes(token)) score += 1;
    }
    if (score > 0) scoreById.set(doc.id, score);
  }

  return sortRanking(scoreById);
}

function rankBySubstringFallback(
  docs: Bm25Document[],
  queries: string[],
  rawQuery: string,
): Bm25Hit[] {
  const qLower = rawQuery.toLowerCase().trim();
  if (!qLower) return [];
  const fallbackById = new Map<string, number>();

  for (const query of queries) {
    const qTokens = tokenize(query);
    for (const doc of docs) {
      const textLower = doc.text.toLowerCase();
      const idLower = doc.id.toLowerCase();
      if (
        textLower.includes(qLower) ||
        idLower.includes(qLower) ||
        qTokens.some((token) => textLower.includes(token) || idLower.includes(token))
      ) {
        fallbackById.set(doc.id, Math.max(fallbackById.get(doc.id) ?? 0, 0.01));
      }
    }
  }

  return applySearchRankingBoosts(
    Array.from(fallbackById.entries()).map(([id, score]) => ({ id, score })),
    rawQuery,
    docs,
  ).sort((a, b) => b.score - a.score);
}

function sortRanking(scoreById: Map<string, number>): Array<{ id: string }> {
  return Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id }));
}

function buildCharacterTrigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return new Set();
  if (normalized.length <= 3) return new Set([normalized]);

  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 2; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

// 暴露给 catalog.ts 用于预计算 trigram 集合（避免每次 search 都重算）。
export { buildCharacterTrigrams, expandSearchQueries };

function registryNameSearchTokens(name: string): string[] {
  const segments = name.split(/[._-]+/).filter((s) => s.length >= 2);
  const underscored = name.replace(/\./g, "_");
  return [...segments, underscored !== name ? underscored : ""].filter(Boolean);
}

function applySearchRankingBoosts(
  hits: Bm25Hit[],
  query: string,
  docs: Bm25Document[],
): Bm25Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits;

  const docById = new Map(docs.map((d) => [d.id, d]));
  const qNorm = q.replace(/\s+/g, "_").replace(/\./g, "_");
  const qTokens = tokenize(q);

  return hits.map((hit) => {
    const doc = docById.get(hit.id);
    if (!doc) return hit;

    const idLower = hit.id.toLowerCase();
    const idNorm = idLower.replace(/\./g, "_");
    let boost = 0;

    if (idLower === q || idNorm === qNorm) boost += 8;
    else if (idLower.startsWith(q) || idNorm.startsWith(qNorm)) boost += 4;
    else if (idLower.includes(q) || idNorm.includes(qNorm)) boost += 2;

    const idSegments = hit.id.split(/[._-]+/).map((s) => s.toLowerCase());
    for (const token of qTokens) {
      if (token.length < 2) continue;
      if (idSegments.some((seg) => seg === token || seg.startsWith(token))) boost += 0.6;
    }

    return boost > 0 ? { ...hit, score: hit.score + boost } : hit;
  });
}

export function buildToolSearchText(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): { text: string; aliases: string[] } {
  const paramNames = extractParameterNames(tool.parameters);
  const paramValues = extractParameterValues(tool.parameters);
  const metadata = getToolIntentMetadata(tool.name);
  const aliases = [...toolSearchAliases(tool.name), ...(metadata.aliases ?? [])];
  const nameTokens = registryNameSearchTokens(tool.name);
  return {
    text: [
      tool.name,
      tool.description ?? "",
      ...nameTokens,
      ...paramNames,
      ...paramValues,
      ...aliases,
      ...(metadata.examples ?? []),
    ]
      .filter(Boolean)
      .join(" "),
    aliases,
  };
}

function toolSearchAliases(name: string): string[] {
  const aliases: string[] = [];
  const prefixRules: Array<{ prefix: string; words: string[] }> = [
    { prefix: "calendar.", words: ["日历", "日程", "待办", "提醒"] },
    { prefix: "phone.", words: ["电话", "短信", "联系", "call", "message"] },
    { prefix: "weather.", words: ["天气", "气温", "预报"] },
    { prefix: "shopping.", words: ["购物", "买东西", "比价", "推荐", "shopping", "buy"] },
    { prefix: "wallet.", words: ["钱包", "余额", "转账", "支付", "消费"] },
    { prefix: "embodiment.", words: ["桌面", "窗口", "移动", "身体", "化身"] },
    { prefix: "memory.", words: ["记忆", "回忆", "笔记"] },
    { prefix: "schedule.", words: ["定时", "计划任务", "cron"] },
    { prefix: "desktop.visual.", words: ["截图", "屏幕", "键鼠", "computer"] },
    { prefix: "browser.", words: ["浏览器", "网页", "cookie", "页面"] },
    { prefix: "mcp.", words: ["外部工具", "平台", "文件", "mcp"] },
  ];
  for (const rule of prefixRules) {
    if (name.startsWith(rule.prefix)) aliases.push(...rule.words);
  }
  return aliases;
}

function extractParameterNames(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
}

function extractParameterValues(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];

  const values: string[] = [];
  for (const value of Object.values(props)) {
    if (!value || typeof value !== "object") continue;
    const schema = value as {
      enum?: unknown[];
      const?: unknown;
      description?: string;
      title?: string;
    };
    if (typeof schema.title === "string") values.push(schema.title);
    if (typeof schema.description === "string") values.push(schema.description);
    if (Array.isArray(schema.enum)) {
      for (const item of schema.enum) {
        if (typeof item === "string" || typeof item === "number") values.push(String(item));
      }
    }
    if (typeof schema.const === "string" || typeof schema.const === "number") {
      values.push(String(schema.const));
    }
  }
  return values;
}

function expandSearchQueries(query: string, aliasEntries?: SearchAliasEntry[]): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9._\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const variants = new Set<string>([trimmed, normalized]);

  const replacements: Array<[RegExp, string]> = [
    [/\bwechat\b/gi, "weixin 微信"],
    [/\bweixin\b/gi, "wechat 微信"],
    [/\bxhs\b/gi, "xiaohongshu 小红书"],
    [/\bdouyin\b/gi, "抖音 tiktok"],
    [/\bremind(er)?\b/gi, "提醒 reminder schedule calendar"],
    [/\bcall\b/gi, "电话 phone call"],
    [/\bmessage\b/gi, "短信 message send"],
    [/\bbuy\b/gi, "购买 下单 buy order"],
    [/\bbook\b/gi, "预订 预约 book reserve"],
    [/\bshop(ping)?\b/gi, "shopping buy compare recommend"],
    [/\bcompare\b/gi, "compare suggest shopping prices"],
    [/\bprice\b/gi, "price compare budget shopping"],
    // 中文同义词扩展：BM25 单工具级文本匹配对中文近义词很弱，
    // 把常见口语/别名扩展成标准工具词，显著提升召回（如「配音」→ voice/tts）。
    // 注意：长精确词放前（语音合成/语音消息），避免被短词（语音）先替换吃掉。
    [/语音合成|合成语音|配音|音频(?:生成)?/gi, "语音合成 配音 音频 语音 voice speak tts speech"],
    [/语音消息|语音(?:播报|回复|对话|通话|提醒)/gi, "语音消息 语音播报 语音 voice speak send_message 播报"],
    [/念(?:给我听|出来)?|朗读|播报|读出来|说出来|发语音|用语音/gi, "朗读 播报 念 读出来 语音 speak voice tts"],
    [/提醒|闹钟|定时(?:提醒)?/gi, "提醒 reminder schedule calendar 闹钟"],
    [/日程|会议|待办|预约/gi, "日程 会议 待办 calendar schedule meeting"],
    [/截图|屏幕(?:截图|画面)?|截屏|截(?:个)?(?:图|屏)/gi, "截图 屏幕 截屏 screenshot desktop.visual"],
    [/搜(?:索|一下|一搜)|查一下|查询/gi, "搜索 查询 search search_web web"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(trimmed)) {
      variants.add(trimmed.replace(pattern, replacement));
    }
  }

  const queryTokens = tokenize(normalized);
  const queryTokenSet = new Set(queryTokens);
  const addedVariants: string[] = [];
  const MAX_VARIANTS = 5; // 限制变体数，避免 BM25/Trigram 多路 RRF 跑 N 次
  if (aliasEntries?.length && queryTokens.length > 0) {
    // 优化：把每个 entry 的所有 alias 预先拼接并 lowercase 一次，
    // 然后用 queryToken 逐个做 includes，避免每对 (alias, token) 都重复 substring。
    // 在 100+ 工具 × 10+ alias × 10+ token 的情况下，旧的 O(N×M×K) substring 拼接约 100ms，
    // 优化后降到 O(N×K)。
    // 同时按 entry 的"语义匹配度"（alias 与 query 重叠 token 数）排序，
    // 只取前 MAX_VARIANTS 个最相关的变体，避免变体爆炸。
    type ScoredEntry = { registryName: string; score: number };
    const scored: ScoredEntry[] = [];
    for (const entry of aliasEntries) {
      if (!entry.searchAliases?.length) continue;
      const aliasBag = entry.searchAliases.map((a) => a.toLowerCase()).join("|");
      if (!aliasBag) continue;
      let overlap = 0;
      for (const token of queryTokenSet) {
        if (token.length < 2) continue;
        if (aliasBag.includes(token)) overlap += 1;
      }
      if (overlap > 0) scored.push({ registryName: entry.registryName, score: overlap });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
      if (addedVariants.length >= MAX_VARIANTS) break;
      const v = `${trimmed} ${s.registryName}`;
      variants.add(v);
      addedVariants.push(v);
    }
  }

  return Array.from(variants).filter(Boolean);
}
