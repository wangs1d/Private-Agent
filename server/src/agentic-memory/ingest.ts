import OpenAI from "openai";
import type { Memory } from "mem0ai/oss";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getCommitmentExtractScope,
  getLowSignalBufferMaxItems,
  getLowSignalBufferMaxChars,
} from "./env.js";
import { decideMemoryWrite } from "../services/memory-decision-engine.js";
import { isEphemeralActorId, warnEphemeralActorMemoryBlocked } from "../agent/actor-id.js";
import {
  extractUnified,
  isMemoryUnifiedExtractEnabled,
  type UnifiedExtraction,
  type UnifiedFact,
  type UnifiedLlmClient,
} from "./unified-extractor.js";

interface BufferEntry {
  actorId: string;
  sourceId: string;
  text: string;
  createdAt: number;
  /** "main" 主会话 / "notes" 笔记学习会话；用于跨上下文过滤 */
  context: "main" | "notes";
}

/** Mem0 add(infer:true) 抽取出的单条记忆 */
export interface Mem0WrittenItem {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
}

/**
 * Mem0 落库完成事件（写入钩子入参）。
 * 方案 B（账本落账）、方案 C（承诺自动提取）、方案 D（溯源登记）都从此处取数——
 * 复用 Mem0 infer 的抽取结果，不额外调 LLM。
 * unified 路径（P1-6）额外携带 commitments/corrections/facts（同一次 LLM 的产物，
 * 钩子直接消费，省掉 commitment-extractor 的第二次调用）。
 */
export interface Mem0WriteEvent {
  actorId: string;
  sourceId: string;
  context: "main" | "notes";
  highSignal: boolean;
  /** Mem0 infer/unified 抽取结果（含记忆 id，供账本/溯源关联） */
  results: Mem0WrittenItem[];
  /** 统一抽取路径携带：承诺识别结果（钩子直接 ingestExtracted，不再调 LLM） */
  commitments?: import("./commitment-board.js").ExtractedCommitment[];
  /** 统一抽取路径携带：用户纠正（钩子走 supersession + 溯源级联） */
  corrections?: import("./unified-extractor.js").UnifiedCorrection[];
  /** 统一抽取路径携带：身份事实（钩子走事实注册表 upsert + 旧值级联作废） */
  facts?: UnifiedFact[];
}

export type Mem0WriteHook = (event: Mem0WriteEvent) => void;

