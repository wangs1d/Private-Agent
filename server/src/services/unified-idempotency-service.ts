type CachedResult = Record<string, unknown>;

type CacheEntry = {
  expiresAt: number;
  result: CachedResult;
};

/**
 * 统一协议幂等缓存（MVP）：按 actor + action + requestId 缓存结果，防止重试重复执行写操作。
 */
export class UnifiedIdempotencyService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor() {
    const raw = process.env.UNIFIED_IDEMPOTENCY_TTL_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
  }

  private key(actorId: string, action: string, requestId: string): string {
    return `${actorId}::${action}::${requestId}`;
  }

  private sweepExpired(now = Date.now()): void {
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
  }

  get(actorId: string, action: string, requestId?: string): CachedResult | null {
    if (!requestId?.trim()) return null;
    const now = Date.now();
    this.sweepExpired(now);
    const entry = this.cache.get(this.key(actorId, action, requestId.trim()));
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.cache.delete(this.key(actorId, action, requestId.trim()));
      return null;
    }
    return { ...entry.result };
  }

  set(actorId: string, action: string, requestId: string | undefined, result: CachedResult): void {
    if (!requestId?.trim()) return;
    const id = requestId.trim();
    this.cache.set(this.key(actorId, action, id), {
      expiresAt: Date.now() + this.ttlMs,
      result: { ...result },
    });
  }
}
