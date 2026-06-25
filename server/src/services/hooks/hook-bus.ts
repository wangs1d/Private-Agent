/**
 * Hook 总线 — 进程内 Pub/Sub
 *
 * 设计目标：让"业务代码 → webhook 外推"成为一条单向、解耦的事件流。
 *
 * 关键不变量：
 * 1. 业务代码只 emit hook，不直接调用 WebhookService
 * 2. WebhookService 在 start() 时订阅本总线，自动接收所有 hook
 * 3. 任何想要"接入 hook 流"的下游（审计、统计、实时面板…）都通过 subscribe 接入
 *
 * 性能/可靠性保证：
 * - emit() 不抛异常：单个订阅者异常不会阻断其他订阅者
 * - 订阅者异步执行：emit 立即返回，不等待订阅者
 * - 环形缓冲：history 自动按 maxHistory 上限截断
 */
import { randomUUID } from "node:crypto";
import type {
  HookEmitOptions,
  HookEvent,
  HookEventType,
  HookHandler,
} from "./hook-types.js";

export class HookBus {
  private readonly listeners = new Set<HookHandler>();
  private readonly typedListeners = new Map<HookEventType, Set<HookHandler>>();
  private readonly history: HookEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = Math.max(1, maxHistory);
  }

  // ─── 发射 ───

  /**
   * 发射一个 hook。
   * 业务代码统一入口。
   *
   * @example
   *   hookBus.emit("agent.task_completed", { taskId: "t-001" });
   *   hookBus.emit("market.anomaly", { symbol: "AAPL", changePct: 5.2 }, { actorId: "u-1" });
   */
  emit(
    type: HookEventType,
    data: Record<string, unknown>,
    opts?: HookEmitOptions,
  ): HookEvent {
    const event: HookEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      actorId: opts?.actorId,
      source: opts?.source,
      data,
      metadata: {
        ...(opts?.source && { source: opts.source }),
        ...(opts?.version && { version: opts.version }),
      },
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // 1) 全局订阅者
    this.dispatchSafely(this.listeners, event, "global");
    // 2) 类型订阅者
    const typed = this.typedListeners.get(type);
    if (typed && typed.size > 0) {
      this.dispatchSafely(typed, event, type);
    }

    return event;
  }

  // ─── 订阅 ───

  /** 订阅全量 hook，返回取消订阅函数 */
  subscribe(handler: HookHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** 订阅指定类型的 hook，返回取消订阅函数 */
  subscribeType(type: HookEventType, handler: HookHandler): () => void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.typedListeners.delete(type);
    };
  }

  // ─── 查询 ───

  /** 最近事件历史（环形缓冲） */
  recentEvents(limit = 50, typeFilter?: HookEventType): HookEvent[] {
    let slice = [...this.history];
    if (typeFilter) {
      slice = slice.filter((e) => e.type === typeFilter);
    }
    return slice.slice(-limit);
  }

  /** 当前历史条数 */
  get historySize(): number {
    return this.history.length;
  }

  /** 当前已注册订阅者数量（用于观测/健康检查） */
  getStats(): {
    globalListeners: number;
    typedListeners: number;
    historySize: number;
    typedBreakdown: Record<string, number>;
  } {
    const typedBreakdown: Record<string, number> = {};
    for (const [type, set] of this.typedListeners) {
      typedBreakdown[type] = set.size;
    }
    return {
      globalListeners: this.listeners.size,
      typedListeners: this.typedListeners.size,
      historySize: this.history.length,
      typedBreakdown,
    };
  }

  /** 清空历史（仅测试/管理用） */
  clearHistory(): void {
    this.history.length = 0;
  }

  // ─── 内部 ───

  private dispatchSafely(
    handlers: Iterable<HookHandler>,
    event: HookEvent,
    label: string,
  ): void {
    for (const handler of handlers) {
      void Promise.resolve(handler(event)).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[HookBus] ${label} listener error (${event.type}):`, msg);
      });
    }
  }
}
