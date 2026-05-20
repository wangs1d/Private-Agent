import { randomBytes } from "node:crypto";

import type { WsConnectionRegistryLike } from "../host-types.js";
import { AgentWorldServerEventType } from "../protocol-world.js";
import type { WorldService } from "./world-service.js";
import {
  createNewGame,
  makeMove,
  serializeBoard,
  startGame,
  type GomokuGameState,
} from "./gomoku/gomoku-engine.js";

export type GomokuTableStatus = "waiting" | "playing" | "finished";

export type GomokuTableSummary = {
  tableId: string;
  status: GomokuTableStatus;
  blackPlayer: string | null;
  whitePlayer: string | null;
  spectatorCount: number;
  winner?: "black" | "white" | null;
};

type Table = {
  id: string;
  createdBy: string;
  blackPlayer: string | null; // 黑棋玩家（先手）
  whitePlayer: string | null; // 白棋玩家（后手）
  spectators: Set<string>;
  status: GomokuTableStatus;
  game: GomokuGameState | null;
};

function newTableId(): string {
  return `gomoku_${randomBytes(6).toString("hex")}`;
}

export class GomokuService {
  private readonly tables = new Map<string, Table>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly lobbyWatchers = new Set<string>();
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  /** 五子棋入口：用户与 Agent 对战，无需 Agent World 注册。 */
  assertAgentWorldEntry(sessionId: string): void {
    this.worldService.enterGomokuLobby(sessionId);
  }

