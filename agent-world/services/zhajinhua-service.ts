import { randomBytes } from "node:crypto";

import type { WsConnectionRegistryLike } from "../host-types.js";
import { AgentWorldServerEventType } from "../protocol-world.js";
import { AGENT_WORLD_CREDIT_REASONS, type WorldService } from "./world-service.js";
import {
  dealThreeFromDeck,
  evaluateHand,
  handBeatsOrTie,
  shuffledDeck,
  type ZjhHandEval,
} from "./zhajinhua/zhajinhua-engine.js";
import { getStateEventManager } from "../deps/state/index.js";
import { pickZjhBotAction } from "./game-center-bot.js";
import { isHumanGameSession } from "./game-center-session.js";

const MAX_BOT_TURN_STEPS = 48;

export const ZJH_MIN_PLAYERS = 3;
export const ZJH_MAX_SEATS = 6;

export type ZjhTableStatus = "waiting" | "playing" | "finished";

export type ZjhTableSummary = {
  tableId: string;
  stake: number;
  status: ZjhTableStatus;
  playerCount: number;
  spectatorCount: number;
  /** 6 个座位，null 为空位 */
  seats: (string | null)[];
};

type Table = {
  id: string;
  stake: number;
  createdBy: string;
  seats: (string | null)[];
  spectators: Set<string>;
  status: ZjhTableStatus;
  /** 本局已扣底注的会话（含座位顺序，用于流局退款） */
  antePayers: string[] | null;
  pot: number;
  /** 每人 3 张；仅选手可见自己的牌 */
  hands: (string[] | null)[] | null;
  inHand: boolean[] | null;
  /** 本圈尚未选择「看牌跟注/闷」的座位（有罚则回合制简化：每人必须 fold 或 stay） */
  pendingSeats: Set<number> | null;
  /** 当前轮到行动的座位 0-5，仅 playing */
  turnSeat: number | null;
  payouts?: Record<string, number>;
  winnerSeats?: number[];
};

function newTableId(): string {
  return `zjh_${randomBytes(6).toString("hex")}`;
}

function countPlayers(seats: (string | null)[]): number {
  return seats.filter(Boolean).length;
}

function nonEmptySeatsInOrder(seats: (string | null)[]): number[] {
  const o: number[] = [];
  for (let i = 0; i < seats.length; i += 1) {
    if (seats[i]) o.push(i);
  }
  return o;
}

function nextPendingAfter(turn: number, pending: Set<number>): number {
  for (let step = 1; step <= ZJH_MAX_SEATS; step += 1) {
    const s = (turn + step) % ZJH_MAX_SEATS;
    if (pending.has(s)) return s;
  }
  return turn;
}

