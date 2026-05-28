/** Agent 交互状态 — 可对接主项目 WebSocket / REST */
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
  /** 用户是否正在与眼睛区域交互 */
  focused: boolean;
  /** 可选：来自主 Agent 的文本提示 */
  caption?: string;
}

export const DEFAULT_AGENT_STATE: AgentState = {
  mood: "idle",
  energy: 0.55,
  focused: false,
};
