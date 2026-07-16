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
}

/** 技能生成器外观 */
interface SkillGeneratorLike {
  generateSkill(request: SkillGenerationRequest): Promise<SkillGenerationResult>;
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

/** Hermes 进化循环外观：cortex 仅注册、观察，不直接驱动 */
interface HermesLoopLike {
  // 预留：未来若需查询 Hermes 状态可在此声明
}

// ---- 内部辅助类型 -----------------------------------------------------

/** 提案附加元信息（不进入 EvolutionProposal 公开字段） */
interface ProposalMeta {
  /** 最近一次执行错误 */
  lastError?: string;
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

// ---- EvolutionCortex --------------------------------------------------

/**
 * 进化皮层。
 *
 * 状态机（自主进化闭环）：
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
 * - execute()           approved → 调用 SkillGenerator 生成 Skill → generated
 * - runAutoEvolutionCycle()  自动驱动 loop：pending → reviewing → approved → generated → awaiting_user_approval
 * - approveByUser()     awaiting_user_approval → 调用 PromotionPipeline.promote 装载 → loaded（终态）
 * - rejectByUser()      awaiting_user_approval → rejected（终态）
 *
 * 设计原则：完全自主进化 + 用户同意闸门。
 * 自动 loop 自主完成缺口识别、提案创建、自动审批、Skill 代码生成；
 * LLM 生成 Skill 代码后必须等待用户同意才装载（approveByUser）。
 */
export class EvolutionCortex {
  private readonly proposals = new Map<string, EvolutionProposal>();
  private readonly meta = new Map<string, ProposalMeta>();

  private selfLearning: SelfLearningLike | null = null;
  private skillGenerator: SkillGeneratorLike | null = null;
  private promotionPipeline: PromotionPipelineLike | null = null;
  private hermesLoop: HermesLoopLike | null = null;
  /** WS 推送器：向用户推送审批请求 / 审批结果 */
  private approvalEmitter: ApprovalEmitterLike | null = null;
  /** 自动驱动 loop 定时器 */
  private autoLoopTimer: NodeJS.Timeout | null = null;
  /** 自动 loop 默认间隔（5 分钟） */
  private static readonly AUTO_LOOP_INTERVAL_MS = 5 * 60 * 1000;

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

  registerPromotionPipeline(svc: PromotionPipelineLike): void {
    this.promotionPipeline = svc;
    console.log("[EvolutionCortex] 已注册 SkillPromotionPipeline");
  }

  registerHermesLoop(svc: HermesLoopLike): void {
    // Hermes 是独立循环，cortex 仅持有引用以便统一观察，不直接驱动。
    this.hermesLoop = svc;
    console.log("[EvolutionCortex] 已注册 HermesEvolutionLoopService（仅观察）");
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
    this.started = true;
    this.startAutoEvolutionLoop();
    console.log("[EvolutionCortex] 启动完成（自动进化 loop 已启动）");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[EvolutionCortex] 未启动，跳过 stop");
      return;
    }
    if (this.autoLoopTimer) {
      clearInterval(this.autoLoopTimer);
      this.autoLoopTimer = null;
    }
    await this.flush();
    this.started = false;
    console.log("[EvolutionCortex] 已停止");
  }

  // ---- 自动进化驱动 loop ------------------------------------------------

  /**
   * 启动自动进化循环。每 5 分钟扫描一次：
   * 1. 从 AgentSelfLearningService 失败轨迹识别能力缺口 → 创建 pending 提案
   * 2. pending → reviewing → approved（规则自动批准，非 LLM）
   * 3. approved → execute 生成 Skill → awaiting_user_approval
   * 4. awaiting_user_approval 状态由用户通过 HTTP 回调决定（approveByUser/rejectByUser）
   *
   * 设计原则：完全自主进化 + 用户同意闸门。
   * LLM 生成 Skill 代码后必须等待用户同意才装载。
   */
  private startAutoEvolutionLoop(): void {
    if (this.autoLoopTimer) clearInterval(this.autoLoopTimer);
    this.autoLoopTimer = setInterval(() => {
      void this.runAutoEvolutionCycle().catch((err) => {
        console.error("[EvolutionCortex] autoEvolutionCycle 异常:", err);
      });
    }, EvolutionCortex.AUTO_LOOP_INTERVAL_MS);
    if (typeof this.autoLoopTimer.unref === "function") {
      this.autoLoopTimer.unref();
    }
  }

  /**
   * 单次自动进化循环：
   * 1. 从失败轨迹识别缺口 → 创建 pending 提案
   * 2. 把 pending 提案推进到 approved
   * 3. 把 approved 提案执行到 awaiting_user_approval（生成 Skill 后停下等用户）
   */
  private async runAutoEvolutionCycle(): Promise<void> {
    if (!this.selfLearning) return;

    // 阶段 1：识别缺口 → 创建提案
    const newProposal = this.fromSelfLearningGap();
    if (newProposal) {
      console.log(`[EvolutionCortex] autoLoop 识别到能力缺口，创建提案 ${newProposal.id}`);
    }

    // 阶段 2：推进 pending → reviewing → approved
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "pending") {
        this.review(proposal.id);
      }
      if (proposal.status === "reviewing") {
        // 规则自动批准（非 LLM）：目前所有通过 review 的提案都自动批准
        this.approve(proposal.id);
        console.log(`[EvolutionCortex] autoLoop 自动批准提案 ${proposal.id}`);
      }
    }

