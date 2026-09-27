/**
 * AuditTrailService —— Agent 行为审计时间线（2026-09-24，对标 Muse「全量审计轨迹：
 * everything done and planned」的本地聚合层）。
 *
 * 数据全部来自既有台账（零新写入方，本服务纯只读聚合）：
 *   - AgentActivityStore   代办足迹（已办/已告知/进行中的代办）
 *   - GoalBoard            目标板（plan 计划推进 / track 盯梢 / preexec 预执行）
 *   - TaskHub              后台任务面（正在办的任务）
 *   - PendingConfirmationStore  挂起的行动确认（等你点头的事）
 *
 * 回答三类问题：「你替我办了什么」「你现在在忙什么/在盯什么」「有什么在等我确认」。
 * 出口：GET /agent/audit-timeline（面板/巡检用）+ activity.timeline 工具（模型
 * 被问「你最近都在干什么」时直接读，不再凭印象编）。
 *
 * 去重边界：计划步骤派生的后台任务（taskId 被步骤引用）不重复出条——计划本身
 * 已代表它们；足迹台账的执行类条目与任务终态是两个视角，保留双条。
 */
import type { AgentActivityStore } from "./activity-store.js";
import type { GoalBoard } from "./goal-board.js";
import type { TaskHub } from "../task-plane/task-hub.js";
import type { PendingConfirmationStore } from "./pending-confirmation-store.js";

export interface AuditEntry {
  ts: number;
  /** done=已办/已告知；planned=进行中（计划/盯梢/后台任务）；awaiting=等你确认 */
  bucket: "done" | "planned" | "awaiting";
  /** 条目类型（activity kind / plan / track / preexec / task / confirmation） */
  kind: string;
  title: string;
  /** 状态一句话 */
  status: string;
  /** 来源台账（ledger / goal_board / task_hub / pending_confirm） */
  source: string;
  refId?: string;
}

export interface AuditTrailDeps {
  activityStore?: AgentActivityStore | null;
  goalBoard?: GoalBoard | null;
  taskHub?: TaskHub | null;
  pendingConfirmations?: PendingConfirmationStore | null;
}

export class AuditTrailService {
  constructor(private readonly deps: AuditTrailDeps) {}

  /** 合并时间线（新→旧，limit 截断） */
  timeline(actorId: string, limit = 60): AuditEntry[] {
    const entries: AuditEntry[] = [];
    const { activityStore, goalBoard, taskHub, pendingConfirmations } = this.deps;

    if (activityStore) {
      for (const a of activityStore.list(actorId)) {
        entries.push({
          ts: a.createdAt,
          bucket: a.status === "pending" ? "planned" : "done",
          kind: a.kind,
          title: a.title,
          status: a.statusLabel ?? a.status,
          source: "ledger",
          refId: a.id,
        });
      }
    }

    // 计划步骤派生的任务 taskId 集合（时间线里由计划条目代表，不重复出条）
    const planTaskIds = new Set<string>();
    if (goalBoard) {
      for (const g of goalBoard.list(actorId)) {
        const steps = Array.isArray(g.payload?.steps)
          ? (g.payload?.steps as Array<{ status?: string; taskId?: string; title?: string; note?: string }>)
          : [];
        for (const s of steps) if (s.taskId) planTaskIds.add(s.taskId);
        const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
        const doing = steps.find((s) => s.status === "doing" || s.status === "awaiting_confirm");
        const status =
          g.status === "ready" || g.status === "done"
            ? "已完成"
            : steps.length > 0
              ? `${done}/${steps.length} 步${doing ? `，当前「${doing.title}」` : ""}${doing?.status === "awaiting_confirm" ? "（等你确认）" : ""}`
              : g.status === "watching"
                ? "盯梢中"
                : "后台准备中";
        entries.push({
          ts: g.createdAt,
          bucket: doing?.status === "awaiting_confirm" ? "awaiting" : "planned",
          kind: g.type || g.kind,
          title: g.title,
          status,
          source: "goal_board",
          refId: g.goalId,
        });
      }
    }

    if (taskHub) {
      for (const rec of taskHub.sessionRecords(actorId)) {
        if (rec.quiet) continue;
        if (planTaskIds.has(rec.taskId)) continue;
        const terminal = rec.state === "done" || rec.state === "failed" || rec.state === "cancelled";
        if (terminal && rec.state !== "done") continue; // 失败/取消的杂任务不进时间线（足迹里有失败语义的才值得看）
        entries.push({
          ts: rec.startedAt,
          bucket: terminal ? "done" : "planned",
          kind: "task",
          title: rec.goal.slice(0, 120),
          status:
            rec.state === "done"
              ? "已办完"
              : rec.progressLine
                ? rec.progressLine.slice(0, 80)
                : "进行中",
          source: "task_hub",
          refId: rec.taskId,
        });
      }
    }

    if (pendingConfirmations) {
      for (const c of pendingConfirmations.list(actorId)) {
        entries.push({
          ts: c.createdAt,
          bucket: "awaiting",
          kind: "confirmation",
          title: c.rationale.slice(0, 120),
          status: "等你确认",
          source: "pending_confirm",
          refId: c.confirmId,
        });
      }
    }

    return entries.sort((a, b) => b.ts - a.ts).slice(0, Math.max(limit, 1));
  }

  /** 三段式摘要（模型口述「你最近都在干什么」用；空态返回 null，零编造） */
  summary(actorId: string): string | null {
    const entries = this.timeline(actorId, 60);
    if (entries.length === 0) return null;
    const awaiting = entries.filter((e) => e.bucket === "awaiting");
    const planned = entries.filter((e) => e.bucket === "planned");
    const done = entries.filter((e) => e.bucket === "done");
    const parts: string[] = [];
    if (awaiting.length > 0) {
      parts.push(`等你确认：${awaiting.slice(0, 3).map((e) => e.title).join("、")}`);
    }
    if (planned.length > 0) {
      parts.push(`在办/在盯：${planned.slice(0, 3).map((e) => e.title).join("、")}`);
    }
    if (done.length > 0) {
      parts.push(`最近办结：${done.slice(0, 3).map((e) => e.title).join("、")}`);
    }
    return parts.join("\n");
  }
}
