export type BatchedMessage = {
  text: string;
  visionFrames?: import("../external-model/types.js").VisionFrame[];
  agentAccessMode?: string;
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  interruptedContext?: string;
  originalMessageId: string;
  userId: string;
  timestamp: number;
  /** 当前 WebSocket 完整 sessionId（含 notes:/master: 等前缀），用于记忆上下文区分。 */
  sessionId?: string;
  /** 消息内容类型，用于区分 voice/text_chat 等 channel（如 "audio" → voice） */
  contentType?: string;
};

export type MessageBatchProcessorConfig = {
  /** 是否启用批处理，默认 true */
  enabled: boolean;
};

export type BatchTurnContext = {
  /** 本轮代次；客户端隐藏「处理中」UI 后新消息进入下一轮 */
  generation: number;
};

const DEFAULT_CONFIG: MessageBatchProcessorConfig = {
  enabled: true,
};

/**
 * 单轮回复的硬超时兜底：onReady 挂死（如底层 LLM/工具链永不 settle）时
 * processing 标志永不清除，该会话后续所有消息无限排队且无任何错误提示。
 * 超时后放弃本轮（bump generation 让迟到的 settle no-op），继续处理队列。
 * 真实长任务（多波工具 + 180s 级工具）远小于该值，正常路径不受影响。
 */