export class ZhaJinHuaService {
  private readonly tables = new Map<string, Table>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly lobbyWatchers = new Set<string>();
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  /** 炸金花工具入口：侧栏「游戏」tab，无需 Agent World 注册。 */
  assertAgentWorldEntry(sessionId: string): void {
    this.worldService.enterGameCenterScene(sessionId, "zhajinhua");
  }

  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

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
    this.worldService.enterGameCenterScene(sessionId, "zhajinhua");
    this.lobbyWatchers.add(sessionId);
    this.sendLobbySnapshotToSession(sessionId);
  }

  unwatchLobby(sessionId: string): void {
    this.lobbyWatchers.delete(sessionId);
  }

  listTables(): ZjhTableSummary[] {
    return [...this.tables.values()].map((t) => this.summarize(t));
  }

  visitHall(sessionId: string): void {
    this.worldService.enterGameCenterScene(sessionId, "zhajinhua");
  }

  createTable(
    sessionId: string,
    stake: number,
  ): { ok: true; table: ZjhTableSummary } | { ok: false; reason: string } {
    if (!Number.isFinite(stake) || stake < 1 || stake > 2000) {
      return { ok: false, reason: "底注/盲注须在 1–2000 之间" };
    }
    this.worldService.enterGameCenterScene(sessionId, "zhajinhua");
    this.worldService.ensureGameCenterCredits(sessionId, stake * 30);
    const id = newTableId();
    const t: Table = {
      id,
      stake: Math.floor(stake),
      createdBy: sessionId,
      seats: [sessionId, null, null, null, null, null],
      spectators: new Set(),
      status: "waiting",
      antePayers: null,
      pot: 0,
      hands: null,
      inHand: null,
      pendingSeats: null,
      turnSeat: null,
    };
    this.tables.set(id, t);
    this.notifyLobby();
    return { ok: true, table: this.summarize(t) };
  }

  joinAsPlayer(
    tableId: string,
    sessionId: string,
  ): { ok: true; table: ZjhTableSummary } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "waiting") return { ok: false, reason: "对局已开始或已结束" };
    this.worldService.visitZhaJinHua(sessionId);
    t.spectators.delete(sessionId);
    if (t.seats.includes(sessionId)) {
      return { ok: true, table: this.summarize(t) };
    }
    const idx = t.seats.findIndex((s) => s === null);
    if (idx < 0) return { ok: false, reason: "座位已满（最多6人）" };
    t.seats[idx] = sessionId;
    this.notifyTable(tableId);
    return { ok: true, table: this.summarize(t) };
  }

  joinSpectator(
    tableId: string,
    sessionId: string,
  ): { ok: true; table: ZjhTableSummary } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    this.worldService.visitZhaJinHua(sessionId);
    if (t.seats.includes(sessionId)) {
      return { ok: false, reason: "你已在选手席" };
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
      for (let i = 0; i < ZJH_MAX_SEATS; i += 1) {
        if (t.seats[i] === sessionId) t.seats[i] = null;
      }
      if (!t.seats.some(Boolean) && t.spectators.size === 0) {
        this.watchers.delete(t.id);
        this.tables.delete(t.id);
        removedTable = true;
      }
    } else if (t.status === "waiting") {
      for (let i = 0; i < ZJH_MAX_SEATS; i += 1) {
        if (t.seats[i] === sessionId) t.seats[i] = null;
      }
    } else if (t.status === "playing") {
      this.abortPlaying(t, "玩家离场，本局作废");
    }
    if (!removedTable) this.notifyTable(tableId);
    else this.notifyLobby();
    return { ok: true };
  }

  /**
   * 开局：须 3–6 人；每人扣等底注 `stake` 入池，发 3 张牌；一轮内每人可弃牌或跟住，全部跟住后比牌。
   */
  startGame(
    tableId: string,
    sessionId: string,
    expectedRevision?: number,
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string; message?: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "waiting") return { ok: false, reason: "本桌不在等待开局状态" };
    const order = nonEmptySeatsInOrder(t.seats);
    const n = order.length;
    if (n < ZJH_MIN_PLAYERS) {
      return { ok: false, reason: `开局至少需要 ${ZJH_MIN_PLAYERS} 名选手` };
    }
    if (n > ZJH_MAX_SEATS) {
      return { ok: false, reason: `超过 ${ZJH_MAX_SEATS} 人` };
    }
    if (!t.seats.includes(sessionId)) {
      return { ok: false, reason: "仅选手席可发起开局" };
    }
    try {
      this.worldService.assertRevisionIfProvided(sessionId, expectedRevision);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("WORLD_REVISION_CONFLICT")) {
        return { ok: false, reason: "WORLD_REVISION_CONFLICT", message: msg };
      }
      throw e;
    }
    const stake = t.stake;
    const sids: string[] = order.map((i) => t.seats[i]!);
    for (const sid of sids) {
      if (!this.worldService.tryDebitCredits(sid, stake)) {
        for (const prev of sids) {
          if (prev === sid) break;
          this.worldService.creditCredits(
            prev,
            stake,
            AGENT_WORLD_CREDIT_REASONS.ZhajinhuaStakeRefund,
          );
        }
        return { ok: false, reason: `会话点数不足，无法支付底注（需 ${stake}）` };
      }
    }
    t.antePayers = [...sids];
    t.pot = stake * n;
    const deck = shuffledDeck();
    const { hands } = dealThreeFromDeck(deck, n);
    if (hands.length !== n) {
      for (const sid of sids) {
        this.worldService.creditCredits(sid, stake, AGENT_WORLD_CREDIT_REASONS.ZhajinhuaStakeRefund);
      }
      t.antePayers = null;
      t.pot = 0;
      return { ok: false, reason: "牌组异常，请重试" };
    }
    const h: (string[] | null)[] = new Array(ZJH_MAX_SEATS).fill(null);
    const alive: boolean[] = new Array(ZJH_MAX_SEATS).fill(false);
    for (let k = 0; k < order.length; k += 1) {
      h[order[k]!] = hands[k] ?? null;
      alive[order[k]!] = true;
    }
    t.hands = h;
    t.inHand = alive;
    t.pendingSeats = new Set(order);
    t.turnSeat = Math.min(...order);
    t.status = "playing";
    this.notifyTable(tableId);
    return { ok: true, snapshot: this.buildSnapshot(t, sessionId) };
  }

  act(
    tableId: string,
    sessionId: string,
    action: "fold" | "stay",
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "playing" || !t.inHand || !t.pendingSeats || t.turnSeat === null) {
      return { ok: false, reason: "未在进行对局" };
    }
    const seat = t.seats.findIndex((s) => s === sessionId);
    if (seat < 0) return { ok: false, reason: "你不是本桌选手" };
    if (t.turnSeat !== seat) return { ok: false, reason: "尚未轮到你" };
    if (!t.inHand[seat] || !t.pendingSeats.has(seat)) {
      return { ok: false, reason: "你已弃牌或本圈已操作" };
    }
    if (action === "fold") {
      t.inHand[seat] = false;
      t.pendingSeats.delete(seat);
      const inCount = t.inHand.filter((x) => x).length;
      if (inCount === 1) {
        this.finishLastStanding(t);
      } else if (t.pendingSeats.size === 0) {
        this.finishShowdown(t);
      } else {
        t.turnSeat = nextPendingAfter(seat, t.pendingSeats);
      }
    } else {
      t.pendingSeats.delete(seat);
      if (t.pendingSeats.size === 0) {
        this.finishShowdown(t);
      } else {
        t.turnSeat = nextPendingAfter(seat, t.pendingSeats);
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
      if (!t || t.status !== "playing" || t.turnSeat === null) break;
      const seat = t.turnSeat;
      const sid = t.seats[seat];
      if (!sid || isHumanGameSession(sid)) break;
      const action = pickZjhBotAction(t, seat);
      const r = this.act(tableId, sid, action);
      if (!r.ok) break;
      if ((r.snapshot as Record<string, unknown>).status === "finished") {
        return r.snapshot;
      }
    }
    const t = this.tables.get(tableId);
    if (!t) return null;
    return this.buildSnapshot(t, viewerSessionId);
  }

  private finishLastStanding(t: Table): void {
    if (!t.inHand) return;
    const w = t.inHand.findIndex((v) => v);
    if (w < 0) return;
    this.payoutSingleWinner(t, t.seats[w]!, t.pot);
  }

  private finishShowdown(t: Table): void {
    if (!t.hands || !t.inHand) return;
    const evals: { seat: number; sid: string; ev: ZjhHandEval }[] = [];
    for (let i = 0; i < ZJH_MAX_SEATS; i += 1) {
      if (!t.inHand[i] || !t.hands[i]) continue;
      const sid = t.seats[i]!;
      const ev = evaluateHand(t.hands[i]!);
      evals.push({ seat: i, sid, ev });
    }
    if (evals.length === 0) {
      t.status = "finished";
      return;
    }
    let bestE = evals[0]!;
    for (const e of evals) {
      if (handBeatsOrTie(e.ev, bestE.ev) > 0) bestE = e;
    }
    const winners = evals.filter((e) => handBeatsOrTie(e.ev, bestE.ev) === 0);
    this.payoutWinners(t, winners.map((w) => w.sid), winners.map((w) => w.seat));
  }

  private payoutSingleWinner(t: Table, sessionId: string, pot: number): void {
    this.worldService.creditCredits(
      sessionId,
      pot,
      AGENT_WORLD_CREDIT_REASONS.ZhajinhuaGamePayout,
    );
    t.payouts = { [sessionId]: pot };
    t.winnerSeats = [t.seats.indexOf(sessionId)];
    t.antePayers = null;
    t.status = "finished";
    t.turnSeat = null;
    t.pendingSeats = null;

    getStateEventManager().emitGameFinished("zhajinhua", t.createdBy, t.createdBy, {
      winner: sessionId,
      moveCount: t.payouts ? Object.keys(t.payouts).length : 0,
    });
  }

  private payoutWinners(t: Table, sids: string[], seats: number[]): void {
    const pot = t.pot;
    const n = sids.length;
    const each = Math.floor(pot / n);
    const rem = pot - each * n;
    const order = sids
      .map((sid, i) => ({ sid, seat: seats[i]! }))
      .sort((a, b) => a.seat - b.seat);
    const pay: Record<string, number> = {};
    order.forEach((o, i) => {
      const add = each + (i < rem ? 1 : 0);
      if (add <= 0) return;
      this.worldService.creditCredits(o.sid, add, AGENT_WORLD_CREDIT_REASONS.ZhajinhuaGamePayout);
      pay[o.sid] = (pay[o.sid] ?? 0) + add;
    });
    t.payouts = pay;
    t.winnerSeats = seats;
    t.antePayers = null;
    t.status = "finished";
    t.turnSeat = null;
    t.pendingSeats = null;

    getStateEventManager().emitGameFinished("zhajinhua", t.createdBy, t.createdBy, {
      winner: sids.join(","),
      moveCount: t.payouts ? Object.keys(t.payouts).length : 0,
    });
  }

  private abortPlaying(t: Table, _reason: string): void {
    const payers = t.antePayers;
    const stake = t.stake;
    if (payers && payers.length > 0) {
      for (const sid of payers) {
        this.worldService.creditCredits(
          sid,
          stake,
          AGENT_WORLD_CREDIT_REASONS.ZhajinhuaStakeRefund,
        );
      }
    }
    t.antePayers = null;
    t.pot = 0;
    t.hands = null;
    t.inHand = null;
    t.pendingSeats = null;
    t.turnSeat = null;
    t.payouts = undefined;
    t.winnerSeats = undefined;
    t.status = "waiting";
  }

  private summarize(t: Table): ZjhTableSummary {
    return {
      tableId: t.id,
      stake: t.stake,
      status: t.status,
      playerCount: countPlayers(t.seats),
      spectatorCount: t.spectators.size,
      seats: [...t.seats],
    };
  }

  private seatForSession(t: Table, sessionId: string): number {
    return t.seats.findIndex((s) => s === sessionId);
  }

  private sendSnapshotToSession(tableId: string, sessionId: string): void {
    if (!this.wsRegistry) return;
    const t = this.tables.get(tableId);
    if (!t) return;
    const snapshot = this.buildSnapshot(t, sessionId);
    this.wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldZhajinhuaSnapshot,
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
        type: AgentWorldServerEventType.WorldZhajinhuaLobbySnapshot,
        payload: { tables },
      }),
    );
  }

  private notifyLobby(): void {
    if (!this.wsRegistry || this.lobbyWatchers.size === 0) return;
    const tables = this.listTables();
    const envelope = JSON.stringify({
      type: AgentWorldServerEventType.WorldZhajinhuaLobbySnapshot,
      payload: { tables },
    });
    for (const sid of this.lobbyWatchers) {
      this.wsRegistry.trySend(sid, envelope);
    }
  }

  private buildSnapshot(t: Table, viewerSessionId: string): Record<string, unknown> {
    const seat = this.seatForSession(t, viewerSessionId);
    const isPlayer = seat >= 0;
    const isSpect = t.spectators.has(viewerSessionId);
    const role: "player" | "spectator" | "guest" = isPlayer
      ? "player"
      : isSpect
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
      game: "zhajinhua",
      minPlayers: ZJH_MIN_PLAYERS,
      maxSeats: ZJH_MAX_SEATS,
      payouts: t.payouts ?? null,
      winnerSeats: t.winnerSeats ?? null,
      turnSeat: t.turnSeat,
    };
    if (t.status === "playing" && t.inHand && t.hands) {
      base.inHand = [...t.inHand];
      if (isPlayer) {
        base.mySeat = seat;
        base.myHand = t.hands[seat] ?? null;
        base.pendingForMe = t.pendingSeats?.has(seat) && t.turnSeat === seat;
      } else {
        const counts: number[] = [];
        for (let i = 0; i < ZJH_MAX_SEATS; i += 1) {
          const hi = t.hands[i];
          counts[i] = hi ? hi.length : 0;
        }
        base.handCardCounts = counts;
      }
    } else if (t.status === "finished" && t.hands) {
      const publicHands: (string[] | null)[] = t.hands.map((h) => (h ? [...h] : null));
      base.hands = publicHands;
    }
    return base;
  }
}
