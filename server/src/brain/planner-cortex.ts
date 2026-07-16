// Agent Brain Center — PlannerCortex（额叶规划皮层）
//
// 职责：纯编排/路由层。对外暴露 plan / execute / react / delegate / routeSystem
// 五个核心方法，内部委托给 PlanExecuteLoop / MasterAgentCoordinator / TaskRouter
// 三个子系统。任一子系统未注册时方法优雅降级到内置兜底规则（基于关键词）。
//
// 设计原则：
//  1. 不调用 LLM 做规划或路由（除非子系统内部已经用了 LLM，那是它内部的事）。
//  2. 路由走 TaskRouter 规则；规划走 PlanExecuteLoop 状态机。
//  3. 兜底规划/路由是基于关键词的简单规则，保证 BrainCenter 即使在子系统
//     未注入时也能给出可用决策。
//  4. 缓存最近一次 plan / route 决策，供 BrainCenter.snapshot 读取。

import type {
  PlanResult,
  PlanStep,
  ReActObservation,
  SystemRouteDecision,
  SystemRouteMode,
} from "./types.js";
import type { SubAgentType } from "../services/master-agent-types.js";

// ---- 子系统外观接口 ------------------------------------------------------

/**
 * PlanExecuteLoop 外观接口。
 *
 * 实际实现是 plan-execute-loop.ts 中的 `runPlanExecuteLoop(args)` 函数 +
 * `parseExecutionPlan(raw)` 等工具函数。本接口面向"已包装为对象"的注入
 * （bootstrap 可包装为 `{ plan, execute, react }` 对象），方法全部可选，
 * 缺失时 PlannerCortex 走内置兜底规划。
 */
