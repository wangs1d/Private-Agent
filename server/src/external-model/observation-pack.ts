/**
 * ObservationPack：大体积工具结果的句柄化存储 + obs_recall 分页读回。
 *
 * 借鉴 NVlabs/SoL-Pi 的 ObservationPack 机制（MIT）：
 * 工具结果被 compactToolOutputForLlm 压缩 / foldOldWaveToolChains 折叠后，原文此前
 * 永久离开模型上下文——模型需要细节时只能重新执行原工具（再付一次延迟与费用，
 * 且非幂等工具有副作用风险）。本模块在压缩发生时把完整原文归档为稳定句柄
 * （obs_N），并暴露 obs_recall 工具按 offset/limit 分页读回：
 *  - 归档在压缩点（openai-compatible-tool-loop 主执行路径）完成，附一行读回提示；
 *  - replan 折叠摘要逐行追加句柄标注，模型可按句柄回读旧波原文；
 *  - 存储有上限（条数 / 总字符 / 会话数），超限 FIFO 淘汰最旧条目；
 *  - 读不到（句柄失效/不存在）时返回可恢复错误，模型重跑原工具即可，无静默丢数据。
 *
 * 执行位置：obs_recall 与 tool_search 桥接同属循环层元工具——在
 * streamCompletionWithTools 的执行器分发处直接服务，不进 ToolRegistry、
 * 不走超时竞速与确定性重试管线（读回是纯内存切片）。
 */

/** obs_recall 的注册表名（无 `.`，API 名与注册表名一致）。 */
export const OBS_RECALL_TOOL_NAME = "obs_recall";

/** 原文低于该字符数不归档（读回价值不足以抵消提示 token）。 */
const OBS_PACK_ARCHIVE_MIN_CHARS = 2_000;
/** 压缩节省低于该字符数不归档（内容几乎无损时提示是纯噪音）。 */
const OBS_PACK_HINT_MIN_SAVED_CHARS = 600;
/** 单次读回默认/上限字符数（对齐 replan 折叠预算的数量级，防止一次读回爆上下文）。 */
const OBS_RECALL_DEFAULT_LIMIT_CHARS = 4_000;
const OBS_RECALL_MAX_LIMIT_CHARS = 12_000;
/** 单个 pack 的容量上限：条数与总字符。超限 FIFO 淘汰最旧条目。 */
const OBS_PACK_MAX_ENTRIES = 32;
const OBS_PACK_MAX_TOTAL_CHARS = 400_000;
/** 跨轮复用的 pack 按 session 缓存的容量上限（LRU 插入序淘汰）。 */
const SESSION_PACK_MAX = 32;

export interface ArchivedObservation {
  id: string;
  toolName: string;
  /** 完整原文（compactToolOutputForLlm 的 rawText，即 strip 后的 JSON 序列化文本）。 */
  text: string;
  chars: number;
  /** 归档时的 tool_call_id（折叠摘要按它反查句柄；桥接路径可能没有）。 */
  toolCallId?: string;
  archivedAt: number;
}

export type ObsRecallOutcome =
  | {
      ok: true;
      result: {
        id: string;
        tool: string;
        totalChars: number;
        offset: number;
        returnedChars: number;
        /** null 表示已到末尾；否则提示模型用该 offset 继续。 */
        nextOffset: number | null;
        text: string;
      };
    }
  | { ok: false; error: string };

export class ObservationPack {
  private seq = 0;
  private readonly entries = new Map<string, ArchivedObservation>();
  private readonly byToolCallId = new Map<string, string>();
  private totalChars = 0;

  /** 当前已归档条数（测试与诊断用）。 */
  get size(): number {
    return this.entries.size;
  }

  get totalArchivedChars(): number {
    return this.totalChars;
  }

