import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskEvent, TaskEventType } from "../types/agent";

const TYPE_ICON: Record<TaskEventType, string> = {
  progress: "⟳",
  success: "✓",
  warning: "⚠",
  error: "✗",
  info: "ℹ",
};

const TOAST_LIFETIME_MS = 6000;
const MAX_TOASTS = 5;

interface ToastItem extends TaskEvent {
  dismissAt: number;
}

interface TaskNotificationCenterProps {
  events: TaskEvent[];
}

export function TaskNotificationCenter({ events }: TaskNotificationCenterProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const lastNotifiedIdRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addToast = useCallback((event: TaskEvent) => {
    if (lastNotifiedIdRef.current.has(event.id)) return;
    lastNotifiedIdRef.current.add(event.id);
    const toast: ToastItem = {
      ...event,
      dismissAt: Date.now() + TOAST_LIFETIME_MS,
    };
    setToasts((prev) => {
      const next = [...prev, toast].slice(-MAX_TOASTS);
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (events.length === 0) return;
    const lastEvent = events[events.length - 1];
    if (!lastNotifiedIdRef.current.has(lastEvent.id)) {
      addToast(lastEvent);
    }
  }, [events.length, addToast]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => {
        const alive = prev.filter((t) => t.dismissAt > now);
        return alive;
      });
    }, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      if (d.type === "agent-sphere:task-notify" || d.type === "task.notify") {
        const event: TaskEvent = {
          id: String(d.id ?? `notify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          type: (["progress", "success", "warning", "error", "info"].includes(d.eventType as string)
            ? d.eventType
            : "info") as TaskEventType,
          title: String(d.title ?? d.message ?? "通知"),
          detail: d.detail ? String(d.detail) : undefined,
          timestamp: new Date(),
          source: String(d.source ?? "webhook"),
        };
        addToast(event);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [addToast]);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="task-notification-hub">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`task-toast task-toast--${toast.type}`}
          onClick={() => dismissToast(toast.id)}
        >
          <div className="task-toast__icon">{TYPE_ICON[toast.type]}</div>
          <div className="task-toast__body">
            <div className="task-toast__title">{toast.title}</div>
            {toast.detail ? (
              <div className="task-toast__detail">{toast.detail}</div>
            ) : null}
            {toast.source ? (
              <div className="task-toast__source">{toast.source}</div>
            ) : null}
          </div>
          <button
            className="task-toast__close"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(toast.id);
            }}
          >
            ×
          </button>
          <div
            className="task-toast__timer"
            style={{
              animationDuration: `${TOAST_LIFETIME_MS}ms`,
            }}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}
