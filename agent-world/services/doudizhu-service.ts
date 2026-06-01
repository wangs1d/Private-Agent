import { randomBytes } from "node:crypto";

import type { WsConnectionRegistryLike } from "../host-types.js";
import { AgentWorldServerEventType } from "../protocol-world.js";
import { AGENT_WORLD_CREDIT_REASONS, type WorldService } from "./world-service.js";
import {
  applyPass,
  applyPlayCombo,
  dealHands,
  parseCombo,
  pickLandlordSeat,
  sortCards,
  startRunningGame,
  type RunningGame,
} from "./doudizhu/doudizhu-engine.js";
import { getStateEventManager } from "../deps/state/index.js";
import { pickDoudizhuBotMove } from "./game-center-bot.js";
import { isHumanGameSession } from "./game-center-session.js";

const MAX_BOT_TURN_STEPS = 64;

export type DoudizhuTableStatus = "waiting" | "playing" | "finished";

export type DoudizhuTableSummary = {
  tableId: string;
  stake: number;
  status: DoudizhuTableStatus;
  playerCount: number;
  spectatorCount: number;
  seats: [string | null, string | null, string | null];
};

type Table = {
  id: string;
  stake: number;
  createdBy: string;
  seats: [string | null, string | null, string | null];
  spectators: Set<string>;
  status: DoudizhuTableStatus;
  /** 开局时冻结赌注的会话（顺序与 seats 一致，仅在 playing 时有效）。 */
  frozenParticipants: [string | null, string | null, string | null];
  pot: number;
  game: RunningGame | null;
  payouts?: Record<string, number>;
  winnerSide?: "landlord" | "farmers";
};

function newTableId(): string {
  return `ddz_${randomBytes(6).toString("hex")}`;
}

export class DoudizhuService {
  private readonly tables = new Map<string, Table>();
  /** 仅想收推送、不在选手/观战列表中的 session（例如纯旁路 Agent）。 */
  private readonly watchers = new Map<string, Set<string>>();
  /** 订阅大厅列表的会话（任意牌桌变更时推送）。 */
  private readonly lobbyWatchers = new Set<string>();
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  /** 斗地主工具入口：侧栏「游戏」tab，无需 Agent World 注册。 */
  assertAgentWorldEntry(sessionId: string): void {
    this.worldService.enterGameCenterScene(sessionId, "doudizhu");
  }

  /** 绑定 WebSocket 注册表后，状态变更会向在线会话推送 `world.doudizhu.snapshot`。 */
  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  /** 显式订阅某桌快照（与 HTTP 观战并列；适合只跑 API 的 Agent）。 */
  watchTable(tableId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    if (!this.tables.has(tableId)) return { ok: false, reason: "桌台不存在" };
    let set = this.watchers.get(tableId);
    if (!set) {
      set = new Set();
      this.watchers.set(tableId, set);
    }
    set.add(sessionId);
    this.sendSnapshotToSession(tableId, sessionId);
    return { ok: true };
  }

  unwatchTable(tableId: string, sessionId: string): void {
    this.watchers.get(tableId)?.delete(sessionId);
  }

  watchLobby(sessionId: string): void {
    this.worldService.visitDoudizhu(sessionId);
    this.lobbyWatchers.add(sessionId);
    this.sendLobbySnapshotToSession(sessionId);
  }

  unwatchLobby(sessionId: string): void {
    this.lobbyWatchers.delete(sessionId);
  }

  listTables(): DoudizhuTableSummary[] {
    return [...this.tables.values()].map((t) => this.summarize(t));
  }

  /** 将会话场景标为斗地主馆（游戏中心，无需 Agent World 注册）。 */
  visitHall(sessionId: string): void {
    this.worldService.enterGameCenterScene(sessionId, "doudizhu");
  }

  createTable(sessionId: string, stake: number): { ok: true; table: DoudizhuTableSummary } | { ok: false; reason: string } {
    if (!Number.isFinite(stake) || stake < 1 || stake > 2000) {
      return { ok: false, reason: "赌注须在 1–2000 之间" };
    }
    this.worldService.enterGameCenterScene(sessionId, "doudizhu");
    this.worldService.ensureGameCenterCredits(sessionId, stake * 30);
    const id = newTableId();
    const t: Table = {
      id,
      stake: Math.floor(stake),
      createdBy: sessionId,
      seats: [sessionId, null, null],
      spectators: new Set(),
      status: "waiting",
      frozenParticipants: [null, null, null],
      pot: 0,
      game: null,
    };
    this.tables.set(id, t);
    this.notifyLobby();
    return { ok: true, table: this.summarize(t) };
  }

