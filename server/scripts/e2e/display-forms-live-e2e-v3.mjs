// E2E v3：最后三个形态的针对性重试（travel/timeline/fold_list）。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";

const ROUNDS = [
  { name: "travel 行程卡(带明确日期)", text: "帮我规划去成都两天的行程，这周六早上出发，周日晚上返程，市区为主，直接出完整计划别反问" },
  { name: "timeline 时间轴卡(喂全时间点)", text: "不要联网。把我明天的时间轴列出来：07:30起床拉伸，09:00项目周会，14:00牙医复诊，19:30和老周吃饭。每条前面带时间" },
  { name: "fold_list 折叠清单(8条短行)", text: "不要联网。列出搬家要带的8样物品，每样一行，短横线开头，每行不超过15个字，不要备注不要解释" },
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectEvidence(done) {
  const finalText = String(done.finalText ?? "");
  const blocks = Array.isArray(done.blocks) ? done.blocks : [];
  const ev = new Set();
  for (const m of finalText.matchAll(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g)) {
    try { ev.add(`card:${JSON.parse(m[1].trim()).cardType || "generic"}`); } catch { ev.add("card:<parse-fail>"); }
  }
  for (const b of blocks) if (b && b.type === "card" && b.cardType) ev.add(`block:${b.cardType}`);
  for (const m of finalText.matchAll(/\[RENDER_AS:(\w+)\]/g)) ev.add(`marker:${m[1]}`);
  if (finalText.includes("CONTENT_SUMMARY_V2")) ev.add("marker:CONTENT_SUMMARY_V2");
  const mediaCount = Array.isArray(done.mediaCards) ? done.mediaCards.length : 0;
  if (mediaCount > 0) ev.add(`mediaCards:${mediaCount}`);
  return [...ev];
}

for (const round of ROUNDS) {
  const session = `e2e-forms3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.type === "chat.assistant_done") dones.push(evt.payload ?? {});
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1200));
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: session, messageId: `e2e-${Date.now()}`, text: round.text, timestamp: new Date().toISOString() },
  }));
  const start = Date.now();
  let lastNonEmptyAt = 0, sawNonEmpty = false;
  while (Date.now() - start < 160_000) {
    await new Promise((r) => setTimeout(r, 600));
    const nonEmpty = dones.find((d) => String(d.finalText ?? "").trim().length > 0);
    if (nonEmpty && !sawNonEmpty) { sawNonEmpty = true; lastNonEmptyAt = Date.now(); }
    if (sawNonEmpty && Date.now() - lastNonEmptyAt > 12_000) break;
  }
  ws.close();
  const chosen = [...dones].reverse().find((d) => String(d.finalText ?? "").trim().length > 0) ?? {};
  const evidence = collectEvidence(chosen);
  console.log(`\n### ${round.name}`);
  console.log(`    证据: [${evidence.join(", ") || "无"}]`);
  console.log(`    正文: ${String(chosen.finalText ?? "").replace(/\s+/g, " ").slice(0, 100) || "(空)"}`);
}
process.exit(0);
