import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";

import type { RuntimeFacade } from "../../runtime/runtime-facade.js";
import type { AuditService } from "../../services/audit-service.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";
import { resolveActorId } from "../../agent/actor-id.js";
import { ClientEventType, ServerEventType } from "../../protocol.js";
import type { VisionFrame } from "../../external-model/types.js";
import { agentProcessingUiSchema, userMessageSchema } from "../../schemas/api.js";
import {
  sanitizeVisionFramesFromWire,
  type VisionWireInput,
} from "../../vision/sanitize-vision-frames.js";
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
import { getChatThreadStore } from "../../external-model/chat-thread-store.js";
import {
  isNotesChatSessionId,
  resolvePrimaryChatSessionId,
} from "../../agent/master-chat-session.js";
import { shouldUsePhasedAsyncConversation } from "../../agent/interim-ack.js";
import { StreamSegmenter } from "../../agent/stream-segmenter.js";
import {
  buildExecutionEventPayload,
  buildIntentDetectedPayload,
  createTurnEventEmitter,
  type TurnEventEmitter,
} from "../../agent/turn-events.js";
import { getToolResultProcessor, attachVideoMediaMarker, attachMediaSearchMarker, attachTravelItineraryCard, extractMediaCards, dedupMediaCards, trimMediaCardsByTopic, buildInterleavedRenderBlocks, buildCaptionedRenderBlocks, allImageCardsHaveCaption, stripMediaCardMarker, type MediaCardItem } from "../../services/tool-result-processor.js";
import { captionMediaCards, isImageCaptionEnabled } from "../../services/image-caption-service.js";
import { travelPlanStore } from "../../skills/travel-planning/travel-plan-store.js";
import { stripDsmlToolCallMarkup } from "../../external-model/stream-chat-helpers.js";
import {
  isOnlyTimestampFrames,
  stripAllTimestampFrameLines,
  stripLeadingTimestampFrames,
} from "../../utils/timestamp-frame.js";
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

/**
 * 单轮主回复的硬超时：handleUserMessage 挂死（底层 LLM/桥接/工具链永不 settle）时
 * finally 里的 releaseTurn() 永不执行，全局并发上限（默认 8）会被逐个耗尽，
 * 最终所有用户收到 BUSY。超时后 abort 本轮 controller 并抛错走 catch 路径，
 * 保证 turn 槽位、心跳定时器、批处理锁全部释放。
 * 默认 540s（略小于 message-batch-processor 的 600s 硬超时，让本层先触发、
 * 用户能收到明确错误提示）；env CHAT_TURN_TIMEOUT_MS 可调。
 */
