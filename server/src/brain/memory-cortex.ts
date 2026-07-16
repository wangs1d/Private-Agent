// Agent Brain Center — 记忆皮层（海马体）
import type {
  MemoryConsolidationStats,
  MemoryDomainKind,
  MemoryItem,
  MemoryItemKind,
  MemoryRecallItem,
  MemoryRecallResult,
  PersonalityCore,
} from "./types.js";

// ============================================================
// 子系统外观接口（最小化，只声明 MemoryCortex 用到的方法）
// ============================================================

// 短期任务条目外观
interface ShortTermTaskLike {
  taskId: string;
  title: string;
  status: "active" | "paused" | "completed";
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
}

// 短期会话记忆外观
interface ShortTermConversationMemoryLike {
  activeTopic: string | null;
  currentMission: string | null;
  carryForward: string[];
  preferences: string[];
  facts: string[];
  openLoops: string[];
  agentCommitments: string[];
  lastUpdated: string;
}

// 短期记忆网关外观接口（ShortTermMemoryGatewayService 子集）
interface ShortTermMemoryLike {
  syncTaskForTurn(sessionId: string, input: string): {
    task: ShortTermTaskLike;
    resumed: boolean;
  };
  getTaskState(sessionId: string): {
    activeTaskId: string | null;
    tasks: ShortTermTaskLike[];
    conversationMemory?: ShortTermConversationMemoryLike;
  };
}

// Mem0 agentic 记忆外观（AgenticMemoryRuntime 子集）
interface AgenticMemoryLike {
  ingest: {
    ingestText(
      actorId: string,
      sourceId: string,
      text: string,
      opts?: { highSignal?: boolean; context?: "main" | "notes" },
    ): Promise<void>;
  };
  retrieval: {
    buildRecall(actorId: string, queryText: string): Promise<string>;
    buildCrossContextRecall(actorId: string, queryText: string): Promise<string>;
  };
}

// 海马体（HumanLikeMemoryService）外观接口
interface HumanLikeMemoryLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: {
      context?: "main" | "notes";
      domain?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
  buildRecall(
    actorId: string,
    query: string,
    opts?: {
      source?: string;
      context?: "main" | "notes";
      explicitDomain?: string;
      crossDomain?: boolean;
      limit?: number;
      detailLevel?: "summary" | "detail" | "source";
    },
  ): Promise<{
    domainId: string;
    mode: "single_domain" | "cross_domain";
    recalledNodeIds: string[];
    confidence: number;
    text: string;
  }>;
}

// 叙事记忆睡眠巩固报告外观
interface NarrativeSleepReport {
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
}

// 叙事记忆端口外观接口（NarrativeMemoryPort 子集）
interface NarrativeMemoryLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: "main" | "notes" },
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  runSleepConsolidation(actorIds: string[]): Promise<NarrativeSleepReport[]>;
}

// KV 摘要记忆外观（AgentMemorySyncService 子集）
interface KvSummaryLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> };
  /** 可选：写入单个 KV 条目（用于 personality_core 等结构化特质的持久化） */
  setEntry?(actorId: string, key: string, value: unknown): void;
}

// 记忆管理器外观（MemoryManagerService 子集）
interface MemoryManagerLike {
  consolidateNow(actorId: string): Promise<{
    entriesMerged: number;
    entriesRemoved: number;
    rememberedCount: number;
    fadedCount: number;
  }>;
}

// 夜间调度器外观（NightlyMemoryTaskService 子集）
interface NightlySchedulerLike {
  forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    synced: boolean;
    error?: string;
  }>;
}

/**
 * SynapseBus 的最小化外观接口（结构兼容真实 SynapseBus 即可）。
 * 仅声明 MemoryCortex 用到的 fire + 可选 subscribeType 能力。
 */
interface SynapseBusLike {
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): unknown;
  subscribeType?(
    type: string,
    handler: (event: {
      data: Record<string, unknown>;
      actorId?: string;
      source?: string;
    }) => void | Promise<void>,
  ): () => void;
}

