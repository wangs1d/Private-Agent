/**
 * 临时诊断：连 WS 触发一次照片搜索，打印 assistant_done 的 mediaCards / renderBlocks，
 * 以及 tool.call / tool.result 事件，判断照片是否送达前端。
 */
import WebSocket from "ws";

const SERVER_URL = process.argv[2] ?? "ws://localhost:3000/ws";
const QUERY = process.argv[3] ?? "帮我搜几张海边日落的照片";

const ws = new WebSocket(SERVER_URL);
const userId = `dbg-img-${Date.now()}`;
const msgId = `msg-${Date.now()}`;
const done = (label, obj) => {
  try { console.log(`\n=== ${label} ===\n${JSON.stringify(obj, null, 2)}`); }
  catch { console.log(`\n=== ${label} ===\n${String(obj)}`); }
};

const timeout = setTimeout(() => { console.log("TIMEOUT 90s"); ws.close(); process.exit(2); }, 90_000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: { text: QUERY, messageId: msgId, sessionId: userId, userId, timestamp: new Date().toISOString() },
    }));
  }, 300);
});

ws.on("message", (raw) => {
  let e;
  try { e = JSON.parse(raw.toString()); } catch { return; }
  const t = e.type;
  const p = e.payload ?? {};
  if (t === "tool.call") { done("tool.call", { toolName: p.toolName, input: p.input }); return; }
  if (t === "tool.result") {
    const r = p.result ?? {};
    const items = Array.isArray(r.items) ? r.items.length : "no-items";
    const mediaGroups = Array.isArray(r.mediaGroups) ? r.mediaGroups.length : "no-groups";
    done("tool.result", { toolName: p.toolName, ok: p.ok, items, mediaGroups, sampleItem: Array.isArray(r.items) ? r.items[0] : undefined });
    return;
  }
  if (t === "chat.media_ready") { done("chat.media_ready", { cards: p.cards }); return; }
  if (t === "chat.assistant_done" && p.traceId === msgId) {
    clearTimeout(timeout);
    done("assistant_done", {
      finalText: p.finalText,
      mediaCards: p.mediaCards,
      renderBlocks: p.renderBlocks,
    });
    ws.close();
    process.exit(0);
    return;
  }
  if (t === "chat.assistant_chunk" && p.traceId === msgId) { return; }
  if (t === "error" || t === "error_event" || t === "error.event") { done("error", p); clearTimeout(timeout); ws.close(); process.exit(3); }
});

ws.on("error", (err) => { clearTimeout(timeout); console.log("WS ERROR:", err.code, err.message, err.stack); process.exit(4); });
