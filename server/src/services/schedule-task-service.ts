import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, join } from "path";

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly";
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
  runAt: string;
  recurrence: ScheduleRecurrence;
  timezone?: string;
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

export class ScheduleTaskService {
  private readonly byTaskId = new Map<string, ScheduleTaskRecord>();
  private readonly runsByTaskId = new Map<string, ScheduleTaskRun[]>();
  private readonly runningTaskIds = new Set<string>();
  private tickHandle: NodeJS.Timeout | undefined;
  private weatherBriefHandler?: WeatherBriefHandler;
  private reminderHandler?: ScheduleReminderHandler;
  private agentTaskHandler?: AgentTaskHandler;

  private get persistPath(): string {
    return process.env.SCHEDULE_TASKS_FILE ?? join(process.cwd(), "data", "schedule-tasks.json");
  }

  /**
   * 由引导层注入：执行「每日天气简报」任务并推送 WebSocket。
   */
  setWeatherBriefHandler(handler: WeatherBriefHandler | undefined): void {
    this.weatherBriefHandler = handler;
  }

  /** 由引导层注入：提醒到点时推送 WebSocket / 虚拟电话等。 */
  setReminderHandler(handler: ScheduleReminderHandler | undefined): void {
    this.reminderHandler = handler;
  }

  /** 由引导层注入：到点后让 Agent 执行一段自动化任务。 */
  setAgentTaskHandler(handler: AgentTaskHandler | undefined): void {
    this.agentTaskHandler = handler;
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
    const from = range?.from ? new Date(range.from).getTime() : Number.NEGATIVE_INFINITY;
    const to = range?.to ? new Date(range.to).getTime() : Number.POSITIVE_INFINITY;
    return Array.from(this.byTaskId.values())
      .filter((task) => task.sessionId === sessionId)
      .filter((task) => task.status !== "cancelled")
      .filter((task) => {
        const anchor = task.nextRunAt ?? task.runAt;
        if (!anchor) return false;
        const t = new Date(anchor).getTime();
        return t >= from && t <= to;
      })
      .sort((a, b) =>
        (a.nextRunAt ?? a.runAt ?? "").localeCompare(b.nextRunAt ?? b.runAt ?? ""),
      );
  }

  listRuns(taskId: string, limit = 20): ScheduleTaskRun[] {
    const list = this.runsByTaskId.get(taskId) ?? [];
    return [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  getTask(taskId: string): ScheduleTaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  async createTask(input: CreateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const runAt = this.parseRunAt(input.runAt);
    this.validateKindPayload(input.kind, input.reminderMessage, input.action, input.agentTask);
    const now = new Date().toISOString();
    const task: ScheduleTaskRecord = {
      taskId: randomUUID(),
      sessionId: input.sessionId,
      title: input.title.trim(),
      description: input.description.trim(),
      kind: input.kind,
      recurrence: input.recurrence,
      timezone: input.timezone?.trim() || "Asia/Shanghai",
      runAt: runAt.toISOString(),
      nextRunAt: runAt.toISOString(),
      status: "active",
      reminderMessage: input.reminderMessage?.trim() || undefined,
      action: input.action,
      agentTask: input.agentTask,
      createdAt: now,
      updatedAt: now,
    };
    this.byTaskId.set(task.taskId, task);
    await this.persist();
    return task;
  }

  async updateTask(taskId: string, input: UpdateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const task = this.byTaskId.get(taskId);
    if (!task) {
      throw new Error("任务不存在");
    }
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("任务已结束，不可再编辑");
    }
    const next: ScheduleTaskRecord = {
      ...task,
      title: input.title?.trim() || task.title,
      description: input.description?.trim() || task.description,
      recurrence: input.recurrence ?? task.recurrence,
      timezone: input.timezone?.trim() || task.timezone,
      reminderMessage: input.reminderMessage?.trim() || task.reminderMessage,
      action: input.action ?? task.action,
      agentTask: input.agentTask ?? task.agentTask,
      updatedAt: new Date().toISOString(),
    };
    if (input.runAt) {
      const runAt = this.parseRunAt(input.runAt).toISOString();
      next.runAt = runAt;
      next.nextRunAt = runAt;
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
    return next;
  }

  async triggerNow(taskId: string): Promise<void> {
    const task = this.byTaskId.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "active") throw new Error("当前任务未处于可执行状态");
    await this.executeTask(task, new Date().toISOString());
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
          throw new Error("天气简报执行器未配置");
        }
        run.output = await this.weatherBriefHandler(task);
      } else if (task.kind === "agent_task") {
        if (!this.agentTaskHandler) {
          throw new Error("Agent 自动化执行器未配置");
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
      if (
        task.kind === "reminder" &&
        run.status === "success" &&
        this.reminderHandler
      ) {
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
      // 失败任务按 1 分钟后重试一次（MVP 策略）。
      updated.nextRunAt = new Date(Date.now() + 60_000).toISOString();
      return updated;
    }
    if (updated.recurrence === "none") {
      updated.status = "completed";
      updated.nextRunAt = null;
      return updated;
    }
    const anchor = new Date(updated.nextRunAt ?? updated.runAt);
    if (updated.recurrence === "daily") {
      anchor.setUTCDate(anchor.getUTCDate() + 1);
    } else if (updated.recurrence === "weekly") {
      anchor.setUTCDate(anchor.getUTCDate() + 7);
    } else {
      anchor.setUTCFullYear(anchor.getUTCFullYear() + 1);
    }
    updated.nextRunAt = anchor.toISOString();
    return updated;
  }

  private async executeAction(task: ScheduleTaskRecord): Promise<unknown> {
    if (!task.action?.url) {
      throw new Error("action 任务缺少 url");
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
      throw new Error(`调用任务 API 失败: ${res.status} ${res.statusText} ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  private parseRunAt(raw: string): Date {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new Error("runAt 时间格式无效");
    }
    if (date.getTime() < Date.now() - 5000) {
      throw new Error("runAt 必须是未来时间");
    }
    return date;
  }

  private validateKindPayload(
    kind: ScheduleTaskKind,
    reminderMessage?: string,
    action?: ScheduleActionConfig,
    agentTask?: ScheduleAgentTaskConfig,
  ): void {
    if (kind === "reminder" && !(reminderMessage?.trim() || "").length) {
      throw new Error("提醒任务必须提供 reminderMessage");
    }
    if (kind === "action" && !action?.url?.trim()) {
      throw new Error("动作任务必须提供 action.url");
    }
    if (kind === "agent_task" && !(agentTask?.prompt?.trim() || "").length) {
      throw new Error("Agent 自动化任务必须提供 agentTask.prompt");
    }
    if (kind === "weather_brief") {
      return;
    }
  }
}

async function assertSafeActionUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("action.url 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("action.url 仅支持 http/https");
  }
  if (process.env.SCHEDULE_ACTION_ALLOW_PRIVATE === "1") {
    return;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("action.url 默认禁止访问 localhost");
  }
  const addresses =
    isIP(hostname) ?
      [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: false });
  if (addresses.some((entry) => isPrivateOrLocalAddress(entry.address))) {
    throw new Error("action.url 默认禁止访问本机或内网地址");
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
