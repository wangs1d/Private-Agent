import type { AgentMood, AgentState, TaskEvent } from "../types/agent";

export interface WsEnvelope {
  type: string;
  payload?: Record<string, unknown>;
}

export type AgentWsUpdate = Partial<
  Pick<
    AgentState,
    | "mood" | "caption" | "energy" | "phase" | "subAgentType" | "subAgentDisplayName" | "source" | "taskEvents"
  >
>;

let speakingChunkCount = 0;
let lastChunkAt = 0;

export function resetWsMapperState() {
  speakingChunkCount = 0;
  lastChunkAt = 0;
}

function patchFromEmbodiment(p: Record<string, unknown>): AgentWsUpdate {
  const caption = p.caption;
  return {
    mood: p.mood as AgentMood | undefined,
    energy: typeof p.energy === "number" ? p.energy : undefined,
    caption: caption === null ? undefined : String(caption ?? "") || undefined,
    phase: p.phase ? String(p.phase) : undefined,
    subAgentType: p.subAgentType ? String(p.subAgentType) : undefined,
    subAgentDisplayName: p.subAgentDisplayName ? String(p.subAgentDisplayName) : undefined,
    source: p.source ? String(p.source) : undefined,
  };
}

/** 将服务端 WS 事件映射为 Agent 状态更新 */
export function mapWsToAgentUpdate(msg: WsEnvelope): AgentWsUpdate | null {
  const type = msg.type;
  const p = msg.payload ?? {};

  if (type === "agent.embodiment.patch") {
    return patchFromEmbodiment(p);
  }

  switch (type) {
    case "chat.agent_status": {
      const phase = p.phase ? String(p.phase) : undefined;
      const isDelegate = phase?.startsWith("delegate");
      return {
        mood: "thinking",
        caption: undefined,
        energy: isDelegate ? 0.78 : 0.72,
        phase,
        subAgentType: p.agentType ? String(p.agentType) : undefined,
        subAgentDisplayName: p.subAgentDisplayName ? String(p.subAgentDisplayName) : undefined,
        source: "agent_status",
      };
    }
    case "tool.call": {
      return { mood: "thinking", caption: undefined, energy: 0.68, source: "tool" };
    }
    case "chat.assistant_chunk": {
      void (p.chunk ?? p.delta);
      speakingChunkCount += 1;
      lastChunkAt = Date.now();
      const burst = Math.min(1, 0.45 + speakingChunkCount * 0.015);
      return { mood: "speaking", energy: burst, caption: undefined, source: "assistant_chunk" };
    }
    case "chat.assistant_done": {
      resetWsMapperState();
      return { mood: "happy", energy: 0.55, caption: "✓ 完成", source: "assistant_done" };
    }
    case "error.event": {
      resetWsMapperState();
      const errorMsg = String(p.message ?? "错误");
      return { mood: "alert", caption: `✗ ${errorMsg}`, energy: 0.85, source: "error" };
    }
    case "schedule.reminder_fired": {
      const msg = String(p.message ?? p.title ?? "提醒").trim();
      return { mood: "alert", energy: 0.9, caption: `⏰ ${msg}`, source: "reminder" };
    }
    case "schedule.agent_task_fired": {
      const title = String(p.title ?? "自动化任务").trim();
      return { mood: "thinking", energy: 0.75, caption: `▶ ${title}`, phase: "agent_task", source: "agent_task" };
    }
    case "agent.phone.incoming": {
      const dir = String(p.direction ?? "");
      const caption =
        dir === "agent_to_user"
          ? "📞 你的 Agent"
          : p.userActionRequired === true || dir === "agent_to_agent"
            ? "📞 其他 Agent"
            : "📞 来电";
      return { mood: "alert", energy: 0.9, caption, source: "phone" };
    }
    case "agent.peer_message": {
      const preview = String(p.preview ?? p.text ?? "新消息").slice(0, 40);
      return { mood: "alert", energy: 0.82, caption: `💬 ${preview}`, source: "peer" };
    }
    case "task.event":
    case "agent.task_event": {
      const eventType = (p.eventType ?? p.type ?? "info") as TaskEvent["type"];
      const title = String(p.title ?? p.message ?? p.text ?? "任务更新").trim();
      const detail = p.detail ? String(p.detail).trim() : undefined;
      const te: TaskEvent = {
        id: String(p.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        type: ["progress", "success", "warning", "error", "info"].includes(eventType) ? eventType : "info",
        title,
        detail,
        timestamp: new Date(),
        source: String(p.source ?? "task"),
      };
      return { taskEvents: [te] };
    }
    default:
      return null;
  }
}

export function mapUserMessageSent(): AgentWsUpdate {
  resetWsMapperState();
  return { mood: "listening", energy: 0.65, caption: undefined, source: "user_message" };
}

export function mapProcessingIdle(): AgentWsUpdate {
  if (Date.now() - lastChunkAt < 800) return { mood: "speaking", energy: 0.5 };
  resetWsMapperState();
  return { mood: "idle", energy: 0.5, caption: undefined, source: "idle" };
}
