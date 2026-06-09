import type { AgentMemorySyncService } from "../agent-memory-sync-service.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import {
  buildToneGuidance,
  defaultEmotionState,
  detectEmotionFromText,
  detectPreferredToneFromText,
  dominantRecentEmotion,
  pushEmotion,
  type EmotionState,
  type PreferredTone,
} from "./emotion-tone.js";
import {
  applyProfilePatches,
  extractProfilePatches,
  syncPreferredToneInProfile,
} from "./profile-heuristics.js";
import { UserProfileStore } from "./user-profile-store.js";
import {
  buildFactPromptSummary,
  decayFactStore,
  defaultFactStore,
  extractFactCandidates,
  mergeFactCandidates,
  toFactStore,
} from "./user-profile-facts.js";
import {
  defaultContactPreferenceState,
  ProactiveContactPolicyService,
  type ProactiveContactChannel,
  type ProactiveContactPreferenceState,
} from "../proactive-contact-policy.js";

const EMOTION_STATE_KEY = "emotion_state";
const USER_PROFILE_KV_KEY = "user_profile";
const USER_BEHAVIOR_SIGNAL_KEY = "user_behavior_signal";
const USER_PROFILE_FACTS_KEY = "user_profile_facts";
const USER_RELATIONSHIP_KEY = "user_relationship_state";
const USER_TIME_RHYTHM_KEY = "user_time_rhythm";
const USER_STYLE_PROFILE_KEY = "user_style_profile";
const USER_CONTACT_PREFERENCE_KEY = "user_contact_preference";

type BehaviorSignals = {
  shoppingInterest: number;
  planningInterest: number;
  companionNeed: number;
  privacyConcern: number;
  updatedAt: string;
};

type RelationshipState = {
  warmth: number;
  humorTolerance: number;
  proactiveTolerance: number;
  encouragementNeed: number;
  directnessPreference: number;
  rapport: number;
  lastUpdatedAt: string;
};

type TimeRhythmState = {
  activeHours: Record<string, number>;
  receptiveHours: Record<string, number>;
  weekdayActivity: Record<string, number>;
  weekdayReceptive: Record<string, number>;
  lateNightTolerance: number;
  weekendTolerance: number;
  lastUpdatedAt: string;
};

type StyleProfileState = {
  banterLevel: number;
  careStyle: "gentle" | "playful" | "direct";
  motivationStyle: "encouraging" | "steady" | "push";
  initiativeStyle: "reserved" | "balanced" | "proactive";
  lastUpdatedAt: string;
};
const contactPolicy = new ProactiveContactPolicyService();

const TONE_ZH: Record<PreferredTone, string> = {
  humor: "幽默轻松",
  formal: "正式专业",
  warm: "温馨亲切",
  balanced: "自然均衡",
};

function weekdayKey(date: Date): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()] ?? "unknown";
}