function resolveTurnHardTimeoutMs(): number {
  const n = Number.parseInt(process.env.BATCH_TURN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

/**
 * 消息队列处理器：用户持续输入时排队，依次回复。
 *
 * 核心机制：
 * - 首条消息到达后尽快开始处理（同事件循环内多条会先合并为一条）
 * - 处理中到达的新消息进入队列，等当前回复完成后依次处理
 * - 每条用户消息都会得到独立的回复，不会被合并或丢弃
 * - 客户端上报 `chat.agent_processing_ui` active=false 后锁定本轮
 */
export class MessageBatchProcessor {
  private buffers = new Map<string, BatchedMessage[]>();
  private onReadyHandlers = new Map<
    string,
    (merged: BatchedMessage, turn: BatchTurnContext) => Promise<void>
  >();
  private processing = new Set<string>();
  /** 客户端已隐藏「处理中」UI，本轮不可再合并 */
  private turnCommitted = new Set<string>();
  private inFlightMerged = new Map<string, BatchedMessage>();
  private processingGeneration = new Map<string, number>();
  private flushScheduled = new Set<string>();
  private config: MessageBatchProcessorConfig;
  /** 消息队列：处理中到达的新消息排队，依次回复 */
  private messageQueue = new Map<string, BatchedMessage[]>();

  constructor(config?: Partial<MessageBatchProcessorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 提交一条用户消息到批处理器。
   */
  submit(
    sessionId: string,
    message: Omit<BatchedMessage, "timestamp">,
    onReady: (merged: BatchedMessage, turn: BatchTurnContext) => Promise<void>,
  ): void {
    this.onReadyHandlers.set(sessionId, onReady);

    if (!this.config.enabled) {
      const turn = this.bumpGeneration(sessionId);
      this.processing.add(sessionId);
      void this.invokeReady(
        sessionId,
        { ...message, timestamp: Date.now() } as BatchedMessage,
        turn,
      );
      return;
    }

    const now = Date.now();
    const buffered: BatchedMessage = { ...message, timestamp: now };

    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, []);
    }
    this.buffers.get(sessionId)!.push(buffered);

    this.scheduleFlush(sessionId);
  }

  /**
   * 同步客户端「Agent 处理中」UI 状态。
   * active=false 表示处理中组件已消失，锁定当前轮次。
   */
  setClientProcessingUiActive(sessionId: string, active: boolean): void {
    if (active) {
      return;
    }
    this.commitTurn(sessionId);
    if ((this.buffers.get(sessionId)?.length ?? 0) > 0) {
      this.scheduleFlush(sessionId);
    }
  }

  /** 当前轮次是否已被更新的用户消息取代（应停止向客户端推送） */
  isStaleTurn(sessionId: string, generation: number): boolean {
    return (this.processingGeneration.get(sessionId) ?? 0) !== generation;
  }

  /** @deprecated 仅服务端兜底；正常由客户端 processing_ui active=false 触发 */
  markReplyStarted(sessionId: string): void {
    this.commitTurn(sessionId);
  }

  private commitTurn(sessionId: string): void {
    this.turnCommitted.add(sessionId);
  }

  private canMerge(sessionId: string): boolean {
    return !this.turnCommitted.has(sessionId);
  }

  private scheduleFlush(sessionId: string): void {
    if (this.flushScheduled.has(sessionId)) return;
    this.flushScheduled.add(sessionId);
    queueMicrotask(() => {
      this.flushScheduled.delete(sessionId);
      this.tryStartOrRestart(sessionId);
    });
  }

  private tryStartOrRestart(sessionId: string): void {
    const pending = this.buffers.get(sessionId)?.length ?? 0;
    if (pending === 0 && !this.inFlightMerged.has(sessionId)) return;

    if (this.processing.has(sessionId)) {
      // 处理中：新消息进入队列，等当前回复完成后依次处理
      // 不再合并/重启当前轮次（避免多条消息只回复一次）
      const pending = this.takeBuffer(sessionId);
      if (pending.length > 0) {
        const queue = this.messageQueue.get(sessionId) ?? [];
        queue.push(...pending);
        this.messageQueue.set(sessionId, queue);
      }
      return;
    }

    this.flush(sessionId);
  }

  private restartInFlight(sessionId: string): void {
    const pending = this.takeBuffer(sessionId);
    const prev = this.inFlightMerged.get(sessionId);
    const merged = this.mergeMessageList(
      prev ? [prev, ...pending] : pending,
    );
    if (!merged) return;

    this.turnCommitted.delete(sessionId);
    const turn = this.bumpGeneration(sessionId);
    this.inFlightMerged.set(sessionId, merged);
    void this.invokeReady(sessionId, merged, turn);
  }

  private flush(sessionId: string): void {
    if (this.processing.has(sessionId)) return;

    const pending = this.takeBuffer(sessionId);
    if (pending.length === 0) return;

    const merged = this.mergeMessageList(pending);
    if (!merged) return;

    const turn = this.bumpGeneration(sessionId);
    this.inFlightMerged.set(sessionId, merged);
    this.processing.add(sessionId);
    this.turnCommitted.delete(sessionId);
    void this.invokeReady(sessionId, merged, turn);
  }

  private takeBuffer(sessionId: string): BatchedMessage[] {
    const messages = this.buffers.get(sessionId) ?? [];
    this.buffers.delete(sessionId);
    return messages;
  }

  private bumpGeneration(sessionId: string): BatchTurnContext {
    const next = (this.processingGeneration.get(sessionId) ?? 0) + 1;
    this.processingGeneration.set(sessionId, next);
    return { generation: next };
  }

  private invokeReady(sessionId: string, merged: BatchedMessage, turn: BatchTurnContext): void {
    const onReady = this.onReadyHandlers.get(sessionId);
    if (!onReady) return;

    // 硬超时兜底：onReady 永不 settle（底层挂死）时强制放弃本轮并解锁队列。
    // 迟到的 settle 会被 generation 不匹配守卫拦下，不会重复清理。
    const hardTimeoutMs = resolveTurnHardTimeoutMs();
    const hardTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`batch turn hard timeout: session=${sessionId} exceeded ${hardTimeoutMs}ms`));
      }, hardTimeoutMs);
      timer.unref?.();
    });

    void Promise.race([Promise.resolve(onReady(merged, turn)), hardTimeout])
      .catch((error) => {
        // onReady 内部已有错误处理；这里兜底超时/异常，保证 finally 一定执行
        console.error("[message-batch-processor] turn failed or timed out:", error);
      })
      .finally(() => {
        if (this.processingGeneration.get(sessionId) !== turn.generation) {
          return;
        }
        this.processing.delete(sessionId);
        this.turnCommitted.delete(sessionId);
        this.inFlightMerged.delete(sessionId);

        // 处理队列中的下一条消息
        const queue = this.messageQueue.get(sessionId);
        if (queue && queue.length > 0) {
          const next = queue.shift();
          if (!next) return;
          if (queue.length === 0) {
            this.messageQueue.delete(sessionId);
          }
          const nextTurn = this.bumpGeneration(sessionId);
          this.inFlightMerged.set(sessionId, next);
          this.processing.add(sessionId);
          this.turnCommitted.delete(sessionId);
          void this.invokeReady(sessionId, next, nextTurn);
          return;
        }

        if ((this.buffers.get(sessionId)?.length ?? 0) > 0) {
          this.scheduleFlush(sessionId);
        }
      });
  }

  private mergeMessageList(messages: BatchedMessage[]): BatchedMessage | null {
    if (messages.length === 0) return null;
    return this.mergeMessages(messages);
  }

  private mergeMessages(messages: BatchedMessage[]): BatchedMessage {
    if (messages.length === 1) {
      return messages[0];
    }

    const texts = messages.map((m, i) =>
      i === 0 ? m.text : `[续${i + 1}] ${m.text}`,
    );

    const last = messages[messages.length - 1];

    return {
      text: texts.join("\n"),
      visionFrames: last.visionFrames,
      agentAccessMode: last.agentAccessMode,
      clientIp: last.clientIp,
      clientLocation: last.clientLocation,
      interruptedContext: last.interruptedContext,
      // 沿用最后一条用户消息的 messageId 作为 traceId：客户端 _pendingAgentUserMessageId
      // 始终是最后发出那条的 id（_armAgentReplyWatchdog 每次覆盖），用合成 batch- id 会让
      // chat.turn_started / chunk 的 traceId 与客户端对不上，导致 _turnState 永远不被赋值。
      originalMessageId: last.originalMessageId,
      userId: last.userId,
      timestamp: Date.now(),
    };
  }

  /**
   * 强制刷新指定会话的所有缓冲消息（用于断开连接等场景）
   */
  forceFlush(
    sessionId: string,
    onReady?: (merged: BatchedMessage, turn: BatchTurnContext) => Promise<void>,
  ): void {
    if (onReady) {
      this.onReadyHandlers.set(sessionId, onReady);
    }
    if (this.processing.has(sessionId) && this.turnCommitted.has(sessionId)) {
      return;
    }
    if (this.processing.has(sessionId)) {
      this.restartInFlight(sessionId);
      return;
    }
    this.flush(sessionId);
  }

  /**
   * 清理资源（服务关闭时调用）
   */
  dispose(): void {
    this.buffers.clear();
    this.onReadyHandlers.clear();
    this.processing.clear();
    this.turnCommitted.clear();
    this.inFlightMerged.clear();
    this.processingGeneration.clear();
    this.flushScheduled.clear();
    this.messageQueue.clear();
  }

  /** 获取指定会话当前缓冲的消息数量（调试用） */
  getBufferSize(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /** 获取指定会话当前队列中等待处理的消息数量（调试用） */
  getQueueSize(sessionId: string): number {
    return this.messageQueue.get(sessionId)?.length ?? 0;
  }
}
