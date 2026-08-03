/**
 * LLM 响应缓存层（Phase 6.4）
 *
 * 设计目标：对确定性 LLM 调用（如情绪识别、技术扫描评估）做基于输入 hash 的缓存。
 * 对于「输入相同 → 输出必然相同」的 LLM 调用，避免重复请求模型，节省 token。
 *
 * 不缓存场景：
 *  - 信号差异大的调用（如 EndToEndDecisionMaker：每次信号上下文都不同）
 *  - 流式响应（streamCompletion）
 *  - 用户直接对话（主 Agent thread store 自然处理）
 *
 * 降级开关：BRAIN_LLM_CACHE_ENABLED=0 时全部跳过缓存（直接返回 null/未命中）。
 *
 * TTL 策略（按 namespace）：
 *  - emotion_recognition: 5 min（情绪状态短期稳定）
 *  - tech_scanner: 24 h（技术评估结果相对稳定）
 *  - 其他: 调用方自行指定
 */

/** 缓存项 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttlMs: number;
}

/** 缓存配置 */
export interface LlmCacheOptions {
  /** 命名空间（隔离不同调用方，避免 key 碰撞） */
  namespace: string;
  /** TTL（毫秒）。建议 5min~24h，过短无意义，过长数据陈旧 */
  ttlMs: number;
  /** 最大缓存条目数（默认 256）。超出按 LRU 淘汰 */
  maxSize?: number;
}

/** 是否启用 LLM 响应缓存 */
export function isLlmCacheEnabled(): boolean {
  const raw = process.env.BRAIN_LLM_CACHE_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/**
 * 简单字符串哈希（FNV-1a 变体，足够防碰撞且无依赖）
 * 不用 crypto 是因为性能考虑：缓存 key 计算每次 LLM 调用都执行。
 */
function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * LLM 响应缓存。
 *
 * 设计为 per-namespace 独立 Map，避免不同调用方的 TTL/maxSize 互相影响。
 * LRU 淘汰策略：超出 maxSize 时按 timestamp 最旧淘汰。
 *
 * 使用方式：
 *   const cache = llmResponseCache.forNamespace({ namespace: "emotion_recognition", ttlMs: 5*60_000 });
 *   const hit = cache.get(inputText);
 *   if (hit) return hit;
 *   const result = await callLlm(inputText);
 *   cache.set(inputText, result);
 */
export class LlmResponseCache {
  private readonly namespaces = new Map<string, { entries: Map<string, CacheEntry<unknown>>; ttlMs: number; maxSize: number }>();

  /**
   * 获取命名空间缓存实例（同一 namespace 复用 Map，TTL/maxSize 一致）。
   * 返回的实例有 get/set 方法。
   */
  forNamespace<T>(opts: LlmCacheOptions): {
    get(input: string): T | null;
    set(input: string, value: T): void;
    clear(): void;
    stats(): { size: number; hits: number; misses: number };
  } {
    const ns = this.namespaces.get(opts.namespace) ?? this.createNamespace(opts);
    let hits = 0;
    let misses = 0;

    return {
      get: (input: string): T | null => {
        if (!isLlmCacheEnabled()) {
          misses++;
          return null;
        }
        const key = hashKey(input);
        const entry = ns.entries.get(key);
        if (!entry) {
          misses++;
          return null;
        }
        if (Date.now() - entry.timestamp > entry.ttlMs) {
          ns.entries.delete(key);
          misses++;
          return null;
        }
        hits++;
        return entry.value as T;
      },
      set: (input: string, value: T): void => {
        if (!isLlmCacheEnabled()) return;
        const key = hashKey(input);
        // LRU 淘汰：超容时删最旧
        if (ns.entries.size >= ns.maxSize && !ns.entries.has(key)) {
          let oldestKey: string | null = null;
          let oldestTs = Number.MAX_SAFE_INTEGER;
          for (const [k, e] of ns.entries) {
            if (e.timestamp < oldestTs) {
              oldestTs = e.timestamp;
              oldestKey = k;
            }
          }
          if (oldestKey) ns.entries.delete(oldestKey);
        }
        ns.entries.set(key, {
          value,
          timestamp: Date.now(),
          ttlMs: ns.ttlMs,
        });
      },
      clear: () => {
        ns.entries.clear();
        hits = 0;
        misses = 0;
      },
      stats: () => ({
        size: ns.entries.size,
        hits,
        misses,
      }),
    };
  }

  private createNamespace(opts: LlmCacheOptions) {
    const ns = {
      entries: new Map<string, CacheEntry<unknown>>(),
      ttlMs: opts.ttlMs,
      maxSize: opts.maxSize ?? 256,
    };
    this.namespaces.set(opts.namespace, ns);
    return ns;
  }

  /** 清空所有命名空间的缓存（测试用） */
  clearAll(): void {
    for (const ns of this.namespaces.values()) {
      ns.entries.clear();
    }
  }
}

/** 单例（全局共享，避免每个调用方各自 new 一个） */
let globalCache: LlmResponseCache | null = null;

export function getLlmResponseCache(): LlmResponseCache {
  if (!globalCache) {
    globalCache = new LlmResponseCache();
  }
  return globalCache;
}
