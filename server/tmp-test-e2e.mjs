/**
 * 状态机编排器端到端测试(修复 uia_query + 长任务路由后)
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3000/ws";
const USER_ID = "session-mvp-001";
const TEST_MESSAGE = "打开微信 找到M 发送消息 你在干嘛";
const MESSAGE_ID = `test-${Date.now()}`;
const LISTEN_MS = 120000;

const ws = new WebSocket(WS_URL);
let msgSent = false;
const toolCalls = [];
const toolResults = [];
const taskEvents = [];

function send(obj) {
  const json = JSON.stringify(obj);
  console.log(`[SEND] ${json.slice(0, 200)}`);
  ws.send(json);
}

ws.on("open", () => {
  console.log("[WS] connected");
  send({ type: "session.init", payload: { userId: USER_ID, sessionId: USER_ID } });
  setTimeout(() => {
    if (!msgSent) {
      msgSent = true;
      console.log("[SEND] chat.user_message\n");
      send({
        type: "chat.user_message",
        payload: {
          sessionId: USER_ID, userId: USER_ID, messageId: MESSAGE_ID,
          text: TEST_MESSAGE, timestamp: new Date().toISOString(),
        },
      });
    }
  }, 1000);
});

ws.on("message", (data) => {
  let evt;
  try { evt = JSON.parse(data.toString()); } catch { return; }
  const t = evt.type;
  const p = evt.payload ?? {};

  if (t === "chat.execution_event") {
    if (p.kind === "tool_call" || p.toolCall) {
      toolCalls.push(p.toolCall ?? p);
      console.log(`[TOOL_CALL] ${p.toolCall?.name} args=${p.toolCall?.argsPreview ?? ""}`);
    } else if (p.kind === "tool_result" || p.toolResult) {
      const r = p.toolResult ?? p;
      toolResults.push(r);
      const preview = (r.preview ?? "").slice(0, 300);
      console.log(`[TOOL_RESULT] ${r.name} ok=${r.ok} preview=${preview}`);
    } else if (p.kind === "task_progress" || p.taskProgress) {
      const tp = p.taskProgress ?? p;
      taskEvents.push(tp);
      console.log(`[TASK] ${tp.type}: ${tp.message}`);
    }
  } else if (t === "chat.assistant_chunk") {
    process.stdout.write(p.chunk ?? "");
  } else if (t === "chat.assistant_done") {
    console.log(`\n[ASSISTANT_DONE] ${((p.finalText ?? "").slice(0, 300))}`);
  } else if (t === "chat.intent_detected") {
    console.log(`[INTENT] mode=${p.mode} reasons=${JSON.stringify(p.reasons ?? [])}`);
  } else if (t === "error") {
    console.log(`[ERR] ${JSON.stringify(p).slice(0, 300)}`);
  }
});

ws.on("error", (err) => console.error("[WS ERROR]", err.message));

ws.on("close", (code) => {
  console.log(`\n[WS CLOSED] code=${code}`);
  console.log(`\n=== Summary ===`);
  console.log(`Tool calls: ${toolCalls.length} | ${toolCalls.map(c => c.name).join(", ")}`);
  console.log(`Tool results: ${toolResults.length}`);
  console.log(`Task events: ${taskEvents.length}`);
  console.log(`\n=== Tool Results Detail ===`);
  for (const r of toolResults) {
    console.log(`  ${r.name}: ok=${r.ok} preview=${(r.preview ?? "").slice(0, 500)}`);
  }
  process.exit(0);
});

setTimeout(() => {
  console.log(`\n[TIMEOUT] ${LISTEN_MS}ms`);
  console.log(`\n=== Summary ===`);
  console.log(`Tool calls: ${toolCalls.length} | ${toolCalls.map(c => c.name).join(", ")}`);
  console.log(`Tool results: ${toolResults.length}`);
  console.log(`Task events: ${taskEvents.length}`);
  console.log(`\n=== Tool Results Detail ===`);
  for (const r of toolResults) {
    console.log(`  ${r.name}: ok=${r.ok} preview=${(r.preview ?? "").slice(0, 500)}`);
  }
  ws.close();
  process.exit(0);
}, LISTEN_MS);
