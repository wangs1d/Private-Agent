// Agent Brain Center — AnalogyMigrator（类比迁移）
//
// 职责：让 agent 把已学到的规则迁移到相似但不同的新场景。
//   当用户线索没匹配任何已有规则时触发，
//   用 Jaccard 相似度计算新线索关键词集合与已有规则 requiredTags 的相似度，
//   相似度 > threshold 时，复制规则并替换关键词，生成新规则。
//
// 核心原则：
//   1. 不调 LLM：纯 Jaccard 计算
//   2. 关键词替换：把原规则 patterns 中的关键词替换为新场景的对应词（用相似度最高的词对）
//   3. 迁移损耗：新规则置信度 = 原置信度 * similarity * 0.8
//
// 详见 task: 4 项仿人推理能力新增

import type {
  InferenceClue,
} from "../types.js";
import type { InferenceRule } from "./memory-inference-engine.js";

// ============================================================
// 类型
// ============================================================

/**
 * 迁移规则：从相似场景迁移过来的规则。
 *
 * - migrated: true 标记
 * - sourceRuleId: 源规则 id
 * - similarity: 迁移时的 Jaccard 相似度
 * - migratedAt: 迁移时间
 */
export interface MigratedRule extends InferenceRule {
  migrated: true;
  sourceRuleId: string;
  similarity: number;
  migratedAt: string;
}

// ============================================================
// 常量
// ============================================================

/** 默认相似度阈值：> 0.5 才迁移 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
/** 迁移损耗系数：新规则置信度 = 原置信度 * similarity * 0.8 */
const MIGRATION_DECAY_FACTOR = 0.8;

// ============================================================
// 工具函数
// ============================================================

/** 转义正则特殊字符，用于把关键词安全嵌入 RegExp */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 限制数值在 [min, max] 区间 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ============================================================
// AnalogyMigrator 主类
// ============================================================

/**
 * 类比迁移器：把已有规则迁移到相似但不同的新场景。
 *
 * 算法：
 *   1. 从 clues 提取关键词集合
 *   2. 对每条已有规则，计算 Jaccard(clue_keywords, rule.requiredTags)
 *   3. 相似度 > threshold 时，复制规则并替换关键词
 *   4. 新规则 baseConfidence = 原规则 baseConfidence * similarity * 0.8
 *
 * 不调 LLM。纯 Jaccard 计算。
 */
export class AnalogyMigrator {
  private readonly similarityThreshold: number;

  constructor(opts: { similarityThreshold?: number } = {}) {
    this.similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  }