interface PlanExecuteLoopLike {
  plan?(goal: string, opts?: unknown): Promise<unknown>;
  execute?(plan: unknown, opts?: unknown): Promise<unknown>;
  react?(observation: unknown): unknown;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * MasterAgentCoordinator 外观接口。
 *
 * 实际类暴露的是 `handleInvokeSubAgentTool(input, context)`，签名与
 * `invokeSubAgent(type, task, opts)` 不同。bootstrap 注入时应包装为
 * `invokeSubAgent` 方法（适配 taskDescription / priorContext / actorId）。
 * 未注册或方法缺失时 delegate 返回 `{ ok: false, error: ... }`。
 */
interface MasterCoordinatorLike {
  invokeSubAgent?(subAgentType: string, task: unknown, opts?: unknown): Promise<unknown>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * ToolExecutor 外观接口。
 *
 * 让 PlannerCortex.execute 能真实执行 plan 中的 expectedTools，
 * 而非只把 step 状态改成 completed。bootstrap 注入 ToolRegistry 的包装。
 */
interface ToolExecutorLike {
  execute(
    name: string,
    args: Record<string, unknown>,
    opts?: { actorId?: string },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }>;
}

/**
 * TaskRouter 外观接口。
 *
 * 实际导出是 `routeLlmExecution(message, config?, options?)` 函数，返回
 * `{ mode: LlmExecutionMode, reasons: string[] }`。bootstrap 可直接将函数
 * 包成对象方法注入。未注册时 PlannerCortex 走内置关键词兜底路由。
 */
interface TaskRouterLike {
  routeLlmExecution?(userMessage: string, opts?: unknown): unknown;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// ---- 内置兜底规则 --------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 内置兜底规划：基于关键词把 goal 拆成 1-3 个泛化步骤。
 * 仅在 PlanExecuteLoop 未注册或方法缺失时使用。
 */
function builtinPlan(goal: string): PlanResult {
  const steps: PlanStep[] = [];
  if (/查|搜|看看|查询/.test(goal)) {
    steps.push({
      id: "s1",
      title: "信息检索",
      description: "根据用户需求检索相关信息",
      expectedTools: ["search_web", "fetch_web"],
      status: "pending",
    });
  }
  if (/分析|计算|算|统计/.test(goal)) {
    steps.push({
      id: "s2",
      title: "分析处理",
      description: "对检索到的信息进行分析处理",
      expectedTools: ["code.run"],
      status: "pending",
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    });
  }
  if (/操作|执行|打开|运行/.test(goal)) {
    steps.push({
      id: "s3",
      title: "执行操作",
      description: "执行用户要求的操作",
      expectedTools: ["desktop.run_preset", "desktop.open"],
      status: "pending",
    });
  }
  if (steps.length === 0) {
    steps.push({
      id: "s1",
      title: "理解需求",
      description: "理解用户需求并给出回复",
      status: "pending",
    });
  }
  return {
    goal,
    steps,
    createdAt: nowIso(),
    rationale: "内置兜底规划（PlanExecuteLoop 未注册）",
  };
}

/**
 * 内置兜底路由：基于关键词判断快慢双系统路由。
 * 仅在 TaskRouter 未注册或方法缺失时使用。
 */
function builtinRoute(userMessage: string): SystemRouteDecision {
  if (/你好|嗨|hi|hello|谢谢|再见/.test(userMessage)) {
    return {
      userMessage,
      system: "system1",
      mode: "fast_chat",
      rationale: "寒暄匹配 fast_chat",
      decidedAt: nowIso(),
    };
  }
  if (/算一下|查一下天气|查一下.*天气|翻译/.test(userMessage)) {
    return {
      userMessage,
      system: "system1",
      mode: "direct_llm",
      rationale: "简单任务匹配 direct_llm",
      decidedAt: nowIso(),
    };
  }
  if (/研究|调研|深度分析|多步骤|完整方案/.test(userMessage)) {
    return {
      userMessage,
      system: "system2",
      mode: "master_delegate",
      rationale: "研究类任务匹配 master_delegate",
      decidedAt: nowIso(),
    };
  }
  if (/规划|计划|分步|帮我.*并.*|然后|接着/.test(userMessage)) {
    return {
      userMessage,
      system: "system2",
      mode: "plan_execute",
      rationale: "多步任务匹配 plan_execute",
      decidedAt: nowIso(),
    };
  }
  return {
    userMessage,
    system: "system1",
    mode: "direct_llm",
    rationale: "默认路由到 direct_llm",
    decidedAt: nowIso(),
  };
}

// ---- shouldDelegate 规则层（Task 6） -------------------------------------

/**
 * shouldDelegate 判断结果。
 * - delegate=true 时携带 agentType（life/tech/info）与 reason
 * - delegate=false 时其余字段省略
 */
interface ShouldDelegateResult {
  delegate: boolean;
  agentType?: SubAgentType;
  reason?: string;
}

/**
 * 不委派白名单：命中任一关键词则直接返回 { delegate: false }。
 * 优先级高于委派倾向词，避免"你好"因含"好"等误判为委派任务。
 * 覆盖：时间/天气/打招呼/简单问答/单步操作。
 */
const NO_DELEGATE_WHITELIST: string[] = [
  "几点",
  "什么时间",
  "现在时间",
  "时间",
  "天气",
  "你好",
  "早上好",
  "中午好",
  "晚上好",
  "嗨",
  "hi",
  "hello",
  "谢谢",
  "感谢",
  "再见",
  "拜拜",
  "晚安",
];

/**
 * 委派倾向词：按子 Agent 类型分组。
 * 命中即表明任务有对应子 Agent 的能力倾向。
 */
const DELEGATE_KEYWORDS: Record<SubAgentType, string[]> = {
  tech: [
    "打开",
    "操作",
    "rpa",
    "自动化",
    "批量",
    "安装",
    "配置",
    "系统",
    "浏览器",
    "运行",
    "桌面",
  ],
  info: [
    "研究",
    "调研",
    "对比",
    "比较",
    "深度分析",
    "搜索",
    "查找",
    "查多个",
    "分析",
    "查一下",
  ],
  life: [
    "订餐",
    "购物",
    "买",
    "预订",
    "打车",
    "下单",
    "点外卖",
  ],
};

/**
 * 步骤数估算连词：每命中一个，估算步骤数 +1。
 * 用于识别"打开浏览器查三个网站并对比价格然后生成报告"类多步任务。
 */
const STEP_CONJUNCTIONS: string[] = [
  "然后",
  "接着",
  "再",
  "之后",
  "第一步",
  "第二步",
  "第三步",
  "第四步",
  "第五步",
  "最后",
  "并",
  "且",
];

/**
 * 动作动词：用于步骤数估算（spec: 基于动词数量、连词估算步骤数）。
 * 每命中一个 distinct 动词，估算步骤数 +1。
 * 与 DELEGATE_KEYWORDS 不同——此处仅用于步骤计数，不决定 agentType。
 */
const ACTION_VERBS: string[] = [
  "打开",
  "搜索",
  "查找",
  "查询",
  "检索",
  "对比",
  "比较",
  "分析",
  "生成",
  "操作",
  "配置",
  "运行",
  "安装",
  "发送",
  "下载",
  "上传",
  "处理",
  "计算",
  "统计",
  "创建",
  "删除",
  "修改",
  "调研",
  "研究",
  "订餐",
  "预订",
  "下单",
  "购买",
  "打车",
  "浏览",
  // 补充常见 RPA/系统操作动词（压测发现覆盖不全）
  "重命名",
  "整理",
  "执行",
  "收集",
  "清理",
  "汇总",
  "结束",
  "导入",
  "导出",
  "归档",
  "压缩",
  "打包",
  "登录",
  "填写",
  "提交",
  "截图",
  "克隆",
  "批量",
  "重启",
  "验证",
];

/** 步骤数阈值：估算步骤数 > 该值才考虑委派（spec: > 3） */
const DELEGATE_STEP_THRESHOLD = 3;

// ---- 辅助：类型收窄工具 --------------------------------------------------

function readSteps(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  const arr = obj.steps;
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}

function readStringOr(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  const filtered = v.filter((x): x is string => typeof x === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeStepStatus(raw: unknown): PlanStep["status"] {
  if (
    raw === "pending" ||
    raw === "in_progress" ||
    raw === "completed" ||
    raw === "failed" ||
    raw === "skipped"
  ) {
    return raw;
  }
  return "pending";
}

/**
 * 把任意 step-like 对象规范化为 PlanStep。
 * 兼容 PlanResult.step 与 PlanExecuteStep（intent / successCriteria / suggestedTools）。
 */
function normalizeStep(raw: Record<string, unknown>): PlanStep {
  const id =
    typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : `s${Math.random().toString(36).slice(2, 8)}`;
  const title =
    typeof raw.title === "string"
      ? raw.title
      : typeof raw.intent === "string"
        ? raw.intent
        : "未命名步骤";
  const description =
    typeof raw.description === "string"
      ? raw.description
      : typeof raw.intent === "string"
        ? raw.intent
        : typeof raw.successCriteria === "string"
          ? raw.successCriteria
          : "";
  const expectedTools =
    readStringArray(raw, "expectedTools") ?? readStringArray(raw, "suggestedTools");
  const dependencies = readStringArray(raw, "dependencies");
  const estimatedDurationMs =
    typeof raw.estimatedDurationMs === "number" ? raw.estimatedDurationMs : undefined;
  const status = normalizeStepStatus(raw.status);
  const step: PlanStep = { id, title, description, status };
  if (expectedTools) step.expectedTools = expectedTools;
  if (dependencies) step.dependencies = dependencies;
  if (estimatedDurationMs !== undefined) step.estimatedDurationMs = estimatedDurationMs;
  return step;
}

/**
 * 把 PlanExecuteLoop.plan() 的返回值转换为 PlanResult。
 *
 * 接受多种形状：
 *  - 直接的 PlanResult（goal/steps/createdAt/rationale，steps 元素有 status）
 *  - TaskExecutionPlan（{ goal, steps: [{ id, intent, successCriteria?, suggestedTools? }] }）
 *  - PlanExecuteLoopResult（{ finalText, plan: TaskExecutionPlan | null, ... }）
 */
function coerceToPlanResult(goal: string, raw: unknown): PlanResult {
  if (!raw || typeof raw !== "object") {
    const fallback = builtinPlan(goal);
    return {
      ...fallback,
      rationale: "PlanExecuteLoop.plan 返回值无法解析为 PlanResult，已退回内置规划",
    };
  }
  const obj = raw as Record<string, unknown>;
  const directSteps = readSteps(obj);
  // 形状 1：直接是 PlanResult（steps 元素含 status）
  if (directSteps.length > 0 && directSteps.some((s) => s.status !== undefined)) {
    return {
      goal: readStringOr(obj, "goal", goal),
      steps: directSteps.map(normalizeStep),
      createdAt: readStringOr(obj, "createdAt", nowIso()),
      rationale: readOptionalString(obj, "rationale"),
    };
  }
  // 形状 2：TaskExecutionPlan（goal + steps[{id, intent, suggestedTools}]）
  if (directSteps.length > 0) {
    return {
      goal: readStringOr(obj, "goal", goal),
      steps: directSteps.map(normalizeStep),
      createdAt: nowIso(),
      rationale: "由 PlanExecuteLoop.plan 返回的 TaskExecutionPlan 转换",
    };
  }
  // 形状 3：PlanExecuteLoopResult（finalText + plan: TaskExecutionPlan | null）
  const inner = obj.plan;
  if (inner && typeof inner === "object") {
    const innerSteps = readSteps(inner as Record<string, unknown>);
    if (innerSteps.length > 0) {
      return {
        goal: readStringOr(inner as Record<string, unknown>, "goal", goal),
        steps: innerSteps.map(normalizeStep),
        createdAt: nowIso(),
        rationale: "由 PlanExecuteLoop.plan 返回的 PlanExecuteLoopResult.plan 转换",
      };
    }
  }
  // 兜底：无法解析，使用内置规划但标注来源
  const fallback = builtinPlan(goal);
  return {
    ...fallback,
    rationale: "PlanExecuteLoop.plan 返回值无法解析为 PlanResult，已退回内置规划",
  };
}

// ---- 辅助：执行结果回填 --------------------------------------------------

/**
 * 把 PlanExecuteLoop.execute() 的返回值映射回 PlanResult：
 *  - 若返回值直接含 steps（按 id 匹配），更新对应 step 的 status
 *  - 若返回值是 PlanExecuteLoopResult（含 finalText / plan 字段）：
 *      · plan.steps 存在 → 按 id 更新 status
 *      · plan=null（fallback 直接 LLM）→ 所有 pending 标记为 completed
 *  - 否则保留原 plan，附加执行说明
 */
function applyExecutionResult(plan: PlanResult, raw: unknown): PlanResult {
  if (!raw || typeof raw !== "object") {
    return {
      ...plan,
      rationale: `${plan.rationale ?? ""} | execute 返回非对象`.trim(),
    };
  }
  const obj = raw as Record<string, unknown>;
  const directSteps = readSteps(obj);
  if (directSteps.length > 0) {
    return mergeStepStatuses(plan, directSteps);
  }
  // PlanExecuteLoopResult 形状
  if ("finalText" in obj || "plan" in obj) {
    const inner = obj.plan;
    if (inner && typeof inner === "object") {
      const innerSteps = readSteps(inner as Record<string, unknown>);
      if (innerSteps.length > 0) {
        return mergeStepStatuses(plan, innerSteps);
      }
    }
    // plan=null（fallback 直接 LLM 路径）：所有 pending 标记为 completed
    const steps = plan.steps.map((step) =>
      step.status === "pending" ? { ...step, status: "completed" as const } : step,
    );
    return { ...plan, steps };
  }
  return {
    ...plan,
    rationale: `${plan.rationale ?? ""} | execute 返回值无法解析 steps，未更新 step 状态`.trim(),
  };
}

/** 按 step.id 把 raw 中的 status 合并回 plan.steps */
function mergeStepStatuses(
  plan: PlanResult,
  rawSteps: Array<Record<string, unknown>>,
): PlanResult {
  const statusById = new Map<string, PlanStep["status"]>();
  for (const s of rawSteps) {
    const id = typeof s.id === "string" ? s.id : "";
    if (id) statusById.set(id, normalizeStepStatus(s.status));
  }
  const steps = plan.steps.map((step) => {
    const next = statusById.get(step.id);
    return next && next !== step.status ? { ...step, status: next } : step;
  });
  return { ...plan, steps };
}

// ---- 辅助：路由决策转换 --------------------------------------------------

/**
 * 把 task-router 的 LlmExecutionMode 映射为 SystemRouteDecision 的 system / mode 二元组。
 *
 * Spec 显式定义 4 个映射：
 *  - fast_chat → system1 / fast_chat
 *  - direct_llm → system1 / direct_llm
 *  - master_only → system2 / master_only（主 Agent 自处理）
 *  - master_delegate → system2 / master_delegate
 *  - plan_execute → system2 / plan_execute
 *  - state_machine → system2 / state_machine（桌面自动化多步骤状态机）
 */
function mapRouteMode(rawMode: unknown): { system: "system1" | "system2"; mode: SystemRouteMode } {
  if (typeof rawMode !== "string") {
    return { system: "system1", mode: "direct_llm" };
  }
  switch (rawMode) {
    case "fast_chat":
      return { system: "system1", mode: "fast_chat" };
    case "direct_llm":
      return { system: "system1", mode: "direct_llm" };
    case "master_only":
      return { system: "system2", mode: "master_only" };
    case "master_delegate":
      return { system: "system2", mode: "master_delegate" };
    case "plan_execute":
      return { system: "system2", mode: "plan_execute" };
    case "state_machine":
      return { system: "system2", mode: "state_machine" };
    default:
      return { system: "system1", mode: "direct_llm" };
  }
}

function coerceToRouteDecision(userMessage: string, raw: unknown): SystemRouteDecision {
  if (!raw || typeof raw !== "object") {
    return builtinRoute(userMessage);
  }
  const obj = raw as Record<string, unknown>;
  const { system, mode } = mapRouteMode(obj.mode);
  const reasonsRaw = obj.reasons;
  const reasons =
    Array.isArray(reasonsRaw) && reasonsRaw.every((x) => typeof x === "string")
      ? (reasonsRaw as string[])
      : [];
  const rationale =
    reasons.length > 0 ? reasons.join("; ") : `TaskRouter 路由到 ${mode}`;
  return {
    userMessage,
    system,
    mode,
    rationale,
    decidedAt: nowIso(),
  };
}

function isThenable<T>(v: unknown): v is PromiseLike<T> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

// ---- PlannerCortex -------------------------------------------------------

/**
 * PlannerCortex —— 额叶规划皮层。
 *
 * 持有 PlanExecuteLoop / MasterAgentCoordinator / TaskRouter 三个子系统的可选
 * 引用，对外提供 plan / execute / react / delegate / routeSystem 五个核心方法。
 * 任一子系统缺失时方法优雅降级到内置关键词兜底规则。
 *
 * 不直接调用 LLM 做规划/路由；规划与路由均委托给子系统内部的状态机/规则。
 */
export class PlannerCortex {
  private planExecuteLoop: PlanExecuteLoopLike | null = null;
  private masterCoordinator: MasterCoordinatorLike | null = null;
  private taskRouter: TaskRouterLike | null = null;
  private toolExecutor: ToolExecutorLike | null = null;
  private started = false;
  private lastPlan: PlanResult | null = null;
  private lastRoute: SystemRouteDecision | null = null;

  // ---- 注册方法 ----------------------------------------------------------

  /** 注册 PlanExecuteLoop（已包装为 { plan?, execute?, react? } 的对象） */
  registerPlanExecuteLoop(svc: PlanExecuteLoopLike): void {
    this.planExecuteLoop = svc;
    console.log("[PlannerCortex] 已注册 PlanExecuteLoop");
  }

  /** 注册 MasterAgentCoordinator（已包装为 { invokeSubAgent? } 的对象） */
  registerMasterCoordinator(svc: MasterCoordinatorLike): void {
    this.masterCoordinator = svc;
    console.log("[PlannerCortex] 已注册 MasterAgentCoordinator");
  }

  /** 注册 TaskRouter（已包装为 { routeLlmExecution? } 的对象） */
  registerTaskRouter(svc: TaskRouterLike): void {
    this.taskRouter = svc;
    console.log("[PlannerCortex] 已注册 TaskRouter");
  }

  /** 注册 ToolExecutor：让 execute 能真实跑 plan 中的 expectedTools */
  registerToolExecutor(svc: ToolExecutorLike): void {
    this.toolExecutor = svc;
    console.log("[PlannerCortex] 已注册 ToolExecutor");
  }

  // ---- 生命周期 ----------------------------------------------------------

  /** 启动皮层：依次启动已注册的子系统（缺失或无 start 方法则跳过） */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[PlannerCortex] 已启动，跳过重复 start");
      return;
    }
    console.log("[PlannerCortex] 正在启动...");
    await this.startSubsystem("PlanExecuteLoop", this.planExecuteLoop);
    await this.startSubsystem("MasterAgentCoordinator", this.masterCoordinator);
    await this.startSubsystem("TaskRouter", this.taskRouter);
    this.started = true;
    console.log("[PlannerCortex] 启动完成");
  }

  /** 停止皮层：依次停止已注册的子系统（缺失或无 stop 方法则跳过） */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[PlannerCortex] 未启动，跳过 stop");
      return;
    }
    console.log("[PlannerCortex] 正在停止...");
    await this.stopSubsystem("PlanExecuteLoop", this.planExecuteLoop);
    await this.stopSubsystem("MasterAgentCoordinator", this.masterCoordinator);
    await this.stopSubsystem("TaskRouter", this.taskRouter);
    this.started = false;
    console.log("[PlannerCortex] 已停止");
  }

