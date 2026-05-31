/** Agent 交互状态 — 对接主 Agent WebSocket / embodiment.patch */
export type AgentMood =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "happy"
  | "alert";

export interface AgentState {
  mood: AgentMood;
  /** 0–1，影响呼吸灯强度 */
  energy: number;
  /** 用户是否正在与玻璃屏区域交互 */
  focused: boolean;
  /** 来自主 Agent 的状态文案 */
  caption?: string;
  /** 委派/工具阶段 */
  phase?: string;
  subAgentType?: string;
  subAgentDisplayName?: string;
  source?: string;
}

export const DEFAULT_AGENT_STATE: AgentState = {
  mood: "idle",
  energy: 0.55,
  focused: false,
};

export type EmbodimentInteractAction = "focus" | "wake" | "chat";

export interface EmbodimentInteractPayload {
  action: EmbodimentInteractAction;
  text?: string;
}

/** 主 Agent 具身指令 — 对应 agent.embodiment.command */
export type EmbodimentCommandAction = "roam" | "move" | "stop" | "window_roam" | "excite";

export interface EmbodimentCommand {
  action: EmbodimentCommandAction;
  x?: number;
  y?: number;
  z?: number;
  strength?: number;
  mood?: AgentMood;
  energy?: number;
  caption?: string | null;
  source?: string;
}
