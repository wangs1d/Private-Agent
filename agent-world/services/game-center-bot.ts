import { comboBeats, mayPass, parseCombo, type Combo, type RunningGame } from "./doudizhu/doudizhu-engine.js";
import { evaluateHand } from "./zhajinhua/zhajinhua-engine.js";
import { isBotGameSession } from "./game-center-session.js";

type ZjhTableLike = {
  seats: (string | null)[];
  turnSeat: number | null;
  status: string;
  hands: (string[] | null)[] | null;
  inHand: boolean[] | null;
};

export function pickZjhBotAction(t: ZjhTableLike, seat: number): "fold" | "stay" {
  const hand = t.hands?.[seat];
  if (!hand || hand.length !== 3) return "stay";
  const ev = evaluateHand(hand);
  
  const strong = ev.type === "baozi" || ev.type === "tonghuashun" || ev.type === "tonghua";
  if (strong) return "stay";
  
  if (ev.type === "shunzi") {
    return Math.random() < 0.85 ? "stay" : "fold";
  }
  
  if (ev.type === "duizi") {
    return Math.random() < 0.7 ? "stay" : "fold";
  }
  
  const highCards = hand.filter(c => {
    const r = parseInt(c.split("-")[0] ?? "0", 10);
    return r >= 12; // J, Q, K, A
  });
  
  if (highCards.length >= 1) {
    return Math.random() < 0.4 ? "stay" : "fold";
  }
  
  return Math.random() < 0.25 ? "stay" : "fold";
}

function cardRank(cardId: string): number {
  const head = cardId.split("-")[0] ?? "";
  return parseInt(head, 10) || 0;
}

function groupByRank(hand: string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const card of hand) {
    const r = cardRank(card);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(card);
  }
  return groups;
}

function findPairs(groups: Map<number, string[]>): { rank: number; cards: string[] }[] {
  const pairs: { rank: number; cards: string[] }[] = [];
  for (const [rank, cards] of groups) {
    if (cards.length >= 2) {
      pairs.push({ rank, cards: cards.slice(0, 2) });
    }
  }
  return pairs.sort((a, b) => a.rank - b.rank);
}

function findTriples(groups: Map<number, string[]>): { rank: number; cards: string[] }[] {
  const triples: { rank: number; cards: string[] }[] = [];
  for (const [rank, cards] of groups) {
    if (cards.length >= 3) {
      triples.push({ rank, cards: cards.slice(0, 3) });
    }
  }
  return triples.sort((a, b) => a.rank - b.rank);
}

function findBombs(groups: Map<number, string[]>): { rank: number; cards: string[] }[] {
  const bombs: { rank: number; cards: string[] }[] = [];
  for (const [rank, cards] of groups) {
    if (cards.length === 4 && rank >= 3 && rank <= 15) {
      bombs.push({ rank, cards });
    }
  }
  return bombs.sort((a, b) => a.rank - b.rank);
}

function findStraights(hand: string[], minLength: number = 5): string[][] {
  const ranks = [...new Set(hand.map(cardRank))].filter(r => r >= 3 && r <= 14).sort((a, b) => a - b);
  const straights: string[][] = [];
  
  for (let i = 0; i <= ranks.length - minLength; i++) {
    let j = i;
    while (j < ranks.length - 1 && ranks[j + 1]! === ranks[j]! + 1) {
      j++;
    }
    
    if (j - i + 1 >= minLength) {
      const straightRanks = ranks.slice(i, j + 1);
      const straightCards = straightRanks.map(r => {
        const card = hand.find(c => cardRank(c) === r);
        return card!;
      }).filter(Boolean);
      
      if (straightCards.length === straightRanks.length) {
        straights.push(straightCards);
      }
    }
  }
  
  return straights;
}

function findRocket(hand: string[]): string[] | null {
  const smallJoker = hand.find(c => c.startsWith("16-"));
  const bigJoker = hand.find(c => c.startsWith("17-"));
  if (smallJoker && bigJoker) {
    return [smallJoker, bigJoker];
  }
  return null;
}

function smallestSingle(hand: string[]): string[] | null {
  if (hand.length === 0) return null;
  const sorted = [...hand].sort((a, b) => cardRank(a) - cardRank(b));
  return [sorted[0]!];
}

