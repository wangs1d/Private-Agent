/**
 * Loop Orchestrator - 默认升级策略
 *
 * 单向升级（避免回环抖动）：
 *   direct_llm (react) → plan_execute → state_machine
 *
 * 触发条件：
 * - consecutiveNoProgress >= 3 且当前 react → 升级 plan_execute
 * - recovery 返回 escalate → 按 escalateTo 升级
 * - needs_escalation finishReason → 升一级
 * - plan_execute 重 plan 后仍 progressScore < 0.3 → 升级 state_machine
 *
 * 单向约束由编排器的 canEscalate 兜底，本策略只负责"建议升级"。
 *
 * 详见 docs/loop-orchestrator-architecture.md §5 Phase 3
 */

import type { LlmExecutionMode } from "../task-router.js";
import type { EscalationPolicy, EscalationDecision } from "./policies.js";
import type { SharedTaskContext } from "./shared-task-context.js";
import type { LoopRunResult } from "./loop-strategy.js";

export interface DefaultEscalationOptions {
  /** react 连续无进展多少轮后升级到 plan_execute，默认 3 */
  reactNoProgressThreshold?: number;
  /** plan_execute 评估分低于多少则升级到 state_machine，默认 0.3 */
  planExecuteScoreThreshold?: number;
}

const ESCALATION_ORDER: LlmExecutionMode[] = [
  "fast",
  "complex",
];

export class DefaultEscalationPolicy implements EscalationPolicy {
  constructor(private readonly opts: DefaultEscalationOptions = {}) {}

  shouldEscalate(ctx: SharedTaskContext, lastResult: LoopRunResult): EscalationDecision {
    const reactThreshold = this.opts.reactNoProgressThreshold ?? 3;
    const peScoreThreshold = this.opts.planExecuteScoreThreshold ?? 0.3;

    // 1. needs_escalation finishReason → 升一级
    if (lastResult.finishReason === "needs_escalation") {
      const next = this.nextLevel(ctx.currentLoop);
      if (next) {
        return { escalate: true, to: next, reason: "strategy_needs_escalation" };
      }
      return { escalate: false, reason: "already_at_top" };
    }

    // 2. react 卡住 → 升级 plan_execute
    if (
      ctx.currentLoop === "fast" &&
      ctx.progress.consecutiveNoProgress >= reactThreshold
    ) {
      return {
        escalate: true,
        to: "complex",
        reason: `react_no_progress_${ctx.progress.consecutiveNoProgress}`,
      };
    }

    // 3. complex 已是顶层模式，低分 reflection 不再升级（双模式下无更高级可升）
    if (ctx.currentLoop === "complex") {
      const lastReflection = ctx.reflections[ctx.reflections.length - 1];
      const score = lastReflection?.confidence ?? 1;
      if (score < peScoreThreshold) {
        // 已在顶层，无法继续升级；返回不升级，让编排器自行 replan 或终止
        return { escalate: false, reason: "already_at_top" };
      }
    }

    return { escalate: false, reason: "on_track" };
  }

  /** 返回下一级 loop mode，已在顶层则返回 null。 */
  private nextLevel(current: LlmExecutionMode): LlmExecutionMode | null {
    const idx = ESCALATION_ORDER.indexOf(current);
    if (idx < 0 || idx >= ESCALATION_ORDER.length - 1) return null;
    return ESCALATION_ORDER[idx + 1];
  }
}
