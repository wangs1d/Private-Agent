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
import { formatStatusForDisplay, stripSentencesAlreadySaid } from "../../utils/text.js";
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
  LivingInterimController,
  shouldUsePhasedAsyncConversation,
} from "../../agent/interim-ack.js";
import {
  buildExecutionEventPayload,
  buildIntentDetectedPayload,
  createTurnEventEmitter,
  type TurnEventEmitter,
} from "../../agent/turn-events.js";
import { getToolResultProcessor } from "../../services/tool-result-processor.js";
import { createExternalChatProviderFromEnv } from "../../external-model/resolve-provider.js";
import { stripDsmlToolCallMarkup } from "../../external-model/stream-chat-helpers.js";
import { globalTurnLimiter, TURN_QUEUE_TIMEOUT, recordTurnOutcome } from "../../services/concurrency-limiter.js";
import { FALLBACK_TEXT_BUSY } from "../../external-model/fallback-texts.js";

const messageBatchProcessor = new MessageBatchProcessor(
  getAgentRuntimeConfig().messageBatch,
);

export { messageBatchProcessor };

/**
 * Actor 级 AbortController 跟踪:用户发新消息时 abort 旧 controller,
 * 真正中断进行中的 LLM HTTP 流式请求(节省 tokens/算力)。
 * 与 messageBatchProcessor 的 isStaleTurn 门控配合:isStale 抑制输出,abort 中断请求。
 */
const activeTurnAborters = new Map<string, AbortController>();

/** 中断指定 actor 当前进行中的 LLM 请求(如有)。 */
function abortActiveTurn(actorId: string): void {
  const prev = activeTurnAborters.get(actorId);
  if (prev) {
    try { prev.abort(); } catch { /* ignore */ }
    activeTurnAborters.delete(actorId);
  }
}

/**
 * 工具调用成功 + LLM 末轮没出正文时，把工具结果格式化成用户可读的回复文本。
 * 不再用"已查到见上面"等合成提示语——直接展示工具返回的真实数据。
 * 返回空串表示无法格式化（上层会走其他回退路径）。
 */
