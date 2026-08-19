/**
 * LLM 语义意图解析服务。
 *
 * 对用户原始消息做真实语义理解，输出结构化意图（类别/实体/子意图/置信度/是否澄清），
 * 供路由决策与工具选择消费。仅在 externalChat 可用时启用，失败时返回降级结果，
 * 不阻塞主流程。
 *
 * 用法与 schedule-intent-service 类似：复用 externalChat.streamCompletion，
 * 通过 JSON 结构化输出。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import type {
  ClarificationQuestion,
  IntentCategory,
  IntentEntity,
  SemanticIntent,
} from "./semantic-intent-types.js";

const VALID_CATEGORIES: IntentCategory[] = [
  "query",
  "command",
  "schedule",
  "chat",
  "tool_call",
  "multi_step",
  "clarification",
  "unknown",
];

export class SemanticIntentService {
  constructor(private readonly externalChat: ExternalChatProvider | null = null) {}

  isEnabled(): boolean {
    return this.externalChat?.isEnabled() === true;
  }

  /**
   * 解析用户消息意图。上下文可选：上一轮意图 + 本轮是否为澄清回答。
   * 任何异常都返回降级结果（unknown / confidence 0.2），绝不抛错。
   */
  async parseIntent(
    sessionId: string,
    userText: string,
    context?: { previousIntent?: SemanticIntent; clarificationAnswer?: string },
  ): Promise<SemanticIntent> {
    if (!this.isEnabled()) {
      return this.fallbackIntent(userText);
    }
    const prompt = this.buildPrompt(userText, context);
    try {
      const text = await this.externalChat?.streamCompletion(sessionId, { text: prompt }, () => {
        // 意图解析无需流式回传
      });
      if (!text?.trim()) return this.fallbackIntent(userText);
      const parsed = this.parseJson(text);
      const intent = this.normalize(parsed, userText, text);
      return intent;
    } catch (err) {
      console.warn("[SemanticIntent] 解析失败，降级处理:", err instanceof Error ? err.message : err);
      return this.fallbackIntent(userText);
    }
  }

  // ---- prompt 构造 ----

  private buildPrompt(
    userText: string,
    context?: { previousIntent?: SemanticIntent; clarificationAnswer?: string },
  ): string {
    const lines: string[] = [];
    lines.push(
      "你是用户意图理解引擎。请真实理解下面这句用户消息的语义（不是关键词匹配），" +
        "判断用户真正想做什么，并输出结构化 JSON。",
    );
    lines.push("只返回 JSON，不要输出 markdown 或解释。");
    lines.push("JSON 结构：");
    lines.push("{");
    lines.push('  "intent": "一句话概括用户想做的事，如「查明天北京的天气」",');
    lines.push(
      '  "category": "query|command|schedule|chat|tool_call|multi_step|clarification|unknown",',
    );
    lines.push('  "confidence": 0.0~1.0,  // 你对意图判断的把握');
    lines.push('  "entities": [{"type": "time|location|person|amount|object|action|...", "value": "提取值"}],');
    lines.push('  "subIntents": ["子意图1", "子意图2"],  // 复杂句拆分；单意图给空数组');
    lines.push('  "clarificationNeeded": false,');
    lines.push('  "clarificationQuestion": {"question": "短口语化澄清问题", "options": ["选项1", "选项2"]},');
    lines.push('  "preferredMode": "fast|complex",');
    lines.push('  "preferredToolDomain": "weather|calendar|desktop|phone|search|wallet|reminder|shopping|... 或省略"');
    lines.push("}");
    lines.push("判断要点：");
    lines.push("- category=chat：寒暄/情绪/闲聊，不需要工具。");
    lines.push("- category=schedule：用户要设置提醒/日程/定时。");
    lines.push("- category=query：查信息/知识问答。");
    lines.push("- category=command：明确指令（打开/执行/创建/设置等）。");
    lines.push("- category=tool_call：明确点名要用某个工具/能力。");
    lines.push("- category=multi_step：一句话里含多个并列子任务。");
    lines.push("- category=clarification：用户正在回答上一轮的澄清问题。");
    lines.push("- category=unknown：确实无法判断（很少见，宁可给个合理猜测也别乱标 unknown）。");
    lines.push("- 只在真的存在明显歧义、不确认就很可能做错时，才置 clarificationNeeded=true 并给出澄清问题。");
    lines.push("- 澄清问题要短、口语化、给选项，方便用户一句话回答。");
    if (context?.previousIntent) {
      const prev = context.previousIntent;
      lines.push(
        `- 上一轮我理解的意图是「${prev.intent}」(${prev.category})，` +
          `我当时的判断置信度 ${prev.confidence.toFixed(2)}。` +
          "如果本轮消息像是回答澄清或纠正上一轮意图，category 用 clarification。",
      );
    }
    if (context?.clarificationAnswer) {
      lines.push(`- 用户本轮是对澄清问题「${context.clarificationAnswer}」的回答，据此确认真实意图。`);
    }
    lines.push(`用户消息：${userText}`);
    return lines.join("\n");
  }

  // ---- JSON 解析与归一化 ----

  private parseJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }

  private normalize(raw: Record<string, unknown> | null, userText: string, llmText: string): SemanticIntent {
    if (!raw) return this.fallbackIntent(userText);
    const category = this.toCategory(raw.category);
    const confidence = this.toConfidence(raw.confidence);
    const clarificationNeeded = Boolean(raw.clarificationNeeded);
    const intentText =
      typeof raw.intent === "string" && raw.intent.trim() ? raw.intent.trim() : userText.slice(0, 80);
    let clarificationQuestion: ClarificationQuestion | undefined;
    if (clarificationNeeded && raw.clarificationQuestion && typeof raw.clarificationQuestion === "object") {
      const q = raw.clarificationQuestion as Record<string, unknown>;
      const question = typeof q.question === "string" && q.question.trim() ? q.question.trim() : undefined;
      const options = Array.isArray(q.options)
        ? q.options.filter((o): o is string => typeof o === "string")
        : undefined;
      if (question) {
        clarificationQuestion = { question, options };
      }
    }
    return {
      intent: intentText,
      category,
      confidence,
      entities: this.toEntities(raw.entities),
      subIntents: this.toStringArray(raw.subIntents),
      clarificationNeeded,
      ...(clarificationQuestion ? { clarificationQuestion } : {}),
      preferredMode: raw.preferredMode === "complex" ? "complex" : "fast",
      ...(typeof raw.preferredToolDomain === "string" && raw.preferredToolDomain.trim()
        ? { preferredToolDomain: raw.preferredToolDomain.trim() }
        : {}),
      raw: llmText.slice(0, 400),
    };
  }

  private fallbackIntent(userText: string): SemanticIntent {
    return {
      intent: userText.slice(0, 80),
      category: "unknown",
      confidence: 0.2,
      entities: [],
      subIntents: [],
      clarificationNeeded: false,
      preferredMode: "fast",
    };
  }

  private toCategory(value: unknown): IntentCategory {
    if (typeof value === "string" && VALID_CATEGORIES.includes(value as IntentCategory)) {
      return value as IntentCategory;
    }
    return "unknown";
  }

  private toConfidence(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(1, value));
    }
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
    return 0.4;
  }

  private toEntities(value: unknown): IntentEntity[] {
    if (!Array.isArray(value)) return [];
    const out: IntentEntity[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const type = typeof rec.type === "string" && rec.type.trim() ? rec.type.trim() : "other";
      const v = typeof rec.value === "string" && rec.value.trim() ? rec.value.trim() : undefined;
      if (v === undefined) continue;
      out.push({ type, value: v });
    }
    return out;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
  }
}