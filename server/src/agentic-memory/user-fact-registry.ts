/**
 * 用户事实注册表（User Fact Registry）——身份类事实的唯一权威层。
 *
 * 解决的结构问题：此前用户身份事实（配偶/生日/居住地/职业…）以自由文本散落在
 * Mem0 / USER_PROFILE.md / KV memory_summary / 认知图四处，任何一处残留旧值
 * 都会被注入 prompt，与新值并存时模型随机站队（典型故障：用户说「我老婆是
 * 刘浩存」，下次问答又回到旧值「景甜」）。
 *
 * 本模块把身份事实原子化为 (attribute, value)：
 *   - attribute 来自受控词表（FACT_ATTRIBUTES），cardinality=single 的属性
 *     执行「属性级最新值权威」：新值写入与旧值 supersede 在同一事务内完成，
 *     任意时刻 getActiveFacts 只返回每个属性的当前值；
 *   - 值变更事件（applyFact 返回 changed=true + previous）由调用方（bootstrap
 *     钩子）级联作废 ledger 旧 claim / Mem0 旧记忆 / 画像旧行；
 *   - 注入侧用 renderForPrompt 渲染权威块、filterConflictingSegments 剔除
 *     其他记忆块里「断言已作废旧值」的行、matchAttributesInText 把问句直接
 *     寻址到当前值（不再依赖向量检索碰运气）。
 *
 * 隐私闭环：purgeActor 供 memory-clear-service 级联调用。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isUserFactRegistryEnabled } from "./env.js";
import { openAgenticSqlite } from "./sqlite-store.js";

/** 注册表内的规范化事实属性。labels 用于 LLM 抽取标签与文本同义词的双重归一。 */
export interface FactAttributeDef {
  key: string;
  /** 展示名（prompt 渲染 / 日志） */
  label: string;
  /** 归一同义词（含 LLM 可能输出的标签变体） */
  labels: string[];
}

export const FACT_ATTRIBUTES: readonly FactAttributeDef[] = [
  { key: "name", label: "名字", labels: ["名字", "姓名", "叫我", "全名", "大名"] },
  {
    key: "spouse",
    label: "配偶",
    labels: ["配偶", "老婆", "妻子", "媳妇", "爱人", "老公", "丈夫", "先生", "伴侣"],
  },
  { key: "father", label: "父亲", labels: ["父亲", "爸爸", "老爸", "我爸"] },
  { key: "mother", label: "母亲", labels: ["母亲", "妈妈", "老妈", "我妈"] },
  { key: "son", label: "儿子", labels: ["儿子"] },
  { key: "daughter", label: "女儿", labels: ["女儿"] },
  { key: "child", label: "孩子", labels: ["孩子", "小孩", "宝宝", "娃"] },
  {
    key: "sibling",
    label: "兄弟姐妹",
    labels: ["哥哥", "姐姐", "弟弟", "妹妹", "兄弟", "姐妹"],
  },
  { key: "birthday", label: "生日", labels: ["生日"] },
  { key: "hometown", label: "老家", labels: ["老家", "家乡", "故乡", "籍贯"] },
  { key: "location", label: "居住地", labels: ["居住地", "住在", "所在地", "坐标", "城市"] },
  { key: "job", label: "职业", labels: ["职业", "工作", "职位", "岗位", "干什么"] },
  { key: "employer", label: "公司", labels: ["公司", "单位", "雇主"] },
  { key: "school", label: "学校", labels: ["学校", "大学", "院校", "在读"] },
  { key: "pet", label: "宠物", labels: ["宠物", "猫", "狗"] },
];

export interface UserFact {
  id: string;
  actorId: string;
  /** 规范化属性键（FACT_ATTRIBUTES.key） */
  attribute: string;
  value: string;
  /** 抽取来源的原句（审计/展示） */
  rawClaim: string | null;
  sourceRef: string | null;
  confidence: number | null;
  createdAt: string;
  lastConfirmedAt: string;
}

