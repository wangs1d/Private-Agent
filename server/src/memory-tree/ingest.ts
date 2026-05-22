import type { MemoryTreeStore } from "./store.js";
import type { MemoryTreeIngestEvent } from "./types.js";
import { canonicalizeMarkdown, chunkCanonicalText, estimateTokenCount } from "./chunker.js";

function fastScoreHeuristic(body: string, tokenCount: number): number {
  const t = body.trim();
  if (!t || t.length < 8) return 0;
  if (tokenCount < 3) return 0.1;
  const uniqueRatio = new Set(t.split(/\s+/)).size / Math.max(1, t.split(/\s+/).length);
  return Math.min(1, 0.35 + Math.log10(tokenCount + 1) * 0.15 + uniqueRatio * 0.25);
}

export class MemoryTreeIngestService {
  /** 入队后台任务后唤醒 worker（由 runtime 注入） */
  onChunkEnqueued?: () => void;

  constructor(private readonly store: MemoryTreeStore) {}

  /**
   * 热路径：canonicalize → chunk → persist → enqueue extract_chunk（无 LLM）。
   */
  async ingest(event: MemoryTreeIngestEvent): Promise<string[]> {
    const canonical = canonicalizeMarkdown(event.markdown, event.provenance);
    const pieces = chunkCanonicalText(event.actorId, event.sourceId, canonical);
    const created: string[] = [];

    for (const piece of pieces) {
      const score = fastScoreHeuristic(piece.body, piece.tokenCount);
      if (score < 0.12) continue;

      const wikiPath = await this.store.writeWikiFile(event.actorId, piece.chunkId, piece.body);
      const inserted = this.store.insertChunk({
        chunkId: piece.chunkId,
        actorId: event.actorId,
        sourceId: event.sourceId,
        body: piece.body,
        tokenCount: piece.tokenCount,
        lifecycle: "pending_extraction",
        fastScore: score,
        deepScore: null,
        createdAt: event.provenance.at || new Date().toISOString(),
        wikiPath,
      });
      if (!inserted) continue;

      created.push(piece.chunkId);
      this.store.enqueueJob("extract_chunk", `extract:${piece.chunkId}`, {
        chunkId: piece.chunkId,
        actorId: event.actorId,
        sourceId: event.sourceId,
      });
      this.onChunkEnqueued?.();
    }

    return created;
  }

  /** 将任意纯文本写入指定 source（供 turn_archive / hermes 等调用方使用） */
  async ingestText(
    actorId: string,
    sourceId: string,
    text: string,
    extra?: { messageId?: string; toolName?: string },
  ): Promise<string[]> {
    const t = text.trim();
    if (!t || estimateTokenCount(t) < 2) return [];
    return this.ingest({
      actorId,
      sourceId,
      markdown: t,
      provenance: {
        at: new Date().toISOString(),
        messageId: extra?.messageId,
        toolName: extra?.toolName,
      },
    });
  }
}