function formatToolResultAsReply(toolName: string, result: Record<string, unknown>): string {
  // 元工具/能力查询类输出是结构化 JSON（工具 schema、能力清单），不是用户可读内容。
  // 若 LLM 末轮没出正文,不能用它们拼成回复透出到前端,直接返回空串走其他兜底路径。
  const META_TOOL_NAMES = new Set([
    "tool_discover",
    "tool_search",
    "tool_describe",
    "tool_call",
    "agent.query_capabilities",
    "brain.list_capabilities",
    "self.list_custom_skills",
  ]);
  if (META_TOOL_NAMES.has(toolName)) return "";

  const t = toolName.toLowerCase();
  // 搜索类：把标题/摘要/URL 列出来
  if (t.includes("search_web") || t.includes("web_search") || t.includes("info_hub")) {
    const items = (result.results ?? result.items ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(items) && items.length > 0) {
      const lines = items.slice(0, 5).map((it, i) => {
        const title = (it.title ?? "") as string;
        const url = (it.url ?? it.link ?? "") as string;
        const snippet = (it.snippet ?? it.summary ?? "") as string;
        return `${i + 1}. ${title}${url ? `\n   ${url}` : ""}${snippet ? `\n   ${snippet.slice(0, 120)}` : ""}`;
      });
      return `查到了 ${items.length} 条结果：\n\n${lines.join("\n\n")}`;
    }
    return "";
  }
  // 抓取类：返回正文摘要
  if (t.includes("fetch_web") || t.includes("web_fetch") || t.includes("http_get")) {
    const title = (result.title ?? "") as string;
    const content = (result.content ?? result.text ?? result.body ?? "") as string;
    if (title || content) {
      return `${title}\n\n${content.slice(0, 800)}`.trim();
    }
    return "";
  }
  // 天气/时钟/日历：直接 JSON 转可读文本
  const summary = (result.summary ?? result.description ?? result.text ?? "") as string;
  if (summary) return String(summary);
  // 兜底：把 result 的关键字段拼出来，避免完全无内容
  const keys = Object.keys(result).filter((k) => !["ok", "error"].includes(k));
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${JSON.stringify(result[k]).slice(0, 200)}`).join("\n");
}

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
    contentType: data.contentType,
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

  // 中断该 actor 上一轮进行中的 LLM 请求(用户发新消息 → abort 旧的 HTTP 流式)
  abortActiveTurn(msgActor);
  const turnAbortController = new AbortController();
  activeTurnAborters.set(msgActor, turnAbortController);

  getEmbodimentAutonomy()?.setProcessing(msgActor, true, (json) => ctx.socket.send(json));

  let chunkSeq = 0;
  // 区分 interim 与 stream：interim 是回复首段（垫词），stream 是主回复正文
  // mainStreamStarted 一旦为 true，interim 不再插入，保证顺序
  let mainStreamStarted = false;
  const assistantMessageId = `assistant-${batched.originalMessageId}`;

  // v2：tool_call 起始时间表（id → epoch ms），用于在 tool_result 阶段算 elapsedMs。
  // 仅当 CHAT_TURN_PANEL_V2 开启时分配，避免无谓内存开销。
  const toolStartedAt: Map<string, number> | undefined = getAgentRuntimeConfig()
    .turnPanelV2.enabled
    ? new Map<string, number>()
    : undefined;

  // [ts:...] 是系统注入的元数据标记，仅供 LLM 上下文使用，绝不能透出到用户可见消息。
  // 在所有 chunk 出口处统一剥离，避免 LLM 误把格式回显到回复里。
  const TS_PREFIX_RE = /^\[ts:[^\]]*\]\s*/gm;
  const stripTsPrefix = (text: string): string =>
    text.replace(TS_PREFIX_RE, "");

  const sendAssistantChunk = (chunk: string, phase: "interim" | "stream" = "stream"): void => {
    if (isStale()) return;
    if (phase === "stream") mainStreamStarted = true;
    chunkSeq += 1;
    // 仅在首块剥离前缀；后续块被剥会丢失合法内容。
    const cleanedChunk = chunkSeq === 1 ? stripTsPrefix(chunk) : chunk;
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantChunk,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          chunk: cleanedChunk,
          sequence: chunkSeq,
          phase,
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

  let replyFinished = false;

  // 路由决策 & 分阶段异步开关
  const cfg = getAgentRuntimeConfig();
  const decision = routeLlmExecution(batched.text, cfg, {
    preferFullPipeline: true,
  });
  const phasedAsyncEnabled = shouldUsePhasedAsyncConversation(batched.text, decision.mode, {
    enabled: cfg.interimAck.enabled,
  });

  // turn 面板 v2 阶段 0/1
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

  // 活体 interim 控制器：智能门控 + 多条进度更新
  // 被动路径统一用 text_chat（传达动作）
  // interim 不再用独立 messageId，而是作为同一 assistant 消息的 phase="interim" 首段
  const interimController = new LivingInterimController({
    sessionId: msgActor,
    traceId: batched.originalMessageId,
    mode: decision.mode,
    enabled: phasedAsyncEnabled,
    channel: "text_chat",
    provider: createExternalChatProviderFromEnv(),
    send: (text, _seq) => {
      // 通过 sendAssistantChunk 推送，phase="interim" 让客户端识别为首段
      sendAssistantChunk(text, "interim");
    },
    isStale,
    isMainReplyStarted: () => mainStreamStarted,
  });

  void interimController.maybeEmitInitial(batched.text);

  // 主动在场：complex 后台执行期间周期性给 LLM 开口机会，
  // 生成自然互动（追问/反馈/闲聊），像真人边做边聊，直到主回复开始/结束。
  if (decision.mode === "complex" && phasedAsyncEnabled) {
    interimController.startPresence(batched.text);
  }

  // 内容驱动的多步回复：主回复流式输出时，由 interim 控制器按自然段落切分，
  // 每完成一个段落就作为一条独立消息推送（步数 = 段落数，无定时器/随机/模板）。
  // 复杂任务（complex）后台执行期间，fast 的承接 + 分段推送共同形成"多步回复"效果。

  // 工具执行心跳：长工具（如 shopping.order.place 180s）执行期间定期发 chat.agent_status，
  // 重置客户端 3 分钟 watchdog，防止用户感知"等待回复超时"。
  const TOOL_HEARTBEAT_INTERVAL_MS = 30_000;
  const toolHeartbeatTimers = new Map<string, NodeJS.Timeout>();
  let heartbeatLineCache: string | null = null;
  // 进度条：每个心跳累计 15%，封顶 90%（留 10% 给最终收尾），支持客户端渲染进度条
  const heartbeatPercent = new Map<string, number>();
  // 防 status line 抖动：tool loop 阶段 LLM 的每个流式 delta 都会把整段 fullText
  // 推过来，formatStatusForDisplay 经常把它剪成同一句"正在查阅历史记忆…" / "正在从网络检索相关信息…"
  // → 不去重的话单轮能连发几百次完全相同的事件，挤占通道并延长 LLM 等待窗口。
  // 这里按"格式化后的展示文案"去重：文案变了才发，文案不变直接吞掉。
  let lastStatusDisplayLine: string | null = null;
  let statusLineRepeats = 0;

  function startToolHeartbeat(toolName: string): void {
    // 已有同工具的心跳则跳过（并行工具调用时可能重名，用 timer 存在性判重）
    if (toolHeartbeatTimers.has(toolName)) return;
    const timer = setInterval(() => {
      if (isStale()) {
        stopToolHeartbeat(toolName);
        return;
      }
      // 进度条：每次心跳 +15%，封顶 90%（最终收尾时 agent-core 会再推 100%）
      const prev = heartbeatPercent.get(toolName) ?? 0;
      const next = Math.min(90, prev + 15);
      heartbeatPercent.set(toolName, next);
      // 发一条轻量 chat.agent_status 心跳，重置客户端 watchdog + 推进度
      const heartbeatLine = heartbeatLineCache ?? `正在执行 ${toolName}…`;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAgentStatus,
          payload: {
            sessionId: msgActor,
            messageId: assistantMessageId,
            traceId: batched.originalMessageId,
            phase: "live",
            line: heartbeatLine,
            percent: next,
          },
        }),
      );
    }, TOOL_HEARTBEAT_INTERVAL_MS);
    // 允许事件循环在无其他任务时退出
    timer.unref();
    toolHeartbeatTimers.set(toolName, timer);
  }

  function stopToolHeartbeat(toolName: string): void {
    const timer = toolHeartbeatTimers.get(toolName);
    if (timer) {
      clearInterval(timer);
      toolHeartbeatTimers.delete(toolName);
    }
    heartbeatPercent.delete(toolName);
  }

  function clearAllToolHeartbeats(): void {
    for (const timer of toolHeartbeatTimers.values()) {
      clearInterval(timer);
    }
    toolHeartbeatTimers.clear();
  }

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
          finalText: FALLBACK_TEXT_BUSY(),
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
      signal: turnAbortController.signal,
      routeDecision: decision,
      onAssistantDelta: (delta) => {
        // 流式推送最终内容到前端（tool loop 结束后的最终回复 token-by-token）
        if (isStale()) return;
        // 主回复正文只走 stream 单条通道。不再喂给 interim 分段器：
        // 否则同一段正文会被 feedStreamDelta 累积成完整段落后以 phase="interim"
        // 推一份（前端渲染为独立消息），又被这里以 phase="stream" 推一份（前端
        // 渲染为主回复）——同一回复内容双推送，前端出现两条气泡。
        // interim 通道只承载垫词 / presence 互动（独立 LLM 生成，内容与正文不同）。
        sendAssistantChunk(delta, "stream");
      },
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
        // 启动工具执行心跳：每 30s 发一次 chat.agent_status，
        // 防止单个长工具（如 shopping.order.place 180s）执行期间客户端 watchdog 超时。
        startToolHeartbeat(info.toolName);
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
        // 清除工具执行心跳
        stopToolHeartbeat(info.toolName);
      },
      onBackgroundAssistantDelta: (info) => {
        if (isStale()) return;
        chunkSeq += 1;
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              sessionId: msgActor,
              messageId: info.messageId,
              traceId: batched.originalMessageId,
              chunk: info.delta,
              sequence: chunkSeq,
              phase: "stream",
              source: info.source,
            },
          }),
        );
      },
      onBackgroundAssistantDone: (info) => {
        if (isStale()) return;
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId: msgActor,
              messageId: info.messageId,
              traceId: batched.originalMessageId,
              finalText: info.finalText,
              toolCalls: [],
              source: info.source,
            },
          }),
        );
      },
      onAgentPhaseStatus: (line) => {
        if (isStale()) return;
        const displayLine = formatStatusForDisplay(line);
        if (!displayLine) return;
        // 去重：同一句展示文案不重复推送（tool loop 每个 delta 都会调一次）
        if (displayLine === lastStatusDisplayLine) {
          statusLineRepeats += 1;
          // 重复超过 20 次（约略估算同一 LLM 轮次上限）就彻底吞掉，避免：
          //   1) WS 通道被同一文案挤爆
          //   2) 客户端 watchdog 始终不超时（chat.agent_status 本身在重置 watchdog），
          //      而真正的 chat.assistant_done 因为 LLM 卡在同一句 status 而发不出
          //   3) 用户在前端看到 LLM 永远在"正在查阅历史记忆…"，超 90s 后被前端兜底成"没听清"
          if (statusLineRepeats > 20) return;
          // 20 次以内仍保留心跳语义（重置 watchdog），但不再 emit event
        } else {
          lastStatusDisplayLine = displayLine;
          statusLineRepeats = 0;
        }
        // 更新心跳文案缓存，让后续心跳更有上下文感
        heartbeatLineCache = displayLine;
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

    // 流式推送已在 onAssistantDelta 中完成；若未启动（兜底路径未走流式），单次推送完整文本
    if (!mainStreamStarted && reply.text) {
      sendAssistantChunk(reply.text, "stream");
    }

    // 多步收尾：把分段器缓冲中剩余的半截文本作为最后一条消息推送
    interimController.flushRemaining();

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
      (chunkSeq > 0 ? "" : "");

    // 工具成功但 LLM 末轮没出正文时，用工具结果文本作为回复（不再用合成的"已查到见上面"）。
    // 真实数据比提示语更有价值——用户能看到工具到底返回了什么。
    if (
      !finalText &&
      reply.toolName &&
      toolResult?.ok &&
      toolResult.result &&
      !chunkSeq
    ) {
      const toolResultText = formatToolResultAsReply(reply.toolName, toolResult.result);
      if (toolResultText) finalText = toolResultText;
    }

    const processor = getToolResultProcessor();
    finalText = processor.processAssistantText(finalText, {
      userText: batched.text,
      toolName: reply.toolName,
    });

    if (scheduleOutcome && scheduleOutcome !== reply.text.trim()) {
      const supplement = scheduleOutcome.startsWith(reply.text.trim())
        ? scheduleOutcome.slice(reply.text.trim().length)
        : `\n\n${scheduleOutcome}`;
      // 去重兜底：剔除 supplement 与已流式正文句级重复的内容，
      // 避免"整段一模一样出现两次"（工具结果拼接与 LLM 已说内容重叠）。
      const deduped = stripSentencesAlreadySaid(reply.text, supplement);
      if (!isStale() && deduped.trim()) sendAssistantChunk(deduped, "stream");
    } else if (!reply.text.trim() && chunkSeq === 0) {
      if (!isStale() && finalText) sendAssistantChunk(finalText, "stream");
    }

    if (isStale()) return;

    embodimentHappy(msgActor, (json) => ctx.socket.send(json));
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));

    // 兜底剥离 [ts:] 时间戳前缀（首块已剥，这里再兜底一次以防路径绕过 sendAssistantChunk）
    finalText = finalText.replace(TS_PREFIX_RE, "").trim();
    // 兜底再剥一次 DSML 工具调用标记：极少数情况下 DSML 跨多个 chunk 拼接后正则未在 adapter 层
    // 命中（极端异步路径），这里二次清理避免内部格式透出到用户可见消息。
    finalText = stripDsmlToolCallMarkup(finalText);

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
    // 内部错误日志保留完整信息（含 stack），便于排查
    console.error("[WS] chat.user_message failed:", err);
    embodimentAlert(msgActor, (json) => ctx.socket.send(json), msg, "error");
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));
    ctx.sendUnifiedError("CHAT_HANDLER_ERROR", msg, batched.originalMessageId);
    // 不再用 apology 兜底文案掩盖错误：agent-core 已尝试 emergencyRegenerate，
    // 此处发空串让 UI 不显示虚假回复。sendUnifiedError 已通知前端出错。
    const errText = "";
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
    // 停止主动在场 ticker（turn 结束无论成败都停，防定时器泄漏）
    interimController.stopPresence();
    // 清除所有可能残留的工具心跳定时器（如工具异常未触发 onToolExecuted）
    clearAllToolHeartbeats();
    // 清理本轮 AbortController(如未被新消息 abort 则正常清理)
    if (activeTurnAborters.get(msgActor) === turnAbortController) {
      activeTurnAborters.delete(msgActor);
    }
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
