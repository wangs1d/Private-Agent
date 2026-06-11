import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, join } from "path";

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly" | "cron";
export type ScheduleTaskKind = "reminder" | "action" | "weather_brief" | "agent_task";
export type ScheduleTaskStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduleRunStatus = "success" | "failed";

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
  title: string;
  description: string;
  kind: ScheduleTaskKind;
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
  title: string;
  description: string;
  kind: ScheduleTaskKind;
  runAt?: string;
  recurrence: ScheduleRecurrence;
  timezone?: string;
  cronExpression?: string;
  webhookToken?: string;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
};

type UpdateScheduleTaskInput = {
  title?: string;
  description?: string;
  recurrence?: ScheduleRecurrence;
  runAt?: string;
  timezone?: string;
  cronExpression?: string | null;
  webhookToken?: string | null;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
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

  listTasksBySession(
    sessionId: string,
    range?: { from?: string; to?: string },
  ): ScheduleTaskRecord[] {
    const now = Date.now();
    const from = range?.from ? new Date(range.from).getTime() : now;
    const to = range?.to ? new Date(range.to).getTime() : Number.POSITIVE_INFINITY;
    return Array.from(this.byTaskId.values())
      .filter((task) => task.sessionId === sessionId)
      .filter((task) => {
        if (task.status === "cancelled") return false;
        const relevantAt =
          task.status === "completed"
            ? task.lastRunAt ?? task.runAt
            : (task.nextRunAt ?? task.runAt);
        const relevantTime = new Date(relevantAt).getTime();
        return Number.isFinite(relevantTime) && relevantTime >= from && relevantTime <= to;
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

  async createTask(input: CreateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const tz = input.timezone?.trim() || "Asia/Shanghai";
    const schedule = this.resolveSchedule(input.runAt, input.recurrence, tz, input.cronExpression);
    const now = new Date().toISOString();
    this.validateKindPayload(input.kind, input.reminderMessage, input.action, input.agentTask);
    const task: ScheduleTaskRecord = {
      taskId: randomUUID(),
      sessionId: input.sessionId,
      title: input.title.trim(),
      description: input.description.trim(),
      kind: input.kind,
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
      description: input.description?.trim() || task.description,
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
