import type { LifeSignal } from "../../services/life-signal-types.js";
import type { LifeRhythmEngine } from "../engine.js";
import type { RhythmConsumer, RhythmProfileUpdate } from "../types.js";

/** 关怀 candidate 依赖的最小信号中枢接口 */
export type CandidateSignalHub = {
  publish(signal: LifeSignal): void;
};

/** 同一维度两条关怀 candidate 的最小间隔（3 天） */
const CANDIDATE_MIN_GAP_MS = 3 * 24 * 60 * 60 * 1000;
/** 主动关怀的模型置信度门槛 */
const MIN_CONFIDENCE = 0.7;

/**
 * 出口 C：节律异常 → 主动关怀 candidate。
 *
 * 不新建提醒类型、不绕过任何决策链：发布一条 source=agent_inference 的
 * rhythm_insight 生命信号，让它在 AnticipationEngine → 现有主动管线
 * （ProactiveLifeRuntimeService / BrainCenter）里走完整的频控/疲劳度/
 * 静默判定。引擎侧只做两道闸：洞察强度（notifiable）+ 每维度 3 天限频。
 */
export function createProactiveCandidateSourceConsumer(
  signalHub: CandidateSignalHub,
  engine: LifeRhythmEngine,
): RhythmConsumer {
  return async (update: RhythmProfileUpdate) => {
    const now = new Date();
    for (const insight of update.insights) {
      if (!insight.notifiable) continue;
      if ((update.confidences[insight.dimension] ?? 0) < MIN_CONFIDENCE) continue;
      const lastSent = update.profile.lastCandidateAt[insight.dimension];
      if (lastSent && now.getTime() - Date.parse(lastSent) < CANDIDATE_MIN_GAP_MS) continue;

      signalHub.publish({
        id: `${update.actorId}:rhythm:${insight.id}`,
        actorId: update.actorId,
        source: "agent_inference",
        kind: "rhythm_insight",
        title: "节律观察",
        summary: insight.text,
        tags: ["rhythm", "care", insight.dimension, insight.kind],
        importance: "low",
        evidence: insight.evidence,
        occurredAt: now.toISOString(),
        metadata: {
          dimension: insight.dimension,
          insightKind: insight.kind,
          confidence: insight.confidence,
          origin: "life-rhythm-engine",
        },
      });
      await engine.markCandidateSent(update.actorId, insight.dimension, now);
      console.log(`[RhythmCandidate] ${update.actorId} 发布关怀信号：${insight.text}`);
    }
  };
}
