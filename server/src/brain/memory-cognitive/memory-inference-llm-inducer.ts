// Agent Brain Center — LLMRuleInducer（LLM 规则归纳器）
//
// 职责：让 LLM 从历史记忆中归纳"因果规则"（仅参与"学规则"，不参与"用规则推理"）。
//
// 与 prompt 演戏的本质区别：
//   - prompt 演戏：每次推理都调 LLM 让它"想"结论（不可控、不可审计）
//   - LLM 归纳：只在学习阶段调一次 LLM 归纳规则，规则可审计、可验证、可热更新
//   - 推理阶段仍是程序化算法（matchRule + fillTemplate），不调 LLM
//
// 流程：
//   1. 从记忆节点中提取共现关键词对（复用 RuleLearner 的共现统计）
//   2. 把共现关键词对 + 相关记忆节点 summary 喂给 LLM
//   3. LLM 输出结构化 JSON：[{ requiredTags, template, baseConfidence, reasoningType, explanation }]
//   4. 解析 JSON 注册为 LearnedRule
//
// 关键约束：
//   1. LLM 输出必须是严格的 JSON 数组（不是自然语言对话），便于审计/回滚
//   2. chatProvider 不可用时返回空数组（降级到纯算法 RuleLearner）
//   3. JSON 解析失败 / 字段缺失时降级
//   4. 单次最多归纳 MAX_RULES_PER_CALL 条规则（限流）
//   5. 每条 template 必须包含 {A} 和 {B} 占位符，否则丢弃（保证可填充）

import type { ExternalChatProvider } from "../../external-model/types.js";

// ============================================================
// 类型
// ============================================================

/** LLM 归纳出的规则（结构化 JSON 解析结果） */
export interface LLMInducedRule {
  /** 触发条件：需要哪些关键词同时存在 */
  requiredTags: string[];
  /** 因果模板：用 {A} {B} 占位符引用 requiredTags 中的关键词 */
  template: string;
  /** 基础置信度（未经验证，0.3-0.7） */
  baseConfidence: number;
  /** 推理类型：因果 / 相关 / 目的 */
  reasoningType: "causal" | "correlation" | "purpose";
  /** 规则说明（人类可读） */
  explanation: string;
}

// ============================================================
// 常量
// ============================================================

/** 单次 induceRules 最多归纳的规则数（限流，避免 LLM 滥用） */
const MAX_RULES_PER_CALL = 5;
/** LLM 归纳规则的最小 baseConfidence */
const MIN_INFERRED_CONFIDENCE = 0.3;
/** LLM 归纳规则的最大 baseConfidence（未经验证不能太高） */
const MAX_INFERRED_CONFIDENCE = 0.7;
/** 一次性会话 id 前缀（避免污染主会话） */
const INDUCER_SESSION_PREFIX = "llm-rule-inducer";

// ============================================================
// 工具函数
// ============================================================

/**
 * 从 LLM 输出文本中提取首个 JSON 数组片段。
 *
 * LLM 偶尔会在 JSON 前后输出解释性文字，此函数从文本中
 * 找到第一个 `[` 和匹配的 `]`，截取中间内容（含两端方括号）。
 * 找不到返回 null。
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  // 从后向前找最后一个 ]，保证截取最长的合法 JSON 数组
  const end = text.lastIndexOf("]");
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** 限制 baseConfidence 在 [min, max] 区间 */
function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return MIN_INFERRED_CONFIDENCE;
  return Math.max(MIN_INFERRED_CONFIDENCE, Math.min(MAX_INFERRED_CONFIDENCE, v));
}

// ============================================================
// LLMRuleInducer 主类
// ============================================================

/**
 * LLM 规则归纳器：让 LLM 从历史记忆中归纳因果规则。
 *
 * 关键：
 *   - chatProvider 为 null 或不可用时返回空数组（降级到纯算法 RuleLearner）
 *   - LLM 输出必须能 JSON.parse，失败则降级
 *   - 单次最多归纳 MAX_RULES_PER_CALL 条规则（限流）
 *   - 每条 template 必须包含 {A} 和 {B} 占位符，否则丢弃
 */
export class LLMRuleInducer {
  private readonly chatProvider: ExternalChatProvider | null;
  /** 会话 id 计数器（每次调用递增，避免会话串扰） */
  private sessionCounter = 0;

