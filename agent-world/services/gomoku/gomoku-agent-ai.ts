/**
 * 五子棋 Agent 本地启发式（不调用 LLM，毫秒级落子）。
 * 模式评分 + 浅层 minimax，用于 LLM 不可用或超时回退。
 */
import {
  isValidMove,
  makeMove,
  type Board,
  type CellState,
  type GomokuGameState,
  type Position,
} from "./gomoku-engine.js";

const BOARD_SIZE = 15;
const CENTER = 7;

const SCORE = {
  FIVE: 1_000_000,
  OPEN_FOUR: 50_000,
  FOUR: 8_000,
  OPEN_THREE: 3_000,
  THREE: 800,
  OPEN_TWO: 200,
  TWO: 50,
} as const;

const SEARCH_DEPTH = 2;
const SEARCH_TOP_K = 10;

/** 为 Agent 选择一手（指定颜色）；无合法着法时返回 null。 */
export function pickAgentMove(
  state: GomokuGameState,
  agentColor: "black" | "white",
): Position | null {
  if (state.status !== "playing" || state.currentPlayer !== agentColor) return null;

  const opp: "black" | "white" = agentColor === "black" ? "white" : "black";

  const win = findWinningMove(state, agentColor);
  if (win) return win;

  const block = findWinningMove(state, opp);
  if (block) return block;

  if (state.moveHistory.length === 0) {
    return { row: CENTER, col: CENTER };
  }

  const blockOpenFour = findBlockOpenFour(state, opp);
  if (blockOpenFour) return blockOpenFour;

  const createOpenFour = findCreateOpenFour(state, agentColor);
  if (createOpenFour) return createOpenFour;

  const candidates = candidateCells(state.board, state.lastMove);
  const scored = candidates
    .filter(({ row, col }) => isValidMove(state.board, row, col))
    .map((pos) => ({
      pos,
      score: scoreMove(state, pos.row, pos.col, agentColor, opp),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const top = scored.slice(0, SEARCH_TOP_K);
  let best = top[0].pos;
  let bestVal = -Infinity;

  for (const { pos } of top) {
    const trial = makeMove(state, pos.row, pos.col);
    if (!trial.ok) continue;
    const val = -negamax(trial.newState, SEARCH_DEPTH - 1, opp, agentColor, -Infinity, Infinity);
    if (val > bestVal) {
      bestVal = val;
      best = pos;
    }
  }

  return best;
}

/** @deprecated 使用 pickAgentMove(state, "black") */
export function pickAgentBlackMove(state: GomokuGameState): Position | null {
  return pickAgentMove(state, "black");
}

function negamax(
  state: GomokuGameState,
  depth: number,
  toMove: "black" | "white",
  agentColor: "black" | "white",
  alpha: number,
  beta: number,
): number {
  if (depth <= 0 || state.status === "finished") {
    return evaluateState(state, agentColor);
  }

  const opp = toMove === "black" ? "white" : "black";
  const win = findWinningMove(state, toMove);
  if (win) {
    const trial = makeMove({ ...state, currentPlayer: toMove }, win.row, win.col);
    if (trial.ok && trial.newState.winner === toMove) {
      return toMove === agentColor ? SCORE.FIVE : -SCORE.FIVE;
    }
  }

  const candidates = candidateCells(state.board, state.lastMove).slice(0, 8);
  let best = -Infinity;

  for (const { row, col } of candidates) {
    if (!isValidMove(state.board, row, col)) continue;
    const trial = makeMove({ ...state, currentPlayer: toMove }, row, col);
    if (!trial.ok) continue;
    const score = -negamax(trial.newState, depth - 1, opp, agentColor, -beta, -alpha);
    best = Math.max(best, score);
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }

  return best === -Infinity ? evaluateState(state, agentColor) : best;
}

function evaluateState(state: GomokuGameState, agentColor: "black" | "white"): number {
  if (state.winner === agentColor) return SCORE.FIVE;
  if (state.winner && state.winner !== agentColor) return -SCORE.FIVE;
  const opp = agentColor === "black" ? "white" : "black";
  return boardValue(state.board, agentColor) - boardValue(state.board, opp) * 0.92;
}

function boardValue(board: Board, player: "black" | "white"): number {
  let total = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] === player) {
        total += cellPatternScore(board, row, col, player) * 0.15;
      }
    }
  }
  return total;
}

function scoreMove(
  state: GomokuGameState,
  row: number,
  col: number,
  self: "black" | "white",
  opp: "black" | "white",
): number {
  const trial = makeMove(state, row, col);
  if (!trial.ok) return -Infinity;
  const b = trial.newState.board;
  let score = cellPatternScore(b, row, col, self) * 2;
  score += cellPatternScore(b, row, col, opp) * 1.2;
  score -= (Math.abs(row - CENTER) + Math.abs(col - CENTER)) * 2;
  return score;
}

