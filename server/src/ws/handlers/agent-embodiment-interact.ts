import { ServerEventType } from "../../protocol.js";
import { agentEmbodimentInteractSchema } from "../../schemas/api.js";
import {
  embodimentListening,
  emitEmbodimentPatch,
} from "../../services/agent-embodiment.js";
import {
  handleChatUserMessageEvent,
  type ChatUserMessageContext,
  type ChatUserMessageHandlerDeps,
} from "./chat-user-message.js";

/**
 * 处理 `agent.embodiment.interact` — 让球形 Agent 可直接唤醒主 Agent 或发送消息。
 */
export async function handleAgentEmbodimentInteractEvent(
  ctx: ChatUserMessageContext,
  payload: unknown,
  deps: ChatUserMessageHandlerDeps,
): Promise<boolean> {
  if (!ctx.boundActorId) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
      }),
    );
    return true;
  }

  const parsed = agentEmbodimentInteractSchema.safeParse(payload);
  if (!parsed.success) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "INVALID_EMBODIMENT_EVENT", message: parsed.error.message },
      }),
    );
    return true;
  }

  const data = parsed.data;
  const msgActor = ctx.boundActorId;
  const send = (json: string) => ctx.socket.send(json);

  if (data.action === "focus") {
    emitEmbodimentPatch(send, msgActor, {
      mood: "listening",
      energy: 0.6,
      caption: "等待输入…",
      source: "embodiment_focus",
    });
    return true;
  }

  const wakeText =
    data.action === "wake"
      ? "（用户从球形 Agent 唤醒，请简短打招呼并询问需要什么帮助。）"
      : (data.text?.trim() ?? "");

  if (!wakeText) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "INVALID_EMBODIMENT_EVENT", message: "chat 动作需要 text" },
      }),
    );
    return true;
  }

  embodimentListening(msgActor, send);

  const messageId = `emb-${Date.now().toString(36)}`;
  return handleChatUserMessageEvent(
    ctx,
    {
      sessionId: data.sessionId,
      userId: data.userId ?? data.sessionId,
      messageId,
      text: wakeText,
      timestamp: new Date().toISOString(),
      agentAccessMode: data.agentAccessMode,
    },
    deps,
  );
}
