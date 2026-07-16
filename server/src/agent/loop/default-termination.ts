/**
 * Loop Orchestrator - 默认终止策略
 *
 * P1 阶段的纯规则实现（零 LLM 调用）：
 * - budget_exhausted：预算（轮次/模型调用/时长）任一超限
 * - max_consecutive_failures：连续失败达阈值
 * - no_progress：连续无进展轮次达阈值
 * - goal_met：assistant 文本匹配完成标记（主要用于 state_machine 文本驱动场景；
 *   react/plan_execute 由编排器在 strategy.finished=true 时直接判定完成）
 *
 * 详见 docs/loop-orchestrator-architecture.md §5 Phase 1
 */

import type { TerminationPolicy, TerminationDecision } from "./policies.js";
import type { SharedTaskContext } from "./shared-task-context.js";
import { isBudgetExhausted } from "./shared-task-context.js";

/** 匹配 assistant 文本中的任务完成标记（参考状态机 parseLlmOutput 语义）。 */
const GOAL_MET_PATTERNS: RegExp[] = [
  /任务完成/,
  /任务已完成/,
  /已完成所有/,
  /全部完成/,
  /目标已达成/,
  /task\s*(is\s*)?(complete|done|finished)/i,
];

export interface DefaultTerminationOptions {
  /** 连续失败多少次后终止，默认 4 */
  maxConsecutiveFailures?: number;
  /** 连续无进展多少轮后终止，默认 3 */
  maxConsecutiveNoProgress?: number;
  /** 自定义完成标记正则（覆盖默认） */
  goalMetPatterns?: RegExp[];
}

export class DefaultTerminationPolicy implements TerminationPolicy {
  private readonly maxConsecutiveFailures: number;
  private readonly maxConsecutiveNoProgress: number;
  private readonly goalMetPatterns: RegExp[];

  constructor(opts: DefaultTerminationOptions = {}) {
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 4;
    this.maxConsecutiveNoProgress = opts.maxConsecutiveNoProgress ?? 3;
    this.goalMetPatterns = opts.goalMetPatterns ?? GOAL_MET_PATTERNS;
  }

  shouldTerminate(ctx: SharedTaskContext): TerminationDecision {
    // 1. 预算耗尽（最高优先级，防失控）
    if (isBudgetExhausted(ctx)) {
      return {
        terminate: true,
        reason: "budget_exhausted",
        hint: "已达执行预算上限，请基于已有结果总结回复。",
      };
    }

    // 2. 连续失败过多
    if (ctx.progress.consecutiveFailures >= this.maxConsecutiveFailures) {
      return {
        terminate: true,
        reason: "max_consecutive_failures",
        hint: `连续 ${ctx.progress.consecutiveFailures} 次工具调用失败，请停止重试并向用户说明情况。`,
      };
    }

    // 3. 连续无进展
    if (ctx.progress.consecutiveNoProgress >= this.maxConsecutiveNoProgress) {
      return {
        terminate: true,
        reason: "no_progress",
        hint: "已连续多轮无实质进展，请停止尝试并基于当前结果回复用户。",
      };
    }

    // 4. goal_met：assistant 文本匹配完成标记
    //    （react/plan_execute 通常由编排器在 strategy.finished=true 时直接判定，
    //     此处用于 state_machine 等靠文本驱动的场景）
    if (ctx.finalText) {
      const text = ctx.finalText;
      for (const pattern of this.goalMetPatterns) {
        if (pattern.test(text)) {
          return { terminate: true, reason: "goal_met" };
        }
      }
    }

    return { terminate: false };
  }
}
