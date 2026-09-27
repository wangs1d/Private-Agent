/**
 * GoalPlanner —— 计划推进型目标（2026-09-24，对标 Muse「大目标 → 计划 → 自主推进 →
 * 动态调整」的本地落地，五层主动性架构 L4 的第三类目标）。
 *
 * 与 track（盯一件事）/ preexec（备一件事）互补：plan = 拆成步骤的长期目标，
 * 每步派后台任务面执行（agentCore.dispatchBackgroundTask），TaskHub 终态回调
 * 自动推进下一步；全部完成 → GoalBoard.markReady 进 ReadyTray，经 goal_ready
 * 评估器挑时机投递「计划完成」摘要。
 *
 * 敏感动作边界（security/sensitive-action 定轴）：步骤描述命中外部副作用词
 * （下单/支付/代发/外呼…）时不自动派发，转 awaiting_confirm 等用户点头——
 * agent 自主推进到外部世界的门口必须停下（Muse 的"需要批准时回来找你" +
 * Shopify 默认 handoff 同构）。确认后经 advance({confirmExternal:true}) 放行。
 *
 * 动态调整 = replan：替换尚未完成的步骤（已完成/失败步保留存档），生活变化
 * （出差/生病/改主意）后模型在对话中调 goal.plan.replan 重排。
 */
import type { GoalBoard, GoalRecord } from "./goal-board.js";
import { classifyTextSensitivity, type ActionSensitivity } from "../security/sensitive-action.js";
import type { TaskHub } from "../task-plane/task-hub.js";

export type PlanStepStatus = "todo" | "doing" | "awaiting_confirm" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** 敏感分级（创建时按标题判定；external 步骤不自动派发） */
  sensitivity: ActionSensitivity;
  /** doing 状态时关联的后台任务 id（TaskHub 终态回调推进的钥匙） */
  taskId?: string;
  /** 结果/原因备注（完成摘要、失败原因、重排原因都落这里） */
  note?: string;
  updatedAt: number;
}

interface PlanPayload {
  steps?: PlanStep[];
  /** 最近一次 replan 的原因 */
  lastReplanReason?: string;
  /** plan 建立时的会话（结果投递归属） */
  sessionId?: string;
}

export interface GoalPlannerDeps {
  goalBoard: GoalBoard;
  /**
   * 后台任务派发（bootstrap 晚绑定 agentCore.dispatchBackgroundTask；
   * LLM 未启用/预算超限时返回 null——步骤如实停在 todo，不假装推进）。
   */
  launchTask?: (input: { actorId: string; sessionId?: string; goal: string; note?: string }) => string | null;
  /**
   * 步骤事件落代办足迹台账（可选注入）：awaiting_confirm / failed / 计划完成
   * 三类事件主动告知用户，复用 AgentActivityStore + activity_new 推送。
   */
  recordActivity?: (input: {
    actorId: string;
    title: string;
    summary: string;
    status?: "pending" | "done" | "failed";
  }) => void;
}

export type AdvanceOutcome =
  | { ok: true; action: "dispatched"; step: PlanStep; remaining: number }
  | { ok: true; action: "awaiting_confirm"; step: PlanStep; reason: string }
  | { ok: true; action: "blocked"; step: PlanStep; reason: string }
  | { ok: true; action: "already_doing"; step: PlanStep }
  | { ok: true; action: "finished"; summary: string }
  | { ok: false; error: string };

/** 单计划步骤上限（防一步计划拆成一百步的滥用） */
const MAX_STEPS = 12;
/** 自动放行外部步骤的总开关（默认关：外部动作必须用户确认） */
function autoExternalEnabled(): boolean {
  return process.env.GOAL_PLAN_AUTO_EXTERNAL === "1";
}

export class GoalPlanner {
  /** taskId → {goalId, stepId}：TaskHub 终态回调的反查索引 */
  private readonly pendingTasks = new Map<string, { goalId: string; stepId: string }>();
  private detach: (() => void) | null = null;

  constructor(private readonly deps: GoalPlannerDeps) {}

  // ─────────────────────────── 创建 / 查询 ───────────────────────────

