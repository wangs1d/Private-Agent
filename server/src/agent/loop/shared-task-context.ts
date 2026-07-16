/**
 * Loop Orchestrator - 共享任务上下文
 *
 * 跨 React / Plan-Execute / State-Machine 三种 loop 流转的单一上下文对象。
 * 切换 loop 模式时不丢进度，是 TerminationPolicy / RecoveryPolicy 等策略的统一输入。
 *
 * 命名说明：区别于 agent/task-context.ts（turn 级 prompt 上下文），本文件是任务级执行控制上下文。
 *
 * 详见 docs/loop-orchestrator-architecture.md §3.1
 */

import type { LlmExecutionMode } from "../task-router.js";
import type { TaskExecutionPlan } from "../plan-execute-loop.js";

/** 跨 loop 流转的单一上下文，由 LoopOrchestrator 持有并传给各 Strategy / Policy。 */
export interface SharedTaskContext {
  taskId: string;
  actorId: string;
  sessionId: string;
  /** 用户原始目标（自然语言） */
  goal: string;

  /** Plan-Execute 阶段产出的计划；react/state_machine 模式下可为 null */
  plan: TaskExecutionPlan | null;
  progress: ProgressState;
  /** 跨 loop 统一的工具调用历史（压缩摘要，防止膨胀） */
  toolHistory: ToolCallRecord[];
  /** RecoveryPolicy 的输入：按 (toolName, argsHash) 聚合的失败记录 */
  failures: FailureRecord[];
  /** 跨 loop 累积的反思条目（借鉴 JarvisReflector 的 confidence 模式） */
  reflections: ReflectionEntry[];
  /** 统一预算，收口现在散落的 maxRounds(30/12/动态) */
  budget: BudgetTracker;

  /** 当前所在 loop 模式 */
  currentLoop: LlmExecutionMode;
  /** 升级/切换历史，用于可观测性与防抖动 */
  loopSwitches: LoopSwitchEvent[];

  /** replan 次数（plan_execute 专属，P4） */
  replanCount: number;

  /** 终止决策记录的最终结果（编排器 finalize 时写入） */
  finalText?: string;
}

export interface ProgressState {
  completedSteps: string[];
  currentStep: string | null;
  remainingSteps: string[];
  /** 上一次有实质进展的轮次序号，用于无进展检测 */
  lastProgressRound: number;
  /** 连续失败计数（成功一次即清零） */
  consecutiveFailures: number;
  /** 连续无新进展轮次（有新 step 完成或新工具成功即清零） */
  consecutiveNoProgress: number;
}

export interface ToolCallRecord {
  round: number;
  loop: LlmExecutionMode;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** 压缩后的结果摘要（复用 compactToolOutputForLlm 思路），避免上下文膨胀 */
  resultSummary: string;
  durationMs: number;
  error?: string;
  timestamp: number;
}

export interface FailureRecord {
  toolName: string;
  /** 取自 TOOL_CATEGORY_MAPPINGS（P2 元数据层就绪前的过渡字段） */
  category: string;
  args: Record<string, unknown>;
  error: string;
  /** 同工具 + 相似参数的连续失败次数（用于"同一 selector 超过 2 次"判断） */
  attempts: number;
  timestamp: number;
}

export interface ReflectionEntry {
  loop: LlmExecutionMode;
  round: number;
  body: string;
  /** 借鉴 JarvisReflector 的 confidence（0..1） */
  confidence: number;
}

export interface BudgetTracker {
  maxRounds: number;
  roundsUsed: number;
  maxModelCalls: number;
  modelCallsUsed: number;
  maxDurationMs: number;
  startedAt: number;
}

export interface LoopSwitchEvent {
  from: LlmExecutionMode;
  to: LlmExecutionMode;
  reason: string;
  atRound: number;
  timestamp: number;
}

/** 创建任务的初始输入（agent-core 集成时构造） */
export interface TaskSeed {
  taskId: string;
  actorId: string;
  sessionId: string;
  goal: string;
  /** 初始 loop 模式（由 routeLlmExecution 选定） */
  initialMode: LlmExecutionMode;
  /** 预算上限；不传则用默认值 */
  maxRounds?: number;
  maxModelCalls?: number;
  maxDurationMs?: number;
}

/** history / failures / reflections 的防膨胀上限 */
const MAX_TOOL_HISTORY = 100;
const MAX_FAILURES = 50;
const MAX_REFLECTIONS = 50;

export function createSharedTaskContext(seed: TaskSeed): SharedTaskContext {
  const now = Date.now();
  return {
    taskId: seed.taskId,
    actorId: seed.actorId,
    sessionId: seed.sessionId,
    goal: seed.goal,
    plan: null,
    progress: {
      completedSteps: [],
      currentStep: null,
      remainingSteps: [],
      lastProgressRound: 0,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
    },
    toolHistory: [],
    failures: [],
    reflections: [],
    budget: {
      maxRounds: seed.maxRounds ?? 12,
      roundsUsed: 0,
      maxModelCalls: seed.maxModelCalls ?? 20,
      modelCallsUsed: 0,
      maxDurationMs: seed.maxDurationMs ?? 5 * 60_000,
      startedAt: now,
    },
    currentLoop: seed.initialMode,
    loopSwitches: [],
    replanCount: 0,
  };
}

/** 追加工具调用记录，自动维持上限。 */
export function appendToolCall(ctx: SharedTaskContext, record: ToolCallRecord): void {
  ctx.toolHistory.push(record);
  if (ctx.toolHistory.length > MAX_TOOL_HISTORY) {
    ctx.toolHistory.splice(0, ctx.toolHistory.length - MAX_TOOL_HISTORY);
  }
  // 更新连续失败计数
  if (record.ok) {
    ctx.progress.consecutiveFailures = 0;
  } else {
    ctx.progress.consecutiveFailures += 1;
  }
}

/** 追加失败记录并聚合 attempts（同 toolName 视为同一失败链）。 */
export function appendFailure(ctx: SharedTaskContext, failure: FailureRecord): void {
  const existing = ctx.failures.find((f) => f.toolName === failure.toolName);
  if (existing) {
    existing.attempts += 1;
    existing.error = failure.error;
    existing.timestamp = failure.timestamp;
  } else {
    ctx.failures.push({ ...failure });
    if (ctx.failures.length > MAX_FAILURES) {
      ctx.failures.splice(0, ctx.failures.length - MAX_FAILURES);
    }
  }
}

/** 追加反思条目，自动维持上限。 */
export function appendReflection(ctx: SharedTaskContext, entry: ReflectionEntry): void {
  ctx.reflections.push(entry);
  if (ctx.reflections.length > MAX_REFLECTIONS) {
    ctx.reflections.splice(0, ctx.reflections.length - MAX_REFLECTIONS);
  }
}

/** 标记一个 step 完成，重置无进展计数。 */
export function markStepCompleted(ctx: SharedTaskContext, stepId: string): void {
  if (!ctx.progress.completedSteps.includes(stepId)) {
    ctx.progress.completedSteps.push(stepId);
  }
  ctx.progress.consecutiveNoProgress = 0;
  ctx.progress.lastProgressRound = ctx.budget.roundsUsed;
}

/** 预算是否已耗尽（轮次 / 模型调用 / 时长任一超限）。 */
export function isBudgetExhausted(ctx: SharedTaskContext): boolean {
  const b = ctx.budget;
  return (
    b.roundsUsed >= b.maxRounds ||
    b.modelCallsUsed >= b.maxModelCalls ||
    Date.now() - b.startedAt >= b.maxDurationMs
  );
}