/** 低信号统一写入者接管后的投递口（memory-consolidation-service，bootstrap 接线） */
export type LowSignalSink = (entry: {
  actorId: string;
  sourceId: string;
  text: string;
  context: "main" | "notes";
}) => void;

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
  private lowSignalSink: LowSignalSink | null = null;
  private writeHooks: Mem0WriteHook[] = [];
  /** 统一抽取 LLM 客户端（测试注入 fake；生产为 null 走内部 OpenAI 构造） */
  private extractionClient: UnifiedLlmClient | null = null;

  constructor(private readonly memory: Memory) {}

  /** 注入统一抽取客户端（e2e 测试用；生产不调用） */
  setExtractionClient(client: UnifiedLlmClient | null): void {
    this.extractionClient = client;
  }

  /**
   * 注入统一写入者接管口。设置后低信号内容不再走内置内存缓冲，
   * 而是投递给 memory-consolidation-service 的候选队列（唯一整合链路）；
   * 未设置（统一写入者关闭/测试）时保持原缓冲行为。
   */
  setLowSignalSink(sink: LowSignalSink | null): void {
    this.lowSignalSink = sink;
  }

  /**
   * 注册 Mem0 落库后钩子（方案 B/C/D 的统一取数口）。
   * 钩子抛错不影响主写入链路。
   */
  addWriteHook(hook: Mem0WriteHook): void {
    this.writeHooks.push(hook);
  }

  private fireWriteHooks(event: Mem0WriteEvent): void {
    for (const hook of this.writeHooks) {
      try {
        hook(event);
      } catch (err) {
        console.error("[agentic-memory] write hook failed（忽略）:", err);
      }
    }
  }

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

    // P0-2 承诺捕获与记忆路由解耦：低信号文本（临时上下文/decay）不值得长期
    // 存储，但里面的承诺/身份事实照样要抓——"明天发你"是 decay 记忆 + 真承诺，
    // "我老婆是刘浩存"是闲聊语气 + 身份事实。
    // fire-and-forget 抽取（无词表预筛，识别交给 LLM），只消费
    // commitments/corrections/facts，不阻塞低信号缓冲主链路。
    if (
      context === "main" &&
      isMemoryUnifiedExtractEnabled() &&
      getCommitmentExtractScope() === "all"
    ) {
      void extractUnified(t, { client: this.extractionClient ?? undefined })
        .then((orphan) => {
          if (!orphan) return;
          if (
            orphan.commitments.length === 0 &&
            orphan.corrections.length === 0 &&
            orphan.facts.length === 0
          ) {
            return;
          }
          this.fireWriteHooks({
            actorId,
            sourceId,
            context,
            highSignal: false,
            results: [],
            commitments: orphan.commitments.length > 0 ? orphan.commitments : undefined,
            corrections: orphan.corrections.length > 0 ? orphan.corrections : undefined,
            facts: orphan.facts.length > 0 ? orphan.facts : undefined,
          });
        })
        .catch((err) =>
          console.warn(
            "[agentic-memory] 低信号承诺抽取失败（忽略）:",
            err instanceof Error ? err.message : err,
          ),
        );
    }

    if (this.lowSignalSink) {
      this.lowSignalSink({ actorId, sourceId, text: t, context });
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
    // P1-6 统一抽取：决策 + 记忆 + 承诺 + 纠正 + 事实 一次 LLM 完成（原最多 3 次调用）。
    // 返回 null（无 key/失败）时整体回退旧三段路径。
    const unified = isMemoryUnifiedExtractEnabled()
      ? await extractUnified(body, { client: this.extractionClient ?? undefined })
      : null;
    if (unified) {
      await this.persistUnifiedExtraction(actorId, sourceId, unified, context, true, body);
      return;
    }

    const decision = await decideMemoryWrite(body, {
      actorId,
      source: sourceId,
      heuristicHint: "remember",
    });

    // 写入决策真正拦截：reject 的内容不落库（此前决策只写 metadata，无否决权）
    if (decision.decision === "reject") return;

    await this.writeDecidedDetailed(actorId, sourceId, body, context, true, {
      memoryDecision: decision.decision,
      memorySemanticClass: decision.semanticClass,
    });
  }

  /**
   * 统一抽取产物直存（所有 unified 路径共用的落库核心）：
   *   - memories 以 infer:false 直存（抽取已在 extractUnified 完成，Mem0 不再二次调 LLM）；
   *   - 落库后 fire 钩子，携带 results + facts + commitments + corrections——
   *     bootstrap 钩子据此做账本落账 / 事实注册表 upsert（含旧值级联作废）/ 承诺落板 / 纠正级联；
   *   - decision=reject 时记忆不落库，但承诺/纠正/事实仍经钩子落地（P0-2 解耦语义）；
   *   - memories 为空且非 reject 时回退 fallbackText（高信号=原句；整合路径传截断后的合并文本）。
   * 供 ingestHighSignal 与 memory-consolidation-service（统一写入者）复用。
   */
  async persistUnifiedExtraction(
    actorId: string,
    sourceId: string,
    extraction: UnifiedExtraction,
    context: "main" | "notes",
    highSignal: boolean,
    fallbackText?: string,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]> {
    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return [];
    }

    const facts = extraction.facts.length > 0 ? extraction.facts : undefined;
    const commitments =
      extraction.commitments.length > 0 ? extraction.commitments : undefined;
    const corrections =
      extraction.corrections.length > 0 ? extraction.corrections : undefined;

    if (extraction.decision === "reject") {
      // 被拒存：results 为空（账本不落 claim），但承诺/纠正/事实仍要落地
      if (facts || commitments || corrections) {
        this.fireWriteHooks({
          actorId,
          sourceId,
          context,
          highSignal,
          results: [],
          commitments,
          corrections,
          facts,
        });
      }
      return [];
    }

    const memories =
      extraction.memories.length > 0
        ? extraction.memories
        : fallbackText
          ? [fallbackText]
          : [];
    const results: Mem0WrittenItem[] = [];
    for (const item of memories) {
      const trimmed = item.length > 12_000 ? `${item.slice(0, 12_000)}...` : item;
      try {
        const addResult = (await this.memory.add([{ role: "user", content: trimmed }], {
          userId: actorId,
          metadata: {
            source: sourceId,
            actorId,
            context,
            highSignal,
            memoryDecision: extraction.decision,
            ...(extraction.semanticClass
              ? { memorySemanticClass: extraction.semanticClass }
              : {}),
            extractSource: "unified",
            ...extraMetadata,
          },
          // 统一抽取已完成记忆改写，Mem0 侧直存，不再进 infer 的 LLM
          infer: false,
        })) as unknown as { results?: Mem0WrittenItem[] };
        // infer:false 时 Mem0 返回的条目文本即原文；缺 id 的条目跳过钩子关联
        for (const r of addResult?.results ?? []) {
          if (r?.id) results.push(r);
        }
      } catch (err) {
        console.error("[agentic-memory] unified 直存失败（跳过该条）:", err);
      }
    }
    // Mem0 全部写入失败但承诺/纠正/事实存在时也要触发钩子（承诺/事实不随存储失败丢失）
    if (results.length > 0 || facts || commitments || corrections) {
      this.fireWriteHooks({
        actorId,
        sourceId,
        context,
        highSignal,
        results,
        commitments,
        corrections,
        facts,
      });
    }
    return results;
  }

  /**
   * 统一写入者出口：候选已由 memory-consolidation-service 裁决过，
   * 这里直接落库（不再调 decideMemoryWrite），消除高信号路径的双重 LLM 决策。
   */
  async writeDecided(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
    highSignal: boolean,
  ): Promise<void> {
    await this.writeDecidedDetailed(actorId, sourceId, body, context, highSignal);
  }

  /**
   * Mem0 落库核心（所有持久写入共用）：
   *   - infer:true 由 Mem0 LLM 抽取结构化记忆条目，返回结果（含 id）
   *   - 落库成功后触发 writeHooks（方案 B 账本 / 方案 C 承诺提取 / 方案 D 溯源）
   *   - extraMetadata 供 memory-bridge 注入 graphNodeId 等跨层关联字段
   * 返回抽取结果；Mem0 未返回明细时 results 为空数组（hooks 不触发）。
   */
  async writeDecidedDetailed(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
    highSignal: boolean,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]> {
    const t = body.trim();
    if (!t || t.length < 4) return [];

    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return [];
    }

    const trimmed = t.length > 12_000 ? `${t.slice(0, 12_000)}...` : t;
    const addResult = (await this.memory.add([{ role: "user", content: trimmed }], {
      userId: actorId,
      metadata: {
        source: sourceId,
        actorId,
        context,
        highSignal,
        ...(highSignal ? { memoryDecision: "remember" } : { memoryDecision: "decay" }),
        ...extraMetadata,
      },
      infer: true,
    })) as unknown as { results?: Mem0WrittenItem[] };

    const results = addResult?.results ?? [];
    if (results.length > 0) {
      this.fireWriteHooks({ actorId, sourceId, context, highSignal, results });
    }
    return results;
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
