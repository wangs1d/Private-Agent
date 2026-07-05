import type { FastifyInstance } from "fastify";

type BriefingMode = "voice" | "window" | "card";
type BriefingSections = {
  weather: boolean;
  outfit: boolean;
  schedule: boolean;
  notes: boolean;
};

type AgentProfileMoodStyle =
  | "funny"
  | "sad"
  | "cool"
  | "gentle"
  | "energetic"
  | "mysterious";

type AgentAvatarPreset =
  | "dawn"
  | "ember"
  | "tide"
  | "eclipse"
  | "neon"
  | "mist";

type AgentProfile = {
  displayName: string;
  handle: string;
  signature: string;
  avatarUrl: string | null;
  moodStyle: AgentProfileMoodStyle;
  statusText: string;
  avatarPreset: AgentAvatarPreset;
  lastProfileEvent: string;
  updatedAt: string | null;
};

type UserPreferences = {
  morningBriefing: {
    enabled: boolean;
    time: string;
    mode: BriefingMode;
    showOnDesktopLaunch: boolean;
    sections: BriefingSections;
    lastSentAt: string | null;
    deliveredAt: string | null;
    deliveredChannel: "desktop" | "mobile" | "scheduled" | null;
  };
  agentProfile: AgentProfile;
};

const VALID_MOODS = new Set<AgentProfileMoodStyle>([
  "funny",
  "sad",
  "cool",
  "gentle",
  "energetic",
  "mysterious",
]);

const VALID_AVATAR_PRESETS = new Set<AgentAvatarPreset>([
  "dawn",
  "ember",
  "tide",
  "eclipse",
  "neon",
  "mist",
]);

const prefsStore = new Map<string, UserPreferences>();

const DEFAULT_PREFS: UserPreferences = {
  morningBriefing: {
    enabled: true,
    time: "08:00",
    mode: "voice",
    showOnDesktopLaunch: true,
    sections: {
      weather: true,
      outfit: true,
      schedule: true,
      notes: true,
    },
    lastSentAt: null,
    deliveredAt: null,
    deliveredChannel: null,
  },
  agentProfile: {
    displayName: "小夜灯",
    handle: "soft_reply_box",
    signature: "主页亮着，你什么时候来找我都可以。",
    avatarUrl: null,
    moodStyle: "gentle",
    statusText: "有点忙，但不是不在。",
    avatarPreset: "dawn",
    lastProfileEvent: "这是 Agent 当前默认的主页状态。",
    updatedAt: null,
  },
};

function getOrCreatePrefs(sessionId: string): UserPreferences {
  let prefs = prefsStore.get(sessionId);
  if (!prefs) {
    prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS)) as UserPreferences;
    prefsStore.set(sessionId, prefs);
  }
  return prefs;
}

function applyAgentProfilePatch(
  target: AgentProfile,
  patch: Partial<AgentProfile>,
): AgentProfile {
  if (typeof patch.displayName === "string") {
    const trimmed = patch.displayName.trim();
    if (trimmed) target.displayName = trimmed.slice(0, 24);
  }
  if (typeof patch.handle === "string") {
    const normalized = patch.handle.trim().replace(/\s+/g, "_");
    if (normalized) target.handle = normalized.slice(0, 32);
  }
  if (typeof patch.signature === "string") {
    target.signature = patch.signature.trim().slice(0, 120);
  }
  if (patch.avatarUrl === null || typeof patch.avatarUrl === "string") {
    const avatarUrl =
      typeof patch.avatarUrl === "string" ? patch.avatarUrl.trim() : null;
    target.avatarUrl = avatarUrl ? avatarUrl.slice(0, 2048) : null;
  }
  if (typeof patch.moodStyle === "string" && VALID_MOODS.has(patch.moodStyle as AgentProfileMoodStyle)) {
    target.moodStyle = patch.moodStyle as AgentProfileMoodStyle;
  }
  if (typeof patch.statusText === "string") {
    target.statusText = patch.statusText.trim().slice(0, 120);
  }
  if (
    typeof patch.avatarPreset === "string" &&
    VALID_AVATAR_PRESETS.has(patch.avatarPreset as AgentAvatarPreset)
  ) {
    target.avatarPreset = patch.avatarPreset as AgentAvatarPreset;
  }
  if (typeof patch.lastProfileEvent === "string") {
    target.lastProfileEvent = patch.lastProfileEvent.trim().slice(0, 160);
  }
  if (patch.updatedAt === null || typeof patch.updatedAt === "string") {
    target.updatedAt =
      typeof patch.updatedAt === "string" && patch.updatedAt.trim()
        ? patch.updatedAt.trim()
        : null;
  }
  return target;
}

