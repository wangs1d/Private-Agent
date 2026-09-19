/**
 * 单轮原始回包探针：看 assistant_done 的真实 payload 结构。
 *   E2E_TEXT="..." node scripts/e2e/raw-turn-probe.mjs
 */
import WebSocket from "ws";

const ACTOR = process.env.E2E_ACTOR ?? "xiaoyu-e2e";
const TEXT = process.env.E2E_TEXT ?? "我大姨妈来了,今天有点痛经";
const ws = new WebSocket(process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws");
const events = [];

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
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }));
await sleep(1000);
ws.send(JSON.stringify({
  type: "chat.user_message",
  payload: { sessionId: ACTOR, userId: ACTOR, messageId: `raw-${Date.now()}`, text: TEXT, timestamp: new Date().toISOString() },
}));

const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  await sleep(500);
  const done = events.find((e) => e.type === "chat.assistant_done");
  if (done) {
    console.log("=== assistant_done payload keys ===");
    console.log(Object.keys(done.payload ?? {}));
    console.log("=== raw payload (截断 3000 字) ===");
    console.log(JSON.stringify(done.payload, null, 2).slice(0, 3000));
    break;
  }
}
ws.close();
process.exit(0);
