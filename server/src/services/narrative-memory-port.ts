import type { AgenticMemoryIngestService } from "../agentic-memory/ingest.js";
import type { AgenticMemoryRetrievalService } from "../agentic-memory/retrieval.js";
import type { AgenticMemoryRecallCompressor } from "../agentic-memory/recall-compressor.js";

/** 长期叙事记忆统一端口（Mem0 记忆图：实体链接 + 多信号检索）。 */
export type NarrativeMemoryPort = {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean },
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
};

export class NarrativeMemoryFacade implements NarrativeMemoryPort {
  constructor(
    private readonly agenticIngest: AgenticMemoryIngestService | null,
    private readonly agenticRetrieval: AgenticMemoryRetrievalService | null,
    private readonly compressor: AgenticMemoryRecallCompressor | null,
  ) {}

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean },
  ): Promise<void> {
    if (this.agenticIngest) {
      await this.agenticIngest.ingestText(actorId, source, text, opts);
    }
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    if (!this.agenticRetrieval) return "";
    const recall = await this.agenticRetrieval.buildRecall(actorId, query);
    if (!recall) return "";
    if (this.compressor) {
      return this.compressor.compress(recall);
    }
    return recall;
  }
}

export function createNarrativeMemoryPort(opts: {
  agenticIngest: AgenticMemoryIngestService | null;
  agenticRetrieval: AgenticMemoryRetrievalService | null;
  compressor: AgenticMemoryRecallCompressor | null;
}): NarrativeMemoryPort | null {
  if (!opts.agenticIngest && !opts.agenticRetrieval) return null;
  return new NarrativeMemoryFacade(opts.agenticIngest, opts.agenticRetrieval, opts.compressor);
}
