import type { AgentCore } from "../../services/agent-core.js";
import type { AuditService } from "../../services/audit-service.js";
import { resolveActorId } from "../../agent/actor-id.js";
import { ClientEventType, ServerEventType } from "../../protocol.js";
import type { VisionFrame } from "../../external-model/types.js";
import { userMessageSchema } from "../../schemas/api.js";
import { sanitizeVisionFramesFromWire } from "../../vision/sanitize-vision-frames.js";
import { chunkText } from "../../utils/text.js";
import { wireToolExecuted, wireToolExecuteStart } from "../chat-tool-wire.js";
import { formatScheduleToolResultForUser } from "../../tools/schedule-user-reply.js";
import { parseAgentAccessMode } from "../../agent/agent-access-mode.js";

export type ChatUserMessageHandlerDeps = {
  agentCore: AgentCore;
  auditService: AuditService;
};

export type ChatUserMessageContext = {
  socket: { send: (data: string) => void };
  boundActorId: string;
  initAsDesktopBridge: boolean;
  clientIp?: string;
  sendUnifiedError: (code: string, message: string, traceId?: string) => void;
};

/**
 * 处理 `chat.user_message` WebSocket 事件。
 * @returns 是否已消费该事件
 */
export async function handleChatUserMessageEvent(
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
  if (ctx.initAsDesktopBridge) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: {
          code: "DESKTOP_BRIDGE_NO_CHAT",
          message: "桌面桥接连接不能发送 chat.user_message，请使用普通客户端聊天",
        },
      }),
    );
    return true;
  }

  const parsed = userMessageSchema.safeParse(payload);
  if (!parsed.success) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "INVALID_CHAT_EVENT", message: parsed.error.message },
      }),
    );
    return true;
  }

  const data = parsed.data;
  const msgActor = resolveActorId({ userId: data.userId, sessionId: data.sessionId });
  if (msgActor !== ctx.boundActorId) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "FORBIDDEN", message: "userId/sessionId 与当前连接不一致" },
      }),
    );
    return true;
  }

  let visionFrames: VisionFrame[] | undefined;
  try {
    visionFrames = sanitizeVisionFramesFromWire(data.visionFrames);
  } catch (ve) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: {
          code: "INVALID_VISION",
          message: ve instanceof Error ? ve.message : String(ve),
        },
      }),
    );
    return true;
  }

  const textTrim = data.text.trim();
  const agentAccessMode = parseAgentAccessMode(data.agentAccessMode);
  const effectiveText =
    textTrim ||
    (visionFrames?.length ? "（用户发送了摄像头/配图画面，请根据图像描述内容并回答。）" : "");

  void deps.auditService
    .record({
      type: ClientEventType.ChatUserMessage,
      sessionId: msgActor,
      userId: data.userId,
      messageId: data.messageId,
      text: effectiveText,
    })
    .catch(() => {});

  let chunkSeq = 0;
  const assistantMessageId = `assistant-${data.messageId}`;
  ctx.socket.send(
    JSON.stringify({
      type: ServerEventType.ChatAgentStatus,
      payload: {
        sessionId: msgActor,
        messageId: assistantMessageId,
        traceId: data.messageId,
        phase: "thinking",
        line: "正在思考…",
      },
    }),
  );

  const sendAssistantChunk = (chunk: string): void => {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantChunk,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          chunk,
          sequence: chunkSeq++,
        },
      }),
    );
  };

  try {
    // 优先使用客户端传递的 IP，其次使用 WebSocket 连接获取的 IP
    const effectiveClientIp = data.clientIp || ctx.clientIp;
    const effectiveClientLocation = data.clientLocation;

    const reply = await deps.agentCore.handleUserMessage(msgActor, effectiveText, {
      chatUserMessageId: data.messageId,
      userId: data.userId,
      agentAccessMode,
      clientIp: effectiveClientIp,
      clientLocation: effectiveClientLocation,
      ...(visionFrames?.length ? { visionFrames } : {}),
      interruptedContext: (data as { interruptedContext?: string }).interruptedContext,
      onAssistantDelta: (delta) => sendAssistantChunk(delta),
      onExternalToolExecuteStart: (info) => {
        wireToolExecuteStart(
          {
            sessionId: msgActor,
            traceId: data.messageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
      },
      onExternalToolExecuted: (info) => {
        wireToolExecuted(
          {
            sessionId: msgActor,
            traceId: data.messageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
      },
      onAgentPhaseStatus: (line) => {
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAgentStatus,
            payload: {
              sessionId: msgActor,
              messageId: assistantMessageId,
              traceId: data.messageId,
              phase: "plan_execute",
              line,
            },
          }),
        );
      },
    });

    if (!reply.streamedChunks) {
      chunkText(reply.text, 12).forEach((chunk) => sendAssistantChunk(chunk));
    }

    let toolResult: { ok: boolean; result?: Record<string, unknown> } | undefined;
    if (reply.toolName && reply.toolInput) {
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolCall,
          payload: {
            toolName: reply.toolName,
            input: reply.toolInput,
            traceId: data.messageId,
          },
        }),
      );
      const startedAt = Date.now();
      toolResult = reply.toolResult
        ? { ok: true, result: reply.toolResult }
        : await deps.agentCore.runToolIfNeeded(msgActor, reply, {
            chatUserMessageId: data.messageId,
            userId: data.userId,
            agentAccessMode,
            clientIp: effectiveClientIp,
            clientLocation: effectiveClientLocation,
          });
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolResult,
          payload: {
            toolName: reply.toolName,
            ok: toolResult.ok,
            result: toolResult.result ?? {},
            traceId: data.messageId,
            durationMs: Date.now() - startedAt,
          },
        }),
      );
    }

    const scheduleOutcome =
      reply.toolName && toolResult?.result
        ? formatScheduleToolResultForUser(reply.toolName, toolResult.result)
        : null;

    const finalText =
      scheduleOutcome?.trim() ||
      reply.text.trim() ||
      (chunkSeq > 0 ? "" : "抱歉，我暂时无法生成回复，请稍后重试。");

    if (scheduleOutcome && scheduleOutcome !== reply.text.trim()) {
      sendAssistantChunk(
        scheduleOutcome.startsWith(reply.text.trim())
          ? scheduleOutcome.slice(reply.text.trim().length)
          : `\n\n${scheduleOutcome}`,
      );
    } else if (!reply.text.trim() && chunkSeq === 0) {
      sendAssistantChunk(finalText);
    }

    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          finalText,
          toolCalls: reply.toolName ? [reply.toolName] : [],
        },
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[WS] chat.user_message failed:", err);
    ctx.sendUnifiedError("CHAT_HANDLER_ERROR", msg, data.messageId);
    const errText = `处理消息时出错：${msg}`;
    sendAssistantChunk(errText);
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          finalText: errText,
          toolCalls: [],
        },
      }),
    );
  }

  return true;
}
