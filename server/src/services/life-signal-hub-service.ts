import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LifeSignal, LifeSignalEvidenceWindow } from "./life-signal-types.js";

type PersistedShape = {
  history: Record<string, LifeSignal[]>;
  evidenceWindows?: Record<string, LifeSignalEvidenceWindow>;
};

export type LifeSignalSubscriber = (signal: LifeSignal) => Promise<void> | void;

export class LifeSignalHubService {
  private readonly history = new Map<string, LifeSignal[]>();
  private readonly evidenceWindows = new Map<string, LifeSignalEvidenceWindow>();
  private readonly subscribers = new Set<LifeSignalSubscriber>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly evidenceWindowMs = Math.max(
    5 * 60_000,
    Number.parseInt(process.env.LIFE_SIGNAL_EVIDENCE_WINDOW_MS ?? "", 10) || 30 * 60_000,
  );

  constructor(private readonly persistPath?: string) {}

  publish(signal: LifeSignal): void {
    const list = this.history.get(signal.actorId) ?? [];
    list.push(signal);
    if (list.length > 100) list.splice(0, list.length - 100);
    this.history.set(signal.actorId, list);
    this.evidenceWindows.set(signal.actorId, this.buildEvidenceWindow(signal.actorId));
    this.schedulePersist();

    for (const subscriber of this.subscribers) {
      void Promise.resolve(subscriber(signal)).catch((error) => {
        console.error("[LifeSignalHub] subscriber failed:", error);
      });
    }
  }

