import type { AgentMemorySyncService } from "../agent-memory-sync-service.js";
import { isDirectFactQuery, shouldSuppressFollowUp } from "../../agent/direct-fact-query.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import { EmotionRecognitionService } from "../emotion-recognition-service.js";
import { PersonalityAdjuster } from "../../brain/personality-adjuster.js";
import type { PersonalityAdjustmentInput } from "../../brain/personality-adjuster.js";
import type { PersonalityCore } from "../../brain/types.js";
import {
  buildToneGuidance,
  defaultEmotionState,
  detectEmotionFromText,
  detectPreferredToneFromText,
  dominantRecentEmotion,
  pushEmotion,
  type EmotionLabel,
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
const USER_REPLY_LENGTH_PROFILE_KEY = "user_reply_length_profile";
const USER_BEHAVIOR_BASELINE_KEY = "behavior_baseline";
const BASELINE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BASELINE_ACTIVE_PROBABILITY_THRESHOLD = 0.3;
const BASELINE_SWITCH_POINT_DELTA = 0.1;

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

type BehaviorBaselineSwitchPoint = {
  hour: number;
  direction: "up" | "down";
};

type BehaviorBaselineActivePeriod = {
  start: number;
  end: number;
};

export type BehaviorBaseline = {
  hourlyActivityProbability: number[];
  activePeriods: BehaviorBaselineActivePeriod[];
  switchPoints: BehaviorBaselineSwitchPoint[];
  sampleCount: number;
  lastUpdated: number;
};

type StyleProfileState = {
  banterLevel: number;
  playfulTolerance: number;
  cuteTolerance: number;
  teasingTolerance: number;
  followUpTolerance: number;
  expressiveTolerance: number;
  careStyle: "gentle" | "playful" | "direct";
  motivationStyle: "encouraging" | "steady" | "push";
  initiativeStyle: "reserved" | "balanced" | "proactive";
  lastUpdatedAt: string;
};

type ReplyLengthProfileState = {
  avgUserChars: number;
  shortPreferenceScore: number;
  longPreferenceScore: number;
  recentUserChars: number[];
  sampleCount: number;
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
    playfulTolerance: 0.45,
    cuteTolerance: 0.35,
    teasingTolerance: 0.32,
    followUpTolerance: 0.48,
    expressiveTolerance: 0.42,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  };
}

