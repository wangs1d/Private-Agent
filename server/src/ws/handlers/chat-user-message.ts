import { readFile } from "node:fs/promises";

import type { AgentCore } from "../../services/agent-core.js";
import type { AuditService } from "../../services/audit-service.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";
import { resolveActorId } from "../../agent/actor-id.js";
import { ClientEventType, ServerEventType } from "../../protocol.js";
import type { VisionFrame } from "../../external-model/types.js";
import { agentProcessingUiSchema, userMessageSchema } from "../../schemas/api.js";
import { sanitizeVisionFramesFromWire } from "../../vision/sanitize-vision-frames.js";
import { chunkText, dedupeAdjacentLines, formatStatusForDisplay } from "../../utils/text.js";
import { wireToolExecuted, wireToolExecuteStart } from "../chat-tool-wire.js";
import { formatScheduleToolResultForUser } from "../../tools/schedule-user-reply.js";
import { parseAgentAccessMode } from "../../agent/agent-access-mode.js";
import {
  embodimentAlert,
  embodimentHappy,
  embodimentListening,
  embodimentThinking,
} from "../../services/agent-embodiment.js";
import { getEmbodimentAutonomy } from "../../services/embodiment-autonomy-service.js";
import {
  MessageBatchProcessor,
  type BatchedMessage,
  type BatchTurnContext,
} from "../message-batch-processor.js";
import { getAgentRuntimeConfig } from "../../agent/agent-runtime-config.js";
import { routeLlmExecution } from "../../agent/task-router.js";
import {
  buildInterimAckText,
  interimAckMessageId,
  shouldUsePhasedAsyncConversation,
} from "../../agent/interim-ack.js";
import {
  buildExecutionEventPayload,
  buildIntentDetectedPayload,
  createTurnEventEmitter,
  type TurnEventEmitter,
} from "../../agent/turn-events.js";
import { getToolResultProcessor } from "../../services/tool-result-processor.js";
import { AssistantRewriterService } from "../../services/assistant-rewriter.js";
import { createExternalChatProviderFromEnv } from "../../external-model/resolve-provider.js";
import { refreshAgentProfileFromTurn } from "../../services/agent-profile-autonomy-service.js";
import { globalTurnLimiter, TURN_QUEUE_TIMEOUT, recordTurnOutcome } from "../../services/concurrency-limiter.js";

const messageBatchProcessor = new MessageBatchProcessor(
  getAgentRuntimeConfig().messageBatch,
);

export { messageBatchProcessor };

export type ChatUserMessageHandlerDeps = {
  agentCore: AgentCore;
  auditService: AuditService;
  /** 语音能力中枢（可选；注入后支持 contentType=audio 的 ASR 链路） */
  voiceCapabilityService?: VoiceCapabilityService;
  /** 语音消息落盘服务（可选；用于解析 audio 消息的本地文件路径） */
  voiceMessageService?: VoiceMessageService;
};

