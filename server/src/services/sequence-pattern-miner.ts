/**
 * 事件序列模式挖掘器（Phase 3.1）
 *
 * 设计原则：
 * - 纯算法挖掘（简化版 PrefixSpan），无 LLM 调用
 * - 从 LifeSignalHubService 历史挖掘长度 2-4 的事件序列模式
 * - 支持时间窗口约束（如 A 后 30min 内出现 B）
 * - BrainStem 45s 心跳时每 10min 重新挖掘（缓存）
 *
 * 输出 Pattern，供 PredictiveActionSynthesizer 合成 predicted_action 信号
 */

import type { LifeSignal } from "./life-signal-types.js";

/** 挖掘出的序列模式 */
export interface Pattern {
  /** 事件序列（kind 列表），如 ["desktop_app_focus", "sustained_busy"] */
  sequence: string[];
  /** 支持度：模式在历史中出现的次数 */
  support: number;
  /** 置信度：前缀出现时，后续出现的概率 */
  confidence: number;
  /** 平均间隔毫秒（序列中相邻事件的平均时间差） */
  avgIntervalMs: number;
  /** 最后一次出现时间 */
  lastSeenAt: Date;
}

/** LifeSignalHubService 的最小依赖接口 */
export interface SignalHistoryProvider {
  recentSignals(actorId: string, limit?: number): LifeSignal[];
}

/** 挖掘参数 */
export interface MiningOptions {
  /** 最小支持度（默认 2） */
  minSupport?: number;
  /** 最小置信度（默认 0.5） */
  minConfidence?: number;
  /** 最大序列长度（默认 4） */
  maxLength?: number;
  /** 最大时间窗口毫秒（默认 60min，序列中相邻事件的最大间隔） */
  maxIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<MiningOptions> = {
  minSupport: 2,
  minConfidence: 0.5,
  maxLength: 4,
  maxIntervalMs: 60 * 60 * 1000,
};

/** 缓存条目 */
interface CacheEntry {
  patterns: Pattern[];
  timestamp: number;
  signalCount: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 序列模式挖掘器
 *
 * 简化版 PrefixSpan 算法：
 * 1. 从信号历史中提取事件序列（kind 序列，按 occurredAt 排序）
 * 2. 生成所有长度 2-maxLength 的候选序列
 * 3. 统计支持度、置信度、平均间隔
 * 4. 过滤低支持度/低置信度的模式
 */
export class SequencePatternMiner {
  private readonly provider: SignalHistoryProvider;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(provider: SignalHistoryProvider) {
    this.provider = provider;
  }

  /**
   * 挖掘指定 actor 的序列模式
   * @param actorId 用户 ID
   * @param opts 挖掘参数
   */
  mine(actorId: string, opts?: MiningOptions): Pattern[] {
    const options = { ...DEFAULT_OPTIONS, ...opts };

    // 缓存命中检查
    const signals = this.provider.recentSignals(actorId, 100);
    if (signals.length === 0) return [];

    const cacheKey = actorId;
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.timestamp < CACHE_TTL_MS &&
      cached.signalCount === signals.length
    ) {
      return cached.patterns;
    }

    // 按时间排序，提取 kind 序列
    const sorted = [...signals].sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );

    // 构建事件序列（带时间戳）
    const events = sorted.map((s) => ({
      kind: s.kind,
      timestamp: Date.parse(s.occurredAt),
    }));

    // 按时间窗口分段（相邻事件间隔 > maxIntervalMs → 新段）
    const segments: Array<Array<{ kind: string; timestamp: number }>> = [];
    let currentSegment: Array<{ kind: string; timestamp: number }> = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (currentSegment.length === 0) {
        currentSegment.push(ev);
      } else {
        const prev = currentSegment[currentSegment.length - 1]!;
        if (ev.timestamp - prev.timestamp > options.maxIntervalMs) {
          if (currentSegment.length >= 2) segments.push(currentSegment);
          currentSegment = [ev];
        } else {
          currentSegment.push(ev);
        }
      }
    }
    if (currentSegment.length >= 2) segments.push(currentSegment);

    // 挖掘所有候选序列
    const candidates = this.generateCandidates(segments, options.maxLength);

