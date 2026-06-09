export type ProactiveOutboundChannel = "websocket" | "voice" | "phone_call" | "console";

export type ProactiveOutboundMessage = {
  id: string;
  actorId: string;
  title: string;
  text: string;
  reason: string;
  channel: ProactiveOutboundChannel;
  createdAt: string;
  meta?: Record<string, unknown>;
};

export type ProactiveOutboundEligibility = {
  allowed: boolean;
  reason: string;
};

export type ProactiveOutboundMessageSender = (
  actorId: string,
  payload: Record<string, unknown>,
) => Promise<boolean> | boolean;

export type ProactiveOutboundMemoryWriter = (
  actorId: string,
  line: string,
  topicHint?: string,
) => Promise<void> | void;

type ThreadContextOptions = {
  category?: string;
  tags?: string[];
  lookbackMs?: number;
};

function formatRelativeTime(atIso: string, now = new Date()): string {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return atIso;

  const diffMs = now.getTime() - at.getTime();
  if (diffMs < 0) return "just ahead";

  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (minutes <= 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function compactText(text: string, maxLength = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeReasonCategory(reason: string): string | null {
  const match = reason.match(/^anticipation:(.+)$/);
  return match?.[1] ?? null;
}

function extractMetaStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function areRelatedCategories(current: string | undefined, previous: string | undefined): boolean {
  if (!current || !previous) return false;
  if (current === previous) return true;

  const relatedGroups = [
    new Set(["warning", "follow_up", "planning"]),
    new Set(["care", "follow_up"]),
    new Set(["planning", "opportunity", "follow_up"]),
  ];

  return relatedGroups.some((group) => group.has(current) && group.has(previous));
}

export class ProactiveOutboundMessageService {
  private readonly history = new Map<string, ProactiveOutboundMessage[]>();

  constructor(
    private readonly sendToClient: ProactiveOutboundMessageSender | null,
    private readonly memoryWriter: ProactiveOutboundMemoryWriter | null = null,
  ) {}

  async send(message: Omit<ProactiveOutboundMessage, "id" | "createdAt" | "channel"> & {
    channel?: ProactiveOutboundChannel;
  }): Promise<boolean> {
    const payload: ProactiveOutboundMessage = {
      ...message,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: new Date().toISOString(),
      channel: message.channel ?? "websocket",
    };

    const list = this.history.get(payload.actorId) ?? [];
    list.push(payload);
    if (list.length > 30) list.splice(0, list.length - 30);
    this.history.set(payload.actorId, list);

    const envelope = {
      type: "agent.proactive_message",
      payload,
    };

    const sent = await Promise.resolve(this.sendToClient?.(payload.actorId, envelope) ?? false);
    if (!sent) {
      console.log(`[ProactiveOutbound] ${payload.actorId}: ${payload.title} - ${payload.text}`);
    }
    await Promise.resolve(
      this.memoryWriter?.(
        payload.actorId,
        this.formatRelationshipHistoryLine(payload),
        this.resolveTopicHint(payload),
      ) ?? null,
    );
    return sent;
  }

  getRecent(actorId: string, limit = 5): ProactiveOutboundMessage[] {
    return [...(this.history.get(actorId) ?? [])].slice(-limit);
  }

  countSince(actorId: string, windowMs: number): number {
    const now = Date.now();
    return (this.history.get(actorId) ?? []).filter((item) => {
      const createdAt = Date.parse(item.createdAt);
      return Number.isFinite(createdAt) && now - createdAt <= windowMs;
    }).length;
  }

  assessFatigue(actorId: string, windowMs = 60 * 60_000): ProactiveOutboundEligibility {
    const now = Date.now();
    const recent = (this.history.get(actorId) ?? []).filter((item) => {
      return now - Date.parse(item.createdAt) <= windowMs;
    });
    if (recent.length >= 6) {
      return { allowed: false, reason: "too_many_recent_proactive_messages" };
    }
    return { allowed: true, reason: recent.length >= 3 ? "high_activity" : "clear" };
  }

  getThreadContext(actorId: string, reason: string, options?: ThreadContextOptions): string | null {
    const now = Date.now();
    const lookbackMs = options?.lookbackMs ?? 36 * 60 * 60_000;
    const targetCategory = options?.category ?? normalizeReasonCategory(reason);
    const targetTags = new Set(options?.tags ?? []);
    const history = [...(this.history.get(actorId) ?? [])].reverse();

    const exact = history.find((item) => item.reason === reason);
    if (exact) {
      return `Previous proactive note (${formatRelativeTime(exact.createdAt)} at ${exact.createdAt}): ${compactText(exact.text)}`;
    }

    const related = history.find((item) => {
      const createdAtMs = Date.parse(item.createdAt);
      if (!Number.isFinite(createdAtMs) || now - createdAtMs > lookbackMs) return false;
      if (!item.reason.startsWith("anticipation:")) return false;

      const previousCategory =
        typeof item.meta?.category === "string"
          ? item.meta.category
          : normalizeReasonCategory(item.reason);
      const previousTags = extractMetaStringArray(item.meta, "tags");
      const sharedTag = previousTags.some((tag) => targetTags.has(tag));

      return areRelatedCategories(targetCategory ?? undefined, previousCategory ?? undefined) || sharedTag;
    });

    if (!related) return null;
    const previousCategory =
      typeof related.meta?.category === "string"
        ? related.meta.category
        : normalizeReasonCategory(related.reason);
    return `Related proactive thread from ${previousCategory ?? "recent context"} (${formatRelativeTime(related.createdAt)} at ${related.createdAt}): ${compactText(related.text)}`;
  }

  private formatRelationshipHistoryLine(message: ProactiveOutboundMessage): string {
    const threadLabel = message.reason.startsWith("anticipation:")
      ? message.reason.slice("anticipation:".length)
      : message.reason;
    const text = compactText(message.text, 180);
    const title = compactText(message.title, 72);
    return `主动消息线程 ${threadLabel} | ${title}: ${text}`;
  }

  private resolveTopicHint(message: ProactiveOutboundMessage): string {
    if (message.reason.startsWith("anticipation:")) {
      const category = message.reason.slice("anticipation:".length);
      if (category === "care") return "relationship";
      if (category === "follow_up" || category === "planning") return "social";
      if (category === "warning") return "security";
      if (category === "opportunity") return "info";
    }
    return "social";
  }
}
