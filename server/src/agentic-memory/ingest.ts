import OpenAI from "openai";
import type { Memory } from "mem0ai/oss";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getLowSignalBufferMaxItems,
  getLowSignalBufferMaxChars,
} from "./env.js";

interface BufferEntry {
  actorId: string;
  sourceId: string;
  text: string;
  createdAt: number;
}

export class AgenticMemoryIngestService {
  private lowSignalBuffer: Map<string, BufferEntry[]> = new Map();
  private lowSignalTotalChars: Map<string, number> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly memory: Memory) {}

  async ingestText(
    actorId: string,
    sourceId: string,
    text: string,
    opts?: { highSignal?: boolean },
  ): Promise<void> {
    const t = text.trim();
    if (!t || t.length < 4) return;

    if (opts?.highSignal) {
      await this.ingestHighSignal(actorId, sourceId, t);
      return;
    }

    this.bufferLowSignal(actorId, sourceId, t);
  }

  private async ingestHighSignal(actorId: string, sourceId: string, body: string): Promise<void> {
    const trimmed = body.length > 12_000 ? `${body.slice(0, 12_000)}…` : body;
    await this.memory.add([{ role: "user", content: trimmed }], {
      userId: actorId,
      metadata: { source: sourceId, actorId, highSignal: true },
      infer: true,
    });
  }

  private bufferLowSignal(actorId: string, sourceId: string, body: string): void {
    const trimmed = body.length > 12_000 ? `${body.slice(0, 12_000)}…` : body;

    let entries = this.lowSignalBuffer.get(actorId);
    if (!entries) {
      entries = [];
      this.lowSignalBuffer.set(actorId, entries);
    }

    entries.push({ actorId, sourceId, text: trimmed, createdAt: Date.now() });
    const totalChars = (this.lowSignalTotalChars.get(actorId) ?? 0) + trimmed.length;
    this.lowSignalTotalChars.set(actorId, totalChars);

    const maxItems = getLowSignalBufferMaxItems();
    const maxChars = getLowSignalBufferMaxChars();

    if (entries.length >= maxItems || totalChars >= maxChars) {
      void this.flushBuffer(actorId);
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.periodicFlush(), 30_000);
      this.flushTimer.unref();
    }
  }

  private async flushBuffer(actorId: string): Promise<void> {
    const entries = this.lowSignalBuffer.get(actorId);
    if (!entries || entries.length === 0) return;

    this.lowSignalBuffer.delete(actorId);
    this.lowSignalTotalChars.delete(actorId);

    const combined = entries
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => `[${e.sourceId}] ${e.text}`)
      .join("\n\n---\n\n");

    if (combined.length < 20) return;

    const summarized = await this.summarizeLowSignal(combined);
    const body = summarized.length > 12_000 ? `${summarized.slice(0, 12_000)}…` : summarized;

    await this.memory.add([{ role: "user", content: body }], {
      userId: actorId,
      metadata: { source: "chat:low_signal_summary", actorId, highSignal: false },
      infer: true,
    });
  }

  private async periodicFlush(): Promise<void> {
    this.flushTimer = null;
    const actorIds = [...this.lowSignalBuffer.keys()];
    for (const aid of actorIds) {
      await this.flushBuffer(aid).catch(() => {});
    }
  }

  private async summarizeLowSignal(text: string): Promise<string> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) return text.slice(0, 3000);

    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "你是信息摘要器。将多轮对话片段压缩为简洁中文摘要，保留关键事实、偏好、决定与待办。删除纯寒暄与无信息量内容。输出纯文本，不超过 500 字。",
          },
          { role: "user", content: text },
        ],
      });
      return response.choices[0]?.message?.content?.trim() || text.slice(0, 3000);
    } catch {
      return text.slice(0, 3000);
    }
  }

  /** 主动刷新指定用户缓冲区（进程退出时调用） */
  async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const actorIds = [...this.lowSignalBuffer.keys()];
    await Promise.all(actorIds.map((id) => this.flushBuffer(id).catch(() => {})));
  }
}
