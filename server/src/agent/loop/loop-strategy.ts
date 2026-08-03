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
// StateMachineStrategy —— stub（暂未接管 state_machine 路径）
// ────────────────────────────────────────────────────────────

/**
 * stub：state_machine 路径暂由 AgentTaskOrchestrator 直接处理（agent-core 原分支：
 * orchestrator.createAndRun 异步启动后台 runLoop，立即返回 taskId）。
 *
 * 当前未在本 Strategy 中实现包装，原因：AgentTaskOrchestrator 的执行模型与 LoopStrategy
 * 接口不兼容，强行包装需要改动 AgentTaskOrchestrator 的公开 API。具体分析如下：
 *
 * 1. 执行模型不匹配
 *    - LoopStrategy.run 期望"跑一轮 → 返回 LoopRunResult（同步等待完成）"，由编排器在
 *      轮次之间驱动 assess→replan→escalation。
 *    - AgentTaskOrchestrator.createAndRun 是 fire-and-forget：立即返回 taskId，主循环
 *      runLoop（private）在后台异步执行，直到 done/failed/paused/awaiting_approval。
 *    - 没有公开的"运行单轮并等待"或"运行至完成并等待"接口。runOneRound（private）虽是
 *      单轮语义，但与持久化 AgentTaskStore 强耦合（读/写 task 状态、子任务、历史）。
 *
 * 2. 状态/进度同步缺口
 *    - LoopStrategy 需要把每轮 toolCalls 同步进 SharedTaskContext.toolHistory 供
 *      RecoveryPolicy/ProgressTracker 使用；AgentTaskOrchestrator 把进度写进
 *      AgentTaskStore（独立存储），并通过 onProgress/onToolExecuted 回调外推，
 *      不会写入 SharedTaskContext。
 *    - 终止判定也不同：编排器用 TerminationPolicy + ProgressTracker；AgentTaskOrchestrator
 *      用 maxRounds + LLM 文本标记（"任务完成"/"任务失败"）+ awaiting_approval 流转。
 *
 * 3. 推荐集成方案（后续迭代，需对 AgentTaskOrchestrator 做 API 增量，不破坏现有 state_machine 路径）
 *    方案 A（推荐，对齐编排器逐轮模型）：
 *      - 在 AgentTaskOrchestrator 上新增公开方法
 *          runOnceForOrchestrator(taskId, options): Promise<LoopRunResultLike>
 *        内部调用现有 runOneRound 逻辑，但把 toolCalls/assistantText/状态迁移结果
 *        映射为 LoopRunResult（finished = task 进入 done/failed；finishReason 映射
 *        awaiting_approval→needs_escalation、failed→failure）。
 *      - 首次调用前用 createAndRun 创建 task（不启动后台 runLoop），或新增
 *          createForOrchestrator(input): string 只建任务不启动循环。
 *      - canHandle 检查 desktopBridgeOnline / phoneBridgeOnline（桌面自动化在线才接管）。
 *      - 通过 options.onToolExecuted 把工具结果同步进 SharedTaskContext.toolHistory
 *        （复用 syncBatchToCtx 思路）。
 *    方案 B（简单但牺牲编排器反思）：
 *      - 新增 runToCompletion(input, options): Promise<AgentTask> 等待后台 runLoop 结束。
 *      - Strategy.run 一次性 await 它，返回 finished=true；编排器无法在 state_machine
 *        路径做 assess→replan（state_machine 本身已是状态机驱动，不需要 replan），
 *        仅做 budget/termination 兜底。适合 state_machine 不参与反思环节的定位。
 *    两种方案都需避免与 agent-core 现有 state_machine 分支重复执行：接管后应在
 *    agent-core.ts 把 state_machine 路径也交给 LoopOrchestrator（去掉 createAndRun 直调）。
 *
 * 4. 风险点
 *    - AgentTaskOrchestrator 的 awaiting_approval 流程需要人工 approve/reject，与编排器
 *      的同步 run 循环冲突（编排器无法等待人工）。方案 A 需把 awaiting_approval 映射为
 *      finishReason: "needs_escalation" 让编排器终止，或新增 "paused" 语义。
 *    - STATE_MACHINE_TOOL_ALLOWLIST 与编排器 toolExposureProfile 的协同需对齐。
 *
 * 在上述方案落地前，state_machine 路径保持 agent-core 原分支（createAndRun），
 * canHandle 返回 false 确保编排器不会误选本 Strategy。
 */
export class StateMachineStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode = "complex";

  canHandle(_ctx: SharedTaskContext): boolean {
    // 接管前返回 false，编排器不会选中；state_machine 走 agent-core 原分支。
    return false;
  }

  async run(_ctx: SharedTaskContext, _params: LoopRunParams): Promise<LoopRunResult> {
    throw new Error(
      "StateMachineStrategy not implemented: state_machine 路径暂由 AgentTaskOrchestrator 直接处理，" +
        "详见本类上方 TODO 集成方案注释。",
    );
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
