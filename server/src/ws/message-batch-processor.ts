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
 * 消息批处理器：在客户端仍显示「Agent 处理中」期间，将用户多条消息合并为一条再处理。
 *
 * 核心机制（不依赖固定时间间隔）：
 * - 首条消息到达后尽快开始处理（同事件循环内多条会先合并）
 * - 客户端上报 `chat.agent_processing_ui` active=true 时允许合并/重启本轮
 * - active=false（处理中 UI 已隐藏）后锁定本轮，新消息进入下一轮
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
      if (!this.canMerge(sessionId)) {
        return;
      }
      this.restartInFlight(sessionId);
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

    void Promise.resolve(onReady(merged, turn)).finally(() => {
      if (this.processingGeneration.get(sessionId) !== turn.generation) {
        return;
      }
      this.processing.delete(sessionId);
      this.turnCommitted.delete(sessionId);
      this.inFlightMerged.delete(sessionId);
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
      originalMessageId: `batch-${Date.now()}-${messages.length}`,
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
  }

  /** 获取指定会话当前缓冲的消息数量（调试用） */
  getBufferSize(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }
}
