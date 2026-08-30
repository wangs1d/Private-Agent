import type { Memory } from "mem0ai/oss";

import {
  getAgenticMemoryTopK,
  getAgenticMemorySearchTopK,
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
  ageHours: number;
  highSignal: boolean;
}

/**
 * 结构化召回候选：直接携带时间戳与元数据，供 MemoryCortex/MemoryArbitrator
 * 做单层（按 domain τ 的）时间衰减与统一重排。
 * 此前 agentic 通道走「格式化文本 → 正则解析」往返，时间戳粒度退化到
 * 刚刚/小时/天，且在检索层多扣一次全局半衰期（与仲裁器的 domain 衰减重复）。
 */
export interface AgenticMemoryCandidate {
  content: string;
  score: number;
  highSignal: boolean;
  /** 记忆原始创建时间（ISO），缺失时缺省 */
  timestamp?: string;
  source?: string;
  context?: string;
}

function contextMatches(
  rawContext: unknown,
  want: "main" | "notes" | "any",
): boolean {
  if (want === "any") return true;
  // 旧数据 / 无 context 字段视为 "main"
  if (rawContext === undefined || rawContext === null) return want === "main";
  return rawContext === want;
}

function ageHoursOf(item: Mem0SearchItem, now: number): number {
  const ts = item.createdAt ?? item.updatedAt;
  if (typeof ts !== "string") return 0;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now - parsed) / 3_600_000);
}

function freshnessLabel(ageHours: number): string {
  return ageHours < 1
    ? "刚刚"
    : ageHours < 24
      ? `${Math.round(ageHours)}h前`
      : `${Math.round(ageHours / 24)}d前`;
}

function buildSearchFilters(
  actorId: string,
  context: "main" | "notes" | "any",
): Record<string, unknown> {
  const filters: Record<string, unknown> = { user_id: actorId };
  // 仅 notes 做下推：Qdrant/本地 store 均支持任意 payload 字段过滤，notes 大时
  // 不再白占 topK。main 不下推——旧数据 payload 无 context 字段，需靠后置
  // contextMatches 的「缺省视为 main」兼容逻辑兜住，不能在向量层把旧记忆排除掉。
  if (context === "notes") filters.context = "notes";
  return filters;
}

export class AgenticMemoryRetrievalService {
  constructor(private readonly memory: Memory) {}

  /**
   * 主流程使用的召回。默认仅查询 context=main（不混入笔记上下文）。
   * 跨上下文查询走 {@link buildCrossContextRecall}。
   *
   * 注意：本方法只做「原始分 × 高信号加成」的粗排与去重，
   * 不再做时间衰减——时间衰减统一由 MemoryArbitrator 按 domain τ 施加，
   * 避免稳定事实被两层衰减重复压制。
   */
  async buildRecall(actorId: string, queryText: string): Promise<string> {
    return this.buildRecallWithContext(actorId, queryText, { context: "main" });
  }

  async buildRecallWithContext(
    actorId: string,
    queryText: string,
    opts: { context: "main" | "notes" | "any" },
  ): Promise<string> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return "";

    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: buildSearchFilters(actorId, opts.context),
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = result.results ?? [];
    if (!items.length) return "";

    const now = Date.now();
    const highSignalBoost = getHighSignalBoost();

    const scored: ScoredItem[] = items
      .filter((item) => contextMatches(item.metadata?.context, opts.context))
      .map((item) => ({
        item,
        rawScore: item.score ?? 0,
        ageHours: ageHoursOf(item, now),
        highSignal: item.metadata?.highSignal === true,
      }))
      .map((s) => ({ ...s, rawScore: s.rawScore * (s.highSignal ? highSignalBoost : 1) }));

    if (!scored.length) return "";

    scored.sort((a, b) => b.rawScore - a.rawScore);

    const finalTopK = getAgenticMemoryTopK();
    const deduped = this.dedupeScoredItems(scored);
    const topItems = deduped.slice(0, finalTopK);

    const parts: string[] = [];
    for (let i = 0; i < topItems.length; i++) {
      const { item, rawScore, ageHours, highSignal } = topItems[i]!;
      const scorePercent = (rawScore * 100).toFixed(0);
      const src = typeof item.metadata?.source === "string" ? `[${item.metadata.source}]` : "";
      const ctxTag =
        opts.context === "any" && typeof item.metadata?.context === "string"
          ? ` [${item.metadata.context}]`
          : "";
      const signalTag = highSignal ? " ⭐高信号" : "";
      parts.push(
        `${i + 1}. 相关度 ${scorePercent}% · ${freshnessLabel(ageHours)}${signalTag}${ctxTag}${src ? ` ${src}` : ""}\n${item.memory}`,
      );
    }

    return `以下为 Mem0 记忆图联想检索（实体链接 + 多信号融合，可跨主题串联前因后果）：\n${parts.join("\n\n")}`;
  }

  /** 跨上下文查询（主 + 笔记）。用于主 Agent 显式查看笔记记忆。 */
  async buildCrossContextRecall(actorId: string, queryText: string): Promise<string> {
    return this.buildRecallWithContext(actorId, queryText, { context: "any" });
  }

  /**
   * 结构化召回：返回带原始时间戳的候选列表（已去重），供仲裁器统一重排。
   * MemoryCortex 主召回路径使用本方法替代「文本 → 正则解析」往返。
   */
  async searchStructured(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any" },
  ): Promise<AgenticMemoryCandidate[]> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return [];

    const context: "main" | "notes" | "any" = opts?.context ?? "main";
    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: buildSearchFilters(actorId, context),
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = (result.results ?? []).filter((item) =>
      contextMatches(item.metadata?.context, context),
    );
    if (!items.length) return [];

    const now = Date.now();
    const highSignalBoost = getHighSignalBoost();

    const scored: ScoredItem[] = items.map((item) => ({
      item,
      rawScore: (item.score ?? 0) * (item.metadata?.highSignal === true ? highSignalBoost : 1),
      ageHours: ageHoursOf(item, now),
      highSignal: item.metadata?.highSignal === true,
    }));
    scored.sort((a, b) => b.rawScore - a.rawScore);

    const deduped = this.dedupeScoredItems(scored);
    return deduped.map(({ item, rawScore }) => ({
      content: item.memory,
      score: rawScore,
      highSignal: item.metadata?.highSignal === true,
      ...(item.createdAt ?? item.updatedAt
        ? { timestamp: (item.createdAt ?? item.updatedAt) as string }
        : {}),
      ...(typeof item.metadata?.source === "string" ? { source: item.metadata.source } : {}),
      ...(typeof item.metadata?.context === "string" ? { context: item.metadata.context } : {}),
    }));
  }

  private dedupeScoredItems(items: ScoredItem[]): ScoredItem[] {
    const keepTexts = dedupeMemoryLines(
      items.map((item) => item.item.memory),
      { preferLatest: false },
    );
    const keep = new Set(keepTexts.map((line) => semanticFingerprint(line) || line));
    return items.filter(
      (item) => keep.has(semanticFingerprint(item.item.memory) || item.item.memory),
    );
  }
}