function findWinningMove(state: GomokuGameState, player: "black" | "white"): Position | null {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (!isValidMove(state.board, row, col)) continue;
      const trial = makeMove({ ...state, currentPlayer: player }, row, col);
      if (trial.ok && trial.newState.winner === player) {
        return { row, col };
      }
    }
  }
  return null;
}

/** 挡对手下一手能形成的活四（冲四）。 */
function findBlockOpenFour(state: GomokuGameState, opp: "black" | "white"): Position | null {
  let best: Position | null = null;
  let bestScore = -Infinity;

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (!isValidMove(state.board, row, col)) continue;
      const trial = makeMove({ ...state, currentPlayer: opp }, row, col);
      if (!trial.ok) continue;
      const s = cellPatternScore(trial.newState.board, row, col, opp);
      if (s >= SCORE.OPEN_FOUR && s > bestScore) {
        bestScore = s;
        best = { row, col };
      }
    }
  }
  return best;
}

/** 己方一手成活四。 */
function findCreateOpenFour(state: GomokuGameState, self: "black" | "white"): Position | null {
  let best: Position | null = null;
  let bestScore = -Infinity;

  const candidates = candidateCells(state.board, state.lastMove);
  for (const { row, col } of candidates) {
    if (!isValidMove(state.board, row, col)) continue;
    const trial = makeMove({ ...state, currentPlayer: self }, row, col);
    if (!trial.ok) continue;
    const s = cellPatternScore(trial.newState.board, row, col, self);
    if (s >= SCORE.OPEN_FOUR && s > bestScore) {
      bestScore = s;
      best = { row, col };
    }
  }
  return best;
}

function cellPatternScore(
  board: Board,
  row: number,
  col: number,
  player: "black" | "white",
): number {
  const dirs: [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let total = 0;
  for (const [dr, dc] of dirs) {
    const line = buildLine(board, row, col, dr, dc, player);
    total += scoreLine(line);
  }
  return total;
}

function buildLine(
  board: Board,
  row: number,
  col: number,
  dr: number,
  dc: number,
  player: "black" | "white",
): string {
  const cells: string[] = [];
  for (let i = -4; i <= 4; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
      cells.push("b");
      continue;
    }
    const v: CellState = i === 0 ? player : board[r][c];
    cells.push(cellToChar(v, player));
  }
  return cells.join("");
}

function cellToChar(cell: CellState, player: "black" | "white"): string {
  if (cell === "empty") return "0";
  if (cell === player) return "1";
  return "2";
}

function scoreLine(line: string): number {
  const patterns: [RegExp, number][] = [
    [/11111/, SCORE.FIVE],
    [/011110/, SCORE.OPEN_FOUR],
    [/211110/, SCORE.FOUR],
    [/011112/, SCORE.FOUR],
    [/11110/, SCORE.FOUR],
    [/01111/, SCORE.FOUR],
    [/011100/, SCORE.OPEN_THREE],
    [/001110/, SCORE.OPEN_THREE],
    [/211100/, SCORE.THREE],
    [/001112/, SCORE.THREE],
    [/011010/, SCORE.OPEN_THREE],
    [/010110/, SCORE.OPEN_THREE],
    [/01100/, SCORE.OPEN_TWO],
    [/00110/, SCORE.OPEN_TWO],
    [/21100/, SCORE.TWO],
    [/00112/, SCORE.TWO],
  ];

  let score = 0;
  const variants = [line, line.split("").reverse().join("")];
  for (const s of variants) {
    for (const [re, w] of patterns) {
      if (re.test(s)) score = Math.max(score, w);
    }
  }
  return score;
}

function candidateCells(board: Board, lastMove?: Position): Position[] {
  const set = new Set<string>();
  const add = (row: number, col: number) => {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
    if (board[row][col] !== "empty") return;
    set.add(`${row},${col}`);
  };

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] === "empty") continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          add(row + dr, col + dc);
        }
      }
    }
  }

  const anchor = lastMove ?? { row: CENTER, col: CENTER };
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      add(anchor.row + dr, anchor.col + dc);
    }
  }
  for (const p of [
    { row: CENTER, col: CENTER },
    { row: 3, col: 3 },
    { row: 3, col: 11 },
    { row: 11, col: 3 },
    { row: 11, col: 11 },
  ]) {
    add(p.row, p.col);
  }

  if (set.size === 0) add(CENTER, CENTER);

  return [...set].map((k) => {
    const [row, col] = k.split(",").map(Number);
    return { row, col };
  });
}