  // ---- 核心方法 ----------------------------------------------------------

  /**
   * 规划：委托 PlanExecuteLoop.plan(goal, opts)，转换为 PlanResult 并缓存。
   * 若 PlanExecuteLoop 未注册或方法缺失，走内置关键词兜底规划。
   * 不直接调用 LLM 做规划（除非子系统内部已经用了 LLM，那是它内部的事）。
   */
  async plan(
    goal: string,
    opts?: { actorId?: string; maxSteps?: number },
  ): Promise<PlanResult> {
    const svc = this.planExecuteLoop;
    if (svc && typeof svc.plan === "function") {
      try {
        const raw = await svc.plan(goal, opts);
        const result = coerceToPlanResult(goal, raw);
        this.lastPlan = result;
        return result;
      } catch (err) {
        console.log(`[PlannerCortex] plan 委托失败，退回兜底: ${err}`);
      }
    } else {
      console.log("[PlannerCortex] PlanExecuteLoop 未注册或缺少 plan 方法，使用内置兜底规划");
    }
    const fallback = builtinPlan(goal);
    this.lastPlan = fallback;
    return fallback;
  }

  /**
   * 执行：委托 PlanExecuteLoop.execute(plan, opts)。
   * 若 PlanExecuteLoop 未注册/返回空(plan:null)，但 toolExecutor 已注册，
   * 则 fallback 到用 toolExecutor 真实执行 plan 中每个 step 的 expectedTools，
   * 把结果写入 step.observation，实现 plan→execute→react 闭环。
   * 若两者都未注册，返回原 plan 并标注 "未注册，无法执行"。
   */
  async execute(plan: PlanResult, opts?: { actorId?: string }): Promise<PlanResult> {
    const svc = this.planExecuteLoop;
    const actorId = opts?.actorId;

    // 路径1：PlanExecuteLoop 真实执行
    if (svc && typeof svc.execute === "function") {
      try {
        const raw = await svc.execute(plan, opts);
        const updated = applyExecutionResult(plan, raw);
        // 若 adapter 返回了真实结果（有 finalText 或 step 有 observation），直接用
        if ((raw as { finalText?: string })?.finalText || this.hasStepObservations(updated)) {
          this.lastPlan = updated;
          return updated;
        }
        // 否则 fallthrough 到 toolExecutor fallback
      } catch (err) {
        console.log(`[PlannerCortex] execute 委托失败，尝试 toolExecutor fallback: ${err}`);
      }
    }

    // 路径2：toolExecutor fallback——真实执行 expectedTools
    if (this.toolExecutor) {
      const executed = await this.executeWithToolExecutor(plan, actorId);
      this.lastPlan = executed;
      return executed;
    }

    // 路径3：两者都未注册
    console.log("[PlannerCortex] PlanExecuteLoop 与 ToolExecutor 均未注册，无法执行");
    const result: PlanResult = {
      ...plan,
      rationale: `${plan.rationale ?? ""} | 无执行器可用`.trim(),
    };
    this.lastPlan = result;
    return result;
  }

