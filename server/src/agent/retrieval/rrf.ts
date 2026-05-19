/**
 * Reciprocal Rank Fusion（RRF）：融合多路有序结果，避免各通道分数尺度不一。
 * 常用平滑常数 k = 60。
 */

export type RankedHit = { id: string };

export function reciprocalRankFusion(rankings: RankedHit[][], k = 60, topN = 8): { id: string; rrf: number }[] {
  const agg = new Map<string, number>();
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]?.id;
      if (!id) continue;
      const inc = 1 / (k + rank + 1);
      agg.set(id, (agg.get(id) ?? 0) + inc);
    }
  }
  return [...agg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, rrf]) => ({ id, rrf }));
}
