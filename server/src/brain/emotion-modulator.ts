// Agent Brain Center — EmotionModulator（情绪调节器）
//
// 职责：让情绪真正影响路由决策，而不是仅作为 context 装饰字段。
//   模拟人脑杏仁核对前额叶的调节作用：
//   - 强负面情绪（valence < -0.5）→ 升级到更谨慎路由（complex）
//   - 高唤醒（arousal > 0.8）→ 急速响应路径（保持 fast 但需立即处理）
//   - 低唤醒 + 低效价 → 闲聊模式（可能用户无聊/疲惫）
//
// 核心机制：
//   1. modulateRoute(route, emotion)：基于情绪调整路由
//   2. modulateConfidence(confidence, emotion)：基于情绪调整置信度
//   3. shouldEscalate(emotion)：是否需要升级到更谨慎路径
//
// 深度链接：
//   - DecisionHub.decidePassive 阶段 2 调用
//   - 路由后置调整：影响最终 mode/confidence
//
// 设计要点：
//   - 纯规则，不调 LLM
//   - 保守策略：未注册或 emotion 为 null 时原样返回（不影响现有路由）

import type { EmotionVector } from "./types.js";
import type { RuleRouteDecision } from "./rule-router.js";

// ---- 纯文本情绪词库（关键字 → valence/arousal/dominance 偏移）---------
//
// 用于在没有 LLM 或 MoodInferenceService 时，基于用户输入文本
// 快速推断情绪向量。关键词匹配 + 简单统计，不调 LLM。

interface TextEmotionEntry {
  valence: number;   // -1..1
  arousal: number;   // 0..1
  dominance: number; // 0..1
}

