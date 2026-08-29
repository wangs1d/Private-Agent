// ProactivitySuppressionStore —— 主动触达负反馈抑制表（Task 20 统一频控框架）
//
// 背景：用户说「别再提醒我这个」「别给我推刘浩存了」这类负反馈时，仅靠
// FrequencyGovernor 的冷却（时间维度）挡不住——冷却到期后同类触达会再次
// 打扰。需要一个「用户意愿维度」的持久抑制：kind 级（整个类别不再推）
// 或关键词级（该 kind 下命中关键词的内容不再推）。
//
// 设计（复用 memory-strength-model 的反馈持久化模式，轻量化）：
//  - 每 actor 一个 JSON 文件：data/proactivity-suppression/{actorId}.json
//  - 内存缓存 + 懒加载：load() 读目录全量入内存，isSuppressed() 纯同步
//    （hub 发送前热路径零 IO）；变更时单 actor 落盘
//  - 失败静默降级：读写失败不抛出到主链路（抑制表是锦上添花，不是闸门）
//
// 匹配语义：
//  - 条目无关键词（keywords 空）→ 抑制整个 kind
//  - 条目有关键词 → kind 匹配且触达文本（标题+摘要）包含任一关键词才抑制
//  - text 未提供时只有 kind 级条目能命中（关键词无法判定，宁漏勿错杀）
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 一条抑制记录（用户一次「别再提醒」负反馈的持久化） */
export interface SuppressionEntry {
  id: string;
  actorId: string;
  /** 抑制的主动触达 kind（如 interest_alert / life_reminder / weather_alert） */
  kind: string;
  /** 关键词（空数组 = 抑制整个 kind；非空 = kind+关键词双匹配才抑制） */
  keywords: string[];
  /** 用户原话/场景摘要（审计用，帮助理解当时为什么被抑制） */
  note?: string;
  createdAt: string;
}

/** 抑制命中详情（日志/诊断用） */
export interface SuppressionMatch {
  suppressed: boolean;
  /** 命中的条目 id（suppressed=false 时为 null） */
  matchedId: string | null;
  /** 人读原因（suppressed=false 时为空串） */
  reason: string;
}

/** 每 actor 抑制条数上限（防膨胀；超限淘汰最旧的） */
const MAX_ENTRIES_PER_ACTOR = 50;

type PersistedShape = { entries?: SuppressionEntry[] };

/** 规范化关键词：去空白、去重、丢空串，统一小写（英文匹配不区分大小写） */
function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    const kw = String(item ?? "").trim().toLowerCase();
    if (kw) seen.add(kw);
  }
  return Array.from(seen);
}

/** 单条持久化数据容错解析 */
function parseEntry(value: unknown, expectActor?: string): SuppressionEntry | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const actorId = typeof o.actorId === "string" ? o.actorId : "";
  if (!actorId || (expectActor && actorId !== expectActor)) return null;
  const kind = typeof o.kind === "string" ? o.kind.trim() : "";
  if (!kind) return null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : randomUUID(),
    actorId,
    kind,
    keywords: normalizeKeywords(o.keywords),
    note: typeof o.note === "string" ? o.note.slice(0, 200) : undefined,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
  };
}

export class ProactivitySuppressionStore {
  /** actorId → 抑制条目（内存缓存，isSuppressed 同步查） */
  private readonly entries = new Map<string, SuppressionEntry[]>();
  private readonly dirPath: string;

  constructor(opts?: { dirPath?: string }) {
    this.dirPath = opts?.dirPath ?? process.env.PROACTIVITY_SUPPRESSION_DIR ?? "data/proactivity-suppression";
  }

