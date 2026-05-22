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
import { pickAgentMove } from "./gomoku/gomoku-agent-ai.js";
import { getStateEventManager } from "../deps/state/index.js";

export type GomokuUserColorPref = "black" | "white" | "random";

export type GomokuCreateTableOptions = {
  /** 用户执子颜色；`random` 为随机（默认）。 */
  userColor?: GomokuUserColorPref;
};

function resolveUserColor(pref?: GomokuUserColorPref): "black" | "white" {
  const p = pref ?? "random";
  if (p === "black" || p === "white") return p;
  return Math.random() < 0.5 ? "black" : "white";
}

function agentColorForHuman(humanColor: "black" | "white"): "black" | "white" {
  return humanColor === "black" ? "white" : "black";
}

export type GomokuAgentTurnRequest = {
  tableId: string;
  agentSessionId: string;
};

/** 黑棋回合时由宿主注入（主 server 接 LLM Agent；未注入时可回退本地启发式）。 */
export type GomokuAgentTurnHook = (req: GomokuAgentTurnRequest) => void | Promise<void>;

/** 人类落子或局面变化后由宿主注入（口语旁白，异步、不阻塞对局）。 */
export type GomokuBanterHook = (req: GomokuAgentTurnRequest) => void | Promise<void>;

export type GomokuTableStatus = "waiting" | "playing" | "finished";

export type GomokuTableSummary = {
  tableId: string;
  status: GomokuTableStatus;
  blackPlayer: string | null;
  whitePlayer: string | null;
  spectatorCount: number;
  winner?: "black" | "white" | null;
  /** 人类选手执子颜色 */
  humanColor: "black" | "white";
  /** Agent 执子颜色 */
  agentColor: "black" | "white";
};

type Table = {
  id: string;
  createdBy: string;
  agentSessionId: string;
  humanColor: "black" | "white";
  blackPlayer: string | null;
  whitePlayer: string | null;
  spectators: Set<string>;
  status: GomokuTableStatus;
  game: GomokuGameState | null;
  /** 对局内 Agent 口语旁白（最近若干条） */
  banter: GomokuBanterLine[];
};

export type GomokuBanterLine = {
  id: string;
  text: string;
  at: string;
};

function newTableId(): string {
  return `gomoku_${randomBytes(6).toString("hex")}`;
}

export class GomokuService {
  private readonly tables = new Map<string, Table>();
  private readonly watchers = new Map<string, Set<string>>();
  private readonly lobbyWatchers = new Set<string>();
  private wsRegistry: WsConnectionRegistryLike | null = null;
  private agentTurnHook: GomokuAgentTurnHook | null = null;
  private banterHook: GomokuBanterHook | null = null;

  constructor(private readonly worldService: WorldService) {}

  /** 五子棋入口：用户与 Agent 对战，无需 Agent World 注册。 */
  assertAgentWorldEntry(sessionId: string): void {
    this.worldService.enterGomokuLobby(sessionId);
  }

  /** 绑定 WebSocket 注册表后，状态变更会向在线会话推送 `world.gomoku.snapshot`。 */
  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  /** 黑棋由对话 Agent（LLM + 工具）落子时注册；未注册则回退本地启发式（仅 standalone 等场景）。 */
  setAgentTurnHook(hook: GomokuAgentTurnHook | null): void {
    this.agentTurnHook = hook;
  }

  /** 人类落子后触发 Agent 口语旁白（由宿主 LLM 或本地回退生成）。 */
  setBanterHook(hook: GomokuBanterHook | null): void {
    this.banterHook = hook;
  }

  private requestBanter(t: Table): void {
    if (!this.banterHook) return;
    if (t.status !== "playing" && t.status !== "finished") return;
    void Promise.resolve(
      this.banterHook({ tableId: t.id, agentSessionId: t.agentSessionId }),
    ).catch((err) => {
      console.error("[GomokuService] banter hook failed:", err);
    });
  }

