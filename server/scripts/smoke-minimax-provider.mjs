import { MiniMaxProvider } from "../src/external-model/providers/minimax-provider.js";

const p = new MiniMaxProvider();
if (!p.isEnabled()) {
  console.error("FAIL: provider not enabled (MINIMAX_API_KEY missing)");
  process.exit(1);
}
console.log("id:", p.id, "| model env:", process.env.MINIMAX_MODEL);
let deltas = 0;
const full = await p.streamCompletion(
  "smoke-minimax-001",
  { text: "用一句话介绍你自己，不要思考过程", clientMessageId: "smoke-msg-1" },
  (d) => {
    deltas++;
    if (deltas <= 3) process.stdout.write(`[delta${deltas}] ${d.slice(0, 40)}\n`);
  },
  undefined,
  { ephemeralTurn: true, systemPromptOverride: "You are a helpful assistant." },
);
console.log("---");
console.log("deltas:", deltas);
console.log("visible:", full.slice(0, 160));
const leaked = full.includes("<think>");
console.log("think-tag-leak:", leaked);
process.exit(leaked || !full.trim() ? 1 : 0);
