/**
 * 熔断器（Circuit Breaker）—— 三态有限状态机
 *
 * 状态流转：
 *   closed   —— 正常放行；按 1 分钟滑动窗口统计失败率
 *     │ 失败率 > 50%
 *     ▼
 *   open     —— 熔断，拒绝请求；30s 后自动转 half-open
 *     │ 30s 超时
 *     ▼
 *   half-open —— 试探态，仅放行 1 个探测请求
 *     │ 成功 → closed     失败 → open
 *
 * 与 FailoverChatProvider 集成：每个 provider 包装一个熔断器，
 * streamCompletion 前调 canExecute()，结束后调 recordSuccess/recordFailure。
 *
 * 详见 Stage 4 Task 4
 */

export type CircuitBreakerState = "closed" | "open" | "half-open";

interface WindowEntry {
  timestamp: number;
  success: boolean;
}

export interface CircuitBreakerOptions {
  /** 滑动窗口长度（ms），默认 60_000（1 分钟） */
  windowMs?: number;
  /** 熔断失败率阈值（0..1），默认 0.5（> 50% 即熔断） */
  failureRateThreshold?: number;
  /** open 态持续时间（ms），超时后转 half-open，默认 30_000（30s） */
  openTimeoutMs?: number;
  /** 获取当前时间戳的函数（便于测试注入），默认 Date.now */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  /** 最近 1 分钟的请求记录（成功/失败） */
  private readonly window: WindowEntry[] = [];
  /** 进入 open 态的时间戳 */
  private openedAt = 0;
  /** half-open 态下是否已有探测请求在途 */
  private halfOpenProbeInFlight = false;

  private readonly windowMs: number;
  private readonly failureRateThreshold: number;
  private readonly openTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.failureRateThreshold = opts.failureRateThreshold ?? DEFAULT_FAILURE_RATE_THRESHOLD;
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** 当前状态（用于日志/可观测性）。 */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * 是否允许放行请求。
   * - closed：始终放行
   * - open：超时后转 half-open 并放行首个探测请求；否则拒绝
   * - half-open：仅放行首个探测请求，其余拒绝直到探测完成
   */
  canExecute(): boolean {
    switch (this.state) {
      case "closed":
        return true;
      case "open":
        if (this.now() - this.openedAt >= this.openTimeoutMs) {
          this.state = "half-open";
          this.halfOpenProbeInFlight = false;
          // 放行首个探测请求
          this.halfOpenProbeInFlight = true;
          return true;
        }
        return false;
      case "half-open":
        if (this.halfOpenProbeInFlight) {
          return false;
        }
        this.halfOpenProbeInFlight = true;
        return true;
    }
  }

  /** 请求成功：half-open → closed；closed → 记录并继续。 */
  recordSuccess(): void {
    if (this.state === "half-open") {
      // 探测成功 → 恢复正常，清空窗口重新统计
      this.state = "closed";
      this.halfOpenProbeInFlight = false;
      this.window.length = 0;
      return;
    }
    if (this.state === "closed") {
      this.window.push({ timestamp: this.now(), success: true });
      this.pruneWindow();
    }
  }

  /** 请求失败：half-open → open；closed → 记录并按失败率判断是否熔断。 */
  recordFailure(): void {
    if (this.state === "half-open") {
      // 探测失败 → 重新熔断
      this.toOpen();
      this.halfOpenProbeInFlight = false;
      return;
    }
    if (this.state === "closed") {
      this.window.push({ timestamp: this.now(), success: false });
      this.pruneWindow();
      if (this.failureRate() > this.failureRateThreshold) {
        this.toOpen();
      }
    }
  }

  /** 进入 open 态并记录时间戳。 */
  private toOpen(): void {
    this.state = "open";
    this.openedAt = this.now();
  }

  /** 剔除滑动窗口中超过 windowMs 的过期记录。 */
  private pruneWindow(): void {
    const cutoff = this.now() - this.windowMs;
    // 从头部连续剔除过期项（按时间顺序入队，头部最旧）
    while (this.window.length > 0 && this.window[0].timestamp < cutoff) {
      this.window.shift();
    }
  }

  /** 计算当前滑动窗口内的失败率（failures / total）；窗口为空时返回 0。 */
  private failureRate(): number {
    const total = this.window.length;
    if (total === 0) return 0;
    let failures = 0;
    for (const entry of this.window) {
      if (!entry.success) failures += 1;
    }
    return failures / total;
  }
}
