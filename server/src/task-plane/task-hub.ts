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
 *   - 进程内单例（与 getAgentTaskStore 一致的风格）；持久化仍由 agent-task-store 负责，
 *     本模块只维护轻量运行时状态，重启后由 resumeAutonomousTasks 重建。
 *   - 终态记录保留 10 分钟供结果问询，之后 prune，防泄漏。
 */

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
};

const TERMINAL_RETENTION_MS = 10 * 60_000;
const MAX_RECORDS = 200;

function pruneExpired(records: Map<string, TaskPlaneRecord>): void {
  const now = Date.now();
  for (const [id, rec] of records) {
    const terminal = rec.state === "done" || rec.state === "failed" || rec.state === "cancelled";
    if (terminal && now - rec.updatedAt > TERMINAL_RETENTION_MS) records.delete(id);
  }
}

export class TaskHub {
  private readonly records = new Map<string, TaskPlaneRecord>();
  /** 提交序号：同毫秒提交时保证"最近任务"排序确定（startedAt 粒度不足） */
  private seq = 0;

  submit(input: {
    taskId: string;
    sessionId: string;
    replyAnchorId?: string;
    goal: string;
  }): TaskPlaneRecord {
    const now = Date.now();
    const record: TaskPlaneRecord = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.replyAnchorId ? { replyAnchorId: input.replyAnchorId } : {}),
      goal: input.goal,
      state: "running",
      startedAt: now,
      updatedAt: now,
      startedSeq: ++this.seq,
    };
    this.records.set(record.taskId, record);
    if (this.records.size > MAX_RECORDS) pruneExpired(this.records);
    return record;
  }

  setState(taskId: string, state: TaskPlaneState): void {
    const rec = this.records.get(taskId);
    if (!rec) return;
    rec.state = state;
    rec.updatedAt = Date.now();
  }

  setProgress(taskId: string, progressLine: string): void {
    const rec = this.records.get(taskId);
    if (!rec) return;
    rec.progressLine = progressLine;
    rec.updatedAt = Date.now();
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
  }
}

const globalForTaskHub = globalThis as unknown as { __taskPlaneHub?: TaskHub };

/** 进程级单例。 */
export function getTaskHub(): TaskHub {
  globalForTaskHub.__taskPlaneHub ??= new TaskHub();
  return globalForTaskHub.__taskPlaneHub;
}
