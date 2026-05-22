import { randomUUID } from "node:crypto";

import type {
  GameFinishedPayload,
  IStateManager,
  StateChangeEvent,
  StateChangeHandler,
  StateEventType,
  StateModule,
  TaskCompletedPayload,
  TransactionCompletedPayload,
} from "./types.js";

const MAX_HISTORY = 200;

export class StateEventManager implements IStateManager {
  private readonly handlers = new Map<string, Set<StateChangeHandler>>();
  private readonly history: StateChangeEvent[] = [];

  emit<T>(event: Omit<StateChangeEvent<T>, "eventId" | "timestamp">): string {
    const eventId = randomUUID();
    const fullEvent: StateChangeEvent<T> = {
      ...event,
      eventId,
      timestamp: new Date().toISOString(),
    } as StateChangeEvent<T>;

    this.history.push(fullEvent as StateChangeEvent);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }

    const exactKey = `${event.module}:${event.type}`;
    this.dispatchToHandlers(exactKey, fullEvent as StateChangeEvent);
    this.dispatchToHandlers(`${event.module}:*`, fullEvent as StateChangeEvent);
    this.dispatchToHandlers(`*:${event.type}`, fullEvent as StateChangeEvent);
    this.dispatchToHandlers(`*:*`, fullEvent as StateChangeEvent);

    console.log(
      `[StateEventManager] 📢 ${event.module}.${event.type}` +
        ` | session=${event.sessionId} | state: ${event.previousState ?? "N/A"} → ${event.currentState}`,
    );

    return eventId;
  }

  private dispatchToHandlers(key: string, event: StateChangeEvent): void {
    const handlers = this.handlers.get(key);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        void Promise.resolve(handler(event)).catch((err) => {
          console.error(`[StateEventManager] Handler error for ${key}:`, err);
        });
      } catch (err) {
        console.error(`[StateEventManager] Sync handler error for ${key}:`, err);
      }
    }
  }

  on<T>(module: StateModule | "*", type: StateEventType | "*", handler: StateChangeHandler<T>): () => void {
    const key = `${module}:${type}`;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler as StateChangeHandler);

    return () => {
      set?.delete(handler as StateChangeHandler);
      if (set?.size === 0) {
        this.handlers.delete(key);
      }
    };
  }

  off(module: StateModule | "*", type: StateEventType | "*", handler: StateChangeHandler): void {
    const key = `${module}:${type}`;
    const set = this.handlers.get(key);
    if (set) {
      set.delete(handler);
    }
  }

  getRecentEvents(module?: StateModule, limit = 50): StateChangeEvent[] {
    let filtered = module ? this.history.filter((e) => e.module === module) : this.history;
    return filtered.slice(-limit);
  }

  emitGameFinished(
    module: StateModule,
    sessionId: string,
    actorSessionId: string,
    payload: GameFinishedPayload,
  ): string {
    return this.emit({
      module,
      type: "game_finished",
      sessionId,
      actorSessionId,
      previousState: "playing",
      currentState: "finished",
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  emitTransactionCompleted(
    sessionId: string,
    actorSessionId: string,
    payload: TransactionCompletedPayload,
  ): string {
    return this.emit({
      module: "wallet",
      type: "transaction_completed",
      sessionId,
      actorSessionId,
      previousState: "pending",
      currentState: "completed",
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  emitTaskCompleted(
    sessionId: string,
    actorSessionId: string,
    payload: TaskCompletedPayload,
  ): string {
    return this.emit({
      module: "task",
      type: "task_completed",
      sessionId,
      actorSessionId,
      previousState: "running",
      currentState: "completed",
      payload: payload as unknown as Record<string, unknown>,
    });
  }
}

let sharedInstance: StateEventManager | null = null;

export function getStateEventManager(): StateEventManager {
  if (!sharedInstance) {
    sharedInstance = new StateEventManager();
  }
  return sharedInstance;
}

export function resetStateEventManagerForTests(): void {
  sharedInstance = null;
}