  constructor(opts: {
    chatProvider?: ExternalChatProvider | null;
  }) {
    this.chatProvider = opts.chatProvider ?? null;
  }

  /**
   * 让 LLM 从共现关键词对 + 相关记忆中归纳因果规则。
   *
   * @param coOccurrencePairs 共现关键词对（来自 RuleLearner 统计）
   * @param relatedNodes 相关记忆节点（供 LLM 参考）
   * @returns 归纳出的规则列表（结构化 JSON 解析）
   */
  async induceRules(
    coOccurrencePairs: Array<{ tagA: string; tagB: string; count: number }>,
    relatedNodes: Array<{ summary: string; keywords?: string[] }>,
  ): Promise<LLMInducedRule[]> {
    // chatProvider 不可用 → 直接降级返回空数组
    if (!this.chatProvider || !this.chatProvider.isEnabled()) {
      return [];
    }
    // 无候选共现对 → 无需调 LLM
    if (coOccurrencePairs.length === 0) {
      return [];
    }

    // 构造 user 输入：共现关键词对 + 相关节点 summary
    const userPrompt = this.buildUserPrompt(coOccurrencePairs, relatedNodes);
    const sessionId = `${INDUCER_SESSION_PREFIX}-${++this.sessionCounter}`;

    // 调 LLM stream，累积响应文本
    // streamCompletion 返回最终完整文本，onDelta 是增量回调
    // 两者都收集，优先用最终返回值（更完整），降级用 onDelta 累加
    let streamedText = "";
    let finalText = "";
    try {
      finalText = await this.chatProvider.streamCompletion(
        sessionId,
        { text: userPrompt },
        (delta) => {
          streamedText += delta;
        },
        undefined, // 不启用 function calling
        {
          // 元指令：跳过 UAP 记忆拼装 + 身份后缀，纯粹做规则归纳
          systemPromptOverride: LLM_RULE_INDUCTION_SYSTEM_PROMPT,
          ephemeralTurn: true,
          suppressRuntimeSuffixes: true,
          functionalSuffixes: false,
        },
      );
    } catch (err) {
      console.log(`[LLMRuleInducer] streamCompletion 失败（降级返回空）: ${err}`);
      return [];
    }
    const fullResponse = (typeof finalText === "string" && finalText.length > 0)
      ? finalText
      : streamedText;

    // 解析 LLM 输出为结构化规则
    return this.parseInducedRules(fullResponse);
  }

  // ---- 内部工具 ----

  /**
   * 构造喂给 LLM 的 user prompt：包含共现关键词对 + 相关节点 summary。
   *
   * 让 LLM 看到原始记忆片段，避免它凭空臆造规则。
   */
  private buildUserPrompt(
    coOccurrencePairs: Array<{ tagA: string; tagB: string; count: number }>,
    relatedNodes: Array<{ summary: string; keywords?: string[] }>,
  ): string {
    const pairsText = coOccurrencePairs
      .slice(0, 10) // 最多 10 对，避免 prompt 过长
      .map((p, i) => `  ${i + 1}. "${p.tagA}" ↔ "${p.tagB}"（共现 ${p.count} 次）`)
      .join("\n");

    const nodesText = relatedNodes
      .slice(0, 10) // 最多 10 个节点 summary
      .map((n, i) => `  ${i + 1}. ${n.summary}`)
      .join("\n");

    return [
      "请从以下记忆节点和共现关键词对中归纳因果规则。",
      "",
      "【共现关键词对】",
      pairsText || "  （无）",
      "",
      "【相关记忆节点】",
      nodesText || "  （无）",
      "",
      "请按系统指令输出严格的 JSON 数组。",
    ].join("\n");
  }

