// Agent Brain Center — 记忆皮层（海马体）
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type {
  MemoryConsolidationStats,
  MemoryDomainKind,
  MemoryItem,
  MemoryItemKind,
  MemoryMedia,
  MemoryRecallItem,
  MemoryRecallResult,
  PersonalityCore,
  PredictedAssociation,
  SchemaMatchResult,
  SalienceDecision,
  ProceduralMatch,
  InferenceClue,
  InferenceResult,
} from "./types.js";
import type { RelationshipGraphService } from "../services/relationship-graph-service.js";
import type { MemoryAssociativeGraph } from "./memory-cognitive/memory-associative-graph.js";
import type { MemoryReconstructionValidator } from "./memory-cognitive/memory-reconstruction-validator.js";
import type { MemoryMetacognitionBridge } from "./memory-cognitive/memory-metacognition-bridge.js";
import type { MemoryForgettingController } from "./memory-cognitive/memory-forgetting-controller.js";
import type { MemoryProceduralAutomation } from "./memory-cognitive/memory-procedural-automation.js";
import type { MemorySchemaFormation } from "./memory-cognitive/memory-schema-formation.js";
import type { MemorySalienceFilter } from "./memory-cognitive/memory-salience-filter.js";
import type { MemoryInferenceEngine } from "./memory-cognitive/memory-inference-engine.js";
import type { EmotionState } from "./memory-cognitive/memory-inference-emotion-modulator.js";
import type {
  LearningFeedback,
  LearningSnapshot,
  MemoryExperienceLearningLoop,
} from "./memory-cognitive/memory-experience-learning-loop.js";

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
  /**
   * 把命中的 forgotten 行移回 memory_summary（forgotten 自动恢复）。
   * 当 recall 命中 memory_summary_forgotten 中的行且判定与当前 query 相关时调用。
   * 实现内部用 applyPatch 原子读写，避免并发覆盖。
   */
  restoreForgottenLines?(actorId: string, lines: string[]): Promise<void>;
  /**
   * 语义化 forgotten 召回（方案 A）：
   * 用 embedding 计算 query 与 forgotten 行的 cosine 相似度，> 阈值视为命中；
   * embedding 无命中时降级到 LLM 批量语义判断。
   * 返回与 query 语义相关的 forgotten 行（用于补充主召回 + 自动恢复）。
   */
  recallForgottenSemantic?(actorId: string, query: string): Promise<string[]>;
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

/** 多模态媒体存储根目录（相对于 server 工作目录） */
const MEMORY_MEDIA_ROOT = resolve(process.cwd(), ".memory-media");

/** 根据 media.kind + mime 推断文件扩展名 */
function inferMediaExt(media: MemoryMedia): string {
  const mime = media.mime.toLowerCase();
  if (media.kind === "image") {
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    return "img";
  }
  if (media.kind === "audio") {
    if (mime.includes("wav")) return "wav";
    if (mime.includes("mp3")) return "mp3";
    if (mime.includes("ogg")) return "ogg";
    if (mime.includes("webm")) return "webm";
    return "audio";
  }
  if (media.kind === "video") {
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("webm")) return "webm";
    return "video";
  }
  return "bin";
}

/**
 * 持久化多模态媒体到本地文件系统。
 * 路径：.memory-media/<actorId>/<sha256>.<ext>
 * 返回 storageId（文件名，不含路径），供召回时拉取。
 * 写入失败时返回 null（不阻塞记忆主流程，降级为纯文本记忆）。
 */
