/**
 * 真实端到端验证脚本：向运行中的 server 发送「她最近在那」，
 * 收集流式回复与最终消息，打印给人工核对。
 * 用法: node scripts/ws-real-test.mjs "她最近在那" [sessionId]
 */
import WebSocket from "ws";

const text = process.argv[2] ?? "她最近在那";
const sessionId = process.argv[3] ?? "session-mvp-001";
const url = "ws://127.0.0.1:3000/ws";

const ws = new WebSocket(url);
let chunks = [];
let done = false;

const timer = setTimeout(() => {
  console.log("\n[TIMEOUT] 90s 未收到最终消息，已收到的增量：");
  console.log(chunks.join(""));
  process.exit(2);
}, 90_000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId, capabilities: { mediaPlayback: false } },
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId,
        messageId: `msg-realtest-${Date.now()}`,
        text,
        timestamp: new Date().toISOString(),
      },
    }));
    console.log(`[SENT] "${text}" -> ${sessionId}`);
  }, 800);
});

ws.on("message", (raw) => {
  let evt;
  try { evt = JSON.parse(raw.toString()); } catch { return; }
  const type = evt?.type ?? "";
  if (type === "chat.assistant_chunk") {
    chunks.push(String(evt.payload?.chunk ?? ""));
  } else if (type === "chat.assistant_done") {
    done = true;
    clearTimeout(timer);
    console.log("\n===== 最终回复 =====");
    console.log(String(evt.payload?.finalText ?? chunks.join("")));
    console.log("====================");
    process.exit(0);
  } else if (type === "error" || type === "error.frame" || type?.includes?.("error")) {
    console.log(`[SERVER-EVENT] ${JSON.stringify(evt).slice(0, 300)}`);
  }
});

ws.on("error", (e) => {
  console.error("[WS-ERROR]", e.message);
  process.exit(1);
});
ws.on("close", () => {
  if (!done) {
    console.log("\n[CLOSED before done] 增量：");
    console.log(chunks.join(""));
    process.exit(3);
  }
});
