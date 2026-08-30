import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  annotateUserContentForLlm,
  getChatThreadStore,
  tagUserMessageClientId,
} from "./chat-thread-store.js";
import type { ChatThreadStore } from "./chat-thread-store.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { modelSupportsVision, ocrImageText } from "./vision-support.js";
import {
  adaptOpenAiChatCompletionStream,
  consumeNormalizedStream,
  createStreamControlTagSanitizer,
  createStreamMetaSentenceFilter,
  pickVisibleText,
  StreamIdleTimeoutError,
  stripInternalControlTags,
  type NormalUsage,
} from "./stream-chat-helpers.js";
import {
  applyPromptCacheMessages,
  preparePromptCachePlan,
} from "./prefix-cache.js";
import { resolveChatToolPlanForStream } from "./resolve-chat-tools.js";
import { prepareTools } from "../gateway/index.js";
import { streamCompletionWithTools } from "./openai-compatible-tool-loop.js";
import { recordLlmUsageByChars } from "../services/llm-token-audit.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  ProviderCapabilities,
  StreamDeltaHandler,
} from "./types.js";

/** preparePromptCachePlan 的返回类型（含 fullSystemPrompt / promptCache / requestSystemMessages）。 */
type PromptCachePlan = ReturnType<typeof preparePromptCachePlan>;
type ToolPlan = ReturnType<typeof resolveChatToolPlanForStream>;
type ToolSearchPrepared = Awaited<ReturnType<typeof prepareTools>>;

/**
 * buildSystemAndPlan 钩子的上下文：基类在调用前已解析好 model / tools / suppressSuffixes 等。
 * 子类据此决定如何构建 sysContent 与 promptPlan（例如是否走缓存、是否分层 prompt）。
 */
export interface SystemAndPlanContext {
  overrideSys: string | undefined;
  promptMemory: AgentPromptMemoryContext | undefined;
  suppressSuffixes: boolean;
  tools: ChatToolExecutionContext | undefined;
  toolSearchPrepared: ToolSearchPrepared | null;
  model: string;
  streamOpts: AgentStreamOptions | undefined;
}

export interface SystemAndPlanResult {
  sysContent: string;
  promptPlan: PromptCachePlan;
}

/**
 * 所有具体 chat provider 的抽象基类（模板方法模式）。
 *
 * 设计动机：防串台逻辑（foldCompletedToolChains，在 afterTurnCompleted 中根源折叠）、
 * 时间戳注入（annotateUserContentForLlm）、clientMessageId 标记（tagUserMessageClientId）、
 * thread 维护（trimThread/afterTurnCompleted）原本散落在各 provider 的 streamCompletion 里
 * 靠复制粘贴维持，任一新 provider 漏调即导致"话题切换串台"问题。本基类把这些逻辑固化为
 * 模板方法中不可跳过的步骤，子类只覆写 provider 特定钩子，从结构上杜绝漏调。
 *
 * 子类职责：
 * - 声明 id / displayLabel / capabilities / systemPrompt / model / client / notEnabledErrorMessage
 * - 实现 buildSystemAndPlan（构建 sysContent + promptPlan）
 * - 按需覆写 resolveModel / buildExtraBody / resolveEffectiveStreamOpts / applyExtraBodyToPlainRequest
 *
 * 基类固化职责（不可被子类跳过）：
 * - thread 装载 / system 写入三分支 / 编辑重发截断
 * - userMsg 时间戳注入 + clientMessageId 标记
 * - afterTurnCompleted 中调用 foldCompletedToolChains（根源防串台：折叠已完成 tool_call 链）
 * - 流式消费 + 超时兜底 + 失败回滚
 * - afterTurnCompleted 持久化
 */
export abstract class AbstractChatProvider implements ExternalChatProvider {
  abstract readonly id: string;
  abstract readonly displayLabel: string;
  abstract readonly capabilities: ProviderCapabilities;

  /** 子类提供的系统提示词常量（用于 thread 初始化与 appendThreadTurn）。 */
  protected abstract readonly systemPrompt: string;
  /** 子类解析的默认模型名（用于 resolveModel 默认实现）。 */
  protected abstract readonly model: string;
  /** 子类持有的 OpenAI 兼容 client（构造函数初始化；null 表示未配置密钥）。 */
  protected abstract readonly client: OpenAI | null;
  /** client 为 null 时抛出的错误信息。 */
  protected abstract readonly notEnabledErrorMessage: string;