// ============================================================
// 域推断 helper
// ============================================================

/** 根据 MemoryItemKind 推断默认记忆域 */
function inferDomain(kind: MemoryItemKind): MemoryDomainKind {
  switch (kind) {
    case "task":
      return "working";
    case "event":
      return "episodic";
    case "knowledge":
      return "semantic";
    case "procedure":
      return "procedural";
    case "fact":
      return "semantic";
    case "commitment":
      return "episodic";
    case "experience":
      return "episodic";
    case "preference":
      return "emotional";
  }
}

// ============================================================
// MemoryCortex
// ============================================================

/** 单条 MemoryRecallItem.text 的最大字符数，超出则截断并追加省略标记 */
const MAX_RECALL_ITEM_TEXT_LENGTH = 800;

/**
 * 默认人格内核 —— 未设置人格时使用，不阻塞启动。
 * 防漂移：人格特质不随单次对话漂移，仅可通过 setPersonalityCore 显式更新。
 */
export const DEFAULT_PERSONALITY_CORE: PersonalityCore = {
  values: ["真诚", "帮助他人", "持续成长"],
  speech_style: { tone: "温和", formality: "适中", humor: "适度" },
  beliefs: ["技术应服务于人"],
  quirks: ["偶尔用比喻解释复杂概念"],
};

/** KV 持久化 key 前缀：personality_core_${actorId} */
function personalityCoreKey(actorId: string): string {
  return `personality_core_${actorId}`;
}

/** 判断未知值是否为合法 PersonalityCore，用于从 KV 反序列化时校验 */
function isPersonalityCore(v: unknown): v is PersonalityCore {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const ss = o.speech_style as Record<string, unknown> | undefined;
  return (
    Array.isArray(o.values) && o.values.every((x): x is string => typeof x === "string") &&
    Boolean(ss) && typeof ss === "object" &&
    typeof ss?.tone === "string" &&
    typeof ss?.formality === "string" &&
    typeof ss?.humor === "string" &&
    Array.isArray(o.beliefs) && o.beliefs.every((x): x is string => typeof x === "string") &&
    Array.isArray(o.quirks) && o.quirks.every((x): x is string => typeof x === "string")
  );
}

/**
 * 记忆皮层（海马体）—— 大脑中心记忆子系统外观。
 *
 * 持有短期 / agentic / 海马体 / 叙事四类记忆服务的可选引用，
 * 对外提供统一的 remember / recall / recallCrossDomain / consolidate 入口。
 * 任一子系统缺失时方法优雅降级。所有方法直接调用底层记忆服务，
 * 不走 LLM prompt 路线。
 */
export class MemoryCortex {
  private shortTerm: ShortTermMemoryLike | null = null;
  private agentic: AgenticMemoryLike | null = null;
  private humanLike: HumanLikeMemoryLike | null = null;
  private narrative: NarrativeMemoryLike | null = null;
  private kvSummary: KvSummaryLike | null = null;
  private memoryManager: MemoryManagerLike | null = null;
  private nightlyScheduler: NightlySchedulerLike | null = null;
  private synapseBus: SynapseBusLike | null = null;
  private started = false;
  // personality 域：结构化人格内核缓存（KV 持久化，防漂移）
  private personalityCache = new Map<string, PersonalityCore>();

  // ---- 子系统注册 ----------------------------------------------------------

  registerShortTerm(svc: ShortTermMemoryLike): void {
    this.shortTerm = svc;
    console.log("[MemoryCortex] 已注册 ShortTermMemory");
  }

  registerAgentic(svc: AgenticMemoryLike): void {
    this.agentic = svc;
    console.log("[MemoryCortex] 已注册 AgenticMemory");
  }

  registerHumanLike(svc: HumanLikeMemoryLike): void {
    this.humanLike = svc;
    console.log("[MemoryCortex] 已注册 HumanLikeMemory");
  }