function persistMediaBlob(actorId: string, media: MemoryMedia): string | null {
  if (!media.blob || media.blob.length === 0) return null;
  try {
    const dir = join(MEMORY_MEDIA_ROOT, actorId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const hash = createHash("sha256").update(media.blob).digest("hex").slice(0, 32);
    const ext = inferMediaExt(media);
    const filename = `${hash}.${ext}`;
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) {
      writeFileSync(filepath, media.blob);
    }
    return filename;
  } catch (err) {
    console.log(`[MemoryCortex] persistMediaBlob 失败（降级纯文本）: ${err}`);
    return null;
  }
}

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
  // relationship 域：关系图谱服务（Phase 1.2，里程碑/轨迹/共同经历）
  private relationshipGraph: RelationshipGraphService | null = null;
  // ---- 记忆认知架构升级（Phase 3）：7 个子组件 ---------------------------
  private associativeGraph: MemoryAssociativeGraph | null = null;
  private reconstructionValidator: MemoryReconstructionValidator | null = null;
  private metacognitionBridge: MemoryMetacognitionBridge | null = null;
  private forgettingController: MemoryForgettingController | null = null;
  private proceduralAutomation: MemoryProceduralAutomation | null = null;
  private schemaFormation: MemorySchemaFormation | null = null;
  private salienceFilter: MemorySalienceFilter | null = null;
  private experienceLearningLoop: MemoryExperienceLearningLoop | null = null;
  // ---- 记忆认知架构升级（推理引擎）：多线索交叉推理 -----------------------
  private inferenceEngine: MemoryInferenceEngine | null = null;

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

  /** 注册关系图谱服务（Phase 1.2）：用于 relationship 域 recall 与里程碑记录 */
  registerRelationshipGraph(svc: RelationshipGraphService): void {
    this.relationshipGraph = svc;
    console.log("[MemoryCortex] 已注册 RelationshipGraph");
  }

  // ---- 记忆认知架构升级（Phase 3）：7 个子组件注册 ------------------------

  registerAssociativeGraph(svc: MemoryAssociativeGraph): void {
    this.associativeGraph = svc;
    console.log("[MemoryCortex] 已注册 MemoryAssociativeGraph");
  }

  registerReconstructionValidator(svc: MemoryReconstructionValidator): void {
    this.reconstructionValidator = svc;
    console.log("[MemoryCortex] 已注册 MemoryReconstructionValidator");
  }

  registerMetacognitionBridge(svc: MemoryMetacognitionBridge): void {
    this.metacognitionBridge = svc;
    console.log("[MemoryCortex] 已注册 MemoryMetacognitionBridge");
  }

  registerForgettingController(svc: MemoryForgettingController): void {
    this.forgettingController = svc;
    console.log("[MemoryCortex] 已注册 MemoryForgettingController");
  }

  registerProceduralAutomation(svc: MemoryProceduralAutomation): void {
    this.proceduralAutomation = svc;
    console.log("[MemoryCortex] 已注册 MemoryProceduralAutomation");
  }

  registerSchemaFormation(svc: MemorySchemaFormation): void {
    this.schemaFormation = svc;
    console.log("[MemoryCortex] 已注册 MemorySchemaFormation");
  }

  registerSalienceFilter(svc: MemorySalienceFilter): void {
    this.salienceFilter = svc;
    console.log("[MemoryCortex] 已注册 MemorySalienceFilter");
  }

  registerExperienceLearningLoop(svc: MemoryExperienceLearningLoop): void {
    this.experienceLearningLoop = svc;
    console.log("[MemoryCortex] 已注册 MemoryExperienceLearningLoop");
  }

  /** 注册推理引擎（多线索交叉推理） */
  registerInferenceEngine(svc: MemoryInferenceEngine): void {
    this.inferenceEngine = svc;
    console.log("[MemoryCortex] 已注册 MemoryInferenceEngine（推理引擎）");
  }

  /**
   * 从多条线索推理出新结论。
   *
   * 委托 MemoryInferenceEngine.inferFromClues；未注册时返回空结果。
   * 不调 LLM——推理是规则匹配 + 模板拼接的纯算法结果。
   *
   * @param actorId 关联 actor
   * @param clues 线索列表
   * @param emotion 情绪状态（可选，传给 emotionModulator 做情感调制）
   */
  async inferFromClues(
    actorId: string,
    clues: InferenceClue[],
    emotion?: EmotionState | null,
  ): Promise<InferenceResult> {
    const empty: InferenceResult = {
      inferences: [],
      combinedConfidence: 0,
      inferredAt: new Date().toISOString(),
    };
    if (!this.inferenceEngine) return empty;
    try {
      return await this.inferenceEngine.inferFromClues(actorId, clues, emotion);
    } catch (err) {
      console.log(`[MemoryCortex] inferFromClues 失败: ${err}`);
      return empty;
    }
  }

  /**
   * 触发规则自学习（4 项仿人推理能力扩展）。
   *
   * 委托 MemoryInferenceEngine.autoLearn；未注册推理引擎时返回空。
   * 扫描记忆图，挖掘频繁共现的关键词对，自动生成新规则并注册到引擎。
   */
  async autoLearn(actorId?: string): Promise<unknown[]> {
    if (!this.inferenceEngine) return [];
    try {
      return await this.inferenceEngine.autoLearn(actorId);
    } catch (err) {
      console.log(`[MemoryCortex] autoLearn 失败: ${err}`);
      return [];
    }
  }

  /**
   * 触发 LLM 规则归纳（LLM 规则归纳器扩展）。
   *
   * 与 autoLearn 的关系：
   *   - autoLearn 内部会优先用 LLM 归纳（若 llmInducer 已注入），降级到算法
   *   - autoLearnWithLLM 是显式入口，语义上明确"用 LLM 归纳"
   *   - 两者底层都走 inferenceEngine.autoLearn，区别仅在语义清晰度
   *
   * LLM 只参与"学规则"（一次性归纳），不参与"用规则推理"。
   * 推理阶段仍是程序化算法（matchRule + fillTemplate）。
   *
   * @param actorId 指定 actor 的记忆图（可选）
   * @returns 本次学习到的新规则列表（推理引擎未注册或 LLM 不可用时返回空）
   */
  async autoLearnWithLLM(actorId?: string): Promise<unknown[]> {
    if (!this.inferenceEngine?.autoLearn) return [];
    // autoLearn 内部会优先用 LLM 归纳（若 llmInducer 已注入），降级到算法
    try {
      return await this.inferenceEngine.autoLearn(actorId);
    } catch (err) {
      console.log(`[MemoryCortex] autoLearnWithLLM 失败: ${err}`);
      return [];
    }
  }

  /** 获取已学习的规则（未注册推理引擎时返回空） */
  getLearnedRules(): unknown[] {
    if (!this.inferenceEngine) return [];
    return this.inferenceEngine.getLearnedRules();
  }

  /** 获取已迁移的规则（未注册推理引擎时返回空） */
  getMigratedRules(): unknown[] {
    if (!this.inferenceEngine) return [];
    return this.inferenceEngine.getMigratedRules();
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
    // ---- 记忆认知架构升级（Phase 3）：salience filter 守门 ----
    // 在 domain / importance 计算之前评估原 item；失败时降级为正常写入（不阻塞主流程）。
    if (this.salienceFilter) {
      try {
        const salience = this.salienceFilter.evaluateSalience(item);
        if (!salience.accept) {
          console.log(
            `[MemoryCortex] salience filter 拒绝写入 (score=${salience.score}, reason=${salience.reason})`,
          );
          return; // 拒绝写入
        }
        if (salience.degraded) {
          // 降级为 decay：写入但不进入长期记忆，仅写短期记忆（如果有 sessionId）
          console.log(`[MemoryCortex] salience filter 降级为 decay (score=${salience.score})`);
          try {
            this.experienceLearningLoop?.observeMemoryItem(actorId, item);
          } catch {
            /* learning loop failure is non-blocking */
          }
          if (item.sessionId && this.shortTerm) {
            try {
              this.shortTerm.syncTaskForTurn(item.sessionId, item.content);
            } catch {
              /* 静默 */
            }
          }
          return;
        }
      } catch (err) {
        console.log(`[MemoryCortex] salience filter 异常（降级为正常写入）: ${err}`);
      }
    }

    const domain = item.domain ?? inferDomain(item.kind);
    const importance = item.importance ?? "medium";
    const sourceId = item.source ?? "system";
    const highSignal = importance === "high" || importance === "critical";

    // 多模态记忆预处理：若携带 media.blob，先持久化到本地文件系统，
    // 在 metadata 中记录 mediaRef（storageId + kind + mime + caption）。
    // 写入失败降级为纯文本记忆（不阻塞主流程）。
    let effectiveContent = item.content;
    let effectiveMetadata = item.metadata;
    if (item.media?.blob && item.media.blob.length > 0) {
      const storageId = persistMediaBlob(actorId, item.media);
      if (storageId) {
        effectiveMetadata = {
          ...(item.metadata ?? {}),
          mediaRef: {
            storageId,
            kind: item.media.kind,
            mime: item.media.mime,
            caption: item.media.caption ?? item.content.slice(0, 100),
            origin: item.media.origin ?? "unknown",
          },
        };
        // content 补充占位符，让召回时 LLM 知道有图但当前不能直接看
        const placeholder = `[${item.media.kind === "image" ? "图片" : item.media.kind === "audio" ? "音频" : "视频"}：${item.media.caption ?? item.content.slice(0, 60)}]`;
        effectiveContent = item.content ? `${item.content}\n${placeholder}` : placeholder;
      }
    }

    try {
      this.experienceLearningLoop?.observeMemoryItem(actorId, {
        ...item,
        actorId,
        domain,
        content: effectiveContent,
        metadata: effectiveMetadata,
      });
    } catch {
      /* learning loop failure is non-blocking */
    }

    // 写短期记忆：工作记忆且带 sessionId
    if (domain === "working" && item.sessionId && this.shortTerm) {
      try {
        this.shortTerm.syncTaskForTurn(item.sessionId, effectiveContent);
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
        await this.narrative.ingest(actorId, effectiveContent, sourceId, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown", hasMedia: !!item.media },
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
        await this.agentic.ingest.ingestText(actorId, sourceId, effectiveContent, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown", hasMedia: !!item.media },
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

    // 关系记忆 → RelationshipGraphService（Phase 1.2）
    if (domain === "relationship") {
      if (this.relationshipGraph) {
        const summary = await this.safeRecall(() =>
          this.relationshipGraph!.getRelationshipSummary(actorId),
        );
        return {
          actorId,
          query,
          items: this.filterBySensitivity(
            summary ? this.textToRecallItems(summary, "relationship") : [],
            opts?.includeRestricted,
          ),
          domain: "relationship",
          mode: "single_domain",
          recalledAt: now,
        };
      }
      return {
        actorId,
        query,
        items: [],
        domain: "relationship",
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

    // Phase 1.2：附加关系记忆片段（最多 2 条，每条 ≤ 200 char，避免 token 膨胀）
    if (this.relationshipGraph) {
      const relSummary = await this.safeRecall(() =>
        this.relationshipGraph!.getRelationshipSummary(actorId),
      );
      if (relSummary) {
        const relItems = this.textToRecallItems(relSummary, "relationship").slice(0, 2);
        mergedItems = [...mergedItems, ...relItems];
      }
    }

    if (this.experienceLearningLoop) {
      try {
        const learningItems = this.experienceLearningLoop.recallLearningContext(
          actorId,
          query,
          Math.max(1, Math.min(3, opts?.limit ?? 3)),
        );
        mergedItems = [...mergedItems, ...learningItems];
      } catch (err) {
        console.log(`[MemoryCortex] experienceLearningLoop recall failed: ${err}`);
      }
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

    // forgotten 主动补充（方案 B）：主召回 < 3 条时，用语义检索 forgotten 归档
    // 改造前：仅三路全空才触发（被动降级，纯关键词匹配）
    // 改造后：主召回不足时主动用 embedding 语义检索 forgotten，命中即补充 + 异步恢复
    if (mergedItems.length < 3 && this.kvSummary && this.memoryManager?.recallForgottenSemantic) {
      try {
        const forgottenHits = await this.memoryManager.recallForgottenSemantic(actorId, query);
        if (forgottenHits.length > 0) {
          // 异步恢复（把命中行从 forgotten 移回 memory_summary），不阻塞当前 recall
          void this.memoryManager.restoreForgottenLines?.(actorId, forgottenHits).catch(() => {});
          mergedItems = [
            ...mergedItems,
            ...this.textToRecallItems(forgottenHits.join("\n"), "semantic"),
          ];
        }
      } catch (err) {
        console.log(`[MemoryCortex] forgotten 语义召回失败: ${err}`);
      }
    }

    const finalResult: MemoryRecallResult = {
      actorId,
      query,
      items: this.filterBySensitivity(mergedItems, opts?.includeRestricted),
      domain: "semantic",
      mode: "single_domain",
      recalledAt: now,
    };

    // ---- 记忆认知架构升级（Phase 3）：recall 命中后异步触发联想扩散（不阻塞主召回）----
    // MemoryRecallItem 不携带 nodeId 字段，用 content 长度兜底构造 seed id。
    // spread 内部按 seed id 匹配图节点，未命中时返回空结果（无副作用）。
    // recall 命中 downranked/cold 节点的再唤醒由 BrainStem 45s 心跳 →
    // forgettingController.continuousScore 统一处理（见 Phase 4 装配）。
    if (this.associativeGraph && finalResult.items.length > 0) {
      const seedNodeIds = finalResult.items
        .slice(0, 3)
        .map((it, idx) => `seed-${idx}-${it.content.length}`);
      void this.associativeGraph
        .spread(actorId, seedNodeIds)
        .then((spreadResult) => {
          void this.associativeGraph!
            .triggerExplorationIfNeeded(actorId, spreadResult, query)
            .catch(() => {
              /* 静默 */
            });
        })
        .catch(() => {
          /* 静默 */
        });
    }

    // ---- 推理引擎：recall 命中 ≥ 2 条时异步触发多线索交叉推理 ----
    // 把召回的前 3 条记忆作为"memory_recalled"线索喂给推理引擎，
    // 若能匹配规则则生成新结论（不阻塞主召回，失败静默降级）。
    if (this.inferenceEngine && finalResult.items.length >= 2) {
      const clues: InferenceClue[] = finalResult.items
        .slice(0, 3)
        .map((it) => ({ text: it.content, source: "memory_recalled" as const }));
      void this.inferenceEngine.inferFromClues(actorId, clues).catch(() => {
        /* 静默 */
      });
    }

    return finalResult;
  }

  async recordLearningFeedback(feedback: LearningFeedback): Promise<LearningSnapshot | null> {
    if (!this.experienceLearningLoop) return null;
    try {
      this.experienceLearningLoop.recordFeedback(feedback);
      return this.experienceLearningLoop.getSnapshot(feedback.actorId);
    } catch (err) {
      console.log(`[MemoryCortex] recordLearningFeedback failed: ${err}`);
      return null;
    }
  }

  async rememberBatch(actorId: string, items: MemoryItem[]): Promise<void> {
    for (const item of items) {
      try {
        await this.remember(actorId, item);
      } catch (err) {
        console.log(`[MemoryCortex] rememberBatch item failed: ${err}`);
      }
    }
  }

  getLearningSnapshot(actorId: string): LearningSnapshot | null {
    if (!this.experienceLearningLoop) return null;
    try {
      return this.experienceLearningLoop.getSnapshot(actorId);
    } catch (err) {
      console.log(`[MemoryCortex] getLearningSnapshot failed: ${err}`);
      return null;
    }
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

    let reports: NarrativeSleepReport[] = [];
    try {
      reports = await this.narrative.runSleepConsolidation(actorIds);
    } catch (err) {
      console.log(`[MemoryCortex] narrative.runSleepConsolidation 失败: ${err}`);
      return empty;
    }

    // ---- 记忆认知架构升级（Phase 3）：consolidate 后置钩子 ----
    // 1) reconstruction validator 钩子：narrative 内部 merge/abstract 时已通过
    //    本类对外方法暴露校验能力，此处仅发射 synapse 事件标记 validator 就绪，
    //    避免双重调用导致性能损耗。
    if (this.reconstructionValidator) {
      try {
        this.synapseBus?.fire(
          "memory.consolidate.validator_ready",
          { actorIds },
          { source: "memory" },
        );
      } catch {
        /* fire 失败不影响主流程 */
      }
    }

    // 2) connection pruning 钩子：对每个 actor 调用 forgettingController.pruneConnections，
    //    清除 score < 阈值节点的所有 edge（保留节点本体供历史追溯）。
    //    失败时静默降级，不阻塞 consolidate 主流程。
    if (this.forgettingController) {
      for (const aid of actorIds) {
        try {
          await this.forgettingController.pruneConnections(aid);
        } catch (err) {
          console.log(
            `[MemoryCortex] forgettingController.pruneConnections 失败 (actorId=${aid}): ${err}`,
          );
        }
      }
    }

    return this.mergeSleepReports(actorIds, reports, now);
  }

  // ---- 记忆认知架构升级（Phase 3）：6 个对外委托方法 ---------------------

  /**
   * 元记忆召回：附带来源（provenance）与置信分层（confidenceTier）。
   *
   * 委托 MetacognitionBridge.recallWithProvenance；未注册时降级到普通 recall。
   * 不调 LLM——confidenceTier 由 accessCount / correctness / verification 状态规则计算。
   */
  async recallWithProvenance(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number },
  ): Promise<MemoryRecallResult> {
    if (this.metacognitionBridge) {
      try {
        return await this.metacognitionBridge.recallWithProvenance(actorId, query, {
          domain: opts?.domain,
          limit: opts?.limit,
        });
      } catch (err) {
        console.log(`[MemoryCortex] recallWithProvenance 失败（降级到 recall）: ${err}`);
      }
    }
    return this.recall(actorId, query, opts);
  }

  /**
   * 联想预判：基于 query 关键词找种子节点，扩散后聚合预判结果。
   *
   * 委托 AssociativeGraph.predictAssociation；未注册时返回空结果。
   * 不调 LLM——predictedOutcome 由激活节点 summary 规则拼接。
   */
  async predictAssociation(actorId: string, query: string): Promise<PredictedAssociation> {
    const empty: PredictedAssociation = {
      seedNodes: [],
      activatedNodes: [],
      predictedOutcome: "",
      confidence: 0,
      predictedAt: new Date().toISOString(),
    };
    if (!this.associativeGraph) return empty;
    try {
      return await this.associativeGraph.predictAssociation(actorId, query);
    } catch (err) {
      console.log(`[MemoryCortex] predictAssociation 失败: ${err}`);
      return empty;
    }
  }

  /**
   * 图式同化：从新场景匹配最相似的图式，返回建议操作序列（仅建议，不强制）。
   *
   * 委托 SchemaFormation.matchSchema；未注册时返回 null。
   * 不调 LLM——匹配是关键词 overlap 计算。
   */
  matchSchema(situation: {
    sceneTag?: string;
    keywords?: string[];
    summary?: string;
  }): SchemaMatchResult | null {
    if (!this.schemaFormation) return null;
    try {
      return this.schemaFormation.matchSchema(situation);
    } catch (err) {
      console.log(`[MemoryCortex] matchSchema 失败: ${err}`);
      return null;
    }
  }

  /**
   * 显著性评估：在写入前评估记忆的 salienceScore，返回写入决策。
   *
   * 委托 SalienceFilter.evaluateSalience；未注册时返回默认接受决策。
   * 不调 LLM——salienceScore 是 emotionValence + importance + feedback + novelty 加权。
   */
  evaluateSalience(item: MemoryItem): SalienceDecision {
    if (!this.salienceFilter) {
      return { accept: true, score: 1, reason: "no_salience_filter", degraded: false };
    }
    try {
      return this.salienceFilter.evaluateSalience(item);
    } catch (err) {
      console.log(`[MemoryCortex] evaluateSalience 失败（默认接受）: ${err}`);
      return { accept: true, score: 1, reason: "salience_eval_error", degraded: false };
    }
  }

  /**
   * 再唤醒反弹：recall 命中 downranked/cold 节点时调用。
   *
   * 委托 ForgettingController.reawakenAndStrengthen；未注册时空操作。
   * 不调 LLM——reawaken 是状态机回退 + frequencyScore += 0.3。
   */
  async reawakenAndStrengthen(actorId: string, nodeId: string): Promise<void> {
    if (!this.forgettingController) return;
    try {
      await this.forgettingController.reawakenAndStrengthen(actorId, nodeId);
    } catch (err) {
      console.log(`[MemoryCortex] reawakenAndStrengthen 失败: ${err}`);
    }
  }

  /**
   * 程序性技能匹配：检查是否已有匹配的 procedural 记忆可绕过 LLM。
   *
   * 委托 ProceduralAutomation.matchProceduralSkill；未注册时返回 null。
   * 不调 LLM——匹配是 Jaccard 相似度计算。
   */
  matchProceduralSkill(query: string): ProceduralMatch | null {
    if (!this.proceduralAutomation) return null;
    try {
      return this.proceduralAutomation.matchProceduralSkill(query);
    } catch (err) {
      console.log(`[MemoryCortex] matchProceduralSkill 失败: ${err}`);
      return null;
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

  // ============================================================
  // 世界状态轨迹存储（P1-10：world 域）
  // ============================================================
  //
  // 在原有记忆域基础上新增 "world" 域，存储 WorldModel 的状态时间序列。
  // 与 TransitionStore（world-model-transition-store.ts）的区别：
  //   - TransitionStore：结构化 (s, a, s') 样本，供世界模型离线训练
  //   - MemoryCortex world 域：人类可读的状态摘要，供叙事/反思/DMN 使用
  //
  // 两者互补：TransitionStore 是机器学习数据，world 域是认知记忆。

  /**
   * 存储世界状态转移轨迹到 world 域。
   *
   * 把 (state, action, nextState) 转为人类可读摘要写入记忆，
   * 供 DMN 空闲时反思"刚才发生了什么"和叙事回忆使用。
   *
   * @param actorId actor id
   * @param stateBefore 动作前状态
   * @param action 执行的动作
   * @param stateAfter 动作后状态
   * @param predictionError 预测误差（可选，附在摘要中供反思）
   */
  async storeWorldStateTrajectory(
    actorId: string,
    stateBefore: import("./world-model-types.js").WorldState,
    action: import("./world-model-types.js").WorldAction,
    stateAfter: import("./world-model-types.js").WorldState,
    predictionError?: number,
  ): Promise<void> {
    try {
      const beforeSummary = this.summarizeWorldState(stateBefore);
      const afterSummary = this.summarizeWorldState(stateAfter);
      const errorTag = typeof predictionError === "number"
        ? ` [预测误差:${predictionError.toFixed(2)}]`
        : "";
      const content = `[世界状态转移]${errorTag}\n动作：${action.tool}\n动作前：${beforeSummary}\n动作后：${afterSummary}`;

      await this.remember(actorId, {
        actorId,
        content,
        kind: "event" as const,
        domain: "world",
        importance: predictionError !== undefined && predictionError > 0.6 ? "high" : "medium",
        timestamp: stateAfter.timestamp || new Date().toISOString(),
      });
    } catch (e) {
      console.log(`[MemoryCortex] storeWorldStateTrajectory 失败: ${e}`);
    }
  }

  /**
   * 召回世界状态轨迹（world 域）。
   *
   * 供 DMN 空闲时反思"最近环境发生了什么变化"使用。
   *
   * @param actorId actor id
   * @param query 查询关键词（如 "desktop" / "click"）
   * @param limit 最大返回条数（默认 5）
   */
  async recallWorldState(
    actorId: string,
    query?: string,
    limit = 5,
  ): Promise<MemoryRecallItem[]> {
    try {
      const items = await this.recall(actorId, query ?? "世界状态转移", {
        domain: "world",
        limit,
      });
      return items.items;
    } catch (e) {
      console.log(`[MemoryCortex] recallWorldState 失败: ${e}`);
      return [];
    }
  }

  /** 把 WorldState 摘要为人类可读短文本 */
  private summarizeWorldState(state: import("./world-model-types.js").WorldState): string {
    const parts: string[] = [];
    if (state.bodyState?.currentDevice) parts.push(`设备:${state.bodyState.currentDevice}`);
    if (state.taskContext) parts.push(`任务:${state.taskContext.slice(0, 60)}`);
    if (state.userActivity) parts.push(`用户:${state.userActivity.slice(0, 40)}`);
    const slotCount = state.perceptualSlots?.length ?? 0;
    if (slotCount > 0) parts.push(`感知:${slotCount}槽位`);
    return parts.length > 0 ? parts.join(" | ") : "(空)";
  }
}
