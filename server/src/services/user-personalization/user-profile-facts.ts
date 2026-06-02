export type UserFactCategory =
  | "habit"
  | "interest"
  | "personality"
  | "communication_style"
  | "decision_style"
  | "privacy_preference";

export type UserFact = {
  id: string;
  category: UserFactCategory;
  key: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  lastSeenAt: string;
  createdAt: string;
};

export type UserFactStore = {
  facts: UserFact[];
  updatedAt: string;
};

export type FactCandidate = {
  category: UserFactCategory;
  key: string;
  value: string;
};

const MAX_FACTS = 80;
const DECAY_DAYS = 90;
const MIN_CONFIDENCE = 0.15;

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultFactStore(): UserFactStore {
  return { facts: [], updatedAt: nowIso() };
}

export function toFactStore(v: unknown): UserFactStore {
  if (!v || typeof v !== "object") return defaultFactStore();
  const o = v as Record<string, unknown>;
  const facts = Array.isArray(o.facts) ? (o.facts as UserFact[]) : [];
  return {
    facts: facts
      .filter((f) => f && typeof f.key === "string" && typeof f.value === "string")
      .slice(0, MAX_FACTS),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
  };
}

export function extractFactCandidates(userText: string): FactCandidate[] {
  const t = userText.trim();
  if (!t) return [];
  const out: FactCandidate[] = [];
  const push = (c: FactCandidate) => {
    if (c.value.length > 1) out.push(c);
  };

  const sleep = /(?:usually sleep at|sleep at|go to bed at)\s*([0-2]?\d:[0-5]\d|\d{1,2}\s*(?:am|pm))/i.exec(t);
  if (sleep?.[1]) push({ category: "habit", key: "sleep_time", value: sleep[1].trim() });

  const work = /(?:work schedule|working hours)\s*:?\s*([^\n,.!?]{2,24})/i.exec(t);
  if (work?.[1]) push({ category: "habit", key: "work_schedule", value: work[1].trim() });

  const like = /(?:i like|i love|i enjoy)\s*([^\n,.!?]{2,40})/i.exec(t);
  if (like?.[1]) push({ category: "interest", key: "likes", value: like[1].trim() });

  const dislike = /(?:i dislike|i hate)\s*([^\n,.!?]{2,40})/i.exec(t);
  if (dislike?.[1]) push({ category: "interest", key: "dislikes", value: dislike[1].trim() });

  if (/(introvert|extrovert)/i.test(t)) {
    push({ category: "personality", key: "social_style", value: t.slice(0, 40) });
  }
  if (/(anxious|calm|sensitive)/i.test(t)) {
    push({ category: "personality", key: "emotional_trait", value: t.slice(0, 40) });
  }

  if (/(be brief|short answer|concise|direct)/i.test(t)) {
    push({ category: "communication_style", key: "response_length", value: "brief" });
  }
  if (/(detailed|explain more|more detail)/i.test(t)) {
    push({ category: "communication_style", key: "response_length", value: "detailed" });
  }
  if (/(formal|professional)/i.test(t)) {
    push({ category: "communication_style", key: "tone", value: "formal" });
  }
  if (/(friendly|casual)/i.test(t)) {
    push({ category: "communication_style", key: "tone", value: "friendly" });
  }

  if (/(risk averse|conservative|low risk)/i.test(t)) {
    push({ category: "decision_style", key: "risk_preference", value: "conservative" });
  }
  if (/(aggressive|high risk)/i.test(t)) {
    push({ category: "decision_style", key: "risk_preference", value: "aggressive" });
  }

  if (/(privacy first|do not store|minimize data|private mode)/i.test(t)) {
    push({ category: "privacy_preference", key: "storage", value: "minimize_storage" });
  }

  return out.slice(0, 8);
}

export function mergeFactCandidates(store: UserFactStore, candidates: FactCandidate[]): UserFactStore {
  if (candidates.length === 0) return store;
  const facts = [...store.facts];
  const now = nowIso();

  for (const c of candidates) {
    const idx = facts.findIndex((f) => f.category === c.category && f.key === c.key && f.value === c.value);
    if (idx >= 0) {
      const f = facts[idx];
      facts[idx] = {
        ...f,
        confidence: Math.min(0.99, f.confidence + 0.08),
        evidenceCount: f.evidenceCount + 1,
        lastSeenAt: now,
      };
      continue;
    }
    const conflictIdx = facts.findIndex((f) => f.category === c.category && f.key === c.key && f.value !== c.value);
    if (conflictIdx >= 0) {
      const old = facts[conflictIdx];
      facts[conflictIdx] = { ...old, confidence: Math.max(0.2, old.confidence - 0.12) };
      facts.push({
        id: `${c.category}:${c.key}:${Date.now()}`,
        category: c.category,
        key: c.key,
        value: c.value,
        confidence: 0.55,
        evidenceCount: 1,
        lastSeenAt: now,
        createdAt: now,
      });
      continue;
    }
    facts.push({
      id: `${c.category}:${c.key}:${Date.now()}`,
      category: c.category,
      key: c.key,
      value: c.value,
      confidence: 0.62,
      evidenceCount: 1,
      lastSeenAt: now,
      createdAt: now,
    });
  }

  const sorted = facts.sort((a, b) => b.confidence - a.confidence || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { facts: sorted.slice(0, MAX_FACTS), updatedAt: now };
}

export function decayFactStore(store: UserFactStore, now = new Date()): UserFactStore {
  const next = store.facts
    .map((f) => {
      const days = (now.getTime() - new Date(f.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24);
      if (days <= DECAY_DAYS) return f;
      const extra = Math.floor((days - DECAY_DAYS) / 14) + 1;
      return { ...f, confidence: Math.max(0, f.confidence - extra * 0.05) };
    })
    .filter((f) => f.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);
  return { facts: next, updatedAt: nowIso() };
}

export function buildFactPromptSummary(store: UserFactStore, limit = 10): string | undefined {
  if (!store.facts.length) return undefined;
  const lines = store.facts.slice(0, limit).map(
    (f) => `- [${f.category}] ${f.key}=${f.value} (confidence=${f.confidence.toFixed(2)}, evidence=${f.evidenceCount})`,
  );
  return `User profile facts:\n${lines.join("\n")}`;
}

