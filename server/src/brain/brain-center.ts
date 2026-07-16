// Agent Brain Center — 外观类
import { randomUUID } from "node:crypto";
import type {
  AudioBufferRef,
  BrainDecision,
  BrainSignalInput,
  BrainSnapshot,
  CapabilityDescriptor,
  CapabilityGapReport,
  CognitiveContext,
  CognitiveEngine,
  CognitiveInput,
  CognitiveResult,
  EmotionVector,
  EvolutionProposal,
  MemoryConsolidationStats,
  MemoryDomainKind,
  MemoryItem,
  MemoryRecallItem,
  MemoryRecallResult,
  PlanResult,
  ReActObservation,
  SafetyCheckResult,
  SensoryFrame,
  SensoryListenResult,
  SensoryLookResult,
  SensorySpeakResult,
  SynapseEnvelope,
  SynapseMessage,
  SystemRouteDecision,
  TonePolicyResult,
  UserActivityState,
  VisualInput,
  PersonalityCore,
} from "./types.js";

// 能力皮层外观接口（后续 CapabilityCortex 实现可直接传入）
interface CapabilityCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  introspect(actorId: string): CapabilityDescriptor[];
  identifyGap?(scenario: string): CapabilityGapReport;
}

// 觉察皮层外观接口
interface AwarenessCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  observe(actorId: string): UserActivityState | null;
  /**
   * 元认知置信度评估（Stage 4 Task 3）。
   * 在 cognize 路由前调用；score < 0.4 时由 BrainCenter 强制升级到 master_delegate。
   * 未注册（无 awareness）时 cognize 跳过该步。
   */
  assessConfidence?(
    query: string,
    recallResult: { items: unknown[] } | null,
    capabilities: unknown[],
  ): { score: number; reason: string };
}

// 主动皮层外观接口
interface ProactionCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  decide(signal: BrainSignalInput): Promise<BrainDecision>;
  recentDecisions?(actorId: string): BrainDecision[];
}

// 进化皮层外观接口
interface EvolutionCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  evolve(
    proposal: Omit<EvolutionProposal, "id" | "status" | "createdAt" | "updatedAt">,
  ): EvolutionProposal;
  listPending?(actorId?: string): EvolutionProposal[];
  approveByUser?(
    proposalId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; proposal: EvolutionProposal | null; error?: string }>;
  rejectByUser?(
    proposalId: string,
    reason: string | undefined,
    sessionId?: string,
  ): { ok: boolean; proposal: EvolutionProposal | null };
}

// 感官皮层外观接口
interface SensoryCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  listen(
    audio: AudioBufferRef,
    opts?: { language?: string },
  ): Promise<SensoryListenResult>;
  look(opts?: VisualInput): Promise<SensoryLookResult>;
  speak(
    text: string,
    opts?: { voiceId?: string; channel?: string },
  ): Promise<SensorySpeakResult>;
  buildSensoryFrame(args: {
    actorId: string;
    audioText?: string;
    visualDescription?: string;
    emotion?: EmotionVector;
    activity?: UserActivityState;
  }): SensoryFrame;
  getStats(): { totalListen: number; totalLook: number; totalSpeak: number };
}

// 记忆皮层外观接口
interface MemoryCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  remember(actorId: string, item: MemoryItem): Promise<void>;
  recall(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number },
  ): Promise<MemoryRecallResult>;
  recallCrossDomain(actorId: string, query: string): Promise<MemoryRecallResult>;
  consolidate(actorIds: string[]): Promise<MemoryConsolidationStats>;
  /** 拉取结构化人格内核（personality 域），未设置时返回默认人格 */
  getPersonalityCore?(actorId: string): PersonalityCore;
}

// 突触总线外观接口
interface SynapseBusLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): SynapseEnvelope;
  subscribe(
    type: string,
    handler: (msg: SynapseMessage) => void | Promise<void>,
  ): () => void;
  sendToAgent(
    targetAgentId: string,
    message: { type: string; data: Record<string, unknown> },
    opts?: { from?: string },
  ): Promise<SynapseEnvelope>;
  sendToUser(
    actorId: string,
    payload: unknown,
    opts?: { channel?: string },
  ): Promise<SynapseEnvelope>;
  getRecentMessages(limit?: number): SynapseMessage[];
  getSubscriberCount(): number;
}

