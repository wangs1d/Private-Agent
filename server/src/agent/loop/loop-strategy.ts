/**
 * Loop Orchestrator - LoopStrategy 接口与三个包装实现
 *
 * 把现有三种 loop（React / Plan-Execute / State-Machine）收敛到统一接口后面。
 * P1 阶段：React/PlanExecute 完成包装，StateMachine 为 stub（state_machine 路径暂不接管）。
 * 内部实现不改 loop 逻辑，只做参数适配与结果归一化。
 *
 * 详见 docs/loop-orchestrator-architecture.md §3.2
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { LlmExecutionMode } from "../task-router.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
} from "../../external-model/types.js";
import type { TaskExecutionPlan } from "../plan-execute-loop.js";
import { runPlanExecuteLoop } from "../plan-execute-loop.js";
import type { SharedTaskContext, ToolCallRecord } from "./shared-task-context.js";
import { appendToolCall } from "./shared-task-context.js";

// ────────────────────────────────────────────────────────────
// 接口
// ────────────────────────────────────────────────────────────

export interface LoopStrategy {
  readonly mode: LlmExecutionMode;
  /** 编排器在选 loop 时问一句：你能在当前 ctx 下接着跑吗 */
  canHandle(ctx: SharedTaskContext): boolean;
  /** 跑一轮（受 budget 与 signal 约束），返回归一化结果 */
  run(ctx: SharedTaskContext, params: LoopRunParams): Promise<LoopRunResult>;
}

export interface LoopRunParams {
  sessionId: string;
  userTurn: ChatUserTurn;
  toolCtx: ChatToolExecutionContext;
  streamOpts: AgentStreamOptions | undefined;
  onDelta?: StreamDeltaHandler;
  signal?: AbortSignal;
}

export interface LoopRunResult {
  finalText: string;
  /** true = 目标已达成（可终止） */
  finished: boolean;
  finishReason:
    | "done"
    | "max_rounds"
    | "failure"
    | "aborted"
    | "needs_escalation"
    | "budget_exhausted"
    | "plan_complete";
  /** 本轮新增的工具调用（已合并进 ctx.toolHistory） */
  toolCalls: ToolCallRecord[];
  modelCalls: number;
  reflections?: string[];
  /** Plan-Execute 产出的计划（仅 plan_execute 模式） */
  plan?: TaskExecutionPlan | null;
}

// ────────────────────────────────────────────────────────────
// ReactLoopStrategy —— 包装 provider.streamCompletion
// ────────────────────────────────────────────────────────────

/**
 * 包装现有 React 工具环（provider.streamCompletion 内部调 streamCompletionWithTools）。
 * 通过 onAfterToolBatch 回调把 ToolLoopAfterBatchInfo 同步进 ctx.toolHistory。
 * 一次 provider 调用即一个完整的多轮工具循环，返回时通常 finished=true。
 */
