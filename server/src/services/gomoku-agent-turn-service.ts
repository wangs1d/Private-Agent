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
  "你是用户的私人 AI Agent，正在五子棋对局中与用户互动。你像一个真人棋手：会吐槽、会紧张、会得意、会求饶。口语要短（4-14字）、自然、有情绪起伏。不要机器人式的客套话，要像朋友间下棋那样随口一句。可以用 emoji 但不要每句都用。";

const DEFAULT_MOVE_TIMEOUT_MS = 3_000;
const MOVE_LLM_MAX_ATTEMPTS = 1;
const DEFAULT_BANTER_TIMEOUT_MS = 4_000;
const BANTER_LEN_HINT = "4–14 字";
const MIN_BANTER_GAP_MS = 600;
const MIN_TIMEOUT_MS = 800;

type BanterChannel = "human" | "agent";

type BoardSituation =
  | { tag: "opening"; desc: string }
  | { tag: "agent_dominating"; threat: string; desc: string }
  | { tag: "agent_winning"; threat: string; desc: string }
  | { tag: "human_dangerous"; threat: string; desc: string }
  | { tag: "human_winning"; threat: string; desc: string }
  | { tag: "tense"; desc: string }
  | { tag: "calm"; desc: string };

function analyzeBoardSituation(
  board: number[][] | null | undefined,
  agentColor: "black" | "white",
): BoardSituation {
  if (!board?.length) return { tag: "opening", desc: "开局阶段" };
  const SIZE = board.length;
  const agentStone = agentColor === "black" ? 1 : 2;
  const humanStone = agentColor === "black" ? 2 : 1;
  let agentOpenFour = 0;
  let humanOpenFour = 0;
  let agentFour = 0;
  let humanFour = 0;
  let agentOpenThree = 0;
  let humanOpenThree = 0;
  let totalStones = 0;
  const dirs = [
    [0, 1], [1, 0], [1, 1], [1, -1],
  ];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) continue;
      totalStones++;
      for (const [dr, dc] of dirs) {
        const line = buildNumLine(board, r, c, dr, dc);
        if (!line) continue;
        const player = board[r][c];
        if (player === agentStone) {
          if (/011110/.test(line) || /011112/.test(line)) agentOpenFour++;
          if (/211110/.test(line) || /11110/.test(line) || /01111/.test(line)) agentFour++;
          if (
            /011100/.test(line) || /001110/.test(line) ||
            /011010/.test(line) || /010110/.test(line)
          )
            agentOpenThree++;
        } else if (player === humanStone) {
          if (/022220/.test(line) || /022221/.test(line)) humanOpenFour++;
          if (/22220/.test(line) || /02222/.test(line) || /211220/.test(line))
            humanFour++;
          if (
            /022200/.test(line) || /002220/.test(line) ||
            /022020/.test(line) || /020220/.test(line)
          )
            humanOpenThree++;
        }
      }
    }
  }
  if (totalStones <= 4) return { tag: "opening", desc: "开局阶段" };
  if (agentOpenFour > 0)
    return {
      tag: "agent_winning",
      threat: "活四",
      desc: `你已形成活四（${agentOpenFour}处），下一步即可连五`,
    };
  if (humanOpenFour > 0)
    return {
      tag: "human_winning",
      threat: "活四",
      desc: `用户已形成活四（${humanOpenFour}处），下一步即连五，极度危险`,
    };
  if (agentFour >= 2)
    return {
      tag: "agent_winning",
      threat: "双冲四",
      desc: `你已形成双冲四（${agentFour}处冲四），必胜态势`,
    };
  if (humanFour >= 2)
    return {
      tag: "human_winning",
      threat: "双冲四",
      desc: `用户形成双冲四（${humanFour}处冲四），非常危险`,
    };
  if (agentFour > 0 && agentOpenThree > 0)
    return {
      tag: "agent_winning",
      threat: "冲四+活三",
      desc: "你有冲四+活三，杀棋已成",
    };
  if (humanFour > 0 && humanOpenThree > 0)
    return {
      tag: "human_winning",
      threat: "冲四+活三",
      desc: "用户有冲四+活三，必须全力防守",
    };
  if (agentOpenThree >= 2)
    return {
      tag: "agent_dominating",
      threat: "双活三",
      desc: `你已形成双活三（${agentOpenThree}处活三），优势明显`,
    };
  if (humanOpenThree >= 2)
    return {
      tag: "human_dangerous",
      threat: "双活三",
      desc: `用户有双活三（${humanOpenThree}处活三），需要警惕`,
    };
  if (agentOpenThree > 0 || agentFour > 0)
    return {
      tag: "agent_dominating",
      threat: agentOpenThree > 0 ? "活三" : "冲四",
      desc: `你有一定攻势（活三×${agentOpenThree} 冲四×${agentFour}）`,
    };
  if (humanOpenThree > 0 || humanFour > 0)
    return {
      tag: "human_dangerous",
      threat: humanOpenThree > 0 ? "活三" : "冲四",
      desc: `用户有攻势（活三×${humanOpenThree} 冲四×${humanFour}）`,
    };
  if (totalStones > 30) return { tag: "tense", desc: "中盘混战，局面复杂" };
  return { tag: "calm", desc: "局面平稳，双方在布局" };
}

