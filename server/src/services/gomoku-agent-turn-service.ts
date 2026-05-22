import {
  GOMOKU_CHAT_TOOLS,
  type GomokuBanterLine,
  type GomokuService,
  type GomokuSnapshot,
} from "@private-ai-agent/agent-world";

import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ExternalChatProvider,
} from "../external-model/types.js";

const GOMOKU_PLAY_TOOL = GOMOKU_CHAT_TOOLS.filter((t) => {
  if (t.type !== "function" || !("function" in t)) return false;
  return t.function.name === "world.gomoku.play";
});

const GOMOKU_MOVE_SYSTEM =
  "你是用户的私人 AI Agent，正在与用户进行五子棋对战。根据当前盘面选点，并立刻调用 world_gomoku_play 工具落子（row/col 0–14）；禁止输出长文、解释或推理过程。";

const GOMOKU_BANTER_SYSTEM =
  "你是用户的私人 AI Agent，正在五子棋对局中与用户互动。请保持 system 中的人设与口吻；对局口语要短、自然、像真人下棋时的随口一句。";

const DEFAULT_MOVE_TIMEOUT_MS = 5_000;
const MOVE_LLM_MAX_ATTEMPTS = 2;
const DEFAULT_BANTER_TIMEOUT_MS = 5_000;
const BANTER_LEN_HINT = "4–14 字";
const MIN_BANTER_GAP_MS = 600;
const MIN_TIMEOUT_MS = 800;

/** 连续 SKIP 后改用「必须开口」提示 */
const MAX_SKIP_STREAK_BEFORE_FORCE = 2;

type BanterChannel = "human" | "agent";

type TableBanterState = {
  skipStreak: number;
  lastLineMove: number;
};

