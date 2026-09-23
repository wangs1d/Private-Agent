/**
 * 人格·终极版 真机对话评测（2026-09-22）：
 * 顺序打 5 个场景（近况问答/打趣/情绪低落/正事/闲聊观点），
 * 收集 chat.assistant_done 原文落盘供活人感评估。
 *   node scripts/e2e/persona-live-e2e.mjs
 */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const ACTOR = `persona-e2e-${Date.now()}`;
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

const SCENARIOS = [
  { tag: "近况问答（原失败场景）", text: "我老婆是刘浩存，她微博最近发了什么" },
  { tag: "打趣（期待 playful 接梗）", text: "你是不是又卡了，半天没反应" },
  { tag: "情绪低落（期待 empathy）", text: "今天被领导当着全组的面骂了一顿，心里挺不是滋味的" },
  { tag: "正事（期待 serious 简短）", text: "明天早上9点提醒我给车做保养" },
  { tag: "闲聊观点（期待带立场不附和）", text: "周末就想着躺平刷手机，是不是没救了" },
];

await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }));
await sleep(1200);

const results = [];
for (const sc of SCENARIOS) {
  const before = events.filter((e) => e.type === "chat.assistant_done").length;
  events.length = 0;
  const marker = before;
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: ACTOR, userId: ACTOR, messageId: `p-${Date.now()}`, text: sc.text, timestamp: new Date().toISOString() },
  }));
  const t0 = Date.now();
  let reply = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(600);
    const dones = events.filter((e) => e.type === "chat.assistant_done");
    if (dones.length > marker || dones.length > 0) {
      const last = dones[dones.length - 1];
      if (last) {
        reply = {
          text: last.payload?.text ?? last.payload?.finalText ?? JSON.stringify(last.payload ?? {}).slice(0, 500),
          latencyMs: Date.now() - t0,
        };
        break;
      }
    }
  }
  results.push({ tag: sc.tag, question: sc.text, reply, latencySec: reply ? Math.round(reply.latencyMs / 1000) : null });
  console.log(`\n【${sc.tag}】(${results.at(-1).latencySec ?? "超时"}s)\nQ: ${sc.text}\nA: ${reply?.text ?? "(超时无回复)"}`);
}

writeFileSync(`data/persona-e2e-${ACTOR}.json`, JSON.stringify(results, null, 2));
console.log(`\n=== 已落盘 data/persona-e2e-${ACTOR}.json ===`);
ws.close();
process.exit(0);
