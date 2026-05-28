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
  if (ev.type === "duizi" || ev.type === "shunzi") return Math.random() < 0.75 ? "stay" : "fold";
  return Math.random() < 0.35 ? "stay" : "fold";
}

function smallestSingle(hand: string[]): string[] | null {
  if (hand.length === 0) return null;
  const sorted = [...hand].sort((a, b) => {
    const ra = parseInt(a.split("-")[0] ?? "0", 10);
    const rb = parseInt(b.split("-")[0] ?? "0", 10);
    return ra - rb;
  });
  return [sorted[0]!];
}

function findBeatingSingle(hand: string[], last: Combo): string[] | null {
  const lastRank = last.kind === "single" ? last.rank : 0;
  const candidates = hand.filter((c) => {
    const r = parseInt(c.split("-")[0] ?? "0", 10);
    return r > lastRank;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ra = parseInt(a.split("-")[0] ?? "0", 10);
    const rb = parseInt(b.split("-")[0] ?? "0", 10);
    return ra - rb;
  });
  return [candidates[0]!];
}

export function pickDoudizhuBotMove(
  g: RunningGame,
  seat: 0 | 1 | 2,
): { action: "pass" } | { action: "play"; cards: string[] } {
  const hand = g.hands[seat]!;
  if (!mayPass(g.lastNonPass)) {
    const cards = smallestSingle(hand);
    return cards ? { action: "play", cards } : { action: "pass" };
  }
  if (g.lastNonPass?.kind === "single") {
    const beat = findBeatingSingle(hand, g.lastNonPass);
    if (beat) {
      const parsed = parseCombo(beat);
      if (parsed.ok && comboBeats(g.lastNonPass, parsed.combo)) {
        return { action: "play", cards: beat };
      }
    }
  }
  return { action: "pass" };
}

export function isBotSeatSession(sessionId: string | null | undefined): boolean {
  return sessionId != null && isBotGameSession(sessionId);
}
