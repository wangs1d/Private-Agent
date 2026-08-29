// Agent Brain Center — 进化皮层
//
// 负责接收/创建进化提案、维护提案状态机、驱动 SkillGenerator 与
// SkillPromotionPipeline 完成自我进化，并从 AgentSelfLearningService
// 的失败轨迹中按规则归纳能力缺口。不直接调用 LLM；所有"智能"行为
// 由被注册的子系统（如 SkillGenerator）内部完成。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  CapabilityGapReport,
  EvolutionProposal,
  EvolutionProposalStatus,
} from "./types.js";
import type {
  ImprovementSuggestion,
  LearningRecord,
} from "../services/agent-self-learning-service.js";
import type {
  ProceduralSkillGenerationRequest,
  ProceduralSkillGenerationResult,
  SkillGenerationRequest,
  SkillGenerationResult,
} from "../services/skill-generator.js";
import type { SkillMetadata } from "../skills/types.js";

// ---- 子系统最小化外观接口 ---------------------------------------------
//
// cortex 只声明它实际需要调用的方法；若真实子系统的签名与之不同，
// 可在注册时由调用方做适配。所有方法均定义为可选，便于优雅降级。

/** 自学习服务外观 */
interface SelfLearningLike {
  /** 返回最近的交互学习记录（含 attemptedTools / errorMessage） */
  getRecentRecords?(): LearningRecord[];
  /** 读取已生成的改进建议（fallback，不含原始轨迹字段） */
  getRecentSuggestions?(): Promise<ImprovementSuggestion[]>;
  /** 记录一次交互学习（含失败轨迹）。生产路径由 AgentCore 工具回调调用 */
  recordInteraction?(record: Omit<LearningRecord, "timestamp">): Promise<void>;
}

/** 技能生成器外观 */
interface SkillGeneratorLike {
  generateSkill(request: SkillGenerationRequest): Promise<SkillGenerationResult>;
  /**
   * 经验沉淀生成器（procedural 技能）。
   *
   * 借鉴外部智能体的经验沉淀思路：把一次复杂任务轨迹交给 LLM 提炼成可复用 SKILL.md。
   * 未实现时 EvolutionCortex 对 skill_distill 提案降级为 generated（保持非终态）。
   */
  generateProceduralSkill?(
    request: ProceduralSkillGenerationRequest,
  ): Promise<ProceduralSkillGenerationResult>;
}

/**
 * procedural 技能沉淀外观（SkillManager 外观）。
 *
 * EvolutionCortex 在 skill_distill 提案执行成功后调用它把 SKILL.md 写入磁盘 +
 * 注册到内存索引。未注册时降级为 generated（保持非终态，等注册后再执行）。
 *
 * 设计原则：与 PromotionPipeline（code 技能装载）解耦——procedural 技能不需要
 * 编译 handler，不需要用户审批，沉淀即可用。
 */
export interface ProceduralSkillSinkLike {
  registerProceduralSkill(
    metadata: SkillMetadata,
    doc: string,
  ): { ok: boolean; skillName?: string; error?: string; docPath?: string };
}

/**
 * 知识缺口执行器外观（学知识层）。
 *
 * 与技能生成器走完全不同的路径：
 *  1. 先调 rag.recall(query) 看本地知识库（向量库+BM25+RRF）能否命中
 *  2. 若召回不足（返回空或太短）→ 调 rag.fetchFromWeb(query) 联网兜底
 *  3. 把查询结果（摘要后）调 rag.ingestKnowledge(actorId, text, source) 沉淀到
 *     - 向量库（NarrativeMemoryPort.ingest → HumanLikeMemory + Mem0）
 *     - 结构化 KV facts（AgentMemorySyncService.appendMemorySummaryLine）
 *
 * 设计原则：知识层不走 SkillGenerator，不生成 handler 代码，不需要用户审批。
 * 知识不是危险操作，但写入需可审计（通过日志 + source 字段标识来源）。
 */
export interface KnowledgeGapExecutorLike {
  /** 先 RAG 召回，召回不足则联网兜底，返回最终沉淀到记忆层的知识文本 */
  executeKnowledgeGap(params: {
    actorId: string;
    query: string;
    rationale: string;
  }): Promise<{ ok: boolean; knowledge?: string; source?: string; ragHit?: boolean; error?: string }>;
}

/** self_upgrade 提案可携带的 LLM 深度评估摘要（结构保持与原评估对象兼容） */
interface EvolutionLlmAssessment {
  recommendation?: string;
  riskLevel?: "low" | "medium" | "high" | string;
  confidence?: number;
  summary?: string;
}

/** 沙箱测试报告摘要（self_upgrade 执行后写入，供外部查询） */
interface SandboxTestReport {
  tscPassed: boolean;
  testsPassed: boolean;
  rolledBack: boolean;
  testFilesRun: string[];
  totalMs: number;
}

/**
 * 升级执行器外观（Phase 5：self_upgrade 执行路径）。
 *
 * EvolutionCortex 对 self_upgrade 提案路由到这里执行。
 * 实现方负责沙箱测试先行：备份 → 安装新版本 → tsc + test → 通过才应用。
 */
export interface CodeRepairExecutorLike {
  /**
   * 执行升级（沙箱测试先行）。
   *
   * 实现需自行做：
   * 1. 备份 package.json + package-lock.json
   * 2. 安装新版本
   * 3. 运行 tsc --noEmit + 相关测试
   * 4. 全部通过才保留；任一失败回滚
   *
   * 返回 sandboxReport 包含详细的测试结果。
   */
  executeUpgrade?(params: {
    target: string;          // 升级目标（如 "升级 @modelcontextprotocol/sdk 到 1.0.0"）
    rationale: string;       // 升级理由
    suggestedAction: string; // 建议操作（LLM 评估产出）
    llmAssessment?: EvolutionLlmAssessment;
  }): Promise<{
    ok: boolean;
    patchApplied?: boolean;
    error?: string;
    sandboxReport?: SandboxTestReport;
  }>;
}

/**
 * 知识验证服务外观（反馈回路入口）。
 *
 * EvolutionCortex 在每次 recordToolInteraction 时通知它，
 * 触发已沉淀知识的验证状态机演进。
 */
export interface KnowledgeVerificationLike {
  /**
   * 观察一次用户交互，匹配已沉淀知识的主题，触发验证状态演进。
   *
   * 反馈识别规则（由 verification service 内部实现）：
   *  - 用户明确确认（"对的"/"谢谢"）→ 强正反馈 → verified_strong
   *  - 用户继续追问同类 + 工具成功 → 负反馈 → disputed → rejected
   *  - 用户切换话题 → 隐式正反馈 → pending_verification 升级为 verified
   */
  observeInteraction(params: {
    userRequest: string;
    toolSuccess: boolean;
    matchedTopics?: string[];
  }): void;
}

/**
 * 技能晋升管道外观。
 *
 * 提供 promote() 把生成的 skill 代码编译并装载到运行时 SkillManager。
 * EvolutionCortex 在用户审批通过后调用 promote 完成自主进化。
 */
