/**
 * 斗地主简化规则引擎（单副 54 张）：出牌类型、比大小、回合与过牌重置。
 * 牌面编码：`${rank}-${suit}`，rank 3–15 为点数（11=J,12=Q,13=K,14=A,15=2），16/17 为小王/大王。
 */

export type Combo =
  | { kind: "single"; rank: number; cards: string[] }
  | { kind: "pair"; rank: number; cards: string[] }
  | { kind: "triple"; rank: number; cards: string[] }
  | { kind: "straight"; length: number; high: number; cards: string[] }
  | { kind: "bomb"; rank: number; cards: string[] }
  | { kind: "rocket"; cards: string[] };

export type RunningGame = {
  landlordSeat: 0 | 1 | 2;
  hands: [string[], string[], string[]];
  turnSeat: 0 | 1 | 2;
  /** 当前轮已出的上一手非「过」的牌型；新一轮开局时为 null，此时不可过牌。 */
  lastNonPass: Combo | null;
  /** 上一手非过牌型的座位；用于两轮过牌后夺回出牌权。 */
  lastNonPassSeat: 0 | 1 | 2 | null;
  /** 当前轮在「有上一手牌」之后连续过牌次数；达到 2 则清空轮次。 */
  passesInTrick: number;
  status: "playing" | "finished";
  winnerSeat?: 0 | 1 | 2;
};

export function cardRank(cardId: string): number {
  const head = cardId.split("-")[0] ?? "";
  return parseInt(head, 10) || 0;
}

export function buildDeck(): string[] {
  const deck: string[] = [];
  for (let r = 3; r <= 15; r++) {
    for (let s = 0; s < 4; s++) deck.push(`${r}-${s}`);
  }
  deck.push("16-0", "17-0");
  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function dealHands(): { hands: [string[], string[], string[]]; bottom: string[] } {
  const d = shuffle(buildDeck());
  const h0 = d.slice(0, 17);
  const h1 = d.slice(17, 34);
  const h2 = d.slice(34, 51);
  const bottom = d.slice(51, 54);
  return {
    hands: [sortCards(h0), sortCards(h1), sortCards(h2)],
    bottom: sortCards(bottom),
  };
}

export function sortCards(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ra = cardRank(a);
    const rb = cardRank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

function countsByRank(ids: string[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of ids) {
    const r = cardRank(id);
    m.set(r, (m.get(r) ?? 0) + 1);
  }
  return m;
}

/** 从所选牌解析牌型；非法则返回原因。 */
export function parseCombo(selected: string[]): { ok: true; combo: Combo } | { ok: false; reason: string } {
  const n = selected.length;
  if (n === 0) return { ok: false, reason: "须选择至少一张牌" };
  const ranks = selected.map(cardRank);
  const cards = sortCards(selected);

  if (n === 1) {
    return { ok: true, combo: { kind: "single", rank: ranks[0]!, cards } };
  }
  if (n === 2) {
    if (ranks.includes(16) && ranks.includes(17)) {
      return { ok: true, combo: { kind: "rocket", cards } };
    }
    if (ranks[0] === ranks[1] && ranks[0]! >= 3 && ranks[0]! <= 15) {
      return { ok: true, combo: { kind: "pair", rank: ranks[0]!, cards } };
    }
    return { ok: false, reason: "无效对子" };
  }
  if (n === 3) {
    if (ranks[0] === ranks[1] && ranks[1] === ranks[2] && ranks[0]! >= 3 && ranks[0]! <= 15) {
      return { ok: true, combo: { kind: "triple", rank: ranks[0]!, cards } };
    }
    return { ok: false, reason: "无效三张" };
  }
  if (n === 4) {
    const m = countsByRank(selected);
    if (m.size === 1) {
      const r = ranks[0]!;
      if (r >= 3 && r <= 15) return { ok: true, combo: { kind: "bomb", rank: r, cards } };
    }
    return { ok: false, reason: "无效四张" };
  }
  // 顺子：≥5 张，点数连续，不可包含 2 与王牌
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  if (uniq.length !== n) return { ok: false, reason: "顺子不能包含重复点数" };
  if (uniq[0]! < 3 || uniq[uniq.length - 1]! > 14) {
    return { ok: false, reason: "顺子只能为 3–A（不能包含 2 或王）" };
  }
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] !== uniq[i - 1]! + 1) return { ok: false, reason: "不是顺子" };
  }
  if (n < 5) return { ok: false, reason: "顺子至少 5 张" };
  return {
    ok: true,
    combo: { kind: "straight", length: n, high: uniq[uniq.length - 1]!, cards },
  };
}

