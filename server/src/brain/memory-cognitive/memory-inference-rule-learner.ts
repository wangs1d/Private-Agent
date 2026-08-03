// Agent Brain Center — RuleLearner（规则自学习）
//
// 职责：让 agent 从历史记忆中自动归纳新规则，而不是靠人写死规则。
//   扫描记忆图中所有节点，挖掘频繁共现的关键词对，
//   当某对关键词在 >= minCoOccurrence 个节点中同时出现，
//   且这对关键词不在任何已有规则的 requiredTags 中，自动生成新规则。
//
// 核心原则：
//   1. 算法为主：纯算法统计共现频次（不依赖 LLM 也能工作）
//   2. LLM 增强（可选）：若注入 llmInducer，把候选关键词对喂给 LLM 归纳因果模板
//      - LLM 归纳成功 → 因果模板（置信度高）
//      - LLM 归纳失败 / 未注入 → 降级到 N-gram 模板（共现陈述，置信度低）
//   3. 去重：已学过的规则不重复学习（用 requiredTags 排序后 hash 去重）
//   4. 热更新：新规则立即可用于推理，无需重启
//   5. 限流：单次 learnRules 最多注册 MAX_NEW_RULES_PER_CALL 条新规则（避免规则爆炸）
//   6. 可验证状态机升级：被验证后 baseConfidence +0.1（由 engine.markVerified 触发）
//
// LLM 参与边界：LLM 只参与"学规则"，不参与"用规则推理"。
//   - 学规则（一次性，可审计）：LLM 从共现对归纳因果模板
//   - 推理（每次推理）：仍是程序化算法 matchRule + fillTemplate，不调 LLM
//
// 详见 task: 4 项仿人推理能力新增 + LLM 规则归纳器扩展

import type {
  HumanLikeMemoryInferenceLike,
  InferenceRule,
  MemoryInferenceEngine,
} from "./memory-inference-engine.js";
import type { LLMRuleInducer, LLMInducedRule } from "./memory-inference-llm-inducer.js";

// ============================================================
// 类型
// ============================================================

/**
 * 自学习规则：从历史记忆中归纳出的新规则。
 *
 * - learned: true 标记，可被验证状态机升级（被验证后 baseConfidence +0.1）
 * - coOccurrenceCount: 该规则基于的共现次数
 * - learnedAt: 学习时间
 * - inducedBy: 规则来源标记
 *   - "algorithm"：纯 N-gram 共现统计归纳（共现陈述，置信度低）
 *   - "llm"：LLM 从共现对归纳的因果模板（因果陈述，置信度高）
 */
export interface LearnedRule extends InferenceRule {
  learned: true;
  coOccurrenceCount: number;
  learnedAt: string;
  inducedBy?: "algorithm" | "llm";
}

// ============================================================
// 常量
// ============================================================

/** 单次 learnRules 最多注册的新规则数（限流，避免规则爆炸） */
const MAX_NEW_RULES_PER_CALL = 5;
/** 默认最小共现次数：关键词对至少在 N 个节点中同时出现才学习 */
const DEFAULT_MIN_CO_OCCURRENCE = 3;
/** 自学习规则的基础置信度（未经验证，较低） */
const LEARNED_RULE_BASE_CONFIDENCE = 0.4;
/** 验证后置信度提升 */
const VERIFIED_CONFIDENCE_BONUS = 0.1;

// ============================================================
// 工具函数
// ============================================================

/** FNV-1a 32 位哈希（用于规则去重） */
function fnv1aHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 生成规则去重 key：把 requiredTags 排序后 hash。
 * 同一组关键词对（无论顺序）生成相同 key，保证去重一致性。
 */
function ruleDedupKey(tagA: string, tagB: string): string {
  const sorted = [tagA, tagB].sort().join("|");
  return fnv1aHash(sorted);
}

/** 转义正则特殊字符，用于把关键词安全嵌入 RegExp */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 生成宽松匹配正则：允许 tag 字符之间有其他字符。
 *
 * 例如 tag="加群" → 正则 /加.*群/，能匹配"加一个群"。
 * 对单字符 tag 直接精确匹配。
 * 对含英文/数字的 tag 保持精确匹配（避免误匹配）。
 */