interface PromotionPipelineLike {
  /** 把生成的 skill 装载到运行时；返回 ok=false 表示装载失败 */
  promote?(skill: {
    metadata: SkillMetadata;
    handlerCode: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /** 备用：基于草稿文件的晋升路径 */
  onDraftPersisted?(params: {
    draftPath: string;
    draft: Record<string, unknown>;
    traceId: string;
  }): Promise<void>;
}

/** WS 推送器外观：用于向用户推送审批请求 */
interface ApprovalEmitterLike {
  /** 向指定 session 推送审批请求 */
  emitApprovalRequest(
    sessionId: string,
    request: {
      proposalId: string;
      title: string;
      description: string;
      rationale: string;
      generatedSkill: {
        name: string;
        description: string;
        parameters: Array<{ name: string; type: string; required: boolean; description?: string }>;
        permissions: string[];
        handlerCodePreview: string;  // handlerCode 前 500 字预览
        explanation?: string;
      };
    },
  ): void;
  /** 向指定 session 推送审批结果 */
  emitApprovalResult(
    sessionId: string,
    result: { proposalId: string; approved: boolean; reason?: string },
  ): void;
}

/** 进化循环外观：cortex 仅注册、观察，不直接驱动 */
interface EvolutionLoopLike {
  // 预留：未来若需查询进化循环状态可在此声明
}

// ---- 内部辅助类型 -----------------------------------------------------

/** 提案附加元信息（不进入 EvolutionProposal 公开字段） */
interface ProposalMeta {
  /** 最近一次执行错误 */
  lastError?: string;
  /** 连续执行失败次数（达到 MAX_EXECUTE_RETRIES 后转 rejected，防无限重试/烧 LLM） */
  retryCount?: number;
  /** 执行过程中产生的 warning 列表 */
  warnings: string[];
  /** 拒绝原因 */
  rejectReason?: string;
  /** 已生成的 skill（执行成功后写入） */
  generatedSkill?: {
    name: string;
    handlerCode: string;
    explanation?: string;
  };
  /** LLM 深度评估结果（self_upgrade 提案专用，执行方回填） */
  llmAssessment?: EvolutionLlmAssessment;
  /** 沙箱测试报告（self_upgrade 提案执行后写入，供查询） */
  sandboxReport?: SandboxTestReport;
  /**
   * skill_distill 提案的任务轨迹快照（即时反思触发器写入）。
   * executeSkillDistill 从此字段读取上下文喂给 SkillGenerator.generateProceduralSkill。
   */
  distillContext?: ProceduralSkillGenerationRequest;
}

/** 持久化文件结构 */
interface PersistEnvelope {
  version: 1;
  proposals: EvolutionProposal[];
  meta: Record<string, ProposalMeta>;
}

/** 终态：不再允许状态流转 */
const TERMINAL_STATUS: ReadonlySet<EvolutionProposalStatus> = new Set([
  "rejected",
  "loaded",
]);

/** 阈值默认值 */
const DEFAULT_GAP_TOOL_FAILURE_THRESHOLD = 3;
const DEFAULT_GAP_RECENT_RECORDS = 50;

/**
 * 长期学习信号阈值：n-gram 关键词反复检测不作为即时救火工具，
 * 而是作为长期模式信号——需要跨会话、跨时间跨度的持续观察才触发进化提案。
 */
const LONG_TERM_PATTERN_THRESHOLD = 5;       // 关键词至少出现 5 次（非 3 次）
const LONG_TERM_PATTERN_MIN_SESSIONS = 2;    // 至少跨 2 个不同会话
const LONG_TERM_PATTERN_MIN_HOURS = 24;      // 首末出现至少间隔 24 小时

// ---- EvolutionCortex --------------------------------------------------

/**
 * 进化皮层。
 *
 * 状态机（进化闭环）：
 * ```
 * pending → reviewing → approved → generated → awaiting_user_approval → loaded
 *                                              ↘ rejected (用户拒绝，终态)
 *                     ↘ rejected (终态)
 * ```
 *
 * - evolve()            创建提案，状态 = pending
 * - review()            pending → reviewing
 * - approve()           pending | reviewing → approved
 * - reject()            任意非终态 → rejected
 * - execute()           approved → 调用 SkillGenerator 生成 Skill / 执行 self_upgrade、skill_distill 分支
 * - executeProposal()   显式入口：外部（用户 / Agent）按 id 触发单个提案执行
 * - approveByUser()     awaiting_user_approval → 调用 PromotionPipeline.promote 装载 → loaded（终态）
 * - rejectByUser()      awaiting_user_approval → rejected（终态）
 *
 * 设计原则：显式触发 + 用户同意闸门。
 * 进化提案不再由后台 autoLoop 自动识别、自动批准、自动执行；
 * 由外部（用户 / Agent）显式按 id 调用 executeProposal 触发单个提案执行。
 * LLM 生成 Skill 代码后必须等待用户同意才装载（approveByUser）。
 */
export class EvolutionCortex {
  private readonly proposals = new Map<string, EvolutionProposal>();
  private readonly meta = new Map<string, ProposalMeta>();

  private selfLearning: SelfLearningLike | null = null;
  private skillGenerator: SkillGeneratorLike | null = null;
  /** 知识缺口执行器（学知识层）：RAG 召回 + 联网兜底 + 沉淀到记忆 */
  private knowledgeExecutor: KnowledgeGapExecutorLike | null = null;
  /**
   * 自我修复皮层引用（Phase 5：self_upgrade 执行路径）。
   * self_upgrade 提案路由到 CodeRepairCortex 执行依赖升级 patch。
   * 未注册时 executeSelfUpgrade 降级为 generated（保持非终态，等注册后再执行）。
   */
  private codeRepairRef: CodeRepairExecutorLike | null = null;
  /**
   * 知识验证服务（学知识层反馈回路）。
   * 每次工具交互都通知它，触发验证状态机演进：
   *  - 用户不再追问同类 → pending_verification 升级为 verified
   *  - 用户明确确认 → verified_strong
   *  - 用户继续追问同类 → disputed → rejected
   */
  private knowledgeVerification: KnowledgeVerificationLike | null = null;
  private promotionPipeline: PromotionPipelineLike | null = null;
  private evolutionLoop: EvolutionLoopLike | null = null;
  /** WS 推送器：向用户推送审批请求 / 审批结果 */
  private approvalEmitter: ApprovalEmitterLike | null = null;
  /**
   * procedural 技能沉淀外观（SkillManager 外观）。
   * skill_distill 提案执行成功后调用 registerProceduralSkill 把 SKILL.md 落盘 + 注册。
   * 未注册时降级为 generated（保持非终态，等注册后再执行）。
   */
  private proceduralSink: ProceduralSkillSinkLike | null = null;

  /**
   * 即时反思触发器去重缓存：sessionId → 最近一次触发时间戳。
   * 防止同一会话短时间内重复创建 skill_distill 提案（防递归 + 防洪）。
   * TTL = 60s，过期自动失效。
   */
  private readonly distillDedup = new Map<string, number>();
  private static readonly DISTILL_DEDUP_TTL_MS = 60_000;
  /** 触发 skill_distill 的最小工具调用次数（≥5 次非平凡流程标准） */
  private static readonly DISTILL_MIN_TOOL_CALLS = 5;

  private readonly persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts?: { persistPath?: string }) {
    this.persistPath =
      opts?.persistPath ??
      process.env.BRAIN_EVOLUTION_PERSIST_PATH?.trim() ??
      join(process.cwd(), "data", "brain-evolution-proposals.json");
  }

  // ---- 子系统注册 ------------------------------------------------------

  registerSelfLearning(svc: SelfLearningLike): void {
    this.selfLearning = svc;
    console.log("[EvolutionCortex] 已注册 AgentSelfLearningService");
  }

  registerSkillGenerator(svc: SkillGeneratorLike): void {
    this.skillGenerator = svc;
    console.log("[EvolutionCortex] 已注册 SkillGenerator");
  }

  /** 注册知识缺口执行器（学知识层入口） */
  registerKnowledgeExecutor(svc: KnowledgeGapExecutorLike): void {
    this.knowledgeExecutor = svc;
    console.log("[EvolutionCortex] 已注册 KnowledgeGapExecutor（RAG+联网+记忆沉淀）");
  }

  /**
   * 注册自我修复执行器（Phase 5：self_upgrade 执行路径）。
   *
   * 注册后 EvolutionCortex 对 self_upgrade 提案路由到 CodeRepairCortex 执行依赖升级。
   * 未注册时 executeSelfUpgrade 降级为 generated（保持非终态，等注册后再执行）。
   */
  registerCodeRepairExecutor(svc: CodeRepairExecutorLike): void {
    this.codeRepairRef = svc;
    console.log("[EvolutionCortex] 已注册 CodeRepairExecutor（self_upgrade 执行路径）");
  }

  /** 注册知识验证服务（反馈回路入口） */
  registerKnowledgeVerification(svc: KnowledgeVerificationLike): void {
    this.knowledgeVerification = svc;
    console.log("[EvolutionCortex] 已注册 KnowledgeVerificationService（反馈回路）");
  }

  registerPromotionPipeline(svc: PromotionPipelineLike): void {
    this.promotionPipeline = svc;
    console.log("[EvolutionCortex] 已注册 SkillPromotionPipeline");
  }

  /**
   * 注册 procedural 技能沉淀外观（SkillManager）。
   *
   * skill_distill 提案执行成功后调用它把 SKILL.md 写入磁盘 + 注册到内存索引。
   * 未注册时 executeSkillDistill 降级为 generated（保持非终态，等注册后再执行）。
   */
  registerProceduralSink(svc: ProceduralSkillSinkLike): void {
    this.proceduralSink = svc;
    console.log("[EvolutionCortex] 已注册 ProceduralSkillSink（经验沉淀落地）");
  }

  registerEvolutionLoop(svc: EvolutionLoopLike): void {
    // 进化循环是独立循环，cortex 仅持有引用以便统一观察，不直接驱动。
    this.evolutionLoop = svc;
    console.log("[EvolutionCortex] 已注册进化循环服务（仅观察）");
  }

  /** 注册 WS 审批推送器：自主进化闭环的关键依赖 */
  registerApprovalEmitter(emitter: ApprovalEmitterLike): void {
    this.approvalEmitter = emitter;
    console.log("[EvolutionCortex] 已注册 ApprovalEmitter");
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[EvolutionCortex] 已启动，跳过重复 start");
      return;
    }
    await this.load();
    this.sweepLegacyProposals();
    this.started = true;
    console.log("[EvolutionCortex] 启动完成（显式触发模式，无后台自动进化 loop）");
  }