function findBeatingSingle(hand: string[], last: Combo): string[] | null {
  const lastRank = last.kind === "single" ? last.rank : 0;
  const candidates = hand.filter((c) => cardRank(c) > lastRank);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => cardRank(a) - cardRank(b));
  return [candidates[0]!];
}

function findBeatingPair(hand: string[], last: Combo): string[] | null {
  if (last.kind !== "pair") return null;
  const groups = groupByRank(hand);
  const pairs = findPairs(groups)
    .filter(p => p.rank > last.rank);
  return pairs.length > 0 ? pairs[0].cards : null;
}

function findBeatingTriple(hand: string[], last: Combo): string[] | null {
  if (last.kind !== "triple") return null;
  const groups = groupByRank(hand);
  const triples = findTriples(groups)
    .filter(t => t.rank > last.rank);
  return triples.length > 0 ? triples[0].cards : null;
}

function findBeatingStraight(hand: string[], last: Combo): string[] | null {
  if (last.kind !== "straight") return null;
  const straights = findStraights(hand, last.length);
  const beatingStraights = straights.filter(s => {
    const maxRank = Math.max(...s.map(cardRank));
    return s.length === last.length && maxRank > (last as { high: number }).high;
  });
  return beatingStraights.length > 0 ? beatingStraights[0] : null;
}

export function pickDoudizhuBotMove(
  g: RunningGame,
  seat: 0 | 1 | 2,
): { action: "pass" } | { action: "play"; cards: string[] } {
  const hand = g.hands[seat]!;
  const groups = groupByRank(hand);
  
  if (!mayPass(g.lastNonPass)) {
    const rocket = findRocket(hand);
    if (rocket) return { action: "play", cards: rocket };
    
    const bombs = findBombs(groups);
    if (bombs.length > 0) return { action: "play", cards: bombs[0].cards };
    
    const triples = findTriples(groups);
    if (triples.length > 0) return { action: "play", cards: triples[0].cards };
    
    const pairs = findPairs(groups);
    if (pairs.length > 0) return { action: "play", cards: pairs[0].cards };
    
    const single = smallestSingle(hand);
    return single ? { action: "play", cards: single } : { action: "pass" };
  }

  const lastCombo = g.lastNonPass;
  if (!lastCombo) {
    const rocket = findRocket(hand);
    if (rocket && Math.random() < 0.8) return { action: "play", cards: rocket };
    
    const bombs = findBombs(groups);
    if (bombs.length > 0 && Math.random() < 0.6) {
      return { action: "play", cards: bombs[0].cards };
    }
    
    const triples = findTriples(groups);
    if (triples.length > 0 && Math.random() < 0.5) {
      return { action: "play", cards: triples[0].cards };
    }
    
    const pairs = findPairs(groups);
    if (pairs.length > 0 && Math.random() < 0.4) {
      return { action: "play", cards: pairs[0].cards };
    }
    
    const single = smallestSingle(hand);
    return single ? { action: "play", cards: single } : { action: "pass" };
  }

  switch (lastCombo.kind) {
    case "single": {
      const beat = findBeatingSingle(hand, lastCombo);
      if (beat && Math.random() < 0.75) {
        return { action: "play", cards: beat };
      }
      break;
    }
    case "pair": {
      const beat = findBeatingPair(hand, lastCombo);
      if (beat && Math.random() < 0.7) {
        return { action: "play", cards: beat };
      }
      break;
    }
    case "triple": {
      const beat = findBeatingTriple(hand, lastCombo);
      if (beat && Math.random() < 0.65) {
        return { action: "play", cards: beat };
      }
      break;
    }
    case "straight": {
      const beat = findBeatingStraight(hand, lastCombo);
      if (beat && Math.random() < 0.55) {
        return { action: "play", cards: beat };
      }
      break;
    }
    case "bomb": {
      const bombs = findBombs(groups).filter(b => b.rank > lastCombo.rank);
      if (bombs.length > 0 && Math.random() < 0.45) {
        return { action: "play", cards: bombs[0].cards };
      }
      break;
    }
    default:
      break;
  }

  if (Math.random() < 0.15) {
    const rocket = findRocket(hand);
    if (rocket) return { action: "play", cards: rocket };
    
    const bombs = findBombs(groups);
    if (bombs.length > 0) {
      return { action: "play", cards: bombs[0].cards };
    }
  }

  return { action: "pass" };
}

export function isBotSeatSession(sessionId: string | null | undefined): boolean {
  return sessionId != null && isBotGameSession(sessionId);
}
