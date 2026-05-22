export type StateModule = "gomoku" | "doudizhu" | "zhajinhua" | "wallet" | "calendar" | "task" | "market" | "social";

export type StateEventType =
  | "game_started"
  | "game_finished"
  | "game_move"
  | "turn_changed"
  | "transaction_completed"
  | "task_completed"
  | "skill_purchased"
  | "post_created"
  | "friend_request_received"
  | "milestone_reached";

export type StateChangeEvent<T = Record<string, unknown>> = {
  eventId: string;
  module: StateModule;
  type: StateEventType;
  sessionId: string;
  actorSessionId: string;
  timestamp: string;
  previousState?: string;
  currentState: string;
  payload: T;
};

export type StateChangeHandler<T = Record<string, unknown>> = (event: StateChangeEvent<T>) => void | Promise<void>;

export interface IStateManager {
  emit<T>(event: Omit<StateChangeEvent<T>, "eventId" | "timestamp">): string;
  on<T>(module: StateModule | "*", type: StateEventType | "*", handler: StateChangeHandler<T>): () => void;
  off(module: StateModule | "*", type: StateEventType | "*", handler: StateChangeHandler): void;
  getRecentEvents(module?: StateModule, limit?: number): StateChangeEvent[];
}

export type GameFinishedPayload = {
  winner?: string;
  loser?: string;
  moveCount?: number;
  durationMs?: number;
  snapshot?: Record<string, unknown>;
};

export type TransactionCompletedPayload = {
  amount: number;
  currency: string;
  counterparty?: string;
  reason: string;
};

export type TaskCompletedPayload = {
  taskId: string;
  taskType: string;
  summary: string;
  success: boolean;
};