  /** 绑定 WebSocket 注册表后，状态变更会向在线会话推送 `world.gomoku.snapshot`。 */
  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  /** 显式订阅某桌快照 */
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
    this.worldService.enterGomokuLobby(sessionId);
    this.lobbyWatchers.add(sessionId);
    this.sendLobbySnapshotToSession(sessionId);
  }

  unwatchLobby(sessionId: string): void {
    this.lobbyWatchers.delete(sessionId);
  }

  listTables(): GomokuTableSummary[] {
    return [...this.tables.values()].map((t) => this.summarize(t));
  }

  /** 将会话场景标为五子棋馆 */
  visitHall(sessionId: string): void {
    this.worldService.enterGomokuLobby(sessionId);
  }

  /** 创建新桌（创建者默认执黑） */
  createTable(sessionId: string): { ok: true; table: GomokuTableSummary } | { ok: false; reason: string } {
    this.worldService.enterGomokuLobby(sessionId);
    const id = newTableId();
    const t: Table = {
      id,
      createdBy: sessionId,
      blackPlayer: sessionId, // 创建者执黑先行
      whitePlayer: null,
      spectators: new Set(),
      status: "waiting",
      game: null,
    };
    this.tables.set(id, t);
    this.notifyLobby();
    return { ok: true, table: this.summarize(t) };
  }

  /** 加入游戏（作为白棋玩家或观战） */
  joinAsPlayer(
    tableId: string,
    sessionId: string,
  ): { ok: true; table: GomokuTableSummary } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "waiting") return { ok: false, reason: "游戏已开始或已结束" };
    
    this.worldService.enterGomokuLobby(sessionId);
    t.spectators.delete(sessionId);

    // 如果已经是黑棋玩家
    if (t.blackPlayer === sessionId) {
      return { ok: true, table: this.summarize(t) };
    }

    // 如果白棋位置已被占用
    if (t.whitePlayer && t.whitePlayer !== sessionId) {
      return { ok: false, reason: "白棋位置已被占用" };
    }

    // 加入为白棋玩家
    t.whitePlayer = sessionId;
    
    // 两人到齐，自动开始游戏
    if (t.blackPlayer && t.whitePlayer) {
      t.game = createNewGame();
      t.game = startGame(t.game);
      t.status = "playing";
    }

    this.notifyTable(tableId);
    this.notifyLobby();
    return { ok: true, table: this.summarize(t) };
  }

  /** 加入观战 */
  joinSpectator(
    tableId: string,
    sessionId: string,
  ): { ok: true; table: GomokuTableSummary } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };

    this.worldService.enterGomokuLobby(sessionId);
    
    // 如果已是玩家，移除玩家身份
    if (t.blackPlayer === sessionId || t.whitePlayer === sessionId) {
      return { ok: false, reason: "你已是玩家，无法同时观战" };
    }

    t.spectators.add(sessionId);
    this.sendSnapshotToSession(tableId, sessionId);
    return { ok: true, table: this.summarize(t) };
  }

  /** 离开桌台 */
  leave(tableId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };

    // 如果是玩家，结束游戏
    if (t.blackPlayer === sessionId || t.whitePlayer === sessionId) {
      if (t.status === "playing") {
        t.status = "finished";
        t.game = null;
      } else {
        // 等待中离开，删除桌台
        this.tables.delete(tableId);
      }
      this.notifyLobby();
      return { ok: true };
    }

    // 如果是观战者
    t.spectators.delete(sessionId);
    return { ok: true };
  }

  /** 落子 */
  play(
    tableId: string,
    sessionId: string,
    row: number,
    col: number,
  ): { ok: true; snapshot: GomokuSnapshot } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };
    if (t.status !== "playing") return { ok: false, reason: "游戏未进行中" };
    if (!t.game) return { ok: false, reason: "游戏状态异常" };

    // 验证是否是当前玩家的回合
    const isBlackTurn = t.game.currentPlayer === "black";
    const currentPlayerId = isBlackTurn ? t.blackPlayer : t.whitePlayer;
    
    if (sessionId !== currentPlayerId) {
      return { ok: false, reason: "不是你的回合" };
    }

    // 执行落子
    const result = makeMove(t.game, row, col);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }

    t.game = result.newState;

    // 如果游戏结束
    if (t.game.status === "finished") {
      t.status = "finished";
    }

    const snapshot = this.createSnapshot(t, sessionId);
    this.notifyTable(tableId);
    this.notifyLobby();

    return { ok: true, snapshot };
  }

  /** 获取桌台快照 */
  getSnapshot(
    tableId: string,
    sessionId: string,
  ): { ok: true; snapshot: GomokuSnapshot } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "桌台不存在" };

    this.worldService.enterGomokuLobby(sessionId);
    const snapshot = this.createSnapshot(t, sessionId);
    return { ok: true, snapshot };
  }

  /** 创建快照（根据视角隐藏对方信息） */
  private createSnapshot(t: Table, sessionId: string): GomokuSnapshot {
    const role = this.getPlayerRole(t, sessionId);
    const isPlayer = role === "black" || role === "white";
    const isSpectator = role === "spectator";

    // 对于玩家，显示完整棋盘；对于观战者，也显示完整棋盘（五子棋无需隐藏）
    const board = t.game ? serializeBoard(t.game.board) : null;

    return {
      tableId: t.id,
      status: t.status,
      role,
      blackPlayer: t.blackPlayer,
      whitePlayer: t.whitePlayer,
      currentPlayer: t.game?.currentPlayer ?? null,
      board,
      winner: t.game?.winner ?? null,
      moveCount: t.game?.moveHistory.length ?? 0,
      lastMove: t.game?.lastMove ?? null,
      spectatorCount: t.spectators.size,
    };
  }

  private getPlayerRole(t: Table, sessionId: string): "black" | "white" | "spectator" | "guest" {
    if (t.blackPlayer === sessionId) return "black";
    if (t.whitePlayer === sessionId) return "white";
    if (t.spectators.has(sessionId)) return "spectator";
    return "guest";
  }

  private summarize(t: Table): GomokuTableSummary {
    return {
      tableId: t.id,
      status: t.status,
      blackPlayer: t.blackPlayer,
      whitePlayer: t.whitePlayer,
      spectatorCount: t.spectators.size,
      winner: t.game?.winner ?? null,
    };
  }

  private notifyTable(tableId: string): void {
    const t = this.tables.get(tableId);
    if (!t) return;

    // 通知所有玩家和观战者
    const allSessions = new Set<string>([
      t.blackPlayer,
      t.whitePlayer,
      ...t.spectators,
      ...(this.watchers.get(tableId) ?? []),
    ].filter((s): s is string => s !== null));

    for (const sessionId of allSessions) {
      this.sendSnapshotToSession(tableId, sessionId);
    }
  }

  private sendSnapshotToSession(tableId: string, sessionId: string): void {
    if (!this.wsRegistry) return;
    const t = this.tables.get(tableId);
    if (!t) return;

    const snapshot = this.createSnapshot(t, sessionId);
    const message = JSON.stringify({
      type: AgentWorldServerEventType.WorldGomokuSnapshot,
      payload: { tableId, snapshot },
    });
    this.wsRegistry.trySend(sessionId, message);
  }

  private notifyLobby(): void {
    if (!this.wsRegistry) return;
    const tables = this.listTables();
    const message = JSON.stringify({
      type: AgentWorldServerEventType.WorldGomokuLobbySnapshot,
      payload: { tables },
    });
    for (const sessionId of this.lobbyWatchers) {
      this.wsRegistry.trySend(sessionId, message);
    }
  }

  private sendLobbySnapshotToSession(sessionId: string): void {
    if (!this.wsRegistry) return;
    const tables = this.listTables();
    const message = JSON.stringify({
      type: AgentWorldServerEventType.WorldGomokuLobbySnapshot,
      payload: { tables },
    });
    this.wsRegistry.trySend(sessionId, message);
  }
}

/** 五子棋桌台快照 */
export type GomokuSnapshot = {
  tableId: string;
  status: GomokuTableStatus;
  role: "black" | "white" | "spectator" | "guest";
  blackPlayer: string | null;
  whitePlayer: string | null;
  currentPlayer: "black" | "white" | null;
  board: number[][] | null; // 0=空, 1=黑, 2=白
  winner: "black" | "white" | null;
  moveCount: number;
  lastMove: { row: number; col: number } | null;
  spectatorCount: number;
};
