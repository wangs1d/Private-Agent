const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "and", "or", "is", "are",
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "这", "那", "有", "和", "与", "或",
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

function tokenize(text: string): string[] {
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

export type Bm25Hit = {
  id: string;
  score: number;
};

/**
 * 轻量 BM25 检索（tool name + description + parameter names）。
 */
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

  search(query: string, limit: number): Bm25Hit[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0 || this.docs.length === 0) return [];

    const N = this.docs.length;
    const scores: Bm25Hit[] = [];

    for (let i = 0; i < this.docs.length; i++) {
      const docTokens = this.docTokens[i];
      const dl = docTokens.length;
      if (dl === 0) continue;

      const tf = new Map<string, number>();
      for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

      let score = 0;
      for (const qt of qTokens) {
        const freq = tf.get(qt) ?? 0;
        if (freq === 0) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = freq + this.k1 * (1 - this.b + this.b * (dl / (this.avgDl || 1)));
        score += idf * ((freq * (this.k1 + 1)) / denom);
      }

      if (score > 0) scores.push({ id: this.docs[i].id, score });
    }

    const boosted = applySearchRankingBoosts(scores, query, this.docs);
    boosted.sort((a, b) => b.score - a.score);
    if (boosted.length > 0) return boosted.slice(0, limit);

    const qLower = query.toLowerCase().trim();
    if (!qLower) return [];
    const fallback: Bm25Hit[] = [];
    for (const doc of this.docs) {
      const textLower = doc.text.toLowerCase();
      const idLower = doc.id.toLowerCase();
      if (
        textLower.includes(qLower) ||
        idLower.includes(qLower) ||
        qTokens.some((qt) => textLower.includes(qt) || idLower.includes(qt))
      ) {
        fallback.push({ id: doc.id, score: 0.01 });
      }
    }
    const boostedFallback = applySearchRankingBoosts(fallback, query, this.docs);
    boostedFallback.sort((a, b) => b.score - a.score);
    return boostedFallback.slice(0, limit);
  }
}

/** 注册名分段 + 下划线形式，提升「gomoku create」类检索命中率。 */
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

  return hits.map((hit) => {
    const doc = docById.get(hit.id);
    if (!doc) return hit;

    const idLower = hit.id.toLowerCase();
    const idNorm = idLower.replace(/\./g, "_");
    let boost = 0;

    if (idLower === q || idNorm === qNorm) boost += 8;
    else if (idLower.startsWith(q) || idNorm.startsWith(qNorm)) boost += 4;
    else if (idLower.includes(q) || idNorm.includes(qNorm)) boost += 2;

    const qTokens = tokenize(q);
    const idSegments = hit.id.split(/[._-]+/).map((s) => s.toLowerCase());
    for (const qt of qTokens) {
      if (qt.length < 2) continue;
      if (idSegments.some((seg) => seg === qt || seg.startsWith(qt))) boost += 0.6;
    }

    return boost > 0 ? { ...hit, score: hit.score + boost } : hit;
  });
}

export function buildToolSearchText(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): string {
  const paramNames = extractParameterNames(tool.parameters);
  const aliases = toolSearchAliases(tool.name);
  const nameTokens = registryNameSearchTokens(tool.name);
  return [tool.name, tool.description ?? "", ...nameTokens, ...paramNames, ...aliases]
    .filter(Boolean)
    .join(" ");
}

/** 领域别名（中文 + 英文片段），弥补描述里未写到的口语检索词。 */
function toolSearchAliases(name: string): string[] {
  const aliases: string[] = [];
  const prefixRules: Array<{ prefix: string; words: string[] }> = [
    { prefix: "world.doudizhu.", words: ["斗地主", "doudizhu", "扑克", "地主", "游戏"] },
    { prefix: "world.zhajinhua.", words: ["炸金花", "zhajinhua", "金花", "比牌", "游戏"] },
    { prefix: "world.gomoku.", words: ["五子棋", "gomoku", "下棋", "棋", "游戏"] },
    { prefix: "gomoku.", words: ["五子棋", "gomoku", "下棋", "棋"] },
    { prefix: "world.blackjack.", words: ["21点", "blackjack", "二十一点", "要牌", "停牌", "游戏"] },
    { prefix: "world.game_center.", words: ["游戏中心", "游戏大厅", "game center"] },
    { prefix: "calendar.", words: ["日历", "日程", "待办", "提醒"] },
    { prefix: "phone.", words: ["电话", "短信", "联系人"] },
    { prefix: "weather.", words: ["天气", "气温", "预报"] },
    { prefix: "embodiment.", words: ["窗口", "桌面", "球体", "化身", "移动"] },
    { prefix: "memory.", words: ["记忆", "回忆", "笔记"] },
    { prefix: "schedule.", words: ["定时", "计划任务", "cron"] },
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