export class ReactLoopStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode = "fast";

  constructor(private readonly provider: ExternalChatProvider) {}

  canHandle(_ctx: SharedTaskContext): boolean {
    return this.provider.isEnabled();
  }

  async run(ctx: SharedTaskContext, params: LoopRunParams): Promise<LoopRunResult> {
    const { sessionId, userTurn, toolCtx, onDelta, signal } = params;

    // 收集本轮新增的 toolCalls（供编排器 recovery 检查失败项）
    const roundToolCalls: ToolCallRecord[] = [];

    // 包装 onAfterToolBatch：在原回调之外同步 ctx.toolHistory
    const originalOnAfterBatch = params.streamOpts?.toolLoop?.onAfterToolBatch;
    const wrappedStreamOpts: AgentStreamOptions | undefined = params.streamOpts
      ? {
          ...params.streamOpts,
          toolLoop: {
            ...(params.streamOpts.toolLoop ?? {}),
            onAfterToolBatch: (info: ToolLoopAfterBatchInfo) => {
              const batch = syncBatchToCtx(ctx, info, ctx.budget.roundsUsed);
              roundToolCalls.push(...batch);
              originalOnAfterBatch?.(info);
            },
          },
        }
      : {
          toolLoop: {
            onAfterToolBatch: (info: ToolLoopAfterBatchInfo) => {
              const batch = syncBatchToCtx(ctx, info, ctx.budget.roundsUsed);
              roundToolCalls.push(...batch);
            },
          },
        };

    if (signal?.aborted) {
      return { finalText: "", finished: false, finishReason: "aborted", toolCalls: [], modelCalls: 0 };
    }

    const finalText = await this.provider.streamCompletion(
      sessionId,
      userTurn,
      onDelta ?? (() => {}),
      toolCtx,
      wrappedStreamOpts,
    );

    ctx.budget.roundsUsed += 1;
    ctx.budget.modelCallsUsed += 1;

    // provider 返回即表示本轮循环结束（finishReason=stop 或达 maxRounds）
    // 一次完整的 streamCompletion 通常已达成目标
    return {
      finalText,
      finished: true,
      finishReason: "done",
      toolCalls: roundToolCalls,
      modelCalls: 1,
    };
  }
}

// ────────────────────────────────────────────────────────────
// PlanExecuteLoopStrategy —— 包装 runPlanExecuteLoop
// ────────────────────────────────────────────────────────────

/**
 * 包装现有 plan-execute loop。复用其 plan 阶段产出写入 ctx.plan。
 *
 * P4 变更：
 * - 支持 replan：检测 ctx.reflections 中的 "replan:" 标记，构造 replan prompt
 * - 规则化完成判定：run 末尾用 assessFinishedByRules 基于 finalText/budget/failures/plan
 *   判定 finished，大部分成功任务直接终止，跳过编排器的 ProgressTracker.assess（可能含 LLM 调用）；
 *   规则无法判定时 finished=false，交编排器评估后决定 onTrack→终止 / replan→重入
 */
export class PlanExecuteLoopStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode = "complex";

  constructor(
    private readonly provider: ExternalChatProvider,
    /** replan 上限，需与 LoopOrchestrator 的 maxReplans 保持一致（默认 2）。 */
    private readonly maxReplans: number = 2,
  ) {}

  canHandle(_ctx: SharedTaskContext): boolean {
    return this.provider.isEnabled();
  }

  async run(ctx: SharedTaskContext, params: LoopRunParams): Promise<LoopRunResult> {
    const { sessionId, userTurn, toolCtx, streamOpts, onDelta, signal } = params;

    if (signal?.aborted) {
      return { finalText: "", finished: false, finishReason: "aborted", toolCalls: [], modelCalls: 0 };
    }

    // 收集本轮新增的 toolCalls（供编排器 recovery 检查失败项）
    const roundToolCalls: ToolCallRecord[] = [];

    // 包装 onToolBatchForExecute：同步 ctx.toolHistory
    const originalOnBatch = streamOpts?.toolLoop?.onAfterToolBatch;
    const onToolBatchForExecute = (info: ToolLoopAfterBatchInfo) => {
      const batch = syncBatchToCtx(ctx, info, ctx.budget.roundsUsed);
      roundToolCalls.push(...batch);
      originalOnBatch?.(info);
    };

    // ── replan 检测 ──
    // 编排器在上一轮评估后写入 "replan:{deviation}" 标记，strategy 据此构造 replan prompt。
    // 必须用 round 匹配当前 roundsUsed，避免命中历史标记导致"永远进入 replan"：
    //   编排器在 step 10 写入 marker 时 round=ctx.budget.roundsUsed，随后 continue；
    //   下一轮进入 strategy.run 时 roundsUsed 尚未被本方法自增，因此 marker.round === roundsUsed
    //   即代表"刚刚由编排器请求的 replan"。历史 marker 的 round < roundsUsed，自然被过滤。
    const replanReflection = ctx.reflections.find(
      (r) => r.body.startsWith("replan:") && r.round === ctx.budget.roundsUsed,
    );
    const isReplan = replanReflection && ctx.plan;

    const effectiveUserText = isReplan
      ? buildReplanPrompt(userTurn.text, ctx, replanReflection!)
      : userTurn.text;

    // ── 反思上下文 ──
    // 把 ctx 的 replanCount / 最近评估反馈透传给 runPlanExecuteLoop，激活
    // PlanExecuteLoopResult.exhaustedRetries / verifyReflection（不再恒 false/""）。
    const lastDeviation = pickLastDeviation(ctx);
    const reflectionContext = {
      replanCount: ctx.replanCount,
      maxReplans: this.maxReplans,
      lastDeviation,
    };

    const result = await runPlanExecuteLoop({
      provider: this.provider,
      planSessionId: sessionId,
      userText: effectiveUserText,
      ...(userTurn.visionFrames?.length ? { visionFrames: userTurn.visionFrames } : {}),
      onDelta,
      onPhaseStatus: undefined,
      onPlanReady: (plan) => {
        ctx.plan = { goal: plan.goal, steps: plan.steps } as TaskExecutionPlan;
      },
      toolCtx,
      baseStreamOpts: streamOpts,
      onToolBatchForExecute,
      reflectionContext,
    });

    ctx.budget.roundsUsed += 1;
    ctx.budget.modelCallsUsed += result.modelCalls;
    ctx.plan = result.plan;

    // P4 优化：规则化完成判定替代大部分 LLM 评估。
    // 成功完成的任务直接 finished=true，编排器跳过 ProgressTracker.assess（可能含 LLM 调用）；
    // 规则无法判定时 finished=false，交编排器评估（assess→replan）。
    const { finished, finishReason } = assessFinishedByRules(ctx, result.finalText);

    return {
      finalText: result.finalText,
      finished,
      finishReason,
      toolCalls: roundToolCalls,
      modelCalls: Math.max(1, result.modelCalls),
      plan: result.plan,
    };
  }
}

