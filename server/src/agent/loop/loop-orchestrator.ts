/**
 * Loop Orchestrator - 编排器
 *
 * 在三种 loop 之上建立单一控制流：选 loop → 跑 loop → 评估 → 升级 → 终止。
 * P1 阶段仅接入 TerminationPolicy，Recovery/Progress/Escalation 为 NoOp 默认实现。
 *
 * 终止逻辑：
 * - strategy.run 返回 finished=true → 直接判定 goal_met（react/plan_execute 一次完成）
 * - finished=false → 交 TerminationPolicy 评估异常终止（budget/no_progress/max_failures）
 *
 * 详见 docs/loop-orchestrator-architecture.md §3.4
 */

import type { LlmExecutionMode } from "../task-router.js";
import type { TaskSeed, SharedTaskContext } from "./shared-task-context.js";
import { createSharedTaskContext } from "./shared-task-context.js";
import type { LoopStrategy, LoopRunParams, LoopRunResult } from "./loop-strategy.js";
import type {
  TerminationPolicy,
  RecoveryPolicy,
  ProgressTracker,
  EscalationPolicy,
} from "./policies.js";
import {
  NoOpRecoveryPolicy,
  NoOpProgressTracker,
  NoOpEscalationPolicy,
} from "./policies.js";
import { applyRetryBackoff } from "./default-recovery.js";

export interface OrchestratorResult {
  finalText: string;
  finished: boolean;
  terminateReason: string;
  ctx: SharedTaskContext;
  /** 整个编排过程消耗的模型调用次数 */
  modelCalls: number;
  /** 发生过的 loop 升级事件 */
  loopSwitches: SharedTaskContext["loopSwitches"];
  /**
   * 反思环节是否耗尽 replan 次数（激活原 PlanExecuteLoopResult.exhaustedRetries 语义）。
   * true 表示 replan 达上限仍未 onTrack，或预算耗尽。
   */
  exhaustedRetries: boolean;
  /**
   * 最近一次 ProgressTracker 评估的反思文本（激活原 PlanExecuteLoopResult.verifyReflection 语义）。
   * 取 ctx.reflections 中最近一条非 "replan:" 标记的 body；无评估时为空串。
   */
  verifyReflection: string;
}

export interface LoopOrchestratorOptions {
  termination?: TerminationPolicy;
  recovery?: RecoveryPolicy;
  progress?: ProgressTracker;
  escalation?: EscalationPolicy;
  /** plan_execute replan 上限，超过则放弃并告知用户。默认 2。 */
  maxReplans?: number;
}

export class LoopOrchestrator {
  private readonly termination: TerminationPolicy;
  private readonly recovery: RecoveryPolicy;
  private readonly progress: ProgressTracker;
  private readonly escalation: EscalationPolicy;
  private readonly maxReplans: number;

  constructor(
    private readonly strategies: Map<LlmExecutionMode, LoopStrategy>,
    opts: LoopOrchestratorOptions = {},
  ) {
    this.termination = opts.termination ?? new (class implements TerminationPolicy {
      shouldTerminate() {
        return { terminate: false };
      }
    })();
    this.recovery = opts.recovery ?? new NoOpRecoveryPolicy();
    this.progress = opts.progress ?? new NoOpProgressTracker();
    this.escalation = opts.escalation ?? new NoOpEscalationPolicy();
    this.maxReplans = opts.maxReplans ?? 2;
  }

