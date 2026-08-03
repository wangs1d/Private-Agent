// Agent Brain Center — MetaCognitionCortex（元认知皮层）
//
// 职责：评估自身置信度、识别不确定性、触发反思。
//   像前额叶背外侧皮层执行"思考自己的思考"（metacognition）。
//
// 核心机制：
//   1. 置信度评估：基于路由结果、记忆召回、能力匹配综合打分
//   2. 不确定性标记：识别"不知道/不确定/需要查"等情境
//   3. 反思触发：confidence < 0.6 时建议反思（不强制，由上层决策）
//   4. 自我怀疑水平：累积近期不确定性，影响后续决策
//
// 深度链接：
//   - cognize 阶段 2.5 评估 DecisionHub 输出的 confidence
//   - 生成 MetacogAssessment 注入 context.metacog
//   - 话术层读取 uncertaintyMarkers 决定是否表达"不确定"
//
// 设计要点：
//   - 与 AwarenessCortex 区分：Awareness 观察用户，MetaCognition 观察自身
//   - 不调 LLM（避免幻觉），用规则评估置信度
//   - 反思是"建议"而非"指令"——上层可采纳可忽略

import type { RuleRouteDecision } from "./rule-router.js";
import type { WorldModel, WorldState, WorldAction } from "./world-model-types.js";

/** 元认知评估结果 */
export interface MetacogAssessment {
  /** 综合置信度（0-1） */
  confidence: number;
  /** 不确定性来源（多个） */
  uncertaintySources: string[];
  /** 是否建议反思 */
  shouldReflect: boolean;
  /** 反思原因 */
  reflectionReason?: string;
  /** 自我怀疑水平（0-1，累积近期不确定性） */
  selfDoubtLevel: number;
  /** 话术标记（建议在响应中表达"不确定"） */
  uncertaintyMarkers: string[];
  /** 评估依据 */
  evidence: string[];
  /** 评估时间 */
  assessedAt: string;
}

/** 反思记录 */
export interface ReflectionRecord {
  id: string;
  actorId: string;
  trigger: string;
  context: string;
  outcome: "confirmed" | "corrected" | "abandoned";
  createdAt: string;
}

/** 评估输入 */
export interface MetacogInput {
  route: RuleRouteDecision;
  recallItems: unknown[];
  capabilities: unknown[];
  userText: string;
}

/**
 * MetaCognition 用到的 WorldModel 外观接口（P1-12）。
 *
 * 只需要 update 方法：反思产生奖励信号时，把 (s, a, s') 喂给世界模型学习。
 * predict/rollout/imagine 不在元认知职责范围内。
 */
export interface MetaCognitionWorldModelLike {
  update(
    stateBefore: WorldState,
    action: WorldAction,
    stateAfter: WorldState,
  ): Promise<number>;
}

/**
 * 奖励信号（P1-12）。
 *
 * MetaCognitionCortex 把反思结果转化为 [-1, 1] 的奖励信号：
 *   - confirmed（反思确认决策正确）→ +1（正向奖励）
 *   - corrected（反思发现决策错误）→ -1（负向奖励）
 *   - abandoned（反思放弃该决策路径）→ -0.5（弱负向奖励）
 *
 * 上层（如 PredictiveCodingCortex.updateStateModel）可调 getRecentRewardSignal()
 * 读取该信号，作为世界模型更新的 reward weight。
 */
