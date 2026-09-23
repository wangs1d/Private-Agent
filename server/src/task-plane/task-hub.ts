/**
 * TaskHub —— 双面架构中"任务面 ↔ 对话面"的唯一接缝（2026-09-05）。
 *
 * 职责：
 *   1. 任务记录生命周期：submitted → running → awaiting_input → done | failed | cancelled
 *   2. 活跃任务摘要：给 TurnRouter 注入会话级任务上下文（"怎么样了/别订了"挂接的依据）
 *   3. 取消把手：每个任务持有 AbortController 语义位（当前由 agent-core 后台任务消费）
 *   4. 回复锚点：任务记录绑定 replyAnchorId（用户消息 id），任务面所有出口事件
 *      都属于任务本身而非某个 WS turn——用户中途继续对话不会让结果丢失。
 *
 * 设计约束：
 *   - 进程内单例（与 getAgentTaskStore 一致的风格）；轻量运行时状态可选落盘
 *     （enablePersistence，data/task-plane/task-hub.json）——重启后恢复台账：
 *     终态记录照常保留供结果问询，非终态记录如实标记 failed（执行体不随进程
 *     存活，"怎么样了"必须能答出"重启中断"而不是凭空消失）。
 *   - 终态记录保留 10 分钟供结果问询，之后 prune，防泄漏。
 */

import { readJson, writeJson } from "../proactivity/persist-file.js";

export type TaskPlaneState =
  | "running"
  | "awaiting_input"
  | "done"
  | "failed"
  | "cancelled";

export type TaskPlaneRecord = {
  taskId: string;
  sessionId: string;
  /** 回复锚点：任务结果归属的对话消息 id（用户消息 id） */
  replyAnchorId?: string;
  goal: string;
  state: TaskPlaneState;
  startedAt: number;
  updatedAt: number;
  /** 提交序号（同毫秒提交的确定性排序用） */
  startedSeq: number;
  /** 最近一条进度快照（供"怎么样了"零 LLM 直答） */
  progressLine?: string;
  /**
   * 静默任务（2026-09-09）：原地同步执行的轻任务（launchComplexBackgroundTask）
   * 只记账（路由摘要/取消/进度），不广播 chat.task_update「任务回执」，
   * 重连快照补发同样跳过——回执只属于真后台派发（dispatchBackgroundTask）。
   */
  quiet?: boolean;
  /**
   * 自动重跑代数（2026-09-23 重启恢复）：任务被服务器重启打断后由
   * restart-recovery 重派时 +1 传入；累计达上限后不再自动重跑，
   * 防止"每次重启都杀掉重跑中的任务"形成无限循环。
   */
  restartCount?: number;
};

const TERMINAL_RETENTION_MS = 10 * 60_000;
const MAX_RECORDS = 200;

/**
 * TaskHub 记录变更监听器（2026-09-08 对话面回执）：
 *   - kind="submit"   任务派发（state=running）
 *   - kind="state"    生命周期态迁移（done/failed/cancelled/awaiting_input…）
 *   - kind="progress" 进度行更新（工具调用/排队提示）
 * TaskHub 本身保持零 WS 依赖；广播由 agent-core 注入监听器实现
 * （见 task-plane/task-events.ts），开关关闭时监听器为 null，行为与旧版一致。
 */
export type TaskHubChangeListenerKind = "submit" | "state" | "progress";
export type TaskHubChangeListener = (
  record: TaskPlaneRecord,
  kind: TaskHubChangeListenerKind,
) => void;

function pruneExpired(
  records: Map<string, TaskPlaneRecord>,
  progressNotify?: Map<string, { at: number; line: string }>,
): void {
  const now = Date.now();
  for (const [id, rec] of records) {
    const terminal = rec.state === "done" || rec.state === "failed" || rec.state === "cancelled";
    if (terminal && now - rec.updatedAt > TERMINAL_RETENTION_MS) {
      records.delete(id);
      progressNotify?.delete(id);
    }
  }
}

