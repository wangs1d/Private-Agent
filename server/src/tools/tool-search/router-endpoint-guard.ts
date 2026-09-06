/**
 * tool-router 主通路端点守卫（2026-09-06）。
 *
 * 背景：backend=tool_router（默认）时每次 tool_discover 先打外部 primary
 * （HTTP FastAPI / stdio Python worker）。服务不可用时，HTTP 默认 30s 超时、
 * stdio 冷启动+60s 命令超时——降级串行等待让「召回」从毫秒级恶化到分钟级，
 * 且每次 distinct query 都重新付费（失败不进搜索缓存）。
 *
 * 三道防线（全部话题无关、进程内、零依赖）：
 *   1. 单次预算：primary 尝试超过 TOOL_ROUTER_PRIMARY_BUDGET_MS 即放弃，
 *      结果作废，立即走进程内 adaptive 冷备（不杀底层操作，只不等它）；
 *   2. 连败熔断：连续 TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN 次失败 → 冷却窗口
 *      TOOL_ROUTER_PRIMARY_COOLDOWN_MS 内直接跳过 primary（半开探测由窗口
 *      过期自然实现），避免每个新 query 都重付连接失败代价；
 *   3. stdio 禁用开关：TOOL_ROUTER_STDIO_DISABLED=1 时 HTTP 失败后不再回退
 *      Python 子进程（防 spawn 风暴；HTTP-only 部署用）。
 *
 * 预算/熔断计数只针对「主通路尝试」这一层，不影响工具执行本身。
 */

export type GuardSnapshot = {
  state: "closed" | "open";
  consecutiveFailures: number;
  openedAt: number | null;
  /** 距离半开（冷却结束）剩余毫秒；closed 时为 0。 */
  cooldownRemainingMs: number;
  totalAttempts: number;
  totalFailures: number;
  totalBudgetAborts: number;
};

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function resolvePrimaryBudgetMs(): number {
  return intEnv("TOOL_ROUTER_PRIMARY_BUDGET_MS", 1_500, 50, 120_000);
}

export function resolveFailuresToOpen(): number {
  return intEnv("TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN", 2, 1, 100);
}

export function resolveCooldownMs(): number {
  return intEnv("TOOL_ROUTER_PRIMARY_COOLDOWN_MS", 60_000, 10, 30 * 60_000);
}

/** HTTP 失败后是否允许回退 stdio Python worker（默认允许；HTTP-only 部署设 1）。 */
export function isStdioDisabled(): boolean {
  const v = (process.env.TOOL_ROUTER_STDIO_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export class RouterEndpointGuard {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private attempts = 0;
  private failures = 0;
  private budgetAborts = 0;

  /** 是否允许发起一次 primary 尝试；熔断打开时返回 false（零等待降级）。 */
  canAttempt(now = Date.now()): { allowed: boolean; reason?: string } {
    if (this.openedAt == null) return { allowed: true };
    if (now - this.openedAt >= resolveCooldownMs()) {
      // 冷却结束 → 半开：放行一次尝试（成败都会重置状态）
      this.openedAt = null;
      return { allowed: true };
    }
    return { allowed: false, reason: "tool-router primary circuit open (cooldown)" };
  }

  recordSuccess(): void {
    this.attempts += 1;
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(detail: { budgetAbort?: boolean } = {}): void {
    this.attempts += 1;
    this.failures += 1;
    if (detail.budgetAbort) this.budgetAborts += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= resolveFailuresToOpen()) {
      this.openedAt = Date.now();
    }
  }

  snapshot(now = Date.now()): GuardSnapshot {
    const cooldownRemainingMs =
      this.openedAt == null
        ? 0
        : Math.max(0, resolveCooldownMs() - (now - this.openedAt));
    return {
      state: this.openedAt == null ? "closed" : "open",
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      cooldownRemainingMs,
      totalAttempts: this.attempts,
      totalFailures: this.failures,
      totalBudgetAborts: this.budgetAborts,
    };
  }

  /** 测试用：清空判定状态（观测计数保留）。 */
  resetForTest(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }
}

/** 超预算错误（用于区分熔断计数口径）。 */
export class PrimaryBudgetExceededError extends Error {
  constructor(readonly budgetMs: number) {
    super(`tool-router primary budget exceeded: ${budgetMs}ms`);
    this.name = "PrimaryBudgetExceededError";
  }
}

/**
 * 给 primary 尝试套硬预算：超时即抛 PrimaryBudgetExceededError，
 * 底层 promise 不被取消（结果作废，由 GC 收尾），调用方立即降级。
 */
export function withPrimaryBudget<T>(op: Promise<T>, budgetMs?: number): Promise<T> {
  const budget = budgetMs ?? resolvePrimaryBudgetMs();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PrimaryBudgetExceededError(budget)),
      budget,
    );
    timer.unref?.();
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// 进程内单例；失败计数跨 query 累积（这正是熔断要的信号）。
const globalGuard = new RouterEndpointGuard();

export function getRouterEndpointGuard(): RouterEndpointGuard {
  return globalGuard;
}

/** 测试用：重置单例状态。 */
export function resetRouterEndpointGuard(): void {
  globalGuard.resetForTest();
}
