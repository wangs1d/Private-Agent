import { AnticipationEngineService } from "./anticipation-engine-service.js";
import { LifeSignalHubService } from "./life-signal-hub-service.js";
import type { AnticipationCandidate, LifeSignal } from "./life-signal-types.js";
import { ProactiveOutboundMessageService } from "./proactive-outbound-message-service.js";
import { ProactiveContactPolicyService } from "./proactive-contact-policy.js";
import type {
  PersonalizationBehaviorSignals,
  PersonalizationRelationshipState,
  PersonalizationStyleProfileState,
  PersonalizationTimeRhythmState,
  UserPersonalizationService,
} from "./user-personalization/user-personalization-service.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("");
}

export class ProactiveLifeRuntimeService {
  private unsubscribe: (() => void) | null = null;
  private readonly lastNotificationAt = new Map<string, number>();
  private readonly recentSilenceAt = new Map<string, number>();
  private readonly contactPolicy = new ProactiveContactPolicyService();

  constructor(
    private readonly signalHub: LifeSignalHubService,
    private readonly anticipation: AnticipationEngineService,
    private readonly outbound: ProactiveOutboundMessageService,
    private readonly personalization: UserPersonalizationService | null = null,
    private readonly isUserOnline: ((actorId: string) => boolean) | null = null,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.signalHub.subscribe((signal) => this.onSignal(signal));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  recentSignals(actorId: string, limit = 20): LifeSignal[] {
    return this.signalHub.recentSignals(actorId, limit);
  }

  recentCandidates(actorId: string, limit = 20): AnticipationCandidate[] {
    return this.anticipation.recentCandidates(actorId, limit);
  }

  private async onSignal(signal: LifeSignal): Promise<void> {
    const relationship = this.personalization?.getRelationshipState(signal.actorId) ?? null;
    const behavior = this.personalization?.getBehaviorSignals(signal.actorId) ?? null;
    const timeRhythm = this.personalization?.getTimeRhythmState(signal.actorId) ?? null;
    const styleProfile = this.personalization?.getStyleProfileState(signal.actorId) ?? null;
    const contactPreference = this.personalization?.getContactPreferenceState(signal.actorId) ?? null;
    const recentSignals = this.signalHub.recentSignals(signal.actorId, 12);
    const repeatedPatternCount = recentSignals.filter((item) => item.kind === signal.kind).length;
    const evidenceWindow = this.signalHub.getEvidenceWindow(signal.actorId);
    const candidates = this.anticipation.evaluate(signal, {
      behavior,
      relationship,
      timeRhythm,
      styleProfile,
      recentSignals,
      repeatedPatternCount,
      evidenceWindow,
    });

    for (const candidate of candidates) {
      if (!candidate.shouldNotify) continue;
      if (!this.shouldInterrupt(signal.actorId, candidate, relationship, timeRhythm)) continue;
      if (this.shouldStayQuiet(signal.actorId, candidate, relationship)) continue;

      const fatigue = this.outbound.assessFatigue(signal.actorId);
      if (!fatigue.allowed && candidate.category !== "warning") {
        this.recentSilenceAt.set(signal.actorId, Date.now());
        continue;
      }

      const decision = this.contactPolicy.decide({
        actorId: signal.actorId,
        category: candidate.category,
        urgency: candidate.urgency,
        confidence: candidate.confidence,
        tags: candidate.tags,
        wsConnected: this.isUserOnline?.(signal.actorId) ?? true,
        recentContactCountHour: this.outbound.countSince(signal.actorId, 60 * 60_000),
        recentContactCountDay: this.outbound.countSince(signal.actorId, 24 * 60 * 60_000),
        relationship,
        timeRhythm,
        styleProfile,
        preference: contactPreference,
      });
      if (!decision.allowed) {
        this.recentSilenceAt.set(signal.actorId, Date.now());
        continue;
      }

      const threadContext = this.outbound.getThreadContext(
        signal.actorId,
        `anticipation:${candidate.category}`,
        {
          category: candidate.category,
          tags: candidate.tags,
        },
      );
      const text = this.composeMessage(candidate, relationship, behavior, styleProfile, threadContext);
      await this.outbound.send({
        actorId: signal.actorId,
        title: candidate.title,
        text,
        reason: `anticipation:${candidate.category}`,
        channel: decision.channel,
        meta: {
          signalId: signal.id,
          category: candidate.category,
          confidence: candidate.confidence,
          urgency: candidate.urgency,
          rationale: candidate.rationale,
          suggestedAction: candidate.suggestedAction,
          tags: candidate.tags,
          interruptScore: this.computeInterruptScore(candidate, relationship, timeRhythm),
          fatigueReason: fatigue.reason,
          recoveryMode: this.isRecoveryWindow(signal.actorId),
          threadContext,
          contactDecision: decision.reason,
          contactRationale: decision.rationale,
          quietHours: decision.quietHours,
          disturbanceScore: decision.disturbanceScore,
        },
      });
      this.lastNotificationAt.set(signal.actorId, Date.now());
    }
  }

  private shouldInterrupt(
    actorId: string,
    candidate: AnticipationCandidate,
    relationship: PersonalizationRelationshipState | null,
    timeRhythm: PersonalizationTimeRhythmState | null,
  ): boolean {
    const lastAt = this.lastNotificationAt.get(actorId) ?? 0;
    const proactiveTolerance = relationship?.proactiveTolerance ?? 0.5;
    const cooldownMs = this.resolveCooldownMs(candidate, proactiveTolerance, timeRhythm);
    if (Date.now() - lastAt < cooldownMs) {
      return false;
    }
    const interruptScore = this.computeInterruptScore(candidate, relationship, timeRhythm);
    return interruptScore >= 0.52;
  }

  private shouldStayQuiet(
    actorId: string,
    candidate: AnticipationCandidate,
    relationship: PersonalizationRelationshipState | null,
  ): boolean {
    if (candidate.category === "warning") return false;
    const rapport = relationship?.rapport ?? 0.35;
    const proactiveTolerance = relationship?.proactiveTolerance ?? 0.5;
    const lowTolerance = rapport < 0.35 && proactiveTolerance < 0.4;
    const lowSignal = candidate.confidence < 0.68 && candidate.urgency < 6;
    if (lowTolerance && lowSignal) {
      this.recentSilenceAt.set(actorId, Date.now());
      return true;
    }
    return false;
  }

  private resolveCooldownMs(
    candidate: AnticipationCandidate,
    proactiveTolerance: number,
    timeRhythm: PersonalizationTimeRhythmState | null,
  ): number {
    const base =
      candidate.category === "warning"
        ? 4 * 60_000
        : candidate.category === "care"
          ? 18 * 60_000
          : 10 * 60_000;
    const toleranceFactor = clamp(1.35 - proactiveTolerance, 0.55, 1.4);
    const hour = new Date().getHours().toString().padStart(2, "0");
    const receptiveness = timeRhythm?.receptiveHours?.[hour] ?? 0;
    const rhythmFactor = receptiveness > 0 ? 0.82 : 1.08;
    return Math.round(base * toleranceFactor * rhythmFactor);
  }

  private computeInterruptScore(
    candidate: AnticipationCandidate,
    relationship: PersonalizationRelationshipState | null,
    timeRhythm: PersonalizationTimeRhythmState | null,
  ): number {
    const urgencyWeight = clamp(candidate.urgency / 10, 0, 1) * 0.4;
    const confidenceWeight = clamp(candidate.confidence, 0, 1) * 0.28;
    const proactiveWeight = (relationship?.proactiveTolerance ?? 0.5) * 0.12;
    const rapportWeight = (relationship?.rapport ?? 0.35) * 0.1;
    const encouragementWeight = (relationship?.encouragementNeed ?? 0.4) * 0.05;
    const hour = new Date().getHours();
    const lateNightFactor =
      hour >= 23 || hour <= 5 ? (timeRhythm?.lateNightTolerance ?? 0.35) * 0.05 : 0.03;
    return clamp(
      urgencyWeight +
        confidenceWeight +
        proactiveWeight +
        rapportWeight +
        encouragementWeight +
        lateNightFactor,
      0,
      1,
    );
  }

  private isRecoveryWindow(actorId: string): boolean {
    const lastSilence = this.recentSilenceAt.get(actorId) ?? 0;
    return Date.now() - lastSilence <= 90 * 60_000 && lastSilence > 0;
  }

  private continuationLead(
    candidate: AnticipationCandidate,
    threadContext: string | null,
    concise: boolean,
  ): string {
    if (!threadContext) return "";
    switch (candidate.category) {
      case "care":
        return concise ? "接着前面的提醒，" : "沿着我前面提到的这条线，";
      case "warning":
        return concise ? "同一条信号上看，" : "这件事还是和前面的警示连着，";
      case "planning":
        return concise ? "接上那条任务线，" : "把前面的任务线继续往前推，";
      case "follow_up":
        return concise ? "继续沿着这条线，" : "沿着前面那条线再往前走一步，";
      default:
        return "";
    }
  }

  private composeMessage(
    candidate: AnticipationCandidate,
    relationship: PersonalizationRelationshipState | null,
    behavior: PersonalizationBehaviorSignals | null,
    styleProfile: PersonalizationStyleProfileState | null,
    threadContext: string | null,
  ): string {
    const playfulAllowed =
      ((relationship?.humorTolerance ?? 0.5) >= 0.65 &&
        (relationship?.rapport ?? 0.35) >= 0.55) ||
      (styleProfile?.careStyle === "playful" && (styleProfile?.banterLevel ?? 0.4) >= 0.55);
    const warmLeadIn =
      (relationship?.warmth ?? 0.5) >= 0.65 || (relationship?.encouragementNeed ?? 0.4) >= 0.6;
    const concise =
      (relationship?.directnessPreference ?? 0.5) >= 0.65 &&
      (behavior?.planningInterest ?? 0) >= 2;
    const recoveryMode = this.isRecoveryWindow(candidate.actorId);
    const continuationLead = this.continuationLead(candidate, threadContext, concise);
    const evidenceLead = this.evidenceExplanation(candidate);

    if (candidate.category === "care") {
      if (recoveryMode) {
        return concise
          ? `${evidenceLead}${continuationLead}先停一下，你现在不用继续硬撑。`
          : `${evidenceLead}${continuationLead}这件事你已经扛了一会儿了，先缓一缓，下一步可以稍后再看。`;
      }
      if (playfulAllowed) {
        return concise
          ? `${evidenceLead}${continuationLead}你又开始硬冲了，先深呼吸一下，再收拾后面的部分。`
          : `${evidenceLead}${continuationLead}你又进入超负荷状态了，先松一点，后面的事情我们一起理。`;
      }
      if (styleProfile?.careStyle === "direct") {
        return `${evidenceLead}${continuationLead}先停一下，先休息，再决定下一步。`;
      }
      return concise
        ? `${evidenceLead}${continuationLead}看起来你这边已经有点晚了，先短暂休息一下。`
        : `${evidenceLead}${continuationLead}你现在大概率还在忙，先停一下，再决定今晚后面的事情还要不要继续处理。`;
    }

    if (candidate.category === "warning") {
      return warmLeadIn
        ? joinParts([evidenceLead, continuationLead, `我看到这边有个变化，值得现在检查一下。${candidate.suggestedAction}`])
        : joinParts([evidenceLead, continuationLead, `这里有个变化，需要你做个决定。${candidate.suggestedAction}`]);
    }

    if (candidate.category === "planning") {
      return concise
        ? joinParts([evidenceLead, continuationLead, `这件事已经可以进入下一步了。${candidate.suggestedAction}`])
        : joinParts([evidenceLead, continuationLead, `这件事大概率需要再往前推进一步。${candidate.suggestedAction}`]);
    }

    if (candidate.category === "follow_up") {
      return playfulAllowed
        ? joinParts([evidenceLead, continuationLead, "这里可能有一个后续动作，你来定，我可以帮你接着推进。"])
        : joinParts([evidenceLead, continuationLead, `这里可能有一个值得继续跟进的动作。${candidate.suggestedAction}`]);
    }

    return `${evidenceLead}我捕捉到一个值得你关注的信号。${candidate.suggestedAction}`;
  }

  private evidenceExplanation(candidate: AnticipationCandidate): string {
    const metadata = candidate.metadata as Record<string, unknown> | undefined;
    const window = metadata?.evidenceWindow as Record<string, unknown> | undefined;
    const reversalDirection = metadata?.reversalDirection as string | null | undefined;
    const totalSignals = typeof window?.totalSignals === "number" ? window.totalSignals : null;
    const trend = typeof window?.trend === "string" ? window.trend : null;
    const slopeScore = typeof window?.slopeScore === "number" ? window.slopeScore : null;
    const turningPoints = typeof window?.turningPoints === "number" ? window.turningPoints : null;

    if (!window) return "";

    const reversalText =
      reversalDirection === "upward"
        ? "方向开始往上走"
        : reversalDirection === "downward"
          ? "方向开始往下走"
          : reversalDirection === "mixed"
            ? "方向有点分歧"
            : trend
              ? `方向${trend === "rising" ? "在往上" : trend === "falling" ? "在往下" : "比较稳"}`
              : "方向在变";

    const parts = [
      "最近这条线",
      totalSignals != null ? `${totalSignals}条信号` : null,
      turningPoints != null ? `${turningPoints}个拐点` : null,
      reversalText,
    ].filter(Boolean);

    const slopeTail = slopeScore != null ? `，斜率 ${slopeScore.toFixed(2)}` : "";
    return `${parts.join("，")}${slopeTail}。`;
  }
}
