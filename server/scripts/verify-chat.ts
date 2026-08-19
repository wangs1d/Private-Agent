/**
 * 完整对话端到端验证：通过 WebSocket 模拟真实客户端，跑一轮联网搜索对话。
 * 验证：扩宽后的搜索宽度 + 噪音过滤在真实 agent 调用链中生效。
 *
 * 运行：cd server && npx tsx scripts/verify-chat.ts "荣耀 折叠屏手机 最新发布有什么推荐"
 */
// 使用 Node 22 原生全局 WebSocket（undici）
const WS_URL = process.env.WS_URL ?? "ws://localhost:3000/ws";
const QUERY = process.argv[2] ?? "荣耀 折叠屏手机 最新发布有什么推荐";
const userId = `verify-chat-${Date.now()}`;

const ws = new WebSocket(WS_URL);
let fullText = "";
let done = false;

ws.onopen = () => {
  console.log(`[conn] 已连接 ${WS_URL}`);
  ws.send(
    JSON.stringify({
      type: "session.init",
      payload: { userId, sessionId: userId },
    }),
  );
  console.log(`[send] session.init userId=${userId}`);
  const messageId = `m-${Date.now()}`;
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: userId,
        userId,
        messageId,
        text: QUERY,
        timestamp: new Date().toISOString(),
      },
    }),
  );
  console.log(`[send] chat.user_message: ${QUERY}`);
};

ws.onmessage = (event) => {
  let evt: { type: string; payload?: Record<string, unknown> };
  try {
    evt = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const type = evt.type;
  if (type === "chat.assistant_chunk") {
    const chunk = String(evt.payload?.chunk ?? "");
    if (chunk) {
      fullText += chunk;
      process.stdout.write(chunk);
    }
  } else if (type === "chat.assistant_done") {
    done = true;
    console.log("\n\n[turn] 对话结束 (assistant_done)");
    ws.close();
  } else if (type === "chat.message_received") {
    // 仅协议 ack，忽略
  } else if (type === "error" || type === "chat.error") {
    console.log("\n[error]", JSON.stringify(evt.payload));
  }
};

ws.onclose = () => {
  console.log("\n[conn] 连接关闭");
  console.log("\n=== 最终回复长度:", fullText.length, "字符 ===");
  process.exit(0);
};

ws.onerror = (err) => {
  console.error("[conn] 错误:", err.message ?? err);
  process.exit(1);
};

// 兜底：60s 未结束则退出
setTimeout(() => {
  if (!done) {
    console.error("\n[timeout] 60s 未收到 assistant_done");
    process.exit(2);
  }
}, 60_000);