  /** 判断 plan 是否已有 step 级 observation（避免覆盖 adapter 已产出的结果） */
  private hasStepObservations(plan: PlanResult): boolean {
    return plan.steps.some((s) => s.observation && s.observation.trim().length > 0);
  }

  /**
   * 用 toolExecutor 真实执行 plan 中每个 pending step 的 expectedTools。
   * 串行执行（有 dependencies 的 step 等前置完成后再跑），
   * 把工具结果摘要写入 step.observation，status 改为 completed/failed。
   */
  private async executeWithToolExecutor(plan: PlanResult, actorId?: string): Promise<PlanResult> {
    if (!this.toolExecutor) return plan;
    const steps = [...plan.steps];
    const completedStepIds = new Set<string>();

    for (const step of steps) {
      if (step.status === "completed") {
        completedStepIds.add(step.id);
        continue;
      }
      // 检查依赖是否已满足
      if (step.dependencies && step.dependencies.length > 0) {
        const depsOk = step.dependencies.every((d) => completedStepIds.has(d));
        if (!depsOk) {
          step.status = "blocked";
          step.observation = "前置步骤未完成，跳过";
          continue;
        }
      }

      // 执行 expectedTools
      const tools = step.expectedTools ?? [];
      if (tools.length === 0) {
        step.status = "completed";
        step.observation = "无预期工具，直接标记完成";
        completedStepIds.add(step.id);
        continue;
      }

      const observations: string[] = [];
      let allOk = true;
      for (const toolName of tools) {
        try {
          const result = await this.toolExecutor!.execute(
            toolName,
            { query: step.description, goal: step.title },
            { actorId },
          );
          if (result.ok) {
            const summary = JSON.stringify(result.result).slice(0, 200);
            observations.push(`${toolName}: ${summary}`);
          } else {
            observations.push(`${toolName}: 失败 - ${JSON.stringify(result.result).slice(0, 100)}`);
            allOk = false;
          }
        } catch (err) {
          observations.push(`${toolName}: 异常 - ${err instanceof Error ? err.message : String(err)}`);
          allOk = false;
        }
      }
      step.status = allOk ? "completed" : "failed";
      step.observation = observations.join("; ");
      if (allOk) completedStepIds.add(step.id);
    }

    return { ...plan, steps };
  }