function defaultReplyLengthProfileState(): ReplyLengthProfileState {
  return {
    avgUserChars: 36,
    shortPreferenceScore: 0,
    longPreferenceScore: 0,
    recentUserChars: [],
    sampleCount: 0,
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

function defaultBehaviorBaseline(): BehaviorBaseline {
  return {
    hourlyActivityProbability: Array.from({ length: 24 }, () => 0),
    activePeriods: [],
    switchPoints: [],
    sampleCount: 0,
    lastUpdated: 0,
  };
}

function toBehaviorBaseline(v: unknown): BehaviorBaseline {
  if (!v || typeof v !== "object") return defaultBehaviorBaseline();
  const o = v as Record<string, unknown>;
  const probRaw = Array.isArray(o.hourlyActivityProbability)
    ? o.hourlyActivityProbability
    : [];
  const hourlyActivityProbability = Array.from({ length: 24 }, (_, h) => {
    const n = Number(probRaw[h]);
    return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : 0;
  });
  const activePeriods: BehaviorBaselineActivePeriod[] = Array.isArray(o.activePeriods)
    ? o.activePeriods
        .map((p): BehaviorBaselineActivePeriod | null => {
          if (!p || typeof p !== "object") return null;
          const pe = p as Record<string, unknown>;
          const startRaw = Number(pe.start);
          const endRaw = Number(pe.end);
          if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return null;
          const start = Math.min(23, Math.max(0, Math.floor(startRaw)));
          const end = Math.min(23, Math.max(0, Math.floor(endRaw)));
          return { start, end: Math.max(end, start) };
        })
        .filter((p): p is BehaviorBaselineActivePeriod => p !== null)
    : [];
  const switchPoints: BehaviorBaselineSwitchPoint[] = Array.isArray(o.switchPoints)
    ? o.switchPoints
        .map((p): BehaviorBaselineSwitchPoint | null => {
          if (!p || typeof p !== "object") return null;
          const pe = p as Record<string, unknown>;
          const hourRaw = Number(pe.hour);
          if (!Number.isFinite(hourRaw)) return null;
          const direction: "up" | "down" =
            pe.direction === "up" ? "up" : pe.direction === "down" ? "down" : "up";
          return { hour: Math.min(23, Math.max(0, Math.floor(hourRaw))), direction };
        })
        .filter((p): p is BehaviorBaselineSwitchPoint => p !== null)
    : [];
  const sampleCountRaw = Number(o.sampleCount);
  const lastUpdatedRaw = Number(o.lastUpdated);
  return {
    hourlyActivityProbability,
    activePeriods,
    switchPoints,
    sampleCount: Number.isFinite(sampleCountRaw) && sampleCountRaw >= 0 ? sampleCountRaw : 0,
    lastUpdated: Number.isFinite(lastUpdatedRaw) && lastUpdatedRaw >= 0 ? lastUpdatedRaw : 0,
  };
}

function buildBaselineFromRhythm(rhythm: TimeRhythmState): BehaviorBaseline {
  const hourlyCounts = Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, "0");
    return rhythm.activeHours[key] ?? 0;
  });
  const rawTotal = hourlyCounts.reduce((a, b) => a + b, 0);
  const total = rawTotal > 0 ? rawTotal : 1;
  const hourlyActivityProbability = hourlyCounts.map((c) => c / total);

  const activePeriods: BehaviorBaselineActivePeriod[] = [];
  let periodStart: number | null = null;
  for (let h = 0; h < 24; h++) {
    const active = hourlyActivityProbability[h] > BASELINE_ACTIVE_PROBABILITY_THRESHOLD;
    if (active && periodStart === null) {
      periodStart = h;
    } else if (!active && periodStart !== null) {
      activePeriods.push({ start: periodStart, end: h - 1 });
      periodStart = null;
    }
  }
  if (periodStart !== null) {
    activePeriods.push({ start: periodStart, end: 23 });
  }

  const switchPoints: BehaviorBaselineSwitchPoint[] = [];
  for (let h = 1; h < 24; h++) {
    const diff = hourlyActivityProbability[h] - hourlyActivityProbability[h - 1];
    if (Math.abs(diff) > BASELINE_SWITCH_POINT_DELTA) {
      switchPoints.push({ hour: h, direction: diff > 0 ? "up" : "down" });
    }
  }

  return {
    hourlyActivityProbability,
    activePeriods,
    switchPoints,
    sampleCount: rawTotal,
    lastUpdated: Date.now(),
  };
}

