export type MemoryScope = "source" | "topic" | "global";

export type ChunkLifecycle =
  | "pending_extraction"
  | "admitted"
  | "dropped"
  | "buffered"
  | "sealed";

export type MemoryJobKind =
  | "extract_chunk"
  | "append_buffer"
  | "seal"
  | "topic_route"
  | "digest_daily"
  | "flush_stale";

export type MemoryTreeProvenance = {
  at: string;
  messageId?: string;
  toolName?: string;
};

export type MemoryTreeIngestEvent = {
  actorId: string;
  sourceId: string;
  markdown: string;
  provenance: MemoryTreeProvenance;
};

export type MemoryTreeRetrievalMode = "search" | "drill_down" | "global_digest" | "fetch";

export type MemoryTreeRetrievalQuery = {
  actorId: string;
  text: string;
  scope?: MemoryScope;
  sourceId?: string;
  topicEntity?: string;
  mode?: MemoryTreeRetrievalMode;
  chunkId?: string;
};

export type MemoryChunkRow = {
  chunkId: string;
  actorId: string;
  sourceId: string;
  body: string;
  tokenCount: number;
  lifecycle: ChunkLifecycle;
  fastScore: number;
  deepScore: number | null;
  createdAt: string;
  wikiPath: string;
};
