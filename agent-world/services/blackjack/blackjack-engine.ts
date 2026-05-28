import { randomInt } from "node:crypto";

export type BjCard = string;

export type BjPhase = "player_turn" | "dealer_turn" | "finished";

export type BjOutcome = "player_win" | "dealer_win" | "push" | "player_blackjack" | "player_bust";

export type BjGame = {
  deck: BjCard[];
  playerHand: BjCard[];
  dealerHand: BjCard[];
  phase: BjPhase;
  outcome?: BjOutcome;
  stake: number;
};

function buildDeck(): BjCard[] {
  const deck: BjCard[] = [];
  for (let r = 2; r <= 14; r += 1) {
    for (let s = 0; s < 4; s += 1) {
      deck.push(`${r}-${s}`);
    }
  }
  return deck;
}

function shuffle(deck: BjCard[]): BjCard[] {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function cardRank(card: BjCard): number {
  const r = parseInt(card.split("-")[0] ?? "", 10);
  return Number.isFinite(r) ? r : 0;
}

/** 最佳点数（A 作 1 或 11）。 */
export function handScore(hand: BjCard[]): number {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    const r = cardRank(c);
    if (r === 14) {
      aces += 1;
      total += 11;
    } else if (r >= 10) {
      total += 10;
    } else {
      total += r;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

export function isBlackjack(hand: BjCard[]): boolean {
  return hand.length === 2 && handScore(hand) === 21;
}

function draw(deck: BjCard[]): BjCard {
  const c = deck.pop();
  if (!c) throw new Error("牌堆已空");
  return c;
}

export function startBlackjack(stake: number): BjGame {
  const deck = shuffle(buildDeck());
  const playerHand = [draw(deck), draw(deck)];
  const dealerHand = [draw(deck), draw(deck)];
  const g: BjGame = {
    deck,
    playerHand,
    dealerHand,
    phase: "player_turn",
    stake,
  };
  if (isBlackjack(playerHand)) {
    g.phase = "finished";
    g.outcome = isBlackjack(dealerHand) ? "push" : "player_blackjack";
  }
  return g;
}

export function playerHit(g: BjGame): BjGame {
  if (g.phase !== "player_turn") return g;
  g.playerHand.push(draw(g.deck));
  const score = handScore(g.playerHand);
  if (score > 21) {
    g.phase = "finished";
    g.outcome = "player_bust";
  }
  return g;
}

export function playerStand(g: BjGame): BjGame {
  if (g.phase !== "player_turn") return g;
  g.phase = "dealer_turn";
  while (handScore(g.dealerHand) < 17) {
    g.dealerHand.push(draw(g.deck));
  }
  g.phase = "finished";
  const ps = handScore(g.playerHand);
  const ds = handScore(g.dealerHand);
  if (ds > 21 || ps > ds) g.outcome = "player_win";
  else if (ps < ds) g.outcome = "dealer_win";
  else g.outcome = "push";
  return g;
}

export function basicStrategyHint(g: BjGame): "hit" | "stand" {
  const ps = handScore(g.playerHand);
  const ds = cardRank(g.dealerHand[0] ?? "10-0");
  const dealerUp = ds >= 10 ? 10 : ds === 14 ? 11 : ds;
  if (ps <= 11) return "hit";
  if (ps >= 17) return "stand";
  if (ps >= 13 && ps <= 16 && dealerUp <= 6) return "stand";
  return "hit";
}