    // 统计支持度、置信度、间隔
    const patterns: Pattern[] = [];
    for (const candidate of candidates) {
      const stats = this.computeStats(segments, candidate);
      if (
        stats.support >= options.minSupport &&
        stats.confidence >= options.minConfidence
      ) {
        patterns.push({
          sequence: candidate,
          support: stats.support,
          confidence: stats.confidence,
          avgIntervalMs: stats.avgIntervalMs,
          lastSeenAt: stats.lastSeenAt,
        });
      }
    }

    // 按支持度降序排序，取前 20 个
    patterns.sort((a, b) => b.support - a.support || b.confidence - a.confidence);
    const topPatterns = patterns.slice(0, 20);

    // 更新缓存
    this.cache.set(cacheKey, {
      patterns: topPatterns,
      timestamp: Date.now(),
      signalCount: signals.length,
    });

    return topPatterns;
  }

  // ---- 内部算法 ----

  /**
   * 生成候选序列
   * 从所有段中提取长度 2-maxLength 的子序列
   */
  private generateCandidates(
    segments: Array<Array<{ kind: string; timestamp: number }>>,
    maxLength: number,
  ): string[][] {
    const candidateSet = new Set<string>();

    for (const segment of segments) {
      for (let len = 2; len <= maxLength && len <= segment.length; len++) {
        for (let start = 0; start <= segment.length - len; start++) {
          const subSeq = segment.slice(start, start + len).map((e) => e.kind);
          // 去重相邻相同 kind
          const deduped: string[] = [];
          for (const k of subSeq) {
            if (deduped.length === 0 || deduped[deduped.length - 1] !== k) {
              deduped.push(k);
            }
          }
          if (deduped.length >= 2) {
            candidateSet.add(JSON.stringify(deduped));
          }
        }
      }
    }

    return [...candidateSet].map((s) => JSON.parse(s) as string[]);
  }

  /**
   * 计算候选序列的统计信息
   */
  private computeStats(
    segments: Array<Array<{ kind: string; timestamp: number }>>,
    candidate: string[],
  ): {
    support: number;
    confidence: number;
    avgIntervalMs: number;
    lastSeenAt: Date;
  } {
    let matchCount = 0;
    let prefixCount = 0;
    let totalIntervalMs = 0;
    let intervalCount = 0;
    let lastSeenTs = 0;

    const prefix = candidate.slice(0, -1);
    const fullSeq = candidate;

    for (const segment of segments) {
      // 在段中查找前缀出现次数
      for (let i = 0; i <= segment.length - prefix.length; i++) {
        if (this.matchesAt(segment, i, prefix)) {
          prefixCount++;
          // 检查完整序列是否匹配
          if (i + fullSeq.length <= segment.length && this.matchesAt(segment, i, fullSeq)) {
            matchCount++;
            // 计算间隔
            const startTs = segment[i]!.timestamp;
            const endTs = segment[i + fullSeq.length - 1]!.timestamp;
            totalIntervalMs += endTs - startTs;
            intervalCount++;
            if (endTs > lastSeenTs) lastSeenTs = endTs;
          }
        }
      }
    }

    const confidence = prefixCount > 0 ? matchCount / prefixCount : 0;
    const avgIntervalMs = intervalCount > 0 ? Math.round(totalIntervalMs / intervalCount) : 0;

    return {
      support: matchCount,
      confidence,
      avgIntervalMs,
      lastSeenAt: new Date(lastSeenTs || Date.now()),
    };
  }

  /** 检查段中指定位置是否匹配候选序列 */
  private matchesAt(
    segment: Array<{ kind: string; timestamp: number }>,
    start: number,
    candidate: string[],
  ): boolean {
    if (start + candidate.length > segment.length) return false;
    for (let i = 0; i < candidate.length; i++) {
      if (segment[start + i]!.kind !== candidate[i]) return false;
    }
    return true;
  }

  /** 清除指定 actor 的缓存 */
  clearCache(actorId?: string): void {
    if (actorId) {
      this.cache.delete(actorId);
    } else {
      this.cache.clear();
    }
  }
}