const TEXT_EMOTION_LEXICON: Record<string, TextEmotionEntry> = {
  // 愤怒/不满
  "生气":    { valence: -0.8, arousal: 0.8, dominance: 0.6 },
  "愤怒":    { valence: -0.9, arousal: 0.9, dominance: 0.7 },
  "烦":      { valence: -0.5, arousal: 0.5, dominance: 0.3 },
  "烦躁":    { valence: -0.6, arousal: 0.6, dominance: 0.3 },
  "讨厌":    { valence: -0.7, arousal: 0.4, dominance: 0.4 },
  "恶心":    { valence: -0.7, arousal: 0.3, dominance: 0.3 },
  "滚":      { valence: -0.9, arousal: 0.8, dominance: 0.8 },
  "吵":      { valence: -0.5, arousal: 0.6, dominance: 0.3 },
  "闭嘴":    { valence: -0.8, arousal: 0.7, dominance: 0.9 },
  "投诉":    { valence: -0.6, arousal: 0.5, dominance: 0.5 },
  "差评":    { valence: -0.7, arousal: 0.4, dominance: 0.4 },
  "垃圾":    { valence: -0.7, arousal: 0.3, dominance: 0.3 },
  "傻了":    { valence: -0.4, arousal: 0.2, dominance: 0.2 },
  "有病":    { valence: -0.7, arousal: 0.5, dominance: 0.4 },
  "糟糕":    { valence: -0.6, arousal: 0.3, dominance: 0.2 },
  "失望":    { valence: -0.6, arousal: 0.2, dominance: 0.2 },
  "无语":    { valence: -0.4, arousal: 0.1, dominance: 0.1 },
  "崩溃":    { valence: -0.8, arousal: 0.7, dominance: 0.2 },
  "受不了":  { valence: -0.7, arousal: 0.6, dominance: 0.3 },
  "不行":    { valence: -0.3, arousal: 0.3, dominance: 0.2 },

  // 不满/否定
  "不对":    { valence: -0.3, arousal: 0.2, dominance: 0.3 },
  "不是":    { valence: -0.2, arousal: 0.1, dominance: 0.2 },
  "错了":    { valence: -0.4, arousal: 0.2, dominance: 0.3 },
  "错误":    { valence: -0.5, arousal: 0.2, dominance: 0.3 },
  "不好":    { valence: -0.4, arousal: 0.2, dominance: 0.2 },
  "没用":    { valence: -0.5, arousal: 0.1, dominance: 0.1 },
  "不要":    { valence: -0.3, arousal: 0.3, dominance: 0.4 },
 "没必要":  { valence: -0.3, arousal: 0.1, dominance: 0.2 },

  // 积极/满意
  "好":      { valence: 0.5, arousal: 0.3, dominance: 0.5 },
  "棒":      { valence: 0.7, arousal: 0.5, dominance: 0.6 },
  "赞":      { valence: 0.7, arousal: 0.4, dominance: 0.5 },
  "厉害":    { valence: 0.7, arousal: 0.5, dominance: 0.6 },
  "不错":    { valence: 0.5, arousal: 0.3, dominance: 0.5 },
  "优秀":    { valence: 0.7, arousal: 0.4, dominance: 0.6 },
  "完美":    { valence: 0.8, arousal: 0.4, dominance: 0.6 },
  "喜欢":    { valence: 0.7, arousal: 0.4, dominance: 0.5 },
  "开心":    { valence: 0.8, arousal: 0.5, dominance: 0.5 },
  "高兴":    { valence: 0.7, arousal: 0.4, dominance: 0.5 },
  "感谢":    { valence: 0.6, arousal: 0.3, dominance: 0.4 },
  "谢谢":    { valence: 0.5, arousal: 0.2, dominance: 0.4 },
  "牛逼":    { valence: 0.8, arousal: 0.6, dominance: 0.7 },
  "太棒了":  { valence: 0.9, arousal: 0.6, dominance: 0.7 },
  "出色":    { valence: 0.7, arousal: 0.4, dominance: 0.6 },
  "聪明":    { valence: 0.6, arousal: 0.3, dominance: 0.5 },
  "有趣":    { valence: 0.6, arousal: 0.4, dominance: 0.4 },
  "舒服":    { valence: 0.6, arousal: 0.2, dominance: 0.5 },
  "可以":    { valence: 0.3, arousal: 0.1, dominance: 0.4 },
  "没问题":  { valence: 0.4, arousal: 0.1, dominance: 0.5 },

  // 惊讶/急切
  "什么":    { valence: 0, arousal: 0.6, dominance: 0.3 },
  "真的":    { valence: 0.2, arousal: 0.5, dominance: 0.3 },
  "不会吧":  { valence: -0.1, arousal: 0.6, dominance: 0.2 },
  "赶紧":    { valence: 0, arousal: 0.7, dominance: 0.5 },
  "快":      { valence: 0.1, arousal: 0.7, dominance: 0.5 },
  "马上":    { valence: 0, arousal: 0.6, dominance: 0.5 },
  "快点":    { valence: -0.1, arousal: 0.7, dominance: 0.6 },
  "迅速":    { valence: 0.1, arousal: 0.6, dominance: 0.5 },
  "紧急":    { valence: -0.3, arousal: 0.8, dominance: 0.6 },
  "着急":    { valence: -0.3, arousal: 0.7, dominance: 0.4 },
  "立刻":    { valence: 0, arousal: 0.7, dominance: 0.6 },

  // 低落/疲惫
  "累":      { valence: -0.3, arousal: 0.1, dominance: 0.2 },
  "困":      { valence: -0.2, arousal: 0.1, dominance: 0.2 },
  "无聊":    { valence: -0.3, arousal: 0.1, dominance: 0.1 },
  "没意思":  { valence: -0.4, arousal: 0.1, dominance: 0.1 },
  "算了":    { valence: -0.3, arousal: 0.1, dominance: 0.1 },
  "随便":    { valence: -0.1, arousal: 0.1, dominance: 0.1 },
  "伤心":    { valence: -0.6, arousal: 0.2, dominance: 0.2 },
  "难过":    { valence: -0.5, arousal: 0.2, dominance: 0.2 },
  "哭":      { valence: -0.7, arousal: 0.3, dominance: 0.1 },
  "想哭":    { valence: -0.7, arousal: 0.3, dominance: 0.1 },

  // 英文情绪词
  "angry":   { valence: -0.8, arousal: 0.8, dominance: 0.6 },
  "mad":     { valence: -0.7, arousal: 0.7, dominance: 0.6 },
  "furious": { valence: -0.9, arousal: 0.9, dominance: 0.8 },
  "happy":   { valence: 0.8, arousal: 0.5, dominance: 0.6 },
  "great":   { valence: 0.7, arousal: 0.4, dominance: 0.6 },
  "awesome": { valence: 0.8, arousal: 0.5, dominance: 0.7 },
  "terrible":{ valence: -0.7, arousal: 0.3, dominance: 0.2 },
  "sad":     { valence: -0.5, arousal: 0.2, dominance: 0.2 },
  "tired":   { valence: -0.3, arousal: 0.1, dominance: 0.2 },
  "boring":  { valence: -0.3, arousal: 0.1, dominance: 0.1 },
  "excited": { valence: 0.7, arousal: 0.7, dominance: 0.6 },
  "urgent":  { valence: -0.2, arousal: 0.8, dominance: 0.6 },
  "hurry":   { valence: 0, arousal: 0.7, dominance: 0.5 },
  "thanks":  { valence: 0.5, arousal: 0.2, dominance: 0.4 },
  "please":  { valence: 0.2, arousal: 0.1, dominance: 0.3 },
  "sorry":   { valence: -0.3, arousal: 0.1, dominance: 0.2 },
  "wrong":   { valence: -0.4, arousal: 0.2, dominance: 0.3 },
  "stupid":  { valence: -0.6, arousal: 0.3, dominance: 0.3 },
  "wtf":     { valence: -0.7, arousal: 0.7, dominance: 0.5 },
  "omg":     { valence: 0.1, arousal: 0.7, dominance: 0.3 },
  "lol":     { valence: 0.5, arousal: 0.4, dominance: 0.4 },
  "haha":    { valence: 0.6, arousal: 0.4, dominance: 0.4 },
};

