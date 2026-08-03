// Agent Brain Center — MemoryProceduralAutomation（程序性学习与自动化）
//
// 职责：将已学会的显性技能转化为绕过 LLM 的自动技能，支持热更新。
//   - SkillPromotionPipeline 装载 skill 后调用 registerProceduralSkill 写入 procedural 域
//   - BrainCenter.cognize 入口先调 matchProceduralSkill，命中（>阈值）直接执行，跳过 LLM
//   - 同 skillId 重新注册时标记旧版本 superseded=true，hotUpdateVersion 自增，保留回退能力
//
// 设计要点：
//   - 不调 LLM，纯规则匹配（Jaccard 相似度）
//   - 不直接依赖 SkillManager 具体实现，通过 SkillManagerLike 外观接口结构兼容
//   - 主开关 BRAIN_MEMORY_PROCEDURAL_ENABLED 缺省开启；关闭后所有方法空操作

import type { ProceduralMatch } from "../types.js";

// ---- 外观接口（结构兼容 SkillManager，不直接依赖具体实现）----

/** SkillManager 的最小化外观接口（结构兼容即可） */
export interface SkillManagerLike {
  /** 注册并装载 skill，返回是否成功 */
  registerFromCode(
    metadata: SkillMetadataLike,
    handlerCode: string,
    opts?: { autoEnable?: boolean },
  ): { ok: boolean; error?: string };
}

/** Skill 元数据外观（结构兼容 SkillMetadata 的子集） */
export interface SkillMetadataLike {
  name: string;
  description: string;
  /** 触发模式（关键词列表） */
  triggerKeywords?: string[];
  /** skill handler 引用（注册时为函数） */
  handlerRef?: unknown;
}

/** 完整 Skill 元数据外观（含 id 与 version） */
export interface SkillMetadataLikeFull extends SkillMetadataLike {
  id: string;
  version: string;
}

// ---- 内部存储结构 ----