// 边缘皮层外观接口
interface LimbicCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult;
  inferEmotion(
    actorId: string,
    signals: { text?: string; voiceTone?: unknown; faceMetrics?: unknown },
  ): Promise<EmotionVector>;
  applyTonePolicy(text: string, emotion: EmotionVector): TonePolicyResult;
  getLastEmotion(actorId: string): EmotionVector | null;
  getLastSafetyCheck(): SafetyCheckResult | null;
  /**
   * 输出安全过滤（Stage 4 Task 2）：检测 LLM 输出文本中的敏感信息并替换为 [REDACTED]。
   * 未注册（无 limbic）时 cognize / executeProactiveDecision 跳过该步（原文本透传）。
   */
  checkOutputSafety?(
    text: string,
    ctx?: Record<string, unknown>,
  ): { safe: boolean; sanitized: string; reason?: string };
}

// 规划皮层外观接口
interface PlannerCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  plan(
    goal: string,
    opts?: { actorId?: string; maxSteps?: number },
  ): Promise<PlanResult>;
  execute(plan: PlanResult, opts?: { actorId?: string }): Promise<PlanResult>;
  react(observation: ReActObservation): ReActObservation;
  delegate(
    subAgentType: string,
    task: { goal: string; input?: unknown },
    opts?: { actorId?: string },
  ): Promise<unknown>;
  routeSystem(userMessage: string, opts?: { actorId?: string }): SystemRouteDecision;
  getLastPlan(): PlanResult | null;
  getLastRoute(): SystemRouteDecision | null;
}

// 脑干外观接口（subcortical:自主节律调度——心跳扫描/趋势消费/合成信号回流）
interface BrainStemLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  sweepOnce?(): Promise<void>;
  snapshot?(): {
    lastSweepAt: string | null;
    syntheticSignalsEmitted: number;
    activeActors: number;
  };
}

// 小脑外观接口（subcortical:时序协调——defer/复查/打断抑制）
interface CerebellumLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  schedule(
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): Promise<void>;
  interrupt(actorId: string): void;
  clearPending(actorId: string): void;
  snapshot?(): {
    pendingCount: number;
    interruptedCount: number;
    lastInterruptAt: string | null;
  };
}

/**
 * Brain Center —— 大脑中心外观类。
 *
 * 持有十一个脑区分区的可选引用（4 个核心皮层 + 5 个神经解剖皮层 + 2 个 subcortical 分区），
 * 对外提供统一的能力自省、用户觉察、主动决策、自我进化、
 * 感官感知、记忆、突触通信、边缘安全/情绪与规划路由入口。
 * subcortical 分区：BrainStem（脑干/自主节律）+ Cerebellum（小脑/时序协调）。
 * 任一分区缺失时方法优雅降级。
 */
export class BrainCenter {
  private cap: CapabilityCortexLike | null = null;
  private awareness: AwarenessCortexLike | null = null;
  private proaction: ProactionCortexLike | null = null;
  private evolution: EvolutionCortexLike | null = null;
  private sensory: SensoryCortexLike | null = null;
  private memory: MemoryCortexLike | null = null;
  private synapse: SynapseBusLike | null = null;
  private limbic: LimbicCortexLike | null = null;
  private planner: PlannerCortexLike | null = null;
  /** 脑干（subcortical:自主节律调度） */
  private brainStem: BrainStemLike | null = null;
  /** 小脑（subcortical:时序协调） */
  private cerebellum: CerebellumLike | null = null;
  /** 端到端认知引擎：一次 LLM 完成理解+决策+响应（整体端到端调度的核心） */
  private cognitiveEngine: CognitiveEngine | null = null;

  private started = false;

  // ---- 皮层注册 ----------------------------------------------------------

  registerCapability(c: CapabilityCortexLike): void {
    this.cap = c;
    console.log("[BrainCenter] 已注册 CapabilityCortex");
  }

  registerAwareness(c: AwarenessCortexLike): void {
    this.awareness = c;
    console.log("[BrainCenter] 已注册 AwarenessCortex");
  }

  registerProaction(c: ProactionCortexLike): void {
    this.proaction = c;
    console.log("[BrainCenter] 已注册 ProactionCortex");
  }

  registerEvolution(c: EvolutionCortexLike): void {
    this.evolution = c;
    console.log("[BrainCenter] 已注册 EvolutionCortex");
  }

  registerSensory(c: SensoryCortexLike): void {
    this.sensory = c;
    console.log("[BrainCenter] 已注册 SensoryCortex");
  }

  registerMemory(c: MemoryCortexLike): void {
    this.memory = c;
    console.log("[BrainCenter] 已注册 MemoryCortex");
  }

