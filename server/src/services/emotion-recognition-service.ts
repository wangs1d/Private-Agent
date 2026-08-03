/**
 * 情绪识别服务（Phase 2.1）
 *
 * 分层策略（Token 效率优先）：
 * - L1 规则层（无 LLM）：关键词 + 表情符号 + 标点强度 + 时段 + 历史情绪
 *   → 90%+ 情绪可识别，仅复杂/模糊文本才触发 L2
 * - L2 LLM 层（仅 L1 置信度 < 0.5）：调用 mini 模型，结构化 JSON 输出
 * - 缓存：同一 actorId 5 分钟内相同 primary emotion 复用结果
 *
 * 输出 EmotionVector，包含 cause / intensity / secondaryLabel 扩展字段
 */

import type { EmotionVector } from "../brain/types.js";
import { buildModelOverrideOpts, TaskTier } from "../config/model-routing.js";
import type { ExternalChatProvider } from "../external-model/types.js";

/** 情绪识别结果（含置信度，用于决定是否触发 L2） */
export interface EmotionRecognitionResult {
  emotion: EmotionVector;
  /** L1 规则置信度 0-1，<0.5 时考虑触发 L2 */
  ruleConfidence: number;
  /** 是否实际调用了 L2 LLM */
  usedLlm: boolean;
}

// ---- L1 规则层：关键词表 ----

interface EmotionRule {
  label: string;
  valence: number;
  arousal: number;
  dominance: number;
  keywords: string[];
  emojis: string[];
}

const EMOTION_RULES: EmotionRule[] = [
  {
    label: "开心",
    valence: 0.8,
    arousal: 0.7,
    dominance: 0.6,
    keywords: ["开心", "高兴", "快乐", "哈哈", "嘻嘻", "棒", "赞", "好耶", "不错", "喜欢", "太好了", "牛"],
    emojis: ["😊", "😄", "😀", "😃", "😁", "😆", "🥳", "😍", "🥰", "👍", "🎉"],
  },
  {
    label: "悲伤",
    valence: -0.7,
    arousal: 0.3,
    dominance: 0.3,
    keywords: ["难过", "伤心", "悲伤", "哭", "心痛", "失落", "孤独", "寂寞", "想哭", "崩溃", "抑郁"],
    emojis: ["😢", "😭", "😞", "😔", "😟", "💔", "😿"],
  },
  {
    label: "愤怒",
    valence: -0.8,
    arousal: 0.9,
    dominance: 0.7,
    keywords: ["生气", "愤怒", "气死", "烦死", "操", "靠", "可恶", "该死", "混蛋", "恶心", "受不了", "烦"],
    emojis: ["😡", "😠", "🤬", "💢", "😤", "🖕"],
  },
  {
    label: "焦虑",
    valence: -0.5,
    arousal: 0.8,
    dominance: 0.3,
    keywords: ["焦虑", "紧张", "担心", "害怕", "恐惧", "不安", "压力", "烦", "急", "慌", "怕", "压力山大"],
    emojis: ["😰", "😨", "😱", "😰", "😟", "😬"],
  },
  {
    label: "疲惫",
    valence: -0.3,
    arousal: 0.2,
    dominance: 0.4,
    keywords: ["累", "困", "疲惫", "没劲", "不想动", "好困", "犯困", "乏力", "精疲力尽", "撑不住"],
    emojis: ["😴", "😪", "🥱", "😞", "😵"],
  },
  {
    label: "平静",
    valence: 0.2,
    arousal: 0.3,
    dominance: 0.6,
    keywords: ["还好", "一般", "正常", "嗯", "哦", "行", "可以", "OK", "ok", "没事"],
    emojis: ["🙂", "🤔", "😐", "😶"],
  },
  {
    label: "兴奋",
    valence: 0.9,
    arousal: 0.95,
    dominance: 0.7,
    keywords: ["兴奋", "激动", "期待", "太棒了", "终于", "等不及", "哇", "天哪", "我的天"],
    emojis: ["🤩", "😱", "🤯", "💫", "🔥", "✨"],
  },
  {
    label: "感激",
    valence: 0.7,
    arousal: 0.4,
    dominance: 0.5,
    keywords: ["谢谢", "感谢", "辛苦了", "多谢", "太感谢", "感激", "谢谢啦"],
    emojis: ["🙏", "😊", "🤝", "❤️"],
  },
];

