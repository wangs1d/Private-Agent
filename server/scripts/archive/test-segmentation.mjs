import WebSocket from "ws";

const PORT = 3000;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const MSG = process.argv[2] || "给我简单介绍一下深度学习和机器学习的关系，还有它们分别适合什么场景？";

const ws = new WebSocket(URL);

const chunks = [];
const dones = [];
let done = false;

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { userId: "test-user", sessionId: "test-session" },
  }));
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: {
      sessionId: "test-session",
      userId: "test-user",
      messageId: `test-${Date.now()}`,
      text: MSG,
      timestamp: new Date().toISOString(),
    },
  }));
});

ws.on("message", (data) => {
  let ev;
  try { ev = JSON.parse(data.toString()); } catch { return; }
  if (ev.type === "chat.assistant_chunk") {
    const p = ev.payload || {};
    chunks.push({ phase: p.phase, seq: p.sequence, text: p.chunk, mid: p.messageId, source: p.source });
  }
  if (ev.type === "chat.assistant_done") {
    const p = ev.payload || {};
    dones.push({ finalText: p.finalText || "", mid: p.messageId, source: p.source });
    console.log("\n===== DONE #" + dones.length + " =====");
    console.log("messageId:", p.messageId);
    console.log("source:", p.source);
    console.log("finalText:", (p.finalText || "").trim());
    if (dones.length >= 1) {
      done = true;
      printChunks();
      ws.close();
    }
  }
});

function printChunks() {
  console.log("\n===== 分段输出 ===== (共 " + chunks.length + " 段)");
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    console.log(`\n[段${i + 1}] phase=${c.phase} seq=${c.seq} mid=${c.mid} source=${c.source || ""}`);
    console.log(c.text);
  }
}

setTimeout(() => {
  if (!done) {
    console.log("TIMEOUT - 打印已收集的分段");
    printChunks();
    ws.close();
    process.exit(0);
  }
}, 60000);