export class TaskHub {
  private readonly records = new Map<string, TaskPlaneRecord>();
  /** 提交序号：同毫秒提交时保证"最近任务"排序确定（startedAt 粒度不足） */
  private seq = 0;
  private changeListener: TaskHubChangeListener | null = null;
  /** 进度广播节流记账（taskId → 上次广播时间与文本），setProgressThrottled 专用 */
  private readonly lastProgressNotify = new Map<string, { at: number; line: string }>();
  /** 可选落盘（enablePersistence）：null=纯内存（默认，测试友好） */
  private persistencePath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 启动清扫（enablePersistence）拦下的"重启被打断"任务（2026-09-23）：
   * 台账如实标 failed 只是记账——此刻既无 WS 连接也无监听器，客户端的
   * 「N 个任务后台进行中」收不到终态信号会永久悬挂。名单暂存在此，
   * 由 restart-recovery 在装配完成后取走：补推送收口 + 自动重跑。
   */
  private interruptedOnRestore: TaskPlaneRecord[] = [];

  /**
   * 启用落盘（bootstrap 调用一次）：加载历史台账 + 后续变更防抖写盘。
   * 恢复语义：终态记录照常保留；running/awaiting_input → failed
   * （progressLine 注明重启中断——执行体已随上一进程消亡，不撒谎）。
   * 被打断的非静默任务记入 interruptedOnRestore 名单，供 restart-recovery
   * 补推送 + 自动重跑（drainInterruptedOnRestore 取走）。
   */
  enablePersistence(path: string): void {
    this.persistencePath = path;
    const raw = readJson<{ seq?: number; records?: TaskPlaneRecord[] }>(path, {});
    let restored = 0;
    for (const rec of raw.records ?? []) {
      if (!rec?.taskId || !rec.goal) continue;
      const terminal = rec.state === "done" || rec.state === "failed" || rec.state === "cancelled";
      const safe: TaskPlaneRecord = terminal
        ? rec
        : {
            ...rec,
            state: "failed",
            progressLine: "服务器重启，任务被中断",
            updatedAt: Date.now(),
          };
      this.records.set(safe.taskId, safe);
      restored += 1;
      if (!terminal) this.interruptedOnRestore.push(safe);
    }
    this.seq = Math.max(0, raw.seq ?? 0);
    if (restored > 0) {
      console.log(`[TaskHub] 台账已恢复 ${restored} 条（非终态已标记 failed）`);
      this.schedulePersist();
    }
  }

  /**
   * 取走启动清扫拦下的"重启被打断"任务名单（取走即清空，2026-09-23）。
   * 含静默任务——是否补推送/重跑由 restart-recovery 按 quiet/restartCount 自行取舍。
   */
  drainInterruptedOnRestore(): TaskPlaneRecord[] {
    const batch = this.interruptedOnRestore;
    this.interruptedOnRestore = [];
    return batch;
  }

