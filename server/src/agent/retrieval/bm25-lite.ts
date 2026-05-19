/** 轻量 Okapi BM25，支持中英混排（中文按字、英文按片段分词）。进程内索引，按 actor 分区。 */

export function tokenizeForBm25(text: string): string[] {
  const s = text.trim().toLowerCase();
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (/[\u4e00-\u9fff]/.test(c)) {
      out.push(c);
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (
        j < s.length &&
        !/[\s\u4e00-\u9fff]/.test(s[j]!)
      ) {
        j++;
      }
      if (j > i) out.push(s.slice(i, j));
      i = j;
    }
  }
  return out.filter(Boolean);
}

type DocData = { id: string; text: string; tokens: string[]; len: number };

export class Bm25LiteIndex {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly docs = new Map<string, DocData>();
  /** 按插入顺序记录 id，便于 LRU 淘汰 */
  private order: string[] = [];

  constructor(private readonly maxDocs: number) {}

  get size(): number {
    return this.docs.size;
  }

  upsert(docId: string, text: string): void {
    if (this.docs.has(docId)) {
      this.remove(docId);
    }
    const tokens = tokenizeForBm25(text);
    const len = tokens.length || 1;
    this.docs.set(docId, { id: docId, text, tokens, len });
    this.order.push(docId);
    this.evictOverflow();
  }

  remove(docId: string): void {
    if (!this.docs.has(docId)) return;
    this.docs.delete(docId);
    const idx = this.order.indexOf(docId);
    if (idx >= 0) this.order.splice(idx, 1);
  }

  private evictOverflow(): void {
    while (this.maxDocs > 0 && this.order.length > this.maxDocs) {
      const old = this.order.shift();
      if (old) this.docs.delete(old);
    }
  }

  /** 返回按分数降序的 docId 列表 */
  search(query: string, topK: number): { id: string; score: number }[] {
    if (this.docs.size === 0 || topK <= 0) return [];
    const qTerms = tokenizeForBm25(query);
    if (qTerms.length === 0) return [];

    const avgLen =
      [...this.docs.values()].reduce((acc, d) => acc + d.len, 0) / this.docs.size;

    const df = new Map<string, number>();
    for (const d of this.docs.values()) {
      const seen = new Set<string>();
      for (const t of d.tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) ?? 0) + 1);
        }
      }
    }

    const N = this.docs.size;
    const scores = new Map<string, number>();

    for (const doc of this.docs.values()) {
      let s = 0;
      const tf = new Map<string, number>();
      for (const t of doc.tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      const seenQ = new Set<string>();
      for (const t of qTerms) {
        const c = tf.get(t) ?? 0;
        if (c === 0) continue;
        if (seenQ.has(t)) continue;
        seenQ.add(t);
        const dfi = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
        const num = c * (this.k1 + 1);
        const den = c + this.k1 * (1 - this.b + this.b * (doc.len / avgLen));
        s += idf * (num / den);
      }
      if (s > 0) scores.set(doc.id, s);
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({ id, score }));
  }

  getText(id: string): string | undefined {
    return this.docs.get(id)?.text;
  }
}