  /**
   * 启动时清理历史遗留的非终态堆积提案（修复"approved 越堆越多 + 后台反复空转"问题）。
   *
   * 背景：早期版本（无失败封顶、无断生成）会让大量提案卡在 pending/reviewing/approved/generated
   * 状态并随时间累积；启动时统一收口——仍待处理的 reset 其失败计数，长时间无进展的堆积直接转
   * rejected（终态），从而一次重启即可清空历史债，且不阻塞新提案的正常涌现。
   */
  private sweepLegacyProposals(): void {
    const now = Date.now();
    let swept = 0;
    let reset = 0;
    for (const [id, proposal] of this.proposals) {
      const isTerminal = TERMINAL_STATUS.has(proposal.status);
      const ageMs =
        now - (proposal.createdAt ? Date.parse(proposal.createdAt) : Number.NaN);
      const stale = Number.isNaN(ageMs) ? true : ageMs > 60 * 60 * 1000; // >1h 视为堆积
      if (isTerminal) continue;
      if (stale) {
        const meta = this.ensureMeta(id);
        meta.retryCount = 0;
        meta.rejectReason = "历史遗留堆积清理（启动时收口超出 1h 未解决的非终态提案）";
        const next = this.transition(id, [proposal.status], "rejected");
        this.proposals.set(id, next ?? proposal);
        swept++;
      } else {
        // 新建的提案保留，但重置失败计数，给一次干净的重试机会
        const meta = this.ensureMeta(id);
        meta.retryCount = 0;
        reset++;
      }
    }
    if (swept || reset) {
      this.schedulePersist();
      console.log(
        `[EvolutionCortex] 启动清理：堆积收口 ${swept} 条 → rejected，重置 ${reset} 条待处理`,
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[EvolutionCortex] 未启动，跳过 stop");
      return;
    }
    await this.flush();
    this.started = false;
    console.log("[EvolutionCortex] 已停止");
  }

  /** 推送审批请求给用户（WS） */
  private emitUserApprovalRequest(proposal: EvolutionProposal): void {
    if (!this.approvalEmitter) {
      console.log("[EvolutionCortex] approvalEmitter 未注册，无法推送审批请求");
      return;
    }
    const meta = this.meta.get(proposal.id);
    if (!meta?.generatedSkill) return;

    // handlerCode 预览：前 500 字
    const preview = meta.generatedSkill.handlerCode.slice(0, 500);

    // 从 relatedGap 或默认 session 推送（proposal 暂未绑定 sessionId，
    // 实际使用时由 ApprovalEmitter 实现根据场景选择推送目标）
    this.approvalEmitter.emitApprovalRequest("__default__", {
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.description,
      rationale: proposal.rationale,
      generatedSkill: {
        name: meta.generatedSkill.name,
        description: proposal.description,
        parameters: [],
        permissions: [],
        handlerCodePreview: preview,
        explanation: meta.generatedSkill.explanation,
      },
    });
  }

  // ---- 提案创建与查询 --------------------------------------------------

  /** 创建一个进化提案，初始状态为 pending */
  evolve(
    proposal: Omit<EvolutionProposal, "id" | "status" | "createdAt" | "updatedAt">,
  ): EvolutionProposal {
    // 去重检查：若已有同 type + 同 title 的非终态提案（pending/reviewing/approved/generated），
    // 复用之，不重复生成。只有在彻底收口为 rejected/loaded（终态）后才允许重建，
    // 避免同一缺口反复产生重复提案堆积。
    const existing = [...this.proposals.values()].find(
      (p) =>
        p.type === proposal.type &&
        p.title === proposal.title &&
        (p.status === "pending" ||
          p.status === "reviewing" ||
          p.status === "approved" ||
          p.status === "generated"),
    );
    if (existing) {
      console.log(
        `[EvolutionCortex] 复用已存在提案 ${existing.id} type=${proposal.type} title="${proposal.title}"（不重复生成）`,
      );
      return existing;
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const record: EvolutionProposal = {
      ...proposal,
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(id, record);
    this.meta.set(id, { warnings: [] });
    this.schedulePersist();
    console.log(`[EvolutionCortex] 新提案 ${id} type=${proposal.type} title="${proposal.title}"`);
    return record;
  }

  /** 列出所有未到终态的提案（actorId 当前无法过滤，忽略并返回全部） */
  listPending(actorId?: string): EvolutionProposal[] {
    void actorId;
    return [...this.proposals.values()].filter((p) => !TERMINAL_STATUS.has(p.status));
  }

  /** 列出全部提案 */
  listAll(actorId?: string): EvolutionProposal[] {
    void actorId;
    return [...this.proposals.values()];
  }

  /** 按 id 取提案 */
  get(proposalId: string): EvolutionProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  /** 读取提案附加元信息 */
  getMeta(proposalId: string): ProposalMeta | null {
    return this.meta.get(proposalId) ?? null;
  }

  // ---- 状态机：review / approve / reject -------------------------------

  /** pending → reviewing */
  review(proposalId: string): EvolutionProposal | null {
    return this.transition(proposalId, ["pending"], "reviewing");
  }

  /** pending | reviewing → approved */
  approve(proposalId: string): EvolutionProposal | null {
    return this.transition(proposalId, ["pending", "reviewing"], "approved");
  }

  /** 任意非终态 → rejected */
  reject(proposalId: string, reason?: string): EvolutionProposal | null {
    const current = this.proposals.get(proposalId);
    if (!current) return null;
    if (TERMINAL_STATUS.has(current.status)) {
      console.log(`[EvolutionCortex] reject: 提案 ${proposalId} 已是终态 ${current.status}，跳过`);
      return current;
    }
    const next: EvolutionProposal = {
      ...current,
      status: "rejected",
      updatedAt: new Date().toISOString(),
    };
    this.proposals.set(proposalId, next);
    const meta = this.meta.get(proposalId);
    if (meta && reason) meta.rejectReason = reason;
    this.schedulePersist();
    console.log(`[EvolutionCortex] 提案 ${proposalId} 已拒绝${reason ? `：${reason}` : ""}`);
    return next;
  }

  // ---- 用户审批闸门 ----------------------------------------------------

  /**
   * 用户同意装载 Skill（HTTP 回调调用）。
   *
   * 流程：
   * 1. awaiting_user_approval → 调 PromotionPipeline.promote 装载到 SkillManager
   * 2. 装载成功 → loaded（终态，Skill 已可用）
   * 3. 装载失败 → 保持 awaiting_user_approval，记录 lastError
   * 4. 推送审批结果 WS 事件给用户
   *
   * @param sessionId 用户会话 ID（用于推送审批结果 WS）
   * @returns 装载结果，loaded=true 表示 Skill 已成功注册可用
   */
  async approveByUser(
    proposalId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; proposal: EvolutionProposal | null; error?: string }> {
    const current = this.proposals.get(proposalId);
    if (!current) {
      return { ok: false, proposal: null, error: "提案不存在" };
    }
    if (current.status !== "awaiting_user_approval") {
      return {
        ok: false,
        proposal: current,
        error: `提案状态 ${current.status} 非 awaiting_user_approval，无法审批`,
      };
    }

    const meta = this.ensureMeta(proposalId);
    if (!meta.generatedSkill) {
      const err = "提案无 generatedSkill 数据，无法装载";
      meta.lastError = err;
      return { ok: false, proposal: current, error: err };
    }

    // 调用 PromotionPipeline.promote 装载
    if (!this.promotionPipeline || typeof this.promotionPipeline.promote !== "function") {
      const err = "PromotionPipeline 未注册或未提供 promote 方法，无法装载";
      meta.lastError = err;
      this.transition(proposalId, ["awaiting_user_approval"], "generated");
      this.emitApprovalResultSafe(sessionId, proposalId, false, err);
      return { ok: false, proposal: this.proposals.get(proposalId) ?? null, error: err };
    }

    try {
      const result = await this.promotionPipeline.promote({
        metadata: this.buildSkillMetadataFromProposal(current, meta),
        handlerCode: meta.generatedSkill.handlerCode,
      });
      if (result?.ok) {
        const next = this.transition(proposalId, ["awaiting_user_approval"], "loaded");
        this.emitApprovalResultSafe(sessionId, proposalId, true);
        console.log(`[EvolutionCortex] 提案 ${proposalId} 用户已同意，Skill 装载成功`);
        return { ok: true, proposal: next };
      }
      const err = result?.error ?? "PromotionPipeline 装载失败";
      meta.lastError = err;
      this.emitApprovalResultSafe(sessionId, proposalId, false, err);
      return { ok: false, proposal: current, error: err };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      meta.lastError = msg;
      this.emitApprovalResultSafe(sessionId, proposalId, false, msg);
      return { ok: false, proposal: current, error: msg };
    }
  }

  /**
   * 用户拒绝装载 Skill（HTTP 回调调用）。
   * awaiting_user_approval → rejected（终态）
   */
  rejectByUser(
    proposalId: string,
    reason: string | undefined,
    sessionId?: string,
  ): { ok: boolean; proposal: EvolutionProposal | null } {
    const current = this.proposals.get(proposalId);
    if (!current) return { ok: false, proposal: null };
    if (current.status !== "awaiting_user_approval") {
      return { ok: false, proposal: current };
    }
    const next = this.transition(proposalId, ["awaiting_user_approval"], "rejected");
    if (reason) {
      const meta = this.meta.get(proposalId);
      if (meta) meta.rejectReason = reason;
    }
    this.emitApprovalResultSafe(sessionId, proposalId, false, reason ?? "用户拒绝");
    console.log(`[EvolutionCortex] 提案 ${proposalId} 用户已拒绝${reason ? `：${reason}` : ""}`);
    return { ok: true, proposal: next };
  }

  /** 从提案 + meta 构建完整的 SkillMetadata */
  private buildSkillMetadataFromProposal(
    proposal: EvolutionProposal,
    meta: ProposalMeta,
  ): SkillMetadata {
    // SkillValidator 要求 name 符合 'namespace.action' 格式（仅字母+下划线）
    // 如果 generatedSkill.name 已符合格式就用原值，否则用 evolved.{letters from id}
    const rawName = meta.generatedSkill?.name ?? "";
    const isValidName = /^[a-z]+\.[a-z_]+$/i.test(rawName);
    // 从 proposal.id 中提取字母作为 action 名（避免数字导致校验失败）
    const idLetters = (proposal.id.replace(/[^a-zA-Z]/g, "").slice(0, 8).toLowerCase() || "generated");
    const skillName = isValidName ? rawName : `evolved.${idLetters}`;

    return {
      name: skillName,
      version: "1.0.0",
      displayName: proposal.title,
      description: proposal.description,
      parameters: [],
      permissions: [],
      timeoutMs: 10000,
      maxRetries: 0,
      tags: ["self-evolved", proposal.type],
      kind: "community",
      createdAt: proposal.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 安全推送审批结果（emitter 未注册时静默跳过） */
  private emitApprovalResultSafe(
    sessionId: string | undefined,
    proposalId: string,
    approved: boolean,
    reason?: string,
  ): void {
    if (!this.approvalEmitter || !sessionId) return;
    try {
      this.approvalEmitter.emitApprovalResult(sessionId, { proposalId, approved, reason });
    } catch {
      // 静默失败
    }
  }

  // ---- 状态机：execute -------------------------------------------------

  /**
   * approved → 调用 SkillGenerator 生成 + SkillPromotionPipeline 装载。
   *
   * - SkillGenerator 未注册 / 不可用 → 状态 generated，warning
   * - 生成抛异常或返回 !ok → 状态保持 approved，记录 lastError
   * - PromotionPipeline 未注册 / 不可用 → 状态 generated，warning
   * - 装载抛异常 → 状态保持 approved，记录 lastError
   * - 装载返回 !ok → 状态 generated，记录 lastError
   * - 装载成功 → 状态 loaded
   */
  async execute(proposalId: string): Promise<EvolutionProposal | null> {
    const current = this.proposals.get(proposalId);
    if (!current) return null;
    if (current.status !== "approved") {
      console.log(
        `[EvolutionCortex] execute: 提案 ${proposalId} 状态为 ${current.status}，仅 approved 可执行`,
      );
      return current;
    }

    const meta = this.ensureMeta(proposalId);

    // === 知识层分支：knowledge_gap 走 RAG + 联网兜底 + 记忆沉淀 ===
    // 设计差异（与技能层对比）：
    //  - 不调 SkillGenerator（不生成 handler 代码）
    //  - 不进 awaiting_user_approval（知识不是危险操作，不需要用户审批）
    //  - 执行成功直接 → loaded（终态）
    //  - 执行失败保持 approved + lastError，等待外部显式再次触发
    if (current.type === "knowledge_gap") {
      return this.executeKnowledgeGap(current);
    }

    // === Phase 5：自我改写分支：self_upgrade 走沙箱测试先行升级 ===
    // 执行路径：委托 CodeRepairExecutor 做沙箱测试先行（备份 → 安装新版本 → tsc + test → 通过才应用），
    //           失败自动回滚，保持 approved + lastError。
    // 安全约束：npm 包白名单 + 失败必回滚。
    if (current.type === "self_upgrade") {
      return this.executeSelfUpgrade(current, meta.llmAssessment);
    }

    // === 经验沉淀分支：skill_distill 走 procedural 技能生成 + 落盘 ===
    // 触发条件：复杂任务成功后（≥5 次工具调用）即时反思触发器创建提案。
    // 执行路径：SkillGenerator.generateProceduralSkill → ProceduralSink.registerProceduralSkill
    //           把任务轨迹提炼成 SKILL.md 并写入磁盘 + 注册到内存索引。
    // 安全约束：procedural 技能只有文档（无 handler 代码），不需要用户审批，沉淀即可用。
    if (current.type === "skill_distill") {
      return this.executeSkillDistill(current, meta);
    }

    // --- 阶段 1：生成 ---
    let generatedSkill: { metadata: SkillMetadata; handlerCode: string; explanation?: string } | null = null;

    if (!this.skillGenerator) {
      const warning = "SkillGenerator 未注册，无法生成代码";
      meta.warnings.push(warning);
      console.log(`[EvolutionCortex] execute ${proposalId}: ${warning}`);
    } else {
      const request = this.buildSkillGenerationRequest(current);
      try {
        const result: SkillGenerationResult = await this.skillGenerator.generateSkill(request);
        if (!result.ok || !result.skill) {
          const err = result.error ?? "SkillGenerator 返回失败但未提供错误信息";
          console.log(`[EvolutionCortex] execute ${proposalId} 生成失败：${err}`);
          return this.recordRetryFailure(proposalId, current, err);
        }
        generatedSkill = result.skill;
      } catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        console.log(`[EvolutionCortex] execute ${proposalId} 生成异常：${errText}`);
        return this.recordRetryFailure(proposalId, current, errText);
      }
    }

    // 生成阶段完成：若没有产出 skill，直接进入 generated（带 warning）并返回
    if (!generatedSkill) {
      meta.generatedSkill = undefined;
      const next = this.setStatus(current, "generated");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      return next;
    }

    // 记录生成的 skill 元信息
    meta.generatedSkill = {
      name: generatedSkill.metadata.name,
      handlerCode: generatedSkill.handlerCode,
      explanation: generatedSkill.explanation,
    };

    // --- 阶段 2：直接装载（不再等用户审批） ---
    // 设计原则（用户明确要求）：自我学习是 Agent 自己的事，不需要用户确认。
    //  - 学经验：已无需用户介入（AgentSelfLearningService 自动沉淀失败轨迹）
    //  - 学技能：LLM 生成 handler 代码后直接 promote 装载
    //  - 学知识：联网沉淀 + 验证状态机，无需用户介入
    //
    // 安全保障：
    //  - LimbicCortex 在工具调用层做 DENY_PATTERNS 拦截（rm -rf / 系统文件 / 注入等）
    //  - PromotionPipeline.promote 内部做代码安全校验
    //  - 全程日志可审计
    if (this.promotionPipeline?.promote) {
      try {
        const promoteResult = await this.promotionPipeline.promote({
          metadata: generatedSkill.metadata,
          handlerCode: generatedSkill.handlerCode,
        });
        if (promoteResult.ok) {
          const next = this.setStatus(current, "loaded");
          this.proposals.set(proposalId, next);
          this.schedulePersist();
          console.log(
            `[EvolutionCortex] 提案 ${proposalId} 已生成并装载 Skill=${generatedSkill.metadata.name}（自主完成，无需用户审批）`,
          );
          return next;
        } else {
          // 装载失败：带失败计数重试，超限自动收口为 rejected
          const err = promoteResult.error ?? "PromotionPipeline.promote 返回失败";
          return this.recordRetryFailure(proposalId, current, err);
        }
      } catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        console.log(`[EvolutionCortex] 提案 ${proposalId} promote 异常：${errText}`);
        return this.recordRetryFailure(proposalId, current, errText);
      }
    }

    // PromotionPipeline 未注册：仅标记 generated（保留向后兼容）
    const next = this.setStatus(current, "generated");
    this.proposals.set(proposalId, next);
    this.schedulePersist();
    console.log(
      `[EvolutionCortex] 提案 ${proposalId} 已生成 Skill=${generatedSkill.metadata.name}（PromotionPipeline 未注册，仅标记 generated）`,
    );
    return next;
  }

  /**
   * 显式执行入口：由外部（用户 / Agent）按 id 显式触发单个提案执行。
   *
   * 内部委托 execute(proposalId) 走已有状态机（approved → 生成/装载，
   * 含 self_upgrade / skill_distill / knowledge_gap 分支）。
   * 不再由后台 autoLoop 自动驱动；同一提案重复调用会被状态机拒绝。
   *
   * @param proposalId 提案 id
   * @returns ok=false 当：提案不存在，或已是终态（loaded / rejected），或未处于 approved 状态。
   */
  async executeProposal(proposalId: string): Promise<{
    ok: boolean;
    proposal: EvolutionProposal | null;
    error?: string;
  }> {
    const current = this.proposals.get(proposalId);
    if (!current) {
      return { ok: false, proposal: null, error: `提案 ${proposalId} 不存在` };
    }
    if (TERMINAL_STATUS.has(current.status)) {
      return {
        ok: false,
        proposal: current,
        error: `提案 ${proposalId} 已是终态（status=${current.status}），无法再次执行`,
      };
    }
    if (current.status !== "approved") {
      return {
        ok: false,
        proposal: current,
        error: `提案 ${proposalId} 状态为 ${current.status}，仅 approved 状态可执行`,
      };
    }
    const executed = await this.execute(proposalId);
    if (!executed) {
      return {
        ok: false,
        proposal: null,
        error: `提案 ${proposalId} 执行失败（状态机未返回执行结果）`,
      };
    }
    return { ok: true, proposal: executed };
  }

  /**
   * 知识层执行器：knowledge_gap 提案的专属执行路径。
   *
   * 与技能层 execute() 完全分离：
   *  - 不调 SkillGenerator（不生成 handler 代码）
   *  - 不进 awaiting_user_approval（知识不是危险操作）
   *  - 成功 → loaded（终态）；失败保持 approved + lastError
   *
   * 委托 KnowledgeGapExecutor 完成三件事：
   *  1. RAG 召回本地知识库（NarrativeMemoryPort.buildNarrativeRecall）
   *  2. 召回不足 → 联网兜底（desktop.http_get）
   *  3. 把查询结果沉淀到记忆层（NarrativeMemoryPort.ingest + memory_facts KV）
   *
   * 从 proposal.title 中提取主题词作为 query：
   *  - 标题格式："补充「${keyword}」相关知识"
   *  - 提取「」之间的内容作为查询关键词
   */
  private async executeKnowledgeGap(
    current: EvolutionProposal,
  ): Promise<EvolutionProposal | null> {
    const proposalId = current.id;
    const meta = this.ensureMeta(proposalId);

    if (!this.knowledgeExecutor) {
      meta.warnings.push("KnowledgeGapExecutor 未注册，无法执行知识层闭环");
      console.log(
        `[EvolutionCortex] executeKnowledgeGap ${proposalId}: KnowledgeGapExecutor 未注册`,
      );
      // 状态降级为 generated（保持非终态，等注册后再执行）
      const next = this.setStatus(current, "generated");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      return next;
    }

    // 从 title 提取主题词：标题格式 "补充「${keyword}」相关知识"
    const keywordMatch = current.title.match(/[「」]/);
    const keyword = keywordMatch
      ? current.title.replace(/.*[「]/, "").replace(/[」].*/, "").trim()
      : current.title;
    const query = keyword || current.title;

    try {
      console.log(
        `[EvolutionCortex] executeKnowledgeGap ${proposalId}: 启动 RAG+联网兜底，query="${query}"`,
      );
      const result = await this.knowledgeExecutor.executeKnowledgeGap({
        actorId: "__knowledge_gap__", // 知识缺口跨 actor 共享，使用固定 actorId
        query,
        rationale: current.rationale,
      });

      if (!result.ok) {
        const err = result.error ?? "KnowledgeGapExecutor 返回失败但未提供错误信息";
        console.log(`[EvolutionCortex] executeKnowledgeGap ${proposalId} 失败：${err}`);
        return this.recordRetryFailure(proposalId, current, err);
      }

      // 知识沉淀成功 → 标记 loaded（终态）
      meta.generatedSkill = result.knowledge
        ? {
            name: `knowledge:${query}`,
            handlerCode: result.knowledge,
            explanation: result.source
              ? `来源: ${result.source}${result.ragHit ? "（RAG 命中）" : "（联网兜底）"}`
              : undefined,
          }
        : undefined;
      const next = this.setStatus(current, "loaded");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      console.log(
        `[EvolutionCortex] 知识提案 ${proposalId} 已沉淀主题="${query}"，` +
          `来源=${result.ragHit ? "RAG" : "联网"}，状态=loaded`,
      );
      return next;
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      console.log(`[EvolutionCortex] executeKnowledgeGap ${proposalId} 异常：${errText}`);
      return this.recordRetryFailure(proposalId, current, errText);
    }
  }

  /**
   * Phase 5：自我改写执行（self_upgrade 提案）。
   *
   * 路由到升级执行器，执行沙箱测试先行的升级流程：
   * 1. 备份 package.json + package-lock.json
   * 2. 安装新版本
   * 3. 运行 tsc --noEmit + 相关测试
   * 4. 全部通过才保留（loaded）；任一失败回滚 + 记录错误
   *
   * 安全约束：
   *  - npm 包白名单（执行器内部拦截）
   *  - 失败必回滚（rollback 是 finally 级别保证）
   *  - 执行失败保持 approved + lastError，等待外部显式再次触发
   *
   * @param llmAssessment LLM 深度评估结果（可选）
   */
  private async executeSelfUpgrade(
    current: EvolutionProposal,
    llmAssessment?: EvolutionLlmAssessment,
  ): Promise<EvolutionProposal | null> {
    const proposalId = current.id;
    const meta = this.ensureMeta(proposalId);

    if (!this.codeRepairRef?.executeUpgrade) {
      const err = "CodeRepairExecutor 未注册，无法执行自我升级（收口为 rejected，避免无限 generated 乒乓）";
      meta.warnings.push(err);
      meta.rejectReason = err;
      console.log(`[EvolutionCortex] executeSelfUpgrade ${proposalId}: ${err}`);
      const next = this.transition(proposalId, [current.status], "rejected");
      this.schedulePersist();
      return next ?? current;
    }

    try {
      console.log(
        `[EvolutionCortex] executeSelfUpgrade ${proposalId}: 启动沙箱测试先行升级，target="${current.title}"`,
      );
      const result = await this.codeRepairRef.executeUpgrade({
        target: current.title,
        rationale: current.rationale,
        suggestedAction: current.description,
        llmAssessment,
      });

      if (!result.ok) {
        if (result.sandboxReport) {
          // 保存完整沙箱报告，供 self_evolution 工具查询（审计记录）
          meta.sandboxReport = result.sandboxReport;
          meta.warnings.push(
            `tscPassed=${result.sandboxReport.tscPassed}, ` +
            `testsPassed=${result.sandboxReport.testsPassed}, ` +
            `rolledBack=${result.sandboxReport.rolledBack}`,
          );
        }
        const err = result.error ?? "升级沙箱测试失败";
        console.log(`[EvolutionCortex] executeSelfUpgrade ${proposalId} 沙箱测试失败：${err}`);
        return this.recordRetryFailure(proposalId, current, err);
      }

      // 升级沙箱测试通过 → 标记 loaded（终态）
      const report = result.sandboxReport;
      if (report) {
        // 保存完整沙箱报告，供 self_evolution 工具查询
        meta.sandboxReport = report;
      }
      meta.generatedSkill = {
        name: `self_upgrade:${current.title}`,
        handlerCode: "",
        explanation: report
          ? `沙箱测试通过：tsc=${report.tscPassed}, tests=${report.testsPassed}, ` +
            `testFiles=[${report.testFilesRun.join(", ")}], ` +
            `总耗时=${(report.totalMs / 1000).toFixed(1)}s`
          : `依赖升级已应用：${current.title}`,
      };
      const next = this.setStatus(current, "loaded");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      console.log(
        `[EvolutionCortex] 自我升级提案 ${proposalId} 沙箱测试通过并已应用，` +
        `target="${current.title}"，状态=loaded`,
      );
      return next;
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      console.log(`[EvolutionCortex] executeSelfUpgrade ${proposalId} 异常：${errText}`);
      return this.recordRetryFailure(proposalId, current, errText);
    }
  }

  /**
   * 经验沉淀执行（skill_distill 提案）。
   *
   * 借鉴外部智能体的经验沉淀思路：把已完成的复杂任务轨迹交给 SkillGenerator 提炼成
   * procedural 技能文档（SKILL.md），通过 ProceduralSink 落盘 + 注册。
   *
   * 与 code 技能执行路径完全分离：
   *  - 不调 SkillGenerator.generateSkill（不生成 handler 代码）
   *  - 不进 awaiting_user_approval（procedural 技能不是危险操作，沉淀即可用）
   *  - 成功 → loaded（终态）；失败保持 approved + lastError
   *
   * 任务轨迹从 meta.distillContext 读取（由即时反思触发器写入）。
   * 若 distillContext 缺失（如外部 ingest 的提案），从 proposal.title/description 兜底构造。
   */
  private async executeSkillDistill(
    current: EvolutionProposal,
    meta: ProposalMeta,
  ): Promise<EvolutionProposal | null> {
    const proposalId = current.id;

    if (!this.skillGenerator?.generateProceduralSkill) {
      meta.warnings.push("SkillGenerator 未实现 generateProceduralSkill，无法沉淀经验");
      console.log(
        `[EvolutionCortex] executeSkillDistill ${proposalId}: SkillGenerator 未实现 procedural 生成`,
      );
      const next = this.setStatus(current, "generated");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      return next;
    }

    if (!this.proceduralSink) {
      meta.warnings.push("ProceduralSink 未注册，无法落盘 procedural 技能");
      console.log(
        `[EvolutionCortex] executeSkillDistill ${proposalId}: ProceduralSink 未注册`,
      );
      const next = this.setStatus(current, "generated");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      return next;
    }

    // 构造任务轨迹上下文：优先用 distillContext，缺失时从 proposal 兜底
    const ctx: ProceduralSkillGenerationRequest =
      meta.distillContext ?? {
        userRequest: current.title,
        toolCallCount: 0,
        toolCallsSummary: current.description,
        assistantReply: current.rationale,
      };

    try {
      console.log(
        `[EvolutionCortex] executeSkillDistill ${proposalId}: 启动经验沉淀，toolCalls=${ctx.toolCallCount}`,
      );
      const result = await this.skillGenerator.generateProceduralSkill(ctx);

      if (!result.ok || !result.skill) {
        // LLM 判定不值得沉淀（shouldSave=false）也走这里：直接 reject，不重试
        const isNotWorth = result.error?.includes("shouldSave=false");
        if (isNotWorth) {
          const next = this.setStatus(current, "rejected");
          this.proposals.set(proposalId, next);
          this.schedulePersist();
          console.log(
            `[EvolutionCortex] executeSkillDistill ${proposalId} LLM 判定不值得沉淀，已 reject`,
          );
          return next;
        }
        meta.lastError = result.error ?? "SkillGenerator.generateProceduralSkill 返回失败";
        return this.recordRetryFailure(proposalId, current, meta.lastError);
      }

      // LLM 生成了 SKILL.md，调用 ProceduralSink 落盘 + 注册
      const skill = result.skill;
      const skillMeta: SkillMetadata = {
        name: skill.name,
        version: "1.0.0",
        displayName: skill.name,
        description: skill.description,
        parameters: [],
        permissions: [],
        tags: skill.tags.length > 0 ? skill.tags : ["distilled"],
        skillType: "procedural",
        kind: "community",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sinkResult = this.proceduralSink.registerProceduralSkill(skillMeta, skill.doc);
      if (!sinkResult.ok) {
        return this.recordRetryFailure(
          proposalId,
          current,
          sinkResult.error ?? "ProceduralSink.registerProceduralSkill 失败",
        );
      }

      meta.generatedSkill = {
        name: skill.name,
        handlerCode: skill.doc, // procedural 技能没有 handler 代码，doc 暂存于此
        explanation: `procedural 技能已沉淀：${skill.description}（${sinkResult.docPath ?? "无磁盘路径"}）`,
      };
      const next = this.setStatus(current, "loaded");
      this.proposals.set(proposalId, next);
      this.schedulePersist();
      console.log(
        `[EvolutionCortex] 经验沉淀提案 ${proposalId} 已生成 procedural 技能 ` +
        `${skill.name}（${skill.description}），状态=loaded`,
      );
      return next;
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      console.log(`[EvolutionCortex] executeSkillDistill ${proposalId} 异常：${errText}`);
      return this.recordRetryFailure(proposalId, current, errText);
    }
  }

  // ---- 能力缺口 --------------------------------------------------------

  /** 汇总当前所有未解决（非终态）提案关联的能力缺口 */
  gapReport(): CapabilityGapReport[] {
    const out: CapabilityGapReport[] = [];
    for (const p of this.proposals.values()) {
      if (TERMINAL_STATUS.has(p.status)) continue;
      if (p.relatedGap) out.push(p.relatedGap);
    }
    return out;
  }

  /**
   * 从 AgentSelfLearningService 的失败轨迹中按规则归纳出一个进化提案。
   *
   * **纯规则，不调用 LLM。** 优先调用 getRecentRecords()；若不可用，
   * 尝试读取 recentRecords 字段（私有但运行时可访问）；若均不可用则返回 null。
   *
   * 三类仿人自我学习缺口（按优先级短路识别，命中即返回）：
   *
   * 1. **技能层-优化工具**（学技能）：某工具反复失败（>=3 次）→ optimize_existing
   *    语义：工具有 bug 或参数设计不合理，需要修代码
   *
   * 2. **技能层-补能力**（学技能）：多次失败且 attemptedTools 为空 + 关键词反复 → new_capability
   *    语义：根本没有对应工具，需要造新工具
   *
   * 3. **知识层-补知识**（学知识）：工具调用成功（success=true）+ 用户请求关键词反复（>=3 次同类主题）→ knowledge_gap
   *    语义：工具齐全且工作正常，但用户还在反复问同一类问题
   *         → 说明上次回答没解决需求，根因是缺背景知识（不是缺工具）
   *    识别特征：attemptedTools 非空 + success=true + 用户请求反复出现同一主题词
   *
   * 4. 否则返回 null。
   */
  fromSelfLearningGap(): EvolutionProposal | null {
    if (!this.selfLearning) return null;

    const records = this.collectRecentRecords();
    if (records.length === 0) return null;

    const recent = records.slice(-DEFAULT_GAP_RECENT_RECORDS);
    const failures = recent.filter((r) => !r.success);

    // 规则 1：工具失败频次（学技能-优化）
    const toolFailCounts = new Map<string, number>();
    for (const f of failures) {
      if (!f.attemptedTools || f.attemptedTools.length === 0) continue;
      for (const tool of f.attemptedTools) {
        toolFailCounts.set(tool, (toolFailCounts.get(tool) ?? 0) + 1);
      }
    }
    const topTool = [...toolFailCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topTool && topTool[1] >= DEFAULT_GAP_TOOL_FAILURE_THRESHOLD) {
      const [toolName, count] = topTool;
      return this.evolve({
        type: "optimize_existing",
        title: `优化工具 ${toolName}`,
        description: `工具 ${toolName} 在最近 ${failures.length} 次失败记录中出现 ${count} 次失败，需要优化其参数校验、错误处理或调用路径。`,
        rationale: `最近 ${recent.length} 条学习记录中存在 ${failures.length} 条失败，其中工具 ${toolName} 频繁失败（${count} 次），达到进化阈值 ${DEFAULT_GAP_TOOL_FAILURE_THRESHOLD}。`,
      });
    }

    // 规则 2：长期模式——用户跨会话、跨时间反复请求某领域但无工具可用（学技能-补能力）
    // 设计：n-gram 是长期学习信号，不是即时救火工具。
    //   - 不因 3 次近期失败就触发（那是即时救火）
    //   - 需要跨 2+ 会话、跨 24+ 小时、出现 5+ 次的持续模式才触发
    //   - 真实场景：agent 应先通过 tool search 找到 web.search 等通用工具
    //     只有长期反复出现同一领域需求且通用工具无法满足时，才考虑建设专门能力
    const emptyToolFailures = failures.filter(
      (f) => !f.attemptedTools || f.attemptedTools.length === 0,
    );
    if (emptyToolFailures.length >= LONG_TERM_PATTERN_THRESHOLD) {
      const keyword = this.pickRepeatedKeyword(emptyToolFailures.map((f) => f.userRequest));
      if (keyword) {
        // 长期模式校验：跨会话 + 跨时间跨度
        const patternCheck = this.checkLongTermPattern(emptyToolFailures, keyword);
        if (patternCheck.isLongTerm) {
          return this.evolve({
            type: "new_capability",
            title: `补充「${keyword}」相关能力`,
            description: `检测到跨 ${patternCheck.sessionCount} 个会话、跨度 ${patternCheck.hourSpan} 小时的长期模式：用户反复请求「${keyword}」相关内容（${patternCheck.occurrenceCount} 次），且通用工具未能满足。建议新增专门能力。`,
            rationale: `长期学习信号：关键词「${keyword}」在 ${patternCheck.sessionCount} 个会话中出现 ${patternCheck.occurrenceCount} 次，时间跨度 ${patternCheck.hourSpan} 小时（≥${LONG_TERM_PATTERN_MIN_HOURS}h），达到长期模式阈值（≥${LONG_TERM_PATTERN_THRESHOLD} 次 / ≥${LONG_TERM_PATTERN_MIN_SESSIONS} 会话 / ≥${LONG_TERM_PATTERN_MIN_HOURS}h）。`,
          });
        }
      }
    }

    // 规则 3：长期模式——工具调用成功但用户跨会话反复问同类问题（学知识-补知识）
    // 语义：工具齐全 + 调用成功，但用户长期反复问，说明回答没满足需求 → 缺背景知识
    // 设计：同样需要跨会话 + 跨时间跨度的长期模式校验，避免短期集中提问误触发
    const successesWithTools = recent.filter(
      (r) =>
        r.success &&
        r.attemptedTools &&
        r.attemptedTools.length > 0,
    );
    if (successesWithTools.length >= LONG_TERM_PATTERN_THRESHOLD) {
      const keyword = this.pickRepeatedKeyword(successesWithTools.map((r) => r.userRequest));
      if (keyword) {
        // 长期模式校验
        const patternCheck = this.checkLongTermPattern(successesWithTools, keyword);
        if (patternCheck.isLongTerm) {
          // 去重：如果已存在同主题的非终态提案，不再重复创建
          const existingSameTopic = [...this.proposals.values()].find(
            (p) =>
              p.type === "knowledge_gap" &&
              p.title.includes(keyword) &&
              (p.status === "pending" ||
                p.status === "reviewing" ||
                p.status === "approved" ||
                p.status === "generated" ||
                p.status === "awaiting_user_approval"),
          );
          if (existingSameTopic) {
            console.log(
              `[EvolutionCortex] 已存在同主题 knowledge_gap 提案 ${existingSameTopic.id}，跳过重复创建`,
            );
            return null;
          }
          return this.evolve({
            type: "knowledge_gap",
            title: `补充「${keyword}」相关知识`,
            description: `检测到跨 ${patternCheck.sessionCount} 个会话、跨度 ${patternCheck.hourSpan} 小时的长期模式：工具调用成功但用户仍在反复询问「${keyword}」（${patternCheck.occurrenceCount} 次）。将通过 RAG 召回本地知识库，召回不足时联网查询，并把结果沉淀到长期记忆。`,
            rationale: `长期学习信号：关键词「${keyword}」在 ${patternCheck.sessionCount} 个会话中出现 ${patternCheck.occurrenceCount} 次，时间跨度 ${patternCheck.hourSpan} 小时。特征：工具齐全+调用成功+用户长期重复问，判定为知识缺口而非技能缺口。`,
          });
        }
      }
    }

    return null;
  }

  /**
   * 显式查询入口：基于规则产出能力进化提案统计。
   *
   * 包装 fromSelfLearningGap + pending 列表统计，返回调用方期望的简单结构。
   * 不调用 LLM，纯规则。失败时返回 proposals=0。
   */
  proposeEvolution(actorId: string): { proposals: number; reason: string } {
    try {
      const gap = this.fromSelfLearningGap();
      const pendingCount = Array.from(this.proposals.values())
        .filter((p) => p.status === "pending" || p.status === "reviewing").length;
      const total = (gap ? 1 : 0) + pendingCount;
      const reason = gap
        ? `已生成新提案：${gap.title.slice(0, 60)}`
        : pendingCount > 0
          ? `当前已有 ${pendingCount} 条待审提案`
          : "无失败轨迹或重复关键词，未达进化阈值";
      void actorId; // 当前规则不依赖 actorId（数据源是 selfLearning 全局失败记录）
      return { proposals: total, reason };
    } catch (e) {
      return { proposals: 0, reason: `proposeEvolution 失败: ${String(e).slice(0, 80)}` };
    }
  }

  /**
   * 记录一次工具交互（成功或失败）到 AgentSelfLearningService。
   *
   * 这是自我进化闭环的真正入口：AgentCore 在工具调用结束（无论成功失败）时
   * 通过 BrainCenter 转发到此。EvolutionCortex 再委托 selfLearning.recordInteraction
   * 持久化失败轨迹，供后续显式 proposeEvolution 扫描。
   *
   * 设计要点：
   *  - 不阻塞调用方（fire-and-forget，错误静默吞掉）
   *  - 不依赖 LLM，纯数据搬运
   *  - recordInteraction 失败不影响主流程
   */
  async recordToolInteraction(params: {
    sessionId: string;
    userRequest: string;
    attemptedTools: string[];
    success: boolean;
    errorMessage?: string;
    responseTime?: number;
  }): Promise<void> {
    // === 经验沉淀即时反思触发器 ===
    // 借鉴外部智能体的经验沉淀思路：复杂任务（≥5 次成功工具调用）完成后，
    // 把任务轨迹沉淀为 skill_distill 提案，由外部显式 executeProposal 触发生成 procedural 技能。
    // 放在方法最前：不依赖 selfLearning（仅依赖 distillBuffer + evolve），
    // 即使 selfLearning 未注册也能触发沉淀。后台 fork，不阻塞主流程。
    this.maybeTriggerSkillDistill(params);

    if (!this.selfLearning?.recordInteraction) {
      // selfLearning 未注册或未实现 recordInteraction，静默降级
      return;
    }
    try {
      await this.selfLearning.recordInteraction({
        sessionId: params.sessionId,
        userRequest: params.userRequest,
        attemptedTools: params.attemptedTools,
        success: params.success,
        errorMessage: params.errorMessage,
        responseTime: params.responseTime,
      });
    } catch (e) {
      // 学习记录失败不应影响主流程
      console.warn("[EvolutionCortex] recordToolInteraction 失败:", e);
    }

    // === 知识层反馈回路 ===
    // 每次工具交互都通知验证服务，触发已沉淀知识的验证状态机演进
    if (this.knowledgeVerification) {
      try {
        this.knowledgeVerification.observeInteraction({
          userRequest: params.userRequest,
          toolSuccess: params.success,
        });
      } catch (e) {
        console.warn("[EvolutionCortex] knowledgeVerification.observeInteraction 失败:", e);
      }
    }
  }

  // ---- 内部：经验沉淀即时反思触发器 ------------------------------------

  /** 会话级工具调用轨迹聚合缓冲（skill_distill 触发用） */
  private readonly distillBuffer = new Map<
    string,
    { userRequest: string; toolCalls: Array<{ name: string; ok: boolean }>; startedAt: number }
  >();

  /** 触发时排除的技能管理类工具：防止"沉淀技能"自身的工具调用递归触发沉淀 */
  private static readonly DISTILL_EXCLUDED_TOOLS = new Set([
    "skill.list",
    "skill.view",
    "skill.manage",
    "skill.generate",
    "skill.promote",
    "skill.self_upgrade",
    "self.create_skill",
    "self.evolution",
  ]);

  /** 聚合缓冲条目存活时长：超过 10 分钟未更新视为任务已结束，丢弃 */
  private static readonly DISTILL_BUFFER_TTL_MS = 10 * 60 * 1000;

  /**
   * 即时反思触发器（纯规则，不调 LLM）。
   *
   * 在每次 recordToolInteraction（逐工具调用）时聚合同一会话 + 同一
   * userRequest 的工具轨迹，当成功工具调用数达到阈值（≥5）时创建
   * skill_distill 提案，并把任务轨迹快照写入 meta.distillContext，
   * 供 executeSkillDistill 提炼 SKILL.md。
   *
   * 防递归设计（防止"沉淀技能"这个动作本身再次触发沉淀）：
   *  1. 排除 skill.* 管理类工具（DISTILL_EXCLUDED_TOOLS），它们的调用不计入轨迹
   *  2. 同一会话 60s 内去重（distillDedup TTL），避免执行期间重复触发
   *  3. 触发成功后清空聚合缓冲（一次任务沉淀一次）
   *  4. 提案去重：evolve() 对同 type + 同 title 的 pending/reviewing 提案自动复用
   */
  private maybeTriggerSkillDistill(params: {
    sessionId: string;
    userRequest: string;
    attemptedTools: string[];
    success: boolean;
  }): void {
    const { sessionId, userRequest } = params;
    if (!sessionId || !userRequest) return;

    // 排除技能管理类工具（防递归）
    const tools = params.attemptedTools.filter(
      (t) => !EvolutionCortex.DISTILL_EXCLUDED_TOOLS.has(t),
    );
    if (tools.length === 0) return;

    // 聚合到会话缓冲；userRequest 变化视为新任务，重置缓冲
    const now = Date.now();
    let entry = this.distillBuffer.get(sessionId);
    if (!entry || entry.userRequest !== userRequest) {
      entry = { userRequest, toolCalls: [], startedAt: now };
      this.distillBuffer.set(sessionId, entry);
    }
    for (const name of tools) {
      entry.toolCalls.push({ name, ok: params.success });
    }

    // 顺带清理过期缓冲条目（避免 Map 无限增长）
    for (const [sid, e] of this.distillBuffer) {
      if (now - e.startedAt > EvolutionCortex.DISTILL_BUFFER_TTL_MS) {
        this.distillBuffer.delete(sid);
      }
    }

    // 未达阈值：继续聚合
    const successCount = entry.toolCalls.filter((c) => c.ok).length;
    if (successCount < EvolutionCortex.DISTILL_MIN_TOOL_CALLS) return;

    // 会话级去重：60s 内不重复触发（防执行期间二次触发）
    const last = this.distillDedup.get(sessionId);
    if (last && now - last < EvolutionCortex.DISTILL_DEDUP_TTL_MS) {
      return;
    }
    this.distillDedup.set(sessionId, now);
    // 顺带清理过期去重条目
    for (const [sid, ts] of this.distillDedup) {
      if (now - ts >= EvolutionCortex.DISTILL_DEDUP_TTL_MS) {
        this.distillDedup.delete(sid);
      }
    }

    // 创建 skill_distill 提案，写入任务轨迹快照
    const userRequestBrief = userRequest.replace(/\s+/g, " ").slice(0, 50);
    const toolCallsSummary = entry.toolCalls
      .map((c) => `${c.name}(${c.ok ? "ok" : "fail"})`)
      .join(", ");
    const proposal = this.evolve({
      type: "skill_distill",
      title: `沉淀技能：${userRequestBrief}`,
      description:
        `复杂任务成功完成（${successCount} 次成功工具调用），工具序列：${toolCallsSummary.slice(0, 200)}。` +
        `值得提炼成 procedural 技能文档（SKILL.md），沉淀操作流程与踩坑经验。`,
      rationale:
        `即时反思触发器：会话 ${sessionId} 的请求「${userRequestBrief}」累计 ${successCount} 次成功工具调用` +
        `（≥${EvolutionCortex.DISTILL_MIN_TOOL_CALLS}），判定为可复用的非平凡流程，触发经验沉淀。`,
    });

    if (proposal) {
      const meta = this.ensureMeta(proposal.id);
      meta.distillContext = {
        userRequest,
        toolCallCount: entry.toolCalls.length,
        toolCallsSummary,
        assistantReply: "", // 触发器不持有最终回复；executeSkillDistill 用 proposal.rationale 兜底
      };
      this.schedulePersist();
      console.log(
        `[EvolutionCortex] 即时反思：创建 skill_distill 提案 ${proposal.id}（${successCount} 次成功工具调用）`,
      );
    }

    // 触发成功后清空缓冲：一次任务沉淀一次
    this.distillBuffer.delete(sessionId);
  }

  // ---- 内部：状态流转辅助 ----------------------------------------------

  private transition(
    proposalId: string,
    allowedFrom: EvolutionProposalStatus[],
    target: EvolutionProposalStatus,
  ): EvolutionProposal | null {
    const current = this.proposals.get(proposalId);
    if (!current) return null;
    if (!allowedFrom.includes(current.status)) {
      console.log(
        `[EvolutionCortex] ${target}: 提案 ${proposalId} 状态为 ${current.status}，期望 ${allowedFrom.join("|")}，跳过`,
      );
      return current;
    }
    const next = this.setStatus(current, target);
    this.proposals.set(proposalId, next);
    this.schedulePersist();
    return next;
  }

  private setStatus(
    current: EvolutionProposal,
    status: EvolutionProposalStatus,
  ): EvolutionProposal {
    return { ...current, status, updatedAt: new Date().toISOString() };
  }

  private touch(current: EvolutionProposal): EvolutionProposal {
    return { ...current, updatedAt: new Date().toISOString() };
  }

  private ensureMeta(proposalId: string): ProposalMeta {
    let m = this.meta.get(proposalId);
    if (!m) {
      m = { warnings: [] };
      this.meta.set(proposalId, m);
    }
    return m;
  }

  /** 单提案最大执行失败重试次数，超过则直接转 rejected（终态），防无限重试/烧 LLM */
  private static readonly MAX_EXECUTE_RETRIES = 3;

  /** 递增某提案的连续失败次数 */
  private bumpRetry(proposalId: string): number {
    const m = this.ensureMeta(proposalId);
    m.retryCount = (m.retryCount ?? 0) + 1;
    return m.retryCount;
  }

  /**
   * 统一记录一次执行失败：递增失败计数，若超过 MAX_EXECUTE_RETRIES 则转 rejected（终态），
   * 否则保持原状态 touch。杜绝失败提案无限重试。
   */
  private recordRetryFailure(
    proposalId: string,
    current: EvolutionProposal,
    error: string,
  ): EvolutionProposal {
    const meta = this.ensureMeta(proposalId);
    meta.lastError = error;
    const retry = this.bumpRetry(proposalId);
    console.log(`[EvolutionCortex] 提案 ${proposalId} 执行失败(第${retry}次)：${error}`);
    if (retry >= EvolutionCortex.MAX_EXECUTE_RETRIES) {
      meta.rejectReason = `执行连续失败 ${retry} 次后终止：${error}`;
      const next = this.transition(proposalId, [current.status], "rejected");
      if (next) {
        console.log(
          `[EvolutionCortex] 提案 ${proposalId} 连续失败达 ${EvolutionCortex.MAX_EXECUTE_RETRIES} 次，转 rejected（终态）`,
        );
      }
      return next ?? current;
    }
    const next = this.touch(current);
    this.proposals.set(proposalId, next);
    this.schedulePersist();
    return next;
  }

  // ---- 内部：SkillGenerator 请求构造 ----------------------------------

  private buildSkillGenerationRequest(
    proposal: EvolutionProposal,
  ): SkillGenerationRequest {
    return {
      description: `${proposal.title}。${proposal.description}`,
      useCase: proposal.rationale,
    };
  }

  // ---- 内部：自学习记录收集 --------------------------------------------

  /**
   * 收集最近的学习记录。
   * 优先调用 getRecentRecords()；若不存在，尝试读取私有 recentRecords 字段。
   */
  private collectRecentRecords(): LearningRecord[] {
    const svc = this.selfLearning;
    if (!svc) return [];
    if (typeof svc.getRecentRecords === "function") {
      try {
        const records = svc.getRecentRecords();
        if (Array.isArray(records)) return records;
      } catch (err) {
        console.log(
          "[EvolutionCortex] getRecentRecords 调用失败：",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // 运行时访问私有字段 recentRecords（TypeScript private 仅编译期生效）
    const fallback = (svc as unknown as { recentRecords?: LearningRecord[] }).recentRecords;
    if (Array.isArray(fallback)) return fallback;
    return [];
  }

  /**
   * 长期模式校验：检查含关键词的记录是否跨会话、跨时间跨度。
   *
   * n-gram 是长期学习信号而非即时救火工具：
   *  - 同一会话连续问 4 次"区块链"→ 不是长期模式（可能是临时任务）
   *  - 跨 3 个会话、跨 2 天共 5 次问"区块链"→ 是长期模式（持续需求）
   */
  private checkLongTermPattern(
    records: LearningRecord[],
    keyword: string,
  ): {
    isLongTerm: boolean;
    sessionCount: number;
    hourSpan: number;
    occurrenceCount: number;
  } {
    // 筛出含关键词的记录
    const matched = records.filter((r) =>
      (r.userRequest ?? "").toLowerCase().includes(keyword.toLowerCase()),
    );
    if (matched.length === 0) {
      return { isLongTerm: false, sessionCount: 0, hourSpan: 0, occurrenceCount: 0 };
    }

    // 统计不同会话数
    const sessions = new Set(matched.map((r) => r.sessionId));
    const sessionCount = sessions.size;

    // 计算时间跨度
    const timestamps = matched
      .map((r) => Date.parse(r.timestamp))
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => a - b);
    const hourSpan =
      timestamps.length >= 2
        ? Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 3_600_000)
        : 0;

    const isLongTerm =
      matched.length >= LONG_TERM_PATTERN_THRESHOLD &&
      sessionCount >= LONG_TERM_PATTERN_MIN_SESSIONS &&
      hourSpan >= LONG_TERM_PATTERN_MIN_HOURS;

    return {
      isLongTerm,
      sessionCount,
      hourSpan,
      occurrenceCount: matched.length,
    };
  }

  /**
   * 从一组用户请求中挑出反复出现的关键词，返回第一个达标的词。
   *
   * 混合策略（纯规则，不调 LLM）：
   *  1. 优先匹配预置关键词列表（图片/翻译/计算等已知能力域）
   *  2. 若无匹配，用通用 2-3 字汉字 n-gram 提取反复出现的片段
   *     这样能识别"区块链分析/股票行情/法律咨询"等任意领域关键词
   */
  private pickRepeatedKeyword(requests: string[]): string | null {
    // 步骤 1：预置关键词列表匹配
    const presetKeywords = [
      "图片", "图像", "photo", "image", "视频", "video", "翻译", "translate",
      "计算", "calculate", "数学", "math", "日历", "calendar", "提醒", "remind",
    ];
    const counts = new Map<string, number>();
    for (const req of requests) {
      const lower = (req ?? "").toLowerCase();
      for (const kw of presetKeywords) {
        if (lower.includes(kw.toLowerCase())) {
          counts.set(kw, (counts.get(kw) ?? 0) + 1);
        }
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= DEFAULT_GAP_TOOL_FAILURE_THRESHOLD) return top[0];

    // 步骤 2：通用 n-gram 提取（识别任意 2-3 字汉字片段的反复出现）
    const ngramCounts = new Map<string, number>();
    const stopChars = new Set(["的", "了", "是", "在", "我", "你", "他", "她", "们", "帮", "下", "有", "什么", "怎么", "能否", "可以", "一下"]);
    for (const req of requests) {
      // 去除空格、标点
      const text = (req ?? "").replace(/[\s\u3000\p{P}]/gu, "");
      // 提取 2-3 字汉字片段
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i <= text.length - n; i++) {
          const gram = text.slice(i, i + n);
          // 跳过含停用字或英文/数字的片段
          if (/[a-z0-9]/i.test(gram)) continue;
          let hasStop = false;
          for (const sc of stopChars) {
            if (gram.includes(sc)) { hasStop = true; break; }
          }
          if (hasStop) continue;
          ngramCounts.set(gram, (ngramCounts.get(gram) ?? 0) + 1);
        }
      }
    }
    // 选词策略：先按出现频次降序，再按 n-gram 长度降序（最长匹配优先）
    // 例：4 句"比特币现在什么行情"等请求中
    //     "比特"(2字) 出现 4 次，"比特币"(3字) 也出现 4 次
    //     长度降序保证选"比特币"而非"比特"（更准确的主题词）
    const topNgram = [...ngramCounts.entries()]
      .filter(([_gram, c]) => c >= DEFAULT_GAP_TOOL_FAILURE_THRESHOLD)
      .sort((a, b) => {
        // 主排序：频次降序
        if (b[1] !== a[1]) return b[1] - a[1];
        // 次排序：长度降序（最长匹配优先）
        return b[0].length - a[0].length;
      })[0];
    if (topNgram) {
      return topNgram[0];
    }
    return null;
  }

  // ---- 内部：持久化 ----------------------------------------------------

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistEnvelope;
      if (!parsed || typeof parsed !== "object") return;
      const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
      const meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
      this.proposals.clear();
      this.meta.clear();
      for (const p of proposals) {
        if (p && typeof p === "object" && typeof p.id === "string") {
          this.proposals.set(p.id, p as EvolutionProposal);
          const m = meta[p.id];
          this.meta.set(p.id, m && typeof m === "object" ? this.normalizeMeta(m) : { warnings: [] });
        }
      }
      console.log(`[EvolutionCortex] 已载入 ${this.proposals.size} 条提案`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) {
        console.log("[EvolutionCortex] load 失败：", msg);
      }
    }
  }

  private normalizeMeta(raw: Partial<ProposalMeta>): ProposalMeta {
    return {
      lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
      retryCount: typeof raw.retryCount === "number" ? raw.retryCount : undefined,
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      rejectReason: typeof raw.rejectReason === "string" ? raw.rejectReason : undefined,
      generatedSkill:
        raw.generatedSkill && typeof raw.generatedSkill === "object"
          ? (raw.generatedSkill as ProposalMeta["generatedSkill"])
          : undefined,
      llmAssessment:
        raw.llmAssessment && typeof raw.llmAssessment === "object"
          ? (raw.llmAssessment as ProposalMeta["llmAssessment"])
          : undefined,
      sandboxReport:
        raw.sandboxReport && typeof raw.sandboxReport === "object"
          ? (raw.sandboxReport as ProposalMeta["sandboxReport"])
          : undefined,
      distillContext:
        raw.distillContext && typeof raw.distillContext === "object"
          ? {
              userRequest:
                typeof raw.distillContext.userRequest === "string"
                  ? raw.distillContext.userRequest
                  : "",
              toolCallCount:
                typeof raw.distillContext.toolCallCount === "number"
                  ? raw.distillContext.toolCallCount
                  : 0,
              toolCallsSummary:
                typeof raw.distillContext.toolCallsSummary === "string"
                  ? raw.distillContext.toolCallsSummary
                  : "",
              assistantReply:
                typeof raw.distillContext.assistantReply === "string"
                  ? raw.distillContext.assistantReply
                  : "",
            }
          : undefined,
    };
  }

  /** 立即写盘 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const envelope: PersistEnvelope = {
        version: 1,
        proposals: [...this.proposals.values()],
        meta: Object.fromEntries(this.meta),
      };
      await writeFile(this.persistPath, JSON.stringify(envelope, null, 2), "utf8");
    } catch (err) {
      console.log(
        "[EvolutionCortex] flush 失败：",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** 防抖写盘（1s 内多次变更合并为一次） */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1000);
    this.persistTimer.unref?.();
  }
}