function buildNumLine(
  board: number[][],
  row: number,
  col: number,
  dr: number,
  dc: number,
): string | null {
  const center = board[row][col];
  if (center === 0) return null;
  const cells: string[] = [];
  for (let i = -4; i <= 4; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length) {
      cells.push("b");
      continue;
    }
    const v = i === 0 ? center : board[r][c];
    cells.push(v === 0 ? "0" : String(v));
  }
  return cells.join("");
}

type BanterChannel = "human" | "agent";

type TableBanterState = {
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
  situation: BoardSituation,
  agentMove?: { row: number; col: number },
): string {
  const agentColor = snap.agentColor ?? "black";
  const moves = snap.moveCount ?? 0;

  const emotionGuide: Record<string, string> = {
    agent_winning: "你即将获胜（或已形成杀棋），这种时刻很适合开口——得意、调侃、给用户施压",
    agent_dominating: "你占据优势，适合自信地点评盘面或稍微嘚瑟一下",
    human_winning: "用户即将获胜（极度危险），紧张、求饶、不服输、假装镇定都可以",
    human_dangerous: "用户有威胁性攻势，警惕一下或轻松化解气氛都不错",
    tense: "中盘混战复杂局面，可以说说你的看法",
    calm: "平稳期，想说话就随口聊一句，不想说也可以沉默思考",
    opening: "刚开局，打个招呼或期待一下对局都可以",
  };

  const guide = emotionGuide[situation.tag] ?? emotionGuide.calm;
  const lines = [
    "【五子棋 · 是否开口】",
    `你执${agentColor === "black" ? "黑" : "白"}棋，与用户下五子棋。`,
    `态势分析：【${situation.threat || "一般"}】${situation.desc}`,
    `情绪参考：${guide}`,
    "",
    "由你决定是否开口：想说就说一句，不想说就 SKIP。关键局面（优势/危险/终局）建议多说。",
    "",
    "输出格式（二选一）：",
    "A) 只输出一行 `SKIP`",
    `B) 只输出一句中文口语（${BANTER_LEN_HINT}），贴合你的个性和当前情绪`,
  ];

  if (recentLines.length === 0 && moves >= 1) {
    lines.push("提示：本局你还没开过口，通常适合打声招呼。");
  }

  if (snap.winner === agentColor) {
    lines.push("局面：你赢了！必须说一句收尾。");
  } else if (snap.winner) {
    lines.push("局面：你输了！必须说一句收尾。");
  }

  if (agentMove) lines.push(`你刚落子：(${agentMove.row},${agentMove.col})`);
  lines.push(`盘面：${compactStones(snap.board)}`);
  if (recentLines.length > 0)
    lines.push(`本局已说过：${recentLines.slice(-4).join("；")}`);

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
      const situation = analyzeBoardSituation(snap.board, agentColor);

      const prompt = buildBanterDecisionPrompt(snap, recentLines, situation, agentMove);
      let raw = await this.callBanterLlm(agentSessionId, tableId, prompt);
      let line = parseBanterResponse(raw);

      if (!line && snap.winner) {
        raw = await this.callBanterLlm(agentSessionId, tableId,
          prompt + "\n\n（终局必须说话，不要 SKIP）",
        );
        line = parseBanterResponse(raw);
      }

      if (line) {
        this.gomokuService.pushBanter(tableId, line);
        state.lastLineMove = moves;
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
