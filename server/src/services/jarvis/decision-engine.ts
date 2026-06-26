/**
 * Jarvis Decision Engine — 单点主动消息决策中心
 *
 * 替代原本散落在 ProactiveAgentCenter / ProactiveLifeRuntimeService /
 * ProactiveContactPolicyService 中的多套判定逻辑。
 *
 * 借鉴 ProactiveAgent (research) 的 value / disturb 双轨评估：
 *  1. 价值评估（value）：这条消息值不值得说
 *  2. 打扰评估（disturb）：现在说会打扰多少
 *  3. 比较两者差值决定 speak / silent
 *  4. LLM 决定具体说什么 / 用什么语气
 *
 * 借鉴 LangGraph 的可观测节点：每个判定都返回 rationale，便于调试。
 */

import type { ExternalChatProvider } from "../../external-model/types.js";
import type { PromptContextBuilder } from "../../agent/prompt-context-builder.js";
import type {
  PersonalizationContactPreferenceState,
  PersonalizationPromptSlice,
  PersonalizationRelationshipState,
  PersonalizationStyleProfileState,
  PersonalizationTimeRhythmState,
  UserPersonalizationService,
} from "../user-personalization/user-personalization-service.js";
import type { ProactiveOutboundMessageService } from "../proactive-outbound-message-service.js";
import type { JarvisMemoryBank } from "./memory-bank.js";
import type {
  JarvisChannel,
  JarvisChannelDecision,
  JarvisDecision,
  JarvisDecisionResult,
  JarvisDisturbScore,
  JarvisHarnessConfig,
  JarvisTrigger,
  JarvisTriggerCategory,
  JarvisValueScore,
} from "./types.js";

type Maybe<T> = T | null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isHourInRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

const SYSTEM_PROMPT = `You are JARVIS, a private life assistant deciding whether to proactively message the user.
Rules:
1. Sound natural, warm, and human — like a friend who actually pays attention.
2. Only speak when the signal is worth interrupting for. When in doubt, output SILENT.
3. Keep it to one short message (under 96 chars if possible).
4. If not worth saying, output SILENT exactly.
5. If the signal suggests stress or late-night work, reduce teasing and be gentler.
6. If the signal is celebratory or light, light humor is allowed when appropriate.
7. Use a SPECIFIC detail or observation — never speak in generic platitudes.
8. Match the user's preferred style (gentle / playful / direct) and language.
Output either one short message or SILENT.`;

