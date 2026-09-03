/**
 * 统一记忆写入者（四路合一，2026-09）。
 *
 * 此前对话内容到持久记忆有四条并行写入链路（turn-lifecycle 高信号 fast-path、
 * turn_archive、低信号 Mem0 缓冲、KV fast-path 行），各自触发、各自裁决、各自
 * 落库——同一事实可能同时进 Mem0 / 海马体 / KV 三份副本，且高信号路径在
 * turn-lifecycle 与 agentic ingestHighSignal 各决策一次（双重 LLM 调用）。
 *
 * 收敛后（借鉴 OpenClaw 2.0 Grounded Dreaming 的单写入者结构）：
 *  - 所有对话衍生的写入（含 memory-cortex 低信号路径）只作为「候选」进入本队列；
 *  - 唯一的整合链路在本服务：回声过滤 → 裁决（每候选一次）→ 摘要（低信号合并）
 *    → supersession 退役 → 单一出口 writeDecided（海马体 + Mem0 + KV）；
 *  - 用户显式驱动的写入（memory-cortex.ingest 高信号、brain 工具）保持直写，
 *    不进队列——与 OpenClaw「直接请求立即写入」一致。
 *
 * 失败语义：落库失败整批回灌队列重试（沿用原 Mem0 低信号缓冲的回灌模式）。
 */
import type { Memory } from "mem0ai/oss";
import OpenAI from "openai";

import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { MemoryDecisionResult } from "./memory-decision-engine.js";
import { decideMemoryWrite } from "./memory-decision-engine.js";
import { isMemoryEcho } from "./memory-echo-guard.js";
import { semanticFingerprint } from "./memory-record-utils.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
} from "../agentic-memory/env.js";

export type MemoryCandidate = {
  actorId: string;
  text: string;
  /** 产生候选的链路：chat:turn_archive / chat:fast_path / cortex:low_signal ... */
  source: string;
  context: "main" | "notes";
  highSignal: boolean;
  createdAt: string;
  /** KV summary 行的话题提示（沿用 inferMemoryTopic 产物） */
  topicHint?: string;
};

type DecidedCandidate = {
  candidate: MemoryCandidate;
  decision: MemoryDecisionResult;
  /** 低信号合并摘要后 text 已被替换 */
  text: string;
};

type PersistedQueue = { candidates: MemoryCandidate[] };

const MAX_CANDIDATE_TEXT_CHARS = 12_000;
const MAX_QUEUE_SIZE = 500;

