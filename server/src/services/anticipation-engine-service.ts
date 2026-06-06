import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AnticipationCandidate,
  AnticipationEvaluationContext,
  LifeSignal,
  LifeSignalEvidenceWindow,
} from "./life-signal-types.js";

function normalizeImportance(value: LifeSignal["importance"]): number {
  switch (value) {
    case "critical":
      return 9;
    case "high":
      return 7;
    case "medium":
      return 5;
    default:
      return 3;
  }
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type CandidateDraft = Omit<AnticipationCandidate, "id" | "actorId" | "signalId" | "createdAt">;

export class AnticipationEngineService {
  private readonly candidates = new Map<string, AnticipationCandidate[]>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath?: string) {}

  evaluate(
    signal: LifeSignal,
    context?: AnticipationEvaluationContext,
  ): AnticipationCandidate[] {
    const text =
      `${signal.title} ${signal.summary} ${signal.description ?? ""} ${signal.tags.join(" ")}`.toLowerCase();
    const baseUrgency = normalizeImportance(signal.importance);
    const behavior = context?.behavior ?? null;
    const relationship = context?.relationship ?? null;
    const recentSignals = context?.recentSignals ?? [];
    const repeatedPatternCount = context?.repeatedPatternCount ?? 0;
    const evidenceWindow = context?.evidenceWindow ?? null;
    const evidenceScore = this.computeEvidenceScore(signal, recentSignals, repeatedPatternCount, evidenceWindow);
    const trendBoost = this.computeTrendBoost(evidenceWindow, signal);
    const turningBoost = this.computeTurningBoost(evidenceWindow);
    const hasReversal = (evidenceWindow?.turningPoints ?? 0) >= 1;
    const reversalDirection = evidenceWindow?.reversalDirection ?? null;
    const reliability = clamp(signal.sourceReliability ?? 0.7, 0.2, 1);
    const results: AnticipationCandidate[] = [];

    if (containsAny(text, [/(stock|position|stop-loss|take-profit|price|trade|market)/i])) {
      const confidence =
        0.58 +
        evidenceScore * 0.2 +
        trendBoost * 0.18 +
        turningBoost * 0.08 +
        reliability * 0.12 +
        (typeof signal.metrics?.priceChangePct === "number"
          ? Math.min(0.14, Math.abs(signal.metrics.priceChangePct) / 100)
          : 0) +
        ((behavior?.shoppingInterest ?? 0) > 0 ? 0.04 : 0);
      results.push(
        this.createCandidate(signal, {
          category: "warning",
          title: "Market Move Detected",
          rationale:
            "Signal is tied to holdings or market movement, so the user may want a timely decision prompt.",
          suggestedAction: "Ask whether to review the position, update stop-loss, or take profit.",
          confidence: clamp(confidence, 0.45, 0.96),
          urgency: Math.min(10, baseUrgency + 2 + evidenceScore * 1.2 + trendBoost * 0.8 + turningBoost * 0.4),
          shouldNotify: true,
          tags: ["finance", "market", "decision"],
          metadata: {
            evidenceScore,
            trendBoost,
            turningBoost,
            reversalDirection,
            sourceReliability: reliability,
            repeatedPatternCount,
            evidenceWindow: this.summarizeEvidenceWindow(evidenceWindow),
            relationshipRapport: relationship?.rapport ?? null,
          },
        }),
      );
    }

    if (containsAny(text, [/(night|late|sleep|overtime|fatigue|midnight|rest|desktop_presence_active)/i])) {
      const confidence =
        0.48 +
        evidenceScore * 0.18 +
        trendBoost * 0.14 +
        turningBoost * 0.08 +
        reliability * 0.08 +
        ((relationship?.encouragementNeed ?? 0.4) * 0.16) +
        ((behavior?.companionNeed ?? 0) > 0 ? 0.08 : 0);
      results.push(
        this.createCandidate(signal, {
          category: "care",
          title: "Late-Night Care",
          rationale:
            "Signal suggests the user may still be active late at night and could benefit from a gentle check-in.",
          suggestedAction: "Send a short care message and offer help with the next step or a wrap-up.",
          confidence: clamp(confidence, 0.45, 0.96),
          urgency: Math.min(10, baseUrgency + 1 + evidenceScore + trendBoost * 0.6 + turningBoost * 0.4),
          shouldNotify:
            (relationship?.proactiveTolerance ?? 0.5) >= 0.35 &&
            (repeatedPatternCount >= 1 ||
              evidenceScore >= 0.55 ||
              trendBoost >= 0.45 ||
              turningBoost >= 0.18 ||
              hasReversal),
          tags: ["care", "presence", "health"],
          metadata: {
            evidenceScore,
            trendBoost,
            turningBoost,
            reversalDirection,
            sourceReliability: reliability,
            repeatedPatternCount,
            evidenceWindow: this.summarizeEvidenceWindow(evidenceWindow),
            relationshipRapport: relationship?.rapport ?? null,
          },
        }),
      );
    }

    if (containsAny(text, [/(deadline|schedule|calendar|reminder|task|todo|plan)/i])) {
      const planningAffinity = Math.min(0.16, (behavior?.planningInterest ?? 0) * 0.03);
      results.push(
        this.createCandidate(signal, {
          category: "planning",
          title: "Planning Follow-up",
          rationale:
            "Signal is planning-oriented, so the user may need a reminder or next-step suggestion.",
          suggestedAction: "Offer to create, move, or refine the reminder and suggest the next action.",
          confidence: clamp(0.54 + evidenceScore * 0.18 + reliability * 0.08 + planningAffinity, 0.45, 0.93),
          urgency: baseUrgency + evidenceScore * 0.6 + trendBoost * 0.5 + turningBoost * 0.3,
          shouldNotify:
            baseUrgency >= 5 ||
            (behavior?.planningInterest ?? 0) >= 3 ||
            repeatedPatternCount >= 2 ||
            trendBoost >= 0.42 ||
            turningBoost >= 0.16 ||
            hasReversal,
          tags: ["planning", "follow-up"],
          metadata: {
            evidenceScore,
            trendBoost,
            turningBoost,
            reversalDirection,
            sourceReliability: reliability,
            repeatedPatternCount,
            evidenceWindow: this.summarizeEvidenceWindow(evidenceWindow),
          },
        }),
      );
    }

    if (containsAny(text, [/(friend|social|message|reply|follow up|chat)/i])) {
      const socialConfidence =
        0.48 +
        evidenceScore * 0.14 +
        trendBoost * 0.12 +
        turningBoost * 0.06 +
        reliability * 0.08 +
        ((behavior?.companionNeed ?? 0) > 0 ? 0.06 : 0);
      results.push(
        this.createCandidate(signal, {
          category: "follow_up",
          title: "Social Follow-up",
          rationale: "Signal looks social; the user may want a nudge or suggested response.",
          suggestedAction: "Prompt whether to reply, follow up, or let it rest for now.",
          confidence: clamp(socialConfidence, 0.4, 0.88),
          urgency: Math.max(4, baseUrgency - 1 + evidenceScore * 0.5 + trendBoost * 0.4 + turningBoost * 0.25),
          shouldNotify: (baseUrgency >= 6 && reliability >= 0.5) || hasReversal,
          tags: ["social", "follow-up"],
          metadata: {
            evidenceScore,
            trendBoost,
            turningBoost,
            reversalDirection,
            sourceReliability: reliability,
            repeatedPatternCount,
            evidenceWindow: this.summarizeEvidenceWindow(evidenceWindow),
          },
        }),
      );
    }

    if (results.length === 0 && baseUrgency >= 8) {
      results.push(
        this.createCandidate(signal, {
          category: "warning",
          title: "High-Importance Signal",
          rationale: "Signal is high importance even without a specific category match.",
          suggestedAction: "Ask whether the user wants help handling it now.",
          confidence: clamp(0.42 + evidenceScore * 0.2 + reliability * 0.15, 0.45, 0.86),
          urgency: baseUrgency + trendBoost * 0.5 + turningBoost * 0.25,
          shouldNotify: true,
          tags: ["generic", "attention"],
          metadata: {
            evidenceScore,
            trendBoost,
            turningBoost,
            sourceReliability: reliability,
            repeatedPatternCount,
            evidenceWindow: this.summarizeEvidenceWindow(evidenceWindow),
          },
        }),
      );
    }

    if (results.length > 0) {
      const list = this.candidates.get(signal.actorId) ?? [];
      list.push(...results);
      if (list.length > 100) list.splice(0, list.length - 100);
      this.candidates.set(signal.actorId, list);
      this.schedulePersist();
    }

    return results;
  }

  recentCandidates(actorId: string, limit = 20): AnticipationCandidate[] {
    return [...(this.candidates.get(actorId) ?? [])].slice(-limit);
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, AnticipationCandidate[]>;
      for (const [actorId, items] of Object.entries(parsed)) {
        this.candidates.set(actorId, Array.isArray(items) ? items.slice(-100) : []);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[AnticipationEngine] load failed:", error);
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.persistPath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(
        this.persistPath,
        JSON.stringify(Object.fromEntries(this.candidates), null, 2),
        "utf8",
      );
    } catch (error) {
      console.error("[AnticipationEngine] flush failed:", error);
    }
  }

  private createCandidate(
    signal: LifeSignal,
    init: CandidateDraft,
  ): AnticipationCandidate {
    return {
      ...init,
      id: `${signal.id}:${init.category}:${Date.now()}`,
      actorId: signal.actorId,
      signalId: signal.id,
      createdAt: new Date().toISOString(),
      metadata: {
        source: signal.source,
        kind: signal.kind,
        ...init.metadata,
      },
    };
  }

  private computeEvidenceScore(
    signal: LifeSignal,
    recentSignals: LifeSignal[],
    repeatedPatternCount: number,
    evidenceWindow: LifeSignalEvidenceWindow | null,
  ): number {
    const evidenceWeight = Math.min(0.28, signal.evidence.length * 0.05);
    const metricWeight = signal.metrics ? Math.min(0.22, Object.keys(signal.metrics).length * 0.04) : 0;
    const repetitionWeight = Math.min(0.18, repeatedPatternCount * 0.05);
    const windowWeight = evidenceWindow ? Math.min(0.24, evidenceWindow.totalSignals * 0.03) : 0;
    const trendWeight = evidenceWindow?.trend === "rising" ? 0.12 : evidenceWindow?.trend === "falling" ? -0.05 : 0;
    const directionWeight = evidenceWindow ? Math.min(0.12, evidenceWindow.directionScore * 0.12) : 0;
    const slopeWeight = evidenceWindow ? clamp(evidenceWindow.slopeScore * 1.8, -0.12, 0.16) : 0;
    const turningWeight = evidenceWindow ? Math.min(0.08, evidenceWindow.turningPoints * 0.02) : 0;
    const noveltyPenalty = recentSignals.some((item) => item.id !== signal.id && item.summary === signal.summary)
      ? 0.06
      : 0;
    return clamp(
      0.34 +
        evidenceWeight +
        metricWeight +
        repetitionWeight +
        windowWeight +
        trendWeight +
        directionWeight -
        slopeWeight +
        turningWeight -
        noveltyPenalty,
      0.2,
      1,
    );
  }

  private computeTrendBoost(
    evidenceWindow: LifeSignalEvidenceWindow | null,
    signal: LifeSignal,
  ): number {
    if (!evidenceWindow || evidenceWindow.totalSignals === 0) return 0;
    const kindCount = evidenceWindow.signalKinds[signal.kind] ?? 0;
    const topic = this.inferSignalTopic(signal);
    const topicCount = evidenceWindow.topicCounts[topic] ?? 0;
    const tagCount = signal.tags.reduce((sum, tag) => sum + (evidenceWindow.tagCounts[tag] ?? 0), 0);
    const density = clamp(evidenceWindow.totalSignals / 8, 0, 1);
    const recurrence = clamp((kindCount + topicCount + tagCount) / 9, 0, 1);
    const trendBias =
      evidenceWindow.trend === "rising"
        ? 0.18
        : evidenceWindow.trend === "stable"
          ? 0.08
          : 0.02;
    const slopeBias = clamp(Math.abs(evidenceWindow.slopeScore) * 0.8, 0, 0.12);
    return clamp(density * 0.22 + recurrence * 0.24 + trendBias + slopeBias, 0, 0.78);
  }

  private computeTurningBoost(evidenceWindow: LifeSignalEvidenceWindow | null): number {
    if (!evidenceWindow) return 0;
    return clamp(evidenceWindow.turningPoints * 0.04 + Math.abs(evidenceWindow.slopeScore) * 0.25, 0, 0.3);
  }

  private summarizeEvidenceWindow(
    evidenceWindow: LifeSignalEvidenceWindow | null,
  ): Record<string, unknown> | null {
    if (!evidenceWindow) return null;
      return {
      windowMs: evidenceWindow.windowMs,
      totalSignals: evidenceWindow.totalSignals,
      trend: evidenceWindow.trend,
      directionScore: evidenceWindow.directionScore,
      slopeScore: evidenceWindow.slopeScore,
      turningPoints: evidenceWindow.turningPoints,
      reversalDirection: evidenceWindow.reversalDirection,
      topicCounts: evidenceWindow.topicCounts,
      signalKinds: evidenceWindow.signalKinds,
    };
  }

  private inferSignalTopic(signal: LifeSignal): string {
    const text = `${signal.title} ${signal.summary} ${signal.description ?? ""} ${signal.tags.join(" ")}`.toLowerCase();
    if (/(stock|position|stop-loss|take-profit|price|trade|market)/i.test(text)) return "market";
    if (/(deadline|schedule|calendar|reminder|task|todo|plan)/i.test(text)) return "planning";
    if (/(friend|social|message|reply|follow up|chat)/i.test(text)) return "social";
    if (/(night|late|sleep|overtime|fatigue|midnight|rest|desktop_presence_active)/i.test(text)) return "care";
    return signal.source;
  }

  private schedulePersist(): void {
    if (!this.persistPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1000);
    this.persistTimer.unref?.();
  }
}
