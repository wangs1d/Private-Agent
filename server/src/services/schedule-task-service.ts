import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, join } from "path";

import { taskHasOccurrenceInRange } from "./schedule-recurrence-expand.js";

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly" | "cron";
export type ScheduleTaskKind = "reminder" | "action" | "weather_brief" | "agent_task";
export type ScheduleTaskStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduleRunStatus = "success" | "failed";

/**
 * 任务分类：itinerary=行程/正事（会议、约会、截止等，进「今日安排」展示）；
 * trivia=生活琐事提醒（喝水、睡觉、活动身体等，只做后台到点提醒，不进「今日安排」）。
 * 缺省（含旧数据）按 itinerary 处理，保证展示兜底。
 */
export type ScheduleTaskCategory = "itinerary" | "trivia";

/** 节律任务标记前缀（care.rhythm_reminder 写入 description；旧数据无 category 时的兜底识别） */
export const RHYTHM_MARK = "[节律提醒:";

/** 宽松解析外部输入（工具参数/HTTP body）中的分类字段，非法值回退 undefined（=按 itinerary 展示）。 */
export function parseScheduleTaskCategory(value: unknown): ScheduleTaskCategory | undefined {
  const v = String(value ?? "").trim();
  return v === "itinerary" || v === "trivia" ? v : undefined;
}

/** 是否为「仅后台提醒、不进今日安排」的任务：显式 trivia 分类，或旧数据带节律标记。 */
export function isTriviaTask(
  task: Pick<ScheduleTaskRecord, "category" | "description">,
): boolean {
  return task.category === "trivia" || task.description.startsWith(RHYTHM_MARK);
}

export type ScheduleActionConfig = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
};

export type ScheduleAgentTaskConfig = {
  prompt: string;
  accessMode?: "sandbox" | "full";
};

export type ScheduleTaskRecord = {
  taskId: string;
  sessionId: string;
  title?: string;
  /** 简洁展示标题（用于「今日安排」等紧凑列表，创建时由 LLM 在同一个调用里生成，区别于完整 title / reminderMessage） */
  shortTitle?: string;
  description: string;
  kind: ScheduleTaskKind;
  category?: ScheduleTaskCategory;
  recurrence: ScheduleRecurrence;
  timezone: string;
  runAt: string;
  nextRunAt: string | null;
  cronExpression?: string;
  webhookToken?: string;
  status: ScheduleTaskStatus;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  /** 事件时长（分钟）；0/缺省 = 时间点提醒（无区间）。用于冲突检测与「今日安排」区间展示。 */
  durationMinutes?: number;
  /** 提前量提醒（分钟数组，如 [15,5]）：到点前按各偏移各推一次，主触发前不打断。 */
  remindBeforeMinutes?: number[];
  /** 来源标记：manual=用户/LLM 直建；booking=预订下单联动自动生成。 */
  source?: "manual" | "booking";
  /** 关联的本地预订订单号（source=booking 时写入，用于取消/改期反向同步）。 */
  sourceBookingOrderId?: string;
  /** 本次待触发周期内已发出的提前提醒偏移（主触发后重置）。 */
  firedPreReminderOffsets?: number[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
};

export type ScheduleTaskRun = {
  runId: string;
  taskId: string;
  plannedAt: string;
  startedAt: string;
  endedAt: string;
  status: ScheduleRunStatus;
  output?: unknown;
  error?: string;
};

type PersistedScheduleState = {
  tasks?: ScheduleTaskRecord[];
  runs?: ScheduleTaskRun[];
};

export type CreateScheduleTaskInput = {
  sessionId: string;
  title?: string;
  shortTitle?: string;
  description: string;
  kind: ScheduleTaskKind;
  category?: ScheduleTaskCategory;
  runAt?: string;
  recurrence: ScheduleRecurrence;
  timezone?: string;
  cronExpression?: string;
  webhookToken?: string;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  durationMinutes?: number;
  remindBeforeMinutes?: number[];
  source?: "manual" | "booking";
  sourceBookingOrderId?: string;
};

export type UpdateScheduleTaskInput = {
  title?: string;
  shortTitle?: string;
  description?: string;
  category?: ScheduleTaskCategory;
  recurrence?: ScheduleRecurrence;
  runAt?: string;
  timezone?: string;
  cronExpression?: string | null;
  webhookToken?: string | null;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  durationMinutes?: number;
  remindBeforeMinutes?: number[];
  status?: Extract<ScheduleTaskStatus, "active" | "paused" | "cancelled">;
};

export type WeatherBriefHandler = (task: ScheduleTaskRecord) => Promise<Record<string, unknown>>;

export type ScheduleReminderHandler = (
  task: ScheduleTaskRecord,
  message: string,
) => Promise<void>;

export type AgentTaskHandler = (task: ScheduleTaskRecord) => Promise<Record<string, unknown>>;
export type ScheduleTaskChangeAction = "created" | "updated" | "deleted";
export type ScheduleTaskChangeHandler = (
  action: ScheduleTaskChangeAction,
  task: ScheduleTaskRecord,
) => void | Promise<void>;

/** 宽松解析时长（分钟）：非法/越界回退 undefined；0 视为无区间。 */
export function normalizeDurationMinutes(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.round(n), 24 * 60 * 7);
}