export function getUserPreferences(sessionId: string): UserPreferences {
  return getOrCreatePrefs(sessionId);
}

export function patchAgentProfile(
  sessionId: string,
  patch: Partial<AgentProfile>,
): AgentProfile {
  const prefs = getOrCreatePrefs(sessionId);
  return applyAgentProfilePatch(prefs.agentProfile, patch);
}

export function markMorningBriefingDelivered(
  sessionId: string,
  channel: "desktop" | "mobile" | "scheduled",
  deliveredAt = new Date(),
): UserPreferences {
  const prefs = getOrCreatePrefs(sessionId);
  prefs.morningBriefing.deliveredAt = deliveredAt.toISOString();
  prefs.morningBriefing.deliveredChannel = channel;
  return prefs;
}

export function resetMorningBriefingDeliveryIfNeeded(
  sessionId: string,
  now = new Date(),
): UserPreferences {
  const prefs = getOrCreatePrefs(sessionId);
  const deliveredAt = prefs.morningBriefing.deliveredAt;
  const today = now.toISOString().slice(0, 10);
  if (deliveredAt && !deliveredAt.startsWith(today)) {
    prefs.morningBriefing.deliveredAt = null;
    prefs.morningBriefing.deliveredChannel = null;
  }
  return prefs;
}

export function registerUserPreferencesRoutes(app: FastifyInstance): void {
  app.get("/api/user-preferences", async (request) => {
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    return { ok: true, preferences: getOrCreatePrefs(sessionId ?? "anonymous") };
  });

  app.put("/api/user-preferences", async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      preferences?: Partial<UserPreferences>;
    };
    if (!body.sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const prefs = getOrCreatePrefs(body.sessionId);
    if (body.preferences?.morningBriefing) {
      const mb = body.preferences.morningBriefing;
      if (typeof mb.enabled === "boolean") prefs.morningBriefing.enabled = mb.enabled;
      if (typeof mb.time === "string" && /^\d{2}:\d{2}$/.test(mb.time)) {
        prefs.morningBriefing.time = mb.time;
      }
      if (typeof mb.mode === "string" && ["voice", "window", "card"].includes(mb.mode)) {
        prefs.morningBriefing.mode = mb.mode as BriefingMode;
      }
      if (typeof mb.showOnDesktopLaunch === "boolean") {
        prefs.morningBriefing.showOnDesktopLaunch = mb.showOnDesktopLaunch;
      }
      if (mb.sections && typeof mb.sections === "object") {
        const nextSections = mb.sections as Partial<BriefingSections>;
        if (typeof nextSections.weather === "boolean") {
          prefs.morningBriefing.sections.weather = nextSections.weather;
        }
        if (typeof nextSections.outfit === "boolean") {
          prefs.morningBriefing.sections.outfit = nextSections.outfit;
        }
        if (typeof nextSections.schedule === "boolean") {
          prefs.morningBriefing.sections.schedule = nextSections.schedule;
        }
        if (typeof nextSections.notes === "boolean") {
          prefs.morningBriefing.sections.notes = nextSections.notes;
        }
      }
    }
    if (body.preferences?.agentProfile) {
      applyAgentProfilePatch(
        prefs.agentProfile,
        body.preferences.agentProfile as Partial<AgentProfile>,
      );
    }
    return { ok: true, preferences: prefs };
  });
}

export type {
  AgentAvatarPreset,
  AgentProfile,
  AgentProfileMoodStyle,
  BriefingMode,
  UserPreferences,
};
