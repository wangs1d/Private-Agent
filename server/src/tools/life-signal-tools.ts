import { randomUUID } from "node:crypto";
import type { LifeSignalHubService } from "../services/life-signal-hub-service.js";
import type { LifeSignal } from "../services/life-signal-types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ToolContext } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";

function normalizeSignal(input: Record<string, unknown>, context: ToolContext): LifeSignal {
  const actorId = String(input.actorId ?? resolveActorId(context)).trim();
  const kind = String(input.kind ?? "generic").trim() || "generic";
  const title = String(input.title ?? kind).trim() || kind;
  const summary = String(input.summary ?? title).trim() || title;
  const tags = Array.isArray(input.tags) ? input.tags.map((v) => String(v)).filter(Boolean) : [];
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map((v) => String(v)).filter(Boolean)
    : [];

  return {
    id: String(input.id ?? randomUUID()),
    actorId,
    source: String(input.source ?? "manual") as LifeSignal["source"],
    kind,
    title,
    summary,
    description: input.description ? String(input.description) : undefined,
    tags,
    importance: String(input.importance ?? "medium") as LifeSignal["importance"],
    evidence,
    metrics:
      input.metrics && typeof input.metrics === "object"
        ? Object.fromEntries(
            Object.entries(input.metrics as Record<string, unknown>)
              .filter((entry): entry is [string, number] => typeof entry[1] === "number"),
          )
        : undefined,
    occurredAt: String(input.occurredAt ?? new Date().toISOString()),
    expiresAt: input.expiresAt ? String(input.expiresAt) : undefined,
    metadata:
      input.metadata && typeof input.metadata === "object"
        ? (input.metadata as Record<string, unknown>)
        : undefined,
  };
}

export function registerLifeSignalTools(
  registry: ToolRegistry,
  signalHub: LifeSignalHubService,
): void {
  registry.register("life.signal.publish", async (input, context) => {
    const signal = normalizeSignal(input, context);
    signalHub.publish(signal);
    return {
      ok: true,
      signalId: signal.id,
      actorId: signal.actorId,
      kind: signal.kind,
    };
  });
}
