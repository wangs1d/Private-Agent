import type { AgentMood } from "../types/agent";

export interface WsEnvelope {
  type: string;
  payload?: Record<string, unknown>;
}

export interface AgentWsUpdate {
  mood?: AgentMood;
  caption?: string;
  energy?: number;
}

let speakingChunkCount = 0;
let lastChunkAt = 0;

export function resetWsMapperState() {
  speakingChunkCount = 0;
  lastChunkAt = 0;
}

/** 将服务端 WS 事件映射为 Agent 状态更新 */
export function mapWsToAgentUpdate(msg: WsEnvelope): AgentWsUpdate | null {
  const type = msg.type;
  const p = msg.payload ?? {};

  switch (type) {
    case "chat.agent_status": {
      const line = String(p.line ?? "").trim();
      return { mood: "thinking", caption: line || undefined, energy: 0.72 };
    }
    case "tool.call": {
      const line = String(p.userStatusLine ?? p.assistantPreamble ?? p.toolName ?? "").trim();
      return { mood: "thinking", caption: line || "工具执行中", energy: 0.68 };
    }
    case "chat.assistant_chunk": {
      const chunk = String(p.chunk ?? p.delta ?? "");
      speakingChunkCount += 1;
      lastChunkAt = Date.now();
      const burst = Math.min(1, 0.45 + speakingChunkCount * 0.015);
      return { mood: "speaking", energy: burst, caption: chunk.slice(-24) || undefined };
    }
    case "chat.assistant_done": {
      resetWsMapperState();
      return { mood: "happy", energy: 0.55, caption: undefined };
    }
    case "error.event": {
      resetWsMapperState();
      return { mood: "alert", caption: String(p.message ?? "错误"), energy: 0.85 };
    }
    case "schedule.reminder_fired":
    case "agent.phone.incoming": {
      return { mood: "alert", energy: 0.9, caption: "提醒" };
    }
    default:
      return null;
  }
}

export function mapUserMessageSent(): AgentWsUpdate {
  resetWsMapperState();
  return { mood: "listening", energy: 0.65, caption: "正在聆听…" };
}

export function mapProcessingIdle(): AgentWsUpdate {
  if (Date.now() - lastChunkAt < 800) return { mood: "speaking", energy: 0.5 };
  resetWsMapperState();
  return { mood: "idle", energy: 0.5, caption: undefined };
}