/** procedural 记忆条目 */
export interface ProceduralMemoryEntry {
  /** 技能 id（与 skillId 一致） */
  skillId: string;
  /** 触发模式：关键词列表 */
  triggerPattern: string[];
  /** skill handler 引用（用于绕过 LLM 直接执行） */
  handlerRef: unknown;
  /** 热更新版本号 */
  hotUpdateVersion: number;
  /** 是否被新版本取代 */
  superseded: boolean;
  /** metadata 快照 */
  metadata: SkillMetadataLikeFull;
  /** 注册时间 */
  registeredAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

// ---- 常量 ----

/** 主开关环境变量名 */
const ENV_ENABLED = "BRAIN_MEMORY_PROCEDURAL_ENABLED";
/** 匹配阈值环境变量名 */
const ENV_MATCH_THRESHOLD = "BRAIN_MEMORY_PROCEDURAL_MATCH_THRESHOLD";

/** 默认匹配阈值 */
const DEFAULT_MATCH_THRESHOLD = 0.8;

// ---- 辅助函数 ----

/** 将数值夹紧到 [0, 1]；非有限值归零 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** 四舍五入到 4 位小数，消除浮点噪声，保证决策与断言稳定 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 从 metadata 提取触发模式：优先 triggerKeywords，缺省从 description 切词 */
function extractTriggerPattern(metadata: SkillMetadataLikeFull): string[] {
  if (metadata.triggerKeywords && metadata.triggerKeywords.length > 0) {
    return metadata.triggerKeywords.filter(
      (kw) => typeof kw === "string" && kw.length > 0,
    );
  }
  const desc = metadata.description || "";
  // 按空格与中英文标点切分
  return desc
    .split(/[\s,，。.!！?？;；:：、]+/)
    .filter((t) => t.length > 0);
}

/**
 * 计算 matchScore（Jaccard 相似度）。
 *
 * - 集合 A = triggerPattern 关键词（小写归一）
 * - 集合 B = query 切分后的 token（小写归一）
 * - 交集 = A 中作为子串出现在 query 中的关键词
 * - 并集 = A ∪ (B 中未被 A 覆盖的 token)
 * - matchScore = |交集| / |并集|
 *
 * 对中文无分词场景，子串匹配保证 "预算" 能命中 "帮我做预算计算"。
 */
function computeMatchScore(triggerPattern: string[], query: string): number {
  if (triggerPattern.length === 0) return 0;
  const queryLower = query.toLowerCase();
  const triggerSet = new Set(
    triggerPattern.map((kw) => kw.toLowerCase()).filter((kw) => kw.length > 0),
  );
  if (triggerSet.size === 0) return 0;

  // 交集：triggerSet 中作为子串出现在 query 中的关键词
  const intersection = new Set<string>();
  for (const kw of triggerSet) {
    if (queryLower.includes(kw)) {
      intersection.add(kw);
    }
  }
  if (intersection.size === 0) return 0;

  // 并集：triggerSet ∪ queryTokens 中未被 triggerSet 覆盖的 token
  const queryTokens = queryLower
    .split(/[\s,，。.!！?？;；:：、]+/)
    .filter((t) => t.length > 0);
  const extraTokens = new Set<string>();
  for (const token of queryTokens) {
    let covered = false;
    for (const kw of triggerSet) {
      // token 被 kw 覆盖：互为子串
      if (token.includes(kw) || kw.includes(token)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      extraTokens.add(token);
    }
  }

  const unionSize = triggerSet.size + extraTokens.size;
  return unionSize === 0 ? 0 : intersection.size / unionSize;
}

// ---- 主类 ----

/**
 * 程序性学习与自动化：将已学会的技能转化为绕过 LLM 的自动技能。
 *
 * 不调 LLM，纯规则匹配（Jaccard 相似度）。
 * 主开关 BRAIN_MEMORY_PROCEDURAL_ENABLED 缺省开启；关闭后所有方法空操作。
 */
export class MemoryProceduralAutomation {
  /** procedural 记忆条目（含历史版本） */
  private readonly entries: ProceduralMemoryEntry[] = [];

  // ---- 配置读取 ----

  /** 主开关是否开启（缺省开启） */
  private isEnabled(): boolean {
    const raw = process.env[ENV_ENABLED]?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return false;
    return true;
  }

  /** 读取匹配阈值（缺省 0.8） */
  private getMatchThreshold(): number {
    const raw = process.env[ENV_MATCH_THRESHOLD];
    const v = raw != null ? Number(raw) : NaN;
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_MATCH_THRESHOLD;
  }

  // ---- 公开 API ----

  /**
   * 注册技能到 procedural 域。
   *
   * - 若已存在同 skillId 的旧版本：标记旧版本 superseded=true，hotUpdateVersion 自增
   * - 新写入条目：{ skillId, triggerPattern, handlerRef, hotUpdateVersion, superseded: false, ... }
   * - triggerPattern 优先从 metadata.triggerKeywords 取，缺省从 description 切词
   * - 不调 LLM
   */
  registerProceduralSkill(skill: {
    metadata: SkillMetadataLikeFull;
    handlerCode?: string;
    handlerRef?: unknown;
  }): { ok: boolean; error?: string } {
    if (!this.isEnabled()) {
      return { ok: false, error: "procedural automation disabled" };
    }

    const { metadata, handlerRef } = skill;
    if (!metadata || !metadata.id) {
      return { ok: false, error: "metadata.id 缺失" };
    }

    const skillId = metadata.id;
    const triggerPattern = extractTriggerPattern(metadata);

    // 标记同 skillId 的旧版本为 superseded，并找到最大版本号
    const now = new Date().toISOString();
    let maxVersion = 0;
    for (const entry of this.entries) {
      if (entry.skillId === skillId) {
        entry.superseded = true;
        entry.updatedAt = now;
        if (entry.hotUpdateVersion > maxVersion) {
          maxVersion = entry.hotUpdateVersion;
        }
      }
    }

    const nextVersion = maxVersion + 1;
    const entry: ProceduralMemoryEntry = {
      skillId,
      triggerPattern,
      handlerRef: handlerRef ?? metadata.handlerRef,
      hotUpdateVersion: nextVersion,
      superseded: false,
      metadata,
      registeredAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);

    return { ok: true };
  }

  /**
   * 匹配技能：遍历所有未 superseded 的条目，返回 matchScore 最高的匹配。
   *
   * - matchScore > 阈值（缺省 0.8）时返回 ProceduralMatch
   * - canBypassLlm = matchScore > 阈值（命中即绕过 LLM）
   * - 未命中返回 null
   * - 不调 LLM
   */
  matchProceduralSkill(query: string): ProceduralMatch | null {
    if (!this.isEnabled()) return null;
    if (typeof query !== "string" || query.length === 0) return null;

    const threshold = this.getMatchThreshold();
    let best: { entry: ProceduralMemoryEntry; score: number } | null = null;

    for (const entry of this.entries) {
      if (entry.superseded) continue;
      const score = round4(clamp01(computeMatchScore(entry.triggerPattern, query)));
      if (score > threshold) {
        if (best === null || score > best.score) {
          best = { entry, score };
        }
      }
    }

    if (best === null) return null;

    return {
      skillId: best.entry.skillId,
      matchScore: best.score,
      canBypassLlm: true,
      triggerPattern: best.entry.triggerPattern.join(","),
      hotUpdateVersion: best.entry.hotUpdateVersion,
      matchedAt: new Date().toISOString(),
    };
  }

  /**
   * 判断是否可绕过 LLM：调用 matchProceduralSkill，返回 canBypassLlm。
   */
  isAutomatable(query: string): boolean {
    if (!this.isEnabled()) return false;
    const match = this.matchProceduralSkill(query);
    return match !== null && match.canBypassLlm;
  }

  /**
   * 直接执行技能（绕过 LLM）。
   *
   * - 调用 matchProceduralSkill 命中后执行 handlerRef
   * - handlerRef 不是函数时返回 error
   * - 返回执行结果
   */
  async executeProceduralSkill(
    query: string,
    args?: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.isEnabled()) {
      return { ok: false, error: "procedural automation disabled" };
    }

    const match = this.matchProceduralSkill(query);
    if (match === null) {
      return { ok: false, error: "no matching procedural skill" };
    }

    // 找到对应条目（matchProceduralSkill 已确认存在且未 superseded）
    const entry = this.entries.find(
      (e) =>
        e.skillId === match.skillId &&
        e.hotUpdateVersion === match.hotUpdateVersion &&
        !e.superseded,
    );
    if (!entry) {
      return {
        ok: false,
        error: `procedural entry not found: ${match.skillId}@${match.hotUpdateVersion}`,
      };
    }

    const handler = entry.handlerRef;
    if (typeof handler !== "function") {
      return { ok: false, error: "handlerRef is not a function" };
    }

    try {
      const result = await (handler as (args?: Record<string, unknown>) => unknown | Promise<unknown>)(args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 获取所有活跃 procedural 技能（未 superseded），供调试/监控。
   */
  getActiveProceduralSkills(): ProceduralMemoryEntry[] {
    if (!this.isEnabled()) return [];
    return this.entries.filter((e) => !e.superseded);
  }

  /**
   * 获取指定 skillId 被取代的历史版本，供回退。
   */
  getSupersededHistory(skillId: string): ProceduralMemoryEntry[] {
    if (!this.isEnabled()) return [];
    return this.entries.filter((e) => e.skillId === skillId && e.superseded);
  }
}
