/**
 * 记忆仲裁器（Memory Arbitrator）
 *
 * 解决三层记忆通道（agentic / humanLike / narrative / kvSummary）并行召回后的统一融合问题：
 * - 现状：MemoryCortex.recall 默认路径是降级链（agentic → narrative → kvSummary），
 *   同一时刻只有一条通道结果被使用，无法跨通道综合排序；且 agentic 的 8 条结构化记忆
 *   被拍平为单条 item，score 信息丢失。
 * - 本模块：对多通道召回结果做「通道内 score 归一化 → 跨通道指纹去重 → 通道权重 ×
 *   多通道命中加成综合重排」，输出统一排序后的 MemoryRecallItem[]。
 *
 * 设计要点：
 * 1) 通道内归一化用 min-max 映射到 [0.2, 1.0]，保留 0.2 下限避免归一化后为 0 被丢弃；
 *    score 缺失时赋默认 0.5（KV 通道无分数，靠此兜底）。
 * 2) 跨通道去重用 semanticFingerprint（来自 memory-record-utils），同指纹合并为一条，
 *    保留 score 最高者为代表，记录所有命中通道。
 * 3) 综合分数 = Σ(通道权重 × 归一化分) / Σ权重 × (1 + multiChannelBoost × (命中通道数-1))。
 *    多通道一致命中是强信号，给予加成。
 * 4) 仲裁器是无状态纯函数，可独立测试；关闭时回退为简单拼接（向后兼容）。
 */

import type { MemoryRecallItem } from "./types.js";
import { semanticFingerprint } from "../services/memory-record-utils.js";

export type MemoryChannelId =
  | "agentic"
  | "humanLike"
  | "narrative"
  | "kvSummary"
  | "forgotten"
  | "relationship"
  | "association"
  | "experienceLearning";

/** 单个通道的召回结果（条目已带 source 与可选 score）。 */
export interface ChannelRecallResult {
  channel: MemoryChannelId;
  items: MemoryRecallItem[];
}

export interface MemoryArbitratorConfig {
  enabled: boolean;
  /** 各通道权重，缺失通道按 0.3 兜底。 */
  channelWeights: Partial<Record<MemoryChannelId, number>>;
  /** 最终返回条目数上限。 */
  topN: number;
  /** 每多命中一个通道的加成系数（0.15 = +15%）。 */
  multiChannelBoost: number;
  /** 最终分数低于此值的条目丢弃。 */
  minScoreThreshold: number;
  /** score 缺失时的默认归一化前分值。 */
  defaultScoreWhenMissing: number;
}

export const DEFAULT_ARBITRATOR_CONFIG: MemoryArbitratorConfig = {
  enabled: true,
  channelWeights: {
    agentic: 0.45,
    humanLike: 0.4,
    narrative: 0.35,
    kvSummary: 0.2,
    forgotten: 0.15,
    relationship: 0.25,
    association: 0.32,
    experienceLearning: 0.3,
  },
  topN: 8,
  multiChannelBoost: 0.15,
  minScoreThreshold: 0.1,
  defaultScoreWhenMissing: 0.5,
};

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 从环境变量加载仲裁器配置（未设置时保留默认值）。 */
export function loadArbitratorConfigFromEnv(
  base: MemoryArbitratorConfig = DEFAULT_ARBITRATOR_CONFIG,
): MemoryArbitratorConfig {
  const enabledRaw = process.env.MEMORY_ARBITRATOR_ENABLED;
  const enabled =
    enabledRaw === undefined
      ? base.enabled
      : !(enabledRaw === "0" || enabledRaw.toLowerCase() === "false");

  const channelWeights = { ...base.channelWeights };
  const envKeys: MemoryChannelId[] = [
    "agentic",
    "humanLike",
    "narrative",
    "kvSummary",
    "forgotten",
    "relationship",
    "association",
    "experienceLearning",
  ];
  for (const key of envKeys) {
    const envKey = `MEMORY_ARBITRATOR_${key.toUpperCase()}_WEIGHT`;
    const v = process.env[envKey];
    if (v) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) channelWeights[key] = n;
    }
  }

  return {
    enabled,
    channelWeights,
    topN: parseIntEnv(process.env.MEMORY_ARBITRATOR_TOP_N, base.topN),
    multiChannelBoost: parseFloatEnv(
      process.env.MEMORY_ARBITRATOR_MULTI_CHANNEL_BOOST,
      base.multiChannelBoost,
    ),
    minScoreThreshold: parseFloatEnv(
      process.env.MEMORY_ARBITRATOR_MIN_SCORE,
      base.minScoreThreshold,
    ),
    defaultScoreWhenMissing: base.defaultScoreWhenMissing,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 通道内 score 归一化：min-max 映射到 [0.2, 1.0]。
 * - 缺失 score 赋 defaultScore。
 * - 所有分值相同（range≈0）时直接 clamp 当前分值，避免除零。
 * - 保留 0.2 下限：防止归一化后最低分为 0 而被 minScoreThreshold 丢弃。
 */
function normalizeChannelScores(
  items: MemoryRecallItem[],
  defaultScore: number,
): Array<MemoryRecallItem & { normalizedScore: number }> {
  const withRaw = items.map((it) => {
    const raw =
      typeof it.score === "number" && Number.isFinite(it.score) ? it.score : defaultScore;
    return { item: it, raw };
  });
  if (withRaw.length === 0) return [];

  const rawVals = withRaw.map((s) => s.raw);
  const min = Math.min(...rawVals);
  const max = Math.max(...rawVals);
  const range = max - min;

  return withRaw.map((s) => {
    const normalized =
      range > 0.001 ? 0.2 + 0.8 * ((s.raw - min) / range) : clamp01(s.raw);
    return { ...s.item, normalizedScore: Math.max(0.2, Math.min(1, normalized)) };
  });
}

interface MergedEntry {
  /** 代表条目（多通道命中时取 score 最高者）。 */
  representative: MemoryRecallItem;
  /** 命中的所有通道。 */
  channels: Set<MemoryChannelId>;
  /** 各通道的归一化分（取该通道内最高）。 */
  normalizedScores: Map<MemoryChannelId, number>;
  fingerprint: string;
}

/**
 * 跨通道去重：按 semanticFingerprint 分组，同指纹合并为一条 MergedEntry。
 * - 代表条目取归一化分最高者（保留其 content/domain/source 等元信息）。
 * - 记录所有命中通道与各自最高归一化分，供后续综合打分。
 */
function dedupeAcrossChannels(channels: ChannelRecallResult[]): MergedEntry[] {
  const byFp = new Map<string, MergedEntry>();

  for (const ch of channels) {
    const normalized = normalizeChannelScores(ch.items, 0.5);
    for (const item of normalized) {
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) continue;
      const fp = semanticFingerprint(content) || content.slice(0, 48);
      const normScore = item.normalizedScore;

      const existing = byFp.get(fp);
      if (!existing) {
        byFp.set(fp, {
          representative: { ...item, score: normScore },
          channels: new Set<MemoryChannelId>([ch.channel]),
          normalizedScores: new Map([[ch.channel, normScore]]),
          fingerprint: fp,
        });
      } else {
        existing.channels.add(ch.channel);
        const existingScore = existing.representative.score ?? 0;
        if (normScore > existingScore) {
          // 更新代表（保留更高分的 content，但合并 source 信息）
          existing.representative = {
            ...item,
            score: normScore,
            source: mergeSource(existing.representative.source, ch.channel),
          };
        }
        // 累积该通道最高分
        const prev = existing.normalizedScores.get(ch.channel) ?? 0;
        if (normScore > prev) existing.normalizedScores.set(ch.channel, normScore);
      }
    }
  }

  return [...byFp.values()];
}