  /**
   * 归档一条完整原文。低于阈值或参数非法返回 null（调用方不发提示）。
   * 容量超限时 FIFO 淘汰最旧条目，保证长会话后续轮次仍可归档。
   */
  archive(toolName: string, toolCallId: string | undefined, rawText: string): ArchivedObservation | null {
    if (typeof rawText !== "string" || rawText.length < OBS_PACK_ARCHIVE_MIN_CHARS) return null;
    while (
      this.entries.size + 1 > OBS_PACK_MAX_ENTRIES ||
      this.totalChars + rawText.length > OBS_PACK_MAX_TOTAL_CHARS
    ) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) return null; // 单条即超总上限等极端情况：放弃归档
      this.dropEntry(oldestId);
    }
    const id = `obs_${++this.seq}`;
    const entry: ArchivedObservation = {
      id,
      toolName,
      text: rawText,
      chars: rawText.length,
      ...(toolCallId ? { toolCallId } : {}),
      archivedAt: Date.now(),
    };
    this.entries.set(id, entry);
    this.totalChars += entry.chars;
    if (toolCallId) this.byToolCallId.set(toolCallId, id);
    return entry;
  }

  /** 按 tool_call_id 反查句柄（折叠摘要标注用）。 */
  idForToolCall(toolCallId: string): string | undefined {
    return this.byToolCallId.get(toolCallId);
  }

  /**
   * 分页读回。offset/limit 做防御性归一（负数/浮点/越界），切片不劈开
   * surrogate pair（emoji 等增补平面字符），返回值携带 nextOffset 供续页。
   */
  recall(args: unknown): ObsRecallOutcome {
    const parsedId =
      args && typeof args === "object" && typeof (args as { id?: unknown }).id === "string"
        ? (args as { id: string }).id.trim()
        : "";
    if (!parsedId) {
      return { ok: false, error: this.unknownIdError("", "缺少必填参数 id（形如 obs_1）") };
    }
    const entry = this.entries.get(parsedId);
    if (!entry) {
      return { ok: false, error: this.unknownIdError(parsedId) };
    }
    const rawOffset = (args as { offset?: unknown }).offset;
    const rawLimit = (args as { limit?: unknown }).limit;
    let offset = Number.parseInt(String(rawOffset ?? "0"), 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    let limit = Number.parseInt(String(rawLimit ?? OBS_RECALL_DEFAULT_LIMIT_CHARS), 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = OBS_RECALL_DEFAULT_LIMIT_CHARS;
    limit = Math.min(limit, OBS_RECALL_MAX_LIMIT_CHARS);

    const clampedOffset = Math.min(offset, entry.chars);
    const slice = safeSliceText(entry.text, clampedOffset, clampedOffset + limit);
    const nextOffset = slice.end < entry.chars ? slice.end : null;
    return {
      ok: true,
      result: {
        id: entry.id,
        tool: entry.toolName,
        totalChars: entry.chars,
        offset: slice.start,
        returnedChars: slice.text.length,
        nextOffset,
        text: slice.text,
      },
    };
  }

  private dropEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalChars -= entry.chars;
    if (entry.toolCallId && this.byToolCallId.get(entry.toolCallId) === id) {
      this.byToolCallId.delete(entry.toolCallId);
    }
  }

  private unknownIdError(id: string, prefix?: string): string {
    const available = [...this.entries.keys()];
    const availableText = available.length
      ? `当前可读回的句柄：${available.slice(-8).join(", ")}。`
      : "当前没有可读回的结果（本轮会话尚无被归档的大结果）。";
    const head = prefix ?? `obs 句柄不存在或已失效（可能来自更早的会话）：${id}。`;
    return `${head}${availableText}若所需内容已无法读回，请重新调用原工具获取。`;
  }
}

/**
 * surrogate pair 安全切片：起止点若落在增补平面字符（如 emoji）中间，回退一位，
 * 被让出的半个字符归入下一页，保证每次读回的 text 都可安全编码。
 */
export function safeSliceText(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (s > 0 && s < text.length && isHigh(text.charCodeAt(s - 1)) && isLow(text.charCodeAt(s))) {
    s -= 1;
  }
  if (e > s && e < text.length && isHigh(text.charCodeAt(e - 1)) && isLow(text.charCodeAt(e))) {
    e -= 1;
  }
  return { text: text.slice(s, e), start: s, end: e };
}

/**
 * 压缩点调用：原文足够大 且 压缩确实省了足够多字符 才归档。
 * 返回 null 表示不值得归档（调用方不发提示、不占容量）。
 */
export function archiveIfWorthwhile(
  pack: ObservationPack,
  toolName: string,
  toolCallId: string | undefined,
  rawText: string | undefined,
  compactedContent: string | undefined,
): ArchivedObservation | null {
  if (!rawText) return null;
  const saved = rawText.length - (compactedContent?.length ?? 0);
  if (saved < OBS_PACK_HINT_MIN_SAVED_CHARS) return null;
  return pack.archive(toolName, toolCallId, rawText);
}

/** 追加在压缩后 tool 消息尾部的读回提示（一行，~70 字符）。 */
export function buildObservationRecallHint(obs: ArchivedObservation): string {
  return (
    `[obs_recall 可用] 本条结果已压缩（原文 ${obs.chars} 字符）。` +
    `需要更多细节时调用 obs_recall(id="${obs.id}", offset=0, limit=4000) 分页读回原文，不要重新执行原工具。`
  );
}

// ── 会话级复用：同一 session 的后续对话轮可读回此前轮次归档的结果 ──
// （只读回、不跨轮重建上下文；容量上限防长会话内存膨胀。）
const sessionPacks = new Map<string, ObservationPack>();

export function getObservationPack(sessionId?: string): ObservationPack {
  if (!sessionId) return new ObservationPack();
  const existing = sessionPacks.get(sessionId);
  if (existing) return existing;
  const pack = new ObservationPack();
  sessionPacks.set(sessionId, pack);
  if (sessionPacks.size > SESSION_PACK_MAX) {
    const oldest = sessionPacks.keys().next().value;
    if (oldest !== undefined) sessionPacks.delete(oldest);
  }
  return pack;
}

/** 测试专用：清空会话 pack 缓存。 */
export function resetObservationPacksForTest(): void {
  sessionPacks.clear();
}