export type ChatUserMessageContext = {
  socket: { send: (data: string) => void };
  boundActorId: string;
  /** 当前 WS 的完整 sessionId（含 notes:/master: 前缀），用于记忆上下文区分。 */
  sessionId: string;
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
  let effectiveText =
    textTrim ||
    (visionFrames?.length ? "（用户发送了摄像头/配图画面，请根据图像描述内容并回答。）" : "");

  // audio 消息：拉取本地 mp3 → ASR 识别 → 用 transcript 作为正文喂给 LLM
  // 同时把 transcript 回推给客户端，让 user 消息气泡直接显示识别文本。
  if (data.contentType === "audio" && data.mediaUrl && deps.voiceCapabilityService && deps.voiceMessageService) {
    try {
      const asrText = await transcribeAudioFromMediaUrl(
        data.mediaUrl,
        msgActor,
        deps.voiceCapabilityService,
        deps.voiceMessageService,
      );
      if (asrText) {
        effectiveText = asrText;
      } else {
        effectiveText = "（用户发送了一段语音消息，但识别失败，请提示用户重试或用文字发送）";
      }
      // 回推 ASR 转写结果给客户端（无论成功失败，方便用户/客户端核对）
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAudioTranscript,
          payload: {
            sessionId: msgActor,
            messageId: data.messageId,
            mediaUrl: data.mediaUrl,
            transcript: asrText ?? "",
            language: "zh",
            ok: Boolean(asrText),
          },
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[chat.user_message] ASR 失败: ${msg}`);
      effectiveText = `（用户发送了一段语音消息，识别失败：${msg}）`;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAudioTranscript,
          payload: {
            sessionId: msgActor,
            messageId: data.messageId,
            mediaUrl: data.mediaUrl,
            transcript: "",
            language: "zh",
            ok: false,
            error: msg,
          },
        }),
      );
    }
  } else if (data.contentType === "audio" && data.mediaUrl) {
    // 未注入 ASR 服务：降级提示
    effectiveText = "（用户发送了一段语音消息，但服务端未配置 ASR 能力，无法识别内容）";
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAudioTranscript,
        payload: {
          sessionId: msgActor,
          messageId: data.messageId,
          mediaUrl: data.mediaUrl,
          transcript: "",
          language: "zh",
          ok: false,
          error: "ASR 服务未注入",
        },
      }),
    );
  }

  void deps.auditService
    .record({
      type: ClientEventType.ChatUserMessage,
      sessionId: msgActor,
      userId: data.userId,
      messageId: data.messageId,
      text: effectiveText,
    })
    .catch(() => {});

  embodimentListening(msgActor, (json) => ctx.socket.send(json));

  // 立即发送协议级 received-ack（< 1ms），让客户端知道消息已被服务端接收
  ctx.socket.send(
    JSON.stringify({
      type: ServerEventType.ChatMessageReceived,
      payload: {
        sessionId: msgActor,
        messageId: data.messageId,
        receivedAt: Date.now(),
      },
    }),
  );

  messageBatchProcessor.submit(msgActor, {
    text: effectiveText,
    visionFrames,
    agentAccessMode,
    clientIp: data.clientIp || ctx.clientIp,
    clientLocation: data.clientLocation,
    interruptedContext: (data as { interruptedContext?: string }).interruptedContext,
    originalMessageId: data.messageId,
    userId: data.userId ?? msgActor,
    sessionId: ctx.sessionId,
  }, (batched, turn) => processBatchedMessage(ctx, batched, deps, turn));

  return true;
}

/**
 * 处理 `chat.agent_processing_ui`：客户端「处理中」组件显隐。
 */
export function handleChatAgentProcessingUiEvent(
  ctx: ChatUserMessageContext,
  payload: unknown,
): boolean {
  if (!ctx.boundActorId) {
    return true;
  }
  const parsed = agentProcessingUiSchema.safeParse(payload);
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
  messageBatchProcessor.setClientProcessingUiActive(msgActor, data.active);
  return true;
}

async function processBatchedMessage(
  ctx: ChatUserMessageContext,
  batched: BatchedMessage,
  deps: ChatUserMessageHandlerDeps,
  turn: BatchTurnContext,
): Promise<void> {
  const msgActor = ctx.boundActorId;
  const isStale = (): boolean => messageBatchProcessor.isStaleTurn(msgActor, turn.generation);

  if (isStale()) return;

  getEmbodimentAutonomy()?.setProcessing(msgActor, true, (json) => ctx.socket.send(json));

  let chunkSeq = 0;
  const assistantMessageId = `assistant-${batched.originalMessageId}`;

  // v2：tool_call 起始时间表（id → epoch ms），用于在 tool_result 阶段算 elapsedMs。
  // 仅当 CHAT_TURN_PANEL_V2 开启时分配，避免无谓内存开销。
  const toolStartedAt: Map<string, number> | undefined = getAgentRuntimeConfig()
    .turnPanelV2.enabled
    ? new Map<string, number>()
    : undefined;

  const sendAssistantChunk = (chunk: string): void => {
    if (isStale()) return;
    chunkSeq += 1;
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantChunk,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          chunk,
          sequence: chunkSeq,
        },
      }),
    );
  };

  const turnEmitter: TurnEventEmitter = createTurnEventEmitter({
    send: (json) => {
      if (isStale()) return;
      ctx.socket.send(json);
    },
    enabled: getAgentRuntimeConfig().turnPanelV2.enabled,
  });

  // ?????????????????????????????????????
  let replyFinished = false;
  const maybeEmitInterimAck = async (): Promise<void> => {
    const cfg = getAgentRuntimeConfig();
    const decision = routeLlmExecution(batched.text, cfg, {
      preferFullPipeline: batched.agentAccessMode === "full",
    });
    const phasedAsyncEnabled = shouldUsePhasedAsyncConversation(batched.text, decision.mode, {
      enabled: cfg.interimAck.enabled,
    });

    if (cfg.turnPanelV2.enabled && phasedAsyncEnabled) {
      const t0 = Date.now();
      turnEmitter.emitTurnStarted({
        sessionId: msgActor,
        traceId: batched.originalMessageId,
        t0,
      });
      turnEmitter.emitIntentDetected(
        buildIntentDetectedPayload({
          sessionId: msgActor,
          traceId: batched.originalMessageId,
          decision,
        }),
      );
    }

    const interimText = phasedAsyncEnabled
      ? await buildInterimAckText({
          text: batched.text,
          mode: decision.mode,
          provider: createExternalChatProviderFromEnv(),
        })
      : null;
    if (interimText) {
      if (isStale() || replyFinished || chunkSeq > 0) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAssistantInterim,
          payload: {
            sessionId: msgActor,
            messageId: interimAckMessageId(batched.originalMessageId),
            traceId: batched.originalMessageId,
            mode: decision.mode,
            text: interimText,
          },
        }),
      );
    }
  };

  void maybeEmitInterimAck();

  // 获取全局 turn 并发许可（防止高并发时事件循环饱和 + LLM API 限流耗尽）
  const turnStartedAt = Date.now();
  let releaseTurn: (() => void) | null = null;
  try {
    releaseTurn = await globalTurnLimiter.acquire(TURN_QUEUE_TIMEOUT);
  } catch {
    // 排队超时 → 返回 429 风格提示，避免客户端无限等待
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          finalText: "当前服务繁忙，请稍后重试。",
          toolCalls: [],
        },
      }),
    );
    if (!isStale()) messageBatchProcessor.markReplyStarted(msgActor);
    return;
  }

  let turnSucceeded = false;
  let turnError: string | undefined;
  try {
    const reply = await deps.agentCore.handleUserMessage(msgActor, batched.text, {
      chatUserMessageId: batched.originalMessageId,
      userId: batched.userId,
      agentAccessMode: parseAgentAccessMode(batched.agentAccessMode),
      clientIp: batched.clientIp,
      clientLocation: batched.clientLocation,
      ...(batched.visionFrames?.length ? { visionFrames: batched.visionFrames } : {}),
      interruptedContext: batched.interruptedContext,
      sessionId: typeof batched.sessionId === "string" ? batched.sessionId : undefined,
      onAssistantDelta: (delta) => sendAssistantChunk(delta),
      onExternalToolExecuteStart: (info) => {
        if (isStale()) return;
        wireToolExecuteStart(
          {
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
      },
      onExternalToolExecuted: (info) => {
        if (isStale()) return;
        wireToolExecuted(
          {
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
      },
      onAgentPhaseStatus: (line) => {
        if (isStale()) return;
        const displayLine = formatStatusForDisplay(line);
        if (!displayLine) return;
        embodimentThinking(msgActor, (json) => ctx.socket.send(json), displayLine, {
          phase: "live",
          source: "agent_status",
        });
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAgentStatus,
            payload: {
              sessionId: msgActor,
              messageId: assistantMessageId,
              traceId: batched.originalMessageId,
              phase: "live",
              line: displayLine,
            },
          }),
        );
        // v2：plan_execute 的阶段进度（"正在分析任务…"等）也按 log 下发
        turnEmitter.emitExecutionEvent(
          buildExecutionEventPayload({
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            eventId: `phase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "log",
            log: displayLine,
          }),
        );
      },
      onPlanReady: (plan) => {
        if (isStale()) return;
        // v2：plan_execute 计划生成后，对每个 step 发 plan_step(status=pending)
        for (const step of plan.steps) {
          turnEmitter.emitExecutionEvent(
            buildExecutionEventPayload({
              sessionId: msgActor,
              traceId: batched.originalMessageId,
              eventId: `plan-${step.id}-${Date.now()}`,
              kind: "plan_step",
              planStep: {
                id: step.id,
                title: step.intent,
                status: "pending",
              },
            }),
          );
        }
        // 执行开始后，把所有 step 标记为 running（当前架构是一次性执行，非逐步）
        // 若未来拆成逐步执行，应在每步开始/完成时单独发 running/ok
        // 这里先发一条 running 表示整体进入执行
        if (plan.steps.length > 0) {
          turnEmitter.emitExecutionEvent(
            buildExecutionEventPayload({
              sessionId: msgActor,
              traceId: batched.originalMessageId,
              eventId: `plan-running-${Date.now()}`,
              kind: "plan_step",
              planStep: {
                id: plan.steps[0].id,
                title: plan.steps[0].intent,
                status: "running",
              },
            }),
          );
        }
      },
    });

    if (isStale()) return;
    replyFinished = true;

    if (!reply.streamedChunks) {
      chunkText(reply.text, 12).forEach((chunk) => sendAssistantChunk(chunk));
    }

    if (isStale()) return;
    replyFinished = true;

    let toolResult: { ok: boolean; result?: Record<string, unknown> } | undefined;
    if (reply.toolName && reply.toolInput) {
      if (isStale()) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolCall,
          payload: {
            toolName: reply.toolName,
            input: reply.toolInput,
            traceId: batched.originalMessageId,
          },
        }),
      );
      const startedAt = Date.now();
      toolResult = reply.toolResult
        ? { ok: true, result: reply.toolResult }
        : await deps.agentCore.runToolIfNeeded(msgActor, reply, {
            chatUserMessageId: batched.originalMessageId,
            userId: batched.userId,
            agentAccessMode: parseAgentAccessMode(batched.agentAccessMode),
            clientIp: batched.clientIp,
            clientLocation: batched.clientLocation,
          });
      if (isStale()) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolResult,
          payload: {
            toolName: reply.toolName,
            ok: toolResult.ok,
            result: toolResult.result ?? {},
            traceId: batched.originalMessageId,
            durationMs: Date.now() - startedAt,
          },
        }),
      );
    }

    const scheduleOutcome =
      reply.toolName && toolResult?.result
        ? formatScheduleToolResultForUser(reply.toolName, toolResult.result)
        : null;

    let finalText =
      scheduleOutcome?.trim() ||
      reply.text.trim() ||
      (chunkSeq > 0 ? "" : "抱歉，我暂时无法生成回复，请稍后重试。");

    const processor = getToolResultProcessor();
    finalText = processor.processAssistantText(finalText, {
      userText: batched.text,
      toolName: reply.toolName,
    });
    finalText = await new AssistantRewriterService(
      createExternalChatProviderFromEnv(),
    ).rewriteIfNeeded(batched.text, finalText);

    if (scheduleOutcome && scheduleOutcome !== reply.text.trim()) {
      sendAssistantChunk(
        scheduleOutcome.startsWith(reply.text.trim())
          ? scheduleOutcome.slice(reply.text.trim().length)
          : `\n\n${scheduleOutcome}`,
      );
    } else if (!reply.text.trim() && chunkSeq === 0) {
      sendAssistantChunk(finalText);
    }

    if (isStale()) return;

    embodimentHappy(msgActor, (json) => ctx.socket.send(json));
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));

    // 剥离可能残留的 [ts:] 时间戳前缀（该前缀仅供 LLM 上下文使用，不应展示给用户）
    const TS_PREFIX_RE = /^\[ts:[^\]]*\]\s*/gm;
    finalText = finalText.replace(TS_PREFIX_RE, "").trim();
    refreshAgentProfileFromTurn({
      sessionId: msgActor,
      userText: batched.text,
      assistantText: finalText,
      toolNames: reply.toolName ? [reply.toolName] : [],
    });

    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          finalText,
          toolCalls: reply.toolName ? [reply.toolName] : [],
        },
      }),
    );
    if (!isStale()) {
      messageBatchProcessor.markReplyStarted(msgActor);
    }
    turnSucceeded = true;
  } catch (err) {
    if (isStale()) return;
    const msg = err instanceof Error ? err.message : String(err);
    turnError = msg;
    console.error("[WS] chat.user_message failed:", err);
    embodimentAlert(msgActor, (json) => ctx.socket.send(json), msg, "error");
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));
    ctx.sendUnifiedError("CHAT_HANDLER_ERROR", msg, batched.originalMessageId);
    const errText = `处理消息时出错：${msg}`;
    sendAssistantChunk(errText);
    refreshAgentProfileFromTurn({
      sessionId: msgActor,
      userText: batched.text,
      assistantText: errText,
      hadError: true,
    });
    if (isStale()) return;
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          finalText: errText,
          toolCalls: [],
        },
      }),
    );
    if (!isStale()) {
      messageBatchProcessor.markReplyStarted(msgActor);
    }
  } finally {
    releaseTurn();
    // Phase 2：记录 turn 结果供自适应并发调整（AIMD）
    const turnDuration = Date.now() - turnStartedAt;
    recordTurnOutcome(turnSucceeded, turnDuration, turnError);
  }
}