function moveTimeoutMs(): number {
  const raw = Number(process.env.GOMOKU_TURN_TIMEOUT_MS ?? DEFAULT_MOVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= MIN_TIMEOUT_MS ? raw : DEFAULT_MOVE_TIMEOUT_MS;
}

function banterTimeoutMs(): number {
  const raw = Number(process.env.GOMOKU_BANTER_TIMEOUT_MS ?? DEFAULT_BANTER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= MIN_TIMEOUT_MS ? raw : DEFAULT_BANTER_TIMEOUT_MS;
}

function fastModelOverride(): string | undefined {
  const m = process.env.GOMOKU_FAST_MODEL?.trim();
  return m || undefined;
}

function heuristicMovesOnly(): boolean {
  const v = process.env.GOMOKU_HEURISTIC_MOVES?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function gomokuSessionId(agentSessionId: string, tableId: string): string {
  return `gomoku:${agentSessionId}:${tableId}`;
}

function compactStones(board: number[][] | null): string {
  if (!board?.length) return "空";
  const cells: string[] = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      const v = board[r][c];
      if (v === 1) cells.push(`(${r},${c},黑)`);
      else if (v === 2) cells.push(`(${r},${c},白)`);
    }
  }
  return cells.length ? cells.join(" ") : "空";
}

function recentBanterTexts(snap: GomokuSnapshot): string[] {
  const list = snap.banter;
  if (!Array.isArray(list)) return [];
  return list
    .map((line: GomokuBanterLine) => line.text?.trim())
    .filter((t): t is string => !!t);
}

function buildMovePrompt(tableId: string, snap: GomokuSnapshot): string {
  const agentColor = snap.agentColor ?? "black";
  const humanColor = snap.humanColor ?? (agentColor === "black" ? "white" : "black");
  const last = snap.lastMove;
  const lastPart =
    last != null
      ? `用户上一手${humanColor === "black" ? "黑" : "白"}棋：(${last.row},${last.col})`
      : `你先手，请落${agentColor === "black" ? "黑" : "白"}棋`;
  return [
    `【第 ${snap.moveCount + 1} 手·${agentColor === "black" ? "黑" : "白"}棋（你）】`,
    `tableId=${tableId}`,
    lastPart,
    `盘面：${compactStones(snap.board)}`,
    "立即调用 world.gomoku.play 落子。",
  ].join("\n");
}

function buildBanterDecisionPrompt(
  snap: GomokuSnapshot,
  recentLines: string[],
  agentMove?: { row: number; col: number },
  forceSpeak = false,
): string {
  const agentColor = snap.agentColor ?? "black";
  const humanColor = snap.humanColor ?? (agentColor === "black" ? "white" : "black");
  const moves = snap.moveCount ?? 0;

  if (forceSpeak || snap.winner) {
    const lines = [
      "【五子棋 · 对局口语】",
      `你执${agentColor === "black" ? "黑" : "白"}棋，正在与用户下五子棋。`,
      "此刻请说一句口语（贴合人设与局面），只输出这一句，不要 SKIP、不要解释。",
      `长度 ${BANTER_LEN_HINT}。`,
    ];
    if (snap.winner === agentColor) {
      lines.push("局面：你刚赢了，收尾调侃或友好得意。");
    } else if (snap.winner) {
      lines.push("局面：你刚输了，可自嘲、不服或友好认输。");
    } else if (recentLines.length === 0) {
      lines.push("局面：对局进行中，本局你还没说过话，适合打个招呼或点评当前盘面。");
    } else {
      lines.push(`局面：进行中，总手数 ${moves}。`);
    }
    if (agentMove) {
      lines.push(`你刚落子：(${agentMove.row},${agentMove.col})。`);
    }
    lines.push(`盘面：${compactStones(snap.board)}`);
    if (recentLines.length > 0) {
      lines.push(`本局已说过：${recentLines.slice(-3).join("；")}（避免重复）。`);
    }
    return lines.join("\n");
  }

  const lines = [
    "【五子棋 · 是否开口】",
    `你执${agentColor === "black" ? "黑" : "白"}棋，与用户下五子棋。`,
    "结合 system 中的人设：多数时候可以随口说一句（默认倾向开口）；只有当你的人设非常寡言、或刚说过极像的话、或局面平淡无事可评时，才输出 SKIP。",
    "",
    "输出格式（二选一，严格遵守）：",
    "A) 只输出一行 `SKIP`",
    `B) 只输出一句中文口语（${BANTER_LEN_HINT}），不要引号、不要换行、不要解释`,
  ];

  if (recentLines.length === 0 && moves >= 1) {
    lines.push("提示：本局你尚未开口，按普通人下棋习惯，通常适合说一句（打招呼或点评）。");
  }

  const last = snap.lastMove;
  if (last) {
    const humanStone = humanColor === "black" ? 1 : 2;
    const who =
      snap.board?.[last.row]?.[last.col] === humanStone ? "用户刚落子" : "你刚落子";
    lines.push(`局面：${who} (${last.row},${last.col})；总手数 ${moves}。`);
  } else {
    lines.push(`局面：进行中，总手数 ${moves}。`);
  }
  if (agentMove) {
    lines.push(`你上一手：(${agentMove.row},${agentMove.col})。`);
  }
  lines.push(`盘面：${compactStones(snap.board)}`);
  if (recentLines.length > 0) {
    lines.push(`本局你已说过：${recentLines.slice(-4).join("；")}`);
  }
  return lines.join("\n");
}

/** 从模型回复中提取一句口语或判定为 SKIP */
function parseBanterResponse(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  // 去掉常见包裹
  text = text.replace(/^```[\w]*\n?|\n?```$/g, "").trim();

  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const first = lines[0] ?? text;
  if (/^skip$/i.test(first) || /^skip[。.!！]?$/i.test(first)) {
    return null;
  }

  // 取最后一行非 SKIP 的短句（模型有时先解释后给句）
  let candidate = first;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/^skip$/i.test(line)) continue;
    if (line.length <= 40) {
      candidate = line;
      break;
    }
  }

  candidate = candidate
    .replace(/^["'「『【]|["'」』】]$/g, "")
    .replace(/^(?:我说|旁白|口语)[：:]\s*/u, "")
    .trim();

  if (!candidate || /^skip$/i.test(candidate)) return null;
  if (candidate.length > 48) {
    candidate = candidate.slice(0, 48);
  }
  return candidate;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 用户落子后：由 LLM Agent 调用 world.gomoku.play 应手。
 * 口语由 Agent 结合人设决定；连续沉默或终局时会温和「必须开口」。
 */
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
      s = { skipStreak: 0, lastLineMove: -1 };
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

  private moveStreamOpts(): AgentStreamOptions {
    return {
      ephemeralTurn: true,
      systemPromptOverride: GOMOKU_MOVE_SYSTEM,
      chatToolsBuiltin: GOMOKU_PLAY_TOOL,
      chatToolsExtra: [],
      toolLoop: { maxRounds: 1 },
      modelOverride: fastModelOverride(),
      disableThinking: true,
    };
  }

  private banterStreamOpts(agentSessionId: string): AgentStreamOptions {
    const base = this.promptContextBuilder.build({ actorId: agentSessionId }) ?? {};
    return {
      ...base,
      ephemeralTurn: true,
      systemPromptOverride: GOMOKU_BANTER_SYSTEM,
      chatToolsExtra: [],
      maxThreadMessages: 6,
      modelOverride: fastModelOverride(),
      disableThinking: true,
    };
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

  private async fetchSnap(
    tableId: string,
    agentSessionId: string,
  ): Promise<GomokuSnapshot | null> {
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

    const agentLlmEnabled =
      this.externalChat?.isEnabled() === true && !heuristicMovesOnly();

    if (!agentLlmEnabled) {
      if (!this.externalChat?.isEnabled()) {
        console.warn(
          "[GomokuAgentTurn] external chat disabled — heuristic fallback (configure MOONSHOT_API_KEY or OPENAI_API_KEY for Agent moves)",
        );
      }
      this.gomokuService.playHeuristicAgent(tableId);
      const after = await this.fetchSnap(tableId, agentSessionId);
      if (after) this.scheduleBanter(tableId, agentSessionId, after, "agent");
      return;
    }

    const sessionId = gomokuSessionId(agentSessionId, tableId);
    const movePrompt = buildMovePrompt(tableId, snap);
    const toolCtx: ChatToolExecutionContext = {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, { sessionId: agentSessionId }),
    };

    let moved = false;
    for (let attempt = 0; attempt < MOVE_LLM_MAX_ATTEMPTS && !moved; attempt++) {
      try {
        await withTimeout(
          this.externalChat!.streamCompletion(
            sessionId,
            { text: movePrompt },
            () => {},
            toolCtx,
            this.moveStreamOpts(),
          ),
          moveTimeoutMs(),
          "GOMOKU_MOVE_TIMEOUT",
        );
        moved = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt + 1 < MOVE_LLM_MAX_ATTEMPTS) {
          console.warn(`[GomokuAgentTurn] move LLM attempt ${attempt + 1} failed (${msg}); retrying`);
          continue;
        }
        console.warn(`[GomokuAgentTurn] move LLM failed (${msg}); heuristic fallback`);
        this.gomokuService.playHeuristicAgent(tableId);
        moved = true;
      }
    }

    if (!moved) return;

    let after = await this.fetchSnap(tableId, agentSessionId);
    const afterAgentColor = after?.agentColor ?? agentColor;
    if (after?.status === "playing" && after.currentPlayer === afterAgentColor) {
      console.warn("[GomokuAgentTurn] no agent move after LLM; heuristic fallback");
      this.gomokuService.playHeuristicAgent(tableId);
      after = await this.fetchSnap(tableId, agentSessionId);
    }

    if (after) {
      this.scheduleBanter(tableId, agentSessionId, after, "agent");
    }
  }

  private canCheckBanterNow(tableId: string, channel: BanterChannel): boolean {
    const key = `${tableId}:${channel}`;
    const last = this.lastBanterCheckMs.get(key) ?? 0;
    return Date.now() - last >= MIN_BANTER_GAP_MS;
  }

  private shouldForceSpeak(snap: GomokuSnapshot, tableId: string): boolean {
    if (snap.winner) return true;
    const recent = recentBanterTexts(snap);
    const moves = snap.moveCount ?? 0;
    const state = this.banterState(tableId);
    if (recent.length === 0 && moves >= 2) return true;
    if (state.skipStreak >= MAX_SKIP_STREAK_BEFORE_FORCE) return true;
    if (moves - state.lastLineMove >= 6 && recent.length > 0) return true;
    return false;
  }

  private scheduleBanter(
    tableId: string,
    agentSessionId: string,
    snap: GomokuSnapshot,
    channel: BanterChannel,
  ): void {
    void this.tryEmitBanter(tableId, agentSessionId, snap, channel).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GomokuAgentTurn] banter error (${msg})`);
    });
  }

  private async callBanterLlm(
    agentSessionId: string,
    tableId: string,
    prompt: string,
  ): Promise<string> {
    const sessionId = gomokuSessionId(agentSessionId, tableId);
    return withTimeout(
      this.externalChat!.streamCompletion(
        sessionId,
        { text: prompt },
        () => {},
        undefined,
        this.banterStreamOpts(agentSessionId),
      ),
      banterTimeoutMs(),
      "GOMOKU_BANTER_TIMEOUT",
    );
  }

  private async tryEmitBanter(
    tableId: string,
    agentSessionId: string,
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
      if (!this.externalChat?.isEnabled()) return;

      const agentColor = snap.agentColor ?? "black";
      const agentStone = agentColor === "black" ? 1 : 2;
      const agentMove =
        snap.lastMove &&
        snap.board?.[snap.lastMove.row]?.[snap.lastMove.col] === agentStone
          ? snap.lastMove
          : undefined;

      const recentLines = recentBanterTexts(snap);
      const state = this.banterState(tableId);
      const forceSpeak = this.shouldForceSpeak(snap, tableId);

      const prompt = buildBanterDecisionPrompt(snap, recentLines, agentMove, forceSpeak);
      let raw = await this.callBanterLlm(agentSessionId, tableId, prompt);
      let line = parseBanterResponse(raw);

      if (!line && !forceSpeak && this.shouldForceSpeak(snap, tableId)) {
        const retryPrompt = buildBanterDecisionPrompt(snap, recentLines, agentMove, true);
        raw = await this.callBanterLlm(agentSessionId, tableId, retryPrompt);
        line = parseBanterResponse(raw);
      }

      if (line) {
        this.gomokuService.pushBanter(tableId, line);
        state.skipStreak = 0;
        state.lastLineMove = moves;
      } else if (!snap.winner) {
        state.skipStreak += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GomokuAgentTurn] banter skipped (${msg})`);
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
