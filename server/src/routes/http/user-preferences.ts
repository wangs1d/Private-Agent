import type { FastifyInstance } from "fastify";

type BriefingMode = "voice" | "window" | "card";
type UserPreferences = {
  morningBriefing: {
    enabled: boolean;
    time: string; // HH:MM
    mode: BriefingMode;
    lastSentAt: string | null;
  };
};

const prefsStore = new Map<string, UserPreferences>();

const DEFAULT_PREFS: UserPreferences = {
  morningBriefing: {
    enabled: true,
    time: "08:00",
    mode: "voice",
    lastSentAt: null,
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

export function getUserPreferences(sessionId: string): UserPreferences {
  return getOrCreatePrefs(sessionId);
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
    }
    return { ok: true, preferences: prefs };
  });
}

export type { BriefingMode, UserPreferences };