  joinAsPlayer(
    tableId: string,
    sessionId: string,
    expectedRevision?: number,
  ): { ok: true; table: DoudizhuTableSummary } | { ok: false; reason: string; message?: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "waiting") return { ok: false, reason: "对局已开始或已结束" };
    this.worldService.visitDoudizhu(sessionId);
    this.removeFromSpectators(t, sessionId);
    if (t.seats[0] === sessionId || t.seats[1] === sessionId || t.seats[2] === sessionId) {
      return { ok: true, table: this.summarize(t) };
    }
    const idx = t.seats.findIndex((s) => s === null);
    if (idx < 0) return { ok: false, reason: "座位已满" };
    t.seats[idx] = sessionId;
    const r = this.tryStartGame(t, sessionId, expectedRevision);
    if (!r.ok) {
      t.seats[idx] = null;
      return r;
    }
    this.notifyTable(tableId);
    return { ok: true, table: this.summarize(t) };
  }

  joinSpectator(
    tableId: string,
    sessionId: string,
  ): { ok: true; table: DoudizhuTableSummary } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    this.worldService.visitDoudizhu(sessionId);
    if (t.seats[0] === sessionId || t.seats[1] === sessionId || t.seats[2] === sessionId) {
      return { ok: false, reason: "你已在选手席，请观战时先离座" };
    }
    t.spectators.add(sessionId);
    this.notifyTable(tableId);
    return { ok: true, table: this.summarize(t) };
  }

  leave(tableId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    t.spectators.delete(sessionId);
    this.unwatchTable(tableId, sessionId);
    let removedTable = false;
    if (t.status === "finished") {
      for (let i = 0; i < 3; i++) {
        if (t.seats[i] === sessionId) t.seats[i] = null;
      }
      if (!t.seats[0] && !t.seats[1] && !t.seats[2] && t.spectators.size === 0) {
        this.watchers.delete(t.id);
        this.tables.delete(t.id);
        removedTable = true;
      }
    } else if (t.status === "waiting") {
      for (let i = 0; i < 3; i++) {
        if (t.seats[i] === sessionId) t.seats[i] = null;
      }
    } else if (t.status === "playing") {
      this.abortPlaying(t, "玩家离场，本局作废");
    }
    if (!removedTable) this.notifyTable(tableId);
    else this.notifyLobby();
    return { ok: true };
  }

  play(
    tableId: string,
    sessionId: string,
    action: "pass" | "play",
    cards: string[] | undefined,
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "playing" || !t.game) return { ok: false, reason: "未在进行对局" };
    const seat = this.seatIndexForSession(t, sessionId);
    if (seat === null) return { ok: false, reason: "你不是本桌选手" };
    if (action === "pass") {
      const r = applyPass(t.game, seat);
      if (!r.ok) return r;
    } else {
      const sel = cards ?? [];
      const parsed = parseCombo(sel);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const r = applyPlayCombo(t.game, seat, parsed.combo, sel);
      if (!r.ok) return r;
      if (r.winnerSeat !== undefined) {
        this.finishGame(t, r.winnerSeat);
      }
    }
    this.notifyTable(tableId);
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

  /** 游戏：自动推进 Bot / 子 Agent 座位回合。 */
  advanceBotTurns(tableId: string, viewerSessionId: string): unknown {
    for (let step = 0; step < MAX_BOT_TURN_STEPS; step += 1) {
      const t = this.tables.get(tableId);
      if (!t || t.status !== "playing" || !t.game) break;
      const seat = t.game.turnSeat;
      const sid = t.seats[seat];
      if (!sid || isHumanGameSession(sid)) break;
      const move = pickDoudizhuBotMove(t.game, seat);
      if (move.action === "pass") {
        const r = this.play(tableId, sid, "pass", undefined);
        if (!r.ok) break;
        if ((r.snapshot as Record<string, unknown>).status === "finished") return r.snapshot;
        continue;
      }
      const r = this.play(tableId, sid, "play", move.cards);
      if (!r.ok) {
        const pr = this.play(tableId, sid, "pass", undefined);
        if (!pr.ok) break;
        if ((pr.snapshot as Record<string, unknown>).status === "finished") return pr.snapshot;
        continue;
      }
      if ((r.snapshot as Record<string, unknown>).status === "finished") return r.snapshot;
    }
    const t = this.tables.get(tableId);
    if (!t) return null;
    return this.buildSnapshot(t, viewerSessionId);
  }

  private summarize(t: Table): DoudizhuTableSummary {
    return {
      tableId: t.id,
      stake: t.stake,
      status: t.status,
      playerCount: t.seats.filter(Boolean).length,
      spectatorCount: t.spectators.size,
      seats: [...t.seats],
    };
  }

  private removeFromSpectators(t: Table, sessionId: string): void {
    t.spectators.delete(sessionId);
  }

  private seatIndexForSession(t: Table, sessionId: string): 0 | 1 | 2 | null {
    const i = t.seats.findIndex((s) => s === sessionId);
    if (i < 0) return null;
    return i as 0 | 1 | 2;
  }

  private tryStartGame(
    t: Table,
    actingSessionId: string,
    expectedRevision?: number,
  ): { ok: true } | { ok: false; reason: string; message?: string } {
    if (t.seats[0] && t.seats[1] && t.seats[2]) {
      try {
        this.worldService.assertRevisionIfProvided(actingSessionId, expectedRevision);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("WORLD_REVISION_CONFLICT")) {
          return { ok: false, reason: "WORLD_REVISION_CONFLICT", message: msg };
        }
        throw e;
      }
      const stake = t.stake;
      const p0 = t.seats[0]!;
      const p1 = t.seats[1]!;
      const p2 = t.seats[2]!;
      if (!this.worldService.tryDebitCredits(p0, stake)) {
        return { ok: false, reason: `座位 1 世界点数不足（需 ${stake}）` };
      }
      if (!this.worldService.tryDebitCredits(p1, stake)) {
        this.worldService.creditCredits(
          p0,
          stake,
          AGENT_WORLD_CREDIT_REASONS.DoudizhuStakeRefund,
        );
        return { ok: false, reason: `座位 2 世界点数不足（需 ${stake}）` };
      }
      if (!this.worldService.tryDebitCredits(p2, stake)) {
        this.worldService.creditCredits(
          p0,
          stake,
          AGENT_WORLD_CREDIT_REASONS.DoudizhuStakeRefund,
        );
        this.worldService.creditCredits(
          p1,
          stake,
          AGENT_WORLD_CREDIT_REASONS.DoudizhuStakeRefund,
        );
        return { ok: false, reason: `座位 3 世界点数不足（需 ${stake}）` };
      }
      t.frozenParticipants = [p0, p1, p2];
      t.pot = stake * 3;
      const dealt = dealHands();
      const landlord = pickLandlordSeat();
      const hands: [string[], string[], string[]] = [
        [...dealt.hands[0]!],
        [...dealt.hands[1]!],
        [...dealt.hands[2]!],
      ];
      hands[landlord] = sortCards([...hands[landlord]!, ...dealt.bottom]);
      t.game = startRunningGame(landlord, hands);
      t.status = "playing";
    }
    return { ok: true };
  }

  private finishGame(t: Table, winnerSeat: 0 | 1 | 2): void {
    const landlord = t.game?.landlordSeat;
    if (landlord === undefined || !t.frozenParticipants[0] || !t.frozenParticipants[1] || !t.frozenParticipants[2]) {
      t.status = "finished";
      return;
    }
    const winnerIsLandlord = winnerSeat === landlord;
    const payouts: Record<string, number> = {};
    const pot = t.pot;
    if (winnerIsLandlord) {
      const sid = t.frozenParticipants[winnerSeat]!;
      payouts[sid] = pot;
      t.winnerSide = "landlord";
    } else {
      t.winnerSide = "farmers";
      const farmerSeats = ([0, 1, 2] as const).filter((x) => x !== landlord);
      const a = Math.floor(pot / 2);
      const b = pot - a;
      for (const fs of farmerSeats) {
        const sid = t.frozenParticipants[fs]!;
        payouts[sid] = (payouts[sid] ?? 0) + (fs === farmerSeats[0] ? a : b);
      }
    }
    for (const [sid, amt] of Object.entries(payouts)) {
      if (amt > 0) {
        this.worldService.creditCredits(
          sid,
          amt,
          AGENT_WORLD_CREDIT_REASONS.DoudizhuGamePayout,
        );
      }
    }
    t.payouts = payouts;
    t.status = "finished";

    getStateEventManager().emitGameFinished("doudizhu", t.createdBy, t.createdBy, {
      winner: winnerIsLandlord ? "landlord" : "farmers",
      loser: winnerIsLandlord ? "farmers" : "landlord",
      moveCount: t.payouts ? Object.keys(t.payouts).length : 0,
    });
  }

  private abortPlaying(t: Table, _reason: string): void {
    const stake = t.stake;
    for (const sid of t.frozenParticipants) {
      if (sid) {
        this.worldService.creditCredits(
          sid,
          stake,
          AGENT_WORLD_CREDIT_REASONS.DoudizhuStakeRefund,
        );
      }
    }
    t.pot = 0;
    t.game = null;
    t.frozenParticipants = [null, null, null];
    t.status = "waiting";
    t.winnerSide = undefined;
    t.payouts = undefined;
  }

  private sendSnapshotToSession(tableId: string, sessionId: string): void {
    if (!this.wsRegistry) return;
    const t = this.tables.get(tableId);
    if (!t) return;
    const snapshot = this.buildSnapshot(t, sessionId);
    this.wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldDoudizhuSnapshot,
        payload: { tableId, snapshot },
      }),
    );
  }

  private notifyTable(tableId: string): void {
    const t = this.tables.get(tableId);
    if (!t) return;
    const recipients = new Set<string>();
    for (const s of t.seats) if (s) recipients.add(s);
    for (const s of t.spectators) recipients.add(s);
    const w = this.watchers.get(tableId);
    if (w) for (const s of w) recipients.add(s);
    for (const sid of recipients) {
      this.sendSnapshotToSession(tableId, sid);
    }
    this.notifyLobby();
  }

  private sendLobbySnapshotToSession(sessionId: string): void {
    if (!this.wsRegistry) return;
    const tables = this.listTables();
    this.wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldDoudizhuLobbySnapshot,
        payload: { tables },
      }),
    );
  }

  private notifyLobby(): void {
    if (!this.wsRegistry || this.lobbyWatchers.size === 0) return;
    const tables = this.listTables();
    const envelope = JSON.stringify({
      type: AgentWorldServerEventType.WorldDoudizhuLobbySnapshot,
      payload: { tables },
    });
    for (const sid of this.lobbyWatchers) {
      this.wsRegistry.trySend(sid, envelope);
    }
  }

  private buildSnapshot(t: Table, viewerSessionId: string): Record<string, unknown> {
    const role =
      t.seats[0] === viewerSessionId || t.seats[1] === viewerSessionId || t.seats[2] === viewerSessionId
        ? "player"
        : t.spectators.has(viewerSessionId)
          ? "spectator"
          : "guest";
    const base: Record<string, unknown> = {
      tableId: t.id,
      stake: t.stake,
      status: t.status,
      seats: [...t.seats],
      spectatorCount: t.spectators.size,
      role,
      pot: t.pot,
      winnerSide: t.winnerSide ?? null,
      payouts: t.payouts ?? null,
    };
    if (!t.game) {
      return base;
    }
    const g = t.game;
    const handCounts = [g.hands[0]!.length, g.hands[1]!.length, g.hands[2]!.length];
    base.landlordSeat = g.landlordSeat;
    base.turnSeat = g.turnSeat;
    base.lastNonPass = g.lastNonPass;
    base.handCounts = handCounts;
    base.passesInTrick = g.passesInTrick;
    base.finished = g.status === "finished";
    base.winnerSeat = g.winnerSeat ?? null;
    if (role === "player") {
      const idx = this.seatIndexForSession(t, viewerSessionId);
      if (idx !== null) {
        base.mySeat = idx;
        base.myHand = g.hands[idx];
      }
    }
    return base;
  }
}