  subscribe(subscriber: LifeSignalSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  recentSignals(actorId: string, limit = 20): LifeSignal[] {
    return [...(this.history.get(actorId) ?? [])].slice(-limit);
  }

  getEvidenceWindow(actorId: string): LifeSignalEvidenceWindow {
    const existing = this.evidenceWindows.get(actorId);
    if (existing) return existing;
    const window = this.buildEvidenceWindow(actorId);
    this.evidenceWindows.set(actorId, window);
    return window;
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape | Record<string, LifeSignal[]>;
      if ("history" in parsed && parsed.history && typeof parsed.history === "object") {
        for (const [actorId, signals] of Object.entries(parsed.history)) {
          this.history.set(actorId, Array.isArray(signals) ? signals.slice(-100) : []);
        }
        if (parsed.evidenceWindows && typeof parsed.evidenceWindows === "object") {
          for (const [actorId, window] of Object.entries(parsed.evidenceWindows)) {
            if (window && typeof window === "object") {
              this.evidenceWindows.set(actorId, this.normalizeEvidenceWindow(actorId, window));
            }
          }
        }
      } else {
        for (const [actorId, signals] of Object.entries(parsed as Record<string, LifeSignal[]>)) {
          this.history.set(actorId, Array.isArray(signals) ? signals.slice(-100) : []);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[LifeSignalHub] load failed:", error);
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
        JSON.stringify(
          {
            history: Object.fromEntries(this.history),
            evidenceWindows: Object.fromEntries(this.evidenceWindows),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (error) {
      console.error("[LifeSignalHub] flush failed:", error);
    }
  }

  private schedulePersist(): void {
    if (!this.persistPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1000);
    this.persistTimer.unref?.();
  }

  private buildEvidenceWindow(actorId: string): LifeSignalEvidenceWindow {
    const now = Date.now();
    const recentSignals = (this.history.get(actorId) ?? []).filter((item) => {
      const occurredAt = Date.parse(item.occurredAt);
      return Number.isFinite(occurredAt) && now - occurredAt <= this.evidenceWindowMs;
    });
    const totalSignals = recentSignals.length;
    const firstOccurredAt = recentSignals[0]?.occurredAt;
    const lastOccurredAt = recentSignals[recentSignals.length - 1]?.occurredAt;

    const topicCounts: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};
    const signalKinds: Record<string, number> = {};
    let directionScore = 0;
    let slopeScore = 0;
    let turningPoints = 0;
    let prevIntensity: number | null = null;
    let prevDelta: number | null = null;

    recentSignals.forEach((signal, index) => {
      signalKinds[signal.kind] = (signalKinds[signal.kind] ?? 0) + 1;
      for (const tag of signal.tags) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      const topic = this.inferSignalTopic(signal);
      topicCounts[topic] = (topicCounts[topic] ?? 0) + 1;

      const ageWeight = recentSignals.length > 1 ? index / (recentSignals.length - 1) : 1;
      const intensity = this.signalIntensity(signal);
      directionScore += intensity * (0.45 + ageWeight * 0.55);

      if (prevIntensity !== null) {
        const delta = intensity - prevIntensity;
        slopeScore += delta * (0.6 + ageWeight * 0.4);
        if (prevDelta !== null && delta !== 0 && prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) {
          turningPoints += 1;
        }
        prevDelta = delta;
      }
      prevIntensity = intensity;
    });

    const normalizedDirection = totalSignals > 0 ? directionScore / totalSignals : 0;
    const normalizedSlope = recentSignals.length > 1 ? slopeScore / (recentSignals.length - 1) : 0;
    const reversalDirection =
      turningPoints > 0
        ? normalizedSlope >= 0.02
          ? "upward"
          : normalizedSlope <= -0.02
            ? "downward"
            : "mixed"
        : null;
    const trend =
      totalSignals < 2
        ? "stable"
        : normalizedDirection >= 0.62 || normalizedSlope >= 0.04
          ? "rising"
          : normalizedDirection <= 0.38 || normalizedSlope <= -0.04
            ? "falling"
            : "stable";

    return {
      actorId,
      windowMs: this.evidenceWindowMs,
      totalSignals,
      recentSignals,
      trend,
      directionScore: Number(normalizedDirection.toFixed(3)),
      slopeScore: Number(normalizedSlope.toFixed(3)),
      turningPoints,
      reversalDirection,
      topicCounts,
      tagCounts,
      signalKinds,
      firstOccurredAt,
      lastOccurredAt,
    };
  }

  private normalizeEvidenceWindow(
    actorId: string,
    window: Partial<LifeSignalEvidenceWindow>,
  ): LifeSignalEvidenceWindow {
    return {
      actorId,
      windowMs: Number(window.windowMs) || this.evidenceWindowMs,
      totalSignals: Number(window.totalSignals) || 0,
      recentSignals: Array.isArray(window.recentSignals) ? window.recentSignals.slice(-20) : [],
      trend: window.trend === "rising" || window.trend === "falling" ? window.trend : "stable",
      directionScore: Number(window.directionScore) || 0,
      slopeScore: Number(window.slopeScore) || 0,
      turningPoints: Number(window.turningPoints) || 0,
      reversalDirection:
        window.reversalDirection === "upward" || window.reversalDirection === "downward" || window.reversalDirection === "mixed"
          ? window.reversalDirection
          : null,
      topicCounts: window.topicCounts && typeof window.topicCounts === "object" ? window.topicCounts : {},
      tagCounts: window.tagCounts && typeof window.tagCounts === "object" ? window.tagCounts : {},
      signalKinds: window.signalKinds && typeof window.signalKinds === "object" ? window.signalKinds : {},
      firstOccurredAt: typeof window.firstOccurredAt === "string" ? window.firstOccurredAt : undefined,
      lastOccurredAt: typeof window.lastOccurredAt === "string" ? window.lastOccurredAt : undefined,
    };
  }

  private signalIntensity(signal: LifeSignal): number {
    const base =
      signal.importance === "critical"
        ? 1
        : signal.importance === "high"
          ? 0.78
          : signal.importance === "medium"
            ? 0.58
            : 0.36;
    const evidenceBonus = Math.min(0.18, signal.evidence.length * 0.03);
    const metricBonus = signal.metrics ? Math.min(0.12, Object.keys(signal.metrics).length * 0.02) : 0;
    const reliability = Math.max(0.2, Math.min(1, signal.sourceReliability ?? 0.7));
    return Math.max(0, Math.min(1, base + evidenceBonus + metricBonus + (reliability - 0.5) * 0.2));
  }

  private inferSignalTopic(signal: LifeSignal): string {
    const text = `${signal.title} ${signal.summary} ${signal.description ?? ""} ${signal.tags.join(" ")}`.toLowerCase();
    if (/(stock|position|stop-loss|take-profit|price|trade|market)/i.test(text)) return "market";
    if (/(deadline|schedule|calendar|reminder|task|todo|plan)/i.test(text)) return "planning";
    if (/(friend|social|message|reply|follow up|chat)/i.test(text)) return "social";
    if (/(night|late|sleep|overtime|fatigue|midnight|rest|desktop_presence_active)/i.test(text)) return "care";
    return signal.source;
  }
}
