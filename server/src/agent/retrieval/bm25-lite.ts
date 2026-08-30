/** 轻量 Okapi BM25，支持中英混排（中文按「单字 + 相邻二字 bigram」、英文按片段分词）。进程内索引，按 actor 分区。 */

export function tokenizeForBm25(text: string): string[] {
  const s = text.trim().toLowerCase();
  const out: string[] = [];
  // 上一字符是汉字时用于生成 bigram；遇任何非汉字（含空白/标点）即断开
  let prevHan = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (/[\u4e00-\u9fff]/.test(c)) {
      out.push(c);
      if (prevHan) out.push(prevHan + c);
      prevHan = c;
      i++;
    } else if (/\s/.test(c)) {
      prevHan = "";
      i++;
    } else {
      prevHan = "";
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

type DocData = { id: string; text: string; tf: Map<string, number>; len: number };

export class Bm25LiteIndex {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly docs = new Map<string, DocData>();
  /** 倒排链：term → 含该 term 的 docId 集合（upsert 时增量维护，search 零重建） */
  private readonly postings = new Map<string, Set<string>>();
  /** 全库 token 总长（avgLen = totalLen / docs.size，增量维护避免每次 search 全量求和） */
  private totalLen = 0;
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
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const len = tokens.length || 1;
    this.docs.set(docId, { id: docId, text, tf, len });
    this.totalLen += len;
    for (const t of tf.keys()) {
      let posting = this.postings.get(t);
      if (!posting) {
        posting = new Set();
        this.postings.set(t, posting);
      }
      posting.add(docId);
    }
    this.order.push(docId);
    this.evictOverflow();
  }

  remove(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    this.docs.delete(docId);
    this.totalLen -= doc.len;
    for (const t of doc.tf.keys()) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      posting.delete(docId);
      if (posting.size === 0) this.postings.delete(t);
    }
    const idx = this.order.indexOf(docId);
    if (idx >= 0) this.order.splice(idx, 1);
  }

  private evictOverflow(): void {
    while (this.maxDocs > 0 && this.order.length > this.maxDocs) {
      const old = this.order.shift();
      if (old) this.remove(old);
    }
  }

  /** 返回按分数降序的 docId 列表。只遍历查询词的倒排链，复杂度 O(Σ|posting(qt)|)。 */
  search(query: string, topK: number): { id: string; score: number }[] {
    if (this.docs.size === 0 || topK <= 0) return [];
    const qTerms = tokenizeForBm25(query);
    if (qTerms.length === 0) return [];

    const N = this.docs.size;
    const avgLen = this.totalLen / N;
    const scores = new Map<string, number>();

    const seenQ = new Set<string>();
    for (const t of qTerms) {
      if (seenQ.has(t)) continue;
      seenQ.add(t);
      const posting = this.postings.get(t);
      if (!posting) continue;
      const dfi = posting.size;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      for (const docId of posting) {
        const doc = this.docs.get(docId);
        if (!doc) continue;
        const c = doc.tf.get(t) ?? 0;
        if (c === 0) continue;
        const num = c * (this.k1 + 1);
        const den = c + this.k1 * (1 - this.b + this.b * (doc.len / avgLen));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * (num / den));
      }
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
