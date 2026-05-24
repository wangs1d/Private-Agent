import type { Memory } from "mem0ai/oss";

import { getAgenticMemoryTopK } from "./env.js";

/**
 * Mem0 记忆图检索：语义 + BM25 + 实体链接融合，支持跨主题联想与前因后果链。
 */
export class AgenticMemoryRetrievalService {
  constructor(private readonly memory: Memory) {}

  async buildRecall(actorId: string, queryText: string): Promise<string> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return "";

    const topK = getAgenticMemoryTopK();
    const result = await this.memory.search(query, {
      filters: { user_id: actorId },
      topK,
    });

    const items = result.results ?? [];
    if (!items.length) return "";

    const parts: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const score =
        item.score != null ? ` 相关度 ${(item.score * 100).toFixed(0)}%` : "";
      const src =
        typeof item.metadata?.source === "string" ? `[${item.metadata.source}]` : "";
      parts.push(`${i + 1}.${score}${src ? ` ${src}` : ""}\n${item.memory}`);
    }

    return `以下为 Mem0 记忆图联想检索（实体链接 + 多信号融合，可跨主题串联前因后果）：\n${parts.join("\n\n")}`;
  }
}