export type DecisionEngineDeps = {
  externalChat: ExternalChatProvider | null;
  promptContextBuilder: PromptContextBuilder | null;
  outbound: ProactiveOutboundMessageService | null;
  memory: JarvisMemoryBank;
  personalization: UserPersonalizationService | null;
  isUserOnline: ((actorId: string) => boolean) | null;
  config: JarvisHarnessConfig;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export type DecisionContext = {
  trigger: JarvisTrigger;
  recentTriggers?: JarvisTrigger[];
  recentOutboundTexts?: string[];
};

export class JarvisDecisionEngine {
  constructor(private readonly deps: DecisionEngineDeps) {}

  /**
   * 决策主入口。返回完整可追溯的决策结果。
   */
  async decide(ctx: DecisionContext): Promise<JarvisDecisionResult> {
    const trigger = ctx.trigger;
    const startedAt = Date.now();

    // 1) 价值评估
    const value = this.evaluateValue(ctx);

    // 2) 打扰评估
    const disturb = this.evaluateDisturb(trigger);

    // 3) 比较：value 显著高于 disturb 才会开口
    const gap = value.composite - disturb.composite;
    const warningEmergency =
      trigger.category === "warning" || trigger.urgency >= 8.5;

    let decision: JarvisDecision;
    let rejectedBy: string | undefined;
    let rejectionReason: string | undefined;

    if (!warningEmergency && value.composite < 0.25) {
      decision = "silent";
      rejectedBy = "low_value";
      rejectionReason = `value.composite=${value.composite.toFixed(2)} < 0.25`;
    } else if (disturb.composite >= 0.92 && !warningEmergency) {
      decision = "silent";
      rejectedBy = "high_disturb";
      rejectionReason = `disturb.composite=${disturb.composite.toFixed(2)} >= 0.92`;
    } else if (!warningEmergency && gap < 0.05) {
      decision = "silent";
      rejectedBy = "gap_too_small";
      rejectionReason = `value-disturb=${gap.toFixed(2)} < 0.05`;
    } else {
      decision = "speak";
    }

    const result: JarvisDecisionResult = {
      triggerId: trigger.id,
      actorId: trigger.actorId,
      decision,
      value,
      disturb,
      rejectedBy,
      rejectionReason,
      rationale: [
        `value=${value.composite.toFixed(2)} (${value.rationale.join(",")})`,
        `disturb=${disturb.composite.toFixed(2)} (${disturb.rationale.join(",")})`,
        `gap=${gap.toFixed(2)}`,
        ...(warningEmergency ? ["emergency_override"] : []),
      ],
      decidedAt: new Date().toISOString(),
    };

    if (decision !== "speak") {
      result.latencyMs = Date.now() - startedAt;
      return result;
    }

    // 4) 通道选择
    const channelDecision = this.chooseChannel(trigger, value, disturb);
    result.channel = channelDecision.channel;

    // 5) LLM 生成内容
    const content = await this.generateContent(ctx, channelDecision.channel);
    if (!content) {
      result.decision = "silent";
      result.rejectedBy = "llm_silent";
      result.rejectionReason = "LLM chose SILENT or empty output";
      result.latencyMs = Date.now() - startedAt;
      return result;
    }
    result.content = content;
    result.latencyMs = Date.now() - startedAt;
    return result;
  }

  // ────────────────────── 价值评估 ──────────────────────

  evaluateValue(ctx: DecisionContext): JarvisValueScore {
    const trigger = ctx.trigger;
    const rationale: string[] = [];
    const personalization = this.deps.personalization;
    const relationship = personalization?.getRelationshipState(trigger.actorId) ?? null;
    const timeRhythm = personalization?.getTimeRhythmState(trigger.actorId) ?? null;
    const styleProfile = personalization?.getStyleProfileState(trigger.actorId) ?? null;

    // 1) raw：信号原始价值
    const urgency = clamp(trigger.urgency / 10, 0, 1);
    const importanceMap: Record<typeof trigger.importance, number> = {
      critical: 1,
      high: 0.78,
      medium: 0.5,
      low: 0.25,
    };
    const importanceScore = importanceMap[trigger.importance];
    const raw = clamp(urgency * 0.55 + importanceScore * 0.25 + trigger.confidence * 0.2, 0, 1);
    rationale.push(`raw=${raw.toFixed(2)}`);

    // 2) contextual：多信号融合（同 actor 近 1h 内同类信号）
    const recent = (ctx.recentTriggers ?? []).filter(
      (t) => t.category === trigger.category && Date.now() - Date.parse(t.occurredAt) < 60 * 60_000,
    );
    const reinforcement = clamp(recent.length * 0.08, 0, 0.4);
    const suppression = clamp(
      this.deps.memory.recentNegativeRatio(trigger.actorId, trigger.category, 20) * 0.5,
      0,
      0.5,
    );
    const contextual = clamp(raw + reinforcement - suppression, 0, 1);
    rationale.push(
      `context=+${reinforcement.toFixed(2)} (${recent.length} rec) -${suppression.toFixed(2)} (neg)`,
    );

    // 3) novelty：新颖度（自发性扫描 + 跨日信号权重高）
    const sameDay = (ctx.recentTriggers ?? []).filter(
      (t) =>
        t.category === trigger.category &&
        new Date(t.occurredAt).toDateString() === new Date().toDateString(),
    ).length;
    const novelty = clamp(0.6 - sameDay * 0.12, 0.05, 1);
    rationale.push(`novelty=${novelty.toFixed(2)} (${sameDay} today)`);

    // 4) userInterest：与用户兴趣 / 关系的契合度
    const proactiveTolerance = relationship?.proactiveTolerance ?? 0.5;
    const rapport = relationship?.rapport ?? 0.35;
    const encouragement = relationship?.encouragementNeed ?? 0.4;
    let userInterest = proactiveTolerance * 0.45 + rapport * 0.25;
    if (trigger.category === "care" && encouragement > 0.5) userInterest += 0.15;
    if (trigger.category === "warning") userInterest += 0.2; // warning 永远值得
    userInterest = clamp(userInterest, 0, 1);
    rationale.push(`userInterest=${userInterest.toFixed(2)}`);

    // 5) silenceCost：不说的代价
    const categoryCost: Record<JarvisTriggerCategory, number> = {
      care: 0.85,
      warning: 0.95,
      opportunity: 0.6,
      planning: 0.55,
      completion: 0.35,
      newness: 0.4,
      follow_up: 0.5,
      presence: 0.3,
      social: 0.45,
      finance: 0.7,
      general: 0.25,
    };
    const silenceCost = categoryCost[trigger.category] ?? 0.3;
    rationale.push(`silenceCost=${silenceCost.toFixed(2)} (${trigger.category})`);

    // 6) composite：加权汇总
    const composite = clamp(
      raw * 0.18 +
        contextual * 0.22 +
        novelty * 0.12 +
        userInterest * 0.23 +
        silenceCost * 0.25,
      0,
      1,
    );

    return {
      raw,
      contextual,
      novelty,
      userInterest,
      silenceCost,
      composite,
      rationale,
    };
  }

  // ────────────────────── 打扰评估 ──────────────────────

  evaluateDisturb(trigger: JarvisTrigger): JarvisDisturbScore {
    const rationale: string[] = [];
    const now = new Date();
    const hour = now.getHours();
    const personalization = this.deps.personalization;
    const contactPref =
      personalization?.getContactPreferenceState(trigger.actorId) ?? null;
    const timeRhythm = personalization?.getTimeRhythmState(trigger.actorId) ?? null;
    const relationship = personalization?.getRelationshipState(trigger.actorId) ?? null;

    // 1) temporal：quiet hours
    const quietStart = contactPref?.quietHoursStart ?? 23;
    const quietEnd = contactPref?.quietHoursEnd ?? 8;
    const inQuiet = isHourInRange(hour, quietStart, quietEnd);
    const isLateNight = hour >= 23 || hour <= 5;
    let temporal = inQuiet ? 0.55 : 0.1;
    if (isLateNight) temporal += 0.15;
    // receptive hours 可以稍微降低
    const receptive = timeRhythm?.receptiveHours?.[String(hour).padStart(2, "0")] ?? 0;
    if (receptive > 0.5) temporal -= 0.1;
    temporal = clamp(temporal, 0, 1);
    rationale.push(`temporal=${temporal.toFixed(2)} (quiet=${inQuiet})`);

    // 2) fatigue：最近推送频率
    const recentHour = this.deps.outbound?.countSince(trigger.actorId, 60 * 60_000) ?? 0;
    const recentDay = this.deps.outbound?.countSince(trigger.actorId, 24 * 60 * 60_000) ?? 0;
    const fatigue = clamp(recentHour * 0.08 + recentDay * 0.025, 0, 1);
    rationale.push(`fatigue=${fatigue.toFixed(2)} (h=${recentHour},d=${recentDay})`);

    // 3) receptivity：接收概率预测（在线 + 时段 + 历史）
    const online = this.deps.isUserOnline?.(trigger.actorId) ?? true;
    let receptivity = 0.3;
    if (online) receptivity -= 0.1; // 在线 = 不在线都打扰
    receptivity += receptive * 0.2;
    if (isLateNight) receptivity += 0.15;
    receptivity = clamp(receptivity, 0, 1);
    rationale.push(`receptivity=${receptivity.toFixed(2)} (online=${online})`);

    // 4) context：用户偏好（proactive tolerance 低 = 容易被打扰）
    const tolerance = relationship?.proactiveTolerance ?? 0.5;
    const rapport = relationship?.rapport ?? 0.35;
    const context = clamp((1 - tolerance) * 0.55 + (rapport < 0.35 ? 0.2 : 0), 0, 1);
    rationale.push(`context=${context.toFixed(2)} (tolerance=${tolerance.toFixed(2)})`);

    // 5) composite
    const composite = clamp(
      temporal * 0.4 + fatigue * 0.25 + receptivity * 0.2 + context * 0.15,
      0,
      1,
    );

    return {
      temporal,
      fatigue,
      receptivity,
      context,
      composite,
      rationale,
    };
  }

  // ────────────────────── 通道选择 ──────────────────────

  chooseChannel(
    trigger: JarvisTrigger,
    value: JarvisValueScore,
    disturb: JarvisDisturbScore,
  ): JarvisChannelDecision {
    const personalization = this.deps.personalization;
    const contactPref = personalization?.getContactPreferenceState(trigger.actorId) ?? null;
    const relationship = personalization?.getRelationshipState(trigger.actorId) ?? null;
    const styleProfile = personalization?.getStyleProfileState(trigger.actorId) ?? null;
    const channelAffinity = contactPref?.channelAffinity ?? {
      websocket: 0.62,
      voice: 0.46,
      phone_call: 0.3,
    };
    const online = this.deps.isUserOnline?.(trigger.actorId) ?? true;

    const isWarning = trigger.category === "warning" || trigger.urgency >= 8.5;
    const isCare = trigger.category === "care";
    const directness = relationship?.directnessPreference ?? 0.5;
    const careStyle = styleProfile?.careStyle ?? "gentle";

    let channel: JarvisChannel = "websocket";
    let reasonParts: string[] = ["default_websocket"];

    // 升级路径
    if (isWarning && !online && channelAffinity.phone_call >= 0.3) {
      channel = "phone_call";
      reasonParts = ["warning_offline", "phone_call"];
    } else if (
      isWarning &&
      trigger.urgency >= 8.5 &&
      channelAffinity.phone_call >= 0.28 &&
      value.composite >= 0.7
    ) {
      channel = "phone_call";
      reasonParts = ["warning_high_urgency", "phone_call"];
    } else if (
      (isCare && careStyle !== "direct" && trigger.urgency >= 6 && channelAffinity.voice >= 0.4) ||
      (!online && trigger.urgency >= 6.5 && channelAffinity.voice >= 0.4)
    ) {
      channel = "voice";
      reasonParts = ["care_voice_or_offline"];
    } else if (trigger.urgency >= 7 && channelAffinity.voice >= 0.5) {
      channel = "voice";
      reasonParts = ["high_urgency_voice"];
    }

    // 降级路径
    if (disturb.temporal >= 0.4 && channel !== "websocket" && !isWarning) {
      channel = "websocket";
      reasonParts.push("downgraded_quiet_hours");
    }
    if (directness >= 0.7 && trigger.category === "planning" && channel === "voice") {
      channel = "websocket";
      reasonParts.push("prefer_text_for_direct_planning");
    }

    return {
      channel,
      reason: reasonParts.join("+"),
      quietHours: disturb.temporal >= 0.4,
    };
  }

  // ────────────────────── LLM 内容生成 ──────────────────────

  async generateContent(
    ctx: DecisionContext,
    channel: JarvisChannel,
  ): Promise<string | null> {
    if (!this.deps.externalChat?.isEnabled()) {
      // LLM 不可用时，使用模板兜底
      return this.templateContent(ctx, channel);
    }
    const trigger = ctx.trigger;
    const personalization = this.deps.personalization;
    let promptSlice: PersonalizationPromptSlice | undefined = undefined;
    if (personalization) {
      try {
        promptSlice = await personalization.getPromptSlice(
          trigger.actorId,
          `${trigger.title} ${trigger.summary}`,
        );
      } catch {
        promptSlice = undefined;
      }
    }
    const recentStr = (ctx.recentOutboundTexts ?? []).slice(-3).join("\n");
    const memoryRecall = this.deps.memory
      .recall(trigger.actorId, trigger, 5)
      .map((entry) => `[${entry.kind}] ${entry.body}`)
      .join("\n");

    const userPrompt = [
      `Event: ${trigger.title}`,
      `Summary: ${trigger.summary}`,
      trigger.description ? `Detail: ${trigger.description}` : "",
      `Category: ${trigger.category}`,
      `Urgency: ${trigger.urgency.toFixed(1)}/10`,
      `Channel: ${channel}`,
      trigger.evidence.length > 0 ? `Evidence:\n${trigger.evidence.join("\n")}` : "",
      memoryRecall ? `Memory recall:\n${memoryRecall}` : "",
      recentStr ? `Recent proactive lines:\n${recentStr}` : "",
      channel === "voice" ? "This will be spoken aloud, so be conversational." : "This will be displayed as a short message.",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const baseOpts =
        this.deps.promptContextBuilder?.build({
          actorId: trigger.actorId,
          personalization: promptSlice,
        }) ?? {};
      let fullText = "";
      await this.deps.externalChat.streamCompletion(
        `jarvis:${trigger.actorId}:${trigger.id}`,
        { text: userPrompt },
        (delta: string) => {
          fullText += delta;
        },
        undefined,
        {
          ...baseOpts,
          ephemeralTurn: true,
          systemPromptOverride: SYSTEM_PROMPT,
          chatToolsExtra: [],
          maxThreadMessages: 1,
          disableThinking: true,
          modelOverride: this.deps.config.decisionModel,
        } as Record<string, unknown>,
      );
      const trimmed = fullText.trim();
      if (!trimmed || trimmed.toUpperCase() === "SILENT") return null;
      return trimmed.slice(0, this.deps.config.maxResponseChars);
    } catch (err) {
      this.deps.logger?.warn(
        `[JarvisDecision] LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.templateContent(ctx, channel);
    }
  }

  /**
   * 模板兜底（LLM 不可用时仍能给出合理消息）
   */
  private templateContent(ctx: DecisionContext, channel: JarvisChannel): string | null {
    const trigger = ctx.trigger;
    const styleProfile = this.deps.personalization?.getStyleProfileState(trigger.actorId) ?? null;
    const careStyle = styleProfile?.careStyle ?? "gentle";
    const prefix = careStyle === "playful" ? "嘿，" : careStyle === "direct" ? "" : "";

    const templates: Record<JarvisTriggerCategory, string> = {
      care:
        trigger.urgency >= 8
          ? `${prefix}注意到你今天状态不太对，要不先放下手头的事，喘口气？`
          : `${prefix}看你最近有点累，注意休息。`,
      warning: `${prefix}市场有点异动，要不要看一下？`,
      opportunity: `${prefix}有个不错的机会，跟你的兴趣挺匹配。`,
      planning: `${prefix}你今天的日程快到了。`,
      completion: `${prefix}搞定！`,
      newness: `${prefix}有新的东西到了。`,
      follow_up: `${prefix}你之前提的那个事，后续怎么样？`,
      presence: `${prefix}想到你，最近怎么样？`,
      social: `${prefix}有朋友在找你。`,
      finance: `${prefix}账户有变化。`,
      general: `${prefix}${trigger.title}`,
    };
    const tpl = templates[trigger.category] ?? templates.general;
    if (channel === "voice") {
      // 语音时去掉标点更自然
      return tpl.replace(/[，。！？,!?]/g, " ").trim();
    }
    return tpl;
  }
}
