/**
 * 炸金花：52 张牌、每人 3 张。牌面 id 为 `rank-suit`（2–14，A=14，花色 0–3）。
 * 牌型：豹子 > 同花顺 > 同花 > 顺子 > 对子 > 高牌。顺子中 A-2-3 为最小顺，Q-K-A 为最大顺（不含「235 克豹子」等地方规则）。
 */
import { randomInt } from "node:crypto";

const RANK_MIN = 2;
const RANK_MAX = 14;

export type ZjhHandType = "baozi" | "tonghuashun" | "tonghua" | "shunzi" | "duizi" | "sanpai";

export type ZjhHandEval = {
  type: ZjhHandType;
  /** 自大到小，用于展示或调试 */
  labelZh: string;
  /** 牌型高者优先；同型再比后续元素（越大越好） */
  sortKey: number[];
};

function parseCard(id: string): { r: number; s: number } {
  const [a, b] = id.split("-");
  const r = parseInt(a ?? "", 10);
  const s = parseInt(b ?? "", 10);
  if (!Number.isFinite(r) || !Number.isFinite(s)) {
    return { r: 0, s: 0 };
  }
  return { r, s };
}

/** 花色用于平分时的次序：大者优先（黑>红>梅>方，对应 suit 0..3 自定义映射） */
const SUIT_ORDER: readonly number[] = [3, 2, 1, 0];

function suitStrength(s: number): number {
  const idx = SUIT_ORDER.indexOf(s);
  return idx < 0 ? 0 : idx;
}

function sortRanksDesc(r0: number, r1: number, r2: number): [number, number, number] {
  const a = [r0, r1, r2].sort((x, y) => y - x);
  return [a[0]!, a[1]!, a[2]!];
}

const ALL_STRAIGHTS_ASC: ReadonlyArray<readonly [number, number, number]> = [
  [2, 3, 14],
  [2, 3, 4],
  [3, 4, 5],
  [4, 5, 6],
  [5, 6, 7],
  [6, 7, 8],
  [7, 8, 9],
  [8, 9, 10],
  [9, 10, 11],
  [10, 11, 12],
  [11, 12, 13],
  [12, 13, 14],
];

/**
 * 将升序排列的三张映射为顺子阶 0..11。0=A-2-3，11=Q-K-A。
 */
function straightIndexFromRanks(asc2: [number, number, number]): number {
  return ALL_STRAIGHTS_ASC.findIndex(
    (t) => t[0] === asc2[0] && t[1] === asc2[1] && t[2] === asc2[2],
  );
}

function isFlush(s0: number, s1: number, s2: number): boolean {
  return s0 === s1 && s1 === s2;
}

function isBaozi(r0: number, r1: number, r2: number): boolean {
  return r0 === r1 && r1 === r2;
}

function isDuizi(r0: number, r1: number, r2: number): boolean {
  return r0 === r1 || r1 === r2 || r0 === r2;
}

function typePriority(t: ZjhHandType): number {
  switch (t) {
    case "baozi":
      return 5;
    case "tonghuashun":
      return 4;
    case "tonghua":
      return 3;
    case "shunzi":
      return 2;
    case "duizi":
      return 1;
    default:
      return 0;
  }
}

const TYPE_LABEL: Record<ZjhHandType, string> = {
  baozi: "豹子",
  tonghuashun: "同花顺",
  tonghua: "同花",
  shunzi: "顺子",
  duizi: "对子",
  sanpai: "散牌",
};

export function evaluateHand(cards: string[]): ZjhHandEval {
  if (cards.length !== 3) {
    return { type: "sanpai", labelZh: "无效", sortKey: [0] };
  }
  const p = cards.map(parseCard);
  const r0 = p[0]!.r;
  const r1 = p[1]!.r;
  const r2 = p[2]!.r;
  const s0 = p[0]!.s;
  const s1 = p[1]!.s;
  const s2 = p[2]!.s;
  const [d0, d1, d2] = sortRanksDesc(r0, r1, r2);
  const asc = [r0, r1, r2].sort((a, b) => a - b) as [number, number, number];
  const flush = isFlush(s0, s1, s2);
  const bz = isBaozi(r0, r1, r2);
  const si = straightIndexFromRanks(asc);

  if (bz) {
    return {
      type: "baozi",
      labelZh: `${TYPE_LABEL.baozi} ${d0}`,
      sortKey: [typePriority("baozi"), d0],
    };
  }
  if (flush && si >= 0) {
    return {
      type: "tonghuashun",
      labelZh: `${TYPE_LABEL.tonghuashun}`,
      sortKey: [typePriority("tonghuashun"), si],
    };
  }
  if (flush) {
    return {
      type: "tonghua",
      labelZh: `${TYPE_LABEL.tonghua} ${d0}/${d1}/${d2}`,
      sortKey: [typePriority("tonghua"), d0, d1, d2, ...[s0, s1, s2].map(suitStrength)],
    };
  }
  if (si >= 0) {
    return {
      type: "shunzi",
      labelZh: `${TYPE_LABEL.shunzi}`,
      sortKey: [typePriority("shunzi"), si],
    };
  }
  if (isDuizi(r0, r1, r2)) {
    let pair = 0;
    let kicker = 0;
    if (r0 === r1) {
      pair = r0;
      kicker = r2;
    } else if (r1 === r2) {
      pair = r1;
      kicker = r0;
    } else {
      pair = r0;
      kicker = r1;
    }
    return {
      type: "duizi",
      labelZh: `${TYPE_LABEL.duizi} ${pair}带${kicker}`,
      sortKey: [typePriority("duizi"), pair, kicker],
    };
  }
  // 高牌：比点自大到小，再比最大牌花色
  const su = [...p].sort((a, b) => b.r - a.r || suitStrength(b.s) - suitStrength(a.s));
  return {
    type: "sanpai",
    labelZh: `${TYPE_LABEL.sanpai} ${d0} ${d1} ${d2}`,
    sortKey: [
      typePriority("sanpai"),
      d0,
      d1,
      d2,
      suitStrength(su[0]!.s),
      suitStrength(su[1]!.s),
      suitStrength(su[2]!.s),
    ],
  };
}

export function compareHandSortKeys(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 返回真则 a 优于 b（a 更可能赢，平分返回 false）
 */
export function handBeatsOrTie(a: ZjhHandEval, b: ZjhHandEval): 1 | 0 | -1 {
  const c = compareHandSortKeys(a.sortKey, b.sortKey);
  if (c > 0) return 1;
  if (c < 0) return -1;
  return 0;
}

function buildDeck(): string[] {
  const d: string[] = [];
  for (let s = 0; s < 4; s += 1) {
    for (let r = RANK_MIN; r <= RANK_MAX; r += 1) {
      d.push(`${r}-${s}`);
    }
  }
  return d;
}

export function shuffledDeck(): string[] {
  const deck = buildDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const t = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = t;
  }
  return deck;
}

export function dealThreeFromDeck(
  deck: string[],
  n: number,
): { hands: string[][]; rest: string[] } {
  const need = n * 3;
  if (deck.length < need) {
    return { hands: [], rest: deck };
  }
  const hands: string[][] = [];
  for (let i = 0; i < n; i += 1) {
    hands.push(deck.slice(i * 3, i * 3 + 3));
  }
  return { hands, rest: deck.slice(need) };
}

export { RANK_MAX, RANK_MIN };
