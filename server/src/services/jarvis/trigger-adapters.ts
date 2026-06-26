/**
 * Jarvis Trigger Adapters — 把 5 类触发源归一为 JarvisTrigger
 *
 *  - eventTriggerAdapter        : StateChangeEvent → JarvisTrigger
 *  - lifeSignalTriggerAdapter   : LifeSignal → JarvisTrigger
 *  - moodTriggerAdapter         : MoodInference → JarvisTrigger
 *  - cronTriggerAdapter         : 定时任务 → JarvisTrigger
 *  - selfScanTriggerAdapter     : 自发性扫描 → JarvisTrigger（见 self-scan-trigger.ts）
 */

import type { StateChangeEvent } from "@private-ai-agent/agent-world";
import type { LifeSignal } from "../life-signal-types.js";
import type { MoodInference } from "../mood-inference-service.js";
import {
  inferTriggerCategoryFromLifeSignal,
  toUrgencyBand,
  type JarvisTrigger,
  type JarvisTriggerSource,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toTitleCase(input: string): string {
  return input
    .split(/[._:\-/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferCategoryFromEvent(event: StateChangeEvent): JarvisTrigger["category"] {
  const text = `${event.module} ${event.type} ${event.currentState ?? ""} ${event.previousState ?? ""}`.toLowerCase();
  if (/(risk|warn|urgent|error|fail)/i.test(text)) return "warning";
  if (/(finish|done|complete|success|end)/i.test(text)) return "completion";
  if (/(start|create|new|receive)/i.test(text)) return "newness";
  if (/(schedule|remind|plan|task|deadline)/i.test(text)) return "planning";
  if (/(chat|social|friend|message|post|comment)/i.test(text)) return "social";
  if (/(money|wallet|trade|payment|stock|fund|price|market)/i.test(text)) return "finance";
  if (event.module === "gomoku") return "completion";
  if (event.module === "wallet") return "finance";
  if (event.module === "task") return "completion";
  if (event.module === "market") return "warning";
  if (event.module === "social") return "social";
  return "general";
}

function tagsFromEvent(event: StateChangeEvent): string[] {
  const tags: string[] = [];
  const text = `${event.module} ${event.type} ${event.currentState ?? ""}`.toLowerCase();
  if (/(done|finish|complete)/i.test(text)) tags.push("completion");
  if (/(start|new|create)/i.test(text)) tags.push("newness");
  if (/(risk|warn|urgent)/i.test(text)) tags.push("risk");
  if (/(planning|remind|schedule)/i.test(text)) tags.push("planning");
  if (/(social|friend)/i.test(text)) tags.push("social");
  if (/(money|wallet|trade|stock|fund)/i.test(text)) tags.push("finance");
  if (event.module) tags.push(`module:${event.module}`);
  if (event.type) tags.push(`event:${event.type}`);
  return tags;
}

function extractEventEvidence(event: StateChangeEvent): string[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return Object.entries(payload)
    .map(([k, v]) => {
      if (v == null) return null;
      if (typeof v === "string") {
        const t = v.trim();
        return t ? `${k}: ${t.slice(0, 100)}` : null;
      }
      if (typeof v === "number" || typeof v === "boolean") return `${k}: ${String(v)}`;
      return null;
    })
    .filter((x): x is string => Boolean(x))
    .slice(0, 5);
}

function eventUrgency(event: StateChangeEvent): number {
  const tags = tagsFromEvent(event);
  let u = 3;
  if (tags.includes("risk")) u += 2;
  if (tags.includes("completion")) u += 1;
  if (tags.includes("newness")) u += 0.5;
  return clamp(u, 0, 10);
}

export function eventTriggerAdapter(event: StateChangeEvent): JarvisTrigger {
  return {
    id: `event:${event.actorSessionId}:${event.module}:${event.type}:${Date.now()}`,
    source: "event" as JarvisTriggerSource,
    actorId: event.actorSessionId,
    category: inferCategoryFromEvent(event),
    title: `${toTitleCase(event.module)} ${toTitleCase(event.type)}`,
    summary: `${toTitleCase(event.type)}${event.currentState ? ` → ${event.currentState}` : ""}`,
    tags: tagsFromEvent(event),
    urgency: eventUrgency(event),
    confidence: 0.7,
    importance: toUrgencyBand(eventUrgency(event)),
    evidence: extractEventEvidence(event),
    occurredAt: nowIso(),
    rawEvent: event,
  };
}

function lifeSignalUrgency(signal: LifeSignal): number {
  const importanceMap: Record<LifeSignal["importance"], number> = {
    critical: 9,
    high: 7,
    medium: 5,
    low: 3,
  };
  return clamp(importanceMap[signal.importance] + (signal.tags.includes("risk") ? 1 : 0), 0, 10);
}

export function lifeSignalTriggerAdapter(signal: LifeSignal): JarvisTrigger {
  return {
    id: `life:${signal.id}`,
    source: "life_signal",
    actorId: signal.actorId,
    category: inferTriggerCategoryFromLifeSignal(signal),
    title: signal.title,
    summary: signal.summary,
    description: signal.description,
    tags: [...(signal.tags ?? []), `source:${signal.source}`, `kind:${signal.kind}`],
    urgency: lifeSignalUrgency(signal),
    confidence: clamp(signal.sourceReliability ?? 0.7, 0, 1),
    importance: signal.importance,
    evidence: (signal.evidence ?? []).slice(0, 6),
    occurredAt: signal.occurredAt,
    metadata: signal.metadata as Record<string, unknown> | undefined,
    rawSignal: signal,
  };
}

export function moodTriggerAdapter(inference: MoodInference): JarvisTrigger {
  const isNegative = inference.sentimentScore < -0.2;
  const isPositive = inference.sentimentScore > 0.3;
  return {
    id: `mood:${inference.sessionId}:${inference.timestamp}`,
    source: "mood",
    actorId: inference.sessionId,
    category: isNegative ? "care" : isPositive ? "presence" : "general",
    title: isNegative
      ? "察觉到情绪低落"
      : isPositive
        ? "察觉到情绪不错"
        : "情绪波动",
    summary: `${inference.emotionTags.join("、") || "情绪信号"} (${inference.sentimentScore.toFixed(2)})`,
    tags: [...inference.emotionTags, "mood", `source:${inference.source}`],
    urgency: isNegative ? Math.min(9, 5 + Math.abs(inference.sentimentScore) * 4) : 4,
    confidence: clamp(inference.confidence, 0, 1),
    importance: toUrgencyBand(isNegative ? 7 : 4),
    evidence: Object.entries(inference.rawSignals ?? {})
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${String(v)}`),
    occurredAt: inference.timestamp,
    metadata: { agentNote: inference.agentNote },
    rawMood: inference,
  };
}

export function cronTriggerAdapter(input: {
  actorId: string;
  triggerId: string;
  category: JarvisTrigger["category"];
  title: string;
  summary: string;
  tags?: string[];
  urgency?: number;
  confidence?: number;
  evidence?: string[];
}): JarvisTrigger {
  return {
    id: input.triggerId,
    source: "cron",
    actorId: input.actorId,
    category: input.category,
    title: input.title,
    summary: input.summary,
    tags: input.tags ?? ["cron"],
    urgency: input.urgency ?? 5,
    confidence: input.confidence ?? 0.9,
    importance: toUrgencyBand(input.urgency ?? 5),
    evidence: input.evidence ?? [],
    occurredAt: nowIso(),
  };
}