  createPlan(input: {
    actorId: string;
    sessionId?: string;
    title: string;
    /** 有序步骤描述（一句话一步） */
    steps: string[];
    note?: string;
  }): { ok: true; goal: GoalRecord } | { ok: false; error: string } {
    const title = String(input.title ?? "").trim();
    const rawSteps = (input.steps ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
    if (!title) return { ok: false, error: "缺少 title（目标一句话）" };
    if (rawSteps.length === 0) return { ok: false, error: "至少拆出 1 个步骤" };
    if (rawSteps.length > MAX_STEPS) return { ok: false, error: `步骤太多（上限 ${MAX_STEPS} 步），先拆主干` };

    const now = Date.now();
    const steps: PlanStep[] = rawSteps.map((s, i) => ({
      id: `s${i + 1}`,
      title: s.slice(0, 200),
      status: "todo",
      sensitivity: classifyTextSensitivity(s),
      updatedAt: now,
    }));

    const payload: PlanPayload = { steps, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    const goal = this.deps.goalBoard.create({
      actorId: input.actorId,
      kind: "plan",
      type: "plan",
      title: title.slice(0, 120),
      payload: payload as unknown as Record<string, unknown>,
    });
    return { ok: true, goal };
  }

  /** 某 actor 的全部计划（活跃在前，最近更新优先） */
  listPlans(actorId: string): GoalRecord[] {
    return this.deps.goalBoard
      .list(actorId)
      .filter((g) => g.kind === "plan")
      .sort((a, b) => {
        const aDone = a.status === "done" || a.status === "ready" ? 1 : 0;
        const bDone = b.status === "done" || b.status === "ready" ? 1 : 0;
        return aDone - bDone || lastStepAt(b) - lastStepAt(a);
      });
  }

  getPlan(goalId: string, actorId?: string): GoalRecord | null {
    const goal = this.deps.goalBoard.get(goalId);
    if (!goal || goal.kind !== "plan") return null;
    if (actorId && goal.actorId !== actorId) return null;
    return goal;
  }

  stepsOf(goal: GoalRecord): PlanStep[] {
    const steps = (goal.payload as PlanPayload | undefined)?.steps;
    return Array.isArray(steps) ? steps : [];
  }

  /** 计划进度摘要（注入对话/投递文案用） */
  progressLine(goal: GoalRecord): string {
    const steps = this.stepsOf(goal);
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const doing = steps.find((s) => s.status === "doing" || s.status === "awaiting_confirm");
    const head = `${done}/${steps.length} 步`;
    if (doing) return `${head}，当前「${doing.title}」${doing.status === "awaiting_confirm" ? "（等你确认）" : "进行中"}`;
    if (goal.status === "ready" || goal.status === "done") return `${head}，已完成`;
    return `${head}`;
  }

  // ─────────────────────────── 推进 ───────────────────────────

  /**
   * 推进计划：从第一个可推进的步骤开始派发。外部步骤（未确认）转
   * awaiting_confirm；后台通道不可用时步骤停在 todo 并如实说明。
   */
  advance(goalId: string, actorId: string, opts: { confirmExternal?: boolean } = {}): AdvanceOutcome {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    if (goal.status === "done" || goal.status === "ready") {
      return { ok: false, error: "计划已完成，无需推进" };
    }
    const steps = this.stepsOf(goal);
    const doing = steps.find((s) => s.status === "doing");
    if (doing) return { ok: true, action: "already_doing", step: doing };

    // 确认放行：把 awaiting_confirm 的步骤转回 todo 再走正常推进
    if (opts.confirmExternal) {
      const awaiting = steps.filter((s) => s.status === "awaiting_confirm");
      for (const s of awaiting) {
        s.status = "todo";
        s.updatedAt = Date.now();
      }
      this.persistSteps(goal, steps);
    }

    // 本轮带 confirmExternal=true：用户已明确同意外部步骤，本轮放行不再拦
    const confirmBypass = opts.confirmExternal === true;

    const next = steps.find((s) => s.status === "todo");
    if (!next) {
      const awaiting = steps.find((s) => s.status === "awaiting_confirm");
      if (awaiting) {
        return {
          ok: true,
          action: "awaiting_confirm",
          step: awaiting,
          reason: "该步骤涉及外部操作（下单/发送/支付类），需要用户明确同意后才能执行",
        };
      }
      return this.finishPlan(goal);
    }

    if (next.sensitivity === "act_external" && !autoExternalEnabled() && !confirmBypass) {
      next.status = "awaiting_confirm";
      next.updatedAt = Date.now();
      this.persistSteps(goal, steps);
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」等你确认`,
        summary: `下一步「${next.title}」涉及外部操作，同意后我继续推进`,
        status: "pending",
      });
      return {
        ok: true,
        action: "awaiting_confirm",
        step: next,
        reason: "该步骤涉及外部操作（下单/发送/支付类），需要用户明确同意后才能执行",
      };
    }

    return this.dispatchStep(goal, steps, next);
  }

  /** 手工置步骤状态（模型在对话中确认结果/跳过时调用） */
  markStep(
    goalId: string,
    actorId: string,
    stepId: string,
    status: "done" | "failed" | "skipped",
    note?: string,
  ): AdvanceOutcome | { ok: false; error: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    const steps = this.stepsOf(goal);
    const step = steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `步骤不存在：${stepId}` };
    if (step.taskId) this.pendingTasks.delete(step.taskId);
    step.status = status;
    step.note = note?.slice(0, 300);
    step.updatedAt = Date.now();
    this.persistSteps(goal, steps);
    if (status === "done" || status === "skipped") return this.advance(goalId, actorId);
    return { ok: true, action: "blocked", step, reason: "步骤已标记失败，计划暂停推进" };
  }

  /**
   * 动态调整：替换未完成步骤（done/failed/skipped 保留存档），记录原因。
   * 正在做的一步若仍在新列表语义内由模型自己决定是否保留（本工具整体重排 todo 尾部）。
   */
  replan(
    goalId: string,
    actorId: string,
    newSteps: string[],
    reason?: string,
  ): { ok: true; goal: GoalRecord } | { ok: false; error: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    if (goal.status === "done" || goal.status === "ready") return { ok: false, error: "计划已完成" };
    const cleaned = newSteps.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (cleaned.length === 0) return { ok: false, error: "新步骤列表为空（放弃计划请用 abandon）" };
    if (cleaned.length > MAX_STEPS) return { ok: false, error: `步骤太多（上限 ${MAX_STEPS} 步）` };

    const steps = this.stepsOf(goal);
    const now = Date.now();
    // 正在跑的步骤不硬停（结果回来时按 taskId 反查落账，查不到原步骤则静默忽略）
    const doing = steps.find((s) => s.status === "doing");
    const archived = steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
    const next: PlanStep[] = [
      ...archived,
      ...(doing ? [{ ...doing }] : []),
      ...cleaned.map((s, i) => ({
        id: `r${now.toString(36)}_${i + 1}`,
        title: s.slice(0, 200),
        status: "todo" as const,
        sensitivity: classifyTextSensitivity(s),
        updatedAt: now,
      })),
    ];
    const payload = goal.payload as PlanPayload;
    payload.steps = next;
    payload.lastReplanReason = (reason ?? "情况有变").slice(0, 200);
    this.deps.goalBoard.markReadyTouch(goalId); // 触发一次 goal 信号（状态不变也刷新 fingerprint）
    this.persistSteps(goal, next);
    return { ok: true, goal };
  }

  /** 放弃计划（用户改主意/目标作废） */
  abandon(goalId: string, actorId: string, reason?: string): { ok: boolean; error?: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    for (const step of this.stepsOf(goal)) {
      if (step.taskId) this.pendingTasks.delete(step.taskId);
    }
    this.deps.goalBoard.markDone(goalId);
    this.deps.recordActivity?.({
      actorId,
      title: `计划「${goal.title}」已放弃`,
      summary: reason?.slice(0, 200) || "你确认不再推进这个计划",
      status: "done",
    });
    return { ok: true };
  }

  // ─────────────────────────── TaskHub 接线 ───────────────────────────

  /**
   * 挂接任务面终态回调（bootstrap 调一次）：doing 步骤对应任务 done → 记完成
   * 并自动推进下一步；failed/cancelled → 步骤失败、计划暂停（不静默重试，
   * 失败如实停住等用户指示——任务面 restart-recovery 的自动重跑封顶已另管）。
   * 返回退订函数（测试/停机用）。
   */
  attachTaskHub(taskHub: TaskHub): () => void {
    this.detach?.();
    const listener = (record: { taskId: string; state: string; progressLine?: string }, kind: string): void => {
      if (kind !== "state") return;
      const hit = this.pendingTasks.get(record.taskId);
      if (!hit) return;
      if (record.state === "done") {
        this.resolveStep(hit.goalId, hit.stepId, "done", record.progressLine);
      } else if (record.state === "failed" || record.state === "cancelled") {
        this.resolveStep(hit.goalId, hit.stepId, "failed", record.progressLine ?? "任务未完成");
      }
    };
    taskHub.addExtraListener(listener as Parameters<TaskHub["addExtraListener"]>[0]);
    this.detach = () => taskHub.removeExtraListener(listener as Parameters<TaskHub["addExtraListener"]>[0]);
    return this.detach;
  }

  /**
   * 重启对账（bootstrap 装配后调一次）：doing 步骤的任务台账已终态/丢失时
   * 如实落账——done 补记完成，失败/丢失标失败；仍在跑的留给终态回调。
   */
  reconcile(taskHub: TaskHub): void {
    for (const goal of this.deps.goalBoard.list()) {
      if (goal.kind !== "plan" || goal.status === "done" || goal.status === "ready") continue;
      for (const step of this.stepsOf(goal)) {
        if (step.status !== "doing" || !step.taskId) continue;
        const rec = taskHub.get(step.taskId);
        if (!rec) {
          step.status = "failed";
          step.note = "服务器重启，执行记录丢失";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else if (rec.state === "done") {
          step.status = "done";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else if (rec.state === "failed" || rec.state === "cancelled") {
          step.status = "failed";
          step.note = rec.progressLine ?? "任务失败";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else {
          this.pendingTasks.set(step.taskId, { goalId: goal.goalId, stepId: step.id });
        }
      }
    }
  }

  /** 测试/停机：清空反查索引 */
  reset(): void {
    this.pendingTasks.clear();
    this.detach?.();
    this.detach = null;
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private dispatchStep(goal: GoalRecord, steps: PlanStep[], step: PlanStep): AdvanceOutcome {
    const launch = this.deps.launchTask;
    if (!launch) {
      return {
        ok: true,
        action: "blocked",
        step,
        reason: "后台任务通道未就绪（LLM 未启用），步骤保持待办",
      };
    }
    const payload = goal.payload as PlanPayload;
    const taskId = launch({
      actorId: goal.actorId,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      goal: `【计划推进】${goal.title}｜第 ${steps.indexOf(step) + 1} 步：${step.title}`,
    });
    if (!taskId) {
      return {
        ok: true,
        action: "blocked",
        step,
        reason: "后台任务通道不可用（预算超限或未就绪），步骤保持待办",
      };
    }
    step.status = "doing";
    step.taskId = taskId;
    step.updatedAt = Date.now();
    this.pendingTasks.set(taskId, { goalId: goal.goalId, stepId: step.id });
    this.persistSteps(goal, steps);
    return { ok: true, action: "dispatched", step, remaining: steps.filter((s) => s.status === "todo").length };
  }

  /** 步骤终态落账 + 自动推进（done）或停住（failed） */
  private resolveStep(goalId: string, stepId: string, status: "done" | "failed", note?: string): void {
    const goal = this.deps.goalBoard.get(goalId);
    if (!goal || goal.kind !== "plan") return;
    const steps = this.stepsOf(goal);
    const step = steps.find((s) => s.id === stepId);
    if (!step || (step.status !== "doing" && step.status !== "awaiting_confirm")) return;
    step.status = status;
    if (note) step.note = String(note).slice(0, 300);
    step.updatedAt = Date.now();
    this.persistSteps(goal, steps);

    if (status === "failed") {
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」第 ${steps.indexOf(step) + 1} 步没办成`,
        summary: `「${step.title}」：${step.note ?? "任务失败"}。我停在这一步，等你的指示`,
        status: "failed",
      });
      return;
    }
    // 完成即自动推进下一步（外部步骤会在 advance 里被拦下等确认）
    const outcome = this.advance(goalId, goal.actorId);
    if (outcome.ok && outcome.action === "finished") {
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」全部完成`,
        summary: outcome.summary,
        status: "done",
      });
    }
  }

  /** 全部步骤终结 → markReady 进 ReadyTray（goal_ready 评估器挑时机投递摘要） */
  private finishPlan(goal: GoalRecord): { ok: true; action: "finished"; summary: string } {
    const steps = this.stepsOf(goal);
    const lines = steps.map((s, i) => {
      const mark = s.status === "failed" ? "✗" : s.status === "skipped" ? "—" : "✓";
      return `${mark} ${i + 1}. ${s.title}${s.note ? `（${s.note}）` : ""}`;
    });
    const summary = `「${goal.title}」计划完成：${steps.filter((s) => s.status === "done").length} 步办成` +
      (steps.some((s) => s.status === "failed") ? `，${steps.filter((s) => s.status === "failed").length} 步没办成` : "");
    this.deps.goalBoard.markReady(goal.goalId, {
      body: `${summary}\n${lines.join("\n")}`,
      bodyKind: "plan_done",
      dedupFields: { title: `计划完成：${goal.title}` },
    });
    return { ok: true, action: "finished", summary };
  }

  private persistSteps(goal: GoalRecord, steps: PlanStep[]): void {
    (goal.payload as PlanPayload).steps = steps;
    // 直接复用 GoalBoard 的落盘/信号链路：markReadyTouch 刷一次存在信号
    this.deps.goalBoard.markReadyTouch(goal.goalId);
  }
}

function lastStepAt(goal: GoalRecord): number {
  const steps = (goal.payload as PlanPayload | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return goal.createdAt;
  return Math.max(...steps.map((s) => s.updatedAt ?? 0));
}
