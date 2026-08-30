// 仲裁层（唯一决策口）：保质期 → 负反馈抑制 → 静默择时 → 分层预算 → 在场择时。
// 纯规则零 LLM（LLM 只出现在 speak 话术生成与可选竞争仲裁），确定可测。
import type { ArbitrationDecision, ProactiveImportance, ProactiveProposal, PresenceState } from "./pipeline-types.js";

export type GovernorVerdict = { allowed: boolean; reason: string };

export type ArbiterContext = {
  now: number;
  presence: PresenceState;
  /** 对话进行中：active 且 90s 内有交互（非 interruptible 提案短延迟，不打断） */
  inConversation: boolean;
  isSuppressed: (actorId: string, kind: string, text: string) => { suppressed: boolean; reason: string };
  /** 社交层预算查询（FrequencyGovernor.canTrigger 薄包装；must 层不查） */
  socialCanTrigger: (actorId: string, kind: string, importance: "high" | "medium" | "low") => GovernorVerdict;
};

export const QUIET_HOUR_START = 23;
export const QUIET_HOUR_END = 7;
/** 对话进行中的判定窗口 */
export const IN_CONVERSATION_WINDOW_MS = 90_000;
/** 对话中被打断提案的短延迟 */
export const CONVERSATION_DEFER_MS = 90_000;
/** 投递竞态重试间隔（仲裁时在线、发送时已全部掉线 → 待发区保留稍后重试，重连即达） */
export const DELIVERY_RETRY_MS = 30_000;

export function isQuietHourNow(d: Date): boolean {
  return d.getHours() >= QUIET_HOUR_START || d.getHours() < QUIET_HOUR_END;
}

/** 下一个静默结束时刻（静默期提案 defer 到早晨，而非丢弃） */
export function nextQuietEnd(now: Date): number {
  const end = new Date(now);
  end.setHours(QUIET_HOUR_END, 0, 0, 0);
  if (now.getHours() >= QUIET_HOUR_START) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export function arbitrate(p: ProactiveProposal, ctx: ArbiterContext): ArbitrationDecision {
  if (p.expiresAt !== undefined && p.expiresAt < ctx.now) {
    return { proposal: p, verdict: "expired", reasonChain: ["expired"] };
  }
  const suppression = ctx.isSuppressed(p.actorId, p.kind, `${p.title} ${p.summary}`);
  if (suppression.suppressed) {
    return { proposal: p, verdict: "suppressed", reasonChain: [`negative_feedback:${suppression.reason}`] };
  }
  const chain: string[] = [];
  // 静默时段：非 critical 择时到静默结束（defer 而非丢弃——"没发"与"择机发"是两种体验）
  if (isQuietHourNow(new Date(ctx.now)) && p.importance !== "critical") {
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: ["quiet_hours_defer_to_morning"],
      deliverAfter: Math.max(nextQuietEnd(new Date(ctx.now)), p.deliverAfter ?? 0),
    };
  }
  // 分层频控：must 层（用户点名要的事）绕过社交预算，不占社交配额
  if (p.tier === "social") {
    const importance = (p.importance === "critical" ? "high" : p.importance) as "high" | "medium" | "low";
    const verdict = ctx.socialCanTrigger(p.actorId, p.kind, importance);
    if (!verdict.allowed) {
      return { proposal: p, verdict: "throttled", reasonChain: [`frequency_governor:${verdict.reason}`] };
    }
  } else {
    chain.push("tier=must_bypass_social_budget");
  }
  // 在场择时：两端都不在线 → 挂起待重连（不落离线信箱；任一设备重连后 flush 立即直推）。
  // 对话中且不打断 → 短延迟（本轮对话结束再发，仅 social 层；must 层是用户点名要的事，即时直推）。
  // critical 默认允许打断。
  if (ctx.presence === "offline") {
    return { proposal: p, verdict: "deferred", reasonChain: [...chain, "offline_wait_reconnect"], deliverAfter: p.deliverAfter };
  }
  const interruptible = p.interruptible ?? p.importance === "critical";
  if (ctx.inConversation && p.tier !== "must" && !interruptible) {
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: [...chain, "in_conversation_defer_90s"],
      deliverAfter: ctx.now + CONVERSATION_DEFER_MS,
    };
  }
  return { proposal: p, verdict: "delivered", reasonChain: [...chain, "deliver_now"] };
}
