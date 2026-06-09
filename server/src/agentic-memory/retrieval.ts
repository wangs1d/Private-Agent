import type { Memory } from "mem0ai/oss";

import {
  getAgenticMemoryTopK,
  getAgenticMemorySearchTopK,
  getTimeDecayHalfLifeHours,
  getHighSignalBoost,
} from "./env.js";
import { dedupeMemoryLines, semanticFingerprint } from "../services/memory-record-utils.js";

interface Mem0SearchItem {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface Mem0SearchResult {
  results: Mem0SearchItem[];
}

interface ScoredItem {
  item: Mem0SearchItem;
  rawScore: number;
  rerankScore: number;
  ageHours: number;
  highSignal: boolean;
}

function computeTimeDecay(ageHours: number, halfLifeHours: number): number {
  if (ageHours <= 0) return 1;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

export class AgenticMemoryRetrievalService {
  constructor(private readonly memory: Memory) {}

  async buildRecall(actorId: string, queryText: string): Promise<string> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return "";

    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: { user_id: actorId },
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = result.results ?? [];
    if (!items.length) return "";

    const now = Date.now();
    const halfLifeHours = getTimeDecayHalfLifeHours();
    const highSignalBoost = getHighSignalBoost();

    const scored: ScoredItem[] = items.map((item) => {
      const rawScore = item.score ?? 0;
      const highSignal = item.metadata?.highSignal === true;

      let ageHours = 0;
      const ts = item.createdAt ?? item.updatedAt;
      if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) {
          ageHours = Math.max(0, (now - parsed) / 3_600_000);
        }
      }

      const decay = computeTimeDecay(ageHours, halfLifeHours);
      const signalBoost = highSignal ? highSignalBoost : 1;
      const rerankScore = rawScore * decay * signalBoost;

      return { item, rawScore, rerankScore, ageHours, highSignal };
    });

    scored.sort((a, b) => b.rerankScore - a.rerankScore);

    const finalTopK = getAgenticMemoryTopK();
    const deduped = this.dedupeScoredItems(scored);
    const topItems = deduped.slice(0, finalTopK);

    const parts: string[] = [];
    for (let i = 0; i < topItems.length; i++) {
      const { item, rerankScore, ageHours, highSignal } = topItems[i]!;
      const scorePercent = (rerankScore * 100).toFixed(0);
      const src = typeof item.metadata?.source === "string" ? `[${item.metadata.source}]` : "";
      const freshness = ageHours < 1 ? "刚刚" : ageHours < 24 ? `${Math.round(ageHours)}h前` : `${Math.round(ageHours / 24)}d前`;
      const signalTag = highSignal ? " ⭐高信号" : "";
      parts.push(`${i + 1}. 相关度 ${scorePercent}% · ${freshness}${signalTag}${src ? ` ${src}` : ""}\n${item.memory}`);
    }

    const recallWithoutCompression = `以下为 Mem0 记忆图联想检索（实体链接 + 多信号融合，可跨主题串联前因后果）：\n${parts.join("\n\n")}`;

    return recallWithoutCompression;
  }

  /** 返回原始结构供压缩器使用 */
  async searchRaw(
    actorId: string,
    queryText: string,
  ): Promise<{ items: ScoredItem[]; topItems: ScoredItem[] }> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return { items: [], topItems: [] };

    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: { user_id: actorId },
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = result.results ?? [];
    if (!items.length) return { items: [], topItems: [] };

    const now = Date.now();
    const halfLifeHours = getTimeDecayHalfLifeHours();
    const highSignalBoost = getHighSignalBoost();

    const scored: ScoredItem[] = items.map((item) => {
      const rawScore = item.score ?? 0;
      const highSignal = item.metadata?.highSignal === true;

      let ageHours = 0;
      const ts = item.createdAt ?? item.updatedAt;
      if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) {
          ageHours = Math.max(0, (now - parsed) / 3_600_000);
        }
      }

      const decay = computeTimeDecay(ageHours, halfLifeHours);
      const signalBoost = highSignal ? highSignalBoost : 1;
      const rerankScore = rawScore * decay * signalBoost;

      return { item, rawScore, rerankScore, ageHours, highSignal };
    });

    scored.sort((a, b) => b.rerankScore - a.rerankScore);
    const finalTopK = getAgenticMemoryTopK();
    const deduped = this.dedupeScoredItems(scored);
    const topItems = deduped.slice(0, finalTopK);

    return { items: deduped, topItems };
  }

  private dedupeScoredItems(items: ScoredItem[]): ScoredItem[] {
    const keepTexts = dedupeMemoryLines(
      items.map((item) => item.item.memory),
      { preferLatest: false },
    );
    const keep = new Set(keepTexts.map((line) => semanticFingerprint(line) || line));
    return items.filter((item) => keep.has(semanticFingerprint(item.item.memory) || item.item.memory));
  }
}
