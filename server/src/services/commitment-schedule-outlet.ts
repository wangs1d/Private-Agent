/**
 * 承诺板 → 日程物化出口（程序层单向桥，样板同 schedule-booking-bridge.ts）：
 *
 *   - 承诺 active 且 deadline 在未来 → 物化为 source=commitment 的日程
 *     （进「今日安排」/冲突检测/早报，到点由日程链路响提醒）
 *   - 承诺 deadline 变更（含延期传播）→ 反向改期
 *   - 承诺进入终态（fulfilled/cancelled/broken/superseded）或撤掉期限 → 反向取消日程
 *
 * 分工定调：承诺板管召回与催办（deadline 前 24h/2h 梯度提醒 + 超时升级），
 * 日程只负责「到点那一响」与展示面——物化任务不配 remindBeforeMinutes，
 * 避免与板上梯度提醒在同一时间窗双响。
 * 时间闸（past-deadline 教训）：只物化未来的 deadline，已过期/即时承诺不落日程。
 * 幂等：sourceRefId=承诺 id 反查已有任务；createTask 自带 60s 锚点容差判重兜底。
 */

import type { CommitmentRecord, CommitmentScheduleOutlet } from "../agentic-memory/commitment-board.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";

/** 物化提前闸门：deadline 距现在不足 1 分钟视为「即时/已过期」，不落日程。 */
const MATERIALIZE_MIN_LEAD_MS = 60_000;

function commitmentPartyLabel(record: CommitmentRecord): string {
  if (record.committedBy === "agent") return "Agent 承诺";
  if (record.committedBy === "third_party") return "第三方承诺";
  return "自己的待办";
}

export function createCommitmentScheduleOutlet(deps: {
  tasks: ScheduleTaskService;
}): CommitmentScheduleOutlet {
  const { tasks } = deps;
  return {
    async upsertFromCommitment(record) {
      if (record.status !== "active" || !record.deadline) return null;
      const deadlineMs = Date.parse(record.deadline);
      if (!Number.isFinite(deadlineMs)) return null;
      if (deadlineMs <= Date.now() + MATERIALIZE_MIN_LEAD_MS) return null; // 时间闸：只物化未来

      const existing = tasks.findTaskBySourceRefId(record.id);
      if (existing) {
        if (existing.status === "active" && existing.runAt !== record.deadline) {
          const updated = await tasks.updateTask(existing.taskId, { runAt: record.deadline });
          return updated.taskId;
        }
        return existing.taskId;
      }

      const text = record.text.length > 60 ? `${record.text.slice(0, 57)}…` : record.text;
      const task = await tasks.createTask({
        sessionId: record.actorId,
        title: `【承诺】${text}`,
        shortTitle: record.text.slice(0, 12),
        description: `承诺板自动物化：${record.text}`,
        kind: "reminder",
        category: "itinerary",
        runAt: record.deadline,
        recurrence: "none",
        reminderMessage: `承诺到期：${record.text}`,
        source: "commitment",
        sourceRefId: record.id,
      });
      return task.taskId;
    },

    async withdrawFromCommitment(record) {
      const task = tasks.findTaskBySourceRefId(record.id);
      if (!task || task.status !== "active") return;
      await tasks.updateTask(task.taskId, { status: "cancelled" });
    },
  };
}
