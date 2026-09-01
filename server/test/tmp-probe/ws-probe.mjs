// WS 探针：连上 server，发一条需要工具的消息，把所有事件带时间戳打印出来。
import WebSocket from "ws";

const text = process.argv[2] ?? "帮我查一下今天有什么科技新闻";
const budgetMs = Number(process.argv[3] ?? "150000");
const ts0 = Date.now();
const elapsed = () => `${((Date.now() - ts0) / 1000).toFixed(1)}s`;

const ws = new WebSocket("ws://127.0.0.1:3000/ws");

const timer = setTimeout(() => {
  console.log(`[${elapsed()}] !! 探针超时（${budgetMs}ms）未收到 done，判定卡住`);
  ws.close();
  process.exit(2);
}, budgetMs);

ws.on("open", () => {
  console.log(`[${elapsed()}] ws open → session.init`);
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: "probe-tooluser" } }));
  setTimeout(() => {
    console.log(`[${elapsed()}] → chat.user_message: ${text}`);
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: { sessionId: "probe-tooluser", text, messageId: `probe-${ts0}`, timestamp: new Date(ts0).toISOString() },
      }),
    );
  }, 500);
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const t = msg.type ?? "?";
  const p = msg.payload ?? {};
  if (t === "chat.assistant_chunk") {
    console.log(`[${elapsed()}] chunk(+${(p.delta ?? "").length}ch): ${(p.delta ?? "").slice(0, 60)}`);
  } else if (t === "chat.assistant_done") {
    console.log(`[${elapsed()}] DONE. finalText(${(p.finalText ?? "").length}ch): ${(p.finalText ?? "").slice(0, 200)}`);
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } else if (t === "chat.tool_start" || t === "chat.tool_end" || t === "chat.execution_event") {
    console.log(`[${elapsed()}] ${t}: ${JSON.stringify(p).slice(0, 220)}`);
  } else if (t === "chat.agent_status") {
    console.log(`[${elapsed()}] agent_status: ${p.line ?? ""} (${p.percent ?? ""}%)`);
  } else if (t === "error.event") {
    console.log(`[${elapsed()}] ERROR: ${JSON.stringify(p).slice(0, 300)}`);
  } else {
    console.log(`[${elapsed()}] ${t}: ${JSON.stringify(p).slice(0, 140)}`);
  }
});

ws.on("error", (e) => {
  console.log(`[${elapsed()}] ws error: ${e.message}`);
  clearTimeout(timer);
  process.exit(1);
});
ws.on("close", () => console.log(`[${elapsed()}] ws closed`));
