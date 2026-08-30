import OpenAI from "openai";
import type { Memory } from "mem0ai/oss";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getLowSignalBufferMaxItems,
  getLowSignalBufferMaxChars,
} from "./env.js";
import { decideMemoryWrite } from "../services/memory-decision-engine.js";
import { isEphemeralActorId, warnEphemeralActorMemoryBlocked } from "../agent/actor-id.js";

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

    // 匿名身份治理：无稳定身份的对话不进长期记忆（共享桶 = 跨请求串台源）
    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return;
    }

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

    // 写入决策真正拦截：reject 的内容不落库（此前决策只写 metadata，无否决权）
    if (decision.decision === "reject") return;

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
      void this.flushBuffer(actorId).catch((err) => {
        console.error("[agentic-memory] flushBuffer failed (check embedding config):", err);
      });
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

    try {
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
        // 摘要已是 LLM 产物，落库裁决不再二次调 LLM 复判——原路径一次 flush 最多
        // 三次 LLM（摘要 + 决策复判 + Mem0 infer 抽取），中间这次收益最低。
        const decision = await decideMemoryWrite(
          summarized,
          {
            actorId,
            source: "chat:low_signal_summary",
            heuristicHint: "decay",
          },
          { allowLlm: false },
        );

        // reject 的摘要不落库；decay 保留（临时上下文仍可短期召回，由遗忘机制回收）
        if (decision.decision === "reject") continue;

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
    } catch (err) {
      // 失败回灌：原实现先删 buffer 再写库，摘要/落库中途异常会静默丢失整批内容。
      // 回灌到该 actor 的 buffer 头部（保持时间序），由下一次 flush 重试。
      const existing = this.lowSignalBuffer.get(actorId) ?? [];
      this.lowSignalBuffer.set(actorId, [...entries, ...existing]);
      const retriedChars = entries.reduce((sum, e) => sum + e.text.length, 0);
      this.lowSignalTotalChars.set(
        actorId,
        retriedChars + (this.lowSignalTotalChars.get(actorId) ?? 0),
      );
      console.error("[agentic-memory] flushBuffer 失败（内容已回灌待重试）:", err);
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
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: "system",
          content:
            "你是信息摘要器。把多轮低信号对话压缩成简洁中文摘要，保留关键事实、偏好、决定与待办，删除寒暄和无信息量内容。输出纯文本，500字内。",
        },
        { role: "user", content: text },
      ];
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0.3,
        messages,
      });
      const summary = response.choices[0]?.message?.content?.trim() || text.slice(0, 3000);
      // Token 审计：低信号批量摘要
      const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
      recordLlmUsageByChars({
        stage: "memory_flush_summarize",
        inputChars: JSON.stringify(messages).length,
        outputChars: summary.length,
        model: getAgenticMemoryLlmModel(),
      });
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
