import type { Memory } from "mem0ai/oss";

export class AgenticMemoryIngestService {
  constructor(private readonly memory: Memory) {}

  /** 将叙事文本写入 Mem0 记忆图（infer=true，自动抽取实体与因果事实）。 */
  async ingestText(
    actorId: string,
    sourceId: string,
    text: string,
    opts?: { highSignal?: boolean },
  ): Promise<void> {
    const t = text.trim();
    if (!t || t.length < 4) return;
    const body = t.length > 12_000 ? `${t.slice(0, 12_000)}…` : t;
    await this.memory.add([{ role: "user", content: body }], {
      userId: actorId,
      metadata: { source: sourceId, actorId, highSignal: opts?.highSignal === true },
      infer: true,
    });
  }
}
