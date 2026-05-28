import { randomBytes } from "node:crypto";

import type { WsConnectionRegistryLike } from "../host-types.js";
import {
  basicStrategyHint,
  handScore,
  isBlackjack,
  playerHit,
  playerStand,
  startBlackjack,
  type BjGame,
  type BjOutcome,
} from "./blackjack/blackjack-engine.js";
import {
  botSessionId,
  humanSessionId,
  isHumanGameSession,
} from "./game-center-session.js";
import type { WorldService } from "./world-service.js";
import { AGENT_WORLD_CREDIT_REASONS } from "./world-service.js";

export type BlackjackTableSummary = {
  tableId: string;
  status: "playing" | "finished";
  stake: number;
};

type Table = {
  id: string;
  agentSessionId: string;
  humanSessionId: string;
  stake: number;
  game: BjGame;
  watchers: Set<string>;
};

function newTableId(): string {
  return `bj_${randomBytes(6).toString("hex")}`;
}

export class BlackjackService {
  private readonly tables = new Map<string, Table>();
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  createGameCenterTable(
    agentSessionId: string,
    stake = 50,
  ): { ok: true; tableId: string; snapshot: unknown } | { ok: false; reason: string } {
    const human = humanSessionId(agentSessionId);
    const st = Math.floor(stake);
    if (!Number.isFinite(st) || st < 1 || st > 2000) {
      return { ok: false, reason: "赌注须在 1–2000 之间" };
    }
    this.worldService.enterGameCenterScene(agentSessionId, "blackjack");
    this.worldService.enterGameCenterScene(human, "blackjack");
    this.worldService.ensureGameCenterCredits(agentSessionId, st * 20);
    this.worldService.ensureGameCenterCredits(human, st * 20);
    if (!this.worldService.tryDebitCredits(human, st)) {
      return { ok: false, reason: "筹码不足" };
    }
    const id = newTableId();
    const game = startBlackjack(st);
    const t: Table = {
      id,
      agentSessionId,
      humanSessionId: human,
      stake: st,
      game,
      watchers: new Set(),
    };
    this.tables.set(id, t);
    this.settleIfFinished(t);
    this.notify(t);
    return { ok: true, tableId: id, snapshot: this.buildSnapshot(t, human) };
  }

  watchTable(tableId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    t.watchers.add(sessionId);
    return { ok: true };
  }

  unwatchTable(tableId: string, sessionId: string): void {
    this.tables.get(tableId)?.watchers.delete(sessionId);
  }

  hit(
    tableId: string,
    sessionId: string,
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (sessionId !== t.humanSessionId) return { ok: false, reason: "仅玩家可要牌" };
    if (t.game.phase !== "player_turn") return { ok: false, reason: "当前不可要牌" };
    t.game = playerHit(t.game);
    this.settleIfFinished(t);
    this.notify(t);
    return { ok: true, snapshot: this.buildSnapshot(t, sessionId) };
  }

  stand(
    tableId: string,
    sessionId: string,
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (sessionId !== t.humanSessionId) return { ok: false, reason: "仅玩家可停牌" };
    if (t.game.phase !== "player_turn") return { ok: false, reason: "当前不可停牌" };
    t.game = playerStand(t.game);
    this.settleIfFinished(t);
    this.notify(t);
    return { ok: true, snapshot: this.buildSnapshot(t, sessionId) };
  }

  getSnapshot(
    tableId: string,
    sessionId: string,
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    return { ok: true, snapshot: this.buildSnapshot(t, sessionId) };
  }

  private settleIfFinished(t: Table): void {
    const o = t.game.outcome;
    if (!o) return;
    const stake = t.stake;
    const human = t.humanSessionId;
    if (o === "player_blackjack") {
      this.worldService.creditCredits(human, Math.floor(stake * 2.5), AGENT_WORLD_CREDIT_REASONS.GameCenterGrant);
    } else if (o === "player_win") {
      this.worldService.creditCredits(human, stake * 2, AGENT_WORLD_CREDIT_REASONS.GameCenterGrant);
    } else if (o === "push") {
      this.worldService.creditCredits(human, stake, AGENT_WORLD_CREDIT_REASONS.GameCenterGrant);
    }
  }

  private buildSnapshot(t: Table, viewerSessionId: string): Record<string, unknown> {
    const g = t.game;
    const hideDealer = g.phase === "player_turn" && viewerSessionId === t.humanSessionId;
    const dealerVisible = hideDealer ? [g.dealerHand[0]!] : [...g.dealerHand];
    const hint = g.phase === "player_turn" ? basicStrategyHint(g) : null;
    return {
      tableId: t.id,
      game: "blackjack",
      role: viewerSessionId === t.humanSessionId ? "player" : "guest",
      status: g.phase === "finished" ? "finished" : "playing",
      stake: t.stake,
      playerHand: [...g.playerHand],
      dealerHand: dealerVisible,
      dealerHidden: hideDealer,
      playerScore: handScore(g.playerHand),
      dealerScore: hideDealer ? handScore([g.dealerHand[0]!]) : handScore(g.dealerHand),
      phase: g.phase,
      outcome: g.outcome ?? null,
      strategyHint: hint,
      agentSessionId: t.agentSessionId,
      isPlayerBlackjack: isBlackjack(g.playerHand),
    };
  }

  private notify(_t: Table): void {
    // 游戏中心 21 点以 HTTP 轮询为主；后续可接专用 WS 事件。
  }
}

export type { BjOutcome };
