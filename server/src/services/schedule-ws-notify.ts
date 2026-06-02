import { ServerEventType } from "../protocol.js";
import type { ScheduleTaskRecord } from "./schedule-task-service.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";

export type ScheduleWsChangeAction = "created" | "updated" | "deleted";

export type ScheduleWsChangePayload = {
  sessionId: string;
  action: ScheduleWsChangeAction;
  taskId: string;
  title?: string;
  kind?: string;
  nextRunAt?: string | null;
  recurrence?: string;
  reminderMessage?: string;
};

function pickDisplayTitle(task: ScheduleTaskRecord): string {
  const msg = task.reminderMessage?.trim();
  if (msg && task.title === "AI 提醒任务") return msg;
  return task.title;
}

export function scheduleWsPayloadFromTask(
  task: ScheduleTaskRecord,
  action: Exclude<ScheduleWsChangeAction, "deleted">,
): ScheduleWsChangePayload {
  return {
    sessionId: task.sessionId,
    action,
    taskId: task.taskId,
    title: pickDisplayTitle(task),
    kind: task.kind,
    nextRunAt: task.nextRunAt,
    recurrence: task.recurrence,
    reminderMessage: task.reminderMessage,
  };
}

export function scheduleWsPayloadDeleted(
  sessionId: string,
  taskId: string,
): ScheduleWsChangePayload {
  return { sessionId, action: "deleted", taskId };
}

export function notifyScheduleTasksChanged(
  wsRegistry: WsConnectionRegistry | undefined,
  payload: ScheduleWsChangePayload,
): void {
  if (!wsRegistry) return;
  wsRegistry.trySend(
    payload.sessionId,
    JSON.stringify({
      type: ServerEventType.ScheduleTasksChanged,
      payload,
    }),
  );
}