  /**
   * ReAct 反馈：把 observation 反馈给 PlanExecuteLoop，返回更新后的 observation。
   * 若 PlanExecuteLoop 未注册或方法缺失，原样返回 observation。
   *
   * 注意：本方法签名同步。若底层 react 返回 Promise（异步），sync 调用无法等待，
   * 会记录日志并返回原 observation；调用方应在子系统侧把 react 实现为同步方法。
   */
  react(observation: ReActObservation): ReActObservation {
    const svc = this.planExecuteLoop;
    if (!svc || typeof svc.react !== "function") {
      return observation;
    }
    try {
      const out = svc.react(observation);
      if (isThenable<ReActObservation>(out)) {
        console.log(
          "[PlannerCortex] PlanExecuteLoop.react 返回 Promise，sync react 无法等待，返回原 observation",
        );
        return observation;
      }
      if (out && typeof out === "object") {
        return { ...observation, ...(out as Partial<ReActObservation>) };
      }
      return observation;
    } catch (err) {
      console.log(`[PlannerCortex] react 委托失败: ${err}`);
      return observation;
    }
  }

  /**
   * 子 Agent 委派：委托 MasterAgentCoordinator.invokeSubAgent(type, task, opts)。
   * 返回 SubAgentResult 形状（具体由子系统决定）。
   * 若 MasterAgentCoordinator 未注册或方法缺失，返回 { ok: false, error: ... }。
   */
  async delegate(
    subAgentType: string,
    task: { goal: string; input?: unknown },
    opts?: { actorId?: string },
  ): Promise<unknown> {
    const svc = this.masterCoordinator;
    if (!svc || typeof svc.invokeSubAgent !== "function") {
      console.log("[PlannerCortex] MasterAgentCoordinator 未注册或缺少 invokeSubAgent 方法");
      return { ok: false, error: "MasterAgentCoordinator 未注册" };
    }
    try {
      return await svc.invokeSubAgent(subAgentType, task, opts);
    } catch (err) {
      console.log(`[PlannerCortex] delegate 委托失败: ${err}`);
      return {
        ok: false,
        error: `delegate 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 规则层 shouldDelegate 判断（Task 6，非 LLM）。
   *
   * 基于关键词 + 步骤数估算决定是否主动委派。判断优先级：
   *  1. 白名单（时间/天气/打招呼/简单问答）命中 → 不委派（优先级最高，避免"你好"误判）
   *  2. 委派倾向词匹配 + 步骤数估算 > 3 → 委派，映射到 life/tech/info 子 Agent
   *  3. 其他 → 不委派
   *
   * 返回值：
   *  - { delegate: true, agentType, reason }：主动委派
   *  - { delegate: false }：走原 standard path 或 fast_chat
   */
  shouldDelegate(
    userMessage: string,
    _context?: { actorId?: string },
  ): ShouldDelegateResult {
    if (!userMessage || !userMessage.trim()) {
      return { delegate: false };
    }
    const msg = userMessage.toLowerCase();

    // 1. 白名单优先（命中则不委派）
    for (const kw of NO_DELEGATE_WHITELIST) {
      if (msg.includes(kw.toLowerCase())) {
        return { delegate: false };
      }
    }

    // 2. 估算步骤数 = 1 + 连词命中数 + 动作动词命中数（distinct）
    //    spec: 基于动词数量、连词估算步骤数 > 3
    let stepCount = 1;
    for (const conj of STEP_CONJUNCTIONS) {
      if (msg.includes(conj)) stepCount++;
    }
    for (const verb of ACTION_VERBS) {
      if (msg.includes(verb)) stepCount++;
    }

    // 3. 匹配委派倾向词，按 tech > info > life 优先级记录首个命中的 agentType
    let matchedType: SubAgentType | undefined;
    for (const agentType of ["tech", "info", "life"] as SubAgentType[]) {
      const keywords = DELEGATE_KEYWORDS[agentType];
      for (const kw of keywords) {
        if (msg.includes(kw.toLowerCase())) {
          matchedType = agentType;
          break;
        }
      }
      if (matchedType) break;
    }

    // 4. 委派条件：步骤数 > 阈值 且 命中委派倾向词
    if (stepCount > DELEGATE_STEP_THRESHOLD && matchedType) {
      return {
        delegate: true,
        agentType: matchedType,
        reason: `多步任务委派（步骤数≈${stepCount}，匹配${matchedType}类关键词）`,
      };
    }

    return { delegate: false };
  }

  /**
   * 系统路由：委托 TaskRouter.routeLlmExecution(userMessage, opts)，
   * 把返回的 LlmExecutionMode 映射为 SystemRouteDecision 并缓存。
   * 若 TaskRouter 未注册或方法缺失，走内置关键词兜底路由。
   *
   * Task 6 注入点：在路由顶部先调 shouldDelegate，若命中则主动 fire delegate
   * 并返回 master_delegate 路径，不等待主 Agent LLM 自行决定是否调 delegate 工具。
   */
  routeSystem(userMessage: string, opts?: { actorId?: string }): SystemRouteDecision {
    // Task 6：规则层主动委派检查（优先于 TaskRouter/builtinRoute）
    const delegation = this.shouldDelegate(userMessage, opts);
    if (delegation.delegate && delegation.agentType) {
      console.log(
        `[PlannerCortex] shouldDelegate 命中：${delegation.reason}，主动委派给 ${delegation.agentType} 子 Agent`,
      );
      // 主动触发 delegate（fire-and-forget，不阻塞同步 routeSystem）
      void this.delegate(
        delegation.agentType,
        { goal: userMessage },
        { actorId: opts?.actorId },
      ).catch((err) => {
        console.log(`[PlannerCortex] shouldDelegate 主动委派失败: ${err}`);
      });
      const route: SystemRouteDecision = {
        userMessage,
        system: "system2",
        mode: "master_delegate",
        rationale: `shouldDelegate 主动委派→${delegation.agentType}：${delegation.reason}`,
        decidedAt: nowIso(),
      };
      this.lastRoute = route;
      return route;
    }

    const svc = this.taskRouter;
    if (svc && typeof svc.routeLlmExecution === "function") {
      try {
        const raw = svc.routeLlmExecution(userMessage, opts);
        const decision = coerceToRouteDecision(userMessage, raw);
        this.lastRoute = decision;
        return decision;
      } catch (err) {
        console.log(`[PlannerCortex] routeSystem 委托失败，退回兜底: ${err}`);
      }
    } else {
      console.log(
        "[PlannerCortex] TaskRouter 未注册或缺少 routeLlmExecution 方法，使用内置兜底路由",
      );
    }
    const fallback = builtinRoute(userMessage);
    this.lastRoute = fallback;
    return fallback;
  }

  // ---- 读取最近缓存 ------------------------------------------------------

  /** 返回最近一次 plan / routeSystem 的结果，供 BrainCenter.snapshot 读取 */
  getLastPlan(): PlanResult | null {
    return this.lastPlan;
  }

  getLastRoute(): SystemRouteDecision | null {
    return this.lastRoute;
  }

  // ---- 内部工具 ----------------------------------------------------------

  private async startSubsystem(
    name: string,
    svc: { start?(): Promise<void> } | null,
  ): Promise<void> {
    if (!svc || typeof svc.start !== "function") return;
    try {
      await svc.start();
      console.log(`[PlannerCortex] ${name} 已启动`);
    } catch (err) {
      console.log(`[PlannerCortex] ${name} 启动失败: ${err}`);
    }
  }

  private async stopSubsystem(
    name: string,
    svc: { stop?(): Promise<void> } | null,
  ): Promise<void> {
    if (!svc || typeof svc.stop !== "function") return;
    try {
      await svc.stop();
      console.log(`[PlannerCortex] ${name} 已停止`);
    } catch (err) {
      console.log(`[PlannerCortex] ${name} 停止失败: ${err}`);
    }
  }
}

