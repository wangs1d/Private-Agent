import { QdrantClient } from "@qdrant/js-client-rest";

const DEFAULT_COLLECTION = "narrative_chunks";

export type NarrativePointPayload = {
  actorId: string;
  text: string;
  source: string;
  chunkId: string;
  createdAt: string;
  /** Mem0 记忆图作用域元数据（source 等） */
  scope?: string;
  sourceId?: string;
  lifecycle?: string;
};

/**
 * Qdrant 向量段落存储；未配置 URL 时客户端为 null。
 */
export class QdrantNarrativeStore {
  readonly client: QdrantClient | null;
  readonly collection: string;
  private ready: Promise<void> | null = null;

  constructor(opts?: { url?: string; apiKey?: string; collection?: string }) {
    const url = opts?.url ?? process.env.AGENT_QDRANT_URL?.trim();
    const apiKey = opts?.apiKey ?? process.env.AGENT_QDRANT_API_KEY?.trim();
    this.collection = opts?.collection ?? process.env.AGENT_QDRANT_COLLECTION?.trim() ?? DEFAULT_COLLECTION;
    if (!url) {
      this.client = null;
      return;
    }
    this.client = new QdrantClient({ url, apiKey: apiKey || undefined });
  }

  isEnabled(): boolean {
    return this.client != null;
  }

  /** 确保 collection 存在（按首次 embedding 维度建表） */
  async ensureCollection(dim: number): Promise<void> {
    if (!this.client) return;
    if (!this.ready) {
      this.ready = (async () => {
        const cols = await this.client!.getCollections();
        const exists = cols.collections.some((c) => c.name === this.collection);
        if (!exists) {
          await this.client!.createCollection(this.collection, {
            vectors: {
              size: dim,
              distance: "Cosine",
            },
          });
        }
      })().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    await this.ready;
  }

  async upsertPoint(
    vec: number[],
    id: string | number,
    payload: NarrativePointPayload,
  ): Promise<void> {
    if (!this.client) return;
    await this.ensureCollection(vec.length);
    await this.client.upsert(this.collection, {
      wait: true,
      points: [
        {
          id,
          vector: vec,
          payload: payload as Record<string, unknown>,
        },
      ],
    });
  }

  async search(
    vec: number[],
    actorId: string,
    limit: number,
  ): Promise<Array<{ id: string | number; score: number; payload: NarrativePointPayload }>> {
    if (!this.client) return [];
    await this.ensureCollection(vec.length);
    const res = await this.client.search(this.collection, {
      vector: vec,
      limit,
      filter: {
        must: [{ key: "actorId", match: { value: actorId } }],
      },
      with_payload: true,
    });
    return res.map((h) => ({
      id: h.id,
      score: typeof h.score === "number" ? h.score : 0,
      payload: h.payload as NarrativePointPayload,
    }));
  }

  /**
   * 按 actor 分页拉取全部点（payload 含原文）。
   * 用途：BM25/文本缓存是进程内的，进程重启即丢；Qdrant 是唯一事实源，
   * 首次召回时据此回灌重建词法索引。
   */
  async scrollByActor(
    actorId: string,
    limit: number,
  ): Promise<Array<{ id: string | number; payload: NarrativePointPayload }>> {
    if (!this.client) return [];
    const out: Array<{ id: string | number; payload: NarrativePointPayload }> = [];
    let offset: string | number | undefined;
    for (let page = 0; page < 64 && out.length < limit; page++) {
      const res = await this.client.scroll(this.collection, {
        limit: Math.min(256, limit - out.length),
        offset,
        filter: {
          must: [{ key: "actorId", match: { value: actorId } }],
        },
        with_payload: true,
      });
      for (const p of res.points ?? []) {
        out.push({ id: p.id, payload: p.payload as NarrativePointPayload });
      }
      if (res.next_page_offset == null) break;
      offset = res.next_page_offset as string | number;
    }
    return out.slice(0, limit);
  }
}
