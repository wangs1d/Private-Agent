// Agent Brain Center — DefaultModeNetwork（默认模式网络）
//
// 职责：模拟人脑的"默认模式网络"（DMN）——
//   空闲时激活，做白日梦、整合记忆、自我反思、提出能力进化建议。
//   不像任务执行时那样调认知皮层，而是"漫游式"地处理后台任务。
//
// 核心机制：
//   1. isIdle(actorId)：检测用户是否空闲（5 分钟无输入）
//   2. onIdle(actorId)：触发 DMN 流程
//      - 触发 MemoryCortex.consolidate（记忆固化）
//      - 触发 MetaCognition 反思最近决策
//      - 触发 EvolutionCortex 提出能力进化建议
//   3. 每 N 次心跳扫描触发一次（避免频繁触发）
//
// 深度链接：
//   - BrainStem 心跳扫描时调用（无输入时触发）
//   - DMN 整合多个皮层：MemoryCortex + MetaCognition + EvolutionCortex
//
// 设计要点：
//   - 纯规则触发，不调 LLM
//   - 触发频率低（每 5 分钟空闲一次）
//   - 异步执行不阻塞 BrainStem 主循环

import type { WorldModel, WorldState, WorldAction, WorldPrediction } from "./world-model-types.js";

/** DMN 最小化外观接口（避免直接依赖 MemoryCortex / EvolutionCortex） */
export interface DMNMemoryCortexLike {
  /** 记忆固化（短期→长期），返回任意 stats 结构（DMN 不解析具体字段） */
  consolidate(actorIds: string[]): Promise<unknown>;
}

export interface DMNEvolutionCortexLike {
  /** 提出能力进化建议（规则驱动，不调 LLM） */
  proposeEvolution(actorId: string): { proposals: number; reason: string };
}

/**
 * DMN 世界模型外观接口（P1-11）。
 *
 * 注入后 DMN 空闲时调用 worldModel.imagine() 做反事实模拟：
 *   - "如果用户现在回来，我会做什么？"
 *   - "如果刚才点了那个按钮，结果会怎样？"
 *
 * 不调 LLM，反事实模拟由 WorldModel.imagine() 内部完成（规则或神经网络）。
 */
export interface DMNWorldModelLike {
  imagine(
    hypotheticalState: WorldState,
    hypotheticalAction?: WorldAction,
  ): Promise<WorldPrediction>;
}

/** 反事实模拟结果 */
export interface CounterfactualSimulation {
  /** 假想场景描述 */
  scenario: string;
  /** 假想状态 */
  hypotheticalState: WorldState;
  /** 假想动作（可选） */
  hypotheticalAction?: WorldAction;
  /** 预测结果 */
  prediction: WorldPrediction;
}

/** DMN 触发结果 */
export interface DMNResult {
  actorId: string;
  triggered: boolean;
  consolidated: { mergedCount: number; promotedCount: number };
  reflected: { reflectedCount: number; insights: string[] };
  evolutionProposals: { proposals: number; reason: string };
  /** P1-11：反事实模拟结果（worldModel 未注入时为空数组） */
  counterfactualSimulations: CounterfactualSimulation[];
  durationMs: number;
}

/**
 * 默认模式网络。
 *
 * 模拟人脑 DMN：空闲时做后台整合（记忆固化 + 反思 + 进化）。
 * 纯规则触发，不调 LLM。
 */
export class DefaultModeNetwork {
  private memoryCortex: DMNMemoryCortexLike | null = null;
  private evolutionCortex: DMNEvolutionCortexLike | null = null;
  /** 世界模型（可选注入）：注入后空闲时做反事实模拟 */
  private worldModel: DMNWorldModelLike | null = null;