  /**
   * 拉取结构化人格内核（personality 域）。
   * 委托 MemoryCortex.getPersonalityCore；未注册或缺失时返回 null。
   * 供 PromptContextBuilder 组装 system prompt 稳定前缀使用。
   */
  getPersonalityCore(actorId: string): PersonalityCore | null {
    return this.memory?.getPersonalityCore?.(actorId) ?? null;
  }

  registerSynapse(c: SynapseBusLike): void {
    this.synapse = c;
    console.log("[BrainCenter] 已注册 SynapseBus");
  }

  registerLimbic(c: LimbicCortexLike): void {
    this.limbic = c;
    console.log("[BrainCenter] 已注册 LimbicCortex");
  }

  registerPlanner(c: PlannerCortexLike): void {
    this.planner = c;
    console.log("[BrainCenter] 已注册 PlannerCortex");
  }

  /** 注册脑干（subcortical:自主节律调度） */
  registerBrainStem(s: BrainStemLike): void {
    this.brainStem = s;
    console.log("[BrainCenter] 已注册 BrainStem（脑干/自主节律）");
  }

  /** 注册小脑（subcortical:时序协调） */
  registerCerebellum(c: CerebellumLike): void {
    this.cerebellum = c;
    console.log("[BrainCenter] 已注册 Cerebellum（小脑/时序协调）");
  }

  /**
   * 小脑调度入口：皮层 ProactionCortex 决策 speak 后,交小脑决定何时执行。
   * - 用户 busy/sleeping → defer,等 reaper 复查
   * - 抑制窗口内 → defer
   * - 否则 → 犹豫后立即执行
   * 小脑未注册时直接执行（降级,不 defer）。
   */
  async scheduleProactive(
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): Promise<void> {
    if (!this.cerebellum) {
      await fire();
      return;
    }
    await this.cerebellum.schedule(decision, signal, fire);
  }

  /** 小脑打断：用户开口时清空 defer 队列 + 设抑制窗口,避免 Agent 抢话 */
  interruptProactive(actorId: string): void {
    this.cerebellum?.interrupt(actorId);
  }

  /** 脑干立即扫描（测试/外部触发用） */
  async sweepBrainStem(): Promise<void> {
    await this.brainStem?.sweepOnce?.();
  }

  /** 注册端到端认知引擎：让 BrainCenter 成为认知中枢而非被动外观 */
  registerCognitiveEngine(engine: CognitiveEngine): void {
    this.cognitiveEngine = engine;
    console.log("[BrainCenter] 已注册 CognitiveEngine（端到端认知）");
  }

  // ---- 核心方法 ----------------------------------------------------------

  /** 能力自省：返回当前 actor 已注册的能力描述符列表 */
  introspect(actorId: string): CapabilityDescriptor[] {
    if (!this.cap) {
      console.log("[BrainCenter] introspect: CapabilityCortex 缺失，返回空列表");
      return [];
    }
    return this.cap.introspect(actorId);
  }

  /** 能力缺口识别：委托给 CapabilityCortex；未注册或方法缺失时返回 null */
  identifyGap(scenario: string): CapabilityGapReport | null {
    if (!this.cap || typeof this.cap.identifyGap !== "function") {
      return null;
    }
    try {
      return this.cap.identifyGap(scenario);
    } catch (err) {
      console.log(`[BrainCenter] identifyGap 调用失败: ${err}`);
      return null;
    }
  }

  /** 用户觉察：返回当前 actor 的活动状态 */
  observe(actorId: string): UserActivityState | null {
    if (!this.awareness) {
      console.log("[BrainCenter] observe: AwarenessCortex 缺失，返回 null");
      return null;
    }
    return this.awareness.observe(actorId);
  }