  /**
   * 跑一个完整任务（从 initialMode 开始，可升级）。
   * P1：react/plan_execute 通常一轮即 finished=true 终止。
   */
  async run(
    seed: TaskSeed,
    params: LoopRunParams,
  ): Promise<OrchestratorResult> {
    const ctx = createSharedTaskContext(seed);
    let mode: LlmExecutionMode = seed.initialMode;
    let lastResult: LoopRunResult | null = null;
    let finalText = "";
    let terminateReason = "unknown";

    // 上限保护：即使策略全部 no-op，也不会无限循环
    const hardMaxIterations = Math.max(1, ctx.budget.maxRounds);

    for (let iteration = 0; iteration < hardMaxIterations; iteration++) {
      // 1. 终止检查（每轮前，基于上一轮写入的 ctx 状态）
      const term = this.termination.shouldTerminate(ctx);
      if (term.terminate) {
        terminateReason = term.reason ?? "terminated";
        finalText = ctx.finalText ?? finalText;
        break;
      }

      // 2. 选 strategy
      const strategy = this.strategies.get(mode);
      if (!strategy || !strategy.canHandle(ctx)) {
        terminateReason = "no_strategy";
        finalText = ctx.finalText ?? lastResult?.finalText ?? "";
        break;
      }

      // 3. 跑一轮
      ctx.currentLoop = mode;
      lastResult = await strategy.run(ctx, params);
      finalText = lastResult.finalText;

      // 4. finished=true → 直接判定完成（react/plan_execute 一次完成）
      if (lastResult.finished) {
        ctx.finalText = lastResult.finalText;
        terminateReason = "goal_met";
        break;
      }

      // 5. needs_escalation → 交升级策略（P1 no-op，直接终止）
      if (lastResult.finishReason === "needs_escalation") {
        const esc = this.escalation.shouldEscalate(ctx, lastResult);
        if (esc.escalate && esc.to && this.canEscalate(mode, esc.to)) {
          ctx.loopSwitches.push({
            from: mode,
            to: esc.to,
            reason: esc.reason,
            atRound: ctx.budget.roundsUsed,
            timestamp: Date.now(),
          });
          mode = esc.to;
          continue;
        }
        terminateReason = "needs_escalation";
        break;
      }

      // 6. 失败恢复（P2：确定性 fallback，不调 LLM）
      //    对本轮失败的 toolCalls 调 recovery.onFailure，记录 injectHint 到 ctx.reflections
      //    注意：react 单轮路径通常 finished=true 不走到这里；
      //    此逻辑为 state_machine/P3 多轮场景预留，以及 finished=false 的异常路径
      const failedCalls = lastResult.toolCalls.filter((t) => !t.ok);
      let shouldEscalateFromRecovery = false;
      for (const fc of failedCalls) {
        const failure = this.findOrCreateFailure(ctx, fc);
        const action = this.recovery.onFailure(ctx, failure);
        if (action.injectHint) {
          ctx.reflections.push({
            loop: mode,
            round: ctx.budget.roundsUsed,
            body: action.injectHint,
            confidence: 0.8,
          });
        }
        // retry 前指数退避（200ms × 2^attempts，封顶 2s）
        if (action.type === "retry") {
          await applyRetryBackoff(failure.attempts);
        }
        if (action.type === "escalate") {
          shouldEscalateFromRecovery = true;
          break;
        }
        if (action.type === "give_up") {
          terminateReason = "recovery_give_up";
          break;
        }
      }
      if (shouldEscalateFromRecovery) {
        // recovery 建议升级 → 交升级策略
        const esc = this.escalation.shouldEscalate(ctx, lastResult);
        if (esc.escalate && esc.to && this.canEscalate(mode, esc.to)) {
          ctx.loopSwitches.push({
            from: mode,
            to: esc.to,
            reason: `recovery:${esc.reason}`,
            atRound: ctx.budget.roundsUsed,
            timestamp: Date.now(),
          });
          mode = esc.to;
          continue;
        }
      }
      if (terminateReason === "recovery_give_up") break;

      // 7. 进展评估（P3+P4：低频 LLM 辅助 + 驱动 replan）
      const assessment = await this.progress.assess(ctx);

      // 8. onTrack → 目标达成，终止（plan_execute 的完成由评估决定，非 strategy.finished）
      if (assessment.onTrack) {
        ctx.finalText = lastResult.finalText;
        terminateReason = "goal_met";
        break;
      }

      // 9. !onTrack → 记录评估反馈
      ctx.reflections.push({
        loop: mode,
        round: ctx.budget.roundsUsed,
        body: assessment.deviation ?? "偏离轨道",
        confidence: assessment.progressScore,
      });

      // 10. replan 决策（P4：两者结合，最多 maxReplans 次）
      if (assessment.recommendation === "replan" && mode === "complex") {
        if (ctx.replanCount < this.maxReplans) {
          ctx.replanCount += 1;
          // 写 "replan:" 标记，strategy 下一轮检测到后构造 replan prompt
          ctx.reflections.push({
            loop: mode,
            round: ctx.budget.roundsUsed,
            body: `replan:${assessment.deviation ?? "偏离轨道"}`,
            confidence: assessment.progressScore,
          });
          continue; // 下一轮：strategy 进入 replan 模式
        }
        // replan 次数耗尽 → 放弃并告知用户
        ctx.finalText = lastResult.finalText;
        terminateReason = "replan_exhausted";
        break;
      }

      // 11. escalate 决策（评估建议升级 或 EscalationPolicy 判断）
      const esc = this.escalation.shouldEscalate(ctx, lastResult);
      if (esc.escalate && esc.to && this.canEscalate(mode, esc.to)) {
        ctx.loopSwitches.push({
          from: mode,
          to: esc.to,
          reason: esc.reason,
          atRound: ctx.budget.roundsUsed,
          timestamp: Date.now(),
        });
        mode = esc.to;
        continue;
      }

      // 12. 预算兜底
      if (ctx.budget.roundsUsed >= ctx.budget.maxRounds) {
        terminateReason = "budget_exhausted";
        break;
      }
    }

    if (!lastResult && terminateReason === "unknown") {
      terminateReason = "no_iteration";
    }

    // 激活反思字段：exhaustedRetries 来自 replan_exhausted / budget_exhausted；
    // verifyReflection 取最近一条非 "replan:" 标记的评估反馈（无则为空串）。
    const exhaustedRetries =
      terminateReason === "replan_exhausted" || terminateReason === "budget_exhausted";
    let verifyReflection = "";
    for (let i = ctx.reflections.length - 1; i >= 0; i--) {
      const r = ctx.reflections[i];
      if (!r.body.startsWith("replan:")) {
        verifyReflection = r.body;
        break;
      }
    }

    return {
      finalText,
      finished: terminateReason === "goal_met",
      terminateReason,
      ctx,
      modelCalls: ctx.budget.modelCallsUsed,
      loopSwitches: ctx.loopSwitches,
      exhaustedRetries,
      verifyReflection,
    };
  }

