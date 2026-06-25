import type { AgenticMemoryIngestService } from "../agentic-memory/ingest.js";
import type { AgenticMemoryRetrievalService } from "../agentic-memory/retrieval.js";
import type { AgenticMemoryRecallCompressor } from "../agentic-memory/recall-compressor.js";
import type {
  HumanLikeMemoryRecallResult,
  HumanLikeMemoryService,
  MemoryContextKind,
} from "./human-like-memory-service.js";

export type NarrativeMemoryContext = "main" | "notes";

export type NarrativeMemoryPort = {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  buildDetailedRecall(actorId: string, query: string): Promise<string>;
  buildSourceRecall(actorId: string, query: string): Promise<string>;
  runSleepConsolidation(actorIds: string[]): Promise<
    Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>
  >;
  selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }>;
  getTelemetrySnapshot(): Record<string, unknown>;
};

async function unwrapRecall(
  recall: Promise<HumanLikeMemoryRecallResult>,
  compressor: AgenticMemoryRecallCompressor | null,
): Promise<string> {
  const result = await recall;
  if (!result.text) return "";
  return compressor ? compressor.compress(result.text) : result.text;
}

export class NarrativeMemoryFacade implements NarrativeMemoryPort {
  constructor(
    private readonly agenticIngest: AgenticMemoryIngestService | null,
    private readonly agenticRetrieval: AgenticMemoryRetrievalService | null,
    private readonly compressor: AgenticMemoryRecallCompressor | null,
    private readonly humanLikeMemory: HumanLikeMemoryService | null,
  ) {}

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void> {
    const context = (opts?.context ?? "main") as MemoryContextKind;

    if (this.humanLikeMemory) {
      await this.humanLikeMemory.ingest(actorId, text, source, {
        context,
        metadata: { highSignal: opts?.highSignal === true },
      });
    }

    if (this.agenticIngest) {
      await this.agenticIngest.ingestText(actorId, source, text, {
        highSignal: opts?.highSignal,
        context,
      });
    }
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    if (this.humanLikeMemory) {
      return unwrapRecall(
        this.humanLikeMemory.buildRecall(actorId, query, {
          context: "main",
          crossDomain: false,
          detailLevel: "summary",
        }),
        this.compressor,
      );
    }

    if (!this.agenticRetrieval) return "";
    const recall = await this.agenticRetrieval.buildRecall(actorId, query);
    return this.compressor && recall ? this.compressor.compress(recall) : recall;
  }

  async buildCrossContextRecall(actorId: string, query: string): Promise<string> {
    if (this.humanLikeMemory) {
      return unwrapRecall(
        this.humanLikeMemory.buildRecall(actorId, query, {
          context: "main",
          crossDomain: true,
          detailLevel: "summary",
        }),
        this.compressor,
      );
    }

    if (!this.agenticRetrieval) return "";
    const recall = await this.agenticRetrieval.buildCrossContextRecall(actorId, query);
    return this.compressor && recall ? this.compressor.compress(recall) : recall;
  }

  async buildDetailedRecall(actorId: string, query: string): Promise<string> {
    if (!this.humanLikeMemory) return this.buildNarrativeRecall(actorId, query);
    return unwrapRecall(
      this.humanLikeMemory.buildRecall(actorId, query, {
        context: "main",
        crossDomain: true,
        detailLevel: "detail",
      }),
      this.compressor,
    );
  }

  async buildSourceRecall(actorId: string, query: string): Promise<string> {
    if (!this.humanLikeMemory) return this.buildNarrativeRecall(actorId, query);
    return unwrapRecall(
      this.humanLikeMemory.buildRecall(actorId, query, {
        context: "main",
        crossDomain: true,
        detailLevel: "source",
      }),
      this.compressor,
    );
  }

  async runSleepConsolidation(actorIds: string[]): Promise<
    Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>
  > {
    if (!this.humanLikeMemory || actorIds.length === 0) return [];
    return this.humanLikeMemory.runSleepCycleForActors(actorIds);
  }

  async selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }> {
    if (!this.humanLikeMemory) return { exists: false, domainId: null, confidence: 0 };
    const recall = await this.humanLikeMemory.buildRecall(actorId, query, {
      context: "main",
      crossDomain: false,
      detailLevel: "summary",
      limit: 1,
    });
    return {
      exists: recall.recalledNodeIds.length > 0,
      domainId: recall.recalledNodeIds.length > 0 ? recall.domainId : null,
      confidence: recall.confidence,
    };
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    return this.humanLikeMemory?.getTelemetrySnapshot() ?? {};
  }
}

export function createNarrativeMemoryPort(opts: {
  agenticIngest: AgenticMemoryIngestService | null;
  agenticRetrieval: AgenticMemoryRetrievalService | null;
  compressor: AgenticMemoryRecallCompressor | null;
  humanLikeMemory: HumanLikeMemoryService | null;
}): NarrativeMemoryPort | null {
  if (!opts.agenticIngest && !opts.agenticRetrieval && !opts.humanLikeMemory) return null;
  return new NarrativeMemoryFacade(
    opts.agenticIngest,
    opts.agenticRetrieval,
    opts.compressor,
    opts.humanLikeMemory,
  );
}
