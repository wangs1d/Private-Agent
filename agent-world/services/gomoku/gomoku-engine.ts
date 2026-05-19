/**
 * 五子棋游戏引擎
 * 15x15 标准棋盘，黑先白后，五子连珠获胜
 */

export type CellState = "empty" | "black" | "white";
export type Board = CellState[][];
export type Position = { row: number; col: number };

export type GomokuStatus = "waiting" | "playing" | "finished";
export type Winner = "black" | "white" | null;

export type GomokuGameState = {
  board: Board;
  currentPlayer: "black" | "white";
  status: GomokuStatus;
  winner: Winner;
  moveHistory: Position[];
  lastMove?: Position;
};

const BOARD_SIZE = 15;
const WIN_COUNT = 5;

/**
 * 创建空棋盘
 */
export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => "empty" as CellState),
  );
}

/**
 * 创建新游戏状态
 */
export function createNewGame(): GomokuGameState {
  return {
    board: createEmptyBoard(),
    currentPlayer: "black", // 黑棋先行
    status: "waiting",
    winner: null,
    moveHistory: [],
  };
}

/**
 * 开始游戏
 */
export function startGame(state: GomokuGameState): GomokuGameState {
  if (state.status !== "waiting") {
    throw new Error("游戏已开始或已结束");
  }
  return {
    ...state,
    status: "playing",
  };
}

/**
 * 验证落子位置是否有效
 */
export function isValidMove(board: Board, row: number, col: number): boolean {
  return (
    row >= 0 &&
    row < BOARD_SIZE &&
    col >= 0 &&
    col < BOARD_SIZE &&
    board[row][col] === "empty"
  );
}

/**
 * 执行落子
 */
export function makeMove(
  state: GomokuGameState,
  row: number,
  col: number,
): { ok: true; newState: GomokuGameState } | { ok: false; reason: string } {
  if (state.status !== "playing") {
    return { ok: false, reason: "游戏未开始或已结束" };
  }

  if (!isValidMove(state.board, row, col)) {
    return { ok: false, reason: "无效落子位置" };
  }

  const newBoard = state.board.map((r) => [...r]);
  newBoard[row][col] = state.currentPlayer;

  const newPosition: Position = { row, col };
  const newHistory = [...state.moveHistory, newPosition];

  // 检查是否获胜
  const winner = checkWinner(newBoard, row, col);

  const newState: GomokuGameState = {
    board: newBoard,
    currentPlayer: state.currentPlayer === "black" ? "white" : "black",
    status: winner ? "finished" : "playing",
    winner,
    moveHistory: newHistory,
    lastMove: newPosition,
  };

  return { ok: true, newState };
}

/**
 * 检查是否有玩家获胜（从最后落子点向四个方向检查）
 */
function checkWinner(board: Board, row: number, col: number): Winner {
  const player = board[row][col];
  if (player === "empty") return null;

  // 四个方向：横、竖、左斜、右斜
  const directions = [
    [0, 1],   // 横向
    [1, 0],   // 纵向
    [1, 1],   // 右下斜
    [1, -1],  // 左下斜
  ];

  for (const [dr, dc] of directions) {
    let count = 1; // 包含当前棋子

    // 正方向
    for (let i = 1; i < WIN_COUNT; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break;
      if (board[r][c] === player) {
        count++;
      } else {
        break;
      }
    }

    // 反方向
    for (let i = 1; i < WIN_COUNT; i++) {
      const r = row - dr * i;
      const c = col - dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break;
      if (board[r][c] === player) {
        count++;
      } else {
        break;
      }
    }

    if (count >= WIN_COUNT) {
      return player;
    }
  }

  return null;
}

/**
 * 检查棋盘是否已满（平局）
 */
export function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell !== "empty"));
}

/**
 * 获取棋盘字符串表示（用于调试）
 */
export function boardToString(board: Board): string {
  const symbols: Record<CellState, string> = {
    empty: "·",
    black: "●",
    white: "○",
  };

  let result = "   ";
  for (let c = 0; c < BOARD_SIZE; c++) {
    result += `${String(c).padStart(2, " ")} `;
  }
  result += "\n";

  for (let r = 0; r < BOARD_SIZE; r++) {
    result += `${String(r).padStart(2, " ")} `;
    for (let c = 0; c < BOARD_SIZE; c++) {
      result += `${symbols[board[r][c]]}  `;
    }
    result += "\n";
  }

  return result;
}

/**
 * 序列化棋盘为二维数组（便于 JSON 传输）
 */
export function serializeBoard(board: Board): number[][] {
  return board.map((row) =>
    row.map((cell) => {
      if (cell === "black") return 1;
      if (cell === "white") return 2;
      return 0;
    }),
  );
}

/**
 * 从二维数组反序列化棋盘
 */
export function deserializeBoard(data: number[][]): Board {
  return data.map((row) =>
    row.map((cell) => {
      if (cell === 1) return "black" as CellState;
      if (cell === 2) return "white" as CellState;
      return "empty" as CellState;
    }),
  );
}