function mergeSource(existing: string | undefined, channel: MemoryChannelId): string {
  const set = new Set<string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  set.add(channel);
  return [...set].join(",");
}

/**
 * 综合打分：通道权重加权平均 × 多通道命中加成。
 * - baseScore = Σ(权重 × 归一化分) / Σ权重
 * - boost = 1 + multiChannelBoost × (命中通道数 - 1)
 * - 多通道一致命中是强信号，boost 放大其最终分。
 */
function computeFinalScore(entry: MergedEntry, config: MemoryArbitratorConfig): number {
  const hitChannels = entry.channels.size;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [channel, normScore] of entry.normalizedScores) {
    const w = config.channelWeights[channel] ?? 0.3;
    weightedSum += w * normScore;
    weightTotal += w;
  }
  const baseScore = weightTotal > 0 ? weightedSum / weightTotal : 0.5;
  const boost = 1 + config.multiChannelBoost * Math.max(0, hitChannels - 1);
  return baseScore * boost;
}

/**
 * 主仲裁入口：多通道召回结果 → 通道内归一化 → 跨通道去重 → 综合重排。
 *
 * @param channels 各通道的召回结果（条目可带可不带 score）
 * @param config 仲裁配置；未传用默认配置
 * @returns 去重 + 重排后的 MemoryRecallItem[]，每条带融合 score 与合并后的 source
 */
export function arbitrateMemories(
  channels: ChannelRecallResult[],
  config: MemoryArbitratorConfig = DEFAULT_ARBITRATOR_CONFIG,
): MemoryRecallItem[] {
  if (!config.enabled) {
    // 关闭时简单拼接所有通道（保持向后兼容），不做去重/排序
    const all: MemoryRecallItem[] = [];
    for (const ch of channels) {
      for (const it of ch.items) {
        if (it.content && it.content.trim()) all.push(it);
      }
    }
    return all.slice(0, config.topN);
  }

  const merged = dedupeAcrossChannels(channels);
  const scored = merged
    .map((entry) => {
      const finalScore = computeFinalScore(entry, config);
      const sources = [...entry.channels].join(",");
      // tiebreaker：命中通道中的最高权重（同分时高权重通道优先，体现通道可信度）
      const maxChannelWeight = Math.max(
        ...[...entry.channels].map((ch) => config.channelWeights[ch] ?? 0.3),
      );
      return {
        item: {
          ...entry.representative,
          score: Number(finalScore.toFixed(4)),
          source: sources,
        } as MemoryRecallItem,
        finalScore,
        maxChannelWeight,
      };
    })
    .filter((s) => s.finalScore >= config.minScoreThreshold)
    .sort((a, b) => {
      // 主排序：综合分数降序
      if (Math.abs(b.finalScore - a.finalScore) > 0.0001) return b.finalScore - a.finalScore;
      // 同分 tiebreaker：高权重通道优先（agentic > narrative > kvSummary）
      return b.maxChannelWeight - a.maxChannelWeight;
    });

  return scored.slice(0, config.topN).map((s) => s.item);
}

/**
 * 短路判断：agentic 主通道是否已足够充分，无需触发并行仲裁。
 * - 条目数 ≥ minCount 且 top1 score ≥ minTopScore 时短路（低延迟路径）。
 * - 用于 MemoryCortex.recall 默认路径：大多数场景 agentic 充足，避免无谓并行。
 */
export function shouldShortCircuitAgentic(
  agenticItems: MemoryRecallItem[],
  opts: { minCount: number; minTopScore: number },
): boolean {
  if (agenticItems.length < opts.minCount) return false;
  const topScore = agenticItems[0]?.score ?? 0;
  return topScore >= opts.minTopScore;
}