  registerNarrative(svc: NarrativeMemoryLike): void {
    this.narrative = svc;
    console.log("[MemoryCortex] 已注册 NarrativeMemory");
  }

  registerKvSummary(s: KvSummaryLike): void {
    this.kvSummary = s;
    console.log("[MemoryCortex] 已注册 KvSummary");
  }

  registerMemoryManager(svc: MemoryManagerLike): void {
    this.memoryManager = svc;
    console.log("[MemoryCortex] 已注册 MemoryManager");
  }

  registerNightlyScheduler(svc: NightlySchedulerLike): void {
    this.nightlyScheduler = svc;
    console.log("[MemoryCortex] 已注册 NightlyScheduler");
  }

  /**
   * 注册突触总线。
   *
   * 注册后自动订阅 sensory.listen 事件：每当感官皮层识别到用户语音，
   * 即把识别文本作为 event 类记忆异步写入（不阻塞事件循环）。
   * fire 失败、remember 失败均静默降级，不影响事件分发链。
   */
  registerSynapseBus(svc: SynapseBusLike): void {
    this.synapseBus = svc;
    console.log("[MemoryCortex] 已注册 SynapseBus");
    // 订阅 sensory.listen 事件 → 自动记忆感知到的用户语音
    if (typeof svc.subscribeType === "function") {
      svc.subscribeType("sensory.listen", (event) => {
        try {
          const text = event.data?.text;
          if (typeof text === "string" && text.length > 0) {
            const actorId =
              (typeof event.data?.actorId === "string" && event.data.actorId) ||
              (typeof event.actorId === "string" && event.actorId) ||
              "unknown";
            // 异步 remember，不阻塞事件循环
            void this.remember(actorId, {
              actorId,
              kind: "event",
              content: text,
              timestamp: new Date().toISOString(),
            }).catch(() => {
              /* 静默 */
            });
          }
        } catch {
          /* 订阅回调异常不传播 */
        }
      });
      console.log("[MemoryCortex] 已订阅 sensory.listen → 自动记忆");
    }
  }

  // ---- 生命周期 ------------------------------------------------------------