  /**
   * 解析 LLM 输出为结构化规则列表。
   *
   * 容错策略：
   *   1. 先尝试直接 JSON.parse
   *   2. 失败则提取首个 [..] 片段再 parse
   *   3. 仍失败则返回空数组（降级）
   *   4. 每条规则做字段校验：requiredTags 长度 >= 2、template 含 {A} {B}、baseConfidence 在 [0.3, 0.7]
   *   5. 最多保留 MAX_RULES_PER_CALL 条
   */
  private parseInducedRules(rawText: string): LLMInducedRule[] {
    if (!rawText || !rawText.trim()) return [];

    let parsed: unknown;
    // 1. 直接 parse
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // 2. 提取首个 JSON 数组片段
      const jsonFragment = extractJsonArray(rawText);
      if (!jsonFragment) {
        console.log(
          `[LLMRuleInducer] LLM 输出无法解析为 JSON（降级返回空）。前 200 字符: ${rawText.slice(0, 200)}`,
        );
        return [];
      }
      try {
        parsed = JSON.parse(jsonFragment);
      } catch (err) {
        console.log(`[LLMRuleInducer] JSON 片段解析失败（降级返回空）: ${err}`);
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      console.log(`[LLMRuleInducer] LLM 输出不是 JSON 数组（降级返回空）`);
      return [];
    }

    const rules: LLMInducedRule[] = [];
    for (const item of parsed) {
      if (rules.length >= MAX_RULES_PER_CALL) break;
      const rule = this.normalizeRule(item);
      if (rule) {
        rules.push(rule);
      }
    }
    return rules;
  }

  /**
   * 把 LLM 输出的单条规则对象规范化为 LLMInducedRule。
   *
   * 校验：
   *   - 必须是对象
   *   - requiredTags 是字符串数组，长度 >= 2
   *   - template 是字符串，必须同时包含 {A} 和 {B}
   *   - baseConfidence 限制到 [0.3, 0.7]
   *   - reasoningType 必须是 causal/correlation/purpose 之一（缺省 causal）
   *   - explanation 是字符串（缺省空串）
   *
   * 校验失败返回 null（该规则被丢弃）。
   */
  private normalizeRule(item: unknown): LLMInducedRule | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;

    // requiredTags 校验
    const tagsRaw = obj.requiredTags;
    if (!Array.isArray(tagsRaw)) return null;
    const requiredTags = tagsRaw.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (requiredTags.length < 2) return null;

    // template 校验：LLM 归纳的规则允许两种模式
    //   1. 占位符模式："出现{A}时可能涉及{B}" — 通用模板，运行时用关键词替换
    //   2. 完整句子模式："朋友让加群是为了帮他点拼多多助力链接" — 具体结论，不需替换
    // LLM 归纳的因果规则更常用完整句子模式（因为 LLM 能看到具体场景）
    const templateRaw = obj.template;
    if (typeof templateRaw !== "string" || templateRaw.trim().length === 0) return null;
    const template = templateRaw.trim();

    // baseConfidence 校验
    const confRaw = obj.baseConfidence;
    const baseConfidence = clampConfidence(
      typeof confRaw === "number" ? confRaw : Number(confRaw),
    );

    // reasoningType 校验
    const typeRaw = obj.reasoningType;
    const reasoningType: LLMInducedRule["reasoningType"] =
      typeRaw === "correlation" || typeRaw === "purpose" ? typeRaw : "causal";

    // explanation 校验
    const explanation =
      typeof obj.explanation === "string" ? obj.explanation : "";

    return {
      requiredTags,
      template,
      baseConfidence,
      reasoningType,
      explanation,
    };
  }
}

// ============================================================
// LLM 系统提示词（元指令，非推理指令）
// ============================================================

/**
 * LLM 规则归纳器的 system prompt。
 *
 * 这是元指令：让 LLM 知道自己的角色是"规则归纳器"，输出必须是严格 JSON。
 * 不是推理指令——LLM 不参与"用规则推理"，只参与"学规则"。
 */
export const LLM_RULE_INDUCTION_SYSTEM_PROMPT = `你是规则归纳器。从给定的记忆节点和共现关键词对中，归纳出"因果规则"。

输出必须是严格的 JSON 数组，每个元素格式：
{
  "requiredTags": ["关键词A", "关键词B"],
  "template": "出现{A}时，可能{B}",
  "baseConfidence": 0.5,
  "reasoningType": "causal" | "correlation" | "purpose",
  "explanation": "规则说明"
}

要求：
1. template 必须是因果陈述（不是共现陈述）
   - 好："朋友让加群是为了帮他点拼多多助力链接"
   - 差："出现拼多多时可能涉及加群"
2. template 用 {A} {B} 占位符引用 requiredTags 中的关键词
3. baseConfidence 0.3-0.7 之间（未经验证，不能太高）
4. 只输出 JSON，不要任何对话式回复`;