/**
 * 规则化完成判定（零 LLM）：基于 finalText / budget / failures / plan 进度判定任务是否完成。
 *
 * 判定优先级：
 * 1. finalText 非空 + 已跑 ≥1 轮 + 无持续失败工具（attempts<2）→ done
 * 2. 预算耗尽（roundsUsed >= maxRounds）→ budget_exhausted
 * 3. plan 全部步骤已在 completedSteps 中 → plan_complete
 * 4. 否则 → 未完成，交编排器决定是否 replan（可能调 ProgressTracker.assess）
 *
 * 这样大部分成功完成的任务不需要编排器再调 LLM 评估。
 */
function assessFinishedByRules(
  ctx: SharedTaskContext,
  finalText: string,
): { finished: boolean; finishReason: LoopRunResult["finishReason"] } {
  // 1. 有最终输出且无持续失败 → 视为完成
  const hasPersistentFailure = ctx.failures.some((f) => f.attempts >= 2);
  if (finalText.length > 0 && ctx.budget.roundsUsed >= 1 && !hasPersistentFailure) {
    return { finished: true, finishReason: "done" };
  }

  // 2. 预算耗尽 → 强制终止
  if (ctx.budget.roundsUsed >= ctx.budget.maxRounds) {
    return { finished: true, finishReason: "budget_exhausted" };
  }

  // 3. plan 全部步骤已完成 → 完成
  const plan = ctx.plan;
  if (plan && plan.steps.length > 0) {
    const allCompleted = plan.steps.every((s) =>
      ctx.progress.completedSteps.includes(s.id),
    );
    if (allCompleted) {
      return { finished: true, finishReason: "plan_complete" };
    }
  }

  // 4. 未判定完成 → 交编排器评估（finishReason 占位，编排器仅专项检查 needs_escalation）
  return { finished: false, finishReason: "done" };
}

/**
 * 取 ctx.reflections 中最近一条非 "replan:" 标记的 body，作为进展评估反馈。
 * 用于激活 verifyReflection（无评估时返回 undefined）。
 */