function loosePattern(tag: string): RegExp {
  const escaped = escapeRegex(tag);
  // 纯中文且长度 >= 2：字符间允许有其他字符
  if (/^[\u4e00-\u9fa5]{2,}$/.test(tag)) {
    const chars = tag.split("").map(escapeRegex);
    return new RegExp(chars.join(".*"));
  }
  return new RegExp(escaped);
}

// ============================================================
// RuleLearner 主类
// ============================================================

/**
 * 规则自学习器：从历史记忆中自动归纳新规则。
 *
 * 算法：
 *   1. 扫描记忆图中所有节点（humanLike.getAllNodes）
 *   2. 挖掘频繁共现的关键词对（pair co-occurrence frequency）
 *   3. 当某对关键词在 >= minCoOccurrence 个节点中同时出现，
 *      且这对关键词不在任何已有规则的 requiredTags 中，自动生成新规则
 *   4. 若 llmInducer 已注入：把候选对 + 相关节点 summary 喂给 LLM 归纳因果模板
 *      - LLM 归纳成功 → 因果模板（inducedBy: "llm"）
 *      - LLM 归纳失败 / 未注入 → 降级 N-gram 模板 "出现{A}时可能涉及{B}"（inducedBy: "algorithm"）
 *   5. baseConfidence：算法 0.4，LLM 归纳 0.55（仍属未验证）
 *
 * LLM 只参与"学规则"，不参与"用规则推理"。
 */
export class RuleLearner {
  private readonly humanLike: HumanLikeMemoryInferenceLike;
  private readonly minCoOccurrence: number;
  /** 可选的 LLM 规则归纳器（未注入时降级到纯算法 N-gram 模板） */
  private readonly llmInducer: LLMRuleInducer | null;
  /** 已学习规则的去重 key 集合（避免重复学习） */
  private readonly learnedDedupKeys = new Set<string>();
  /** 已学习的规则列表 */
  private readonly learnedRules: LearnedRule[] = [];

  constructor(opts: {
    humanLike: HumanLikeMemoryInferenceLike;
    minCoOccurrence?: number;
    /** LLM 规则归纳器（可选，未注入时降级到纯算法） */
    llmInducer?: LLMRuleInducer | null;
  }) {
    this.humanLike = opts.humanLike;
    this.minCoOccurrence = opts.minCoOccurrence ?? DEFAULT_MIN_CO_OCCURRENCE;
    this.llmInducer = opts.llmInducer ?? null;
  }