  private isHumanPlayer(t: Table, sessionId: string): boolean {
    const humanSlot = t.humanColor;
    return humanSlot === "black" ? t.blackPlayer === sessionId : t.whitePlayer === sessionId;
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

  /** 创建新桌；`userColor` 指定用户执子，`random` 为随机（默认）。 */
  createTable(
    sessionId: string,
    opts?: GomokuCreateTableOptions,
  ): { ok: true; table: GomokuTableSummary } | { ok: false; reason: string } {
    this.worldService.enterGomokuLobby(sessionId);
    const humanColor = resolveUserColor(opts?.userColor);
    const agentColor = agentColorForHuman(humanColor);
    const id = newTableId();
    const t: Table = {
      id,
      createdBy: sessionId,
      agentSessionId: sessionId,
      humanColor,
      blackPlayer: agentColor === "black" ? sessionId : null,
      whitePlayer: agentColor === "white" ? sessionId : null,
      spectators: new Set(),
      status: "waiting",
      game: null,
      banter: [],
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

    const humanSlot: "black" | "white" = t.humanColor;
    const occupied =
      humanSlot === "black" ? t.blackPlayer : t.whitePlayer;
    if (occupied === sessionId) {
      return { ok: true, table: this.summarize(t) };
    }
    if (occupied && occupied !== sessionId) {
      return { ok: false, reason: "选手位置已被占用" };
    }

    if (humanSlot === "black") {
      t.blackPlayer = sessionId;
    } else {
      t.whitePlayer = sessionId;
    }
    
    // 两人到齐，自动开始游戏
    if (t.blackPlayer && t.whitePlayer) {
      t.game = createNewGame();
      t.game = startGame(t.game);
      t.status = "playing";

      getStateEventManager().emit({
        module: "gomoku",
        type: "game_started",
        sessionId,
        actorSessionId: t.agentSessionId,
        previousState: "waiting",
        currentState: "playing",
        payload: { tableId, humanColor: t.humanColor, agentColor: agentColorForHuman(t.humanColor) },
      });

      this.requestAgentTurn(t);
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

      getStateEventManager().emitGameFinished("gomoku", sessionId, t.agentSessionId, {
        winner: t.game.winner ?? undefined,
        loser: t.game.winner === "black" ? "white" : t.game.winner === "white" ? "black" : undefined,
        moveCount: t.game.moveHistory.length,
        snapshot: this.createSnapshot(t, sessionId),
      });

      if (this.isHumanPlayer(t, sessionId)) {
        this.requestBanter(t);
      }
    } else {
      if (this.isHumanPlayer(t, sessionId)) {
        this.requestBanter(t);
      }
      // 用户落子后轮到 Agent——由宿主 LLM 或本地启发式应手
      this.requestAgentTurn(t);
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

    const humanColor = t.humanColor;
    const agentColor = agentColorForHuman(humanColor);

    return {
      tableId: t.id,
      status: t.status,
      role,
      blackPlayer: t.blackPlayer,
      whitePlayer: t.whitePlayer,
      humanColor,
      agentColor,
      currentPlayer: t.game?.currentPlayer ?? null,
      board,
      winner: t.game?.winner ?? null,
      moveCount: t.game?.moveHistory.length ?? 0,
      lastMove: t.game?.lastMove ?? null,
      spectatorCount: t.spectators.size,
      banter: t.banter.slice(-24),
    };
  }

  /** Agent 在对局页推送一条口语旁白（同时 WS 广播）。 */
  pushBanter(tableId: string, text: string): GomokuBanterLine | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    const trimmed = text.trim().slice(0, 120);
    if (!trimmed) return null;
    const line: GomokuBanterLine = {
      id: `b_${randomBytes(4).toString("hex")}`,
      text: trimmed,
      at: new Date().toISOString(),
    };
    t.banter.push(line);
    if (t.banter.length > 40) {
      t.banter.splice(0, t.banter.length - 40);
    }
    this.broadcastBanter(tableId, line);
    this.notifyTable(tableId);
    return line;
  }

  private broadcastBanter(tableId: string, line: GomokuBanterLine): void {
    if (!this.wsRegistry) return;
    const t = this.tables.get(tableId);
    if (!t) return;
    const message = JSON.stringify({
      type: AgentWorldServerEventType.WorldGomokuBanter,
      payload: { tableId, line },
    });
    const sessions = new Set<string>([
      t.blackPlayer,
      t.whitePlayer,
      ...t.spectators,
      ...(this.watchers.get(tableId) ?? []),
    ].filter((s): s is string => s !== null));
    // Flutter 人类选手 session 带 --human，聊天 WS 常绑定无后缀 actorId
    if (t.whitePlayer?.endsWith("--human")) {
      sessions.add(t.whitePlayer.slice(0, -"--human".length));
    }
    for (const sessionId of sessions) {
      this.wsRegistry.trySend(sessionId, message);
    }
  }

  private getPlayerRole(t: Table, sessionId: string): "black" | "white" | "spectator" | "guest" {
    if (t.blackPlayer === sessionId) return "black";
    if (t.whitePlayer === sessionId) return "white";
    if (t.spectators.has(sessionId)) return "spectator";
    return "guest";
  }

  /** 请求 Agent 落子：优先宿主 hook（LLM），否则本地启发式。 */
  private requestAgentTurn(t: Table): void {
    if (!t.game || t.status !== "playing") return;
    const agentColor = agentColorForHuman(t.humanColor);
    if (t.game.currentPlayer !== agentColor || t.game.status !== "playing") return;

    if (this.agentTurnHook) {
      void Promise.resolve(
        this.agentTurnHook({ tableId: t.id, agentSessionId: t.agentSessionId }),
      ).catch((err) => {
        console.error("[GomokuService] agent turn hook failed:", err);
      });
      return;
    }

    this.autoPlayAgent(t);
    this.notifyTable(t.id);
  }

  /** LLM 超时或失败时的 Agent 快速回退（不再次触发 agentTurnHook）。 */
  playHeuristicAgent(tableId: string): { ok: true } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t?.game || t.status !== "playing") {
      return { ok: false, reason: "游戏未进行中" };
    }
    const agentColor = agentColorForHuman(t.humanColor);
    if (t.game.currentPlayer !== agentColor) {
      return { ok: false, reason: "非 Agent 回合" };
    }
    this.autoPlayAgent(t);
    this.notifyTable(tableId);
    this.notifyLobby();
    return { ok: true };
  }

