/**
 * 任务面旅游轮 E2E 探针（2026-09-24 大理轮双修复配套）。
 *
 * 复刻事故原景：goal「我想去云南大理玩 帮我规划5天行程」经对话面路由派后台
 * 任务面执行。修复前实测双故障：
 *   1. 收尾漏剥 NEXT_UP——[NEXT_UP_START]...[NEXT_UP_END] 五行原样透出；
 *   2. travel.plan-itinerary 漏召（router-first 预召回未命中）——无行程卡。
 *
 * 断言（对 messageId=assistant-task-* 的结果 done 载荷）：
 *   A. finalText 无 NEXT_UP / RENDER_HINT / AGENT_RESULT_CARD 裸标记；
 *   B. blocks 含 cardType=travel_itinerary 的确定性行程卡（旅游 skill 真执行的反证）；
 *   C. followups 字段存在时为胶囊文案数组（不强制有，模型可能不出建议）。
 * 另打印任务记录落库检查提示（chat-threads.json 该会话不应含 NEXT_UP）。
 *
 * 用法：node scripts/e2e/task-lane-travel-e2e.mjs [goal]
 */
import WebSocket from "ws";

const ACTOR = process.env.E2E_ACTOR ?? `e2e-task-travel-${Date.now()}`;
const GOAL = process.argv[2] ?? "我想去云南大理玩 帮我规划5天行程";
const ws = new WebSocket(process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws");
const events = [];

ws.on("message", (raw) => {
  try {
    const frame = JSON.parse(raw.toString());
    events.push(frame);
    if (frame.type === "agent.location_request") {
      ws.send(JSON.stringify({
        type: "client.location_report",
        payload: { jobId: frame.payload?.jobId, latitude: 25.6065, longitude: 100.2676, city: "大理白族自治州", source: "ondemand" },
      }));
    }
    if (frame.type === "chat.task_update") {
      console.log(`[task] ${frame.payload?.state ?? "?"} ${frame.payload?.progressText ?? frame.payload?.progress ?? ""}`);
    }
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }));
await sleep(1000);
console.log(`[probe] actor=${ACTOR}`);
console.log(`[probe] goal=${GOAL}`);
ws.send(JSON.stringify({
  type: "chat.user_message",
  payload: { sessionId: ACTOR, userId: ACTOR, messageId: `probe-${Date.now()}`, text: GOAL, timestamp: new Date().toISOString() },
}));

// 断言 A 只查真正对用户可见的泄漏物：NEXT_UP 建议块与 RENDER_HINT 声明行。
// [AGENT_RESULT_CARD_START/END] 不算泄漏——它是行程卡在 finalText 里的合法
// 载体（blocks 的唯一事实源，新客户端按 blocks 渲染成卡，旧客户端解析标记成卡）。
const MARKER_RE = /\[(?:NEXT_UP_START|NEXT_UP_END|RENDER_HINT:[A-Za-z_]+)\]/;
const deadline = Date.now() + 300_000;
let done = null;
while (Date.now() < deadline) {
  await sleep(1000);
  // 结果 done = messageId 以 assistant-task- 开头（派发提示 done 是另一条消息）
  done = events.find(
    (e) => e.type === "chat.assistant_done" && String(e.payload?.messageId ?? "").startsWith("assistant-task-"),
  );
  if (done) break;
}
ws.close();

if (!done) {
  console.log("[probe] FAIL：300s 内未收到任务结果 assistant_done");
  console.log("[probe] 收到的事件类型:", [...new Set(events.map((e) => e.type))].join(", "));
  process.exit(1);
}

const p = done.payload;
const finalText = String(p.finalText ?? "");
const blocks = Array.isArray(p.blocks) ? p.blocks : [];
const travelCard = blocks.find(
  (b) => b?.type === "card" && b?.card?.cardType === "travel_itinerary",
);
const leakedMarkers = finalText.match(new RegExp(MARKER_RE, "g")) ?? [];

console.log("=== 断言结果 ===");
console.log(`A. finalText 无裸标记: ${leakedMarkers.length === 0 ? "PASS" : "FAIL " + JSON.stringify(leakedMarkers)}`);
console.log(`B. 出 travel_itinerary 行程卡: ${travelCard ? "PASS" : "FAIL"}`);
const followups = Array.isArray(p.followups) ? p.followups : [];
console.log(`C. followups 胶囊: ${followups.length > 0 ? `PASS (${followups.length} 条)` : "N/A（模型本轮未出建议）"}`);

console.log("=== finalText 尾部 400 字 ===");
console.log(finalText.slice(-400));
console.log("=== 行程卡摘要 ===");
if (travelCard) {
  const card = travelCard.card;
  console.log(`title=${card.title} keys=${Object.keys(card).join(",")}`);
} else {
  console.log("blocks cardTypes:", blocks.map((b) => b?.card?.cardType ?? b?.type).join(","));
  console.log(finalText.slice(0, 600));
}
console.log("=== followups ===");
console.log(JSON.stringify(followups));

const pass = leakedMarkers.length === 0 && Boolean(travelCard);
console.log(`[probe] ${pass ? "ALL PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
