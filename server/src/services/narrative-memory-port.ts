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
  /**
   * 统一写入者出口：候选已经过整合链路裁决（decideMemoryWrite / 回声过滤 /
   * supersession），此处直接落库，不再二次决策。语义与 ingest 相同
   * （海马体 + Mem0 [+ hybrid 索引]），只是免去重复 LLM 裁决。
   */
  writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  buildDetailedRecall(actorId: string, query: string): Promise<string>;
  buildSourceRecall(actorId: string, query: string): Promise<string>;
  /**
   * 词法预筛分数（0~1，进程内 BM25 归一）。
   * 供 recall-gate 的廉价放行通道在 embedding 预筛前快筛，省掉非门控轮次的 API 调用。
   * 未实现（纯 facade）/ 无索引时返回 0。
   */
  lexicalPreScreen?(actorId: string, query: string): Promise<number>;
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

  async writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
  ): Promise<void> {
    const context = opts.context as MemoryContextKind;
    if (this.humanLikeMemory) {
      await this.humanLikeMemory.ingest(actorId, text, source, {
        context,
        metadata: { highSignal: opts.highSignal },
      });
    }
    if (this.agenticIngest) {
      await this.agenticIngest.writeDecided(actorId, source, text, context, opts.highSignal);
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

/**
 * 混合检索适配器：把 NarrativeHybridRetrievalService（BM25+Qdrant+RRF）
 * 与现有 NarrativeMemoryPort 组合，实现「人脑记忆 + 向量检索」双通道。
 *
 * - ingest：双写（facade 做人脑记忆沉淀，hybrid 做 BM25+Qdrant 索引）
 * - buildNarrativeRecall：双通道召回后拼接结果（facade 优先，hybrid 补充）
 * - 其余方法：仅委托 facade（hybrid 未实现这些方法）
 */
class NarrativeHybridAdapter implements NarrativeMemoryPort {
  constructor(
    private readonly facade: NarrativeMemoryPort,
    private readonly hybrid: import("./narrative-hybrid-retrieval-service.js").NarrativeHybridRetrievalService,
  ) {}

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void> {
    await Promise.all([
      this.facade.ingest(actorId, text, source, opts),
      this.hybrid.ingest(actorId, text, source),
    ]);
  }

  async writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
  ): Promise<void> {
    await Promise.all([
      this.facade.writeDecided(actorId, text, source, opts),
      this.hybrid.ingest(actorId, text, source),
    ]);
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    const [facadeResult, hybridResult] = await Promise.all([
      this.facade.buildNarrativeRecall(actorId, query),
      this.hybrid.buildNarrativeRecall(actorId, query),
    ]);
    return [facadeResult, hybridResult].filter(Boolean).join("\n\n");
  }

  async lexicalPreScreen(actorId: string, query: string): Promise<number> {
    return this.hybrid.lexicalPreScreen(actorId, query);
  }

  async buildCrossContextRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildCrossContextRecall(actorId, query);
  }

  async buildDetailedRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildDetailedRecall(actorId, query);
  }

  async buildSourceRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildSourceRecall(actorId, query);
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
    return this.facade.runSleepConsolidation(actorIds);
  }

  async selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }> {
    return this.facade.selfCheck(actorId, query);
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    return {
      ...this.facade.getTelemetrySnapshot(),
      hybridRetrieval: "enabled",
    };
  }
}

/**
 * 条件包装：如果 hybrid 检索服务可用，把 port 包装为双通道适配器。
 * @param port 现有 NarrativeMemoryPort（可能为 null）
 * @param hybrid NarrativeHybridRetrievalService 实例（可能为 null）
 * @returns 包装后的 NarrativeMemoryPort（或原 port / null）
 */
export function wrapNarrativeWithHybrid(
  port: NarrativeMemoryPort | null,
  hybrid: import("./narrative-hybrid-retrieval-service.js").NarrativeHybridRetrievalService | null,
): NarrativeMemoryPort | null {
  if (!port || !hybrid) return port;
  return new NarrativeHybridAdapter(port, hybrid);
}