  /** @deprecated 使用 playHeuristicAgent */
  playHeuristicBlack(tableId: string): { ok: true } | { ok: false; reason: string } {
    return this.playHeuristicAgent(tableId);
  }

  /** 无 LLM 宿主时的 Agent 回退（standalone 等）。 */
  private autoPlayAgent(t: Table): void {
    if (!t.game || t.status !== "playing") return;
    const agentColor = agentColorForHuman(t.humanColor);
    if (t.game.currentPlayer !== agentColor || t.game.status !== "playing") return;

    const move = pickAgentMove(t.game, agentColor);
    if (!move) return;

    const result = makeMove(t.game, move.row, move.col);
    if (!result.ok) return;

    t.game = result.newState;
    if (t.game.status === "finished") {
      t.status = "finished";
    }
  }

  private summarize(t: Table): GomokuTableSummary {
    const humanColor = t.humanColor;
    return {
      tableId: t.id,
      status: t.status,
      blackPlayer: t.blackPlayer,
      whitePlayer: t.whitePlayer,
      spectatorCount: t.spectators.size,
      winner: t.game?.winner ?? null,
      humanColor,
      agentColor: agentColorForHuman(humanColor),
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
  /** 人类选手执子颜色 */
  humanColor: "black" | "white";
  /** Agent 执子颜色 */
  agentColor: "black" | "white";
  currentPlayer: "black" | "white" | null;
  board: number[][] | null; // 0=空, 1=黑, 2=白
  winner: "black" | "white" | null;
  moveCount: number;
  lastMove: { row: number; col: number } | null;
  spectatorCount: number;
  /** 对局内 Agent 旁白（最近若干条） */
  banter: GomokuBanterLine[];
};