export function mayPass(lastNonPass: Combo | null): boolean {
  return lastNonPass !== null;
}

export function comboBeats(tableLast: Combo | null, played: Combo): boolean {
  if (!tableLast) return true;
  if (tableLast.kind === "rocket") return false;
  if (played.kind === "rocket") return true;
  if (played.kind === "bomb" && tableLast.kind !== "bomb") return true;
  if (played.kind === "bomb" && tableLast.kind === "bomb") return played.rank > tableLast.rank;
  if (tableLast.kind === "bomb" && played.kind !== "bomb") return false;
  if (played.kind !== tableLast.kind) return false;
  switch (played.kind) {
    case "single":
      return played.rank > (tableLast as { rank: number }).rank;
    case "pair":
      return played.rank > (tableLast as { rank: number }).rank;
    case "triple":
      return played.rank > (tableLast as { rank: number }).rank;
    case "straight": {
      const t = tableLast as { length: number; high: number };
      return played.length === t.length && played.high > t.high;
    }
    default:
      return false;
  }
}

function removeFromHand(hand: string[], play: string[]): { ok: true; next: string[] } | { ok: false; reason: string } {
  const bag = new Map<string, number>();
  for (const c of hand) bag.set(c, (bag.get(c) ?? 0) + 1);
  for (const c of play) {
    const v = bag.get(c) ?? 0;
    if (v <= 0) return { ok: false, reason: "手牌中不包含所选牌" };
    bag.set(c, v - 1);
  }
  const next: string[] = [];
  for (const [c, v] of bag) {
    for (let i = 0; i < v; i++) next.push(c);
  }
  return { ok: true, next: sortCards(next) };
}

export function startRunningGame(landlordSeat: 0 | 1 | 2, hands: [string[], string[], string[]]): RunningGame {
  return {
    landlordSeat,
    hands: [sortCards(hands[0]!), sortCards(hands[1]!), sortCards(hands[2]!)],
    turnSeat: landlordSeat,
    lastNonPass: null,
    lastNonPassSeat: null,
    passesInTrick: 0,
    status: "playing",
  };
}

export function applyPass(
  g: RunningGame,
  seat: 0 | 1 | 2,
): { ok: true } | { ok: false; reason: string } {
  if (g.status !== "playing") return { ok: false, reason: "对局已结束" };
  if (seat !== g.turnSeat) return { ok: false, reason: "非你回合" };
  if (!mayPass(g.lastNonPass)) return { ok: false, reason: "新一轮须出牌，不可过" };
  g.passesInTrick += 1;
  if (g.passesInTrick >= 2) {
    const leader = g.lastNonPassSeat;
    g.lastNonPass = null;
    g.passesInTrick = 0;
    g.lastNonPassSeat = null;
    g.turnSeat = (leader ?? g.turnSeat) as 0 | 1 | 2;
  } else {
    g.turnSeat = ((seat + 1) % 3) as 0 | 1 | 2;
  }
  return { ok: true };
}

export function applyPlayCombo(
  g: RunningGame,
  seat: 0 | 1 | 2,
  combo: Combo,
  selectedIds: string[],
): { ok: true; winnerSeat?: 0 | 1 | 2 } | { ok: false; reason: string } {
  if (g.status !== "playing") return { ok: false, reason: "对局已结束" };
  if (seat !== g.turnSeat) return { ok: false, reason: "非你回合" };
  const hand = g.hands[seat]!;
  const rm = removeFromHand(hand, selectedIds);
  if (!rm.ok) return rm;
  const sortedSel = sortCards(selectedIds);
  const canon = sortCards(combo.cards);
  if (sortedSel.join(",") !== canon.join(",")) return { ok: false, reason: "出牌与牌型不一致" };
  if (!comboBeats(g.lastNonPass, combo)) return { ok: false, reason: "牌型不够大或类型不匹配" };
  g.hands[seat] = rm.next;
  g.lastNonPass = combo;
  g.lastNonPassSeat = seat;
  g.passesInTrick = 0;
  if (g.hands[seat]!.length === 0) {
    g.status = "finished";
    g.winnerSeat = seat;
    return { ok: true, winnerSeat: seat };
  }
  g.turnSeat = ((seat + 1) % 3) as 0 | 1 | 2;
  return { ok: true };
}

export function pickLandlordSeat(): 0 | 1 | 2 {
  return Math.floor(Math.random() * 3) as 0 | 1 | 2;
}