function resolveChatTurnTimeoutMs(): number {
  const n = Number.parseInt(process.env.CHAT_TURN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 540_000;
}

function withTurnHardTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
      reject(new Error(`chat turn hard timeout: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  // 媒体搜索（search_images/search_videos）：照片/视频已由 independent 的 mediaCards
  // 结构化卡片渲染给用户，绝对不能再把工具的 items 原始 JSON 拼成回复文本透出——
  // 否则会出现"空 thumbnailUrl 的无效项、原始 JSON、脏字段"一起发给用户的脏展示。
  // 这里直接返回空串，让本轮只呈现干净的媒体卡片（不产生任何文本噪音）。
  if (t.includes("search_images") || t.includes("search_videos")) return "";
  // 旅游行程规划：行程的正确呈现形态是 travel_itinerary 双面板卡，手工拼文本只会
  // 得到 `days: [{...}]` 式 key:value 垃圾展示。这里原样返回 summarizeItinerary JSON，
  // 交由 processAssistantText 的行程检测器（detectRawTravelItineraryJson）确定性转卡。
  if (t.startsWith("travel.plan-itinerary")) {
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
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
  // 视频抓取：列出标题/作者/链接，播放页链接供点击
  if (t === "video.grab" || t.includes("video_grab") || t.includes("video.grab")) {
    const title = (result.title ?? "") as string;
    const author = (result.author ?? "") as string;
    const pageUrl = (result.playPageUrl ?? result.pageUrl ?? "") as string;
    const notes = Array.isArray(result.notes) ? result.notes.map(String).join("；") : "";
    const parts: string[] = [];
    if (title) parts.push(`视频：${title}`);
    if (author) parts.push(`作者：${author}`);
    if (pageUrl) parts.push(`原链接：${pageUrl}`);
    if (notes) parts.push(notes);
    return parts.join("\n");
  }
  // 天气/时钟/日历：直接 JSON 转可读文本
  const summary = (result.summary ?? result.description ?? result.text ?? "") as string;
  if (summary) return String(summary);
  // 兜底：把 result 的关键字段拼出来，避免完全无内容
  const keys = Object.keys(result).filter((k) => !["ok", "error"].includes(k));
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${JSON.stringify(result[k]).slice(0, 200)}`).join("\n");
}

/**
 * 把 finalText 中以纯文本形式出现的图片地址提升为可见缩略图（Markdown 图片语法）。
 *
 * 这是 mediaCards 解析为空时的最后兜底：LLM 若把图片 URL 直接写进正文（如
 * `http.../a.png`），前端 markdown 默认只当普通链接，用户看到的是地址而非照片。
 * 仅按常见图片扩展名识别，避免误伤一般超链接；已处于 `![alt](url)` 内则不重复包裹。
 */
function promoteImageUrlsToMedia(text: string): string {
  if (!text) return text;
  const IMG_URL_RE = /https?:\/\/[^\s)\]}"'<>]+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s)\]}"'<>]*)?/gi;
  const promote = (segment: string): string =>
    segment.replace(IMG_URL_RE, (match: string, offset: number, full: string) => {
      // 前面紧邻 `](` => 已处于 markdown 图片/链接语法内，不重复包裹
      if (/\]\($/.test(full.slice(0, offset))) return match;
      return `![图片](${match})`;
    });
  // 卡片标记段内是结构化 JSON（travelPlan.images 等自带图片字段，前端直读渲染），
  // 往 JSON 字符串值里注入 markdown 会让面板图片地址解析失败。只处理卡片外的纯文本段。
  const START = "[AGENT_RESULT_CARD_START]";
  const END = "[AGENT_RESULT_CARD_END]";
  if (!text.includes(START)) return promote(text);
  let out = "";
  let cursor = 0;
  for (let guard = 0; guard < 10; guard++) {
    const si = text.indexOf(START, cursor);
    if (si === -1) break;
    const ei = text.indexOf(END, si);
    if (ei === -1) break;
    out += promote(text.slice(cursor, si));
    out += text.slice(si, ei + END.length);
    cursor = ei + END.length;
  }
  out += promote(text.slice(cursor));
  return out;
}

/**
 * 从文本中剥离媒体工具 echo：形如 `[/agent/images/.../xxx.png]说明` 或
 * `![...](http.../xxx.jpg)` 这类「图片路径 + 标题」行。
 *
 * 场景：即便 `formatToolResultAsReply` 已对 media 工具返回空串，LLM 仍可能把
 * `search_images` 的工具项原样抄进自己的正文（如 `[路径]歌名`）。但这些照片已经
 * 由独立 mediaCards 结构化卡片渲染，正文里再出现 URL 行就会变成底部脏文本。
 * 这里按行剔除含图片地址的行，保留纯文字叙述（若整段都是 echo 则剩余为空）。
 */