export interface RewardSignal {
  actorId: string;
  /** 奖励值 [-1, 1] */
  reward: number;
  /** 触发反思的来源 */
  trigger: string;
  /** 反思上下文（简短） */
  context: string;
  /** 反思结果 */
  outcome: ReflectionRecord["outcome"];
  /** 产生时间 */
  createdAt: string;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const REFLECTION_THRESHOLD = 0.4;
const SELT_DOUBT_DECAY = 0.85; // 每次评估后衰减

/** 反思结果 → 奖励值映射（P1-12） */
function rewardForOutcome(outcome: ReflectionRecord["outcome"]): number {
  switch (outcome) {
    case "confirmed":
      return 1;
    case "corrected":
      return -1;
    case "abandoned":
      return -0.5;
  }
}

/** 单个 actor 保留的最近奖励信号条数（避免无限增长） */
const MAX_REWARD_SIGNALS_PER_ACTOR = 20;

// 不确定性关键词（用户表达模糊时）
const VAGUE_INDICATORS = [
  "那个", "这个", "东西", "什么", "怎么", "为啥", "为什么",
  "maybe", "可能", "也许", "好像", "似乎", "应该",
];

// 能力缺口指示
const CAPABILITY_GAP_INDICATORS = [
  "我不知道", "我不会", "无法", "不能", "做不到",
  "不确定", "不太清楚", "需要查", "让我想想",
];

/**
 * 元认知皮层。
 *
 * 评估"自己知道什么、不知道什么"，决定是否表达不确定性、是否触发反思。
 * 不直接调 LLM，用规则评估，避免幻觉。
 */
export class MetaCognitionCortex {
  /** actorId → 自我怀疑水平（累积值） */
  private readonly selfDoubt = new Map<string, number>();
  /** actorId → 反思历史 */
  private readonly reflections = new Map<string, ReflectionRecord[]>();
  /** actorId → 最近奖励信号（P1-12，供世界模型读取） */
  private readonly rewardSignals = new Map<string, RewardSignal[]>();
  /** 世界模型（可选注入，P1-12）：注入后反思结果会作为奖励信号喂给世界模型学习 */
  private worldModel: MetaCognitionWorldModelLike | null = null;
  /** 统计 */
  private assessmentCount = 0;
  private reflectionTriggeredCount = 0;
  /** 已馈送给世界模型的奖励次数（统计用） */
  private rewardFedToWorldModel = 0;

  /**
   * 注入世界模型（P1-12）。
   *
   * 注入后：
   *   1. recordPredictionOutcome() 会调 worldModel.update() 把 (s, a, s') 喂给世界模型
   *   2. recordReflection() 产生的奖励信号可被上层读取后用于世界模型更新加权
   *
   * 未注入时所有方法优雅降级（不影响原有反思链路）。
   */
  registerWorldModel(wm: WorldModel | MetaCognitionWorldModelLike): void {
    this.worldModel = wm as MetaCognitionWorldModelLike;
    console.log("[MetaCognitionCortex] 已注册 WorldModel（反思奖励信号对接）");
  }

