import OpenAI from "openai";

export type MemoryDecision = "remember" | "reject" | "overwrite" | "decay";

export type MemorySemanticClass =
  | "stable_preference"
  | "stable_identity"
  | "stable_constraint"
  | "mutable_fact"
  | "commitment_or_todo"
  | "temporary_context"
  | "small_talk"
  | "low_signal_noise";

export type MemoryDecisionResult = {
  decision: MemoryDecision;
  confidence: number;
  semanticClass: MemorySemanticClass;
  reasons: string[];
};

export type MemoryDecisionContext = {
  actorId?: string;
  source?: string;
  userText?: string;
  assistantText?: string;
  heuristicHint?: MemoryDecision;
};

const SMALL_TALK_RE =
  /^(好|好的|嗯|哦|哈|哈哈|收到|知道了|行|可以|ok|okay|thanks|thank you|早安|晚安|拜拜|在吗|好的收到)[!！。.\s]*$/i;
const STABLE_PREFERENCE_RE =
  /喜欢|不喜欢|讨厌|偏好|习惯|总是|从不|口味|风格|常用|倾向|prefer|favorite/i;
const STABLE_IDENTITY_RE =
  /生日|纪念日|住在|学校|公司|职业|工作是|家人|宠物|名字|身份|城市|地址/i;
const STABLE_CONSTRAINT_RE =
  /禁忌|不要|别|不能|避免|忌口|过敏|敏感|必须|务必|长期|固定|默认/i;
const MUTABLE_FACT_RE =
  /现在|以后|改成|更新|不再|从今天起|最新|改为|变成|目前|如今|以后都|后续|new|update/i;
const COMMITMENT_RE =
  /承诺|结论|提醒|计划|待办|待办项|记住|记得|别忘|帮我记着|约定|下次|需要跟进/i;
const TEMPORARY_RE =
  /今天|刚刚|刚才|这一轮|这次|临时|稍后|待会|一下|短期|先这样|回头|明天再说|本次|这个会话/i;
const RISK_RE = /密码|授权|转账|删除|注销|风险|诈骗|异常|隐私|敏感/i;

function normalizedLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function buildResult(
  decision: MemoryDecision,
  confidence: number,
  semanticClass: MemorySemanticClass,
  reasons: string[],
): MemoryDecisionResult {
  return {
    decision,
    confidence: Math.max(0, Math.min(1, confidence)),
    semanticClass,
    reasons: reasons.slice(0, 6),
  };
}

function classifyHeuristically(text: string, context: MemoryDecisionContext): MemoryDecisionResult {
  const t = text.trim();
  const len = normalizedLength(t);

  if (!t || len < 6) {
    return buildResult("reject", 0.98, "low_signal_noise", ["too_short"]);
  }
  if (SMALL_TALK_RE.test(t)) {
    return buildResult("reject", 0.99, "small_talk", ["small_talk"]);
  }
  if (MUTABLE_FACT_RE.test(t) && (STABLE_PREFERENCE_RE.test(t) || STABLE_IDENTITY_RE.test(t))) {
    return buildResult("overwrite", 0.94, "mutable_fact", ["mutable_fact_update"]);
  }
  if (RISK_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.93, "stable_constraint", ["risk_or_sensitive_constraint"]);
  }
  if (STABLE_CONSTRAINT_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.91, "stable_constraint", ["long_term_constraint"]);
  }
  if (STABLE_PREFERENCE_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.89, "stable_preference", ["stable_preference"]);
  }
  if (STABLE_IDENTITY_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.88, "stable_identity", ["stable_identity"]);
  }
  if (COMMITMENT_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.84, "commitment_or_todo", ["commitment_or_followup"]);
  }
  if (TEMPORARY_RE.test(t)) {
    return buildResult("decay", 0.86, "temporary_context", ["temporary_context"]);
  }
  if (len < 24) {
    return buildResult("reject", 0.82, "low_signal_noise", ["low_information_density"]);
  }
  if (context.heuristicHint === "remember") {
    return buildResult("remember", 0.68, "commitment_or_todo", ["hinted_by_pipeline"]);
  }
  if (context.heuristicHint === "overwrite") {
    return buildResult("overwrite", 0.68, "mutable_fact", ["hinted_by_pipeline"]);
  }
  return buildResult("decay", 0.66, "temporary_context", ["default_decay"]);
}