function pickLastDeviation(ctx: SharedTaskContext): string | undefined {
  for (let i = ctx.reflections.length - 1; i >= 0; i--) {
    const r = ctx.reflections[i];
    if (!r.body.startsWith("replan:")) return r.body;
  }
  return undefined;
}

/**
 * 构造 replan prompt（两者结合：严重偏离→完全重新规划，轻微→增量 replan）。
 *
 * @param originalGoal 用户原始目标
 * @param ctx 共享上下文（含前次 plan + completedSteps + 评估反馈）
 * @param replanReflection 编排器写入的 replan 标记（body="replan:{deviation}", confidence=progressScore）
 */
function buildReplanPrompt(
  originalGoal: string,
  ctx: SharedTaskContext,
  replanReflection: { body: string; confidence: number },
): string {
  const deviation = replanReflection.body.slice("replan:".length) || "偏离轨道";
  const isSevere = replanReflection.confidence < 0.3;
  const prevPlan = ctx.plan;
  const completedSteps = ctx.progress.completedSteps;
  const failedTools = ctx.failures
    .filter((f) => f.attempts >= 2)
    .map((f) => `${f.toolName}(${f.error})`)
    .join("、");

  if (isSevere) {
    // 严重偏离：完全重新规划
    return [
      `[重新规划] 前次计划严重偏离目标，需要从零重新制定计划。`,
      ``,
      `用户原始目标：${originalGoal}`,
      ``,
      `前次计划（已作废，仅供参考避免重复错误）：`,
      prevPlan ? JSON.stringify(prevPlan, null, 2) : "无",
      ``,
      `偏离原因：${deviation}`,
      failedTools ? `持续失败的工具：${failedTools}` : "",
      ``,
      `请完全重新分析任务，制定全新的执行计划。避免重复前次的错误路径。`,
    ].filter(Boolean).join("\n");
  }

  // 轻微偏离：增量 replan（保留已完成步骤，只重规划未完成部分）
  return [
    `[增量重新规划] 前次计划部分完成，需要对未完成部分重新规划。`,
    ``,
    `用户原始目标：${originalGoal}`,
    ``,
    `前次计划：`,
    prevPlan ? JSON.stringify(prevPlan, null, 2) : "无",
    ``,
    `已完成的步骤：${completedSteps.join("、") || "无"}`,
    `偏离原因：${deviation}`,
    failedTools ? `持续失败的工具：${failedTools}（请在新计划中换用替代方案）` : "",
    ``,
    `请保留已完成步骤的成果，仅对未完成/失败的部分重新规划。`,
  ].filter(Boolean).join("\n");
}

// ────────────────────────────────────────────────────────────
// 辅助
// ────────────────────────────────────────────────────────────

/** 把 ToolLoopAfterBatchInfo 同步进 ctx.toolHistory，返回本轮新增记录（供编排器 recovery 检查）。 */
function syncBatchToCtx(
  ctx: SharedTaskContext,
  info: ToolLoopAfterBatchInfo,
  round: number,
): ToolCallRecord[] {
  const batch: ToolCallRecord[] = [];
  for (const tr of info.toolResults) {
    const record: ToolCallRecord = {
      round,
      loop: ctx.currentLoop,
      name: tr.name,
      args: {},
      ok: tr.ok,
      resultSummary: "",
      durationMs: 0,
      timestamp: Date.now(),
    };
    appendToolCall(ctx, record);
    batch.push(record);
  }
  // 若本轮有工具成功，重置无进展计数
  if (info.toolResults.some((t) => t.ok)) {
    ctx.progress.consecutiveNoProgress = 0;
    ctx.progress.lastProgressRound = ctx.budget.roundsUsed;
  } else if (info.toolResults.length > 0) {
    ctx.progress.consecutiveNoProgress += 1;
  }
  return batch;
}

/** 编排器选 strategy 时用到的工具列表类型（预留，P2 元数据层使用）。 */
export type { ChatCompletionTool };