  /** 启动时全量加载目录下所有 actor 文件（ENOENT 静默跳过） */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dirPath);
    } catch {
      return; // 目录不存在 = 无历史抑制，冷启动
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const actorId = file.slice(0, -".json".length);
      if (!actorId) continue;
      try {
        const raw = await readFile(join(this.dirPath, file), "utf8");
        const data = JSON.parse(raw) as PersistedShape;
        const list: SuppressionEntry[] = [];
        for (const item of data.entries ?? []) {
          const entry = parseEntry(item, actorId);
          if (entry) list.push(entry);
        }
        this.entries.set(actorId, list);
      } catch {
        /* 单文件损坏跳过，不影响其他 actor */
      }
    }
  }

  /** 单 actor 落盘（变更时调用；失败静默——内存态仍生效，下次重启丢失可接受） */
  private async persist(actorId: string): Promise<void> {
    try {
      await mkdir(this.dirPath, { recursive: true });
      const payload: PersistedShape = { entries: this.entries.get(actorId) ?? [] };
      await writeFile(
        join(this.dirPath, `${actorId}.json`),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    } catch (err) {
      console.log(`[SuppressionStore] 落盘失败（忽略，内存态仍生效）actor=${actorId}: ${err}`);
    }
  }

  /**
   * 记录一条负反馈抑制。
   * @param kind 要抑制的触达类别（必填）
   * @param keywords 关键词（空/缺省 = 抑制整个 kind）
   * @param note 用户原话/场景摘要（审计）
   */
  async add(
    actorId: string,
    kind: string,
    keywords?: unknown,
    note?: unknown,
  ): Promise<SuppressionEntry[]> {
    const kindNorm = String(kind ?? "").trim();
    if (!kindNorm) throw new Error("缺少要抑制的触达类别 (kind)");
    if (!actorId) throw new Error("缺少 actorId");
    const list = this.entries.get(actorId) ?? [];
    const kws = normalizeKeywords(keywords);

    // 同 kind 同关键词集合的条目直接合并续期（避免重复负反馈堆条目）
    const fingerprint = `${kindNorm}|${kws.sort().join(",")}`;
    const existing = list.find(
      (e) => `${e.kind}|${[...e.keywords].sort().join(",")}` === fingerprint,
    );
    if (existing) {
      existing.createdAt = new Date().toISOString();
      if (typeof note === "string" && note.trim()) existing.note = note.trim().slice(0, 200);
    } else {
      const entry: SuppressionEntry = {
        id: randomUUID(),
        actorId,
        kind: kindNorm,
        keywords: kws,
        note: typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : undefined,
        createdAt: new Date().toISOString(),
      };
      list.push(entry);
      // 超限淘汰最旧（负反馈意愿最新优先）
      if (list.length > MAX_ENTRIES_PER_ACTOR) {
        list.splice(0, list.length - MAX_ENTRIES_PER_ACTOR);
      }
    }
    this.entries.set(actorId, list);
    await this.persist(actorId);
    return this.list(actorId);
  }

  /**
   * 解除抑制（用户改主意：「可以继续提醒我了」）。
   * @param target 条目 id 或 kind（传 kind 时清掉该 kind 的全部抑制条目）
   */
  async remove(actorId: string, target: unknown): Promise<SuppressionEntry[]> {
    const raw = String(target ?? "").trim();
    if (!raw) throw new Error("需要提供要解除的抑制条目 id 或 kind");
    const list = this.entries.get(actorId) ?? [];
    const before = list.length;
    const rest = list.filter((e) => e.id !== raw && e.kind !== raw);
    if (rest.length !== before) {
      this.entries.set(actorId, rest);
      await this.persist(actorId);
    }
    return this.list(actorId);
  }

  /** 该 actor 的抑制条目列表（诊断/HTTP 查询用） */
  list(actorId: string): SuppressionEntry[] {
    return [...(this.entries.get(actorId) ?? [])];
  }

  /**
   * 发送前检查：一次主动触达是否被用户负反馈抑制。
   * @param text 触达文本（标题+摘要拼接；关键词级条目在此匹配）
   */
  isSuppressed(actorId: string, kind: string, text?: string): SuppressionMatch {
    const list = this.entries.get(actorId);
    if (!list || list.length === 0) return { suppressed: false, matchedId: null, reason: "" };
    const textLower = text ? text.toLowerCase() : null;
    for (const entry of list) {
      if (entry.kind !== kind) continue;
      // kind 级条目（无关键词）：整类抑制
      if (entry.keywords.length === 0) {
        return {
          suppressed: true,
          matchedId: entry.id,
          reason: `kind_suppressed(${kind},since=${entry.createdAt.slice(0, 10)})`,
        };
      }
      // 关键词级条目：kind + 关键词双匹配（无文本时无法判定，跳过）
      if (textLower && entry.keywords.some((kw) => textLower.includes(kw))) {
        return {
          suppressed: true,
          matchedId: entry.id,
          reason: `keyword_suppressed(${kind},${entry.keywords.join("/")})`,
        };
      }
    }
    return { suppressed: false, matchedId: null, reason: "" };
  }
}