  /** actorId → 最后输入时间戳 */
  private lastInputAt = new Map<string, number>();
  /** actorId → 上次 DMN 触发时间戳 */
  private lastDmnAt = new Map<string, number>();
  /** 触发间隔（ms）：5 分钟。
   * 可通过 DMN_IDLE_THRESHOLD_MS 环境变量覆盖（毫秒，测试用）。 */
  private static getIdleThresholdMs(): number {
    const env = process.env.DMN_IDLE_THRESHOLD_MS;
    const parsed = env != null ? parseInt(env, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 5 * 60 * 1000;
  }
  /** 最小 DMN 间隔（ms）：避免频繁触发，10 分钟一次。
   * 可通过 DMN_MIN_INTERVAL_MS 环境变量覆盖（毫秒，测试用）。 */
  private static getMinDmnIntervalMs(): number {
    const env = process.env.DMN_MIN_INTERVAL_MS;
    const parsed = env != null ? parseInt(env, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 10 * 60 * 1000;
  }

  private stats = {
    triggered: 0,
    consolidations: 0,
    evolutionProposals: 0,
  };

  registerMemoryCortex(mc: DMNMemoryCortexLike): void {
    this.memoryCortex = mc;
  }

  registerEvolutionCortex(ec: DMNEvolutionCortexLike): void {
    this.evolutionCortex = ec;
  }

  /** 注入世界模型（开启空闲时反事实模拟能力，P1-11） */
  registerWorldModel(wm: DMNWorldModelLike): void {
    this.worldModel = wm;
    console.log("[DefaultModeNetwork] 已注册 WorldModel（反事实模拟）");
  }

  /** 记录用户输入时间（由 BrainStem 调用） */
  recordUserInput(actorId: string, timestamp: number = Date.now()): void {
    this.lastInputAt.set(actorId, timestamp);
  }

  /** 检测用户是否空闲（默认 5 分钟无输入，可通过环境变量调整） */
  isIdle(actorId: string, now: number = Date.now()): boolean {
    const lastInput = this.lastInputAt.get(actorId);
    if (!lastInput) return false; // 从未输入过，不算空闲
    return now - lastInput >= DefaultModeNetwork.getIdleThresholdMs();
  }

  /**
   * 触发 DMN 流程（如果满足条件）。
   *
   * @returns DMN 结果，triggered=false 表示未触发
   */
  async onIdle(actorId: string): Promise<DMNResult> {
    const now = Date.now();
    const startMs = now;

    // 检查触发条件
    if (!this.isIdle(actorId, now)) {
      return this.emptyResult(actorId);
    }

    const lastDmn = this.lastDmnAt.get(actorId) ?? 0;
    if (now - lastDmn < DefaultModeNetwork.getMinDmnIntervalMs()) {
      return this.emptyResult(actorId);
    }

    this.lastDmnAt.set(actorId, now);
    this.stats.triggered++;

    console.log(`[DefaultModeNetwork] 触发 DMN actor=${actorId}`);

    // 1. 记忆固化
    let consolidated: { mergedCount: number; promotedCount: number } = { mergedCount: 0, promotedCount: 0 };
    if (this.memoryCortex) {
      try {
        const result = await this.memoryCortex.consolidate([actorId]) as { mergedCount?: number; promotedCount?: number; weeklyMergedCount?: number; knowledgePromotedCount?: number };
        // 兼容 MemoryCortex 的 MemoryConsolidationStats 字段（weeklyMergedCount/knowledgePromotedCount）
        // 或简单 { mergedCount, promotedCount } 结构
        consolidated = {
          mergedCount: result?.mergedCount ?? result?.weeklyMergedCount ?? 0,
          promotedCount: result?.promotedCount ?? result?.knowledgePromotedCount ?? 0,
        };
        this.stats.consolidations++;
        if (consolidated.mergedCount > 0) {
          console.log(`[DMN] 记忆固化 actor=${actorId} merged=${consolidated.mergedCount} promoted=${consolidated.promotedCount}`);
        }
      } catch (e) {
        console.error(`[DMN] 记忆固化失败:`, e);
      }
    }

    // 3. 提出能力进化建议
    let evolutionProposals = { proposals: 0, reason: "未注册" };
    if (this.evolutionCortex) {
      try {
        evolutionProposals = this.evolutionCortex.proposeEvolution(actorId);
        this.stats.evolutionProposals += evolutionProposals.proposals;
        if (evolutionProposals.proposals > 0) {
          console.log(`[DMN] 进化提案 actor=${actorId} proposals=${evolutionProposals.proposals}`);
        }
      } catch (e) {
        console.error(`[DMN] 进化提案失败:`, e);
      }
    }

    // 4. 反事实模拟（P1-11：worldModel.imagine）
    // 空闲时模拟"如果用户现在回来/如果刚才做了不同选择，会怎样"。
    // 不调 LLM，由 WorldModel.imagine() 内部完成（规则或神经网络）。
    const counterfactualSimulations: CounterfactualSimulation[] = [];
    if (this.worldModel) {
      try {
        // 构造假想状态：用户即将回来、当前设备空闲
        const hypotheticalState: WorldState = {
          timestamp: new Date().toISOString(),
          actorId,
          taskContext: "(空闲)",
          userActivity: "即将回来",
          bodyState: { currentDevice: "desktop", mood: "idle" },
        };
        const prediction = await this.worldModel.imagine(hypotheticalState);
        counterfactualSimulations.push({
          scenario: "用户回来后的状态预测",
          hypotheticalState,
          prediction,
        });
        if (prediction.changes && prediction.changes.length > 0) {
          console.log(`[DMN] 反事实模拟 actor=${actorId} changes=${prediction.changes.length}`);
        }
      } catch (e) {
        console.error(`[DMN] 反事实模拟失败:`, e);
      }
    }

    return {
      actorId,
      triggered: true,
      consolidated,
      reflected: { reflectedCount: 0, insights: [] },
      evolutionProposals,
      counterfactualSimulations,
      durationMs: Date.now() - startMs,
    };
  }

  private emptyResult(actorId: string): DMNResult {
    return {
      actorId,
      triggered: false,
      consolidated: { mergedCount: 0, promotedCount: 0 },
      reflected: { reflectedCount: 0, insights: [] },
      evolutionProposals: { proposals: 0, reason: "未触发" },
      counterfactualSimulations: [],
      durationMs: 0,
    };
  }

  getStats(): {
    triggered: number;
    consolidations: number;
    evolutionProposals: number;
  } {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    console.log("[DefaultModeNetwork] 启动完成");
  }
  async stop(): Promise<void> {
    this.lastInputAt.clear();
    this.lastDmnAt.clear();
    console.log("[DefaultModeNetwork] 已停止");
  }
}
