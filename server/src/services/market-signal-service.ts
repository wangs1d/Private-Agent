import { randomUUID } from "node:crypto";

import type { LifeSignalHubService } from "./life-signal-hub-service.js";
import type { LifeSignal } from "./life-signal-types.js";
import type { HookBus } from "./hooks/index.js";

export type MarketPositionSnapshotInput = {
  actorId: string;
  symbol: string;
  side?: "long" | "short";
  quantity?: number;
  averageCost?: number;
  currentPrice?: number;
  unrealizedPnlPct?: number;
  volatilityPct?: number;
  thesis?: string;
  tags?: string[];
  occurredAt?: string;
};

export type MarketAnomalySignalInput = {
  actorId: string;
  symbol: string;
  anomalyType: string;
  summary: string;
  priceChangePct?: number;
  volumeRatio?: number;
  confidence?: number;
  evidence?: string[];
  tags?: string[];
  occurredAt?: string;
};

export class MarketSignalService {
  /** 可选：HookBus（价格/数据信号自动外推到 webhook） */
  private hookBus: HookBus | null = null;

  constructor(private readonly signalHub: LifeSignalHubService) {}

  /** 注入 HookBus。新功能接入时无需再手动 wire WebhookService */
  bindHookBus(bus: HookBus | null): void {
    this.hookBus = bus;
  }

  publishPositionSnapshot(input: MarketPositionSnapshotInput): LifeSignal {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const signal: LifeSignal = {
      id: randomUUID(),
      actorId: input.actorId,
      source: "market",
      kind: "portfolio_position_snapshot",
      title: `${input.symbol} Position Snapshot`,
      summary: `Position snapshot recorded for ${input.symbol}.`,
      description: input.thesis,
      tags: ["market", "portfolio", input.symbol.toLowerCase(), ...(input.tags ?? [])],
      importance: this.resolvePositionImportance(input.unrealizedPnlPct, input.volatilityPct),
      evidence: [
        `symbol=${input.symbol}`,
        typeof input.currentPrice === "number" ? `current_price=${input.currentPrice}` : "",
        typeof input.averageCost === "number" ? `average_cost=${input.averageCost}` : "",
        typeof input.unrealizedPnlPct === "number" ? `unrealized_pnl_pct=${input.unrealizedPnlPct}` : "",
        input.thesis ? `thesis=${input.thesis}` : "",
      ].filter(Boolean),
      metrics: this.compactMetrics({
        quantity: input.quantity,
        averageCost: input.averageCost,
        currentPrice: input.currentPrice,
        unrealizedPnlPct: input.unrealizedPnlPct,
        volatilityPct: input.volatilityPct,
      }),
      occurredAt,
      metadata: {
        symbol: input.symbol,
        side: input.side ?? "long",
      },
    };
    this.signalHub.publish(signal);
    // ─── 通过 HookBus 发射（WebhookService 自动订阅并外推）───
    this.hookBus?.emit(
      "market.position_snapshot",
      {
        symbol: input.symbol,
        side: input.side ?? "long",
        quantity: input.quantity,
        averageCost: input.averageCost,
        currentPrice: input.currentPrice,
        unrealizedPnlPct: input.unrealizedPnlPct,
        volatilityPct: input.volatilityPct,
        thesis: input.thesis,
        importance: signal.importance,
        occurredAt,
      },
      { actorId: input.actorId, source: "market-signal" },
    );
    return signal;
  }

  publishAnomaly(input: MarketAnomalySignalInput): LifeSignal {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const signal: LifeSignal = {
      id: randomUUID(),
      actorId: input.actorId,
      source: "market",
      kind: "market_anomaly",
      title: `${input.symbol} Market Anomaly`,
      summary: input.summary,
      tags: ["market", "anomaly", input.symbol.toLowerCase(), ...(input.tags ?? [])],
      importance: this.resolveAnomalyImportance(input.priceChangePct, input.confidence),
      evidence: [
        `anomaly_type=${input.anomalyType}`,
        typeof input.priceChangePct === "number" ? `price_change_pct=${input.priceChangePct}` : "",
        typeof input.volumeRatio === "number" ? `volume_ratio=${input.volumeRatio}` : "",
        ...(input.evidence ?? []),
      ].filter(Boolean),
      metrics: this.compactMetrics({
        priceChangePct: input.priceChangePct,
        volumeRatio: input.volumeRatio,
        confidence: input.confidence,
      }),
      occurredAt,
      metadata: {
        symbol: input.symbol,
        anomalyType: input.anomalyType,
      },
    };
    this.signalHub.publish(signal);
    // ─── 通过 HookBus 发射（价格异动是真实事件，必须实时外推）───
    this.hookBus?.emit(
      "market.anomaly",
      {
        symbol: input.symbol,
        anomalyType: input.anomalyType,
        summary: input.summary,
        priceChangePct: input.priceChangePct,
        volumeRatio: input.volumeRatio,
        confidence: input.confidence,
        evidence: input.evidence,
        importance: signal.importance,
        occurredAt,
      },
      { actorId: input.actorId, source: "market-signal" },
    );
    return signal;
  }

  private resolvePositionImportance(
    pnlPct: number | undefined,
    volatilityPct: number | undefined,
  ): LifeSignal["importance"] {
    const magnitude = Math.max(Math.abs(pnlPct ?? 0), Math.abs(volatilityPct ?? 0));
    if (magnitude >= 9) return "high";
    if (magnitude >= 4) return "medium";
    return "low";
  }

  private resolveAnomalyImportance(
    priceChangePct: number | undefined,
    confidence: number | undefined,
  ): LifeSignal["importance"] {
    const magnitude = Math.abs(priceChangePct ?? 0);
    if (magnitude >= 8 || (confidence ?? 0) >= 0.9) return "critical";
    if (magnitude >= 4 || (confidence ?? 0) >= 0.7) return "high";
    if (magnitude >= 2) return "medium";
    return "low";
  }

  private compactMetrics(metrics: Record<string, number | undefined>): Record<string, number> | undefined {
    const entries = Object.entries(metrics).filter((entry): entry is [string, number] => {
      return typeof entry[1] === "number" && Number.isFinite(entry[1]);
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
