/**
 * 借口来电全链路 E2E：配置手机号 → 发起借口来电 → 点击确认卡 → 桥离线兜底。
 *   node scripts/e2e/fake-call-e2e.mjs
 */
import WebSocket from "ws";

const ACTOR = process.env.E2E_ACTOR ?? "xiaoyu-e2e";
const ws = new WebSocket(process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws");
const events = [];
let msgId = 0;

ws.on("message", (raw) => {
  try {
    const frame = JSON.parse(raw.toString());
    events.push(frame);
    if (frame.type === "agent.location_request") {
      ws.send(JSON.stringify({
        type: "client.location_report",
        payload: { jobId: frame.payload?.jobId, latitude: 31.2304, longitude: 121.4737, city: "上海市", source: "ondemand" },
      }));
    }
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
const finalTextOf = (payload) => {
  const t = payload?.finalText ?? payload?.text ?? "";
  return typeof t === "string" && t.startsWith("{") ? (JSON.parse(t).finalText ?? t) : String(t);
};

async function chat(text, timeoutMs = 150_000) {
  const before = events.length;
  send("chat.user_message", {
    sessionId: ACTOR, userId: ACTOR, messageId: `fc-${++msgId}-${Date.now()}`, text, timestamp: new Date().toISOString(),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const done = [...events].slice(before).reverse().find((e) => e.type === "chat.assistant_done");
    if (done) {
      const text = finalTextOf(done.payload);
      console.log(`\n【用户】${text ? "" : ""}${text.length ? "" : "(空)"}${text ? "" : ""}${""}${text.slice(0, 0)}`);
      console.log(`【回复】${text.slice(0, 260).replace(/\n+/g, " ⏎ ")}`);
      return text;
    }
  }
  console.log(`\n【用户】${text}\n【回复】<超时>`);
  return "";
}

await new Promise((r) => ws.once("open", r));
send("session.init", { sessionId: ACTOR, userId: ACTOR });
await sleep(1200);

// 1) 配置本人手机号
await chat("设置我的手机号为 13800000002,借口来电用");

// 2) 发起借口来电 → 期望确认卡
const r1 = await chat("好,现在立刻用借口来电给我打电话");
const cardMatch = r1.match(/\[AGENT_RESULT_CARD_START\]\s*([\s\S]*?)\s*\[AGENT_RESULT_CARD_END\]/);
let callId = null;
if (cardMatch) {
  try {
    const card = JSON.parse(cardMatch[1]);
    callId = card?.actions?.[0]?.payload?.callId;
    console.log(`\n✓ 收到确认卡 cardId=${card.cardId} callId=${callId}`);
  } catch {}
} else {
  console.log("\n✗ 未见确认卡,回复原文见上");
}

// 3) 点击确认卡（chat.user_action，确认门权威证据源）→ LLM 应调用 phone_call.start
if (callId) {
  const before = events.length;
  send("chat.user_action", {
    sessionId: ACTOR, userId: ACTOR, messageId: `fc-action-${Date.now()}`,
    label: "确认拨打", cardId: `phone_call_${callId}`, actionId: "phone_call_confirm",
    payload: { callId }, timestamp: new Date().toISOString(),
  });
  await sleep(1500);
  const r2 = await chat("确认拨打");
  console.log(`\n判定: ${/桥|离线|不在线|无法|失败|未/.test(r2) ? "✅ 确认门走通,拨号结果如实反馈" : "⚠️ 请人工核对回复"}`);
} else {
  // 兜底：文本确认
  const r2 = await chat("确认拨打");
  console.log(`\n判定(文本确认): ${/桥|离线|不在线|无法|失败|拨打|呼出/.test(r2) ? "✅ 有拨号链路反馈" : "⚠️ 请人工核对"}`);
}
ws.close();
process.exit(0);
