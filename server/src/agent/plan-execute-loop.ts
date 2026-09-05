/**
 * 「计划 → 执行（工具）」编排：与 OpenAI/Kimi Provider 的多轮工具环协作。
 *
 * 优化说明（2026-05-22）：
 * - 移除了"自检 → 重试"环节，减少 50%+ 的 LLM 调用次数
 * - 采用主流的 ReAct 风格：先计划，然后直接执行并通过工具环自动处理多轮调用
 * - 保留计划解析失败时的兜底逻辑，确保稳定性
 *
 * 环境变量：
 * - `AGENT_PLAN_EXECUTE_LOOP=1|true|yes` 启用（默认关闭）。
 * - `AGENT_PE_VERBOSE_STREAM=1`：将计划阶段标题写入用户可见流（默认仅推 phase 状态）。
 */
import { requiresTaskDecomposition } from "./simple-task.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";

export type PlanExecuteStep = {
  id: string;
  intent: string;
  successCriteria?: string;
  suggestedTools?: string[];
};

export type TaskExecutionPlan = {
  goal: string;
  steps: PlanExecuteStep[];
};

export type PlanExecuteLoopResult = {
  finalText: string;
  modelCalls: number;
  plan: TaskExecutionPlan | null;
  /**
   * 反思环节是否耗尽 replan 次数。
   *
   * 激活方式：调用方（通常是 PlanExecuteLoopStrategy）传入 `reflectionContext` 时，
   * 由 `replanCount >= maxReplans` 计算；未传入时为 false（兼容旧路径/直调场景）。
   *
   * 在 LoopOrchestrator 模型下，反思由编排器在 strategy.run 之间驱动（assess→replan），
   * 单次 runPlanExecuteLoop 调用时通常未耗尽；任务级"是否耗尽"以 OrchestratorResult.exhaustedRetries 为准。
   */
  exhaustedRetries: boolean;
  /**
   * 最近一次进展评估的反思文本。
   *
   * 激活方式：调用方传入 `reflectionContext.lastDeviation` 时回填；未传入时为空串。
   * 任务级反思聚合见 SharedTaskContext.reflections / OrchestratorResult.verifyReflection。
   */
  verifyReflection: string;
};