/** 宽松解析提前量数组（分钟）：过滤非法值、去重、倒序（大偏移在前），最多 5 个。 */
export function normalizeRemindBeforeMinutes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  for (const raw of value.slice(0, 5)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 24 * 60 * 7) seen.add(Math.round(n));
  }
  if (seen.size === 0) return undefined;
  return [...seen].sort((a, b) => b - a);
}

/** 任务在给定起点时刻的结束时刻（UTC ms）；无 durationMinutes 时 = 起点（零长区间）。 */
export function taskEndMs(startMs: number, durationMinutes?: number): number {
  return startMs + (durationMinutes && durationMinutes > 0 ? durationMinutes : 0) * 60_000;
}

/**
 * 同一次创建意图的 runAt 锚点容差：程序层确定性创建与模型工具调用解析的是同一句
 * 用户原话，锚点差异只会来自毫秒级解析抖动，超过该值即视为两次独立创建。
 */
const DUPLICATE_RUN_AT_TOLERANCE_MS = 60_000;

/** 内容归一化：去全部空白 + 小写，跨创建路径（程序层/工具/HTTP）对同一句话稳定可比。 */
function normalizeScheduleContent(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

export class ScheduleTaskService {
  private readonly byTaskId = new Map<string, ScheduleTaskRecord>();
  private readonly runsByTaskId = new Map<string, ScheduleTaskRun[]>();
  private readonly runningTaskIds = new Set<string>();
  private tickHandle: NodeJS.Timeout | undefined;
  private weatherBriefHandler?: WeatherBriefHandler;
  private reminderHandler?: ScheduleReminderHandler;
  private agentTaskHandler?: AgentTaskHandler;
  private taskChangeHandler?: ScheduleTaskChangeHandler;

  private get persistPath(): string {
    return process.env.SCHEDULE_TASKS_FILE ?? join(process.cwd(), "data", "schedule-tasks.json");
  }

  setWeatherBriefHandler(handler: WeatherBriefHandler | undefined): void {
    this.weatherBriefHandler = handler;
  }

  setReminderHandler(handler: ScheduleReminderHandler | undefined): void {
    this.reminderHandler = handler;
  }

  setAgentTaskHandler(handler: AgentTaskHandler | undefined): void {
    this.agentTaskHandler = handler;
  }

  setTaskChangeHandler(handler: ScheduleTaskChangeHandler | undefined): void {
    this.taskChangeHandler = handler;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedScheduleState;
      this.byTaskId.clear();
      this.runsByTaskId.clear();
      for (const task of data.tasks ?? []) {
        if (task?.taskId && task?.sessionId) {
          this.byTaskId.set(task.taskId, task);
        }
      }
      for (const run of data.runs ?? []) {
        if (!run?.taskId || !run?.runId) continue;
        const list = this.runsByTaskId.get(run.taskId) ?? [];
        list.push(run);
        this.runsByTaskId.set(run.taskId, list);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  startScheduler(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  stopScheduler(): void {
    if (!this.tickHandle) return;
    clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const tasks = Array.from(this.byTaskId.values());
    const runs = Array.from(this.runsByTaskId.values()).flat();
    await writeFile(this.persistPath, JSON.stringify({ tasks, runs }, null, 2), "utf8");
  }

  /** 全量任务列表（跨会话；UpcomingScheduleWatcher 临近日程扫描用） */
  listAllTasks(): ScheduleTaskRecord[] {
    return Array.from(this.byTaskId.values());
  }

  listTasksBySession(
    sessionId: string,
    range?: { from?: string; to?: string },
  ): ScheduleTaskRecord[] {
    const now = Date.now();
    const from = range?.from ? new Date(range.from).getTime() : now;
    const hasExplicitTo = !!range?.to;
    // 非周期任务沿用原行为：未给 to → +∞（列出所有未来单次任务）
    const toForSingle = hasExplicitTo ? new Date(range!.to!).getTime() : Number.POSITIVE_INFINITY;
    // 周期任务展开需要有限上界，避免 expandTaskOccurrenceTimes 无限循环；未指定时默认查 7 天
    const toForRecurring = hasExplicitTo
      ? new Date(range!.to!).getTime()
      : now + 7 * 24 * 60 * 60 * 1000;
    return Array.from(this.byTaskId.values())
      .filter((task) => task.sessionId === sessionId)
      .filter((task) => {
        if (task.status === "cancelled") return false;
        // 周期任务（daily/weekly/yearly）：用展开器检查区间内是否有任何实例
        if (task.recurrence !== "none") {
          return taskHasOccurrenceInRange(task, from, toForRecurring);
        }
        const relevantAt =
          task.status === "completed"
            ? task.lastRunAt ?? task.runAt
            : (task.nextRunAt ?? task.runAt);
        const relevantTime = new Date(relevantAt).getTime();
        return Number.isFinite(relevantTime) && relevantTime >= from && relevantTime <= toForSingle;
      })
      .sort((a, b) =>
        (a.status === "completed" ? (a.lastRunAt ?? a.runAt) : (a.nextRunAt ?? a.runAt)).localeCompare(
          b.status === "completed" ? (b.lastRunAt ?? b.runAt) : (b.nextRunAt ?? b.runAt),
        ),
      );
  }

  listRuns(taskId: string, limit = 20): ScheduleTaskRun[] {
    const list = this.runsByTaskId.get(taskId) ?? [];
    return [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  getTask(taskId: string): ScheduleTaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  /** 按关联预订订单号查找未结束的日程（预订取消/改期反向同步用）。 */
  findTaskByBookingOrderId(orderId: string): ScheduleTaskRecord | undefined {
    const id = orderId.trim();
    if (!id) return undefined;
    for (const task of this.byTaskId.values()) {
      if (task.sourceBookingOrderId === id && task.status !== "cancelled") return task;
    }
    return undefined;
  }

  async deleteTask(taskId: string): Promise<void> {
    const task = this.byTaskId.get(taskId);
    if (!task) {
      throw new Error("task not found");
    }
    this.byTaskId.delete(taskId);
    this.runsByTaskId.delete(taskId);
    await this.persist();
    await this.emitTaskChange("deleted", task);
  }

  /**
   * 活动任务重复检测（幂等创建的判定核心）：同会话 + 同类型 + 同归一化内容 +
   * 同时间签名（时区/重复规则/cron/runAt 锚点）的 active/paused 任务已存在时，
   * 判定为同一次创建意图的多路径重放——程序层确定性创建、模型工具调用
   * （reminder.plan / calendar.create_*）、客户端断线重发、HTTP 直写都从这里落库，
   * 只有第一次真实创建，后续一律返回已有任务。已结束（completed/cancelled）的
   * 任务不参与判定：用户稍后重设同名同刻的提醒必须能成功。
   */
  private findActiveDuplicate(
    input: CreateScheduleTaskInput,
    schedule: { recurrence: ScheduleRecurrence; runAt: string; cronExpression?: string },
    timezone: string,
  ): ScheduleTaskRecord | undefined {
    const description = normalizeScheduleContent(input.description);
    const reminderMessage = normalizeScheduleContent(input.reminderMessage ?? input.description);
    const runAtMs = Date.parse(schedule.runAt);
    for (const task of this.byTaskId.values()) {
      if (task.sessionId !== input.sessionId || task.kind !== input.kind) continue;
      if (task.status !== "active" && task.status !== "paused") continue;
      if (normalizeScheduleContent(task.description) !== description) continue;
      if (normalizeScheduleContent(task.reminderMessage ?? task.description) !== reminderMessage) {
        continue;
      }
      if (task.timezone !== timezone || task.recurrence !== schedule.recurrence) continue;
      if (schedule.recurrence === "cron") {
        // cron 任务的签名就是表达式本身（runAt 是随创建时刻浮动的下次触发点）。
        if ((task.cronExpression ?? "") !== (schedule.cronExpression ?? "")) continue;
        return task;
      }
      const taskRunAtMs = Date.parse(task.runAt);
      if (
        Number.isFinite(runAtMs) &&
        Number.isFinite(taskRunAtMs) &&
        Math.abs(taskRunAtMs - runAtMs) <= DUPLICATE_RUN_AT_TOLERANCE_MS
      ) {
        return task;
      }
    }
    return undefined;
  }

  async createTask(input: CreateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const tz = input.timezone?.trim() || "Asia/Shanghai";
    const schedule = this.resolveSchedule(input.runAt, input.recurrence, tz, input.cronExpression);
    const now = new Date().toISOString();
    this.validateKindPayload(input.kind, input.reminderMessage, input.action, input.agentTask);
    // 幂等创建：命中重复时直接返回已有任务，不插入、不持久化、不广播 tasks_changed
    //（客户端本地镜像按 taskId 幂等，旧广播已存在，无需再发）。
    const duplicate = this.findActiveDuplicate(input, schedule, tz);
    if (duplicate) return duplicate;
    const task: ScheduleTaskRecord = {
      taskId: randomUUID(),
      sessionId: input.sessionId,
      title: input.title?.trim() || undefined,
      shortTitle: input.shortTitle?.trim() || undefined,
      description: input.description.trim(),
      kind: input.kind,
      category: input.category,
      recurrence: schedule.recurrence,
      timezone: tz,
      runAt: schedule.runAt,
      nextRunAt: schedule.nextRunAt,
      cronExpression: schedule.cronExpression,
      webhookToken: this.normalizeWebhookToken(input.webhookToken),
      status: "active",
      reminderMessage: input.reminderMessage?.trim() || undefined,
      action: input.action,
      agentTask: input.agentTask,
      durationMinutes: normalizeDurationMinutes(input.durationMinutes),
      remindBeforeMinutes: normalizeRemindBeforeMinutes(input.remindBeforeMinutes),
      source: input.source,
      sourceBookingOrderId: input.sourceBookingOrderId?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.byTaskId.set(task.taskId, task);
    await this.persist();
    await this.emitTaskChange("created", task);
    return task;
  }

  async updateTask(taskId: string, input: UpdateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const task = this.byTaskId.get(taskId);
    if (!task) {
      throw new Error("task not found");
    }
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("task already ended");
    }
    const next: ScheduleTaskRecord = {
      ...task,
      title: input.title?.trim() || task.title,
      shortTitle: input.shortTitle?.trim() || task.shortTitle,
      description: input.description?.trim() || task.description,
      category: input.category ?? task.category,
      recurrence: input.recurrence ?? task.recurrence,
      timezone: input.timezone?.trim() || task.timezone,
      cronExpression:
        input.cronExpression === undefined
          ? task.cronExpression
          : (input.cronExpression?.trim() || undefined),
      webhookToken:
        input.webhookToken === undefined
          ? task.webhookToken
          : this.normalizeWebhookToken(input.webhookToken ?? undefined),
      reminderMessage: input.reminderMessage?.trim() || task.reminderMessage,
      action: input.action ?? task.action,
      agentTask: input.agentTask ?? task.agentTask,
      durationMinutes:
        input.durationMinutes !== undefined
          ? normalizeDurationMinutes(input.durationMinutes)
          : task.durationMinutes,
      remindBeforeMinutes:
        input.remindBeforeMinutes !== undefined
          ? normalizeRemindBeforeMinutes(input.remindBeforeMinutes)
          : task.remindBeforeMinutes,
      updatedAt: new Date().toISOString(),
    };
    if (
      input.runAt !== undefined ||
      input.recurrence !== undefined ||
      input.timezone !== undefined ||
      input.cronExpression !== undefined
    ) {
      const schedule = this.resolveSchedule(
        input.runAt ?? task.runAt,
        next.recurrence,
        next.timezone,
        next.cronExpression,
      );
      next.recurrence = schedule.recurrence;
      next.runAt = schedule.runAt;
      next.nextRunAt = schedule.nextRunAt;
      next.cronExpression = schedule.cronExpression;
    }
    if (input.status) {
      next.status = input.status;
      if (input.status === "cancelled") {
        next.nextRunAt = null;
      }
    }
    this.validateKindPayload(next.kind, next.reminderMessage, next.action, next.agentTask);
    this.byTaskId.set(taskId, next);
    await this.persist();
    await this.emitTaskChange("updated", next);
    return next;
  }

  async triggerNow(taskId: string): Promise<void> {
    const task = this.byTaskId.get(taskId);
    if (!task) throw new Error("task not found");
    if (task.status !== "active") throw new Error("current task is not active");
    await this.executeTask(task, new Date().toISOString());
  }

  async triggerByWebhookToken(webhookToken: string): Promise<ScheduleTaskRecord> {
    const token = webhookToken.trim();
    if (!token) throw new Error("webhook token is required");
    const task = Array.from(this.byTaskId.values()).find((entry) => entry.webhookToken === token);
    if (!task) throw new Error("webhook task not found");
    if (task.status !== "active") throw new Error("current task is not active");
    await this.executeTask(task, new Date().toISOString());
    return this.byTaskId.get(task.taskId) ?? task;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    await this.firePreReminders(now);
    const dueTasks = Array.from(this.byTaskId.values()).filter((task) => {
      if (task.status !== "active" || !task.nextRunAt) return false;
      return new Date(task.nextRunAt).getTime() <= now;
    });
    for (const task of dueTasks) {
      if (this.runningTaskIds.has(task.taskId)) continue;
      this.runningTaskIds.add(task.taskId);
      const plannedAt = task.nextRunAt ?? new Date().toISOString();
      void this.executeTask(task, plannedAt).finally(() => {
        this.runningTaskIds.delete(task.taskId);
      });
    }
  }

  /** 提前量提醒：到点前按 remindBeforeMinutes 各偏移推送一次（不产生 run、不推进 nextRunAt）。 */
  private async firePreReminders(now: number): Promise<void> {
    if (!this.reminderHandler) return;
    for (const task of Array.from(this.byTaskId.values())) {
      if (task.status !== "active" || !task.nextRunAt) continue;
      if (task.kind !== "reminder") continue;
      const offsets = task.remindBeforeMinutes;
      if (!offsets?.length) continue;
      const runMs = new Date(task.nextRunAt).getTime();
      // 全部到期偏移一次触发（tick 间隔大于偏移间隔时不漏提醒）
      const dueOffsets = offsets.filter(
        (o) =>
          !(task.firedPreReminderOffsets ?? []).includes(o) &&
          now >= runMs - o * 60_000 &&
          now < runMs,
      );
      if (dueOffsets.length === 0) continue;
      const updated: ScheduleTaskRecord = {
        ...task,
        firedPreReminderOffsets: [...(task.firedPreReminderOffsets ?? []), ...dueOffsets],
      };
      this.byTaskId.set(task.taskId, updated);
      await this.persist();
      const base = task.reminderMessage || task.title || task.description;
      for (const dueOffset of dueOffsets.sort((a, b) => b - a)) {
        try {
          await this.reminderHandler(updated, `【提前${dueOffset}分钟】${base}`);
        } catch {
          // 提前提醒推送失败不影响主触发链路
        }
      }
    }
  }

  private async executeTask(task: ScheduleTaskRecord, plannedAt: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const run: ScheduleTaskRun = {
      runId,
      taskId: task.taskId,
      plannedAt,
      startedAt,
      endedAt: startedAt,
      status: "success",
    };
    try {
      if (task.kind === "reminder") {
        const message = task.reminderMessage || task.description;
        run.output = {
          type: "reminder",
          title: task.title,
          message,
        };
      } else if (task.kind === "weather_brief") {
        if (!this.weatherBriefHandler) {
          throw new Error("weather brief handler is not configured");
        }
        run.output = await this.weatherBriefHandler(task);
      } else if (task.kind === "agent_task") {
        if (!this.agentTaskHandler) {
          throw new Error("agent task handler is not configured");
        }
        run.output = await this.agentTaskHandler(task);
      } else {
        run.output = await this.executeAction(task);
      }
    } catch (e) {
      run.status = "failed";
      run.error = e instanceof Error ? e.message : String(e);
    } finally {
      run.endedAt = new Date().toISOString();
      const nextTaskState = this.computeNextTaskState(task, run.status === "success");
      this.byTaskId.set(task.taskId, nextTaskState);
      const list = this.runsByTaskId.get(task.taskId) ?? [];
      list.push(run);
      this.runsByTaskId.set(task.taskId, list);
      await this.persist();
      await this.emitTaskChange("updated", nextTaskState);
      if (task.kind === "reminder" && run.status === "success" && this.reminderHandler) {
        const message = task.reminderMessage || task.description;
        await this.reminderHandler(nextTaskState, message);
      }
    }
  }

  private computeNextTaskState(
    task: ScheduleTaskRecord,
    wasSuccessful: boolean,
  ): ScheduleTaskRecord {
    const updated: ScheduleTaskRecord = {
      ...task,
      lastRunAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 主触发后重置提前提醒记录，下一周期可再次推送
      firedPreReminderOffsets: undefined,
    };
    if (!wasSuccessful) {
      updated.nextRunAt = new Date(Date.now() + 60_000).toISOString();
      return updated;
    }
    if (updated.cronExpression) {
      updated.recurrence = "cron";
      updated.nextRunAt = this.computeNextCronRun(
        updated.cronExpression,
        updated.timezone,
        updated.lastRunAt ?? updated.runAt,
      );
      return updated;
    }
    if (updated.recurrence === "none") {
      updated.status = "completed";
      updated.nextRunAt = null;
      return updated;
    }

    const anchorUtc = new Date(updated.nextRunAt ?? updated.runAt);
    const local = this.toLocalInTimezone(anchorUtc, updated.timezone);
    if (updated.recurrence === "daily") {
      local.setDate(local.getDate() + 1);
    } else if (updated.recurrence === "weekly") {
      local.setDate(local.getDate() + 7);
    } else {
      local.setFullYear(local.getFullYear() + 1);
    }
    updated.nextRunAt = this.toUtcFromLocalTime(local, updated.timezone).toISOString();
    return updated;
  }

  private async executeAction(task: ScheduleTaskRecord): Promise<unknown> {
    if (!task.action?.url) {
      throw new Error("action task requires url");
    }
    await assertSafeActionUrl(task.action.url);
    const method = task.action.method ?? "POST";
    const res = await fetch(task.action.url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(task.action.headers ?? {}),
      },
      body:
        method === "GET" || method === "DELETE" ? undefined : JSON.stringify(task.action.body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`task api call failed: ${res.status} ${res.statusText} ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  private resolveSchedule(
    runAtRaw: string | undefined,
    recurrence: ScheduleRecurrence,
    timezone: string,
    cronExpression?: string,
  ): {
    recurrence: ScheduleRecurrence;
    runAt: string;
    nextRunAt: string | null;
    cronExpression?: string;
  } {
    const normalizedCron = cronExpression?.trim() || undefined;
    if (normalizedCron) {
      const nextRunAt = this.computeNextCronRun(normalizedCron, timezone);
      return {
        recurrence: "cron",
        runAt: nextRunAt,
        nextRunAt,
        cronExpression: normalizedCron,
      };
    }
    if (!runAtRaw?.trim()) {
      throw new Error("runAt or cronExpression is required");
    }
    const runAt = this.parseRunAt(runAtRaw, timezone).toISOString();
    return {
      recurrence,
      runAt,
      nextRunAt: runAt,
    };
  }

  private parseRunAt(raw: string, timezone: string): Date {
    const normalizedRaw = raw.trim();
    const hasExplicitTimezone = /(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(normalizedRaw);
    const utc =
      hasExplicitTimezone
        ? this.parseAbsoluteRunAt(normalizedRaw)
        : this.parseLocalRunAt(normalizedRaw, timezone);
    if (utc.getTime() < Date.now() - 5000) {
      throw new Error("runAt must be in the future");
    }
    return utc;
  }

  private parseAbsoluteRunAt(raw: string): Date {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new Error("invalid runAt");
    }
    return date;
  }

  private parseLocalRunAt(raw: string, timezone: string): Date {
    const match = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/,
    );
    if (match) {
      const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
      const local = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        0,
      );
      return this.toUtcFromLocalTime(local, timezone);
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new Error("invalid runAt");
    }
    return this.toUtcFromLocalTime(date, timezone);
  }

  private normalizeWebhookToken(token: string | undefined): string | undefined {
    const normalized = token?.trim();
    return normalized ? normalized : undefined;
  }

  private computeNextCronRun(
    cronExpression: string,
    timezone: string,
    fromIso?: string,
  ): string {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error("cronExpression must have 5 fields");
    }
    const minutes = this.parseCronField(fields[0]!, 0, 59);
    const hours = this.parseCronField(fields[1]!, 0, 23);
    const daysOfMonth = this.parseCronField(fields[2]!, 1, 31);
    const months = this.parseCronField(fields[3]!, 1, 12);
    const daysOfWeek = this.parseCronField(fields[4]!, 0, 7, true);
    const base = fromIso ? new Date(fromIso) : new Date();
    const candidate = this.toLocalInTimezone(new Date(base.getTime() + 60_000), timezone);
    candidate.setSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i += 1) {
      const month = candidate.getMonth() + 1;
      const day = candidate.getDate();
      const hour = candidate.getHours();
      const minute = candidate.getMinutes();
      const dayOfWeek = candidate.getDay();
      if (
        months.has(month) &&
        daysOfMonth.has(day) &&
        hours.has(hour) &&
        minutes.has(minute) &&
        daysOfWeek.has(dayOfWeek)
      ) {
        return this.toUtcFromLocalTime(candidate, timezone).toISOString();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error("unable to compute next cron run within one year");
  }

  private parseCronField(
    expr: string,
    min: number,
    max: number,
    normalizeSunday = false,
  ): Set<number> {
    const values = new Set<number>();
    for (const rawPart of expr.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const [rangeExpr, stepExpr] = part.split("/");
      const step = stepExpr ? Number(stepExpr) : 1;
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid cron step: ${part}`);
      }
      let rangeStart = min;
      let rangeEnd = max;
      if (rangeExpr !== "*") {
        const rangeParts = rangeExpr.split("-");
        if (rangeParts.length === 1) {
          rangeStart = Number(rangeParts[0]);
          rangeEnd = rangeStart;
        } else if (rangeParts.length === 2) {
          rangeStart = Number(rangeParts[0]);
          rangeEnd = Number(rangeParts[1]);
        } else {
          throw new Error(`invalid cron field: ${part}`);
        }
      }
      if (
        !Number.isInteger(rangeStart) ||
        !Number.isInteger(rangeEnd) ||
        rangeStart < min ||
        rangeEnd > max ||
        rangeStart > rangeEnd
      ) {
        throw new Error(`cron field out of range: ${part}`);
      }
      for (let value = rangeStart; value <= rangeEnd; value += step) {
        values.add(normalizeSunday && value === 7 ? 0 : value);
      }
    }
    if (values.size === 0) {
      throw new Error(`empty cron field: ${expr}`);
    }
    return values;
  }

  private async emitTaskChange(
    action: ScheduleTaskChangeAction,
    task: ScheduleTaskRecord,
  ): Promise<void> {
    if (!this.taskChangeHandler) return;
    await this.taskChangeHandler(action, task);
  }

  private toUtcFromLocalTime(localTime: Date, timezone: string): Date {
    const y = localTime.getFullYear();
    const mo = localTime.getMonth();
    const d = localTime.getDate();
    const h = localTime.getHours();
    const mi = localTime.getMinutes();
    const s = localTime.getSeconds();

    let tentative = new Date(Date.UTC(y, mo, d, h, mi, s));

    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(tentative);
    const tzVals: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") tzVals[p.type] = Number(p.value);
    }

    let deltaMs =
      ((h - (tzVals.hour ?? 0)) * 60 + (mi - (tzVals.minute ?? 0))) * 60000 +
      (s - (tzVals.second ?? 0)) * 1000;

    if (deltaMs > 43200000) deltaMs -= 86400000;
    if (deltaMs < -43200000) deltaMs += 86400000;

    return new Date(tentative.getTime() + deltaMs);
  }

  private toLocalInTimezone(utcDate: Date, timezone: string): Date {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(utcDate);
    const v: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") v[p.type] = Number(p.value);
    }
    return new Date(v.year, v.month - 1, v.day, v.hour ?? 0, v.minute ?? 0, v.second ?? 0);
  }

  private validateKindPayload(
    kind: ScheduleTaskKind,
    reminderMessage?: string,
    action?: ScheduleActionConfig,
    agentTask?: ScheduleAgentTaskConfig,
  ): void {
    if (kind === "reminder" && !(reminderMessage?.trim() || "").length) {
      throw new Error("reminder task requires reminderMessage");
    }
    if (kind === "action" && !action?.url?.trim()) {
      throw new Error("action task requires action.url");
    }
    if (kind === "agent_task" && !(agentTask?.prompt?.trim() || "").length) {
      throw new Error("agent task requires agentTask.prompt");
    }
  }
}

async function assertSafeActionUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid action.url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("action.url only supports http/https");
  }
  if (process.env.SCHEDULE_ACTION_ALLOW_PRIVATE === "1") {
    return;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("action.url cannot access localhost by default");
  }
  const addresses =
    isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: false });
  if (addresses.some((entry) => isPrivateOrLocalAddress(entry.address))) {
    throw new Error("action.url cannot access local or private network by default");
  }
}

function isPrivateOrLocalAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  const lower = address.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    return isPrivateOrLocalAddress(address.slice("::ffff:".length));
  }
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