  /** 防抖写盘（1s）；进度类高频更新不会每条都碰磁盘 */
  private schedulePersist(): void {
    if (!this.persistencePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistence();
    }, 1_000);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  /** 立即落盘（shutdown/测试用） */
  flushPersistence(): void {
    if (!this.persistencePath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    pruneExpired(this.records, this.lastProgressNotify);
    writeJson(this.persistencePath, { seq: this.seq, records: [...this.records.values()] });
  }

  /** 注入/清除记录变更监听器（null 清除）。重复注入覆盖前一个。 */
  setChangeListener(listener: TaskHubChangeListener | null): void {
    this.changeListener = listener;
  }

  private notify(record: TaskPlaneRecord, kind: TaskHubChangeListenerKind): void {
    try {
      this.changeListener?.(record, kind);
    } catch {
      /* 监听器异常不反噬任务记账 */
    }
  }

  submit(input: {
    taskId: string;
    sessionId: string;
    replyAnchorId?: string;
    goal: string;
    /** 静默任务：只记账，不广播回执（见 TaskPlaneRecord.quiet） */
    quiet?: boolean;
    /** 自动重跑代数：重启恢复重派时由 restart-recovery 传入（上一代 +1） */
    restartCount?: number;
  }): TaskPlaneRecord {
    const now = Date.now();
    const record: TaskPlaneRecord = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.replyAnchorId ? { replyAnchorId: input.replyAnchorId } : {}),
      goal: input.goal,
      ...(input.quiet ? { quiet: true } : {}),
      ...(input.restartCount && input.restartCount > 0 ? { restartCount: input.restartCount } : {}),
      state: "running",
      startedAt: now,
      updatedAt: now,
      startedSeq: ++this.seq,
    };
    this.records.set(record.taskId, record);
    if (this.records.size > MAX_RECORDS) pruneExpired(this.records, this.lastProgressNotify);
    this.schedulePersist();
    this.notify(record, "submit");
    return record;
  }

  setState(taskId: string, state: TaskPlaneState): void {
    const rec = this.records.get(taskId);
    if (!rec) return;
    rec.state = state;
    rec.updatedAt = Date.now();
    this.schedulePersist();
    this.notify(rec, "state");
  }

  setProgress(taskId: string, progressLine: string): void {
    const rec = this.records.get(taskId);
    if (!rec) return;
    rec.progressLine = progressLine;
    rec.updatedAt = Date.now();
    this.schedulePersist();
    this.notify(rec, "progress");
  }

  /**
   * 带广播节流的进度更新（2026-09-19 P0-2）：记录无条件刷新（快照最终一致），
   * 仅"progress"广播被限频——同文本 10s 内去重 + 任意文本最小间隔 3s。
   * 背景：工具执行粒度的 setProgress（"正在使用 X"）一次任务可触发十几次
   * chat.task_update，客户端原地更新虽幂等但 WS 帧与 Flutter 重建是无谓开销；
   * 终态（state 迁移）不经此路径，收尾快照始终可达。
   */
  setProgressThrottled(
    taskId: string,
    progressLine: string,
    opts?: { sameLineDedupeMs?: number; minBroadcastIntervalMs?: number },
  ): void {
    const rec = this.records.get(taskId);
    if (!rec) return;
    rec.progressLine = progressLine;
    rec.updatedAt = Date.now();
    const now = Date.now();
    const last = this.lastProgressNotify.get(taskId);
    const sameLineDedupeMs = opts?.sameLineDedupeMs ?? 10_000;
    const minIntervalMs = opts?.minBroadcastIntervalMs ?? 3_000;
    if (
      last &&
      ((last.line === progressLine && now - last.at < sameLineDedupeMs) ||
        now - last.at < minIntervalMs)
    ) {
      return;
    }
    this.lastProgressNotify.set(taskId, { at: now, line: progressLine });
    this.schedulePersist();
    this.notify(rec, "progress");
  }

  get(taskId: string): TaskPlaneRecord | undefined {
    return this.records.get(taskId);
  }

  /** 会话内全部非终态任务（最近优先；同毫秒按提交序号倒序，确定性）。 */
  activeRecords(sessionId: string): TaskPlaneRecord[] {
    return [...this.records.values()]
      .filter(
        (r) =>
          r.sessionId === sessionId &&
          (r.state === "running" || r.state === "awaiting_input"),
      )
      .sort((a, b) => (b.startedAt - a.startedAt) || (b.startedSeq - a.startedSeq));
  }

  /**
   * 会话内全部在册任务（含 10 分钟保留期内的终态记录，task.status 查询用）。
   * 活跃优先、终态按 updatedAt 倒序由调用方自行取舍。
   */
  sessionRecords(sessionId: string): TaskPlaneRecord[] {
    return [...this.records.values()].filter((r) => r.sessionId === sessionId);
  }

  /**
   * 活跃任务摘要（注入路由 prompt）：让路由器把"怎么样了/改成明天/别订了"
   * 识别为对任务的过问/修正，而非新话题。无活跃任务返回 undefined（prompt 零污染）。
   */
  activeSummary(sessionId: string): string | undefined {
    const actives = this.activeRecords(sessionId).slice(0, 3);
    if (actives.length === 0) return undefined;
    return actives
      .map((r, i) => {
        const mins = Math.max(0, Math.round((Date.now() - r.startedAt) / 60_000));
        const progress = r.progressLine ? `（${r.progressLine}）` : "";
        return `${i + 1}. [${r.state}] ${r.goal.slice(0, 60)}${progress} 已运行 ${mins} 分钟`;
      })
      .join("\n");
  }

  /** 供运维/测试：清空全部记录。 */
  reset(): void {
    this.records.clear();
    this.interruptedOnRestore = [];
    this.schedulePersist();
  }
}

const globalForTaskHub = globalThis as unknown as { __taskPlaneHub?: TaskHub };

/** 进程级单例。 */
export function getTaskHub(): TaskHub {
  globalForTaskHub.__taskPlaneHub ??= new TaskHub();
  return globalForTaskHub.__taskPlaneHub;
}
