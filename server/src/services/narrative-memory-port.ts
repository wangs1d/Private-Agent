import type { MemoryTreeIngestService } from "../memory-tree/ingest.js";
import type { MemoryTreeRetrievalService } from "../memory-tree/retrieval.js";
import { isMemoryTreeDualWriteHybrid } from "../memory-tree/env.js";
import type { NarrativeHybridRetrievalService } from "./narrative-hybrid-retrieval-service.js";

/** 长期叙事记忆统一端口（Memory Tree 优先，可选双写 legacy hybrid）。 */
export type NarrativeMemoryPort = {
  ingest(actorId: string, text: string, source: string): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
};

export class NarrativeMemoryFacade implements NarrativeMemoryPort {
  constructor(
    private readonly memoryTreeIngest: MemoryTreeIngestService | null,
    private readonly memoryTreeRetrieval: MemoryTreeRetrievalService | null,
    private readonly legacy: NarrativeHybridRetrievalService | null,
  ) {}

  async ingest(actorId: string, text: string, source: string): Promise<void> {
    if (this.memoryTreeIngest) {
      await this.memoryTreeIngest.ingestText(actorId, source, text);
    }
    if (isMemoryTreeDualWriteHybrid() && this.legacy) {
      await this.legacy.ingest(actorId, text, source);
    } else if (!this.memoryTreeIngest && this.legacy) {
      await this.legacy.ingest(actorId, text, source);
    }
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    if (this.memoryTreeRetrieval) {
      const fromTree = await this.memoryTreeRetrieval.buildRecall(actorId, query);
      if (fromTree.trim()) return fromTree;
    }
    if (!this.memoryTreeRetrieval && this.legacy) {
      return this.legacy.buildNarrativeRecall(actorId, query);
    }
    return "";
  }
}

export function createNarrativeMemoryPort(opts: {
  memoryTreeIngest: MemoryTreeIngestService | null;
  memoryTreeRetrieval: MemoryTreeRetrievalService | null;
  legacy: NarrativeHybridRetrievalService | null;
}): NarrativeMemoryPort | null {
  if (!opts.memoryTreeIngest && !opts.memoryTreeRetrieval && !opts.legacy) return null;
  return new NarrativeMemoryFacade(
    opts.memoryTreeIngest,
    opts.memoryTreeRetrieval,
    opts.legacy,
  );
}
