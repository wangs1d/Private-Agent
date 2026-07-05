export type StateModule = "wallet" | "calendar" | "task" | "market" | "social";

export type StateEventType =
  | "turn_changed"
  | "transaction_completed"
  | "task_completed"
  | "game_finished"
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

export type GameFinishedPayload = {
  gameId?: string;
  gameType?: string;
  outcome?: "win" | "lose" | "draw" | "finished";
  score?: number;
  summary?: string;
};
