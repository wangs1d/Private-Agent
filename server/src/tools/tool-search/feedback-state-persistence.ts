/**
 * 检索反馈学习状态的持久化（阶段优化③）。
 *
 * 状态内容：top-p 升档表、资源失败计数（rate_limited）、高频工具晋升计数。
 * 此前全部是进程内存——重启即失、多实例不共享。
 *
 * 策略（与跨进程边界军规一致：可降级、不阻塞）：
 *   - 配置 AGENT_REDIS_URL 时写 redis（带 TTL，fire-and-forget，任何失败静默）；
 *   - 未配置 / redis 不可用 → 纯内存（与原行为一致，功能不缺失）；
 *   - 恢复时机：模块内懒加载（首次访问时读一次），过期条目丢弃。
 */
import { createClient, type RedisClientType } from "redis";

const KEY_PREFIX = "tool-search:fb-state:";
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

let clientPromise: Promise<RedisClientType | null> | null = null;

function getClient(): Promise<RedisClientType | null> {
  if (!clientPromise) {
    const url = process.env.AGENT_REDIS_URL?.trim();
    if (!url) {
      clientPromise = Promise.resolve(null);
      return clientPromise;
    }
    clientPromise = (async () => {
      try {
        const client = createClient({ url }) as RedisClientType;
        client.on("error", () => {
          /* 静默：持久化故障不影响检索主链路 */
        });
        await client.connect();
        return client;
      } catch {
        return null;
      }
    })();
  }
  return clientPromise;
}

export async function loadFeedbackState<T>(key: string): Promise<T | null> {
  try {
    const client = await getClient();
    if (!client) return null;
    const raw = await client.get(KEY_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveFeedbackState(
  key: string,
  value: unknown,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): void {
  void (async () => {
    try {
      const client = await getClient();
      if (!client) return;
      await client.set(KEY_PREFIX + key, JSON.stringify(value), { EX: ttlSeconds });
    } catch {
      /* 静默 */
    }
  })();
}
