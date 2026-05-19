/**
 * 「计划 → 执行（工具）→ 自检 → 重试」编排：与 OpenAI/Kimi Provider 的多轮工具环协作。
 *
 * 环境变量：
 * - `AGENT_PLAN_EXECUTE_LOOP=1|true|yes` 启用（默认关闭）。
 * - `AGENT_PE_MAX_RETRIES`：自检未通过后最多额外重试几次执行阶段（默认 2，共最多 3 轮执行）。
 */
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

export type VerifyDecision = {
  pass: boolean;
  gaps: string[];
  reflection: string;
};

export function isPlanExecuteLoopEnabled(): boolean {
  const raw = process.env.AGENT_PLAN_EXECUTE_LOOP?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

export function planExecuteSessionId(actorId: string, chatMessageKey: string): string {
  return `${actorId}\u007fpe\u007f${chatMessageKey}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
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

/** 供单元测试使用 */
export function parseVerifyDecision(raw: string): VerifyDecision | null {
  const jsonSrc = extractJsonObject(raw);
  if (!jsonSrc) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonSrc);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const pr = (data as { pass?: unknown }).pass;
  if (typeof pr !== "boolean") return null;
  const pass = pr;
  const gapsRaw = (data as { gaps?: unknown }).gaps;
  const gaps: string[] =
    Array.isArray(gapsRaw) ?
      gapsRaw.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  const reflection =
    typeof (data as { reflection?: unknown }).reflection === "string" ?
      String((data as { reflection: string }).reflection).trim()
    : "";
  return { pass, gaps, reflection };
}

async function emitPhase(onDelta: StreamDeltaHandler | undefined, label: string, extraNewline = true): Promise<void> {
  await Promise.resolve();
  const line = `\n━━ ${label} ━━${extraNewline ? "\n" : ""}`;
  onDelta?.(line);
}

type RunPlanExecuteLoopArgs = {
  provider: ExternalChatProvider;
  planSessionId: string;
  userText: string;
  /** 与首轮用户消息对齐的视觉上下文；仅并入「执行」与「计划失败兜底」请求，不进入计划 JSON / 自检纯文本轮 */
  visionFrames?: VisionFrame[];
  onDelta?: StreamDeltaHandler;
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
  } = args;
  const maxRetries = Math.min(
    8,
    Math.max(
      0,
      Number.parseInt(process.env.AGENT_PE_MAX_RETRIES ?? "2", 10) || 0,
    ),
  );

  provider.clearSession?.(planSessionId);

  let modelCalls = 0;

  await emitPhase(onDelta, "制定计划");

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
    (d) => onDelta?.(d),
    undefined,
    baseStreamOpts,
  );
  modelCalls += 1;

  const plan = parseExecutionPlan(planAssistant);

  if (!plan) {
    await emitPhase(onDelta, "执行（计划解析失败，按常规工具环处理）");
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

  const toolLog: Array<{ name: string; ok: boolean; snippet: string }> = [];
  const wrappedToolCtx: ChatToolExecutionContext | undefined =
    toolCtx ?
      {
        executeTool: toolCtx.executeTool,
        onToolExecuted: (info) => {
          const raw = JSON.stringify(info.result);
          const snippet = truncate(raw, 720);
          toolLog.push({ name: info.toolName, ok: info.ok, snippet });
          toolCtx.onToolExecuted?.(info);
        },
      }
    : undefined;

  let lastExecuteText = "";
  let verifyReflection = "";
  let exhaustedRetries = false;
  let pendingSelfCheckFeedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    toolLog.length = 0;

    const executePromptParts = [
      "用户原始任务：",
      truncate(userText, 6000),
      "",
      "已批准的执行计划（必须以此为纲，逐步完成）：",
      JSON.stringify(plan, null, 2),
      pendingSelfCheckFeedback,
      attempt > 0 ? `\n（当前为第 ${attempt + 1} 轮工具执行轮次；上一轮对话中已包含自检员的 JSON，请对照缺口补救。）` : "",
      "",
      "请调用可用工具收集事实并完成任务；最后用自然语言向用户汇总结果（含关键数据依据）。若某工具失败应换策略或说明阻塞点。",
    ].filter(Boolean);

    await emitPhase(onDelta, attempt === 0 ? "执行与工具调用" : `重试执行（第 ${attempt + 1} 轮）`);

    const executeOpts: AgentStreamOptions = {
      ...baseStreamOpts,
      ...(onToolBatchForExecute ? { toolLoop: { onAfterToolBatch: onToolBatchForExecute } } : {}),
    };

    const executeUserMsg = executePromptParts.join("\n");

    pendingSelfCheckFeedback = "";

    const executeTurn: ChatUserTurn = {
      text: executeUserMsg,
      ...(visionFrames?.length ? { visionFrames } : {}),
    };
    lastExecuteText = await provider.streamCompletion(
      planSessionId,
      executeTurn,
      (d) => onDelta?.(d),
      wrappedToolCtx,
      executeOpts,
    );
    modelCalls += 1;

    const toolDigest =
      toolLog.length === 0 ?
        "（本轮未调用工具或暂无记录）"
      : toolLog.map((t, i) => `${i + 1}. ${t.name} ok=${t.ok}\n ${t.snippet}`).join("\n");

    await emitPhase(onDelta, "自检");

    const verifyTurn: ChatUserTurn = {
      text: [
        "你是严格的任务验收审核员（只输出 JSON，不要 Markdown 围栏与其它文字）。",
        "用户原始任务：",
        truncate(userText, 4000),
        "",
        "计划 goal：",
        plan.goal,
        "",
        "助手最终答复（截取）：",
        truncate(lastExecuteText, 4500),
        "",
        "工具调用与返回摘要：",
        toolDigest.slice(0, 12000),
        "",
        "请判断：**是否已充分完成用户任务**（不是语气态度，而是目标与证据）。",
        "输出 JSON：`{\"pass\":true|false,\"gaps\":[\"...\"],\"reflection\":\"简练反思\"}`",
        "- pass=true：证据链足以支持用户任务，无重大遗漏；",
        "- pass=false：gaps 列出未满足的计划步骤或缺失的数据/失败的工具仍需处理；reflection 简述原因与建议下一步。",
      ].join("\n"),
    };
    const verifyAssistant = await provider.streamCompletion(
      planSessionId,
      verifyTurn,
      (d) => onDelta?.(d),
      undefined,
      baseStreamOpts,
    );
    modelCalls += 1;

    const decision = parseVerifyDecision(verifyAssistant);
    if (!decision) {
      verifyReflection = "（自检阶段未能解析结构化结果，跳过重试判定。）";
      break;
    }
    verifyReflection = decision.reflection;

    if (decision.pass) {
      exhaustedRetries = false;
      break;
    }

    if (attempt >= maxRetries) {
      exhaustedRetries = true;
      break;
    }

    const gapLines = decision.gaps.length ?
      decision.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
    : "（自检未列出具体缺口，请根据反思自行改进执行）";

    pendingSelfCheckFeedback = [
      "",
      "【上一轮自检未通过 — 编入本轮执行的显式缺口】",
      gapLines,
      "",
      `【上一轮自检反思】${decision.reflection || "（无）"}`,
    ].join("\n");
  }

  let finalText = lastExecuteText;
  if (exhaustedRetries) {
    finalText = `${lastExecuteText}\n\n（提示：经多轮自检仍认为未完全达成目标，请补充信息或调整任务范围。上次反思：${verifyReflection || "无"}）`;
  }

  return {
    finalText,
    modelCalls,
    plan,
    exhaustedRetries,
    verifyReflection,
  };
}