export function isPlanExecuteLoopEnabled(): boolean {
  const raw = process.env.AGENT_PLAN_EXECUTE_LOOP?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

function isPeVerboseStreamEnabled(): boolean {
  const raw = process.env.AGENT_PE_VERBOSE_STREAM?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function planExecuteSessionId(actorId: string, chatMessageKey: string): string {
  return `${actorId}\u007fpe\u007f${chatMessageKey}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function isPlanTriviallySimple(plan: TaskExecutionPlan): boolean {
  if (plan.steps.length > 1) return false;
  const step = plan.steps[0];
  if (!step) return false;
  if (step.intent.length > 80) return false;
  if (step.suggestedTools?.length && step.suggestedTools.length > 2) return false;
  return true;
}

function extractJsonObject(text: string): string | null {
  const t = text.trim();
  const direct = tryParseWhole(t);
  if (direct !== null) return direct;
  const fence = /\{[\s\S]*\}/.exec(text);
  if (fence?.[0]) {
    const inner = tryParseWhole(fence[0].trim());
    if (inner !== null) return inner;
  }
  return null;
}

function tryParseWhole(s: string): string | null {
  try {
    const o = JSON.parse(s);
    return typeof o === "object" && o !== null ? s : null;
  } catch {
    return null;
  }
}

/** 供单元测试使用 */
export function parseExecutionPlan(raw: string): TaskExecutionPlan | null {
  const jsonSrc = extractJsonObject(raw);
  if (!jsonSrc) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonSrc);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const goal = typeof (data as { goal?: unknown }).goal === "string" ? (data as { goal: string }).goal : "";
  if (!goal.trim()) return null;
  const stepsRaw = (data as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) return null;
  const steps: PlanExecuteStep[] = [];
  for (const row of stepsRaw) {
    if (typeof row !== "object" || row === null) continue;
    const id = typeof (row as { id?: unknown }).id === "string" ? String((row as { id: string }).id).trim() : "";
    const intent =
      typeof (row as { intent?: unknown }).intent === "string"
        ? String((row as { intent: string }).intent).trim()
        : "";
    if (!intent) continue;
    const successCriteria =
      typeof (row as { successCriteria?: unknown }).successCriteria === "string"
        ? String((row as { successCriteria: string }).successCriteria).trim()
        : undefined;
    let suggestedTools: string[] | undefined;
    const st = (row as { suggestedTools?: unknown }).suggestedTools;
    if (Array.isArray(st)) {
      const names = st.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      if (names.length > 0) suggestedTools = names;
    }
    steps.push({
      id: id || `${steps.length + 1}`,
      intent,
      successCriteria,
      suggestedTools,
    });
  }
  if (steps.length === 0) return null;
  return { goal: goal.trim(), steps };
}

async function emitPhase(
  _onPhaseStatus: ((label: string) => void) | undefined,
  onDelta: StreamDeltaHandler | undefined,
  label: string,
): Promise<void> {
  await Promise.resolve();
  // 进度由主 Agent 在执行阶段流式生成，不再推送固定阶段文案。
  if (isPeVerboseStreamEnabled()) {
    onDelta?.(`\n━━ ${label} ━━\n`);
  }
}

function buildPhaseLabel(phase: string, detail?: { stepCount?: number; currentStep?: string; totalSteps?: number }): string {
  const d = detail;
  if (!d) return phase;
  const parts = [phase];
  if (d.stepCount != null && d.stepCount > 1) parts.push(`（共 ${d.stepCount} 步）`);
  if (d.currentStep) parts.push(d.currentStep);
  if (d.totalSteps != null && d.currentStep) parts.push(`[${d.currentStep}/${d.totalSteps}]`);
  return parts.join("");
}

type RunPlanExecuteLoopArgs = {
  provider: ExternalChatProvider;
  planSessionId: string;
  userText: string;
  /** 与首轮用户消息对齐的视觉上下文；仅并入「执行」与「计划失败兜底」请求，不进入计划 JSON / 自检纯文本轮 */
  visionFrames?: VisionFrame[];
  onDelta?: StreamDeltaHandler;
  /** 计划/执行/自检阶段口语化进度（供 WS chat.agent_status），不写入正文流 */
  onPhaseStatus?: (label: string) => void;
  /** plan_execute 计划生成后回调，供上层发 chat.execution_event(plan_step) */
  onPlanReady?: (plan: { goal: string; steps: { id: string; intent: string; successCriteria?: string; suggestedTools?: string[] }[] }) => void;
  /** 启用工具时必须传入（与 AgentCore 一致） */
  toolCtx: ChatToolExecutionContext | undefined;
  /** 不包含 toolLoop（由编排器在每轮执行拼接） */
  baseStreamOpts: AgentStreamOptions | undefined;
  onToolBatchForExecute?: ((info: ToolLoopAfterBatchInfo) => void) | undefined;
  /**
   * 反思上下文（可选）。由编排器/PlanExecuteLoopStrategy 传入，用于激活
   * exhaustedRetries / verifyReflection 字段（不再恒 false/""）。
   * 不传则保持默认（兼容旧路径直调与 PlannerCortex 适配器）。
   */
  reflectionContext?: {
    replanCount: number;
    maxReplans: number;
    lastDeviation?: string;
  };
};

export async function runPlanExecuteLoop(args: RunPlanExecuteLoopArgs): Promise<PlanExecuteLoopResult> {
  const {
    provider,
    planSessionId,
    userText,
    visionFrames,
    onDelta,
    toolCtx,
    baseStreamOpts,
    onToolBatchForExecute,
    onPhaseStatus,
    onPlanReady,
    reflectionContext,
  } = args;

  // 反思字段激活：由调用方传入的 reflectionContext 驱动；未传入时为默认值（兼容旧路径）。
  const exhaustedRetries = reflectionContext
    ? reflectionContext.replanCount >= reflectionContext.maxReplans
    : false;
  const verifyReflection = reflectionContext?.lastDeviation ?? "";

  provider.clearSession?.(planSessionId);

  let modelCalls = 0;

  await emitPhase(onPhaseStatus, onDelta, "🔍 正在分析任务，制定执行计划…");

  const planUserTurn: ChatUserTurn = {
    text: [
      "用户任务：",
      truncate(userText, 8000),
      "",
      "请只输出**一个合法 JSON 对象**（不要用 Markdown 代码围栏，不要其它说明文字），格式如下：",
      '{"goal":"用一句话概括用户要达成的结果","steps":[{"id":"1","intent":"该步要做什么","successCriteria":"如何判定该步完成","suggestedTools":[]}]}',
      "suggestedTools 为可选字符串数组，填你认为可能用到的工具名；若不确定可填 []。",
      "steps 至少 1 步，且必须可执行、可检验。",
    ].join("\n"),
  };

  const planAssistant = await provider.streamCompletion(
    planSessionId,
    planUserTurn,
    () => {},
    undefined,
    baseStreamOpts,
  );
  modelCalls += 1;

  const plan = parseExecutionPlan(planAssistant);

  // v2：计划生成后立即回调，让上层发 chat.execution_event(plan_step, status=pending)
  if (plan && !isPlanTriviallySimple(plan) && onPlanReady) {
    onPlanReady(plan);
  }

  if (!plan || isPlanTriviallySimple(plan)) {
    if (plan) {
      await emitPhase(onPhaseStatus, onDelta, "⚡ 计划已确认，开始执行…");
    } else {
      await emitPhase(onPhaseStatus, onDelta, "⚡ 直接进入执行环节…");
    }
    const fallbackTurn: ChatUserTurn = {
      text: userText,
      ...(visionFrames?.length ? { visionFrames } : {}),
    };
    const full = await provider.streamCompletion(
      planSessionId,
      fallbackTurn,
      (d) => onDelta?.(d),
      toolCtx,
      {
        ...baseStreamOpts,
        ...(onToolBatchForExecute ? { toolLoop: { onAfterToolBatch: onToolBatchForExecute } } : {}),
      },
    );
    modelCalls += 1;
    return {
      finalText: full,
      modelCalls,
      plan: null,
      exhaustedRetries,
      verifyReflection,
    };
  }

  await emitPhase(
    onPhaseStatus,
    onDelta,
    `🔧 按计划执行中（${plan.steps.length} 步）…`,
  );

  const executePrompt = [
    "用户原始任务：",
    truncate(userText, 6000),
    "",
    "已批准的执行计划（必须以此为纲，逐步完成）：",
    JSON.stringify(plan, null, 2),
    "",
    "请调用可用工具收集事实并完成任务；最后用自然语言向用户汇总结果（含关键数据依据）。若某工具失败应换策略或说明阻塞点。",
  ].filter(Boolean).join("\n");

  const executeOpts: AgentStreamOptions = {
    ...baseStreamOpts,
    ...(onToolBatchForExecute ? { toolLoop: { onAfterToolBatch: onToolBatchForExecute } } : {}),
  };

  const executeTurn: ChatUserTurn = {
    text: executePrompt,
    ...(visionFrames?.length ? { visionFrames } : {}),
  };

  const full = await provider.streamCompletion(
    planSessionId,
    executeTurn,
    (d) => onDelta?.(d),
    toolCtx,
    executeOpts,
  );
  modelCalls += 1;

  return {
    finalText: full,
    modelCalls,
    plan,
    exhaustedRetries,
    verifyReflection,
  };
}
