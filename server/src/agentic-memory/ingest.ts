import OpenAI from "openai";
import type { Memory } from "mem0ai/oss";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getLowSignalBufferMaxItems,
  getLowSignalBufferMaxChars,
} from "./env.js";
import { decideMemoryWrite } from "../services/memory-decision-engine.js";

interface BufferEntry {
  actorId: string;
  sourceId: string;
  text: string;
  createdAt: number;
  /** "main" 主会话 / "notes" 笔记学习会话；用于跨上下文过滤 */
  context: "main" | "notes";
}

function extractKeyLowSignalLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      /\[.*\]|喜欢|不喜欢|讨厌|偏好|记住|提醒|承诺|决定|计划|待办|重要|生日|纪念日/i.test(
        line,
      ),
    )
    .slice(0, 6);
}

export class AgenticMemoryIngestService {
  private lowSignalBuffer: Map<string, BufferEntry[]> = new Map();
  private lowSignalTotalChars: Map<string, number> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly memory: Memory) {}

  /**
   * 兼容旧调用（默认 context=main）。新调用请显式传 context 区分主会话 vs 笔记会话。
   */
  async ingestText(
    actorId: string,
    sourceId: string,
    text: string,
    opts?: { highSignal?: boolean; context?: "main" | "notes" },
  ): Promise<void> {
    const t = text.trim();
    if (!t || t.length < 4) return;

    const context = opts?.context ?? "main";

    if (opts?.highSignal) {
      await this.ingestHighSignal(actorId, sourceId, t, context);
      return;
    }

    this.bufferLowSignal(actorId, sourceId, t, context);
  }

  private async ingestHighSignal(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
  ): Promise<void> {
    const decision = await decideMemoryWrite(body, {
      actorId,
      source: sourceId,
      heuristicHint: "remember",
    });

    const trimmed = body.length > 12_000 ? `${body.slice(0, 12_000)}...` : body;
    await this.memory.add([{ role: "user", content: trimmed }], {
      userId: actorId,
      metadata: {
        source: sourceId,
        actorId,
        context,
        highSignal: true,
        memoryDecision: decision.decision,
        memorySemanticClass: decision.semanticClass,
      },
      infer: true,
    });
  }

  private bufferLowSignal(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
  ): void {
    const trimmed = body.length > 12_000 ? `${body.slice(0, 12_000)}...` : body;

    let entries = this.lowSignalBuffer.get(actorId);
    if (!entries) {
      entries = [];
      this.lowSignalBuffer.set(actorId, entries);
    }

    entries.push({ actorId, sourceId, text: trimmed, createdAt: Date.now(), context });
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

    // 按 context 分桶：每桶独立成一段，方便后续按 context 检索
    const grouped = new Map<"main" | "notes", BufferEntry[]>();
    for (const e of entries) {
      const key = e.context;
      let arr = grouped.get(key);
      if (!arr) {
        arr = [];
        grouped.set(key, arr);
      }
      arr.push(e);
    }

    for (const [context, ctxEntries] of grouped.entries()) {
      const sorted = [...ctxEntries].sort((a, b) => a.createdAt - b.createdAt);
      const combined = sorted
        .map((entry) => `[${entry.sourceId}] ${entry.text}`)
        .join("\n\n---\n\n");

      if (combined.length < 20) continue;

      const summarized = await this.summarizeLowSignal(combined);
      const decision = await decideMemoryWrite(summarized, {
        actorId,
        source: "chat:low_signal_summary",
        heuristicHint: "decay",
      });

      const body = summarized.length > 12_000 ? `${summarized.slice(0, 12_000)}...` : summarized;
      await this.memory.add([{ role: "user", content: body }], {
        userId: actorId,
        metadata: {
          source: "chat:low_signal_summary",
          actorId,
          context,
          highSignal: decision.decision === "remember" || decision.decision === "overwrite",
          memoryDecision: decision.decision,
          memorySemanticClass: decision.semanticClass,
        },
        infer: true,
      });
    }
  }

  private async periodicFlush(): Promise<void> {
    this.flushTimer = null;
    const actorIds = [...this.lowSignalBuffer.keys()];
    for (const actorId of actorIds) {
      await this.flushBuffer(actorId).catch(() => {});
    }
  }

  private async summarizeLowSignal(text: string): Promise<string> {
    const apiKey = resolveOpenAiApiKey();
    const keyLines = extractKeyLowSignalLines(text);
    if (!apiKey) {
      return [...keyLines, text.slice(0, 3000)].filter(Boolean).join("\n");
    }

    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "你是信息摘要器。把多轮低信号对话压缩成简洁中文摘要，保留关键事实、偏好、决定与待办，删除寒暄和无信息量内容。输出纯文本，500字内。",
          },
          { role: "user", content: text },
        ],
      });
      const summary = response.choices[0]?.message?.content?.trim() || text.slice(0, 3000);
      return [...keyLines, summary].filter(Boolean).join("\n");
    } catch {
      return [...keyLines, text.slice(0, 3000)].filter(Boolean).join("\n");
    }
  }

  async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const actorIds = [...this.lowSignalBuffer.keys()];
    await Promise.all(actorIds.map((actorId) => this.flushBuffer(actorId).catch(() => {})));
  }
}
