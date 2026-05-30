const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "and", "or", "is", "are",
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "这", "那", "有", "和", "与", "或",
]);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(/[\u4e00-\u9fa5]|[a-z0-9_./-]+/g)) {
    const t = match[0]?.trim();
    if (!t || t.length < 2 || STOP_WORDS.has(t)) continue;
    tokens.push(t);
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

    scores.sort((a, b) => b.score - a.score);
    if (scores.length > 0) return scores.slice(0, limit);

    const qLower = query.toLowerCase().trim();
    if (!qLower) return [];
    const fallback: Bm25Hit[] = [];
    for (const doc of this.docs) {
      if (doc.id.toLowerCase().includes(qLower) || doc.text.toLowerCase().includes(qLower)) {
        fallback.push({ id: doc.id, score: 0.01 });
      }
    }
    return fallback.slice(0, limit);
  }
}

export function buildToolSearchText(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): string {
  const paramNames = extractParameterNames(tool.parameters);
  return [tool.name, tool.description ?? "", ...paramNames].filter(Boolean).join(" ");
}

function extractParameterNames(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
}