  /**
   * 尝试把已有规则迁移到新场景。
   *
   * 流程：
   *   1. 从 clues 提取关键词集合
   *   2. 对每条已有规则计算 Jaccard 相似度
   *   3. 相似度 > threshold 时生成迁移规则
   *   4. 关键词替换：用相似度最高的词对替换原规则 requiredTags 和 patterns
   *
   * @param clues 用户线索（未匹配任何已有规则时传入）
   * @param existingRules 已有规则列表
   * @returns 迁移后的新规则列表（可能为空）
   */
  migrateRules(
    clues: InferenceClue[],
    existingRules: InferenceRule[],
  ): MigratedRule[] {
    const clueKeywords = this.extractClueKeywords(clues);
    if (clueKeywords.length === 0) return [];

    const migrated: MigratedRule[] = [];
    const now = new Date().toISOString();

    for (const rule of existingRules) {
      // 跳过已迁移的规则（避免级联迁移）
      if ((rule as MigratedRule).migrated === true) continue;

      // 词级 Jaccard（适合英文）
      const wordSim = this.jaccardSimilarity(
        clueKeywords,
        rule.requiredTags,
      );
      // 字符级 Jaccard（适合中文短文本，但易被无关字符稀释）
      const charSim = this.charJaccardSimilarity(
        clueKeywords,
        rule.requiredTags,
      );
      // tag 覆盖度：requiredTag 直接在 clue 文本中出现的比例
      // 最适合中文场景（"加班" 直接出现在 "今天加班" 中）
      const coverSim = this.tagCoverageSimilarity(rule.requiredTags, clues);
      // 取最大值：英文用词级，中文用覆盖度或字符级
      const similarity = Math.max(wordSim, charSim, coverSim);
      if (similarity <= this.similarityThreshold) continue;

      // 关键词替换策略（人类直觉模拟）：
      //   对每个 requiredTag，找一条最匹配的 clue（用 substring 包含判断）
      //   - 如果 tag 直接出现在某条 clue 文本中（如 "加班" 在 "今天加班" 中）
      //     → 用 tag 本身作为新 tag（patterns 用 tag 能直接匹配）
      //   - 如果 tag 没出现在任何 clue 中（如 "咖啡" 不在 "下午喝奶茶" 中）
      //     → 保留原 tag（patterns 仍用原 tag，虽然匹配不到但保留规则结构）
      //   - 如果某条 clue 包含所有 tag 之外的新词（如 "奶茶" 是新概念）
      //     → 不替换（不强行把"咖啡"改成"奶茶"，因为 agent 不确定它们是同一概念）
      //
      //   这样 patterns 用原 tag（"加班"）能匹配到 clue（"今天加班"），
      //   而"咖啡" pattern 匹配不到"奶茶" → 整条规则不触发，
      //   符合人类直觉：看到"加班"会联想到"咖啡"，但不会无依据地把"咖啡"等同于"奶茶"。
      //
      //   但若想强迁移（similarity 高时），可改用"任一 tag 命中即触发"模式。
      //   当前实现：保留原 patterns 不替换，让 matchRulesAndGenerate 自己判断。
      const newRequiredTags = [...rule.requiredTags];

      // 迁移时不替换 patterns（保持原 tag 作为匹配目标）
      // 推理时若任一 clue 包含 pattern 关键词即视为匹配
      const clueAKeyword = rule.requiredTags[0] ?? "";
      const clueBKeyword = rule.requiredTags[1] ?? rule.requiredTags[0] ?? "";

      // 生成迁移规则
      const newConfidence = clamp(
        rule.baseConfidence * similarity * MIGRATION_DECAY_FACTOR,
        0,
        1,
      );

      const migratedRule: MigratedRule = {
        id: `migrated_${rule.id}_${now.replace(/[^0-9]/g, "").slice(0, 14)}`,
        name: `迁移规则：${rule.name} → ${clueAKeyword}/${clueBKeyword}（sim=${similarity.toFixed(2)}）`,
        description: `从规则 ${rule.id} 迁移（相似度 ${similarity.toFixed(3)}）：${rule.description}`,
        requiredTags: newRequiredTags,
        patterns: {
          // 保留原 patterns：用原 tag 作为匹配目标
          // 推理时 matchRulesAndGenerate 会对每条 clue 单独匹配 pattern
          clueAPattern: new RegExp(escapeRegex(clueAKeyword)),
          clueBPattern: new RegExp(escapeRegex(clueBKeyword)),
        },
        template: rule.template,
        baseConfidence: Number(newConfidence.toFixed(3)),
        migrated: true,
        sourceRuleId: rule.id,
        similarity: Number(similarity.toFixed(3)),
        migratedAt: now,
      };

      migrated.push(migratedRule);
    }

    // 去重：同一条源规则只迁移一次（取相似度最高的）
    const bySource = new Map<string, MigratedRule>();
    for (const m of migrated) {
      const existing = bySource.get(m.sourceRuleId);
      if (!existing || m.similarity > existing.similarity) {
        bySource.set(m.sourceRuleId, m);
      }
    }

    if (bySource.size > 0) {
      console.log(
        `[AnalogyMigrator] 从 ${existingRules.length} 条规则中迁移出 ${bySource.size} 条新规则（阈值 ${this.similarityThreshold}）`,
      );
    }
    return Array.from(bySource.values());
  }