  /**
   * 扫描记忆图，挖掘并注册新规则到 inferenceEngine。
   *
   * 流程：
   *   1. 从 humanLike.getAllNodes 获取所有节点
   *   2. 统计每对关键词的共现频次
   *   3. 筛选共现频次 >= minCoOccurrence 的关键词对
   *   4. 过滤已被现有规则 requiredTags 覆盖的关键词对
   *   5. 过滤已学习过的关键词对（去重）
   *   6. 若 llmInducer 已注入：把候选对 + 相关节点 summary 喂给 LLM 归纳因果模板
   *      - LLM 归纳成功 → 因果模板（inducedBy: "llm"）
   *      - LLM 归纳失败 / 未注入 → 降级 N-gram 模板（inducedBy: "algorithm"）
   *   7. 生成 LearnedRule 并注册到 inferenceEngine
   *   8. 限流：最多注册 MAX_NEW_RULES_PER_CALL 条
   *
   * @param inferenceEngine 推理引擎（新规则注册到此）
   * @param actorId 指定 actor 的记忆图（可选，缺省 "default"）
   * @returns 本次学习到的新规则列表
   */
  async learnRules(
    inferenceEngine: MemoryInferenceEngine,
    actorId?: string,
  ): Promise<LearnedRule[]> {
    const aid = actorId ?? "default";
    const allNodes = this.humanLike.getAllNodes(aid);
    if (allNodes.length === 0) return [];

    // 1. 对每个节点提取关键词（含 N-gram + 人工 keywords），并记录每个 N-gram 的跨节点出现次数
    //    用于后续噪音过滤：只在 1 个节点出现过的 N-gram 大概率是噪音
    const nodeKeywords: string[][] = [];
    const nodeManualKeywords: Set<string>[] = []; // 人工 keywords 单独跟踪，豁免过滤
    const gramDocFrequency = new Map<string, number>(); // N-gram → 出现在多少个节点
    for (const node of allNodes) {
      const manualKws = new Set<string>(
        (node.keywords ?? [])
          .map((k) => k.trim())
          .filter((k) => k.length >= 2 && !STOP_WORDS.has(k))
      );
      nodeManualKeywords.push(manualKws);
      const kws = this.extractKeywords(node);
      nodeKeywords.push(kws);
      for (const kw of kws) {
        gramDocFrequency.set(kw, (gramDocFrequency.get(kw) ?? 0) + 1);
      }
    }

    // 2. 噪音过滤：最长匹配保留 + 跨节点频次过滤
    //    - 若 3-gram "拼多多" 在 >= 2 个节点中出现，删除它包含的 2-gram "拼多"/"多多"
    //    - 只在 1 个节点出现过的 N-gram 丢弃
    //    - 人工 keywords 豁免所有过滤（直接保留）
    const nodeKeywordsFiltered: string[][] = [];
    for (let ni = 0; ni < nodeKeywords.length; ni++) {
      const kws = nodeKeywords[ni]!;
      const manualKws = nodeManualKeywords[ni]!;
      const filtered = new Set<string>();
      for (const kw of kws) {
        // 人工 keywords 直接保留，不做频次/最长匹配过滤
        if (manualKws.has(kw)) {
          filtered.add(kw);
          continue;
        }
        const docFreq = gramDocFrequency.get(kw) ?? 0;
        // 跨节点频次 < 2 的 N-gram 丢弃（噪音）
        if (docFreq < 2) continue;
        // 检查是否有更长的 N-gram 包含它（最长匹配保留）
        let isSubstringOfLonger = false;
        for (const other of kws) {
          if (other === kw || other.length <= kw.length) continue;
          if (other.includes(kw)) {
            // other 更长且包含 kw，检查 other 的跨节点频次
            const otherFreq = gramDocFrequency.get(other) ?? 0;
            if (otherFreq >= 2) {
              isSubstringOfLonger = true;
              break;
            }
          }
        }
        if (!isSubstringOfLonger) {
          filtered.add(kw);
        }
      }
      nodeKeywordsFiltered.push(Array.from(filtered));
    }

    // 3. 统计每对关键词的共现频次
    const pairStats = new Map<
      string,
      { tagA: string; tagB: string; count: number }
    >();
    for (const kws of nodeKeywordsFiltered) {
      if (kws.length < 2) continue;
      for (let i = 0; i < kws.length; i++) {
        for (let j = i + 1; j < kws.length; j++) {
          const a = kws[i]!;
          const b = kws[j]!;
          if (a === b) continue;
          const key = ruleDedupKey(a, b);
          const stat = pairStats.get(key);
          if (stat) {
            stat.count++;
          } else {
            pairStats.set(key, { tagA: a, tagB: b, count: 1 });
          }
        }
      }
    }

    // 4. 筛选共现频次 >= minCoOccurrence 的关键词对
    const candidates = Array.from(pairStats.values())
      .filter((s) => s.count >= this.minCoOccurrence)
      .sort((a, b) => b.count - a.count); // 按共现频次降序

    if (candidates.length === 0) return [];

    // 5. 收集已有规则的所有 requiredTags（用于过滤已被覆盖的关键词对）
    const existingTagsSet = new Set<string>();
    for (const rule of inferenceEngine.getRules()) {
      for (const tag of rule.requiredTags) {
        existingTagsSet.add(tag);
      }
    }
    // 也包含已学习规则的 tags
    for (const learned of this.learnedRules) {
      for (const tag of learned.requiredTags) {
        existingTagsSet.add(tag);
      }
    }

    // 6. 过滤候选对：去重 + 已被现有规则覆盖
    const filteredCandidates = candidates.filter((c) => {
      // 去重：已学过的关键词对不重复学习
      const dedupKey = ruleDedupKey(c.tagA, c.tagB);
      if (this.learnedDedupKeys.has(dedupKey)) return false;
      // 过滤：如果这对关键词已在某个现有规则的 requiredTags 中，跳过
      if (existingTagsSet.has(c.tagA) && existingTagsSet.has(c.tagB)) return false;
      return true;
    });

    if (filteredCandidates.length === 0) return [];

    // 7. 若 llmInducer 已注入，把候选对 + 相关节点 summary 喂给 LLM 归纳因果模板
    //    LLM 只参与"学规则"，不参与"用规则推理"
    let llmInducedMap = new Map<string, LLMInducedRule>();
    if (this.llmInducer) {
      try {
        const relatedNodes = allNodes.map((n) => ({
          summary: n.summary,
          keywords: n.keywords,
        }));
        const inducedRules = await this.llmInducer.induceRules(
          filteredCandidates.slice(0, 10),
          relatedNodes,
        );
        // 用 dedupKey 索引 LLM 归纳出的规则，便于候选对匹配
        for (const ir of inducedRules) {
          if (ir.requiredTags.length >= 2) {
            const key = ruleDedupKey(ir.requiredTags[0]!, ir.requiredTags[1]!);
            llmInducedMap.set(key, ir);
          }
        }
        if (inducedRules.length > 0) {
          console.log(
            `[RuleLearner] LLM 归纳出 ${inducedRules.length} 条因果规则候选`,
          );
        }
      } catch (err) {
        console.log(`[RuleLearner] LLM 归纳失败（降级到纯算法）: ${err}`);
      }
    }

    // 8. 生成 LearnedRule：优先用 LLM 因果模板，否则降级 N-gram 共现陈述
    const newRules: LearnedRule[] = [];
    const now = new Date().toISOString();
    for (const candidate of filteredCandidates) {
      if (newRules.length >= MAX_NEW_RULES_PER_CALL) break;

      const dedupKey = ruleDedupKey(candidate.tagA, candidate.tagB);
      const llmRule = llmInducedMap.get(dedupKey);

      let learnedRule: LearnedRule;
      if (llmRule) {
        // LLM 归纳成功 → 因果模板
        learnedRule = {
          id: `learned_${dedupKey}`,
          name: `LLM 归纳规则：${candidate.tagA} ↔ ${candidate.tagB}`,
          description: llmRule.explanation ||
            `LLM 从 ${candidate.count} 个共现节点归纳的因果规则`,
          requiredTags: [candidate.tagA, candidate.tagB],
          patterns: {
            clueAPattern: loosePattern(candidate.tagA),
            clueBPattern: loosePattern(candidate.tagB),
          },
          template: llmRule.template,
          baseConfidence: llmRule.baseConfidence,
          learned: true,
          coOccurrenceCount: candidate.count,
          learnedAt: now,
          inducedBy: "llm",
        };
      } else {
        // 降级 → N-gram 共现陈述
        learnedRule = {
          id: `learned_${dedupKey}`,
          name: `自学习规则：${candidate.tagA} ↔ ${candidate.tagB}`,
          description: `从 ${candidate.count} 个记忆节点中归纳：${candidate.tagA} 与 ${candidate.tagB} 频繁共现`,
          requiredTags: [candidate.tagA, candidate.tagB],
          patterns: {
            clueAPattern: loosePattern(candidate.tagA),
            clueBPattern: loosePattern(candidate.tagB),
          },
          template: `出现${candidate.tagA}时可能涉及${candidate.tagB}`,
          baseConfidence: LEARNED_RULE_BASE_CONFIDENCE,
          learned: true,
          coOccurrenceCount: candidate.count,
          learnedAt: now,
          inducedBy: "algorithm",
        };
      }

      // 注册到推理引擎（热更新：立即可用于推理）
      inferenceEngine.registerRule(learnedRule);
      // 记录到已学习列表 + 去重集合
      this.learnedRules.push(learnedRule);
      this.learnedDedupKeys.add(dedupKey);
      // 把新 tags 加入 existingTagsSet，避免本轮学习出重复 tags
      existingTagsSet.add(candidate.tagA);
      existingTagsSet.add(candidate.tagB);

      newRules.push(learnedRule);
    }

    if (newRules.length > 0) {
      console.log(
        `[RuleLearner] 从 actor=${aid} 的 ${allNodes.length} 个节点中学习了 ${newRules.length} 条新规则`,
      );
    }
    return newRules;
  }