export function isUserPersonalizationEnabled(): boolean {
  const raw = process.env.AGENT_USER_PERSONALIZATION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

function profileLlmEveryNTurns(): number {
  const n = Number.parseInt(process.env.AGENT_USER_PROFILE_LLM_EVERY_N ?? "8", 10);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

function toEmotionState(v: unknown): EmotionState {
  if (!v || typeof v !== "object") return defaultEmotionState();
  const o = v as Record<string, unknown>;
  const recent = Array.isArray(o.recent)
    ? o.recent.filter((x): x is EmotionState["recent"][number] =>
        x === "positive" || x === "neutral" || x === "negative" || x === "stressed",
      )
    : [];
  const preferredTone =
    o.preferredTone === "humor" ||
    o.preferredTone === "formal" ||
    o.preferredTone === "warm" ||
    o.preferredTone === "balanced"
      ? o.preferredTone
      : "balanced";
  return {
    recent: recent.slice(-6),
    preferredTone,
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
    turnCount: Number(o.turnCount) || 0,
  };
}

function defaultBehaviorSignals(): BehaviorSignals {
  return {
    shoppingInterest: 0,
    planningInterest: 0,
    companionNeed: 0,
    privacyConcern: 0,
    updatedAt: new Date().toISOString(),
  };
}

function defaultRelationshipState(): RelationshipState {
  return {
    warmth: 0.5,
    humorTolerance: 0.5,
    proactiveTolerance: 0.5,
    encouragementNeed: 0.4,
    directnessPreference: 0.5,
    rapport: 0.35,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultTimeRhythmState(): TimeRhythmState {
  return {
    activeHours: {},
    receptiveHours: {},
    weekdayActivity: {},
    weekdayReceptive: {},
    lateNightTolerance: 0.35,
    weekendTolerance: 0.45,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultStyleProfileState(): StyleProfileState {
  return {
    banterLevel: 0.4,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  };
}

function toContactPreferenceState(v: unknown): ProactiveContactPreferenceState {
  if (!v || typeof v !== "object") return defaultContactPreferenceState();
  const o = v as Record<string, unknown>;
  const channelAffinityRaw =
    o.channelAffinity && typeof o.channelAffinity === "object"
      ? (o.channelAffinity as Record<string, unknown>)
      : {};
  const channelAffinity = {
    websocket: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.websocket) || 0.62)),
    voice: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.voice) || 0.46)),
    phone_call: Math.min(0.95, Math.max(0.05, Number(channelAffinityRaw.phone_call) || 0.3)),
  };
  return {
    channelAffinity,
    quietHoursStart: Math.min(23, Math.max(0, Number(o.quietHoursStart) || 23)),
    quietHoursEnd: Math.min(23, Math.max(0, Number(o.quietHoursEnd) || 8)),
    maxDailyProactiveContacts: Math.min(
      12,
      Math.max(2, Number(o.maxDailyProactiveContacts) || 6),
    ),
    voiceUrgencyThreshold: Math.min(9, Math.max(5.5, Number(o.voiceUrgencyThreshold) || 6.6)),
    phoneUrgencyThreshold: Math.min(9.7, Math.max(7.8, Number(o.phoneUrgencyThreshold) || 8.7)),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function toRelationshipState(v: unknown): RelationshipState {
  if (!v || typeof v !== "object") return defaultRelationshipState();
  const o = v as Record<string, unknown>;
  const clamp = (n: unknown, fallback: number) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.min(1, Math.max(0, x));
  };
  return {
    warmth: clamp(o.warmth, 0.5),
    humorTolerance: clamp(o.humorTolerance, 0.5),
    proactiveTolerance: clamp(o.proactiveTolerance, 0.5),
    encouragementNeed: clamp(o.encouragementNeed, 0.4),
    directnessPreference: clamp(o.directnessPreference, 0.5),
    rapport: clamp(o.rapport, 0.35),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function toTimeRhythmState(v: unknown): TimeRhythmState {
  if (!v || typeof v !== "object") return defaultTimeRhythmState();
  const o = v as Record<string, unknown>;
  const asNumMap = (value: unknown): Record<string, number> =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {};
  return {
    activeHours: asNumMap(o.activeHours),
    receptiveHours: asNumMap(o.receptiveHours),
    weekdayActivity: asNumMap(o.weekdayActivity),
    weekdayReceptive: asNumMap(o.weekdayReceptive),
    lateNightTolerance: Math.min(1, Math.max(0, Number(o.lateNightTolerance) || 0.35)),
    weekendTolerance: Math.min(1, Math.max(0, Number(o.weekendTolerance) || 0.45)),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function toStyleProfileState(v: unknown): StyleProfileState {
  if (!v || typeof v !== "object") return defaultStyleProfileState();
  const o = v as Record<string, unknown>;
  return {
    banterLevel: Math.min(1, Math.max(0, Number(o.banterLevel) || 0.4)),
    careStyle:
      o.careStyle === "playful" || o.careStyle === "direct" ? o.careStyle : "gentle",
    motivationStyle:
      o.motivationStyle === "encouraging" || o.motivationStyle === "push"
        ? o.motivationStyle
        : "steady",
    initiativeStyle:
      o.initiativeStyle === "reserved" || o.initiativeStyle === "proactive"
        ? o.initiativeStyle
        : "balanced",
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function relationshipSummaryLine(state: RelationshipState, style: StyleProfileState): string {
  const directness =
    state.directnessPreference >= 0.68
      ? "用户偏好直接表达，优先先给结论，少铺垫。"
      : "默认保持简短自然，必要时再补解释。";
  const humor =
    state.humorTolerance >= 0.7
      ? "可带一点轻微玩笑或俏皮感，但不要影响信息密度。"
      : state.humorTolerance <= 0.35
        ? "少玩梗少调侃，避免轻浮。"
        : "可以轻微口语化，不必硬凹幽默。";
  const care =
    style.careStyle === "playful"
      ? "整体语气可轻松一点。"
      : style.careStyle === "direct"
        ? "整体语气更利落一点。"
        : "整体语气保持温和自然。";
  return [
    directness,
    humor,
    care,
    "无论怎么个性化，默认都要精简、口语化、少废话，避免客服腔和过度正式。",
    "不要把用户硬归类成某种固定模板，优先根据他这段时间真实的说话方式持续微调。",
    "优先贴近用户当前说话方式；如果用户明显喜欢某种表达，就往那个方向小幅靠拢，不要突变。",
  ].join("\n");
}

function buildReplyLengthGuidance(userText: string): string {
  const text = userText.trim();
  const compactText = text.replace(/\s+/g, "");
  const shortExplicit =
    /(简单说|简短点|短一点|一句话|一两句|别展开|直接说结论|长话短说|太长不看|简洁点)/i.test(text);
  const longExplicit =
    /(详细说|展开说|具体一点|多说点|讲清楚|完整方案|详细分析|一步一步|越详细越好)/i.test(text);
  if (longExplicit) {
    return "本轮长度控制：用户明确要详细，信息给全，但仍先给结论，再展开，避免空话。";
  }
  if (shortExplicit || compactText.length <= 18) {
    return "本轮长度控制：尽量压到 1~2 句，先给结论，没被追问就别展开。";
  }
  if (compactText.length <= 60) {
    return "本轮长度控制：以短回复为主，2~4 句内解决；只保留必要信息。";
  }
  return "本轮长度控制：默认中短回复，先回答核心问题，再按需要补充，不要写成长文。";
}

function timeRhythmSummaryLine(rhythm: TimeRhythmState): string | undefined {
  const topHours = Object.entries(rhythm.receptiveHours)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => hour.padStart(2, "0"));
  const topWeekdays = Object.entries(rhythm.weekdayReceptive)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([day]) => day);
  if (topHours.length === 0 && topWeekdays.length === 0) return undefined;
  return `较适合主动互动的时间帧: ${topHours.join("、")}点左右 / ${topWeekdays.join("、")}；深夜容忍度=${rhythm.lateNightTolerance.toFixed(2)}；周末容忍度=${rhythm.weekendTolerance.toFixed(2)}`;
}

function toBehaviorSignals(v: unknown): BehaviorSignals {
  if (!v || typeof v !== "object") return defaultBehaviorSignals();
  const o = v as Record<string, unknown>;
  return {
    shoppingInterest: Number(o.shoppingInterest) || 0,
    planningInterest: Number(o.planningInterest) || 0,
    companionNeed: Number(o.companionNeed) || 0,
    privacyConcern: Number(o.privacyConcern) || 0,
    updatedAt:
      typeof o.updatedAt === "string" && o.updatedAt
        ? o.updatedAt
        : new Date().toISOString(),
  };
}

function detectBehaviorSignals(userText: string): Partial<BehaviorSignals> {
  const t = userText.toLowerCase();
  return {
    shoppingInterest:
      /(buy|shopping|price|deal|discount|coupon|amazon|walmart|costco|购买|比价|优惠|省钱)/i.test(t)
        ? 1
        : 0,
    planningInterest:
      /(plan|schedule|calendar|todo|reminder|deadline|安排|计划|日程|提醒|待办)/i.test(t)
        ? 1
        : 0,
    companionNeed:
      /(chat with me|talk to me|陪我|陪伴|孤独|lonely|support me|安慰)/i.test(t) ? 1 : 0,
    privacyConcern:
      /(privacy|private|data|delete|export|gdpr|ccpa|隐私|删除数据|导出数据)/i.test(t)
        ? 1
        : 0,
  };
}

function behaviorSummaryLine(signal: BehaviorSignals): string | undefined {
  const pairs: Array<[string, number]> = [
    ["shopping", signal.shoppingInterest],
    ["planning", signal.planningInterest],
    ["companion", signal.companionNeed],
    ["privacy", signal.privacyConcern],
  ];
  pairs.sort((a, b) => b[1] - a[1]);
  if (pairs[0][1] <= 0) return undefined;
  if (pairs[0][0] === "companion") {
    return "用户有陪伴型对话倾向：回复更偏真人聊天感，多倾听与共情，少办事式罗列。";
  }
  const top2 = pairs.slice(0, 2).map((x) => x[0]).join(", ");
  return `User long-term behavior tendency: ${top2}. Prioritize matching response style and actions.`;
}

function contactPreferenceSummaryLine(
  preference: ProactiveContactPreferenceState,
  rhythm: TimeRhythmState,
): string {
  const rankedChannels = Object.entries(preference.channelAffinity)
    .sort((a, b) => b[1] - a[1])
    .map(([channel]) => channel)
    .slice(0, 2)
    .join(", ");
  return `Preferred proactive contact: ${rankedChannels}; quiet hours ${String(preference.quietHoursStart).padStart(2, "0")}:00-${String(preference.quietHoursEnd).padStart(2, "0")}:00; daily contact budget ${preference.maxDailyProactiveContacts}; late-night tolerance ${rhythm.lateNightTolerance.toFixed(2)}.`;
}

export type PersonalizationPromptSlice = {
  userProfile?: string;
  toneGuidance?: string;
  relationshipGuidance?: string;
};

export type PersonalizationRelationshipState = ReturnType<typeof toRelationshipState>;
export type PersonalizationBehaviorSignals = ReturnType<typeof toBehaviorSignals>;
export type PersonalizationTimeRhythmState = ReturnType<typeof toTimeRhythmState>;
export type PersonalizationStyleProfileState = ReturnType<typeof toStyleProfileState>;
export type PersonalizationContactPreferenceState = ReturnType<typeof toContactPreferenceState>;
export type PersonalizationUnderstandingSnapshot = {
  relationship: PersonalizationRelationshipState;
  behavior: PersonalizationBehaviorSignals;
  timeRhythm: PersonalizationTimeRhythmState;
  styleProfile: PersonalizationStyleProfileState;
  contactPreference: PersonalizationContactPreferenceState;
  contactSummary: string;
};

export class UserPersonalizationService {
  private readonly store = new UserProfileStore();

  constructor(
    private readonly memory: AgentMemorySyncService | null,
    private readonly externalChat: ExternalChatProvider | null = null,
  ) {}

  async getPromptSlice(actorId: string, userText?: string): Promise<PersonalizationPromptSlice> {
    if (!isUserPersonalizationEnabled()) return {};
    let state = this.loadEmotionState(actorId);
    let behavior = this.loadBehaviorSignals(actorId);
    let relationship = this.loadRelationshipState(actorId);
    let rhythm = this.loadTimeRhythmState(actorId);
    let style = this.loadStyleProfileState(actorId);
    const facts = this.loadFactStore(actorId);
    const decayedFacts = decayFactStore(facts);
    if (userText?.trim()) {
      state = this.applyUserSignals(actorId, userText, state);
      behavior = this.applyBehaviorSignals(actorId, userText, behavior);
      relationship = this.applyRelationshipSignals(actorId, userText, relationship, state, behavior);
      rhythm = this.applyTimeRhythmSignals(actorId, rhythm);
      style = this.applyStyleProfile(actorId, userText, relationship, behavior, style);
    }
    const profile = await this.store.read(actorId);
    const maxChars = Number.parseInt(process.env.AGENT_USER_PROFILE_PROMPT_MAX_CHARS ?? "3500", 10);
    const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 3500;
    const userProfile = profile.length > cap ? `…（较早内容已截断）\n${profile.slice(-cap)}` : profile;
    return {
      userProfile,
      toneGuidance: [
        "基础回复纪律：默认用口语化短句，先说重点；除非用户明确要求展开，否则不要长篇铺垫、套话、总结腔。",
        userText?.trim() ? buildReplyLengthGuidance(userText) : undefined,
        buildToneGuidance(state),
        behaviorSummaryLine(behavior),
        timeRhythmSummaryLine(rhythm),
        contactPreferenceSummaryLine(this.loadContactPreferenceState(actorId), rhythm),
        buildFactPromptSummary(decayedFacts, 8),
      ].filter(Boolean).join("\n"),
      relationshipGuidance: relationshipSummaryLine(relationship, style),
    };
  }

  getRelationshipState(actorId: string): PersonalizationRelationshipState {
    return this.loadRelationshipState(actorId);
  }

  getBehaviorSignals(actorId: string): PersonalizationBehaviorSignals {
    return this.loadBehaviorSignals(actorId);
  }

  getTimeRhythmState(actorId: string): PersonalizationTimeRhythmState {
    return this.loadTimeRhythmState(actorId);
  }

  getStyleProfileState(actorId: string): PersonalizationStyleProfileState {
    return this.loadStyleProfileState(actorId);
  }

  getContactPreferenceState(actorId: string): PersonalizationContactPreferenceState {
    return this.loadContactPreferenceState(actorId);
  }

  observeContactOutcome(
    actorId: string,
    params: {
      channel: ProactiveContactChannel;
      responded: boolean;
      responseTimeMs?: number;
      feedback?: "positive" | "negative" | "neutral";
      quietHours?: boolean;
    },
  ): void {
    const current = this.loadContactPreferenceState(actorId);
    const next = contactPolicy.learnPreference(current, params);
    this.saveJsonState(actorId, USER_CONTACT_PREFERENCE_KEY, next);
  }

  getUnderstandingSnapshot(actorId: string): PersonalizationUnderstandingSnapshot {
    const relationship = this.loadRelationshipState(actorId);
    const behavior = this.loadBehaviorSignals(actorId);
    const timeRhythm = this.loadTimeRhythmState(actorId);
    const styleProfile = this.loadStyleProfileState(actorId);
    const contactPreference = this.loadContactPreferenceState(actorId);
    return {
      relationship,
      behavior,
      timeRhythm,
      styleProfile,
      contactPreference,
      contactSummary: contactPreferenceSummaryLine(contactPreference, timeRhythm),
    };
  }

  observeTurn(actorId: string, userText: string, _assistantText: string): void {
    if (!isUserPersonalizationEnabled()) return;
    void this.observeTurnAsync(actorId, userText).catch(() => {});
  }

  private async observeTurnAsync(actorId: string, userText: string): Promise<void> {
    const patches = extractProfilePatches(userText);
    let md = await this.store.read(actorId);
    if (patches.length > 0) md = applyProfilePatches(md, patches);
    const state = this.loadEmotionState(actorId);
    md = syncPreferredToneInProfile(md, TONE_ZH[state.preferredTone]);
    await this.store.write(actorId, md);
    this.syncProfileKv(actorId, md);
    this.updateFactStore(actorId, userText);
    const everyN = profileLlmEveryNTurns();
    if (everyN > 0 && state.turnCount > 0 && state.turnCount % everyN === 0) {
      await this.refineProfileWithLlm(actorId, userText, md);
    }
  }

  private applyUserSignals(actorId: string, userText: string, state: EmotionState): EmotionState {
    const emotion = detectEmotionFromText(userText);
    let next = pushEmotion(state, emotion);
    const tone = detectPreferredToneFromText(userText);
    if (tone) next = { ...next, preferredTone: tone };
    this.saveEmotionState(actorId, next);
    return next;
  }

  private loadEmotionState(actorId: string): EmotionState {
    if (!this.memory) return defaultEmotionState();
    return toEmotionState(this.memory.getSnapshot(actorId, [EMOTION_STATE_KEY]).entries[EMOTION_STATE_KEY]);
  }

  private loadFactStore(actorId: string) {
    if (!this.memory) return defaultFactStore();
    return toFactStore(this.memory.getSnapshot(actorId, [USER_PROFILE_FACTS_KEY]).entries[USER_PROFILE_FACTS_KEY]);
  }

  private loadRelationshipState(actorId: string): RelationshipState {
    if (!this.memory) return defaultRelationshipState();
    return toRelationshipState(this.memory.getSnapshot(actorId, [USER_RELATIONSHIP_KEY]).entries[USER_RELATIONSHIP_KEY]);
  }

  private loadTimeRhythmState(actorId: string): TimeRhythmState {
    if (!this.memory) return defaultTimeRhythmState();
    return toTimeRhythmState(this.memory.getSnapshot(actorId, [USER_TIME_RHYTHM_KEY]).entries[USER_TIME_RHYTHM_KEY]);
  }

  private loadStyleProfileState(actorId: string): StyleProfileState {
    if (!this.memory) return defaultStyleProfileState();
    return toStyleProfileState(this.memory.getSnapshot(actorId, [USER_STYLE_PROFILE_KEY]).entries[USER_STYLE_PROFILE_KEY]);
  }

  private loadContactPreferenceState(actorId: string): ProactiveContactPreferenceState {
    if (!this.memory) return defaultContactPreferenceState();
    return toContactPreferenceState(
      this.memory.getSnapshot(actorId, [USER_CONTACT_PREFERENCE_KEY]).entries[USER_CONTACT_PREFERENCE_KEY],
    );
  }

  private applyRelationshipSignals(
    actorId: string,
    userText: string,
    current: RelationshipState,
    emotion: EmotionState,
    behavior: BehaviorSignals,
  ): RelationshipState {
    const text = userText.toLowerCase();
    const humorBoost = /(调侃|开玩笑|搞笑|幽默|逗我|别太严肃|轻松一点|humor)/i.test(text) ? 0.12 : 0;
    const warmthBoost = /(安慰|鼓励|陪我|温柔|耐心|温暖|辛苦了|谢谢你)/i.test(text) ? 0.12 : 0;
    const directnessBoost = /(直接点|别绕|简短|一句话|别啰嗦|straight|direct)/i.test(text) ? 0.12 : 0;
    const proactiveBoost = behavior.planningInterest > 0 || behavior.companionNeed > 0 ? 0.08 : 0;
    const stressPenalty = emotion.recent.includes("stressed") || emotion.recent.includes("negative") ? 0.08 : 0;
    const rapportBoost = humorBoost * 0.45 + warmthBoost * 0.4 + proactiveBoost * 0.25 + (behavior.companionNeed > 0 ? 0.03 : 0);
    const next: RelationshipState = {
      warmth: Math.min(1, Math.max(0, current.warmth + warmthBoost - stressPenalty / 2)),
      humorTolerance: Math.min(1, Math.max(0, current.humorTolerance + humorBoost - stressPenalty / 2)),
      proactiveTolerance: Math.min(1, Math.max(0, current.proactiveTolerance + proactiveBoost - stressPenalty)),
      encouragementNeed: Math.min(1, Math.max(0, current.encouragementNeed + stressPenalty + (behavior.companionNeed > 0 ? 0.05 : 0))),
      directnessPreference: Math.min(1, Math.max(0, current.directnessPreference + directnessBoost)),
      rapport: Math.min(1, Math.max(0, current.rapport + rapportBoost - stressPenalty / 3)),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_RELATIONSHIP_KEY, next);
    return next;
  }

  private applyTimeRhythmSignals(actorId: string, current: TimeRhythmState): TimeRhythmState {
    const now = new Date();
    const hour = String(now.getHours()).padStart(2, "0");
    const day = weekdayKey(now);
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    const next: TimeRhythmState = {
      activeHours: { ...current.activeHours, [hour]: (current.activeHours[hour] ?? 0) + 1 },
      receptiveHours: { ...current.receptiveHours, [hour]: (current.receptiveHours[hour] ?? 0) + 1 },
      weekdayActivity: { ...current.weekdayActivity, [day]: (current.weekdayActivity[day] ?? 0) + 1 },
      weekdayReceptive: { ...current.weekdayReceptive, [day]: (current.weekdayReceptive[day] ?? 0) + 1 },
      lateNightTolerance:
        now.getHours() >= 23 || now.getHours() <= 2 ? Math.min(1, current.lateNightTolerance + 0.02) : current.lateNightTolerance,
      weekendTolerance: weekend ? Math.min(1, current.weekendTolerance + 0.02) : current.weekendTolerance,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_TIME_RHYTHM_KEY, next);
    return next;
  }

  private applyStyleProfile(
    actorId: string,
    userText: string,
    relationship: RelationshipState,
    behavior: BehaviorSignals,
    current: StyleProfileState,
  ): StyleProfileState {
    const text = userText.toLowerCase();
    const next: StyleProfileState = {
      banterLevel: Math.min(1, Math.max(0, current.banterLevel + (relationship.humorTolerance - 0.5) * 0.08)),
      careStyle:
        /(安慰|温柔|陪我|慢一点)/i.test(text)
          ? "gentle"
          : relationship.humorTolerance > 0.7 && relationship.rapport > 0.6
            ? "playful"
            : relationship.directnessPreference > 0.7
              ? "direct"
              : current.careStyle,
      motivationStyle:
        /(鼓励|打气|夸我)/i.test(text) ? "encouraging" : /(催我|推我|盯着我)/i.test(text) ? "push" : current.motivationStyle,
      initiativeStyle:
        relationship.proactiveTolerance > 0.7 || behavior.planningInterest > 4
          ? "proactive"
          : relationship.proactiveTolerance < 0.4
            ? "reserved"
            : "balanced",
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_STYLE_PROFILE_KEY, next);
    return next;
  }

  private updateFactStore(actorId: string, userText: string): void {
    if (!this.memory || !userText.trim()) return;
    void this.updateFactStoreAsync(actorId, userText);
  }

  private async updateFactStoreAsync(actorId: string, userText: string): Promise<void> {
    if (!this.memory) return;
    const candidates = extractFactCandidates(userText);
    if (!candidates.length) return;
    for (let i = 0; i < 8; i++) {
      const { revision, entries } = this.memory.getSnapshot(actorId, [USER_PROFILE_FACTS_KEY]);
      const current = toFactStore(entries[USER_PROFILE_FACTS_KEY]);
      const merged = mergeFactCandidates(decayFactStore(current), candidates);
      const r = await this.memory.applyPatch(actorId, revision, [{ key: USER_PROFILE_FACTS_KEY, op: "put", value: merged }]);
      if (r.ok) return;
    }
  }

  private loadBehaviorSignals(actorId: string): BehaviorSignals {
    if (!this.memory) return defaultBehaviorSignals();
    return toBehaviorSignals(this.memory.getSnapshot(actorId, [USER_BEHAVIOR_SIGNAL_KEY]).entries[USER_BEHAVIOR_SIGNAL_KEY]);
  }

  private applyBehaviorSignals(actorId: string, userText: string, current: BehaviorSignals): BehaviorSignals {
    const delta = detectBehaviorSignals(userText);
    const next: BehaviorSignals = {
      shoppingInterest: current.shoppingInterest + (delta.shoppingInterest ?? 0),
      planningInterest: current.planningInterest + (delta.planningInterest ?? 0),
      companionNeed: current.companionNeed + (delta.companionNeed ?? 0),
      privacyConcern: current.privacyConcern + (delta.privacyConcern ?? 0),
      updatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_BEHAVIOR_SIGNAL_KEY, next);
    return next;
  }

  private saveEmotionState(actorId: string, state: EmotionState): void {
    this.saveJsonState(actorId, EMOTION_STATE_KEY, state);
  }

  private saveJsonState(actorId: string, key: string, value: unknown): void {
    if (!this.memory) return;
    void this.saveJsonStateAsync(actorId, key, value);
  }

  private async saveJsonStateAsync(actorId: string, key: string, value: unknown): Promise<void> {
    if (!this.memory) return;
    for (let i = 0; i < 8; i++) {
      const { revision } = this.memory.getSnapshot(actorId, [key]);
      const r = await this.memory.applyPatch(actorId, revision, [{ key, op: "put", value }]);
      if (r.ok) return;
    }
  }

  private syncProfileKv(actorId: string, md: string): void {
    this.saveJsonState(actorId, USER_PROFILE_KV_KEY, md);
  }

  private async refineProfileWithLlm(actorId: string, latestUserText: string, currentMd: string): Promise<void> {
    if (!this.externalChat?.isEnabled()) return;
    const mood = dominantRecentEmotion(this.loadEmotionState(actorId).recent);
    const prompt = [
      "你是用户画像整理助手。根据现有 USER_PROFILE.md 与用户最近一句话，输出更新后的完整 Markdown。",
      "要求：保留原有有效信息；合并重复；不要编造用户未提及的事实；章节保持：基本信息、兴趣与习惯、沟通偏好、备注。",
      `用户最近说：${latestUserText.slice(0, 300)}`,
      `近期情绪倾向（供沟通偏好参考，勿当医疗诊断）：${mood}`,
      "",
      "当前 USER_PROFILE.md：",
      currentMd.slice(-4000),
    ].join("\n");
    let out = "";
    await this.externalChat.streamCompletion(
      `profile-refine:${actorId}:${Date.now()}`,
      { text: prompt },
      (delta) => {
        out += delta;
      },
      undefined,
      {
        ephemeralTurn: true,
        systemPromptOverride: "只输出 Markdown 正文，不要代码围栏，不要解释。以 # 用户画像 开头。",
        maxThreadMessages: 1,
        disableThinking: true,
      },
    );
    const trimmed = out.trim();
    if (!trimmed.startsWith("#")) return;
    await this.store.write(actorId, trimmed);
    this.syncProfileKv(actorId, trimmed);
  }
}
