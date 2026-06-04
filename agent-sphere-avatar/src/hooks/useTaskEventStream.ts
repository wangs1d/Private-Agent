import { useEffect, useRef } from "react";
import type { TaskEvent, TaskEventType } from "../types/agent";

/**
 * 任务事件数据流 — 同时监听：
 * 1. WebSocket 消息（agent.task_event / task.event）通过 apply 推入 state.taskEvents
 * 2. postMessage 通知（agent-sphere:task-notify / task.notify）来自父页或宿主页
 * 3. 自定义 DOM 事件 'agent-sphere:task-event' 供业务层主动派发
 *
 * 通过 onTaskEvent 回调订阅，事件被推入传入的 state 后由 TaskFeed / TaskNotificationCenter 消费
 */
export interface UseTaskEventStreamOptions {
  enabled?: boolean;
  onTaskEvent: (event: TaskEvent) => void;
}

const VALID_TYPES: ReadonlySet<TaskEventType> = new Set([
  "progress",
  "success",
  "warning",
  "error",
  "info",
]);

function toTaskEvent(raw: Record<string, unknown>, source: string): TaskEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const candidateType = String(raw.eventType ?? raw.type ?? "info");
  const type: TaskEventType = VALID_TYPES.has(candidateType as TaskEventType)
    ? (candidateType as TaskEventType)
    : "info";
  const title = String(raw.title ?? raw.message ?? raw.text ?? "任务更新").trim() || "任务更新";
  const detail = raw.detail ? String(raw.detail).trim() : undefined;
  return {
    id: String(raw.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    type,
    title,
    detail,
    timestamp: new Date(),
    source: String(raw.source ?? source),
  };
}

export function useTaskEventStream({ enabled = true, onTaskEvent }: UseTaskEventStreamOptions) {
  const handlerRef = useRef(onTaskEvent);
  handlerRef.current = onTaskEvent;

  useEffect(() => {
    if (!enabled) return;

    const dispatch = (raw: unknown, source: string) => {
      if (!raw || typeof raw !== "object") return;
      const ev = toTaskEvent(raw as Record<string, unknown>, source);
      if (ev) handlerRef.current(ev);
    };

    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      if (d.type === "agent-sphere:task-notify" || d.type === "task.notify") {
        dispatch(d, "postMessage");
      }
    };

    const onDomEvent = (ev: Event) => {
      const ce = ev as CustomEvent<Record<string, unknown>>;
      dispatch(ce.detail, "dom-event");
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("agent-sphere:task-event", onDomEvent as EventListener);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("agent-sphere:task-event", onDomEvent as EventListener);
    };
  }, [enabled]);
}

/** 业务层主动派发任务事件（任意位置可调用） */
export function dispatchTaskEvent(event: Omit<TaskEvent, "timestamp"> & { timestamp?: Date }) {
  if (typeof window === "undefined") return;
  const payload: TaskEvent = {
    ...event,
    timestamp: event.timestamp ?? new Date(),
  };
  window.dispatchEvent(new CustomEvent("agent-sphere:task-event", { detail: payload }));
}