function clampText(text: string): string {
  return text.length > MAX_CANDIDATE_TEXT_CHARS ? `${text.slice(0, MAX_CANDIDATE_TEXT_CHARS)}...` : text;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type MemoryConsolidationDeps = {
  narrative: NarrativeMemoryPort | null;
  kvSync: AgentMemorySyncService | null;
  /** Mem0 实例，供 supersession 语义检索/退役；缺省跳过退役 */
  memory: Memory | null;
  filePath?: string;
};

export class MemoryConsolidationService {
  private queue: MemoryCandidate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly debounceMs: number;
  private readonly supersedeSimilarity: number;
  private readonly filePath: string;
  private loaded = false;

  constructor(private readonly deps: MemoryConsolidationDeps) {
    this.debounceMs = envNum("AGENT_MEMORY_CONSOLIDATION_DEBOUNCE_MS", 30_000);
    this.supersedeSimilarity = envNum("AGENT_MEMORY_SUPERSEDE_SIMILARITY", 0.8);
    this.filePath =
      deps.filePath ??
      (process.env.AGENT_MEMORY_CANDIDATES_FILE?.trim() ||
        `${process.cwd()}/data/memory-candidates.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedQueue;
      if (Array.isArray(parsed?.candidates)) {
        this.queue = parsed.candidates.filter(
          (c) => c && typeof c.actorId === "string" && typeof c.text === "string",
        );
      }
    } catch {
      // 首次运行/文件缺失：空队列启动
    }
  }

  /**
   * 提交一条写入候选。指纹去重（同 actor 同内容的重复候选只保留一份），
   * 并调度防抖整合。永不抛出——候选生产方（turn-lifecycle 等）不允许被写入链路阻塞。
   */
  submitCandidate(candidate: MemoryCandidate): void {
    const text = candidate.text?.trim();
    if (!text || text.length < 4) return;
    if (!candidate.actorId) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
    const fp = semanticFingerprint(text);
    const dup = this.queue.find(
      (c) => c.actorId === candidate.actorId && semanticFingerprint(c.text) === fp,
    );
    if (dup) return;

    this.queue.push({
      ...candidate,
      text: clampText(text),
      createdAt: candidate.createdAt || new Date().toISOString(),
    });
    void this.persistQueue();

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushAll().catch(() => {});
      }, this.debounceMs);
      this.flushTimer.unref();
    }
  }

  /** 立即整合所有 actor 的待处理候选（防抖触发 / 关停 / 测试用）。 */
  async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const actorIds = [...new Set(this.queue.map((c) => c.actorId))];
    for (const actorId of actorIds) {
      await this.flushActor(actorId).catch((err) => {
        console.error("[memory-consolidation] flushActor failed:", err);
      });
    }
  }

  pendingCount(actorId?: string): number {
    return actorId ? this.queue.filter((c) => c.actorId === actorId).length : this.queue.length;
  }

  private async flushActor(actorId: string): Promise<void> {
    const batch = this.queue.filter((c) => c.actorId === actorId);
    if (batch.length === 0) return;
    // 先出队再落库，失败整批回灌（保持时间序），沿用原低信号缓冲的失败语义
    this.queue = this.queue.filter((c) => c.actorId !== actorId);
    void this.persistQueue();

    try {
      // 回声过滤：注入过的记忆被模型复述的候选不入库
      const accepted = batch.filter((c) => {
        if (isMemoryEcho(actorId, c.text)) return false;
        return true;
      });

      const decided: DecidedCandidate[] = [];

      // 高信号：逐条决策（heuristic + LLM 复判，与原 ingestHighSignal 一致）
      for (const candidate of accepted.filter((c) => c.highSignal)) {
        const decision = await decideMemoryWrite(candidate.text, {
          actorId,
          source: candidate.source,
          heuristicHint: "remember",
        });
        decided.push({ candidate, decision, text: candidate.text });
      }

      // 低信号：按 context 分桶合并 → 摘要 → 单次决策（摘要已是 LLM 产物，不二次复判）
      const low = accepted.filter((c) => !c.highSignal);
      const lowByContext = new Map<"main" | "notes", MemoryCandidate[]>();
      for (const candidate of low) {
        const arr = lowByContext.get(candidate.context) ?? [];
        arr.push(candidate);
        lowByContext.set(candidate.context, arr);
      }
      for (const [context, items] of lowByContext) {
        const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const combined = sorted.map((e) => `[${e.source}] ${e.text}`).join("\n\n---\n\n");
        if (combined.length < 20) continue;
        const summarized = await this.summarizeLowSignal(combined);
        const decision = await decideMemoryWrite(
          summarized,
          { actorId, source: "chat:low_signal_summary", heuristicHint: "decay" },
          { allowLlm: false },
        );
        decided.push({
          candidate: { ...sorted[0]!, text: summarized },
          decision,
          text: summarized,
        });
      }

      await this.egress(actorId, decided);
    } catch (err) {
      this.queue = [...batch, ...this.queue];
      void this.persistQueue();
      console.error("[memory-consolidation] flush 失败（候选已回灌待重试）:", err);
    }
  }

  /** 唯一落库出口：海马体 + Mem0（经 narrative port）+ KV summary 行。 */
  private async egress(actorId: string, decided: DecidedCandidate[]): Promise<void> {
    const toPersist = decided.filter((d) => d.decision.decision !== "reject");

    // Supersession：overwrite/mutable_fact 语义的候选先退役语义重合的旧记忆
    for (const d of toPersist) {
      if (d.decision.decision === "overwrite" || d.decision.semanticClass === "mutable_fact") {
        await this.retireSuperseded(actorId, d.text);
      }
    }

    if (toPersist.length > 0 && this.deps.narrative) {
      const body = toPersist.map((d) => d.text).join("\n");
      const context = toPersist[0]!.candidate.context;
      await this.deps.narrative.writeDecided(actorId, body, toPersist[0]!.candidate.source, {
        context,
        highSignal: true,
      });
    }

    // KV summary 行：fast_path 候选沿用旧行为——无论决策结果都落一行（记录决策）；
    // 其他来源仅 remember/overwrite 时落行。
    if (this.deps.kvSync) {
      for (const d of decided) {
        const isFastPath = d.candidate.source === "chat:fast_path";
        if (!isFastPath && d.decision.decision === "reject") continue;
        this.deps.kvSync.appendMemorySummaryLine(
          actorId,
          `[fast-path][${d.decision.decision}][${d.decision.semanticClass}] ${d.candidate.text}`,
          d.candidate.topicHint,
        );
      }
    }
  }

  /**
   * Supersession：新事实（overwrite/mutable_fact）到来时，语义重合的旧记忆
   * 退役（删除），而非靠 Jaccard 字面去重或任由新旧并存——过期偏好并存时
   * 模型会拿旧值作答。高信号稳定约束不自动退役，防一次误判抹掉长期约束。
   */
  private async retireSuperseded(actorId: string, text: string): Promise<string[]> {
    const memory = this.deps.memory;
    if (!memory) return [];
    try {
      const result = (await memory.search(text, {
        filters: { user_id: actorId },
        topK: 8,
      })) as unknown as {
        results?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>;
      };
      const retired: string[] = [];
      for (const item of result.results ?? []) {
        const score = item.score ?? 0;
        if (score < this.supersedeSimilarity) continue;
        if (
          item.metadata?.highSignal === true &&
          item.metadata?.memorySemanticClass === "stable_constraint"
        ) {
          continue;
        }
        await memory.delete(item.id).catch(() => {});
        retired.push(item.id);
      }
      if (retired.length > 0) {
        console.info(
          `[memory-consolidation] superseded ${retired.length} old memories for actor ${actorId}`,
        );
      }
      return retired;
    } catch {
      return [];
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
      const { recordLlmUsageByChars } = await import("./llm-token-audit.js");
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

  private async persistQueue(): Promise<void> {
    try {
      await writeJsonAtomic(this.filePath, { candidates: this.queue } satisfies PersistedQueue);
    } catch (err) {
      console.warn("[memory-consolidation] queue persist failed:", err);
    }
  }
}

/** 与原 AgenticMemoryIngestService.extractKeyLowSignalLines 一致的高信号行提取。 */
function extractKeyLowSignalLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      /\[.*\]|喜欢|不喜欢|讨厌|偏好|记住|提醒|承诺|决定|计划|待办|重要|生日|纪念日/i.test(line),
    )
    .slice(0, 6);
}

let singleton: MemoryConsolidationService | null = null;

export function getMemoryConsolidationService(): MemoryConsolidationService | null {
  return singleton;
}

/** bootstrap 装配：依赖齐备且开关开启时启用统一写入者；否则返回 null（各链路走旧路径）。 */
export function configureMemoryConsolidation(deps: MemoryConsolidationDeps): MemoryConsolidationService | null {
  if (!envBool("AGENT_MEMORY_CONSOLIDATION_ENABLED", true)) {
    console.info("[memory-consolidation] disabled by AGENT_MEMORY_CONSOLIDATION_ENABLED");
    singleton = null;
    return null;
  }
  if (!deps.narrative) {
    console.info("[memory-consolidation] disabled: no narrative egress");
    singleton = null;
    return null;
  }
  singleton = new MemoryConsolidationService(deps);
  void singleton.load();
  console.info(
    `[memory-consolidation] unified writer ready (debounce=${singleton["debounceMs"]}ms)`,
  );
  return singleton;
}

/** 测试专用：清空单例。 */
export function resetMemoryConsolidationForTests(): void {
  singleton = null;
}