/** 情绪调节结果 */
export interface EmotionModulationResult {
  /** 调整后的路由（可能与原路由相同） */
  route: RuleRouteDecision;
  /** 调整原因 */
  reason: string;
  /** 是否真的调整了 */
  adjusted: boolean;
  /** 情绪影响等级 */
  level: "none" | "low" | "medium" | "high";
}

/**
 * 情绪调节器。
 *
 * 让情绪真正影响路由决策，模拟人脑杏仁核对前额叶的调节。
 */
export class EmotionModulator {
  private stats = {
    total: 0,
    adjusted: 0,
    escalated: 0,
  };

  /**
   * 基于情绪调整路由。
   *
   * 规则：
   *  - 强负面情绪（valence < -0.5）+ 非闲聊 → 升级 complex → complex
   *  - 高唤醒（arousal > 0.8）+ 闲聊 → 保持 fast（急速响应）
   *  - 低唤醒 + 低效价 + 闲聊 → 保持 fast
   *  - 其他 → 原样返回
   */
  modulateRoute(route: RuleRouteDecision, emotion: EmotionVector | null): EmotionModulationResult {
    this.stats.total++;

    if (!emotion) {
      return { route, reason: "无情绪数据", adjusted: false, level: "none" };
    }

    const { valence, arousal, dominance } = emotion;
    const isUrgent = valence < -0.5; // 强负面
    const isExcited = arousal > 0.8; // 高唤醒
    const isLowEnergy = arousal < 0.3 && valence < 0; // 低能量
    const isCasualMode = route.mode === "fast";

    // 1. 强负面情绪：升级到更谨慎路径
    if (isUrgent && isCasualMode && route.mode !== "complex") {
      // valence < -0.5 且当前是闲聊路径 → 升级到 complex
      const newRoute: RuleRouteDecision = {
        ...route,
        mode: "complex",
        reason: `${route.reason}；情绪调节：valence=${valence.toFixed(2)} 强负面，升级到 complex`,
        confidence: Math.max(route.confidence - 0.15, 0.4),
      };
      this.stats.adjusted++;
      this.stats.escalated++;
      return { route: newRoute, reason: "强负面情绪升级", adjusted: true, level: "high" };
    }

    // 2. 高唤醒 + 闲聊 → 保持 fast 但加急速标记
    if (isExcited && route.mode === "fast") {
      this.stats.adjusted++;
      return {
        route: { ...route, reason: `${route.reason}；情绪调节：arousal=${arousal.toFixed(2)} 高唤醒，急速响应` },
        reason: "高唤醒急速响应",
        adjusted: true,
        level: "medium",
      };
    }

    // 3. 低能量 + 低效价 + 闲聊 → 保持闲聊（可能用户无聊需要陪伴）
    if (isLowEnergy && route.mode === "fast") {
      this.stats.adjusted++;
      return {
        route: { ...route, reason: `${route.reason}；情绪调节：低能量低效价，保持陪伴` },
        reason: "低能量陪伴模式",
        adjusted: true,
        level: "low",
      };
    }

    // 4. dominance < 0.3（用户受支配感）+ 非闲聊 → 升级
    if (dominance < 0.3 && route.mode === "complex") {
      const newRoute: RuleRouteDecision = {
        ...route,
        mode: "complex",
        reason: `${route.reason}；情绪调节：dominance=${dominance.toFixed(2)} 低支配感，升级 complex`,
      };
      this.stats.adjusted++;
      this.stats.escalated++;
      return { route: newRoute, reason: "低支配感升级规划", adjusted: true, level: "medium" };
    }

    return { route, reason: "情绪无显著影响", adjusted: false, level: "none" };
  }

