// 语义觉察推断器（纯规则、零 LLM、零 token）
//
// 职责：从最近对话历史 + 活动状态，用关键词规则产出 UserMentalState
//（用户心智状态：当下意图分类 + 情绪成因 + 亲密度基线）。
//
// 设计原则：
//  - 不调 LLM，零 token 成本，因此可安全接入 automate 场景（如对话内主动钩子）。
//  - 宁可 unknown/neutral 也不编造：topicTrend 需要跨轮语义聚合，纯规则难以可靠，
//    故返回 null，交由上层决定如何使用。
//  - 仅在 AwarenessCortex.observeWithMental 显式按需调用，不随每轮对话常驻占用。
import type { SemanticAwarenessInferrer, UserMentalState, UserActivityState } from "./types.js";

// 意图分类关键词（首条命中即返回）
const INTENT_RULES: Array<{ category: UserMentalState["intentCategory"]; re: RegExp }> = [
  { category: "venting", re: /烦死|好烦|气死|难受|委屈|崩溃|憋屈|无语|emo|丧/i },
  { category: "seeking_help", re: /怎么办|帮帮我|求助|怎么弄|怎么搞|教我|帮个忙|需要你/i },
  { category: "planning", re: /换工作|筹备|计划|打算|想换|准备.*(旅|考|搬)|规划|考虑.*一下/i },
  { category: "executing", re: /正在做|赶工|在改|在写|在处理|实现.*中|做一半|进行到|写代码/i },
  { category: "reflecting", re: /复盘|总结|回想|反思|回顾|想想|回味/i },
  { category: "chatting", re: /你(觉得|认为|说呢)|聊聊|随便聊聊|分享|今天.*好玩|笑死/i },
];

// 情绪成因关键词（首条命中即返回）
const CAUSE_RULES: Array<{ cause: UserMentalState["emotionCause"]; re: RegExp }> = [
  { cause: "work_pressure", re: /加班|赶工|压力|任务|deadline|截止|工作|项目|业绩/i },
  { cause: "interpersonal", re: /同事|老板|朋友|吵架|误会|对象|家里人|没人理/i },
  { cause: "physical_unwell", re: /头疼|发烧|不舒服|生病|疼|感冒|没睡好/i },
  { cause: "anticipation", re: /好期待|快到了|要来了|终于.*拿到|快好起来了/i },
  { cause: "disappointment", re: /失望|没成|失败|落空|泡汤|黄了|白忙/i },
];

/** 从文本块中提取用户说的部分（历史通常形如「用户：xxx」），用于意图推断 */
function extractUserText(history: string | undefined): string {
  if (!history) return "";
  // 取所有「用户：…」片段；无则退化为整段
  const lines = history.split("\n");
  const userLines = lines
    .filter((l) => /^用户[:：]/.test(l.trim()))
    .map((l) => l.replace(/^用户[:：]\s*/, ""));
  return userLines.join("\n") || history;
}

export class SemanticAwarenessInferrerImpl implements SemanticAwarenessInferrer {
  private inferIntent(userText: string): UserMentalState["intentCategory"] {
    for (const rule of INTENT_RULES) {
      if (rule.re.test(userText)) return rule.category;
    }
    return "unknown";
  }

  private inferCause(userText: string): UserMentalState["emotionCause"] {
    for (const rule of CAUSE_RULES) {
      if (rule.re.test(userText)) return rule.cause;
    }
    return "neutral";
  }

  async infer(
    actorId: string,
    opts?: { recentConversationHistory?: string; recentActivity?: UserActivityState },
  ): Promise<UserMentalState> {
    const userText = extractUserText(opts?.recentConversationHistory);
    const activity = opts?.recentActivity?.activity;
    const intentCategory = this.inferIntent(userText);
    const emotionCause = this.inferCause(userText);

    const evidence: string[] = [];
    if (activity) evidence.push(`activity=${activity}`);
    if (userText) evidence.push("基于最近对话文本规则推断");

    return {
      actorId,
      intentCategory,
      emotionCause,
      // 纯规则无法可靠聚合跨轮话题趋势，不编造；等待未来的 LLM/图聚合版本填充。
      topicTrend: null,
      // 亲密度给出保守基线（无跨轮统计），未来由关系模型覆盖。
      relationshipCloseness: 0.5,
      evidence,
      inferredAt: new Date().toISOString(),
    };
  }
}