  /**
   * 端到端认知入口（整体端到端调度的核心）。
   *
   * 像真人一样一气呵成完成"感知 → 理解 → 决策 → 响应"：
   *  阶段 1 — 感知收集（并行，各脑区同时工作，不串行切片）：
   *    listen(audio) / look(visual) / recall(query) / inferEmotion(text)
   *    / observe(actorId) / introspect(actorId) / recentDecisions(actorId)
   *  阶段 2 — 端到端认知 LLM（一次调用）：
   *    把所有脑区上下文一次性交给 CognitiveEngine，
   *    产出 {路由, 响应, 记忆写入, 动作, 是否需要工具循环}
   *  阶段 3 — 后置执行：
   *    checkSafety(action) + remember(memoryWrites)
   *
   * 工具循环（openai-compatible-tool-loop）是执行层迭代，保留——人用工具也是迭代的。
   * 真正端到端的是"认知决策"：路由+召回+情绪+响应策略合并为一次认知。
   */
  async cognize(input: CognitiveInput): Promise<CognitiveResult> {
    const now = new Date().toISOString();
    const actorId = input.actorId;
    const query = input.text ?? input.signal?.title ?? "";

    // === 阶段 1：感知收集（并行，不串行切片）===
    const [audioResult, visualResult, recallResult, emotion, userActivity, capabilities, recentDecisions] =
      await Promise.all([
        input.audio && this.sensory
          ? this.sensory.listen(input.audio).catch(() => null)
          : Promise.resolve(null),
        input.visual && this.sensory
          ? this.sensory.look(input.visual).catch(() => null)
          : Promise.resolve(null),
        this.memory
          ? this.memory.recall(actorId, query, { limit: 5 }).catch(() => null)
          : Promise.resolve(null),
        this.limbic?.inferEmotion
          ? this.limbic.inferEmotion(actorId, { text: input.text }).catch(() => null)
          : Promise.resolve(null),
        Promise.resolve(this.awareness?.observe(actorId) ?? null),
        Promise.resolve(this.cap?.introspect(actorId) ?? []),
        Promise.resolve(this.proaction?.recentDecisions?.(actorId) ?? []),
      ]);

    // === 阶段 1.5：组装多模态融合帧（SensoryFrame）===
    // 将 audioResult/visualResult/emotion/userActivity 融合为统一感知帧，
    // 让认知 LLM 一次拿到完整的多模态上下文。
    const sensoryFrame = this.sensory
      ? this.sensory.buildSensoryFrame({
          actorId,
          audioText: audioResult?.text,
          visualDescription: visualResult?.description,
          emotion: emotion ?? undefined,
          activity: userActivity ?? undefined,
        })
      : undefined;

    const context: CognitiveContext = {
      memories: recallResult?.items ?? [],
      emotion: emotion ?? null,
      userActivity: userActivity ?? null,
      capabilities: capabilities ?? [],
      recentDecisions: recentDecisions ?? [],
      audioText: audioResult?.text,
      visualDescription: visualResult?.description,
      sensoryFrame,
    };

    // === 阶段 1.6：（已废弃正则预评判）===
    // 原先在此用 AwarenessCortex.assessConfidence 正则规则预评分，但正则无法理解
    // 对话语义（如「嗯」是模糊追问还是确认、「那个」指代什么），会误判。
    // 现置信度由 cognize LLM 基于对话内容语义评判（见阶段 2），规则仅作 cognize
    // 失败降级时的兜底（见阶段 2 catch 分支）。

    // === 阶段 2：端到端认知 LLM ===
    let cognitive: {
      route: SystemRouteDecision;
      response: string;
      memoryWrites: MemoryItem[];
      action?: { tool: string; args: Record<string, unknown> };
      needsToolLoop: boolean;
      rationale: string;
      confidence?: number;
      confidenceReason?: string;
    };
    // 兜底置信度：仅当 cognize 失败/未返回 confidence 时用规则评估
    let ruleFallbackConfidence: { score: number; reason: string } | null = null;
    if (this.cognitiveEngine) {
      try {
        cognitive = await this.cognitiveEngine.cognize(input, context);
      } catch (e) {
        // 端到端认知失败 → 降级到 routeSystem 规则路由 + 规则置信度兜底
        const fallbackRoute = this.routeSystem(query, { actorId });
        cognitive = {
          route: fallbackRoute,
          response: "",
          memoryWrites: [],
          needsToolLoop: fallbackRoute.mode !== "fast_chat",
          rationale: `cognize_failed:${String(e).slice(0, 80)}`,
        };
        if (typeof this.awareness?.assessConfidence === "function") {
          try {
            ruleFallbackConfidence = this.awareness.assessConfidence(query, recallResult, capabilities ?? []);
          } catch { /* ignore */ }
        }
      }
    } else {
      // 未注入认知引擎 → 降级到 routeSystem + 规则置信度兜底
      const fallbackRoute = this.routeSystem(query, { actorId });
      cognitive = {
        route: fallbackRoute,
        response: "",
        memoryWrites: [],
        needsToolLoop: fallbackRoute.mode !== "fast_chat",
        rationale: "no_cognitive_engine",
      };
      if (typeof this.awareness?.assessConfidence === "function") {
        try {
          ruleFallbackConfidence = this.awareness.assessConfidence(query, recallResult, capabilities ?? []);
        } catch { /* ignore */ }
      }
    }

    // === 阶段 2.5：低置信度路由升级 ===
    // 置信度来源优先级：cognize LLM 基于对话内容的语义评判 > 规则兜底（仅 cognize 失败时）。
    // score < 0.4 且 route.mode === "master_only" 时升级到 master_delegate，让子 Agent 兜底。
    //
    // ⚠️ 仅对 `master_only` 路由生效：该路由是「主 Agent 带工具先试」，若 LLM 基于内容
    // 判定置信度低（信息不足/能力缺失），委派给子 Agent 兜底是合理的。
    // 对 `fast_chat` / `direct_llm` 绝不升级——这两类是认知 LLM 明确判定「可直接回答」的路由。
    let finalRoute = cognitive.route;
    let finalRationale = cognitive.rationale;
    let finalNeedsToolLoop = cognitive.needsToolLoop;
    // 选取有效置信度：优先 cognize 的内容评判，缺省时用规则兜底
    const effScore = typeof cognitive.confidence === "number" ? cognitive.confidence : ruleFallbackConfidence?.score;
    const effReason = typeof cognitive.confidence === "number"
      ? (cognitive.confidenceReason ?? `cognize_confidence=${cognitive.confidence.toFixed(2)}`)
      : (ruleFallbackConfidence?.reason ?? "");
    if (typeof effScore === "number" && effScore < 0.4 && finalRoute.mode === "master_only") {
      console.log(
        `[BrainCenter] 低置信度路由升级 actorId=${actorId} score=${effScore.toFixed(2)} ` +
          `origMode=${finalRoute.mode} → master_delegate reason=${effReason}`,
      );
      finalRoute = {
        userMessage: finalRoute.userMessage,
        system: "system2",
        mode: "master_delegate",
        rationale: `low_confidence_override:${effReason}`,
        decidedAt: now,
      };
      finalRationale = `${cognitive.rationale}; low_confidence(score=${effScore.toFixed(2)}): ${effReason}`;
      finalNeedsToolLoop = true;
    }

    // === 阶段 3：后置执行（安全检查 + 输出过滤 + 记忆写入）===
    const safety: SafetyCheckResult = cognitive.action
      ? this.checkSafety(cognitive.action)
      : {
          allowed: true,
          severity: "allowed",
          reason: "no_action",
          checkedAt: now,
        };

    // Stage 4 Task 2：输出安全过滤——检测 LLM 输出中的敏感信息并替换为 [REDACTED]。
    // limbic 未注册时 checkOutputSafety 原文本透传（safe=true）。
    const outputSafety = this.checkOutputSafety(cognitive.response, {
      actorId,
      sessionId: input.sessionId,
      stage: "cognize",
    });
    const finalResponse = outputSafety.sanitized;
    if (!outputSafety.safe) {
      console.log(
        `[BrainCenter] cognize 输出已脱敏 actorId=${actorId} reason=${outputSafety.reason}`,
      );
    }

    if (cognitive.memoryWrites.length > 0 && this.memory) {
      for (const item of cognitive.memoryWrites) {
        try {
          await this.memory!.remember(actorId, item);
        } catch {
          /* ignore memory write failure */
        }
      }
    }

    return {
      actorId,
      route: finalRoute,
      response: finalResponse,
      emotion: context.emotion,
      memoryWrites: cognitive.memoryWrites,
      action: cognitive.action,
      safety,
      needsToolLoop: finalNeedsToolLoop,
      rationale: finalRationale,
      cognizedAt: now,
      // 携带阶段 1 已召回的记忆条目，供后续 standard path 复用，避免重复 MemoryCortex.recall
      recallItems: recallResult?.items ?? [],
    };
  }