    // 阶段 3：执行 approved → 生成 Skill → awaiting_user_approval
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "approved") {
        const executed = await this.execute(proposal.id);
        // execute() 完成后，若 generatedSkill 已生成，转入 awaiting_user_approval
        if (executed) {
          const meta = this.meta.get(proposal.id);
          if (meta?.generatedSkill) {
            this.transition(proposal.id, ["generated"], "awaiting_user_approval");
            this.emitUserApprovalRequest(executed);
            console.log(`[EvolutionCortex] autoLoop 提案 ${proposal.id} 已生成 Skill，等待用户审批`);
          }
        }
      }
    }

    // 阶段 4：处理遗留的 generated 提案 → awaiting_user_approval
    // （execute() 在上一轮已生成 Skill 但尚未转为 awaiting_user_approval 的情况）
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "generated") {
        const meta = this.meta.get(proposal.id);
        if (meta?.generatedSkill) {
          this.transition(proposal.id, ["generated"], "awaiting_user_approval");
          this.emitUserApprovalRequest(proposal);
          console.log(`[EvolutionCortex] autoLoop 遗留 generated 提案 ${proposal.id} 转入等待用户审批`);
        }
      }
    }
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
          meta.lastError = result.error ?? "SkillGenerator 返回失败但未提供错误信息";
          const next = this.touch(current);
          this.proposals.set(proposalId, next);
          this.schedulePersist();
          console.log(`[EvolutionCortex] execute ${proposalId} 生成失败：${meta.lastError}`);
          return next;
        }
        generatedSkill = result.skill;
      } catch (err) {
        meta.lastError = err instanceof Error ? err.message : String(err);
        const next = this.touch(current);
        this.proposals.set(proposalId, next);
        this.schedulePersist();
        console.log(`[EvolutionCortex] execute ${proposalId} 生成异常：${meta.lastError}`);
        return next;
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

    // --- 阶段 2：不立即装载，仅标记 generated ---
    // 设计原则：完全自主进化 + 用户同意闸门。
    // execute() 只负责生成 Skill 代码，不装载。
    // 装载由 approveByUser() 在用户同意后调用 promote 完成。
    const next = this.setStatus(current, "generated");
    this.proposals.set(proposalId, next);
    this.schedulePersist();
    console.log(
      `[EvolutionCortex] 提案 ${proposalId} 已生成 Skill=${generatedSkill.metadata.name}，等待用户审批后装载`,
    );
    return next;
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
   * 规则：
   * 1. 统计最近 N 条失败记录中 attemptedTools 的失败频次；
   *    若某工具失败次数 >= 阈值（默认 3），生成 optimize_existing 提案。
   * 2. 若多失败记录 attemptedTools 为空且 userRequest 关键词反复出现，
   *    生成 new_capability 提案。
   * 3. 否则返回 null。
   */
  fromSelfLearningGap(): EvolutionProposal | null {
    if (!this.selfLearning) return null;

    const records = this.collectRecentRecords();
    if (records.length === 0) return null;

    const recent = records.slice(-DEFAULT_GAP_RECENT_RECORDS);
    const failures = recent.filter((r) => !r.success);

    // 规则 1：工具失败频次
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

    // 规则 2：反复出现的用户请求但无工具可用
    const emptyToolFailures = failures.filter(
      (f) => !f.attemptedTools || f.attemptedTools.length === 0,
    );
    if (emptyToolFailures.length >= DEFAULT_GAP_TOOL_FAILURE_THRESHOLD) {
      const keyword = this.pickRepeatedKeyword(emptyToolFailures.map((f) => f.userRequest));
      if (keyword) {
        return this.evolve({
          type: "new_capability",
          title: `补充「${keyword}」相关能力`,
          description: `检测到最近 ${emptyToolFailures.length} 次失败请求均未触发任何工具，且反复出现「${keyword}」关键词，可能需要新增专门技能。`,
          rationale: `最近 ${recent.length} 条学习记录中有 ${emptyToolFailures.length} 条失败未触发工具调用，且关键词「${keyword}」反复出现，达到进化阈值 ${DEFAULT_GAP_TOOL_FAILURE_THRESHOLD}。`,
        });
      }
    }

    return null;
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

  /** 从一组用户请求中挑出反复出现的关键词，返回第一个达标的词 */
  private pickRepeatedKeyword(requests: string[]): string | null {
    const keywords = ["图片", "图像", "photo", "image", "视频", "video", "翻译", "translate", "计算", "calculate", "数学", "math", "日历", "calendar", "提醒", "remind"];
    const counts = new Map<string, number>();
    for (const req of requests) {
      const lower = (req ?? "").toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          counts.set(kw, (counts.get(kw) ?? 0) + 1);
        }
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= DEFAULT_GAP_TOOL_FAILURE_THRESHOLD) return top[0];
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
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      rejectReason: typeof raw.rejectReason === "string" ? raw.rejectReason : undefined,
      generatedSkill:
        raw.generatedSkill && typeof raw.generatedSkill === "object"
          ? (raw.generatedSkill as ProposalMeta["generatedSkill"])
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
