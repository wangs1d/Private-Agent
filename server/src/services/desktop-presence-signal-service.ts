import type { DesktopBridgeSyncPayload } from "./desktop-bridge-coordinator.js";
import type { LifeSignalHubService } from "./life-signal-hub-service.js";
import type { LifeSignal } from "./life-signal-types.js";

function hourOf(timestamp: string): number {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? -1 : date.getHours();
}

function isLateWindow(hour: number): boolean {
  return hour >= 23 || hour <= 5;
}

export class DesktopPresenceSignalService {
  private readonly lastPublishedByActor = new Map<string, { key: string; at: number }>();

  constructor(private readonly signalHub: LifeSignalHubService) {}

  handleSync(actorId: string, payload: DesktopBridgeSyncPayload): void {
    const hour = hourOf(payload.updatedAt);
    if (!payload.bridgeOnline && !payload.lastTask) return;

    const tags = ["desktop", payload.bridgeOnline ? "online" : "offline"];
    const evidence = [`desktop bridge ${payload.bridgeOnline ? "online" : "offline"}`];
    let importance: LifeSignal["importance"] = "low";

    if (payload.bridgeOnline && isLateWindow(hour)) {
      tags.push("late_night", "active_window");
      evidence.push(`desktop active at hour ${hour}`);
      importance = "medium";
    }

    this.publishIfFresh(actorId, {
      id: `${actorId}:desktop-sync:${payload.updatedAt}:${payload.bridgeOnline ? "1" : "0"}`,
      actorId,
      source: "desktop",
      kind: payload.bridgeOnline ? "desktop_presence_active" : "desktop_presence_inactive",
      title: payload.bridgeOnline ? "Desktop Active" : "Desktop Disconnected",
      summary: payload.bridgeOnline
        ? "Desktop bridge is active and available."
        : "Desktop bridge went offline after recent activity.",
      tags,
      importance,
      evidence,
      occurredAt: payload.updatedAt,
      metadata: {
        bridgeOnline: payload.bridgeOnline,
        hour,
        lastTaskOk: payload.lastTask?.ok,
      },
    });
  }

  handleTaskResult(actorId: string, payload: DesktopBridgeSyncPayload): void {
    if (!payload.lastTask) return;

    this.publishIfFresh(actorId, {
      id: `${actorId}:desktop-task:${payload.updatedAt}:${payload.lastTask.ok ? "1" : "0"}`,
      actorId,
      source: "desktop",
      kind: payload.lastTask.ok ? "desktop_task_completed" : "desktop_task_failed",
      title: payload.lastTask.ok ? "Desktop Task Completed" : "Desktop Task Needs Attention",
      summary: payload.lastTask.summary?.trim()
        ? payload.lastTask.summary
        : payload.lastTask.ok
          ? "A desktop task completed successfully."
          : "A desktop task failed and may need attention.",
      description: payload.lastTask.error,
      tags: ["desktop", "task_result", payload.lastTask.ok ? "task_ok" : "task_failed"],
      importance: payload.lastTask.ok ? "low" : "high",
      evidence: [
        payload.lastTask.ok ? "desktop task completed" : "desktop task failed",
        payload.lastTask.summary ?? payload.lastTask.error ?? "no details",
      ],
      metrics:
        typeof payload.lastTask.steps === "number"
          ? { steps: payload.lastTask.steps }
          : undefined,
      occurredAt: payload.updatedAt,
      metadata: {
        bridgeOnline: payload.bridgeOnline,
      },
    });
  }

  private publishIfFresh(actorId: string, signal: LifeSignal): void {
    const freshnessKey = `${signal.kind}:${signal.summary}`;
    const previous = this.lastPublishedByActor.get(actorId);
    const now = Date.now();
    if (previous && previous.key === freshnessKey && now - previous.at < 15 * 60_000) {
      return;
    }
    this.lastPublishedByActor.set(actorId, { key: freshnessKey, at: now });
    this.signalHub.publish(signal);
  }
}