  /** 主动决策：根据输入信号产出大脑决策 */
  async decide(signal: BrainSignalInput): Promise<BrainDecision> {
    if (!this.proaction) {
      console.log("[BrainCenter] decide: ProactionCortex 缺失，返回静默降级决策");
      return {
        actorId: signal.actorId,
        outcome: "silent",
        valueScore: 0,
        disturbScore: 0,
        rationale: "ProactionCortex 未注册，默认静默",
        decidedAt: new Date().toISOString(),
      };
    }
    return this.proaction.decide(signal);
  }

  /** 自我进化：提交一个进化提案 */
  evolve(
    proposal: Omit<EvolutionProposal, "id" | "status" | "createdAt" | "updatedAt">,
  ): EvolutionProposal {
    if (!this.evolution) {
      console.log("[BrainCenter] evolve: EvolutionCortex 缺失，返回未持久化的临时提案");
      const now = new Date().toISOString();
      return {
        ...proposal,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.evolution.evolve(proposal);
  }

  /**
   * 用户同意装载进化提案生成的 Skill（用户审批闸门）。
   * 委托 EvolutionCortex.approveByUser：调 PromotionPipeline.promote 装载到 SkillManager。
   */
  async approveEvolution(
    proposalId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; proposal: EvolutionProposal | null; error?: string }> {
    if (!this.evolution?.approveByUser) {
      return { ok: false, proposal: null, error: "EvolutionCortex 或 approveByUser 未注册" };
    }
    return this.evolution.approveByUser(proposalId, sessionId);
  }

  /**
   * 用户拒绝装载进化提案生成的 Skill（用户审批闸门）。
   * 委托 EvolutionCortex.rejectByUser：awaiting_user_approval → rejected。
   */
  rejectEvolution(
    proposalId: string,
    reason: string | undefined,
    sessionId?: string,
  ): { ok: boolean; proposal: EvolutionProposal | null } {
    if (!this.evolution?.rejectByUser) {
      return { ok: false, proposal: null };
    }
    return this.evolution.rejectByUser(proposalId, reason, sessionId);
  }

  /** 听：委托 SensoryCortex.listen 做语音识别；缺失时返回空结果 */
  async listen(
    audio: AudioBufferRef,
    opts?: { language?: string },
  ): Promise<SensoryListenResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] listen: SensoryCortex 缺失");
      return {
        text: "",
        confidence: 0,
        isFinal: false,
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.listen(audio, opts);
    } catch (err) {
      console.log(`[BrainCenter] listen 调用失败: ${err}`);
      return {
        text: "",
        confidence: 0,
        isFinal: false,
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 看：委托 SensoryCortex.look 截屏并生成视觉描述；缺失时返回空结果 */
  async look(opts?: VisualInput): Promise<SensoryLookResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] look: SensoryCortex 缺失");
      return {
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.look(opts);
    } catch (err) {
      console.log(`[BrainCenter] look 调用失败: ${err}`);
      return {
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 说：委托 SensoryCortex.speak 合成并投递语音；缺失时返回投递失败 */
  async speak(
    text: string,
    opts?: { voiceId?: string; channel?: string },
  ): Promise<SensorySpeakResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] speak: SensoryCortex 缺失");
      return {
        delivered: false,
        channel: opts?.channel ?? "ws",
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.speak(text, opts);
    } catch (err) {
      console.log(`[BrainCenter] speak 调用失败: ${err}`);
      return {
        delivered: false,
        channel: opts?.channel ?? "ws",
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 记忆写入：委托 MemoryCortex.remember；缺失时记日志并跳过 */
  async remember(actorId: string, item: MemoryItem): Promise<void> {
    if (!this.memory) {
      console.log("[BrainCenter] remember: MemoryCortex 缺失");
      return;
    }
    try {
      return await this.memory.remember(actorId, item);
    } catch (err) {
      console.log(`[BrainCenter] remember 调用失败: ${err}`);
      return;
    }
  }

  /** 记忆召回：委托 MemoryCortex.recall；缺失时返回空召回结果 */
  async recall(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number },
  ): Promise<MemoryRecallResult> {
    if (!this.memory) {
      console.log("[BrainCenter] recall: MemoryCortex 缺失");
      return {
        actorId,
        query,
        items: [],
        domain: opts?.domain ?? "semantic",
        mode: "single_domain",
        recalledAt: new Date().toISOString(),
      };
    }
    try {
      return await this.memory.recall(actorId, query, opts);
    } catch (err) {
      console.log(`[BrainCenter] recall 调用失败: ${err}`);
      return {
        actorId,
        query,
        items: [],
        domain: opts?.domain ?? "semantic",
        mode: "single_domain",
        recalledAt: new Date().toISOString(),
      };
    }
  }

  /** 突触发射：委托 SynapseBus.fire 发布进程内事件；缺失时返回未投递信封 */
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): SynapseEnvelope {
    if (!this.synapse) {
      console.log("[BrainCenter] fire: SynapseBus 缺失");
      return {
        message: {
          id: randomUUID(),
          type,
          route: "internal",
          from: opts?.source ?? "brain",
          data,
          timestamp: new Date().toISOString(),
        },
        delivered: false,
        error: "SynapseBus 未注册",
      };
    }
    try {
      return this.synapse.fire(type, data, opts);
    } catch (err) {
      console.log(`[BrainCenter] fire 调用失败: ${err}`);
      return {
        message: {
          id: randomUUID(),
          type,
          route: "internal",
          from: opts?.source ?? "brain",
          data,
          timestamp: new Date().toISOString(),
        },
        delivered: false,
        error: "SynapseBus 未注册",
      };
    }
  }

  /** 安全检查：委托 LimbicCortex.checkSafety；缺失时默认放行 */
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult {
    if (!this.limbic) {
      console.log("[BrainCenter] checkSafety: LimbicCortex 缺失");
      return {
        allowed: true,
        severity: "allowed",
        reason: "LimbicCortex 未注册，默认放行",
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      return this.limbic.checkSafety(action, ctx);
    } catch (err) {
      console.log(`[BrainCenter] checkSafety 调用失败: ${err}`);
      return {
        allowed: true,
        severity: "allowed",
        reason: "LimbicCortex 未注册，默认放行",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 输出安全过滤（Stage 4 Task 2）：委托 LimbicCortex.checkOutputSafety。
   *
   * 在 cognize 阶段 3 后置执行、在 executeProactiveDecision 话术输出后执行，
   * 检测 LLM 输出中的 API key / 私钥 / 长随机串 / 内部路径并替换为 [REDACTED]。
   * LimbicCortex 未注册或调用异常时原文本透传（降级，不阻塞主流程）。
   */
  checkOutputSafety(
    text: string,
    ctx?: Record<string, unknown>,
  ): { safe: boolean; sanitized: string; reason?: string } {
    if (!this.limbic || typeof this.limbic.checkOutputSafety !== "function") {
      return { safe: true, sanitized: text };
    }
    try {
      return this.limbic.checkOutputSafety(text, ctx);
    } catch (err) {
      console.log(`[BrainCenter] checkOutputSafety 调用失败: ${err}`);
      return { safe: true, sanitized: text };
    }
  }

  /** 规划：委托 PlannerCortex.plan；缺失时返回空计划 */
  async plan(
    goal: string,
    opts?: { actorId?: string; maxSteps?: number },
  ): Promise<PlanResult> {
    if (!this.planner) {
      console.log("[BrainCenter] plan: PlannerCortex 缺失");
      return {
        goal,
        steps: [],
        rationale: "PlannerCortex 未注册",
        createdAt: new Date().toISOString(),
      };
    }
    try {
      return await this.planner.plan(goal, opts);
    } catch (err) {
      console.log(`[BrainCenter] plan 调用失败: ${err}`);
      return {
        goal,
        steps: [],
        rationale: "PlannerCortex 未注册",
        createdAt: new Date().toISOString(),
      };
    }
  }

  /** 系统路由：委托 PlannerCortex.routeSystem；缺失时返回 fast_chat 兜底 */
  routeSystem(
    userMessage: string,
    opts?: { actorId?: string },
  ): SystemRouteDecision {
    if (!this.planner) {
      console.log("[BrainCenter] routeSystem: PlannerCortex 缺失");
      return {
        userMessage,
        system: "system1",
        mode: "fast_chat",
        rationale: "PlannerCortex 未注册",
        decidedAt: new Date().toISOString(),
      };
    }
    try {
      return this.planner.routeSystem(userMessage, opts);
    } catch (err) {
      console.log(`[BrainCenter] routeSystem 调用失败: ${err}`);
      return {
        userMessage,
        system: "system1",
        mode: "fast_chat",
        rationale: "PlannerCortex 未注册",
        decidedAt: new Date().toISOString(),
      };
    }
  }

  /** 子 Agent 委派：委托 PlannerCortex.delegate；缺失时返回失败 */
  async delegate(
    subAgentType: string,
    task: { goal: string; input?: unknown },
    opts?: { actorId?: string },
  ): Promise<unknown> {
    if (!this.planner) {
      console.log("[BrainCenter] delegate: PlannerCortex 缺失");
      return { ok: false, error: "PlannerCortex 未注册" };
    }
    try {
      return await this.planner.delegate(subAgentType, task, opts);
    } catch (err) {
      console.log(`[BrainCenter] delegate 调用失败: ${err}`);
      return {
        ok: false,
        error: `delegate 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** 大脑状态快照：聚合九个脑区当前状态 */
  snapshot(actorId: string): BrainSnapshot {
    const now = new Date().toISOString();
    return {
      actorId,
      capabilities: this.cap ? this.cap.introspect(actorId) : [],
      userActivity: this.awareness ? this.awareness.observe(actorId) : null,
      lastDecisions: this.proaction?.recentDecisions?.(actorId) ?? [],
      pendingEvolutions: this.evolution?.listPending?.(actorId) ?? [],
      sensory: this.sensory ? { stats: this.sensory.getStats() } : undefined,
      memory: this.memory ? { recentItems: [] } : undefined,
      synapse: this.synapse
        ? {
            recentMessages: this.synapse.getRecentMessages(10),
            subscribers: this.synapse.getSubscriberCount(),
          }
        : undefined,
      limbic: this.limbic
        ? {
            lastEmotion: this.limbic.getLastEmotion(actorId) ?? undefined,
            lastSafetyCheck: this.limbic.getLastSafetyCheck() ?? undefined,
          }
        : undefined,
      planner: this.planner
        ? {
            lastPlan: this.planner.getLastPlan() ?? undefined,
            lastRoute: this.planner.getLastRoute() ?? undefined,
          }
        : undefined,
      brainStem: this.brainStem?.snapshot
        ? (() => {
            const s = this.brainStem!.snapshot()!;
            return {
              ...s,
              lastSweepAt: s.lastSweepAt ?? undefined,
            };
          })()
        : undefined,
      cerebellum: this.cerebellum?.snapshot
        ? (() => {
            const s = this.cerebellum!.snapshot()!;
            return {
              ...s,
              lastInterruptAt: s.lastInterruptAt ?? undefined,
            };
          })()
        : undefined,
      capturedAt: now,
    };
  }

  // ---- 生命周期 ----------------------------------------------------------

  /** 启动大脑：依次启动已注册的皮层（缺失或无 start 方法则跳过） */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[BrainCenter] 已启动，跳过重复 start");
      return;
    }
    console.log("[BrainCenter] 正在启动...");
    await this.startCortex("CapabilityCortex", this.cap);
    await this.startCortex("AwarenessCortex", this.awareness);
    await this.startCortex("ProactionCortex", this.proaction);
    await this.startCortex("EvolutionCortex", this.evolution);
    await this.startCortex("SensoryCortex", this.sensory);
    await this.startCortex("MemoryCortex", this.memory);
    await this.startCortex("SynapseBus", this.synapse);
    await this.startCortex("LimbicCortex", this.limbic);
    await this.startCortex("PlannerCortex", this.planner);
    await this.startCortex("BrainStem", this.brainStem);
    await this.startCortex("Cerebellum", this.cerebellum);
    this.started = true;
    console.log("[BrainCenter] 启动完成");
  }

  /** 停止大脑：依次停止已注册的皮层（缺失或无 stop 方法则跳过） */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BrainCenter] 未启动，跳过 stop");
      return;
    }
    console.log("[BrainCenter] 正在停止...");
    await this.stopCortex("CapabilityCortex", this.cap);
    await this.stopCortex("AwarenessCortex", this.awareness);
    await this.stopCortex("ProactionCortex", this.proaction);
    await this.stopCortex("EvolutionCortex", this.evolution);
    await this.stopCortex("SensoryCortex", this.sensory);
    await this.stopCortex("MemoryCortex", this.memory);
    await this.stopCortex("SynapseBus", this.synapse);
    await this.stopCortex("LimbicCortex", this.limbic);
    await this.stopCortex("PlannerCortex", this.planner);
    await this.stopCortex("Cerebellum", this.cerebellum);
    await this.stopCortex("BrainStem", this.brainStem);
    this.started = false;
    console.log("[BrainCenter] 已停止");
  }

  // ---- 内部工具 ----------------------------------------------------------

  private async startCortex(
    name: string,
    c: { start?(): Promise<void> } | null,
  ): Promise<void> {
    if (!c || typeof c.start !== "function") {
      return;
    }
    try {
      await c.start();
      console.log(`[BrainCenter] ${name} 已启动`);
    } catch (err) {
      console.log(`[BrainCenter] ${name} 启动失败: ${err}`);
    }
  }

  private async stopCortex(
    name: string,
    c: { stop?(): Promise<void> } | null,
  ): Promise<void> {
    if (!c || typeof c.stop !== "function") {
      return;
    }
    try {
      await c.stop();
      console.log(`[BrainCenter] ${name} 已停止`);
    } catch (err) {
      console.log(`[BrainCenter] ${name} 停止失败: ${err}`);
    }
  }
}
