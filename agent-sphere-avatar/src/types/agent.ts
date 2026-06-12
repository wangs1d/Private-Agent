/** Agent 交互状态 — 对接主 Agent WebSocket / embodiment.patch */
export type AgentMood =
  | "idle"
  | "listening"
  | "thinking"
  | "happy"
  | "alert";

import type { Message } from "../components/MessageList";

export type TaskEventType = "progress" | "success" | "warning" | "error" | "info";

export interface TaskEvent {
  id: string;
  type: TaskEventType;
  title: string;
  detail?: string;
  timestamp: Date;
  source?: string;
  /** 是否已触发桌面通知 */
  notified?: boolean;
}

export interface AgentState {
  mood: AgentMood;
  energy: number;
  focused: boolean;
  caption?: string;
  phase?: string;
  subAgentType?: string;
  subAgentDisplayName?: string;
  source?: string;
  attentionTarget?: {
    screenX: number;
    screenY: number;
    strength?: number;
    source?: string;
    expiresAt?: number;
  };
  messages?: Message[];
  taskEvents?: TaskEvent[];
}

export const DEFAULT_AGENT_STATE: AgentState = {
  mood: "idle",
  energy: 0.55,
  focused: false,
  taskEvents: [],
};

export type EmbodimentInteractAction = "focus" | "wake" | "chat";

export interface EmbodimentInteractPayload {
  action: EmbodimentInteractAction;
  text?: string;
}

/** 主 Agent 具身指令 — 对应 agent.embodiment.command */
export type EmbodimentCommandAction =
  | "roam"
  | "move"
  | "stop"
  | "window_roam"
  | "window_place"
  | "query_state"
  | "excite";

export interface EmbodimentCommand {
  action: EmbodimentCommandAction;
  x?: number;
  y?: number;
  z?: number;
  screenX?: number;
  screenY?: number;
  strength?: number;
  mood?: AgentMood;
  energy?: number;
  caption?: string | null;
  source?: string;
}
