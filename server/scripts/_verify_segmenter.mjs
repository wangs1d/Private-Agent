// 临时验证脚本：连接 WS，发一条日常聊天消息，观察垫词同源分段的 chunk 推送
const ws = new WebSocket("ws://127.0.0.1:3000/ws");

const userId = "ws-segmenter-test-user";
const traceId = `trace-${Date.now()}`;

const send = (obj) => ws.send(JSON.stringify(obj));

ws.onopen = () => {
  console.log("[ws] open");
  send({ type: "session.init", payload: { userId } });
  // 等绑定后发消息
  setTimeout(() => {
    console.log("[send] chat.user_message traceId=" + traceId);
    send({
      type: "chat.user_message",
      payload: {
        userId,
        sessionId: userId,
        text: "帮我看看明天北京天气怎么样，顺便说说我该穿什么",
        messageId: traceId,
        timestamp: new Date().toISOString(),
      },
    });
  }, 500);
};

let chunkCount = 0;
ws.onmessage = (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  const t = msg.type;
  if (t === "chat.assistant_chunk") {
    chunkCount++;
    const p = msg.payload;
    console.log(
      `[chunk #${chunkCount}] phase=${p.phase} seq=${p.sequence} len=${(p.chunk||"").length} :: ${JSON.stringify(p.chunk)}`
    );
  } else if (t === "chat.assistant_done") {
    console.log("[done] finalText=" + JSON.stringify(msg.payload.finalText));
    console.log("[done] totalChunks=" + chunkCount);
    setTimeout(() => process.exit(0), 300);
  } else if (t === "chat.agent_status") {
    // 忽略状态
  } else if (t === "error") {
    console.log("[error] " + JSON.stringify(msg.payload));
    process.exit(1);
  } else {
    console.log(`[evt] ${t} ${JSON.stringify(msg.payload).slice(0, 120)}`);
  }
};

ws.onerror = (e) => {
  console.log("[ws] error", e.message || "");
};
ws.onclose = () => {
  console.log("[ws] closed");
};
setTimeout(() => {
  console.log("[timeout] 60s 无 done，退出");
  process.exit(2);
}, 60000);