  /** 基于情绪调整置信度（保守策略） */
  modulateConfidence(confidence: number, emotion: EmotionVector | null): number {
    if (!emotion) return confidence;
    // 强负面 → 降置信度（更谨慎）
    if (emotion.valence < -0.5) return Math.max(confidence - 0.1, 0.3);
    // 高唤醒 → 略增置信度（更果断）
    if (emotion.arousal > 0.8) return Math.min(confidence + 0.05, 1.0);
    return confidence;
  }

  /** 是否需要升级到更谨慎路径 */
  shouldEscalate(emotion: EmotionVector | null): boolean {
    if (!emotion) return false;
    return emotion.valence < -0.5 || emotion.dominance < 0.3;
  }

  /**
   * 纯文本情绪推理：基于关键词词库从用户输入文本推断情绪向量。
   *
   * 关键词匹配 + 加权平均，不调 LLM，0 延迟。
   * 匹配到的每个关键词取其 valence/arousal/dominance 做算术平均，
   * 未匹配到任何关键词时返回 null（由调用方决定是否用默认值）。
   *
   * 与 LimbicCortex.inferEmotion 的关系：
   *  - LimbicCortex 走 MoodInferenceService（LLM 驱动，更准确但更慢）
   *  - 本方法纯规则，始终可用，适合作为 fallback 或快速预判
   *
   * @param text 用户输入文本
   * @param actorId 当前 actor
   * @returns EmotionVector 或 null（无匹配关键词）
   */
  inferFromText(text: string, actorId: string): EmotionVector | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    let matchedValence = 0;
    let matchedArousal = 0;
    let matchedDominance = 0;
    let matchCount = 0;

    for (const [keyword, entry] of Object.entries(TEXT_EMOTION_LEXICON)) {
      if (lower.includes(keyword)) {
        matchedValence += entry.valence;
        matchedArousal += entry.arousal;
        matchedDominance += entry.dominance;
        matchCount++;
      }
    }

    if (matchCount === 0) return null;

    // 加权平均，valence 用匹配次数做 Sigmoid 压缩避免极端值
    const sigmoid = (x: number) => 2 / (1 + Math.exp(-x / 3)) - 1;
    const avgValence = sigmoid(matchedValence);
    const avgArousal = Math.max(0, Math.min(1, matchedArousal / matchCount));
    const avgDominance = Math.max(0, Math.min(1, matchedDominance / matchCount));

    return {
      actorId,
      valence: Math.max(-1, Math.min(1, avgValence)),
      arousal: avgArousal,
      dominance: avgDominance,
      label: this._inferLabel(avgValence, avgArousal),
      confidence: Math.min(1, matchCount / 5), // 5 个关键词匹配 = 满置信
      detectedAt: new Date().toISOString(),
    };
  }

  /** 基于 VAD 推断情绪标签（简化版） */
  private _inferLabel(valence: number, arousal: number): string {
    if (valence < -0.5 && arousal > 0.6) return "angry";
    if (valence < -0.5 && arousal <= 0.3) return "sad";
    if (valence > 0.5 && arousal > 0.5) return "excited";
    if (valence > 0.5 && arousal <= 0.4) return "happy";
    if (arousal > 0.7 && Math.abs(valence) < 0.3) return "surprised";
    if (arousal < 0.2 && valence < 0) return "tired";
    if (arousal < 0.2) return "calm";
    return "neutral";
  }

  getStats(): { total: number; adjusted: number; escalated: number; adjustRate: number } {
    return {
      ...this.stats,
      adjustRate: this.stats.total > 0 ? this.stats.adjusted / this.stats.total : 0,
    };
  }

  async start(): Promise<void> {
    console.log("[EmotionModulator] 启动完成");
  }
  async stop(): Promise<void> {
    console.log("[EmotionModulator] 已停止");
  }
}