  /**
   * 评估元认知。
   *
   * 输入路由结果 + 记忆召回 + 能力匹配，输出综合置信度与不确定性。
   * 不调 LLM，纯规则评估。
   */
  assess(actorId: string, input: MetacogInput): MetacogAssessment {
    this.assessmentCount++;
    const evidence: string[] = [];
    const uncertaintySources: string[] = [];
    const uncertaintyMarkers: string[] = [];

    // 1. 基础置信度：路由 confidence
    let confidence = input.route.confidence;
    evidence.push(`路由置信度=${confidence.toFixed(2)}（${input.route.reason}）`);

    // 2. 记忆召回质量：召回 0 条且非闲聊 → 降置信
    if (input.recallItems.length === 0 && input.route.mode !== "fast") {
      confidence -= 0.15;
      uncertaintySources.push("无相关记忆召回");
      evidence.push("记忆召回 0 条，扣 0.15");
    } else if (input.recallItems.length >= 3) {
      confidence += 0.05;
      evidence.push(`记忆召回 ${input.recallItems.length} 条，加 0.05`);
    }

    // 3. 能力匹配：无能力但路由要求工具 → 降置信
    if (input.route.mode === "complex" && input.capabilities.length === 0) {
      confidence -= 0.2;
      uncertaintySources.push("无可用能力支撑委派任务");
      evidence.push("能力列表为空但要求委派，扣 0.2");
    }

    // 4. 用户表达模糊 → 降置信
    const lowerText = input.userText.toLowerCase();
    const vagueHits = VAGUE_INDICATORS.filter((kw) => lowerText.includes(kw));
    if (vagueHits.length > 0) {
      confidence -= 0.1 * Math.min(vagueHits.length, 3);
      uncertaintySources.push(`用户表达模糊：${vagueHits.join(",")}`);
      uncertaintyMarkers.push("需要澄清用户意图");
      evidence.push(`模糊词命中 ${vagueHits.length} 个，扣 ${0.1 * Math.min(vagueHits.length, 3)}`);
    }

    // 5. 能力缺口自检
    const gapHits = CAPABILITY_GAP_INDICATORS.filter((kw) => lowerText.includes(kw));
    if (gapHits.length > 0) {
      confidence -= 0.2;
      uncertaintySources.push(`能力缺口指示：${gapHits.join(",")}`);
      uncertaintyMarkers.push("明确表达不确定");
      evidence.push(`能力缺口指示命中，扣 0.2`);
    }

    // 6. 路由默认值（no_match）→ 中等不确定性
    if (input.route.matchedRules.some((r) => r.startsWith("no_match"))) {
      uncertaintySources.push("路由规则未命中（fallback 路径）");
      uncertaintyMarkers.push("建议先确认用户意图");
      evidence.push("路由走 fallback，标记中等不确定");
    }

    // 7. 限制在 [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    // 8. 自我怀疑累积
    const prevDoubt = this.selfDoubt.get(actorId) ?? 0;
    const newDoubt = (1 - confidence) * 0.3 + prevDoubt * SELT_DOUBT_DECAY;
    this.selfDoubt.set(actorId, newDoubt);

    // 9. 是否建议反思
    const shouldReflect = confidence < REFLECTION_THRESHOLD;
    const reflectionReason = shouldReflect
      ? `置信度 ${confidence.toFixed(2)} < ${REFLECTION_THRESHOLD}，建议反思`
      : undefined;
    if (shouldReflect) this.reflectionTriggeredCount++;

    evidence.push(`自我怀疑水平=${newDoubt.toFixed(2)}`);

    return {
      confidence,
      uncertaintySources,
      shouldReflect,
      reflectionReason,
      selfDoubtLevel: newDoubt,
      uncertaintyMarkers,
      evidence,
      assessedAt: new Date().toISOString(),
    };
  }