  /**
   * 计算两个关键词集合的 Jaccard 相似度（词级）。
   *
   * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
   *
   * 两个空集的 Jaccard 定义为 0（避免除零）。
   * 比较时大小写不敏感。
   *
   * 注意：对中文不友好（中文 token 化常不切词），中文场景请用 charJaccardSimilarity。
   */
  jaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    const setB = new Set(b.map((s) => s.toLowerCase()));
    let intersection = 0;
    for (const x of setA) {
      if (setB.has(x)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
  }

  /**
   * 字符级 Jaccard 相似度（适合中文）。
   *
   * 把两个字符串集合的所有字符拼到一个集合中，再算 Jaccard。
   * 这样 "加班咖啡" 与 ["加班","咖啡"] 会因共享 "加","班","咖","啡" 4 个字符而相似度高。
   */
  private charJaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a.join("").toLowerCase());
    const setB = new Set(b.join("").toLowerCase());
    let intersection = 0;
    for (const ch of setA) {
      if (setB.has(ch)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
  }

  /**
   * tag 覆盖度相似度：requiredTag 直接在 clue 文本中出现的比例。
   *
   * 这是中文场景最稳的相似度判断（不依赖 token 化）：
   *   - rule.requiredTags = ["加班","咖啡"]
   *   - clues = ["今天加班", "喝了奶茶"]
   *   - "加班" 出现在 "今天加班" 中 → 命中
   *   - "咖啡" 未出现在任何 clue 中 → 未命中
   *   - 覆盖度 = 1/2 = 0.5
   *
   * 这种判断最接近人类直觉：人看到"加班"会立刻联想到"加班+咖啡"规则。
   */
  private tagCoverageSimilarity(tags: string[], clues: InferenceClue[]): number {
    if (tags.length === 0 || clues.length === 0) return 0;
    let hitCount = 0;
    for (const tag of tags) {
      const lowerTag = tag.toLowerCase();
      const hit = clues.some(c => c.text.toLowerCase().includes(lowerTag));
      if (hit) hitCount++;
    }
    return hitCount / tags.length;
  }

  // ---- 内部工具 ----

  /**
   * 从线索中提取关键词集合。
   * 合并所有线索文本的分词结果，去重。
   */
  private extractClueKeywords(clues: InferenceClue[]): string[] {
    const set = new Set<string>();
    for (const clue of clues) {
      const tokens = this.tokenize(clue.text);
      for (const t of tokens) {
        if (t.length >= 2) set.add(t);
      }
    }
    return Array.from(set);
  }

  /**
   * 为原 tag 找相似度最高的 clue keyword。
   *
   * 相似度用字符级 Jaccard 计算：
   *   - 把字符串拆为字符集合
   *   - 计算两个字符集合的 Jaccard 相似度
   *
   * 这样 "拼多多" 和 "拼团" 会有一定相似度（共享 "拼" 字）。
   */
  private findBestMatch(tag: string, clueKeywords: string[]): string | null {
    if (clueKeywords.length === 0) return null;
    let bestMatch: string | null = null;
    let bestScore = 0;
    const tagChars = new Set(tag.toLowerCase());
    for (const kw of clueKeywords) {
      const kwChars = new Set(kw.toLowerCase());
      // 字符级 Jaccard
      let intersection = 0;
      for (const ch of tagChars) {
        if (kwChars.has(ch)) intersection++;
      }
      const union = tagChars.size + kwChars.size - intersection;
      const score = union === 0 ? 0 : intersection / union;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = kw;
      }
    }
    // 至少要有 1 个字符重叠才认为是匹配
    return bestScore > 0 ? bestMatch : null;
  }

  /** 简单分词（中英文混合，按空格 + 标点切分，转小写） */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,，。.、;；!！?？:："'`'（）()【】\[\]]+/)
      .filter((t) => t.length > 0);
  }
}