/** 默认情绪（无匹配时） */
const DEFAULT_EMOTION: Omit<EmotionVector, "actorId" | "detectedAt"> = {
  valence: 0,
  arousal: 0.4,
  dominance: 0.5,
  label: "neutral",
  confidence: 0.3,
  cause: "无明显情绪特征",
  intensity: 0.3,
};

/** 缓存条目 */
interface CacheEntry {
  emotion: EmotionVector;
  timestamp: number;
  textHash: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 简单 hash（非加密用途） */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * 情绪识别服务
 *
 * 规则优先，LLM 兜底，5 分钟缓存
 */
export class EmotionRecognitionService {
  private readonly provider: ExternalChatProvider | null;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(provider: ExternalChatProvider | null = null) {
    this.provider = provider;
  }

  /**
   * 识别情绪
   * @param actorId 用户 ID
   * @param text 用户文本
   * @param opts 可选上下文（时段、历史情绪）
   */
  async recognize(
    actorId: string,
    text: string,
    opts?: {
      hour?: number;
      recentEmotions?: string[];
    },
  ): Promise<EmotionRecognitionResult> {
    // 缓存命中检查
    const textHash = simpleHash(text);
    const cacheKey = `${actorId}:${textHash}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return {
        emotion: cached.emotion,
        ruleConfidence: cached.emotion.confidence ?? 0.5,
        usedLlm: false,
      };
    }

    // L1 规则识别
    const l1Result = this.recognizeByRules(actorId, text, opts);
    if (l1Result.ruleConfidence >= 0.5) {
      this.cache.set(cacheKey, {
        emotion: l1Result.emotion,
        timestamp: Date.now(),
        textHash,
      });
      return { ...l1Result, usedLlm: false };
    }

    // L2 LLM 识别（仅当 provider 可用且 L1 置信度低）
    if (this.provider?.isEnabled()) {
      const l2Result = await this.recognizeByLlm(actorId, text, l1Result.emotion);
      if (l2Result) {
        this.cache.set(cacheKey, {
          emotion: l2Result,
          timestamp: Date.now(),
          textHash,
        });
        return {
          emotion: l2Result,
          ruleConfidence: l1Result.ruleConfidence,
          usedLlm: true,
        };
      }
    }

    // L2 不可用或失败，返回 L1 结果
    this.cache.set(cacheKey, {
      emotion: l1Result.emotion,
      timestamp: Date.now(),
      textHash,
    });
    return { ...l1Result, usedLlm: false };
  }

  // ---- L1 规则层 ----

  private recognizeByRules(
    actorId: string,
    text: string,
    opts?: { hour?: number; recentEmotions?: string[] },
  ): { emotion: EmotionVector; ruleConfidence: number } {
    const now = new Date().toISOString();
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        emotion: { actorId, ...DEFAULT_EMOTION, detectedAt: now },
        ruleConfidence: 0.3,
      };
    }

    let bestMatch: { rule: EmotionRule; score: number } | null = null;
    let secondaryMatch: { rule: EmotionRule; score: number } | null = null;

    for (const rule of EMOTION_RULES) {
      let score = 0;
      // 关键词匹配
      for (const kw of rule.keywords) {
        if (trimmed.includes(kw)) score += 1;
      }
      // 表情匹配
      for (const emoji of rule.emojis) {
        if (trimmed.includes(emoji)) score += 1.5; // 表情权重更高
      }
      // 标点强度（感叹号、问号多 → arousal 提升）
      const exclaimCount = (trimmed.match(/[!！]/g) || []).length;
      const questionCount = (trimmed.match(/[?？]/g) || []).length;
      if (exclaimCount >= 2 && rule.arousal > 0.7) score += 0.5;

      if (score > 0) {
        if (!bestMatch || score > bestMatch.score) {
          if (bestMatch) secondaryMatch = bestMatch;
          bestMatch = { rule, score };
        } else if (!secondaryMatch || score > secondaryMatch.score) {
          secondaryMatch = { rule, score };
        }
      }
    }

    // 时段调整：深夜（23-5点）→ 疲惫/焦虑倾向提升
    const hour = opts?.hour ?? new Date().getHours();
    let hourAdjust = 0;
    if (hour >= 23 || hour < 5) {
      if (bestMatch?.rule.label === "疲惫" || bestMatch?.rule.label === "焦虑") {
        hourAdjust = 0.5;
      } else if (!bestMatch) {
        // 深夜无匹配 → 默认疲惫
        const fatigueRule = EMOTION_RULES.find((r) => r.label === "疲惫")!;
        bestMatch = { rule: fatigueRule, score: 0.5 };
      }
    }

    if (!bestMatch) {
      // 历史情绪延续
      const recent = opts?.recentEmotions?.slice(-1)[0];
      if (recent && recent !== "neutral") {
        const rule = EMOTION_RULES.find((r) => r.label === recent);
        if (rule) {
          return {
            emotion: {
              actorId,
              valence: rule.valence * 0.7, // 衰减
              arousal: rule.arousal * 0.6,
              dominance: rule.dominance,
              label: rule.label,
              confidence: 0.45,
              cause: "延续上轮情绪",
              intensity: rule.arousal * 0.6,
              detectedAt: now,
            },
            ruleConfidence: 0.45,
          };
        }
      }
      return {
        emotion: { actorId, ...DEFAULT_EMOTION, detectedAt: now },
        ruleConfidence: 0.3,
      };
    }

    const rule = bestMatch.rule;
    const intensity = Math.min(1, rule.arousal + Math.abs(rule.valence) * 0.3 + hourAdjust * 0.2);
    const confidence = Math.min(0.95, 0.5 + bestMatch.score * 0.15 + hourAdjust * 0.1);

    return {
      emotion: {
        actorId,
        valence: rule.valence,
        arousal: rule.arousal,
        dominance: rule.dominance,
        label: rule.label,
        confidence,
        cause: this.inferCause(rule.label, trimmed),
        intensity,
        secondaryLabel: secondaryMatch?.rule.label,
        detectedAt: now,
      },
      ruleConfidence: confidence,
    };
  }

  private inferCause(label: string, text: string): string {
    // 简单因果推断：提取可能的原因短语
    const causePatterns: Record<string, RegExp[]> = {
      "愤怒": [/因为(.{2,20})/, /(.{2,15})气死/, /(.{2,15})烦死/],
      "焦虑": [/担心(.{2,20})/, /害怕(.{2,20})/, /(.{2,15})压力/],
      "悲伤": [/(.{2,15})难过/, /(.{2,15})伤心/, /失去(.{2,15})/],
      "开心": [/(.{2,15})开心/, /(.{2,15})棒/],
    };
    const patterns = causePatterns[label];
    if (patterns) {
      for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]) return m[1].slice(0, 40);
      }
    }
    return "";
  }

  // ---- L2 LLM 层 ----

  private async recognizeByLlm(
    actorId: string,
    text: string,
    fallback: EmotionVector,
  ): Promise<EmotionVector | null> {
    if (!this.provider) return null;

    try {
      const systemPrompt =
        "你是情绪识别器。分析用户文本的情绪，输出 JSON：{\"label\":\"情绪标签\",\"valence\":-1到1,\"arousal\":0到1,\"dominance\":0到1,\"intensity\":0到1,\"cause\":\"简短原因或空\"}。标签用中文：开心/悲伤/愤怒/焦虑/疲惫/平静/兴奋/感激/困惑/恐惧/骄傲/羞愧。只输出 JSON。";

      let responseText = "";
      const onDelta = (delta: string) => {
        responseText += delta;
      };

      await this.provider.streamCompletion(
        `emotion_recognition_${actorId}_${Date.now()}`,
        { text },
        onDelta,
        undefined,
        {
          ephemeralTurn: true,
          systemPromptOverride: systemPrompt,
          disableThinking: true,
          maxThreadMessages: 0,
          ...buildModelOverrideOpts(TaskTier.MINI),
        },
      );

      const parsed = this.parseEmotionJson(responseText, actorId);
      return parsed ?? fallback;
    } catch (err) {
      console.log(`[EmotionRecognition] L2 LLM 失败: ${err}`);
      return null;
    }
  }

  private parseEmotionJson(
    raw: string,
    actorId: string,
  ): EmotionVector | null {
    try {
      // 提取 JSON
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const obj = JSON.parse(jsonMatch[0]);

      const valence = Number(obj.valence);
      const arousal = Number(obj.arousal);
      const dominance = Number(obj.dominance);
      const intensity = Number(obj.intensity);

      if (!Number.isFinite(valence) || !Number.isFinite(arousal)) return null;

      return {
        actorId,
        valence: Math.max(-1, Math.min(1, valence)),
        arousal: Math.max(0, Math.min(1, arousal)),
        dominance: Math.max(0, Math.min(1, dominance || 0.5)),
        label: String(obj.label || "neutral"),
        confidence: 0.8,
        cause: obj.cause ? String(obj.cause).slice(0, 60) : undefined,
        intensity: Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : undefined,
        detectedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
