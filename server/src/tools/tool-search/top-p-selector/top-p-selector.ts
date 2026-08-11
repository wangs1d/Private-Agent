export type ScoredCandidate<T> = {
  item: T;
  score: number;
};

export type TopPSelectionOptions = {
  confidence: number;
  minCandidate?: number;
  maxCandidate?: number;
  topPOverride?: number | null;
};

export type TopPSelectionResult<T> = {
  top_p: number;
  selected: Array<ScoredCandidate<T>>;
  total_candidates: number;
};

const DEFAULT_MIN_CANDIDATE = 3;
const DEFAULT_MAX_CANDIDATE = 25;

export class AdaptiveTopPSelector {
  select<T>(
    candidates: Array<ScoredCandidate<T>>,
    options: TopPSelectionOptions,
  ): TopPSelectionResult<T> {
    const minCandidate = Math.max(1, options.minCandidate ?? DEFAULT_MIN_CANDIDATE);
    const maxCandidate = Math.max(
      minCandidate,
      options.maxCandidate ?? DEFAULT_MAX_CANDIDATE,
    );
    const topP = clamp(
      options.topPOverride ?? topPForConfidence(options.confidence),
      0.5,
      0.99,
    );

    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const limited = sorted.slice(0, maxCandidate);
    if (limited.length <= minCandidate) {
      return { top_p: topP, selected: limited, total_candidates: candidates.length };
    }

    const probabilities = normalizeScores(limited);
    const selected: Array<ScoredCandidate<T>> = [];
    let cumulative = 0;
    for (let i = 0; i < limited.length; i++) {
      selected.push(limited[i]!);
      cumulative += probabilities[i] ?? 0;
      if (selected.length >= minCandidate && cumulative >= topP) break;
    }

    return {
      top_p: topP,
      selected: selected.slice(0, maxCandidate),
      total_candidates: candidates.length,
    };
  }
}

export function topPForConfidence(confidence: number): number {
  if (confidence > 0.85) return 0.7;
  if (confidence > 0.6) return 0.9;
  return 0.95;
}

function normalizeScores<T>(candidates: Array<ScoredCandidate<T>>): number[] {
  const scores = candidates.map((c) => Math.max(0, c.score));
  const sum = scores.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const p = candidates.length > 0 ? 1 / candidates.length : 0;
    return candidates.map(() => p);
  }
  return scores.map((s) => s / sum);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