  /** 获取已学习的规则 */
  getLearnedRules(): LearnedRule[] {
    return [...this.learnedRules];
  }

  /**
   * 标记某条已学习规则为已验证（baseConfidence +0.1）。
   *
   * 供 inferenceEngine.markVerified 调用——当推理结论被验证时，
   * 触发对应学习规则的置信度升级。
   */
  markRuleVerified(ruleId: string): void {
    const rule = this.learnedRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.baseConfidence = Math.min(1, rule.baseConfidence + VERIFIED_CONFIDENCE_BONUS);
    }
  }

  // ---- 内部工具 ----

  /**
   * 从节点中提取关键词（合并 keywords 字段 + summary N-gram 提取）。
   *
   * 改进点（v2）：
   *   1. 不再依赖人工 keywords 字段（很多场景没打 keywords）
   *   2. 用 N-gram 滑窗从中文 summary 提取 2-4 字短语
   *      例如 "上周加班到凌晨喝了三杯咖啡" 会提取 "加班","凌晨","三杯","咖啡" 等
   *   3. 过滤停用词（"的","了","是" 等）避免噪音
   */
  private extractKeywords(node: {
    summary: string;
    keywords?: string[];
  }): string[] {
    const set = new Set<string>();

    // 1. 人工 keywords（如有）
    if (node.keywords && Array.isArray(node.keywords)) {
      for (const k of node.keywords) {
        const trimmed = k.trim();
        if (trimmed.length >= 2 && !STOP_WORDS.has(trimmed)) {
          set.add(trimmed);
        }
      }
    }

    // 2. summary N-gram 提取（中文友好）
    //    按标点切分成短句，再从每句中滑窗提取 2-4 字短语
    const sentences = node.summary.split(/[\s,，。.、;；!！?？:："'`'（）()【】\[\]]+/);
    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (clean.length < 2) continue;
      // 2-gram
      for (let i = 0; i <= clean.length - 2; i++) {
        const gram = clean.slice(i, i + 2);
        if (!STOP_WORDS.has(gram) && !this.isAllDigit(gram)) {
          set.add(gram);
        }
      }
      // 3-gram
      for (let i = 0; i <= clean.length - 3; i++) {
        const gram = clean.slice(i, i + 3);
        if (!STOP_WORDS.has(gram) && !this.isAllDigit(gram)) {
          set.add(gram);
        }
      }
      // 整个短句也作为一个候选（≤4 字时）
      if (clean.length >= 2 && clean.length <= 4 && !STOP_WORDS.has(clean)) {
        set.add(clean);
      }
    }

    return Array.from(set);
  }

  /** 判断字符串是否全为数字（过滤纯数字 N-gram） */
  private isAllDigit(s: string): boolean {
    return /^\d+$/.test(s);
  }
}

/** 中文停用词表（避免提取"的","了","是"等噪音词） */
const STOP_WORDS = new Set<string>([
  "的", "了", "是", "在", "有", "和", "与", "或", "也", "都", "就", "还",
  "不", "没", "无", "要", "会", "能", "可", "应", "该", "这", "那",
  "一个", "一些", "一种", "一样", "什么", "怎么", "为什么", "如何",
  "可以", "应该", "需要", "可能", "或者", "但是", "因为", "所以",
  "如果", "虽然", "尽管", "不过", "然后", "接着", "之后", "之前",
  "已经", "正在", "将要", "马上", "立刻", "现在", "以前", "以后",
]);