  /** 共享的 thread store 单例（所有 provider 共用同一份会话历史）。 */
  protected readonly threads: ChatThreadStore = getChatThreadStore();

  isEnabled(): boolean {
    return this.client !== null;
  }

  clearSession(sessionId: string): void {
    this.threads.clearSession(sessionId);
  }

  /**
   * 按 clientMessageId 移除该 user 消息及其后的全部线程内容（fast→complex 升级
   * 重放前清理 fast 轮写入的残迹，防 user 消息/部分回复在重放后重复落盘）。
   * 无 clientMessageId 时 no-op（无法定位，保持原线程）。
   */
  removeUserTurnAndAfter(sessionId: string, clientMessageId?: string): void {
    if (!clientMessageId) return;
    this.threads.removeUserMessageAndAfter(sessionId, clientMessageId);
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    model?: string,
  ): void {
    this.threads.appendTurn(
      sessionId,
      this.systemPrompt,
      userTurn,
      assistantText,
      maxThreadMessages,
      undefined,
      undefined,
      model ?? this.model,
    );
  }

  protected thread(sessionId: string): ChatCompletionMessageParam[] {
    return this.threads.thread(sessionId, this.systemPrompt);
  }

  protected trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number, sessionId?: string): void {
    this.threads.trimThread(msgs, maxMessages, sessionId);
  }

  // ── 子类可覆写的钩子（均有默认实现） ──────────────────────────────

  /** 解析本轮使用的模型。默认：streamOpts.modelOverride ?? this.model。子类可覆写为智能路由。 */
  protected resolveModel(
    streamOpts: AgentStreamOptions | undefined,
    _userText: string,
    _msgCount: number,
  ): string {
    return streamOpts?.modelOverride?.trim() || this.model;
  }

  /**
   * 构造 extraBody（如 thinking 开关 / fastProfile）。
   * 默认返回 undefined（不附加任何字段）。子类按 provider 特性覆写。
   * 该返回值同时用于工具分支（传给 toolLoop）和非工具分支（按 applyExtraBodyToPlainRequest 决定是否 spread）。
   */
  protected buildExtraBody(_effectiveStreamOpts: AgentStreamOptions): Record<string, unknown> | undefined {
    return undefined;
  }

  /** 派生 effectiveStreamOpts。默认原样返回；子类可覆写（如 Kimi 强制 disableThinking）。 */
  protected resolveEffectiveStreamOpts(streamOpts: AgentStreamOptions | undefined): AgentStreamOptions {
    return streamOpts ?? {};
  }

  /** 非工具分支的 request 是否 spread extraBody。默认 false（OpenAI 风格）；Kimi 覆写为 true。 */
  protected applyExtraBodyToPlainRequest(): boolean {
    return false;
  }

  /**
   * 构建 system 内容与 prompt cache plan（子类必须实现）。
   *
   * 子类在此完成：
   * - sysContent 的构建（可走缓存 / 分层 prompt / 直算）
   * - promptPlan 的构建（含 tools 信息，供工具分支与非工具分支共用）
   *
   * 基类保证在调用此钩子前已解析 model、已准备 toolSearchPrepared。
   */
  protected abstract buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult;

  // ── 模板方法（固化防串台逻辑的唯一入口） ──────────────────────────

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    const client = this.client;
    if (!client) {
      throw new Error(this.notEnabledErrorMessage);
    }

    const ephemeral = streamOpts?.ephemeralTurn === true;
    const msgs: ChatCompletionMessageParam[] = ephemeral ? [] : this.thread(sessionId);
    // Token 用量审计：非工具分支记录实际发往 LLM 的输入规模（估算）
    let requestAuditInput = 0;

    const overrideSys = streamOpts?.systemPromptOverride?.trim();
    const promptMemory = streamOpts?.promptContext?.memory;
    const suppressSuffixes = streamOpts?.suppressRuntimeSuffixes === true;

    // 模型解析（子类可覆写为智能路由；此时 msgs 尚未 push userMsg，msgCount 为 thread 原始长度）
    const model = this.resolveModel(streamOpts, userTurn.text, msgs.length);

    // 工具准备（若启用工具）
    const toolPlan: ToolPlan | null = tools
      ? resolveChatToolPlanForStream(userTurn.text, streamOpts)
      : null;
    // disableToolSearch（fast 车道）：visible 全量即 searchable，不构建延迟目录。
    // fast maxRounds=1 下 tool_discover→tool_call 两波召回必断头，目录只会造成
    // "发现工具说明就被截断"的断头回复。
    const searchableForTurn =
      streamOpts?.disableToolSearch === true
        ? toolPlan?.visibleTools
        : toolPlan?.searchableTools;
    const toolSearchPrepared: ToolSearchPrepared | null = toolPlan
      ? await prepareTools(toolPlan.visibleTools, searchableForTurn, {
          userText: userTurn.text,
        })
      : null;

    // 子类构建 sysContent + promptPlan（含 tools 信息，两个分支共用，避免 Kimi 式重复构建）
    const { sysContent, promptPlan } = this.buildSystemAndPlan({
      overrideSys,
      promptMemory,
      suppressSuffixes,
      tools,
      toolSearchPrepared,
      model,
      streamOpts,
    });

    // system 写入 msgs：三分支逻辑（ephemeral/空 → push；minimal+override → 内容不同才覆盖；else → 覆盖）
    if (ephemeral || msgs.length === 0) {
      msgs.push({ role: "system", content: sysContent });
    } else if (suppressSuffixes && overrideSys) {
      const first = msgs[0];
      const currentContent =
        first && first.role === "system" && typeof first.content === "string"
          ? first.content
          : "";
      if (currentContent !== sysContent) {
        msgs[0] = { role: "system", content: sysContent };
      }
    } else {
      msgs[0] = { role: "system", content: sysContent };
    }

    // 支持「编辑同 clientMessageId 的 user 消息并重发」：先把该消息及其后续内容删掉。
    if (!ephemeral && userTurn.clientMessageId) {
      this.threads.removeUserMessageAndAfter(sessionId, userTurn.clientMessageId);
    }
    const turnStartLen = msgs.length;

    // ★ 防串台关键步骤 1：user 消息时间戳注入 + clientMessageId 标记（固化，子类无法跳过）
    // 用户照片注入分流：纯文本模型（deepseek-chat 等）无法接收 image_url，注入会直接
    // 报 400 导致整轮失败——照片"发不进对话"。此处先尽力把照片 OCR 成文本（失败静默），
    // 再由 openAiUserContentFromTurn 按模型能力决定：视觉模型注入 image_url，非视觉降级文本。
    let contentTurn = userTurn;
    if (userTurn.visionFrames?.length && !modelSupportsVision(model)) {
      const ocrParts: string[] = [];
      const ocrResults = await Promise.allSettled(
        userTurn.visionFrames.slice(0, 2).map((f) => ocrImageText(f.dataBase64, f.mimeType)),
      );
      for (const r of ocrResults) {
        if (r.status === "fulfilled" && r.value) ocrParts.push(r.value);
      }
      if (ocrParts.length > 0) {
        contentTurn = { ...userTurn, text: `${userTurn.text}\n\n${ocrParts.join("\n\n")}` };
      }
    }
    const userMsg = {
      role: "user",
      content: annotateUserContentForLlm(openAiUserContentFromTurn(contentTurn, { model })),
    } as ChatCompletionMessageParam;
    tagUserMessageClientId(userMsg, userTurn.clientMessageId);
    msgs.push(userMsg);

    // ★ 防串台已根源解决：afterTurnCompleted 在上一轮完成时已调用 foldCompletedToolChains
    //    移除 raw tool 结果。这里只需 trimThread 控制上下文长度。
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
    }

    const effectiveStreamOpts = this.resolveEffectiveStreamOpts(streamOpts);
    const extraBody = this.buildExtraBody(effectiveStreamOpts);

    // ── 工具分支 ──
    if (tools && toolPlan && toolSearchPrepared) {
      let completed = false;
      try {
        const full = await streamCompletionWithTools(
          client,
          model,
          msgs,
          onDelta,
          tools,
          {
            onAfterToolBatch: effectiveStreamOpts.toolLoop?.onAfterToolBatch,
            tools: toolPlan.visibleTools,
            toolSearchSourceTools: toolPlan.searchableTools,
            maxRounds: effectiveStreamOpts.toolLoop?.maxRounds,
            extraBody,
            promptCache: promptPlan.promptCache,
            requestSystemMessages: promptPlan.requestSystemMessages,
            tailDynamicContext: promptPlan.tailDynamicContext,
            maxOutputTokens: effectiveStreamOpts.maxOutputTokens,
            audit: { sessionId, stage: "main_chat" },
          },
        );
        completed = true;
        if (!ephemeral) {
          this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
          this.threads.afterTurnCompleted(sessionId, msgs);
        }
        return full;
      } catch (e) {
        if (!completed && !ephemeral) {
          msgs.length = turnStartLen;
        }
        throw e;
      }
    }

    // ── 非工具分支 ──
    let stream;
    try {
      const finalMessages = applyPromptCacheMessages(
        msgs,
        promptPlan.requestSystemMessages,
        promptPlan.tailDynamicContext,
      );
      const request = {
        model,
        messages: finalMessages,
        stream: true,
        ...(streamOpts?.maxOutputTokens ? { max_tokens: streamOpts.maxOutputTokens } : {}),
        ...(promptPlan.promptCache ?? {}),
        ...(this.applyExtraBodyToPlainRequest() ? (extraBody ?? {}) : {}),
      };
      // Token 用量审计：记录发往 LLM 的实际输入规模（估算）
      requestAuditInput = JSON.stringify(finalMessages).length + (toolPlan ? JSON.stringify(toolPlan.visibleTools).length : 0);
      stream = await client.chat.completions.create(
        request as Parameters<typeof client.chat.completions.create>[0],
        effectiveStreamOpts.signal ? { signal: effectiveStreamOpts.signal } : undefined,
      ) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (e) {
      msgs.length = turnStartLen;
      throw e;
    }

    let visible = "";
    // API 流末尾 chunk 返回的 prefix cache 计费数据（scope 提升供下方 token 审计采集）
    let streamUsage: NormalUsage | undefined;
    try {
      const sanitizer = createStreamControlTagSanitizer();
      const metaFilter = createStreamMetaSentenceFilter();
      const result = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => {
            // 根源净化：model 偶发会把内部控制标签（如 [STOP...] / [话题切换...]）
            // 混进 content，逐 chunk 直推这里时先过净化器，避免标签透出到前端气泡。
            // 2026-08-29 扩展：再叠一层元术语整句过滤（"上一轮转入规划任务..."），
            // 兜底 LLM 在流式中把系统元描述整段写进回复。
            const clean = metaFilter(sanitizer(d));
            if (clean) onDelta(clean);
          },
          providerId: this.id,
          model,
        },
      );
      streamUsage = result.usage;
      visible = stripInternalControlTags(pickVisibleText(result.content, result.reasoning));
    } catch (e) {
      // 流式空闲超时：如果有 partial content，用它作为兜底回复而非直接失败。
      if (e instanceof StreamIdleTimeoutError && e.partialContent.trim()) {
        visible = e.partialContent.trim();
        // eslint-disable-next-line no-console
        console.warn(
          `[stream-idle-timeout] provider=${this.id} model=${model} ` +
            `→ 使用 ${visible.length} 字符的 partial content 兜底`,
        );
      } else {
        msgs.length = turnStartLen;
        throw e;
      }
    }

    if (visible.trim()) {
      msgs.push({ role: "assistant", content: visible });
    }
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
      this.threads.afterTurnCompleted(sessionId, msgs);
    }
    // Token 用量审计（非工具分支）：输入为发往 LLM 的 messages + 可见工具 schema，
    // 并附带 API 真实返回的 prefix cache 命中/未命中 token（若流末尾带 usage）
    try {
      recordLlmUsageByChars({
        stage: "main_chat",
        sessionId,
        inputChars: requestAuditInput,
        outputChars: visible.length,
        model,
        promptCacheHitTokens: streamUsage?.promptCacheHitTokens,
        promptCacheMissTokens: streamUsage?.promptCacheMissTokens,
      });
    } catch {
      /* 审计失败静默 */
    }
    return visible;
  }
}
