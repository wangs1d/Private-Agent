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
  finishReason: "done" | "max_rounds" | "failure" | "aborted" | "needs_escalation";
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
  readonly mode: LlmExecutionMode = "direct_llm";

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
 * - finished 恒为 false：让编排器调 ProgressTracker 评估后决定 onTrack→终止 / replan→重入
 *   （plan_execute 是多步骤任务，不能靠 strategy 自身判断是否完成）
 */
export class PlanExecuteLoopStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode = "plan_execute";

  constructor(private readonly provider: ExternalChatProvider) {}

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
    // 编排器在上一轮评估后写入 "replan:{deviation}" 标记，strategy 据此构造 replan prompt
    const replanReflection = ctx.reflections.find((r) => r.body.startsWith("replan:"));
    const isReplan = replanReflection && ctx.plan;

    const effectiveUserText = isReplan
      ? buildReplanPrompt(userTurn.text, ctx, replanReflection!)
      : userTurn.text;

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
    });

    ctx.budget.roundsUsed += 1;
    ctx.budget.modelCallsUsed += result.modelCalls;
    ctx.plan = result.plan;

    // P4：plan_execute 的 finished 由编排器（基于 ProgressTracker 评估）决定，不由 strategy 判定
    return {
      finalText: result.finalText,
      finished: false,
      finishReason: "done",
      toolCalls: roundToolCalls,
      modelCalls: Math.max(1, result.modelCalls),
      plan: result.plan,
    };
  }
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
// StateMachineStrategy —— P1 stub
// ────────────────────────────────────────────────────────────

/**
 * P1 stub：state_machine 路径暂由 AgentTaskOrchestrator 直接处理（agent-core 原分支）。
 * P3 阶段实现真正的单轮入口包装（runOnceForOrchestrator）。
 */
export class StateMachineStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode = "state_machine";

  canHandle(_ctx: SharedTaskContext): boolean {
    return false;
  }

  async run(_ctx: SharedTaskContext, _params: LoopRunParams): Promise<LoopRunResult> {
    throw new Error("StateMachineStrategy not implemented in P1");
  }
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
