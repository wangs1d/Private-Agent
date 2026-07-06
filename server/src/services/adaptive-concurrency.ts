/**
 * 自适应并发控制器：基于 AIMD（Additive Increase / Multiplicative Decrease）算法
 * 动态调整全局 turn 并发上限。
 *
 * 原理（类似 TCP 拥塞控制）：
 *   - 每次成功完成一个 turn：线性增加 concurrency（+1，直到 maxLimit）
 *   - 每次失败/超时/429 的 turn：乘性减少 concurrency（×0.5，直到 minLimit）
 *   - 每次慢完成（> slowThresholdMs）：乘性减少（×0.7，比失败温和）
 *
 * 与 Phase 1 的静态 Semaphore 区别：
 *   - Phase 1：max 固定 8，不区分正常/异常
 *   - Phase 2：max 根据 LLM API 健康度动态浮动 [2, 16]
 *
 * 集成方式：
 *   - globalTurnLimiter 的 max 变成动态值
 *   - turn 完成后调 recordSuccess/recordFailure/recordSlow
 *   - Semaphore.acquire 前先调 getCurrentLimit 刷新 max
 */

function envPosInt(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_LIMIT = envPosInt("ADAPTIVE_CONCURRENCY_MIN", 2);
const MAX_LIMIT = envPosInt("ADAPTIVE_CONCURRENCY_MAX", 16);
/** 慢 turn 阈值（毫秒）：超过此值视为"慢"，温和降并发。 */
const SLOW_THRESHOLD_MS = envPosInt("ADAPTIVE_CONCURRENCY_SLOW_MS", 15_000);
/** AI 周期（毫秒）：每这么久至少 +1，防止长期卡在低值。 */
const PROBE_INTERVAL_MS = envPosInt("ADAPTIVE_CONCURRENCY_PROBE_MS", 10_000);

export class AdaptiveConcurrency {
  private currentLimit: number;
  private lastAdjustAt: number;
  private lastProbeAt: number;
  /** 滑动窗口：最近 50 个 turn 的完成时间。 */
  private readonly recentLatencies: number[] = [];
  private static readonly WINDOW_SIZE = 50;

  constructor() {
    this.currentLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, envPosInt("MAX_CONCURRENT_TURNS", 8)));
    this.lastAdjustAt = Date.now();
    this.lastProbeAt = Date.now();
  }

  /** 获取当前并发上限。 */
  get limit(): number {
    return this.currentLimit;
  }

  /** 获取最小/最大边界。 */
  get minLimit(): number {
    return MIN_LIMIT;
  }

  get maxLimit(): number {
    return MAX_LIMIT;
  }

  /** 记录一个 turn 成功完成。 */
  recordSuccess(durationMs: number): void {
    this.recentLatencies.push(durationMs);
    if (this.recentLatencies.length > AdaptiveConcurrency.WINDOW_SIZE) {
      this.recentLatencies.shift();
    }

    const now = Date.now();

    // 慢完成：温和降并发（×0.7）
    if (durationMs > SLOW_THRESHOLD_MS) {
      this.decrease(0.7, `slow(${durationMs}ms)`);
      return;
    }

    // 正常完成：线性增 +1（受 probe 周期限制，防止突增）
    if (now - this.lastProbeAt >= PROBE_INTERVAL_MS && this.currentLimit < MAX_LIMIT) {
      this.currentLimit = Math.min(MAX_LIMIT, this.currentLimit + 1);
      this.lastProbeAt = now;
    }
  }

  /** 记录一个 turn 失败（超时/错误/429）。 */
  recordFailure(reason: string): void {
    this.decrease(0.5, reason);
  }

  /** 获取最近延迟统计（供监控用）。 */
  getLatencyStats(): { p50: number; p95: number; avg: number; count: number } {
    if (this.recentLatencies.length === 0) {
      return { p50: 0, p95: 0, avg: 0, count: 0 };
    }
    const sorted = [...this.recentLatencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { p50, p95, avg, count: sorted.length };
  }

  private decrease(factor: number, reason: string): void {
    const old = this.currentLimit;
    this.currentLimit = Math.max(MIN_LIMIT, Math.floor(this.currentLimit * factor));
    this.lastAdjustAt = Date.now();
    if (old !== this.currentLimit) {
      console.warn(
        `[adaptive-concurrency] ${old} → ${this.currentLimit} ` +
          `(reason: ${reason}, factor: ${factor})`,
      );
    }
  }
}

// 全局单例
export const adaptiveConcurrency = new AdaptiveConcurrency();
