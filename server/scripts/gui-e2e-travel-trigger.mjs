// 单轮实测：以 Flutter 客户端默认会话（session-mvp-001）发送旅游规划请求，
// 让 agent 真实执行 travel.plan-itinerary，行程卡随回复推入在线客户端。
// 前置：server 已运行，Flutter 客户端已连接 WS。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const SESSION = process.env.E2E_SESSION ?? "session-mvp-001";
const TEXT =
  process.env.E2E_TEXT ?? "帮我规划一下去大理玩的行程 两天 节奏轻松一点 其他的你看着安排";

const ws = new WebSocket(WS_URL);
let finalText = "";
let toolEvents = [];

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: SESSION } }));
  setTimeout(() => {
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: {
          sessionId: SESSION,
          messageId: `gui-e2e-${Date.now()}`,
          text: TEXT,
          timestamp: new Date().toISOString(),
        },
      }),
    );
  }, 1500);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const p = evt.payload ?? {};
  if (evt.type === "chat.assistant_chunk") {
    finalText += p.delta ?? p.text ?? "";
  } else if (evt.type === "chat.assistant_done") {
    finalText = p.finalText ?? finalText;
    console.log("=== ASSISTANT_DONE ===");
    console.log("has travel card:", finalText.includes("travel_itinerary"));
    console.log("has AGENT_RESULT_CARD:", finalText.includes("AGENT_RESULT_CARD_START"));
    console.log("HEAD:",finalText.slice(0,300));console.log("TAIL:",finalText.slice(-400));
    console.log("=== END ===");
    process.exit(0);
  } else if (String(evt.type).includes("tool")) {
    toolEvents.push(evt.type);
  }
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

// 兜底超时：3 分钟
setTimeout(() => {
  console.log("TIMEOUT. tool events:", toolEvents.length, "text so far:", finalText.slice(0, 400));
  process.exit(2);
}, 180000);
