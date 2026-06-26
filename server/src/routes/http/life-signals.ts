import type { FastifyInstance } from "fastify";
import type { HttpRouteDeps } from "./types.js";
import type { LifeSignal } from "../../services/life-signal-types.js";

/** 心情打卡条目（内存存储，按 sessionId 分组）。 */
type MoodEntry = {
  sessionId: string;
  moodLevel: number;
  note?: string;
  createdAt: string;
};

/** 模块级内存存储：sessionId -> 该会话的心情打卡列表（按时间正序）。 */
const moodStore = new Map<string, MoodEntry[]>();

function normalizeSignal(body: Record<string, unknown>): LifeSignal {
  const actorId = String(body.actorId ?? body.sessionId ?? "").trim();
  if (!actorId) throw new Error("actorId is required");

  const source = String(body.source ?? "manual") as LifeSignal["source"];
  const kind = String(body.kind ?? "generic").trim() || "generic";
  const title = String(body.title ?? kind).trim() || kind;
  const summary = String(body.summary ?? body.description ?? title).trim() || title;
  const tags = Array.isArray(body.tags) ? body.tags.map((v) => String(v)).filter(Boolean) : [];
  const evidence = Array.isArray(body.evidence)
    ? body.evidence.map((v) => String(v)).filter(Boolean)
    : [];
  const metrics =
    body.metrics && typeof body.metrics === "object"
      ? Object.fromEntries(
          Object.entries(body.metrics as Record<string, unknown>)
            .filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        )
      : undefined;

  return {
    id: String(body.id ?? `${actorId}:${kind}:${Date.now()}`),
    actorId,
    source,
    kind,
    title,
    summary,
    description: body.description ? String(body.description) : undefined,
    tags,
    importance: String(body.importance ?? "medium") as LifeSignal["importance"],
    evidence,
    metrics,
    occurredAt: String(body.occurredAt ?? new Date().toISOString()),
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
    metadata:
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : undefined,
  };
}

export function registerLifeSignalRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.post("/life/signals", async (request, reply) => {
    try {
      const signal = normalizeSignal((request.body ?? {}) as Record<string, unknown>);
      deps.lifeSignalHubService?.publish(signal);
      return reply.send({ ok: true, signalId: signal.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.get("/life/signals/:actorId", async (request, reply) => {
    const actorId = String((request.params as { actorId?: string }).actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId is required" });
    const limit = Number((request.query as { limit?: string }).limit ?? "20");
    return reply.send({
      ok: true,
      signals: deps.proactiveLifeRuntimeService?.recentSignals(actorId, limit) ?? [],
      candidates: deps.proactiveLifeRuntimeService?.recentCandidates(actorId, limit) ?? [],
    });
  });

  app.post("/api/life-signals/mood-checkin", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sessionId?: unknown;
      moodLevel?: unknown;
      note?: unknown;
    };
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const moodLevel = Number(body.moodLevel);
    if (!Number.isInteger(moodLevel) || moodLevel < 1 || moodLevel > 5) {
      return reply.code(400).send({ ok: false, error: "moodLevel must be an integer between 1 and 5" });
    }
    const noteRaw = body.note;
    const note =
      typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : undefined;
    const entry: MoodEntry = {
      sessionId,
      moodLevel,
      note,
      createdAt: new Date().toISOString(),
    };
    const list = moodStore.get(sessionId);
    if (list) list.push(entry);
    else moodStore.set(sessionId, [entry]);
    return reply.code(201).send({ ok: true, entry });
  });

  app.get("/api/life-signals/mood-history", async (request, reply) => {
    const query = request.query as { sessionId?: string; limit?: string };
    const sessionId = String(query.sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const limit = Math.max(1, Math.min(200, Number(query.limit ?? "30") || 30));
    const list = moodStore.get(sessionId) ?? [];
    const entries = [...list]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return reply.send({ ok: true, entries, count: entries.length });
  });
}