/**
 * 从 mediaUrl 解析本地文件路径，读取 mp3 字节并调 ASR 识别。
 * mediaUrl 形如 `/agent/voice/messages/{actorId}/{msgId}.mp3`。
 * 失败时返回空字符串，由调用方降级处理。
 */
async function transcribeAudioFromMediaUrl(
  mediaUrl: string,
  actorId: string,
  voiceCapability: VoiceCapabilityService,
  voiceMessageService: VoiceMessageService,
): Promise<string> {
  // 从 mediaUrl 提取 actorId 与 fileName
  const match = mediaUrl.match(/^\/agent\/voice\/messages\/([^/]+)\/([^/]+)$/);
  if (!match) {
    console.warn(`[ASR] 无法解析 mediaUrl: ${mediaUrl}`);
    return "";
  }
  const [, urlActorId, fileName] = match;
  const fullPath = voiceMessageService.resolveFilePath(urlActorId, fileName);
  if (!fullPath) {
    console.warn(`[ASR] 文件不存在: ${mediaUrl}`);
    return "";
  }

  const buffer = await readFile(fullPath);
  const result = await voiceCapability.transcribe({
    audio: { data: Buffer.from(buffer), format: "mp3" },
    language: "zh",
  });

  if (!result.ok || !result.text) {
    console.warn(`[ASR] 识别失败: ${result.error ?? "empty"}`);
    return "";
  }

  console.log(`[ASR] 识别成功（actor=${actorId}, ${buffer.length} bytes）: ${result.text.slice(0, 80)}…`);
  return result.text.trim();
}
