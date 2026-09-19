/**
 * 工具调用判别探针：验证关键词→工具注入→模型调用链路。
 *   node scripts/e2e/wellness-probe.mjs
 */
import WebSocket from "ws";

const ACTOR = process.env.E2E_ACTOR ?? "session-mvp-001";
const WS_URL = process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws";
const ws = new WebSocket(WS_URL);
const events = [];
let msgId = 0;

ws.on("message", (raw) => {
  try {
    events.push(JSON.parse(raw.toString()));
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(type, payload) {
  ws.send(JSON.stringify({ type, payload }));
}

async function chat(text) {
  const before = events.length;
  send("chat.user_message", {
    sessionId: ACTOR,
    userId: ACTOR,
    messageId: `probe-${++msgId}-${Date.now()}`,
    text,
    timestamp: new Date().toISOString(),
  });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const done = [...events]
      .slice(before)
      .reverse()
      .find((e) => e.type === "chat.assistant_done");
    if (done) {
      const p = done.payload ?? {};
      const calls = (p.toolCalls ?? []).map((t) => t?.name ?? t?.tool ?? t?.toolName ?? JSON.stringify(t).slice(0, 60));
      const finalText = (() => {
        try {
          const parsed = typeof p.text === "string" && p.text.startsWith("{") ? JSON.parse(p.text) : null;
          return parsed?.finalText ?? p.text ?? "";
        } catch {
          return p.text ?? "";
        }
      })();
      return { calls, text: String(finalText).slice(0, 180) };
    }
  }
  return { calls: ["<timeout>"], text: "" };
}

await new Promise((r) => ws.once("open", r));
send("session.init", { sessionId: ACTOR, userId: ACTOR });
await sleep(1200);

const probes = [
  "帮我记录一下,今天体重65公斤",              // 基线:health 域关键词,生产已验证的路径
  "帮我记录一下,我月经今天来了,有点痛经",      // period 域关键词(新)
  "查一下你有没有能记录生理期或安全求助方面的工具", // 显式要求查工具目录
];

for (const text of probes) {
  const r = await chat(text);
  console.log(`\n【探针】${text}`);
  console.log(`  toolCalls: ${r.calls.length > 0 ? r.calls.join(", ") : "(零调用)"}`);
  console.log(`  回复: ${r.text.replace(/\n/g, " ")}`);
}

ws.close();
process.exit(0);
