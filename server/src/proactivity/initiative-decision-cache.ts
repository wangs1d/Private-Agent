// ProactivityHub —— 负向决策缓存（InitiativeDecisionCache）
//
// 省 token 关键件：LLM 通用路径对同一观察模式（指纹相同）反复判 none 时，
// TTL 内直接跳过 LLM 调用——重复场景重复问，答案大概率还是 none。
//
// 护栏（不影响质量）：
//  - 仅缓存 none 决策与「判主动但被抑制/频控拦截」（主动决策的防重复由
//    FrequencyGovernor 分 kind 冷却负责）
//  - 当前窗口含 high 显著性观察时永不跳过（重要事件必须真评估）
//  - TTL 过期自动失效（默认 6h）；条数上限滚动淘汰
import type { Observation } from "./proactivity-types.js";
import { fingerprintText } from "./semantic-trigger-matcher.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;

type CacheEntry = { fingerprint: string; decidedAt: number };

export class InitiativeDecisionCache {
  private readonly actors = new Map<string, Map<string, CacheEntry>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * 观察窗口指纹：类型+内容全并入词法特征集合（顺序无关）。
   * 内容相同的一组观察 → 指纹相同（时间戳不参与，只看"发生了什么"）。
   */
  fingerprintObservations(observations: Observation[]): string {
    const combined = observations
      .map((o) => `${o.type}:${o.content}`)
      .join("\n");
    return fingerprintText(combined);
  }

  /** 当前窗口是否可直接跳过 LLM 评估（近期同指纹已判 none 且无高显著观察） */
  shouldSkip(actorId: string, fingerprint: string, hasHighSalience: boolean): boolean {
    if (hasHighSalience) return false;
    const entry = this.actors.get(actorId)?.get(fingerprint);
    if (!entry) return false;
    return Date.now() - entry.decidedAt < this.ttlMs;
  }

  /** 记录一次 none 决策（后续同指纹窗口 TTL 内免 LLM） */
  recordNone(actorId: string, fingerprint: string): void {
    let map = this.actors.get(actorId);
    if (!map) {
      map = new Map();
      this.actors.set(actorId, map);
    }
    map.set(fingerprint, { fingerprint, decidedAt: Date.now() });
    // 滚动淘汰最旧（Map 保插入序，首个 key 即最旧）
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * 记录一次「LLM 判主动但被抑制/频控拦截」（后续同指纹窗口 TTL 内免 LLM——
   * 同样的观察喂给 LLM 大概率还是同样的决策、同样的拦截）。
   * 与 recordNone 共用存储；高显著观察仍不跳过（shouldSkip 护栏不变）。
   */
  recordBlocked(actorId: string, fingerprint: string): void {
    this.recordNone(actorId, fingerprint);
  }

  /** 条数（诊断/测试） */
  size(actorId: string): number {
    return this.actors.get(actorId)?.size ?? 0;
  }

  /** 清空（测试） */
  clear(): void {
    this.actors.clear();
  }
}