  /** 启动记忆皮层：子系统由外部初始化后注入，这里只翻转 started 标志 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[MemoryCortex] 已启动，跳过重复 start");
      return;
    }
    console.log("[MemoryCortex] 正在启动...");
    this.started = true;
    console.log("[MemoryCortex] 启动完成");
  }

  /** 停止记忆皮层 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[MemoryCortex] 未启动，跳过 stop");
      return;
    }
    console.log("[MemoryCortex] 正在停止...");
    this.started = false;
    console.log("[MemoryCortex] 已停止");
  }

  // ---- 核心方法 ------------------------------------------------------------

  /**
   * 写入记忆。
   *
   * - 根据 item.domain（缺省时按 kind 推断）决定写入哪个域；
   * - 工作记忆且带 sessionId → 写短期记忆；
   * - importance=high/critical 或非工作记忆 → 写长期记忆（优先 narrative，fallback agentic）。
   * 不调用 LLM。
   */
  async remember(actorId: string, item: MemoryItem): Promise<void> {
    const domain = item.domain ?? inferDomain(item.kind);
    const importance = item.importance ?? "medium";
    const sourceId = item.source ?? "system";
    const highSignal = importance === "high" || importance === "critical";

    // 写短期记忆：工作记忆且带 sessionId
    if (domain === "working" && item.sessionId && this.shortTerm) {
      try {
        this.shortTerm.syncTaskForTurn(item.sessionId, item.content);
      } catch (err) {
        console.log(`[MemoryCortex] shortTerm.syncTaskForTurn 失败: ${err}`);
      }
    }

    // 写长期记忆：高信号或非工作记忆
    const shouldPersistLongTerm = highSignal || domain !== "working";
    if (!shouldPersistLongTerm) return;

    // 优先 narrative（其内部会同时写 humanLike + agentic）
    if (this.narrative) {
      try {
        await this.narrative.ingest(actorId, item.content, sourceId, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown" },
            { actorId, source: "memory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
        return;
      } catch (err) {
        console.log(`[MemoryCortex] narrative.ingest 失败: ${err}`);
      }
    }

    // Fallback：直接写 agentic
    if (this.agentic) {
      try {
        await this.agentic.ingest.ingestText(actorId, sourceId, item.content, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown" },
            { actorId, source: "memory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
      } catch (err) {
        console.log(`[MemoryCortex] agentic.ingest.ingestText 失败: ${err}`);
      }
    }
  }

  /**
   * 单域召回。
   *
   * 根据 opts.domain 路由：
   * - working → 短期记忆（按 sessionId 索引；recall 入参无 sessionId，返回空）
   * - narrative → narrative.buildNarrativeRecall
   * - episodic / semantic / procedural / emotional → 优先海马体，fallback agentic.retrieval
   * - 默认（未指定 domain）：降级链 agentic → narrative → kvSummary
   */
  async recall(
    actorId: string,
    query: string,
    opts?: {
      domain?: MemoryDomainKind;
      limit?: number;
      sessionId?: string;
      /** 是否包含 sensitivity=restricted 的受限记忆，默认 false（restricted 不进 prompt 路径） */
      includeRestricted?: boolean;
    },
  ): Promise<MemoryRecallResult> {
    const domain = opts?.domain;
    const now = new Date().toISOString();

    try {
      this.synapseBus?.fire(
        "memory.recall",
        { actorId, query, domain: opts?.domain ?? "default" },
        { actorId, source: "memory" },
      );
    } catch {
      /* fire 失败不影响主流程 */
    }

    // 工作记忆 → 短期记忆（需 sessionId 索引）
    if (domain === "working") {
      const sessionId = opts?.sessionId ?? actorId; // 无 sessionId 时用 actorId 兜底
      if (!this.shortTerm) {
        console.log("[MemoryCortex] recall(working): ShortTermMemory 未注册，返回空");
      } else {
        try {
          const taskState = this.shortTerm.getTaskState(sessionId);
          const items: Array<{ content: string; domain: MemoryDomainKind; timestamp?: string; score?: number }> = [];
          // 活跃任务上下文
          if (taskState.activeTaskId) {
            const active = taskState.tasks.find((t) => t.taskId === taskState.activeTaskId);
            if (active) {
              items.push({
                content: `当前任务: ${active.title}（${active.contextSummary}）`,
                domain: "working",
                timestamp: active.updatedAt,
              });
            }
          }
          // 会话记忆（主题/使命/待办等）
          const conv = taskState.conversationMemory;
          if (conv) {
            if (conv.activeTopic) items.push({ content: `当前话题: ${conv.activeTopic}`, domain: "working" });
            if (conv.currentMission) items.push({ content: `当前使命: ${conv.currentMission}`, domain: "working" });
            for (const loop of conv.openLoops.slice(0, 3)) {
              items.push({ content: `待办: ${loop}`, domain: "working" });
            }
          }
          return {
            actorId,
            query,
            items: this.filterBySensitivity(items, opts?.includeRestricted),
            domain: "working",
            mode: "single_domain",
            recalledAt: now,
          };
        } catch (err) {
          console.log(`[MemoryCortex] recall(working) 失败: ${err}`);
        }
      }
      return {
        actorId,
        query,
        items: [],
        domain: "working",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 叙事记忆 → narrative.buildNarrativeRecall
    if (domain === "narrative") {
      const text = this.narrative
        ? (await this.safeRecall(() => this.narrative!.buildNarrativeRecall(actorId, query))) ?? ""
        : "";
      return {
        actorId,
        query,
        items: this.filterBySensitivity(
          this.textToRecallItems(text, "narrative"),
          opts?.includeRestricted,
        ),
        domain: "narrative",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // episodic / semantic / procedural / emotional → 优先海马体，fallback agentic
    if (domain) {
      if (this.humanLike) {
        const result = await this.safeRecall(() =>
          this.humanLike!.buildRecall(actorId, query, {
            context: "main",
            crossDomain: false,
            detailLevel: "summary",
            limit: opts?.limit,
          }),
        );
        return {
          actorId,
          query,
          items: this.filterBySensitivity(
            this.humanLikeResultToItems(result, domain),
            opts?.includeRestricted,
          ),
          domain,
          mode: "single_domain",
          recalledAt: now,
        };
      }
      if (this.agentic) {
        const text =
          (await this.safeRecall(() => this.agentic!.retrieval.buildRecall(actorId, query))) ?? "";
        return {
          actorId,
          query,
          items: this.filterBySensitivity(
            this.textToRecallItems(text, domain),
            opts?.includeRestricted,
          ),
          domain,
          mode: "single_domain",
          recalledAt: now,
        };
      }
      // 既无 humanLike 也无 agentic：返回空
      return {
        actorId,
        query,
        items: [],
        domain,
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 默认（未指定 domain）：降级链 agentic → narrative → kvSummary
    let mergedItems: MemoryRecallItem[] = [];
    // 先 agentic
    if (this.agentic) {
      const text =
        (await this.safeRecall(() => this.agentic!.retrieval.buildRecall(actorId, query))) ?? "";
      mergedItems = this.textToRecallItems(text, "semantic");
    }
    // agentic 无结果才调 narrative（降级）
    if (mergedItems.length === 0 && this.narrative) {
      const text =
        (await this.safeRecall(() => this.narrative!.buildNarrativeRecall(actorId, query))) ?? "";
      mergedItems = this.textToRecallItems(text, "narrative");
    }

    // KV summary fallback：仍然无结果才降级到 KV 摘要记忆
    if (mergedItems.length === 0 && this.kvSummary) {
      try {
        const snapshot = this.kvSummary.getSnapshot(actorId, ["memory_summary"]);
        const summary = snapshot.entries.memory_summary;
        if (typeof summary === "string" && summary.trim()) {
          return {
            actorId,
            query,
            items: this.filterBySensitivity(
              [
                {
                  content: summary,
                  domain: "semantic",
                  source: "kv_summary",
                  timestamp: now,
                },
              ],
              opts?.includeRestricted,
            ),
            domain: "semantic",
            mode: "single_domain",
            recalledAt: now,
          };
        }
      } catch (err) {
        console.log(`[MemoryCortex] kvSummary.getSnapshot 失败: ${err}`);
      }
    }

    return {
      actorId,
      query,
      items: this.filterBySensitivity(mergedItems, opts?.includeRestricted),
      domain: "semantic",
      mode: "single_domain",
      recalledAt: now,
    };
  }

  /**
   * 跨域召回。
   *
   * 优先委托 humanLike 的 cross-domain recall（海马体多域图谱遍历）；
   * 若未注册，fallback 到 narrative.buildCrossContextRecall；
   * 再退一步：并行调多域单域 recall 合并。
   */
  async recallCrossDomain(actorId: string, query: string): Promise<MemoryRecallResult> {
    const now = new Date().toISOString();

    if (this.humanLike) {
      const result = await this.safeRecall(() =>
        this.humanLike!.buildRecall(actorId, query, {
          context: "main",
          crossDomain: true,
          detailLevel: "summary",
        }),
      );
      return {
        actorId,
        query,
        items: this.filterBySensitivity(this.humanLikeResultToItems(result, "episodic")),
        domain: "episodic",
        mode: "cross_domain",
        recalledAt: now,
      };
    }

    if (this.narrative) {
      const text =
        (await this.safeRecall(() =>
          this.narrative!.buildCrossContextRecall(actorId, query),
        )) ?? "";
      return {
        actorId,
        query,
        items: this.filterBySensitivity(this.textToRecallItems(text, "narrative")),
        domain: "narrative",
        mode: "cross_domain",
        recalledAt: now,
      };
    }

    // Fallback：并行调多个单域 recall 合并
    const domains: MemoryDomainKind[] = ["semantic", "episodic", "narrative"];
    const results = await Promise.all(
      domains.map((d) =>
        this.recall(actorId, query, { domain: d }).catch((err) => {
          console.log(`[MemoryCortex] recallCrossDomain domain=${d} 失败: ${err}`);
          return null;
        }),
      ),
    );
    const mergedItems: MemoryRecallItem[] = [];
    for (const r of results) {
      if (!r) continue;
      mergedItems.push(...r.items);
    }
    return {
      actorId,
      query,
      items: this.filterBySensitivity(mergedItems),
      domain: "semantic",
      mode: "cross_domain",
      recalledAt: now,
    };
  }

  /**
   * 记忆巩固（夜间睡眠状态机）。
   *
   * 优先委托 nightlyScheduler.forceRunNightTasks（内部整合 memoryManager.consolidateNow
   * + narrative.runSleepConsolidation + archive + sync）；未注册时 fallback 到
   * narrative.runSleepConsolidation；均未注册或空入参则返回空统计（不报错）。
   */
  async consolidate(actorIds: string[]): Promise<MemoryConsolidationStats> {
    const now = new Date().toISOString();
    const empty: MemoryConsolidationStats = {
      actorIds,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      consolidatedAt: now,
    };

    if (actorIds.length === 0) {
      return empty;
    }

    // 优先委托夜间调度器（统一整合 consolidate + archive + sync）
    if (this.nightlyScheduler) {
      try {
        const result = await this.nightlyScheduler.forceRunNightTasks();
        if (result.error) {
          console.log(`[MemoryCortex] nightlyScheduler.forceRunNightTasks 错误: ${result.error}`);
        }
        return {
          actorIds,
          dailyCleanupCount: result.consolidated ? 1 : 0,
          weeklyMergedCount: result.archived ? 1 : 0,
          monthlyAbstractedCount: result.synced ? 1 : 0,
          consistencyFlagCount: 0,
          knowledgePromotedCount: 0,
          compressionRate: 0,
          estimatedRecallPrecision: 0,
          plannedActions: 0,
          executedActions: 0,
          consolidatedAt: now,
        };
      } catch (err) {
        console.log(`[MemoryCortex] nightlyScheduler.forceRunNightTasks 失败: ${err}`);
        return empty;
      }
    }

    // Fallback：委托 narrative.runSleepConsolidation
    if (!this.narrative) {
      return empty;
    }

    try {
      const reports = await this.narrative.runSleepConsolidation(actorIds);
      return this.mergeSleepReports(actorIds, reports, now);
    } catch (err) {
      console.log(`[MemoryCortex] narrative.runSleepConsolidation 失败: ${err}`);
      return empty;
    }
  }

  // ---- 人格内核（personality 域）-------------------------------------------

  /**
   * 拉取结构化人格内核（values / speech_style / beliefs / quirks）。
   *
   * - 优先返回内存缓存；
   * - 缓存未命中时从 KV 摘要记忆读取（key: `personality_core_${actorId}`）；
   * - 未设置或读取失败时返回默认人格（不阻塞启动，防漂移）。
   * 人格特质不随单次对话漂移，仅可通过 {@link setPersonalityCore} 显式更新。
   */
  getPersonalityCore(actorId: string): PersonalityCore {
    const cached = this.personalityCache.get(actorId);
    if (cached) return cached;

    if (this.kvSummary) {
      try {
        const key = personalityCoreKey(actorId);
        const { entries } = this.kvSummary.getSnapshot(actorId, [key]);
        const raw = entries[key];
        if (isPersonalityCore(raw)) {
          this.personalityCache.set(actorId, raw);
          return raw;
        }
      } catch (err) {
        console.log(`[MemoryCortex] getPersonalityCore 读取 KV 失败: ${err}`);
      }
    }

    // 默认人格（不缓存，避免误把默认值固化为「已设置」）
    return DEFAULT_PERSONALITY_CORE;
  }

  /**
   * 设置结构化人格内核，并持久化到 KV（key: `personality_core_${actorId}`）。
   * 写入同时更新内存缓存，确保后续 getPersonalityCore 立即返回新值。
   */
  setPersonalityCore(actorId: string, core: PersonalityCore): void {
    this.personalityCache.set(actorId, core);
    if (this.kvSummary?.setEntry) {
      try {
        this.kvSummary.setEntry(actorId, personalityCoreKey(actorId), core);
      } catch (err) {
        console.log(`[MemoryCortex] setPersonalityCore 写入 KV 失败: ${err}`);
      }
    } else {
      console.log("[MemoryCortex] setPersonalityCore: kvSummary.setEntry 未注册，仅更新内存缓存");
    }
  }

  // ---- 内部工具 ------------------------------------------------------------

  /**
   * 按 sensitivity 过滤召回条目。
   * includeRestricted=false（缺省）时剔除 sensitivity=restricted 的条目，
   * 防止受限记忆进入 prompt 路径；缺省 sensitivity 视为 "public"。
   */
  private filterBySensitivity(
    items: MemoryRecallItem[],
    includeRestricted?: boolean,
  ): MemoryRecallItem[] {
    if (includeRestricted) return items;
    return items.filter((item) => (item.sensitivity ?? "public") !== "restricted");
  }

  /** 把召回文本包装为单条 MemoryRecallItem（超长文本截断至 800 字符并追加省略标记） */
  private textToRecallItems(text: string, domain: MemoryDomainKind): MemoryRecallItem[] {
    if (!text || !text.trim()) return [];
    const clipped =
      text.length > MAX_RECALL_ITEM_TEXT_LENGTH
        ? text.slice(0, MAX_RECALL_ITEM_TEXT_LENGTH) + "…"
        : text;
    return [
      {
        content: clipped,
        domain,
      },
    ];
  }

  /** 把 HumanLikeMemory 召回结果映射为 MemoryRecallItem 列表 */
  private humanLikeResultToItems(
    result: { text: string; confidence: number } | null,
    domain: MemoryDomainKind,
  ): MemoryRecallItem[] {
    if (!result || !result.text) return [];
    return [
      {
        content: result.text,
        domain,
        score: result.confidence,
      },
    ];
  }

  /** 安全调用异步召回，捕获异常并返回 null */
  private async safeRecall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      console.log(`[MemoryCortex] recall 调用失败: ${err}`);
      return null;
    }
  }

  /** 合并多个睡眠巩固报告为单一 MemoryConsolidationStats */
  private mergeSleepReports(
    actorIds: string[],
    reports: NarrativeSleepReport[],
    consolidatedAt: string,
  ): MemoryConsolidationStats {
    const stats: MemoryConsolidationStats = {
      actorIds,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      consolidatedAt,
    };
    if (reports.length === 0) return stats;

    let precisionSum = 0;
    let compressionSum = 0;
    for (const r of reports) {
      stats.dailyCleanupCount += r.dailyCleanupCount;
      stats.weeklyMergedCount += r.weeklyMergedCount;
      stats.monthlyAbstractedCount += r.monthlyAbstractedCount;
      stats.consistencyFlagCount += r.consistencyFlagCount;
      stats.knowledgePromotedCount += r.knowledgePromotedCount;
      stats.plannedActions += r.plannedActions;
      stats.executedActions += r.executedActions;
      precisionSum += r.estimatedRecallPrecision;
      compressionSum += r.compressionRate;
    }
    stats.estimatedRecallPrecision = Number((precisionSum / reports.length).toFixed(3));
    stats.compressionRate = Number((compressionSum / reports.length).toFixed(3));
    return stats;
  }
}
