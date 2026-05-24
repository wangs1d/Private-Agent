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
}