  /** 记录反思结果 */
  recordReflection(actorId: string, trigger: string, context: string, outcome: ReflectionRecord["outcome"]): void {
    const list = this.reflections.get(actorId) ?? [];
    list.push({
      id: `reflect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorId,
      trigger,
      context,
      outcome,
      createdAt: new Date().toISOString(),
    });
    // 只保留最近 20 条
    if (list.length > 20) list.shift();
    this.reflections.set(actorId, list);

    // 反思后调整自我怀疑：confirmed → 降低怀疑；corrected → 提升怀疑；abandoned → 不变
    const cur = this.selfDoubt.get(actorId) ?? 0;
    if (outcome === "confirmed") this.selfDoubt.set(actorId, cur * 0.5);
    else if (outcome === "corrected") this.selfDoubt.set(actorId, Math.min(1, cur + 0.2));

    // P1-12：把反思结果转化为奖励信号并缓存，供世界模型读取
    const rewardSignal: RewardSignal = {
      actorId,
      reward: rewardForOutcome(outcome),
      trigger,
      context,
      outcome,
      createdAt: new Date().toISOString(),
    };
    const signals = this.rewardSignals.get(actorId) ?? [];
    signals.push(rewardSignal);
    if (signals.length > MAX_REWARD_SIGNALS_PER_ACTOR) signals.shift();
    this.rewardSignals.set(actorId, signals);
  }

  /**
   * 记录预测结果对错（P1-12 桥接方法）。
   *
   * 当 PredictiveCodingCortex / ActionExecutor 拿到 (stateBefore, action, stateAfter)
   * 并对比 WorldModel.predict 的预测后，调此方法把"预测对错"反馈给元认知 + 世界模型：
   *   1. 内部调 recordReflection() 记录一条反思（outcome=confirmed/corrected）
   *   2. 若 worldModel 已注入，调 worldModel.update() 把 (s, a, s') 喂给世界模型学习
   *
   * 这是"反思奖励信号 → 世界模型学习"的闭环入口。
   *
   * @param actorId 关联 actor
   * @param stateBefore 动作前状态
   * @param action 执行的动作
   * @param stateAfter 实际动作后状态
   * @param predictionSuccess 预测是否正确（true=confirmed，false=corrected）
   * @param trigger 反思触发来源描述（默认 "prediction_outcome"）
   * @returns 世界模型返回的预测误差（0=完全准确，1=完全错误）；worldModel 未注入时返回 null
   */
  async recordPredictionOutcome(
    actorId: string,
    stateBefore: WorldState,
    action: WorldAction,
    stateAfter: WorldState,
    predictionSuccess: boolean,
    trigger: string = "prediction_outcome",
  ): Promise<number | null> {
    const outcome: ReflectionRecord["outcome"] = predictionSuccess ? "confirmed" : "corrected";
    const contextSummary = `动作 ${action.tool} 预测${predictionSuccess ? "正确" : "错误"}`;
    // 1. 记录反思 + 缓存奖励信号
    this.recordReflection(actorId, trigger, contextSummary, outcome);

    // 2. 喂给世界模型学习（如果已注入）
    if (!this.worldModel) return null;
    try {
      const error = await this.worldModel.update(stateBefore, action, stateAfter);
      this.rewardFedToWorldModel++;
      return error;
    } catch (e) {
      console.error("[MetaCognitionCortex] worldModel.update 失败（忽略）:", e);
      return null;
    }
  }

  /**
   * 读取最近奖励信号（P1-12，供世界模型 / PredictiveCoding 读取）。
   *
   * 世界模型更新路径可基于此信号对学习率加权：
   *   - 正奖励（confirmed）→ 强化该转移样本
   *   - 负奖励（corrected/abandoned）→ 加大学习步长，修正预测
   */
  getRecentRewardSignals(actorId: string, limit = 5): RewardSignal[] {
    const list = this.rewardSignals.get(actorId) ?? [];
    return list.slice(-limit);
  }

  /** 读取最近奖励信号的滑动平均（[-1, 1]，无数据时返回 0） */
  getAverageReward(actorId: string): number {
    const list = this.rewardSignals.get(actorId) ?? [];
    if (list.length === 0) return 0;
    const sum = list.reduce((acc, s) => acc + s.reward, 0);
    return sum / list.length;
  }

  /** 获取最近反思记录 */
  getRecentReflections(actorId: string, limit = 5): ReflectionRecord[] {
    const list = this.reflections.get(actorId) ?? [];
    return list.slice(-limit);
  }

  /** 获取当前自我怀疑水平 */
  getSelfDoubtLevel(actorId: string): number {
    return this.selfDoubt.get(actorId) ?? 0;
  }

  getStats(): {
    assessmentCount: number;
    reflectionTriggeredCount: number;
    activeActors: number;
    rewardFedToWorldModel: number;
    worldModelRegistered: boolean;
  } {
    return {
      assessmentCount: this.assessmentCount,
      reflectionTriggeredCount: this.reflectionTriggeredCount,
      activeActors: this.selfDoubt.size,
      rewardFedToWorldModel: this.rewardFedToWorldModel,
      worldModelRegistered: this.worldModel !== null,
    };
  }

  async start(): Promise<void> {
    console.log("[MetaCognitionCortex] 启动完成");
  }
  async stop(): Promise<void> {
    this.selfDoubt.clear();
    this.reflections.clear();
    this.rewardSignals.clear();
    console.log("[MetaCognitionCortex] 已停止");
  }
}