  /** 单向升级校验：只允许向更强 loop 升级，禁止回退以防抖动。 */
  private canEscalate(from: LlmExecutionMode, to: LlmExecutionMode): boolean {
    const order: LlmExecutionMode[] = ["fast", "complex"];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    return toIdx > fromIdx;
  }

  /** 从 ctx.failures 查找或创建 FailureRecord（按 toolName 聚合 attempts）。 */
  private findOrCreateFailure(
    ctx: SharedTaskContext,
    tc: import("./shared-task-context.js").ToolCallRecord,
  ): import("./shared-task-context.js").FailureRecord {
    const existing = ctx.failures.find((f) => f.toolName === tc.name);
    if (existing) {
      existing.attempts += 1;
      existing.error = tc.error ?? "unknown";
      existing.timestamp = Date.now();
      return existing;
    }
    const failure: import("./shared-task-context.js").FailureRecord = {
      toolName: tc.name,
      category: this.inferCategory(tc.name),
      args: tc.args,
      error: tc.error ?? "unknown",
      attempts: 1,
      timestamp: Date.now(),
    };
    ctx.failures.push(failure);
    return failure;
  }

  /** 简易分类推断（P2 过渡；P3 元数据层就绪后由 tool-metadata 提供）。 */
  private inferCategory(toolName: string): string {
    const dotIdx = toolName.indexOf(".");
    if (dotIdx > 0) return toolName.slice(0, dotIdx);
    const underIdx = toolName.indexOf("_");
    if (underIdx > 0) return toolName.slice(0, underIdx);
    return "misc";
  }
}
