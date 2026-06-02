import { type GomokuService, type GomokuSnapshot } from "@private-ai-agent/agent-world";

import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

const MIN_BANTER_GAP_MS = 600;

type BanterChannel = "human" | "agent";

type TableBanterState = {
  lastLineMove: number;
};

function recentBanterTexts(snap: GomokuSnapshot): string[] {
  const list = snap.banter;
  if (!Array.isArray(list)) return [];
  return list.map((line) => line.text?.trim()).filter((t): t is string => !!t);
}

export class GomokuAgentTurnService {
  private readonly inFlight = new Set<string>();
  private readonly banterInFlight = new Set<string>();
  private readonly lastBanterCheckMs = new Map<string, number>();
  private readonly tableBanterState = new Map<string, TableBanterState>();

  constructor(
    private readonly gomokuService: GomokuService,
    private readonly toolRegistry: ToolRegistry,
    private readonly externalChat: ExternalChatProvider | null,
    private readonly promptContextBuilder: PromptContextBuilder,
  ) {
    gomokuService.setAgentTurnHook((req) => this.handleAgentTurn(req));
    gomokuService.setBanterHook((req) => this.handleBanterRequest(req, "human"));
  }

  private banterState(tableId: string): TableBanterState {
    let s = this.tableBanterState.get(tableId);
    if (!s) {
      s = { lastLineMove: -1 };
      this.tableBanterState.set(tableId, s);
    }
    return s;
  }

  private handleBanterRequest(
    req: { tableId: string; agentSessionId: string },
    channel: BanterChannel,
  ): void {
    void this.fetchSnap(req.tableId, req.agentSessionId).then((snap) => {
      if (snap) this.scheduleBanter(req.tableId, req.agentSessionId, snap, channel);
    });
  }

  private async handleAgentTurn(req: { tableId: string; agentSessionId: string }): Promise<void> {
    if (this.inFlight.has(req.tableId)) return;
    this.inFlight.add(req.tableId);
    try {
      await this.runAgentTurn(req.tableId, req.agentSessionId);
    } finally {
      this.inFlight.delete(req.tableId);
    }
  }

  private async fetchSnap(tableId: string, agentSessionId: string): Promise<GomokuSnapshot | null> {
    const exec = await this.toolRegistry.execute("world.gomoku.get_snapshot", { tableId }, {
      sessionId: agentSessionId,
    });
    if (!exec.ok) return null;
    return (exec.result.snapshot as GomokuSnapshot | undefined) ?? null;
  }

  private async runAgentTurn(tableId: string, agentSessionId: string): Promise<void> {
    const snap = await this.fetchSnap(tableId, agentSessionId);
    const agentColor = snap?.agentColor ?? "black";
    if (!snap || snap.status !== "playing" || snap.currentPlayer !== agentColor) {
      return;
    }

    this.gomokuService.playHeuristicAgent(tableId);

    const after = await this.fetchSnap(tableId, agentSessionId);
    if (after) this.scheduleBanter(tableId, agentSessionId, after, "agent");
  }

  private canCheckBanterNow(tableId: string, channel: BanterChannel): boolean {
    const key = `${tableId}:${channel}`;
    const last = this.lastBanterCheckMs.get(key) ?? 0;
    return Date.now() - last >= MIN_BANTER_GAP_MS;
  }

  private scheduleBanter(
    tableId: string,
    _agentSessionId: string,
    snap: GomokuSnapshot,
    channel: BanterChannel,
  ): void {
    void this.tryEmitBanter(tableId, snap, channel).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GomokuAgentTurn] banter error (${msg})`);
    });
  }

  private async tryEmitBanter(
    tableId: string,
    snap: GomokuSnapshot,
    channel: BanterChannel,
  ): Promise<void> {
    const moves = snap.moveCount ?? 0;
    if (moves <= 0 && !snap.winner) return;
    if (!this.canCheckBanterNow(tableId, channel)) return;

    const inFlightKey = `${tableId}:${channel}`;
    if (this.banterInFlight.has(inFlightKey)) return;

    this.lastBanterCheckMs.set(`${tableId}:${channel}`, Date.now());
    this.banterInFlight.add(inFlightKey);

    try {
      void this.externalChat;
      void this.promptContextBuilder;

      const recentLines = recentBanterTexts(snap);
      const state = this.banterState(tableId);

      if (snap.winner && state.lastLineMove !== moves) {
        const line = snap.winner === (snap.agentColor ?? "black") ? "好棋，收官。" : "这局你更稳。";
        this.gomokuService.pushBanter(tableId, line);
        state.lastLineMove = moves;
        return;
      }

      if (!snap.winner && recentLines.length === 0 && state.lastLineMove !== moves && moves % 6 === 0) {
        this.gomokuService.pushBanter(tableId, "继续，下一手。");
        state.lastLineMove = moves;
      }
    } finally {
      this.banterInFlight.delete(inFlightKey);
      if (snap.winner) {
        this.tableBanterState.delete(tableId);
        this.lastBanterCheckMs.delete(`${tableId}:human`);
        this.lastBanterCheckMs.delete(`${tableId}:agent`);
      }
    }
  }
}
