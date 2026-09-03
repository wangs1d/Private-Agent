import type { FocusDimensionState, FocusPeakBlock, RhythmDimensionModel, RhythmObservation } from "../types.js";

/** 每次分析对历史直方图做的衰减（≈一周不活跃后旧分布权重剩 ~28%） */
const DECAY_PER_RUN = 0.94;
const STRONG_INTERACTION_WEIGHT = 1;
const WEAK_INTERACTION_WEIGHT = 0.3;

export const EMPTY_FOCUS_STATE: FocusDimensionState = {
  hourHistogram: new Array<number>(24).fill(0),
  peakBlocks: [],
  totalWeight: 0,
};

/**
 * 专注/活跃维度模型器。
 *
 * 输入观察：kind="desktop_active"（权重 1）或 "interaction"（权重 0.3），
 * value=十进制本地小时。24 槽直方图衰减累计；peakBlocks 为连续高强度槽合并块。
 */
export class FocusDimensionModel implements RhythmDimensionModel<FocusDimensionState> {
  readonly dimension = "focus" as const;

  ingest(
    prev: FocusDimensionState | null,
    observations: RhythmObservation[],
  ): FocusDimensionState {
    const histogram = [...(prev?.hourHistogram ?? EMPTY_FOCUS_STATE.hourHistogram)];
    let totalWeight = (prev?.totalWeight ?? 0) * DECAY_PER_RUN;
    for (let h = 0; h < 24; h++) {
      histogram[h] = (histogram[h] ?? 0) * DECAY_PER_RUN;
    }

    for (const obs of observations) {
      if (!Number.isFinite(obs.value)) continue;
      const hour = Math.floor(((obs.value % 24) + 24) % 24);
      const weight =
        (obs.weight ?? 1) *
        (obs.kind === "interaction" ? WEAK_INTERACTION_WEIGHT : STRONG_INTERACTION_WEIGHT);
      if (weight <= 0) continue;
      histogram[hour] = (histogram[hour] ?? 0) + weight;
      totalWeight += weight;
    }

    return {
      hourHistogram: histogram.map((x) => Math.round(x * 1000) / 1000),
      peakBlocks: extractPeakBlocks(histogram),
      totalWeight,
    };
  }

  /** 累计活跃权重 50 即满置信（约一周桌面+交互信号） */
  confidence(state: FocusDimensionState): number {
    return Math.min(1, state.totalWeight / 50);
  }
}

/** 连续高强度（≥ max 的 40% 且 ≥0.5）槽合并为峰值块，最多取 3 个最强 */
export function extractPeakBlocks(histogram: number[]): FocusPeakBlock[] {
  const max = Math.max(...histogram, 0);
  if (max < 0.5) return [];
  const threshold = Math.max(0.5, max * 0.4);
  const blocks: FocusPeakBlock[] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const strong = h < 24 && (histogram[h] ?? 0) >= threshold;
    if (strong && start === null) {
      start = h;
    } else if (!strong && start !== null) {
      const score = avgRange(histogram, start, h) / max;
      blocks.push({ startHour: start, endHour: h, score: Math.round(score * 100) / 100 });
      start = null;
    }
  }
  // 跨午夜合并（23-1 点这种块首尾相接）
  if (blocks.length >= 2) {
    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    if (first.startHour === 0 && last.endHour === 24) {
      last.endHour = first.endHour;
      blocks.shift();
    }
  }
  return blocks.sort((a, b) => b.score - a.score).slice(0, 3);
}

function avgRange(histogram: number[], from: number, to: number): number {
  let sum = 0;
  for (let h = from; h < to; h++) sum += histogram[h] ?? 0;
  return sum / Math.max(1, to - from);
}