function stripMediaEchoText(text: string): string {
  if (!text) return text;
  // 图片地址：代理路径 /agent/images/... 或 http(s) 常见图片扩展名
  const MEDIA_LINE_RE =
    /(\/agent\/images\/[^\s)\]"']+)|(https?:\/\/[^\s)\]"']+\.(?:png|jpe?g|gif|webp|avif)(?::\d+)?(?:\?[^\s)\]"']*)?)/i;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !MEDIA_LINE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ChatUserMessageHandlerDeps = {
  runtime: RuntimeFacade;
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
    // 边界收敛：zod 双实例（agent-protocol 与 server 各自的 zod 副本）会让
    // 跨包 z.infer 把枚举字段退化成 unknown；schema 本身已校验 sourceKind，
    // 这里仅做类型断言，无运行时行为差异。
    visionFrames = sanitizeVisionFramesFromWire(
      data.visionFrames as VisionWireInput[] | undefined,
    );
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
    contentType: typeof data.contentType === "string" ? data.contentType : undefined,
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
  const assistantMessageId = `assistant-${batched.originalMessageId}`;

  // [ts:...] 是系统注入的元数据标记，仅供 LLM 上下文使用，绝不能透出到用户可见消息。
  // 2026-09-03 收紧：此前只剥首块，后续块里模型复述的时间戳帧（含残缺帧）会直透前端。
  // 现在每个 chunk 出口都剥"帧"：
  // - stripLeadingTimestampFrames：剥块首的帧（分段器的信息块经常以复述的帧开头）；
  // - 整块恰好是一帧/一串帧（复述的帧独立成块时）→ 整块丢弃；
  // - 首块额外做全量整行清洗（兜底模型把帧复述在正文中间的行）。
  // 剥离容忍残缺帧（[ts 后断行/丢冒号），杜绝"严格正则匹配不上所以漏网"。
  const sendAssistantChunk = (chunk: string, phase: "interim" | "stream" = "stream"): void => {
    if (isStale()) return;
    chunkSeq += 1;
    let cleanedChunk = stripLeadingTimestampFrames(chunk);
    if (chunkSeq === 1) cleanedChunk = stripAllTimestampFrameLines(cleanedChunk);
    if (isOnlyTimestampFrames(cleanedChunk)) cleanedChunk = "";
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

  // 路由决策 & 分阶段异步开关
  // 2026-08-29：语义 LLM 路由为唯一权威（词法硬规则退出判定链，仅作其失败降级）。
  // 拉最近几条用户消息供 LLM 理解短追问（"娱乐圈的""新鲜的"）继承的话题意图；
  // 拉取失败不阻塞，LLM 路由内部对 provider 异常也有词法降级兜底。
  const cfg = getAgentRuntimeConfig();
  let recentUserTurns: string[] = [];
  try {
    const chatSessionId =
      batched.sessionId && typeof batched.sessionId === "string" && isNotesChatSessionId(batched.sessionId)
        ? batched.sessionId
        : resolvePrimaryChatSessionId(msgActor, cfg.masterDelegation.enabled);
    const current = batched.text.trim();
    recentUserTurns = getChatThreadStore()
      .thread(chatSessionId, "")
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim() && m.content.trim() !== current)
      .slice(-4)
      .map((m) => (m.content as string).trim());
  } catch {
    recentUserTurns = [];
  }
  const decision = await deps.runtime.routeTurnForWs(msgActor, batched.text, recentUserTurns);
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

  // 统一分段器：主回复流式 delta 按"信息块"（同话题连贯短句）切分，像真人
  // 一句一句蹦出来（GPT live 节奏）。垫词、分段、层层递进全部由此模块统一产出：
  // - 垫词 = 主回复的首个分句：仅当确认主回复还有后续内容时才作为 phase="interim"
  //   独立气泡先出现（前端渲染成独立垫词气泡），后续信息块走 phase="stream"
  //   追加到正文气泡；若整段回复只有一句，则整体走 stream 单个气泡。
  // - 信息块分段 + 段落增量去重：能一个气泡放完的合并，话题切换才切块，
  //   每块推送前剔除与已推送句级重复的内容，保证层层递进不重复。
  // - 重量上限 + 首段做结论锚：正文块数封顶（超限并入尾部块），首个信息块承载结论。
  // 全程同源（都来自主回复流式），天然连续、不重复。
  const streamSegmenter = new StreamSegmenter(
    (segment, phase) => sendAssistantChunk(segment, phase),
    {
      // pauseMs：每条回复信息块之间的间隔，拉长到 400ms，
      // 配合前端打字机，让每块逐字打出后都有一段清晰的停顿再输出下一块。
      pauseMs: 400,
      minSegmentChars: 6,
      interimReplyGapMs: 800,
      // 2026-08-28 修复"分段回复一次性整段渲染"：原按路由决策
      // （decision.segmentable）关闭工具/搜索/知识问答轮的分段，工具循环的
      // 最终文本只在收尾时经一次 onDelta 整段喂入 → segmentationEnabled=false
      // 时 flushFinal 把全文作为单个 stream chunk 推出，前端一条气泡一次性
      // 渲染全部内容。改为所有轮次统一启用信息块分段：无论闲聊还是工具轮，
      // 回复都按信息块逐条推送（块间 400ms 停顿），前端一条一条渲染。
      segmentationEnabled: true,
      // 信息块目标字符数（同话题短句累积到该长度切块）；正文块数上限从 8 提到 24：
      // 8 块 × 56 字 ≈ 450 字，普通长回复就会触顶，超限内容并入 tailBuffer 后在
      // flushFinal 一次性输出——长回复尾部"同时渲染"的根因。24 块 ≈ 1300 字，
      // 覆盖真实回复体量，尾部合并只对病态超长输出生效（保留为防刷屏极端阀）。
      blockCharTarget: 56,
      maxStreamSegments: 24,
    },
  );

  // 工具执行心跳：长工具（如 shopping.order.place 180s）执行期间定期发 chat.agent_status，
  // 重置客户端 3 分钟 watchdog，防止用户感知"等待回复超时"。
  const TOOL_HEARTBEAT_INTERVAL_MS = 30_000;
  // 心跳总时长封顶（自本轮 turnStartedAt 起算），env TOOL_HEARTBEAT_MAX_MS 可调。
  // 默认 5 分钟：超时后客户端 watchdog（3 分钟）可在 8 分钟内正常触发；
  // 本层硬超时（CHAT_TURN_TIMEOUT_MS 默认 540s）作为最终兜底。
  const TOOL_HEARTBEAT_MAX_MS = (() => {
    const n = Number.parseInt(process.env.TOOL_HEARTBEAT_MAX_MS ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 300_000;
  })();
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
      // 心跳总时长封顶：心跳每 30s 重置客户端 3 分钟 watchdog，会把挂死轮次
      // 掩盖成永远"正在调用工具"。超过封顶后停止心跳，让客户端 watchdog 正常
      // 超时（合法长任务如 shopping.order.place 180s 远小于该值，不受影响）。
      if (Date.now() - turnStartedAt > TOOL_HEARTBEAT_MAX_MS) {
        console.warn(
          `[WS] tool heartbeat capped at ${TOOL_HEARTBEAT_MAX_MS}ms (tool=${toolName})，停止重置客户端 watchdog`,
        );
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

  // 收集本轮实际执行的媒体搜索工具结果（search_images / search_videos）。
  // 原因：LLM 的最终回复 reply.toolName 时常为 undefined（模型在搜完图后仅输出
  // 正文，不再带工具声明），导致 extractMediaCards 拿不到 items，前端照片无法展示。
  // 这里绕开 reply.toolName，直接从 onExternalToolExecuted 捕获真实工具结果，
  // 保证 chat.assistant_done 的 mediaCards 一定有真实缩略图。
  const executedMediaToolResults: Array<{
    toolName: string;
    result: Record<string, unknown>;
  }> = [];
  // 行程规划工具（tool-loop 路径）：LLM 末轮通常只输出正文不带工具声明，
  // reply.toolName/toolResult 均为空 → attachTravelItineraryCard 拿不到原始
  // 结果、行程卡永远附不上（右侧面板不自动展开）。这里从 onExternalToolExecuted
  // 捕获真实结果作为附卡数据源。
  let executedTravelPlanResult: Record<string, unknown> | undefined;
  // 「边说边出图」已推送过的媒体地址集合：跨工具批去重，避免同一张图被推两次
  const sentEarlyMediaKeys = new Set<string>();
  // 方案1：不再把流式 delta 逐段喂入分段器（多段流/工具边界会打断 heldFirst 导致
  // 多个垫词、顺序错乱、语义重复）。仅累积原始流式文本作兜底，最终只把"最终文本"一次性
  // 喂入分段器，保证：垫词恰好一个、信息块按最终文本顺序、层层递进不重复。
  let streamedText = "";

  try {
    // 硬超时兜底：挂死时 abort 本轮 controller（中断 LLM 流式请求）并抛错，
    // 让 catch/finally 路径释放 turn 槽位与全部定时器（见 withTurnHardTimeout 注释）。
    const chatTurnTimeoutMs = resolveChatTurnTimeoutMs();
    const reply = await withTurnHardTimeout(
      deps.runtime.handleUserMessage(msgActor, batched.text, {
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
        // 方案1：只需累积原始流式文本作兜底；不再实时 feed 分段器，
        // 避免多段流/工具边界打断 heldFirst 造成多个垫词与顺序错乱。
        // 最终在 reply.text 完成后一次性 feed 进分段器（见下方 flush 前）。
        if (isStale()) return;
        streamedText += delta;
      },
      onExternalToolExecuteStart: (info) => {
        if (isStale()) return;
        // 方案1：不再需要 markToolBoundary——分段器只在最终文本一次性喂入时才裁决，
        // 工具边界不会再产生垫词碎片。
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
        // 捕获媒体搜索工具的真实结果，供 done 阶段构建 mediaCards（见上方说明）
        if (info.ok && info.result && info.toolName === "travel.plan-itinerary") {
          executedTravelPlanResult = info.result as Record<string, unknown>;
        }
        if (
          info.ok &&
          info.result &&
          (info.toolName === "search_images" ||
            info.toolName === "search_images_batch" ||
            info.toolName === "search_videos")
        ) {
          executedMediaToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          // 边说边出图：媒体工具一执行完，先把该批照片结构化推给前端，
          // 前端插到当前流式正文下方实时展示；done 时再按 renderBlocks 校正顺序。
          try {
            const earlyCards = dedupMediaCards(
              extractMediaCards(
                info.toolName,
                info.result as Record<string, unknown>,
              ),
            ).filter((c) => {
              const key = (c.thumbnailUrl || c.mediaUrl || "").trim();
              if (!key || sentEarlyMediaKeys.has(key)) return false;
              sentEarlyMediaKeys.add(key);
              return true;
            });
            if (earlyCards.length > 0) {
              ctx.socket.send(
                JSON.stringify({
                  type: ServerEventType.ChatMediaReady,
                  payload: {
                    sessionId: msgActor,
                    messageId: assistantMessageId,
                    traceId: batched.originalMessageId,
                    cards: earlyCards,
                  },
                }),
              );
            }
          } catch {
            /* 边说边出图为可选增强，失败静默不阻塞主流程 */
          }
        }
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
    }),
      chatTurnTimeoutMs,
      () => {
        console.error(
          `[WS] chat turn hard timeout (${chatTurnTimeoutMs}ms), actor=${msgActor}，abort 本轮并释放并发槽位`,
        );
        try {
          turnAbortController.abort();
        } catch {
          /* ignore */
        }
      },
    );

    if (isStale()) return;

    // 方案1：主回复流结束后，把"最终文本"一次性喂入分段器作为唯一内容源。
    // - 优先用 reply.text（最终答复，确定性来源）；为空（如走兜底/工具拼接路径）时
    //   用流式累积的 streamedText 兜底，保证至少有一段正文可分段。
    // - 链路保证：只 feed 这一次，分段器内部据此裁决一个垫词 + 按信息块递进，
    //   避免多段流/工具边界造成的重复、乱序与多个垫词。
    // - 入料前统一清一遍时间戳帧（streamedText 分支是原始流式累积、从未清洗过；
    //   复述的帧不在这里剥掉，就会成为独立信息块推给前端）。
    const finalFeedRaw = (reply.text && reply.text.trim()) ? reply.text : streamedText;
    const finalFeed = stripAllTimestampFrameLines(finalFeedRaw);
    if (finalFeed && finalFeed.trim()) {
      streamSegmenter.feed(finalFeed);
    }

    // 主回复流结束：把分段器缓冲中剩余的半截文本作为最后一段推送
    await streamSegmenter.flushFinal();

    if (isStale()) return;

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
        : await deps.runtime.runToolIfNeeded(msgActor, reply, {
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
    // 旅游行程确定性附卡：工具返回已瘦身，LLM 口头回复不再携带明细、也写不出
    // 能被切卡的逐日列表，卡片由代码直接从工具原始结果生成（autoOpen=true，
    // 前端 assistant_done 收到即自动展开双面板；卡片保留在消息中供回看）。
    // 正文已有卡片标记时不重复附加。
    let travelCardToolName = reply.toolName
      ?? (executedTravelPlanResult ? "travel.plan-itinerary" : undefined);
    let travelCardResult = toolResult?.result ?? executedTravelPlanResult;
    if (travelCardToolName === "travel.plan-itinerary") {
      // 工具回执是瘦身摘要（只有 id/title，无 days）：按 planId 从冷层取完整行程供附卡
      const planId = String(
        (travelCardResult as Record<string, unknown> | undefined)?.id ?? "",
      ).trim();
      const fullPlan = planId ? travelPlanStore.get(planId) : null;
      if (fullPlan) travelCardResult = fullPlan as unknown as Record<string, unknown>;
    }
    if (!travelCardToolName && !travelCardResult) {
      // tool-loop 内执行的工具不经过 onExternalToolExecuted（回调只覆盖单工具直跑路径），
      // 这里从行程冷层确定性回捞：只认「最近 60s 内生成」的行程（工具成功即落盘，
      // 附卡在其后几秒内执行），正文点名目的地时优先，避免把旧行程误挂到后续闲聊轮。
      const candidates = travelPlanStore
        .listSummaries(5)
        .filter((s) => Date.now() - s.createdAt < 60 * 1000);
      const picked =
        candidates.find((s) => s.destination && finalText.includes(s.destination)) ??
        candidates[0];
      const recentPlan = picked ? travelPlanStore.get(picked.planId) : null;
      if (recentPlan) {
        travelCardToolName = "travel.plan-itinerary";
        travelCardResult = recentPlan as unknown as Record<string, unknown>;
      }
    }
    finalText = attachTravelItineraryCard(finalText, travelCardToolName, travelCardResult);
    // 视频抓取：附加可播放媒体标记（[RENDER_AS:video] + [VIDEO_MEDIA_START]），
    // 前端据此真实内联播放代理后的视频流
    finalText = attachVideoMediaMarker(finalText, reply.toolName, toolResult?.result);
    // 结构化媒体卡片（Coze 式架构）：与 LLM 文本解耦，作为独立字段下发。
    // 前端直接读取 chat.assistant_done 的 mediaCards 字段渲染缩略图，
    // 不再依赖从 LLM 文本解析 [AGENT_RESULT_CARD_START] 标记。
    //
    // 聚合规则（2026-08-20）：**保留本轮所有**媒体搜索执行结果，而不是只取第一个。
    // 原因：对比类需求（马尔代夫 vs 印尼）LLM 会多次调用 search_images/
    // search_images_batch（不同维度/两侧），旧逻辑只取首个非空结果导致
    // 对比图只显示一侧或单维度。现在全部聚合，配合每条卡片携带的
    // groupTitle/side/sideLabel 分组元数据，前端按维度分组、左右分栏展示。
    let mediaCards: MediaCardItem[] = [];
    for (const mt of executedMediaToolResults) {
      const cards = extractMediaCards(mt.toolName, mt.result);
      if (cards.length > 0) mediaCards.push(...cards);
    }
    // 兜底：reply.toolName 路径执行（runToolIfNeeded 未走 onExternalToolExecuted）时，
    // 本轮执行结果里没有它，这里直接补齐。
    if (mediaCards.length === 0 && reply.toolName) {
      mediaCards = extractMediaCards(reply.toolName, toolResult?.result);
    }
    // 同一张图不重复展示：跨轮聚合后按图片地址去重（对比图各维度/两侧常重复返回）
    mediaCards = dedupMediaCards(mediaCards);
    // 主题粒度自适应裁剪：不设全局总量硬限，按主题(分组)保证"少而精、不遗漏"。
    // - 普通分组(单次搜索)最多 maxPerGroup 张，不堆一墙；
    // - 对比分组(A/B)每侧各 maxPerSide 张，两侧对称；
    // - 主题多则每个主题都保留前几张，不因总量上限把后面的主题/某侧挤掉。
    mediaCards = trimMediaCardsByTopic(mediaCards, {
      maxPerGroup: 4,
      maxPerSide: 2,
    });
    // 真实图片描述（Coze 式「一图一句」）：对裁剪后的图片卡逐张看图生成 caption。
    // 视觉模型批量调用（与主对话同 provider），失败/超时/模型不支持视觉时
    // 静默跳过——卡片保持无 caption，渲染回退旧的正文交错排版。
    if (mediaCards.length > 0 && isImageCaptionEnabled()) {
      try {
        await captionMediaCards(mediaCards);
      } catch (err) {
        console.info(
          `[chat] 图片描述生成异常（忽略，回退旧渲染）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // 仅当没有结构化卡片时，才回退走文本标记注入（保持旧客户端兼容、
    // 以及非图片工具不带结构数据的场景）。有 mediaCards 时不再注入标记，
    // 避免 finalText 携带标记被前端旧解析路径抢先渲染、且无真实缩略图。
    if (mediaCards.length === 0) {
      // 媒体搜索：确定性注入 thumbnailUrl 到 media 卡片（不依赖 LLM 转发）
      finalText = attachMediaSearchMarker(finalText, reply.toolName, toolResult?.result);
    } else {
      // mediaCards 由 toolResult 承载、前端已能独立渲染缩略图；若 finalText 里
      // 还残留 processAssistantText 注入的 [AGENT_RESULT_CARD_START] 卡片块，
      // 前端会将其当作纯文本原样展示（重复/来回渲染）。这里剥掉，避免与
      // mediaCards 双份展示。
      finalText = stripMediaCardMarker(finalText);
      // 媒体搜索轮次：照片已由 mediaCards 卡片渲染，正文里若还残留 LLM 抄的
      // 工具项（`[路径]说明` 行）就会变成底部脏文本。按行剔除含图片地址的 echo，
      // 只保留纯文字叙述（若整段都是 echo 则剩余为空），保证下方只剩干净照片。
      finalText = stripMediaEchoText(finalText);
    }
    // 提升最终回复文本中图片地址为可见缩略图（mediaCards 为空时的最后兜底）
    if (mediaCards.length === 0) {
      finalText = promoteImageUrlsToMedia(finalText);
    }

    // 交错渲染块（renderBlocks）：把「清洗后的正文段落」与「媒体分组」按正文顺序交错，
    // 前端按块顺序渲染 → 「一段文字介绍后放一组照片，再一段文字，再一组照片」，
    // 替代旧行为「全部照片一次性铺在最前面」。由代码层位置锚定完成，不依赖 prompt。
    // 仅当有结构化媒体卡片时构建；无媒体时前端走原「文本+标记」路径。
    //
    // 2026-09-03：图片卡全部带真实描述（caption）时改走 buildCaptionedRenderBlocks——
    // 正文保持完整一段，照片逐张附各自的 caption（描述由视觉模型看图生成），
    // 不再用位置启发式把正文切段钉到照片旁（那是「文字与照片对不上」的根源）。
    const renderBlocks =
      mediaCards.length > 0
        ? allImageCardsHaveCaption(mediaCards)
          ? buildCaptionedRenderBlocks(finalText, mediaCards)
          : buildInterleavedRenderBlocks(finalText, mediaCards)
        : [];

    // [调试] 图片搜索链路诊断：记录工具名 / items / 卡片是否注入，用于排查前端照片不显示
    try {
      const debugItems = Array.isArray((toolResult?.result as any)?.items)
        ? ((toolResult?.result as any).items as unknown[]).length
        : -1;
      appendFileSync(
        "data/debug-image-card.log",
        `${new Date().toISOString()} toolName=${reply.toolName ?? "undefined"} ` +
          `toolOk=${toolResult?.ok} items=${debugItems} hasCard=${finalText.includes(
            "[AGENT_RESULT_CARD_START]",
          )}\n`,
      );
    } catch {
      /* 调试日志失败不影响主流程 */
    }

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

    // 兜底剥离 [ts:] 时间戳帧（chunk 出口已逐块剥，这里对 finalText 再整行兜底一次，
    // 容忍残缺帧，防路径绕过 sendAssistantChunk）
    finalText = stripAllTimestampFrameLines(finalText).trim();
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
          // 结构化媒体卡片（Coze 式架构）：独立于 LLM 文本，前端直接渲染缩略图
          ...(mediaCards.length > 0 ? { mediaCards } : {}),
          // 交错渲染块：按正文顺序切好的「文字段+媒体组」，前端按序渲染
          // → 「一段文字介绍后放一组照片，再一段文字，再一组照片」。
          ...(renderBlocks.length > 0 ? { renderBlocks } : {}),
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
    // 丢弃主回复分段器缓冲（异常路径防残留半截文本）
    streamSegmenter.discard();
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

