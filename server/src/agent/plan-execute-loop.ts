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
import { requiresTaskDecomposition, isSimpleDirectTask } from "./simple-task.js";
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
  exhaustedRetries: boolean;
  verifyReflection: string;
};

export function isPlanExecuteLoopEnabled(): boolean {
  const raw = process.env.AGENT_PLAN_EXECUTE_LOOP?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

/** 仅在复杂/多步任务上启用 PE，避免简单问答多跑 2～3 轮模型。 */
export function shouldUsePlanExecuteLoop(message: string): boolean {
  if (!isPlanExecuteLoopEnabled()) return false;
  const t = message.trim();
  if (!t) return false;
  if (isSimpleDirectTask(t)) return false;
  return requiresTaskDecomposition(t);
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
  onPhaseStatus: ((label: string) => void) | undefined,
  onDelta: StreamDeltaHandler | undefined,
  label: string,
): Promise<void> {
  await Promise.resolve();
  onPhaseStatus?.(label);
  if (isPeVerboseStreamEnabled()) {
    onDelta?.(`\n━━ ${label} ━━\n`);
  }
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
  /** 启用工具时必须传入（与 AgentCore 一致） */
  toolCtx: ChatToolExecutionContext | undefined;
  /** 不包含 toolLoop（由编排器在每轮执行拼接） */
  baseStreamOpts: AgentStreamOptions | undefined;
  onToolBatchForExecute?: ((info: ToolLoopAfterBatchInfo) => void) | undefined;
};

export type PlanExecuteLoopResult = {
  finalText: string;
  modelCalls: number;
  plan: TaskExecutionPlan | null;
  exhaustedRetries: boolean;
  verifyReflection: string;
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
  } = args;

  provider.clearSession?.(planSessionId);

  let modelCalls = 0;

  await emitPhase(onPhaseStatus, onDelta, "制定计划");

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

  if (!plan || isPlanTriviallySimple(plan)) {
    if (plan) {
      await emitPhase(onPhaseStatus, onDelta, "执行（计划较简单，直接进入工具环）");
    } else {
      await emitPhase(onPhaseStatus, onDelta, "执行（计划解析失败，按常规工具环处理）");
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
      exhaustedRetries: false,
      verifyReflection: "",
    };
  }

  await emitPhase(onPhaseStatus, onDelta, "执行与工具调用");

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
    exhaustedRetries: false,
    verifyReflection: "",
  };
}
