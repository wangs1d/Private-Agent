/**
 * Loop Orchestrator - 四个可插拔策略接口
 *
 * 每个痛点对应一个策略，默认实现可替换。
 * P1 阶段仅 TerminationPolicy 有真实实现，其余用 NoOp 默认；
 * P2 接入 RecoveryPolicy，P3 接入 ProgressTracker + EscalationPolicy。
 *
 * 详见 docs/loop-orchestrator-architecture.md §3.3
 */

import type { LlmExecutionMode } from "../task-router.js";
import type {
  SharedTaskContext,
  FailureRecord,
} from "./shared-task-context.js";
import type { LoopRunResult } from "./loop-strategy.js";

// ────────────────────────────────────────────────────────────
// TerminationPolicy —— 解决"终止时机不智能"
// ────────────────────────────────────────────────────────────

export interface TerminationPolicy {
  shouldTerminate(ctx: SharedTaskContext): TerminationDecision;
}

export interface TerminationDecision {
  terminate: boolean;
  reason?:
    | "goal_met"
    | "no_progress"
    | "budget_exhausted"
    | "max_consecutive_failures"
    | "aborted";
  /** 注入给 LLM 的收尾提示（如"目标已达成，请总结"） */
  hint?: string;
}

// ────────────────────────────────────────────────────────────
// RecoveryPolicy —— 解决"工具失败后不会换策略"（P2）
// ────────────────────────────────────────────────────────────

export interface RecoveryPolicy {
  onFailure(ctx: SharedTaskContext, failure: FailureRecord): RecoveryAction;
}

export interface RecoveryAction {
  type: "retry" | "switch_tool" | "switch_args" | "escalate" | "give_up";
  /** switch_tool 时，从 TOOL_CATEGORY_MAPPINGS 同类里选 */
  alternativeTool?: string;
  alternativeArgs?: Record<string, unknown>;
  /** 替代/增强 buildToolFailureReminder 的注入提示 */
  injectHint?: string;
  escalateTo?: LlmExecutionMode;
}

// ────────────────────────────────────────────────────────────
// ProgressTracker —— 解决"复杂任务跑偏"（P3）
// ────────────────────────────────────────────────────────────

export interface ProgressTracker {
  assess(ctx: SharedTaskContext): Promise<ProgressAssessment>;
}

export interface ProgressAssessment {
  onTrack: boolean;
  /** 0..1 */
  progressScore: number;
  deviation?: string;
  recommendation: "continue" | "replan" | "escalate";
}

// ────────────────────────────────────────────────────────────
// EscalationPolicy —— 解决"动态编排"（P3）
// ────────────────────────────────────────────────────────────

export interface EscalationPolicy {
  shouldEscalate(ctx: SharedTaskContext, lastResult: LoopRunResult): EscalationDecision;
}

export interface EscalationDecision {
  escalate: boolean;
  to?: LlmExecutionMode;
  reason: string;
}

// ────────────────────────────────────────────────────────────
// NoOp 默认实现（P1 阶段占位，P2/P3 替换）
// ────────────────────────────────────────────────────────────

/** 不干预失败，交给 LLM 自行决策（等价于现有 prompt 引导行为）。 */
export class NoOpRecoveryPolicy implements RecoveryPolicy {
  onFailure(_ctx: SharedTaskContext, _failure: FailureRecord): RecoveryAction {
    return { type: "retry" };
  }
}

/** 不评估进展，永远建议继续（P3 用 DefaultProgressTracker 替换）。 */
export class NoOpProgressTracker implements ProgressTracker {
  async assess(_ctx: SharedTaskContext): Promise<ProgressAssessment> {
    return { onTrack: true, progressScore: 1, recommendation: "continue" };
  }
}

/** 不升级，永远留在当前 loop（P3 用 DefaultEscalationPolicy 替换）。 */
export class NoOpEscalationPolicy implements EscalationPolicy {
  shouldEscalate(_ctx: SharedTaskContext, _lastResult: LoopRunResult): EscalationDecision {
    return { escalate: false, reason: "no-op" };
  }
}
