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
  /** 等待新消息的时间窗口（毫秒），默认 1200ms */
  debounceMs: number;
  /** 最大等待时间（毫秒），即使还在收到消息也会强制处理，默认 5000ms */
  maxWaitMs: number;
  /** 是否启用批处理，默认 true */
  enabled: boolean;
};

const DEFAULT_CONFIG: MessageBatchProcessorConfig = {
  debounceMs: 1200,
  maxWaitMs: 5000,
  enabled: true,
};

/**
 * 消息批处理器：将用户连续发送的多条消息合并为一条后再处理。
 *
 * 核心机制：
 * - 收到消息后不立即处理，而是放入缓冲区
 * - 启动防抖计时器（debounceMs），期间新消息会重置计时器
 * - 计时器到期后将缓冲区中所有消息合并处理
 * - 超过最大等待时间（maxWaitMs）强制处理，避免用户长时间等待
 * - 若当前会话正在生成回复，新消息继续缓冲，待本轮结束后再合并处理
 */
export class MessageBatchProcessor {
  private buffers = new Map<string, BatchedMessage[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onReadyHandlers = new Map<string, (merged: BatchedMessage) => Promise<void>>();
  private processing = new Set<string>();
  private config: MessageBatchProcessorConfig;

  constructor(config?: Partial<MessageBatchProcessorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 提交一条用户消息到批处理器。
   * 若仍在防抖窗口内会缓冲；若当前会话正在回复则继续缓冲，待本轮结束后再合并触发。
   */
  submit(
    sessionId: string,
    message: Omit<BatchedMessage, "timestamp">,
    onReady: (merged: BatchedMessage) => Promise<void>,
  ): void {
    this.onReadyHandlers.set(sessionId, onReady);

    if (!this.config.enabled) {
      void this.invokeReady(sessionId, { ...message, timestamp: Date.now() } as BatchedMessage);
      return;
    }

    const now = Date.now();
    const buffered: BatchedMessage = { ...message, timestamp: now };

    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, []);
    }
    this.buffers.get(sessionId)!.push(buffered);

    if (this.processing.has(sessionId)) {
      return;
    }

    this.resetDebounceTimer(sessionId);
    this.ensureMaxWaitTimer(sessionId);
  }

  private resetDebounceTimer(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.flush(sessionId);
    }, this.config.debounceMs);

    this.timers.set(sessionId, timer);
  }

  private ensureMaxWaitTimer(sessionId: string): void {
    if (this.maxWaitTimers.has(sessionId)) return;

    const messages = this.buffers.get(sessionId);
    if (!messages?.length) return;

    const firstMsgTime = messages[0].timestamp;
    const elapsed = Date.now() - firstMsgTime;
    const remaining = Math.max(0, this.config.maxWaitMs - elapsed);

    const timer = setTimeout(() => {
      this.flush(sessionId);
    }, remaining);

    this.maxWaitTimers.set(sessionId, timer);
  }

  private flush(sessionId: string): void {
    if (this.processing.has(sessionId)) return;

    const messages = this.buffers.get(sessionId);
    if (!messages || messages.length === 0) return;

    this.clearTimers(sessionId);
    this.buffers.delete(sessionId);

    const merged = this.mergeMessages(messages);
    void this.invokeReady(sessionId, merged);
  }

  private invokeReady(sessionId: string, merged: BatchedMessage): void {
    const onReady = this.onReadyHandlers.get(sessionId);
    if (!onReady) return;

    this.processing.add(sessionId);
    void Promise.resolve(onReady(merged)).finally(() => {
      this.processing.delete(sessionId);
      if ((this.buffers.get(sessionId)?.length ?? 0) > 0) {
        this.resetDebounceTimer(sessionId);
        this.ensureMaxWaitTimer(sessionId);
      }
    });
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

  private clearTimers(sessionId: string): void {
    const debounce = this.timers.get(sessionId);
    if (debounce) {
      clearTimeout(debounce);
      this.timers.delete(sessionId);
    }

    const maxWait = this.maxWaitTimers.get(sessionId);
    if (maxWait) {
      clearTimeout(maxWait);
      this.maxWaitTimers.delete(sessionId);
    }
  }

  /**
   * 强制刷新指定会话的所有缓冲消息（用于断开连接等场景）
   */
  forceFlush(
    sessionId: string,
    onReady?: (merged: BatchedMessage) => Promise<void>,
  ): void {
    if (onReady) {
      this.onReadyHandlers.set(sessionId, onReady);
    }
    if (this.processing.has(sessionId)) {
      return;
    }
    this.flush(sessionId);
  }

  /**
   * 清理资源（服务关闭时调用）
   */
  dispose(): void {
    for (const sessionId of this.timers.keys()) {
      this.clearTimers(sessionId);
    }
    this.buffers.clear();
    this.onReadyHandlers.clear();
    this.processing.clear();
  }

  /** 获取指定会话当前缓冲的消息数量（调试用） */
  getBufferSize(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }
}
