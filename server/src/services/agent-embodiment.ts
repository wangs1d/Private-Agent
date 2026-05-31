import { ServerEventType } from "../protocol.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import { getEmbodimentAutonomy } from "./embodiment-autonomy-service.js";

/** 球形 Agent 视觉状态 — 与 agent-sphere-avatar 对齐 */
export type EmbodimentMood =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "happy"
  | "alert";

export type EmbodimentPatch = {
  mood?: EmbodimentMood;
  energy?: number;
  caption?: string | null;
  phase?: string;
  subAgentType?: string;
  subAgentDisplayName?: string;
  source?: string;
};

export type EmbodimentSender = (json: string) => void;

/** 主 Agent 对球形身体的运动/姿态指令 */
export type EmbodimentCommandAction = "roam" | "move" | "stop" | "window_roam" | "excite";

export type EmbodimentCommand = {
  action: EmbodimentCommandAction;
  /** 3D 场景目标 x（约 -2.4～2.4） */
  x?: number;
  y?: number;
  z?: number;
  /** roam 推力倍率 0.2～2 */
  strength?: number;
  mood?: EmbodimentMood;
  energy?: number;
  caption?: string | null;
  source?: string;
};

export function emitEmbodimentPatch(
  send: EmbodimentSender,
  sessionId: string,
  patch: EmbodimentPatch,
): void {
  send(
    JSON.stringify({
      type: ServerEventType.AgentEmbodimentPatch,
      payload: { sessionId, ...patch },
    }),
  );
  getEmbodimentAutonomy()?.onPatch(sessionId, patch, send);
}

export function embodimentListening(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "listening",
    energy: 0.65,
    caption: "正在聆听…",
    source: "user_message",
  });
}

export function embodimentThinking(
  sessionId: string,
  send: EmbodimentSender,
  caption: string,
  extra?: Pick<EmbodimentPatch, "phase" | "subAgentType" | "subAgentDisplayName" | "source">,
): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "thinking",
    energy: extra?.phase?.startsWith("delegate") ? 0.78 : 0.72,
    caption: caption || undefined,
    source: extra?.source ?? "agent_status",
    ...extra,
  });
}

export function embodimentSpeaking(
  sessionId: string,
  send: EmbodimentSender,
  energy: number,
  caption?: string,
): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "speaking",
    energy,
    caption,
    source: "assistant_chunk",
  });
}

export function embodimentHappy(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "happy",
    energy: 0.55,
    caption: null,
    source: "assistant_done",
  });
}

export function embodimentIdle(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "idle",
    energy: 0.5,
    caption: null,
    source: "idle",
  });
}

export function embodimentAlert(
  sessionId: string,
  send: EmbodimentSender,
  caption: string,
  source: string,
): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "alert",
    energy: 0.9,
    caption,
    source,
  });
}

export function emitEmbodimentCommand(
  send: EmbodimentSender,
  sessionId: string,
  command: EmbodimentCommand,
): void {
  send(
    JSON.stringify({
      type: ServerEventType.AgentEmbodimentCommand,
      payload: { sessionId, ...command },
    }),
  );
}

/** 向已注册 WS 会话推送具身指令（主 Agent 工具用） */
export function pushEmbodimentCommand(
  wsRegistry: WsConnectionRegistry,
  sessionId: string,
  command: EmbodimentCommand,
): boolean {
  return wsRegistry.trySend(
    sessionId,
    JSON.stringify({
      type: ServerEventType.AgentEmbodimentCommand,
      payload: { sessionId, ...command },
    }),
  );
}
