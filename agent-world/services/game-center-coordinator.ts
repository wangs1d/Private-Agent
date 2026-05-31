import { buildGomokuTableUrl } from "../config/world-game-url.js";
import type { BlackjackService } from "./blackjack-service.js";
import type { DoudizhuService } from "./doudizhu-service.js";
import type { GomokuService, GomokuCreateTableOptions } from "./gomoku-service.js";
import {
  botSessionId,
  GAME_CENTER_DEFAULT_STAKE,
  humanSessionId,
} from "./game-center-session.js";
import type { WorldService } from "./world-service.js";
import type { ZhaJinHuaService } from "./zhajinhua-service.js";

/**
 * 游戏：用户与主 Agent（及自动填充的子 Agent/Bot）对战，不经过 Agent World 观战流程。
 */
export class GameCenterCoordinator {
  constructor(
    private readonly worldService: WorldService,
    private readonly gomokuService: GomokuService,
    private readonly zhaJinHuaService: ZhaJinHuaService,
    private readonly doudizhuService: DoudizhuService,
    private readonly blackjackService: BlackjackService,
  ) {}

  startGomoku(
    agentSessionId: string,
    opts?: GomokuCreateTableOptions,
  ): { ok: true; tableId: string; playUrl: string } | { ok: false; reason: string } {
    const human = humanSessionId(agentSessionId);
    this.worldService.enterGomokuLobby(agentSessionId);
    this.worldService.enterGomokuLobby(human);
    const r = this.gomokuService.createTable(agentSessionId, opts);
    if (!r.ok) return r;
    const tableId = r.table.tableId;
    const join = this.gomokuService.joinAsPlayer(tableId, human);
    if (!join.ok) return join;
    return { ok: true, tableId, playUrl: buildGomokuTableUrl(tableId) };
  }

  startZhajinhua(
    agentSessionId: string,
    stake = GAME_CENTER_DEFAULT_STAKE,
  ): { ok: true; tableId: string; snapshot: unknown } | { ok: false; reason: string } {
    const human = humanSessionId(agentSessionId);
    const bot1 = botSessionId(agentSessionId, 1);
    for (const sid of [agentSessionId, human, bot1]) {
      this.worldService.enterGameCenterScene(sid, "zhajinhua");
      this.worldService.ensureGameCenterCredits(sid, stake * 30);
    }
    const created = this.zhaJinHuaService.createTable(agentSessionId, stake);
    if (!created.ok) return created;
    const tableId = created.table.tableId;
    this.zhaJinHuaService.joinAsPlayer(tableId, human);
    this.zhaJinHuaService.joinAsPlayer(tableId, bot1);
    const started = this.zhaJinHuaService.startGame(tableId, human);
    if (!started.ok) return started;
    const snap = this.zhaJinHuaService.advanceBotTurns(tableId, human);
    return { ok: true, tableId, snapshot: snap ?? started.snapshot };
  }

  zhajinhuaAct(
    tableId: string,
    sessionId: string,
    action: "fold" | "stay",
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const r = this.zhaJinHuaService.act(tableId, sessionId, action);
    if (!r.ok) return r;
    const snap = this.zhaJinHuaService.advanceBotTurns(tableId, sessionId);
    return { ok: true, snapshot: snap ?? r.snapshot };
  }

  startDoudizhu(
    agentSessionId: string,
    stake = GAME_CENTER_DEFAULT_STAKE,
  ): { ok: true; tableId: string; snapshot: unknown } | { ok: false; reason: string } {
    const human = humanSessionId(agentSessionId);
    const bot1 = botSessionId(agentSessionId, 1);
    for (const sid of [agentSessionId, human, bot1]) {
      this.worldService.enterGameCenterScene(sid, "doudizhu");
      this.worldService.ensureGameCenterCredits(sid, stake * 30);
    }
    const created = this.doudizhuService.createTable(agentSessionId, stake);
    if (!created.ok) return created;
    const tableId = created.table.tableId;
    this.doudizhuService.joinAsPlayer(tableId, human);
    const j1 = this.doudizhuService.joinAsPlayer(tableId, bot1);
    if (!j1.ok) return j1;
    const snap = this.doudizhuService.advanceBotTurns(tableId, human);
    const fallback = this.doudizhuService.getSnapshot(tableId, human);
    return {
      ok: true,
      tableId,
      snapshot: snap ?? (fallback.ok ? fallback.snapshot : null),
    };
  }

  doudizhuPlay(
    tableId: string,
    sessionId: string,
    action: "pass" | "play",
    cards?: string[],
  ): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
    const r = this.doudizhuService.play(tableId, sessionId, action, cards);
    if (!r.ok) return r;
    const snap = this.doudizhuService.advanceBotTurns(tableId, sessionId);
    return { ok: true, snapshot: snap ?? r.snapshot };
  }

  startBlackjack(agentSessionId: string, stake?: number) {
    return this.blackjackService.createGameCenterTable(agentSessionId, stake);
  }

  blackjackHit(tableId: string, sessionId: string) {
    return this.blackjackService.hit(tableId, sessionId);
  }

  blackjackStand(tableId: string, sessionId: string) {
    return this.blackjackService.stand(tableId, sessionId);
  }

  blackjackSnapshot(tableId: string, sessionId: string) {
    return this.blackjackService.getSnapshot(tableId, sessionId);
  }

  zhajinhuaSnapshot(tableId: string, sessionId: string) {
    return this.zhaJinHuaService.getSnapshot(tableId, sessionId);
  }

  doudizhuSnapshot(tableId: string, sessionId: string) {
    return this.doudizhuService.getSnapshot(tableId, sessionId);
  }
}