function toStyleProfileState(v: unknown): StyleProfileState {
  if (!v || typeof v !== "object") return defaultStyleProfileState();
  const o = v as Record<string, unknown>;
  const clamp = (n: unknown, fallback: number) =>
    Math.min(1, Math.max(0, Number(n) || fallback));
  return {
    banterLevel: clamp(o.banterLevel, 0.4),
    playfulTolerance: clamp(o.playfulTolerance, 0.45),
    cuteTolerance: clamp(o.cuteTolerance, 0.35),
    teasingTolerance: clamp(o.teasingTolerance, 0.32),
    followUpTolerance: clamp(o.followUpTolerance, 0.48),
    expressiveTolerance: clamp(o.expressiveTolerance, 0.42),
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

function detectDynamicStyleSignals(userText: string): {
  playful: number;
  cute: number;
  teasing: number;
  followUp: number;
  expressive: number;
} {
  const text = userText.trim();
  return {
    playful:
      /(搞笑|幽默|逗|贫|皮一点|别太端着|松弛一点|活一点|梗|好玩|哈哈|笑死|乐了)/i.test(text)
        ? 0.14
        : 0,
    cute:
      /(卖萌|可爱一点|软一点|奶一点|撒娇|萌一点|乖一点)/i.test(text)
        ? 0.14
        : 0,
    teasing:
      /(损我|吐槽|内涵|阴阳|怼|别太正经|调侃我|嘴我两句)/i.test(text)
        ? 0.12
        : 0,
    followUp:
      /(追问|多问一句|继续问我|顺着聊|陪我聊|别只答完就停)/i.test(text)
        ? 0.15
        : 0,
    expressive:
      /[!！~～哈哈嘿嘿哇呀啦捏呗嘛嘞诶欸]|😂|😅|🥹|🤔|😎|🥲/u.test(text)
        ? 0.08
        : 0,
  };
}

function buildAdaptiveStyleGuidance(
  relationship: RelationshipState,
  style: StyleProfileState,
  userText?: string,
): string {
  const lines: string[] = [];
  const suppressFollowUp = userText ? shouldSuppressFollowUp(userText) : false;
  if (relationship.rapport >= 0.62 && style.playfulTolerance >= 0.58) {
    lines.push("关系已经熟一点了，可以偶尔顺手逗一句，像熟人聊天那样自然一点。");
  } else {
    lines.push("先别硬凹风格，优先自然接话，再一点点贴近用户。");
  }
  if (style.cuteTolerance >= 0.6) {
    lines.push("用户对软一点、萌一点的表达接受度高，偶尔带一点可爱感也行，但别连着来。");
  }
  if (style.teasingTolerance >= 0.56 && relationship.rapport >= 0.58) {
    lines.push("可以轻微调侃、吐槽、阴阳一下下，但尺度要像熟人拌嘴，不要真冒犯。");
  }
  if (suppressFollowUp) {
    lines.push("这轮更像单一事实查询：回答到结论和依据就停，不要顺手追加追问、兜圈总结或第二遍复述。");
  } else if (style.followUpTolerance >= 0.58) {
    lines.push("回答完可以顺手追问半句，把话题接住，别每次都机械收尾。");
  }
  if (style.expressiveTolerance >= 0.55) {
    lines.push("表达可以更有情绪起伏一点，允许少量语气词和表情感。");
  } else {
    lines.push("少堆语气词和表情，免得显得太演。");
  }
  lines.push("这些都不是固定人设，只能顺着用户当下的说话方式小幅贴近。");
  return lines.join("\n");
}

function relationshipSummaryLine(
  state: RelationshipState,
  style: StyleProfileState,
  userText?: string,
): string {
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
    buildAdaptiveStyleGuidance(state, style, userText),
    "无论怎么个性化，默认都要精简、口语化、少废话，避免客服腔和过度正式。",
    "不要把用户硬归类成某种固定模板，优先根据他这段时间真实的说话方式持续微调。",
    "优先贴近用户当前说话方式；如果用户明显喜欢某种表达，就往那个方向小幅靠拢，不要突变。",
  ].join("\n");
}

function toReplyLengthProfileState(v: unknown): ReplyLengthProfileState {
  if (!v || typeof v !== "object") return defaultReplyLengthProfileState();
  const o = v as Record<string, unknown>;
  const recentUserChars = Array.isArray(o.recentUserChars)
    ? o.recentUserChars
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x >= 0)
        .slice(-8)
    : [];
  return {
    avgUserChars: Math.max(1, Number(o.avgUserChars) || 36),
    shortPreferenceScore: Math.max(0, Number(o.shortPreferenceScore) || 0),
    longPreferenceScore: Math.max(0, Number(o.longPreferenceScore) || 0),
    recentUserChars,
    sampleCount: Math.max(0, Number(o.sampleCount) || recentUserChars.length || 0),
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function buildReplyLengthGuidance(userText: string, profile: ReplyLengthProfileState): string {
  const text = userText.trim();
  const compactText = text.replace(/\s+/g, "");
  const shortExplicit =
    /(简单说|简短点|短一点|一句话|一两句|别展开|直接说结论|长话短说|太长不看|简洁点)/i.test(text);
  const longExplicit =
    /(详细说|展开说|具体一点|多说点|讲清楚|完整方案|详细分析|一步一步|越详细越好)/i.test(text);
  if (longExplicit) {
    return "本轮长度控制：用户明确要详细，信息给全，但仍先给结论，再展开，避免空话。";
  }
  if (isDirectFactQuery(text)) {
    return "本轮长度控制：这是单一事实查询，默认压到「结论 + 1句依据」；不要重复总结，也不要顺手追问。";
  }
  if (shortExplicit || compactText.length <= 18) {
    return "本轮长度控制：尽量压到 1~2 句，先给结论，没被追问就别展开。";
  }
  if (
    profile.sampleCount >= 3 &&
    profile.shortPreferenceScore > profile.longPreferenceScore + 1.2 &&
    profile.avgUserChars <= 28
  ) {
    return "本轮长度控制：这个用户长期更偏短回复，默认压缩表达，2 句左右优先，非必要不展开。";
  }
  if (
    profile.sampleCount >= 3 &&
    profile.longPreferenceScore > profile.shortPreferenceScore + 1.2 &&
    profile.avgUserChars >= 65
  ) {
    return "本轮长度控制：这个用户长期接受稍展开的说明，可以多给一点上下文，但仍先讲重点。";
  }
  if (compactText.length <= 60) {
    return "本轮长度控制：以短回复为主，2~4 句内解决；只保留必要信息，同一事实不要重复解释两遍。";
  }
  return "本轮长度控制：默认中短回复，先回答核心问题，再按需要补充；避免重复总结、重复铺垫和连续追问。";
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
export type PersonalizationReplyLengthProfileState = ReturnType<typeof toReplyLengthProfileState>;
export type PersonalizationUnderstandingSnapshot = {
  relationship: PersonalizationRelationshipState;
  behavior: PersonalizationBehaviorSignals;
  timeRhythm: PersonalizationTimeRhythmState;
  styleProfile: PersonalizationStyleProfileState;
  contactPreference: PersonalizationContactPreferenceState;
  replyLengthProfile: PersonalizationReplyLengthProfileState;
  contactSummary: string;
};

/**
 * MemoryCortex 最小化外观接口（仅暴露人格内核读写，避免循环依赖）。
 *
 * UserPersonalizationService 通过此接口在 observeTurnAsync 中驱动 PersonalityAdjuster，
 * 后者调用 getPersonalityCore / setPersonalityCore 完成人格微调。
 */
interface MemoryCortexLike {
  getPersonalityCore(actorId: string): PersonalityCore;
  setPersonalityCore(actorId: string, core: PersonalityCore): void;
}

/** 把 EmotionRecognitionService 的细粒度中文标签映射回粗粒度 EmotionLabel */
function fineEmotionToCoarse(fineLabel: string): EmotionLabel {
  switch (fineLabel) {
    case "开心":
    case "兴奋":
    case "感激":
      return "positive";
    case "悲伤":
    case "愤怒":
      return "negative";
    case "焦虑":
      return "stressed";
    default:
      return "neutral";
  }
}

/** 根据细粒度情绪标签推断偏好语气（仅高置信度时覆盖） */
function inferPreferredToneFromFineEmotion(fineLabel: string): PreferredTone | null {
  switch (fineLabel) {
    case "悲伤":
    case "焦虑":
    case "疲惫":
      return "warm";
    case "开心":
    case "兴奋":
    case "感激":
      return "humor";
    case "愤怒":
      return "balanced";
    default:
      return null;
  }
}

export class UserPersonalizationService {
  private readonly store = new UserProfileStore();
  private readonly fallbackState = new Map<string, unknown>();
  /** 情绪识别服务（L1 规则 + L2 LLM mini） */
  private readonly emotionRecognition: EmotionRecognitionService;
  /** 人格自适应微调器（纯规则，clamp ±30%） */
  private readonly personalityAdjuster: PersonalityAdjuster;
  /** MemoryCortex 引用，用于人格内核读写（registerMemoryCortex 注入） */
  private memoryCortex: MemoryCortexLike | null = null;

  constructor(
    private readonly memory: AgentMemorySyncService | null,
    private readonly externalChat: ExternalChatProvider | null = null,
  ) {
    this.emotionRecognition = new EmotionRecognitionService(this.externalChat);
    this.personalityAdjuster = new PersonalityAdjuster();
  }

  /** 注入 MemoryCortex 引用，激活人格自适应微调闭环 */
  registerMemoryCortex(mc: MemoryCortexLike): void {
    this.memoryCortex = mc;
  }

  async getPromptSlice(actorId: string, userText?: string): Promise<PersonalizationPromptSlice> {
    if (!isUserPersonalizationEnabled()) return {};
    let state = this.loadEmotionState(actorId);
    let behavior = this.loadBehaviorSignals(actorId);
    let relationship = this.loadRelationshipState(actorId);
    let rhythm = this.loadTimeRhythmState(actorId);
    let style = this.loadStyleProfileState(actorId);
    let replyLength = this.loadReplyLengthProfileState(actorId);
    const facts = this.loadFactStore(actorId);
    const decayedFacts = decayFactStore(facts);
    if (userText?.trim()) {
      state = this.applyUserSignals(actorId, userText, state);
      behavior = this.applyBehaviorSignals(actorId, userText, behavior);
      relationship = this.applyRelationshipSignals(actorId, userText, relationship, state, behavior);
      rhythm = this.applyTimeRhythmSignals(actorId, rhythm);
      style = this.applyStyleProfile(actorId, userText, relationship, behavior, style);
      replyLength = this.applyReplyLengthProfile(actorId, userText, replyLength);
    }
    const profile = await this.store.read(actorId);
    const maxChars = Number.parseInt(process.env.AGENT_USER_PROFILE_PROMPT_MAX_CHARS ?? "3500", 10);
    const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 3500;
    const userProfile = profile.length > cap ? `…（较早内容已截断）\n${profile.slice(-cap)}` : profile;
    return {
      userProfile,
      toneGuidance: [
        "基础回复纪律：默认用口语化短句，先说重点；除非用户明确要求展开，否则不要长篇铺垫、套话、总结腔。",
        userText?.trim() ? buildReplyLengthGuidance(userText, replyLength) : undefined,
        buildToneGuidance(state),
        behaviorSummaryLine(behavior),
        timeRhythmSummaryLine(rhythm),
        contactPreferenceSummaryLine(this.loadContactPreferenceState(actorId), rhythm),
        buildFactPromptSummary(decayedFacts, 8),
      ].filter(Boolean).join("\n"),
      relationshipGuidance: relationshipSummaryLine(relationship, style, userText),
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

  getBehaviorBaseline(actorId: string): BehaviorBaseline {
    return this.loadBehaviorBaseline(actorId);
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
    const replyLengthProfile = this.loadReplyLengthProfileState(actorId);
    return {
      relationship,
      behavior,
      timeRhythm,
      styleProfile,
      contactPreference,
      replyLengthProfile,
      contactSummary: contactPreferenceSummaryLine(contactPreference, timeRhythm),
    };
  }

  observeTurn(actorId: string, userText: string, assistantText: string): void {
    if (!isUserPersonalizationEnabled()) return;
    void this.observeTurnAsync(actorId, userText, assistantText).catch(() => {});
  }

  private async observeTurnAsync(actorId: string, userText: string, assistantText: string): Promise<void> {
    const patches = extractProfilePatches(userText);
    let md = await this.store.read(actorId);
    if (patches.length > 0) md = applyProfilePatches(md, patches);
    let state = this.loadEmotionState(actorId);
    md = syncPreferredToneInProfile(md, TONE_ZH[state.preferredTone]);
    await this.store.write(actorId, md);
    this.syncProfileKv(actorId, md);
    this.updateFactStore(actorId, userText);
    this.learnFromAssistantStyle(actorId, assistantText);

    // ---- 情绪识别簇集成 ----
    // 用 EmotionRecognitionService（L1 规则 + L2 LLM mini）做更精细的情绪识别，
    // 高置信度时回写粗粒度 EmotionLabel 并推断 preferredTone。
    if (userText.trim()) {
      try {
        const result = await this.emotionRecognition.recognize(actorId, userText, {
          recentEmotions: state.recent,
        });
        if ((result.emotion.confidence ?? 0) >= 0.6) {
          const coarseLabel = fineEmotionToCoarse(result.emotion.label);
          // 替换最近一条情绪（不额外 increment turnCount，因 applyUserSignals 已 +1）
          if (state.recent.length > 0 && state.recent[state.recent.length - 1] !== coarseLabel) {
            state = {
              ...state,
              recent: [...state.recent.slice(0, -1), coarseLabel],
              lastUpdatedAt: new Date().toISOString(),
            };
            this.saveEmotionState(actorId, state);
          }
          // 高置信度情绪推断 preferredTone
          const inferredTone = inferPreferredToneFromFineEmotion(result.emotion.label);
          if (inferredTone && inferredTone !== state.preferredTone) {
            state = { ...state, preferredTone: inferredTone };
            this.saveEmotionState(actorId, state);
          }
        }
      } catch {
        // 情绪识别失败不阻塞主流程
      }
    }

    // ---- 人格簇集成 ----
    // 每 N turn 触发 PersonalityAdjuster 微调 MemoryCortex.personalityCache
    if (this.memoryCortex && state.turnCount > 0) {
      const relationship = this.loadRelationshipState(actorId);
      const style = this.loadStyleProfileState(actorId);
      const input: PersonalityAdjustmentInput = {
        relationship,
        style,
        preferredTone: state.preferredTone,
        turnCount: state.turnCount,
      };
      const adjusted = this.personalityAdjuster.tryAdjust(
        actorId,
        input,
        () => this.memoryCortex!.getPersonalityCore(actorId),
        (core) => this.memoryCortex!.setPersonalityCore(actorId, core),
      );
      if (adjusted) {
        console.log(`[UserPersonalization] 人格微调已应用: actor=${actorId}, turn=${state.turnCount}`);
      }
    }

    const everyN = profileLlmEveryNTurns();
    if (everyN > 0 && state.turnCount > 0 && state.turnCount % everyN === 0) {
      await this.refineProfileWithLlm(actorId, userText, md);
    }
  }

  private learnFromAssistantStyle(actorId: string, assistantText: string): void {
    const text = assistantText.trim();
    if (!text) return;
    const current = this.loadStyleProfileState(actorId);
    const next: StyleProfileState = {
      ...current,
      followUpTolerance: Math.min(
        1,
        Math.max(0, current.followUpTolerance * 0.98 + (/[?？]$/u.test(text) ? 0.02 : 0)),
      ),
      expressiveTolerance: Math.min(
        1,
        Math.max(0, current.expressiveTolerance * 0.98 + (/[!！~～]|😂|😅|🥹|🤔|😎|🥲/u.test(text) ? 0.02 : 0)),
      ),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_STYLE_PROFILE_KEY, next);
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
    return toEmotionState(this.readState(actorId, EMOTION_STATE_KEY));
  }

  private loadFactStore(actorId: string) {
    return toFactStore(this.readState(actorId, USER_PROFILE_FACTS_KEY));
  }

  private loadRelationshipState(actorId: string): RelationshipState {
    return toRelationshipState(this.readState(actorId, USER_RELATIONSHIP_KEY));
  }

  private loadTimeRhythmState(actorId: string): TimeRhythmState {
    return toTimeRhythmState(this.readState(actorId, USER_TIME_RHYTHM_KEY));
  }

  private loadStyleProfileState(actorId: string): StyleProfileState {
    return toStyleProfileState(this.readState(actorId, USER_STYLE_PROFILE_KEY));
  }

  private loadContactPreferenceState(actorId: string): ProactiveContactPreferenceState {
    return toContactPreferenceState(this.readState(actorId, USER_CONTACT_PREFERENCE_KEY));
  }

  private loadReplyLengthProfileState(actorId: string): ReplyLengthProfileState {
    return toReplyLengthProfileState(this.readState(actorId, USER_REPLY_LENGTH_PROFILE_KEY));
  }

  private applyRelationshipSignals(
    actorId: string,
    userText: string,
    current: RelationshipState,
    emotion: EmotionState,
    behavior: BehaviorSignals,
  ): RelationshipState {
    const text = userText.toLowerCase();
    const dynamic = detectDynamicStyleSignals(userText);
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
    this.maybeRefreshBehaviorBaseline(actorId, next);
    return next;
  }

  private loadBehaviorBaseline(actorId: string): BehaviorBaseline {
    return toBehaviorBaseline(this.readState(actorId, USER_BEHAVIOR_BASELINE_KEY));
  }

  private saveBehaviorBaseline(actorId: string, baseline: BehaviorBaseline): void {
    this.saveJsonState(actorId, USER_BEHAVIOR_BASELINE_KEY, baseline);
  }

  private maybeRefreshBehaviorBaseline(actorId: string, rhythm: TimeRhythmState): void {
    const baseline = this.loadBehaviorBaseline(actorId);
    if (Date.now() - baseline.lastUpdated <= BASELINE_REFRESH_INTERVAL_MS) return;
    const refreshed = buildBaselineFromRhythm(rhythm);
    this.saveBehaviorBaseline(actorId, refreshed);
  }

  private applyStyleProfile(
    actorId: string,
    userText: string,
    relationship: RelationshipState,
    behavior: BehaviorSignals,
    current: StyleProfileState,
  ): StyleProfileState {
    const text = userText.toLowerCase();
    const dynamic = detectDynamicStyleSignals(userText);
    const humorLift = Math.max(0, relationship.humorTolerance - 0.5);
    const warmthLift = Math.max(0, relationship.warmth - 0.5);
    const rapportLift = Math.max(0, relationship.rapport - 0.5);
    const directLift = Math.max(0, relationship.directnessPreference - 0.5);
    const next: StyleProfileState = {
      banterLevel: Math.min(
        1,
        Math.max(
          0,
          current.banterLevel * 0.92 +
            humorLift * 0.08 +
            rapportLift * 0.05 +
            dynamic.playful * 0.5 -
            directLift * 0.03,
        ),
      ),
      playfulTolerance: Math.min(
        1,
        Math.max(
          0,
          current.playfulTolerance * 0.94 + dynamic.playful + humorLift * 0.05 + rapportLift * 0.03,
        ),
      ),
      cuteTolerance: Math.min(
        1,
        Math.max(
          0,
          current.cuteTolerance * 0.94 +
            dynamic.cute +
            (/(?:\u53ef\u7231|\u5356\u840c|\u840c)/i.test(userText) ? 0.04 : 0) +
            warmthLift * 0.03,
        ),
      ),
      teasingTolerance: Math.min(
        1,
        Math.max(
          0,
          current.teasingTolerance * 0.95 +
            dynamic.teasing +
            (relationship.rapport > 0.55 ? 0.03 : 0) +
            humorLift * 0.03 -
            Math.max(0, relationship.encouragementNeed - 0.55) * 0.04,
        ),
      ),
      followUpTolerance: Math.min(
        1,
        Math.max(
          0,
          current.followUpTolerance * 0.95 +
            dynamic.followUp +
            (behavior.companionNeed > 0 ? 0.04 : 0) +
            (behavior.planningInterest > 0 ? 0.02 : 0),
        ),
      ),
      expressiveTolerance: Math.min(
        1,
        Math.max(
          0,
          current.expressiveTolerance * 0.94 + dynamic.expressive + warmthLift * 0.05 + rapportLift * 0.02,
        ),
      ),
      careStyle:
        /(?:\u5b89\u6170|\u6e29\u67d4|\u966a\u6211|\u6162\u4e00\u70b9)/i.test(userText)
          ? 'gentle'
          : ((relationship.humorTolerance > 0.7 && relationship.rapport > 0.6) ||
                current.playfulTolerance > 0.6 ||
                dynamic.playful > 0.1) &&
              relationship.encouragementNeed < 0.78
            ? 'playful'
            : relationship.directnessPreference > 0.7
              ? 'direct'
              : current.careStyle,
      motivationStyle:
        /(?:\u9f13\u52b1|\u6253\u6c14|\u5938\u6211)/i.test(userText)
          ? 'encouraging'
          : /(?:\u50ac\u6211|\u63a8\u6211|\u76ef\u7740\u6211)/i.test(userText)
            ? 'push'
            : current.motivationStyle,
      initiativeStyle:
        relationship.proactiveTolerance > 0.7 || behavior.planningInterest > 4
          ? 'proactive'
          : relationship.proactiveTolerance < 0.4
            ? 'reserved'
            : 'balanced',
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_STYLE_PROFILE_KEY, next);
    return next;
  }

  private applyReplyLengthProfile(
    actorId: string,
    userText: string,
    current: ReplyLengthProfileState,
  ): ReplyLengthProfileState {
    const text = userText.trim();
    const chars = text.replace(/\s+/g, "").length;
    const shortExplicit =
      /(简单说|简短点|短一点|一句话|一两句|别展开|直接说结论|长话短说|太长不看|简洁点)/i.test(text);
    const longExplicit =
      /(详细说|展开说|具体一点|多说点|讲清楚|完整方案|详细分析|一步一步|越详细越好)/i.test(text);
    const recentUserChars = [...current.recentUserChars, chars].slice(-8);
    const sampleCount = current.sampleCount + 1;
    const avgUserChars =
      current.sampleCount <= 0
        ? chars
        : Number(((current.avgUserChars * current.sampleCount + chars) / sampleCount).toFixed(2));
    const next: ReplyLengthProfileState = {
      avgUserChars,
      shortPreferenceScore: Math.max(0, current.shortPreferenceScore * 0.92 + (shortExplicit ? 1.2 : chars <= 20 ? 0.45 : 0)),
      longPreferenceScore: Math.max(0, current.longPreferenceScore * 0.92 + (longExplicit ? 1.2 : chars >= 90 ? 0.35 : 0)),
      recentUserChars,
      sampleCount,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.saveJsonState(actorId, USER_REPLY_LENGTH_PROFILE_KEY, next);
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
    return toBehaviorSignals(this.readState(actorId, USER_BEHAVIOR_SIGNAL_KEY));
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
    if (!this.memory) {
      this.fallbackState.set(`${actorId}:${key}`, value);
      return;
    }
    void this.saveJsonStateAsync(actorId, key, value);
  }

  private readState(actorId: string, key: string): unknown {
    if (!this.memory) return this.fallbackState.get(`${actorId}:${key}`);
    return this.memory.getSnapshot(actorId, [key]).entries[key];
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