interface UserFactRow {
  id: string;
  actor_id: string;
  attribute: string;
  value: string;
  raw_claim: string | null;
  source_ref: string | null;
  confidence: number | null;
  status: string;
  created_at: string;
  last_confirmed_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

export interface ApplyFactInput {
  actorId: string;
  /** LLM 抽取的属性标签（中文），内部归一到 FACT_ATTRIBUTES */
  attribute: string;
  value: string;
  rawClaim?: string | null;
  sourceRef?: string | null;
  confidence?: number | null;
}

export interface ApplyFactResult {
  /** true = 值发生变更（旧值已 supersede，调用方应级联作废）；false = 同值确认/touch */
  changed: boolean;
  fact: UserFact;
  /** 变更前的活跃值（changed=true 时非空） */
  previous: UserFact[];
}

export function factAttributeLabel(key: string): string {
  return FACT_ATTRIBUTES.find((a) => a.key === key)?.label ?? key;
}

function attributeSynonyms(key: string): string[] {
  const def = FACT_ATTRIBUTES.find((a) => a.key === key);
  return def ? [def.label, ...def.labels] : [key];
}

function clampConfidence(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

/** LLM 属性标签 → 规范化 key；词表外返回 null（该事实不进注册表，走普通记忆路径） */
export function normalizeFactAttribute(label: string): string | null {
  const t = label.trim();
  if (!t) return null;
  for (const def of FACT_ATTRIBUTES) {
    if (t === def.key || t === def.label || def.labels.includes(t)) return def.key;
  }
  // 兜底包含匹配（LLM 偶尔输出「配偶姓名」这类复合标签）
  for (const def of FACT_ATTRIBUTES) {
    if ([def.label, ...def.labels].some((l) => l.length >= 2 && (t.includes(l) || l.includes(t)))) {
      return def.key;
    }
  }
  return null;
}

function normalizeFactValue(value: string): string {
  return value.trim().replace(/[。．.！!？?~～\s]+$/g, "").trim();
}

function toFact(row: UserFactRow): UserFact {
  return {
    id: row.id,
    actorId: row.actor_id,
    attribute: row.attribute,
    value: row.value,
    rawClaim: row.raw_claim,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
}

let factIdSeq = 0;
function nextFactId(): string {
  factIdSeq = (factIdSeq + 1) % 100000;
  return `fact_${Date.now().toString(36)}_${factIdSeq.toString(36)}`;
}

export class UserFactRegistry {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_facts (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        raw_claim TEXT,
        source_ref TEXT,
        confidence REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_facts_actor_active
        ON user_facts(actor_id, attribute, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 属性级事务 upsert（single-cardinality 最新值权威）：
   *   - 同属性当前值 == 新值 → touch（更新确认时间/置信度），changed=false；
   *   - 否则旧活跃值全部 supersede + 新值插入（同一事务，读侧要么看到旧值要么看到新值）。
   * 词表外属性返回 null（调用方无需级联）。
   */
  applyFact(input: ApplyFactInput): ApplyFactResult | null {
    const actorId = input.actorId?.trim();
    const attribute = normalizeFactAttribute(input.attribute ?? "");
    const value = normalizeFactValue(input.value ?? "");
    if (!actorId || !attribute || !value || value.length > 60) return null;

    const now = new Date().toISOString();
    const run = this.db.transaction((): ApplyFactResult => {
      const actives = this.db
        .prepare(
          `SELECT * FROM user_facts
           WHERE actor_id = ? AND attribute = ? AND status = 'active'
           ORDER BY created_at ASC`,
        )
        .all(actorId, attribute) as UserFactRow[];

      const same = actives.find((r) => r.value === value);
      if (same) {
        this.db
          .prepare(
            `UPDATE user_facts SET last_confirmed_at = ?,
               confidence = COALESCE(?, confidence)
             WHERE id = ?`,
          )
          .run(now, clampConfidence(input.confidence), same.id);
        return {
          changed: false,
          fact: toFact({ ...same, last_confirmed_at: now }),
          previous: [],
        };
      }

      const id = nextFactId();
      this.db
        .prepare(
          `INSERT INTO user_facts
             (id, actor_id, attribute, value, raw_claim, source_ref, confidence,
              status, created_at, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          actorId,
          attribute,
          value,
          input.rawClaim?.trim() || null,
          input.sourceRef ?? null,
          clampConfidence(input.confidence),
          now,
          now,
        );
      for (const old of actives) {
        this.db
          .prepare(
            `UPDATE user_facts SET status = 'superseded', superseded_at = ?, superseded_by = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(now, id, old.id);
      }
      const inserted = this.db.prepare(`SELECT * FROM user_facts WHERE id = ?`).get(id) as UserFactRow;
      return { changed: true, fact: toFact(inserted), previous: actives.map(toFact) };
    });
    return run();
  }

  getActiveFacts(actorId: string): UserFact[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM user_facts
         WHERE actor_id = ? AND status = 'active'
         ORDER BY last_confirmed_at DESC`,
      )
      .all(actorId) as UserFactRow[];
    return rows.map(toFact);
  }

  getActiveFact(actorId: string, attribute: string): UserFact | null {
    const key = normalizeFactAttribute(attribute);
    if (!actorId || !key) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM user_facts
         WHERE actor_id = ? AND attribute = ? AND status = 'active'
         ORDER BY last_confirmed_at DESC LIMIT 1`,
      )
      .get(actorId, key) as UserFactRow | undefined;
    return row ? toFact(row) : null;
  }

  /** 各属性的历史值（已作废），供注入侧冲突行过滤。仅保留 ≥2 字值防单字误杀。 */
  getSupersededValuesByAttribute(actorId: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!actorId) return map;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT attribute, value FROM user_facts
         WHERE actor_id = ? AND status = 'superseded'`,
      )
      .all(actorId) as Array<{ attribute: string; value: string }>;
    for (const row of rows) {
      if (!row.value || row.value.length < 2) continue;
      const arr = map.get(row.attribute) ?? [];
      if (!arr.includes(row.value)) arr.push(row.value);
      map.set(row.attribute, arr);
    }
    return map;
  }

  /**
   * 问句直接寻址：userText 命中某属性的同义词（"我老婆是谁"→spouse）时
   * 返回对应活跃事实，供注入侧置顶（不依赖向量检索）。
   */
  matchAttributesInText(actorId: string, text: string): UserFact[] {
    const t = text?.trim();
    if (!t || t.length === 0) return [];
    const facts = this.getActiveFacts(actorId);
    return facts.filter((fact) =>
      attributeSynonyms(fact.attribute).some((label) => t.includes(label)),
    );
  }

  /**
   * 注入侧冲突过滤：剔除「断言了某属性已作废旧值、且不含当前值」的段/行。
   * 段粒度由调用方决定（召回条目按空行分段，KV/画像按行）。
   * 含当前值的段保留（如「从景甜换成刘浩存」同时含新旧值 → 保留）。
   */
  filterConflictingSegments(actorId: string, segments: string[]): string[] {
    if (segments.length === 0) return segments;
    const facts = this.getActiveFacts(actorId);
    if (facts.length === 0) return segments;
    const history = this.getSupersededValuesByAttribute(actorId);
    if (history.size === 0) return segments;

    return segments.filter((seg) => {
      if (!seg) return false;
      for (const [attribute, oldValues] of history) {
        const current = facts.find((f) => f.attribute === attribute);
        if (!current || seg.includes(current.value)) continue;
        if (oldValues.some((old) => seg.includes(old))) return false;
      }
      return true;
    });
  }

  /** 权威事实块渲染（注入侧直接使用；空返回 null 零注入） */
  renderForPrompt(actorId: string, groundedAttributes?: Set<string>): string | null {
    const facts = this.getActiveFacts(actorId);
    if (facts.length === 0) return null;
    const lines = facts.map((fact) => {
      const attrLabel = factAttributeLabel(fact.attribute);
      const confirmedAt = fact.lastConfirmedAt.slice(0, 10);
      const grounded = groundedAttributes?.has(fact.attribute)
        ? " ← 本轮提问相关，直接以此作答"
        : "";
      return `- ${attrLabel}：${fact.value}（${confirmedAt} 确认）${grounded}`;
    });
    return [
      "【用户核验事实】",
      "（以下为系统从对话中逐条核验登记的用户当前事实，是身份类信息的权威来源；",
      "与其他任何记忆、画像、检索结果或历史对话冲突时，一律以本块为准。",
      "仅当用户最新消息明确给出新值时以最新消息为准——此时系统会自动登记更新）",
      ...lines,
    ].join("\n");
  }

  /** actor 级清理（memory-clear-service 级联调用，隐私闭环） */
  purgeActor(actorId: string): number {
    if (!actorId) return 0;
    return this.db.prepare(`DELETE FROM user_facts WHERE actor_id = ?`).run(actorId).changes;
  }
}

export function createUserFactRegistryIfEnabled(db?: SqliteDatabase): UserFactRegistry | null {
  if (!isUserFactRegistryEnabled()) return null;
  return new UserFactRegistry(db);
}