function shouldTrustHeuristic(result: MemoryDecisionResult): boolean {
  if (result.decision === "reject" && result.confidence >= 0.96) return true;
  if (result.decision === "overwrite" && result.confidence >= 0.92) return true;
  if (result.decision === "remember" && result.confidence >= 0.9) return true;
  if (result.decision === "decay" && result.confidence >= 0.86) return true;
  return false;
}

async function llmDecision(
  text: string,
  context: MemoryDecisionContext,
  heuristic: MemoryDecisionResult,
): Promise<MemoryDecisionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Decide whether text should enter durable user memory. Use this taxonomy: stable_preference, stable_identity, stable_constraint, mutable_fact, commitment_or_todo, temporary_context, small_talk, low_signal_noise. Map taxonomy to decisions strictly: stable_preference/stable_identity/stable_constraint/commitment_or_todo => remember; mutable_fact => overwrite; temporary_context => decay; small_talk/low_signal_noise => reject. Favor reject/decay unless the text clearly helps future conversations beyond this session. Return JSON only: {\"decision\":\"remember|reject|overwrite|decay\",\"semanticClass\":\"...\",\"confidence\":0-1,\"reasons\":[...]}",
        },
        {
          role: "user",
          content: JSON.stringify({
            text,
            context,
            heuristic,
            guidance: {
              keep: [
                "stable user preferences",
                "durable identity facts",
                "long-term constraints and risks",
                "commitments requiring future follow-up",
              ],
              reject: [
                "greetings and acknowledgements",
                "low-information chat",
                "single-turn filler",
              ],
              decay: [
                "session-local temporary details",
                "time-bounded plans unless explicitly long-term",
              ],
              overwrite: ["updated preference or fact replacing previous value"],
            },
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as Partial<MemoryDecisionResult>;
    const decision = parsed.decision;
    const semanticClass = parsed.semanticClass;
    if (
      decision !== "remember" &&
      decision !== "reject" &&
      decision !== "overwrite" &&
      decision !== "decay"
    ) {
      return null;
    }
    const validClass: MemorySemanticClass[] = [
      "stable_preference",
      "stable_identity",
      "stable_constraint",
      "mutable_fact",
      "commitment_or_todo",
      "temporary_context",
      "small_talk",
      "low_signal_noise",
    ];
    if (!semanticClass || !validClass.includes(semanticClass)) {
      return null;
    }
    return buildResult(
      decision,
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0.5,
      semanticClass,
      Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return null;
  }
}

function mergeDecision(
  heuristic: MemoryDecisionResult,
  llm: MemoryDecisionResult | null,
): MemoryDecisionResult {
  if (!llm) return heuristic;
  if (shouldTrustHeuristic(heuristic)) return heuristic;
  if (llm.confidence >= 0.75) return llm;
  if (heuristic.decision === llm.decision) {
    return buildResult(
      heuristic.decision,
      Math.max(heuristic.confidence, llm.confidence),
      llm.semanticClass,
      [...heuristic.reasons, ...llm.reasons],
    );
  }
  if (heuristic.decision === "reject" && llm.decision === "remember" && heuristic.confidence >= 0.8) {
    return heuristic;
  }
  if (heuristic.decision === "decay" && llm.decision === "remember" && llm.confidence < 0.85) {
    return heuristic;
  }
  return llm.confidence >= heuristic.confidence ? llm : heuristic;
}

export async function decideMemoryWrite(
  text: string,
  context: MemoryDecisionContext = {},
): Promise<MemoryDecisionResult> {
  const heuristic = classifyHeuristically(text, context);
  const llm = shouldTrustHeuristic(heuristic) ? null : await llmDecision(text, context, heuristic);
  return mergeDecision(heuristic, llm);
}
