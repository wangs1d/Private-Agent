// 中断场景探针：先发一条复杂消息，3 秒后再发一条短消息，观察两轮是否都能完成。
import WebSocket from "ws";

const ts0 = Date.now();
const elapsed = () => `${((Date.now() - ts0) / 1000).toFixed(1)}s`;
const ws = new WebSocket("ws://127.0.0.1:3000/ws");
let doneCount = 0;

const timer = setTimeout(() => {
  console.log(`[${elapsed()}] !! 探针超时，done 次数=${doneCount}`);
  ws.close();
  process.exit(doneCount >= 2 ? 0 : 2);
}, 180000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: "probe-interrupt" } }));
  setTimeout(() => {
    console.log(`[${elapsed()}} → msg1`);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: "probe-interrupt",
        text: "帮我查一下三亚和丽江哪个更适合五一去玩",
        messageId: `probe-a-${ts0}`,
        timestamp: new Date(ts0).toISOString(),
      },
    }));
  }, 500);
  setTimeout(() => {
    console.log(`[${elapsed()}] → msg2（打断）`);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: "probe-interrupt",
        text: "在吗",
        messageId: `probe-b-${ts0}`,
        timestamp: new Date(ts0 + 3000).toISOString(),
      },
    }));
  }, 3500);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const t = msg.type ?? "?";
  const p = msg.payload ?? {};
  if (t === "chat.assistant_chunk") {
    console.log(`[${elapsed()}] chunk trace=${p.traceId}: ${(p.chunk ?? "").slice(0, 40)}`);
  } else if (t === "chat.assistant_done") {
    doneCount += 1;
    console.log(`[${elapsed()}] DONE#${doneCount} trace=${p.traceId} final=${(p.finalText ?? "").slice(0, 80)}`);
    if (doneCount >= 2) { clearTimeout(timer); ws.close(); process.exit(0); }
  } else if (t === "chat.tool_start" || t === "chat.execution_event") {
    console.log(`[${elapsed()}] ${t} trace=${p.traceId ?? ""}: ${JSON.stringify(p).slice(0, 100)}`);
  } else if (t === "error.event") {
    console.log(`[${elapsed()}] ERROR: ${JSON.stringify(p).slice(0, 200)}`);
  }
});

ws.on("error", (e) => { console.log(`[${elapsed()}] ws error: ${e.message}`); process.exit(1); });
