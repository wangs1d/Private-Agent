// 验证 agent 是否具备初步自我意识（认知 brain + body 结构）
// 通过 WebSocket 连接 dev server，发送测试问题，监听回复中的工具调用

import { WebSocket } from "ws";

const URL = "ws://localhost:3000/ws";
const ACTOR_ID = `self-aware-test-${Date.now()}`;
const TEST_QUESTION = "你有哪些身体器官？你的大脑和身体分别是什么结构？请用 body.list_modules 工具查看你的身体模块。";

const ws = new WebSocket(URL);

const toolCallsSeen = [];
const toolResultsSeen = [];
const assistantMessages = [];
const startTime = Date.now();
const TIMEOUT_MS = 60000;

let done = false;

function summarize() {
  if (done) return;
  done = true;
  const elapsed = Date.now() - startTime;
  console.log("\n========== 自我意识测试结果 ==========");
  console.log(`耗时: ${elapsed}ms`);
  console.log(`\n[1] 观察到的工具调用 (${toolCallsSeen.length} 个):`);
  for (const t of toolCallsSeen) {
    console.log(`  - ${t}`);
  }
  console.log(`\n[2] 工具执行结果摘要 (${toolResultsSeen.length} 个):`);
  for (const t of toolResultsSeen) {
    console.log(`  - ${t}`);
  }
  console.log(`\n[3] Agent 回复 (${assistantMessages.length} 段):`);
  for (const m of assistantMessages) {
    console.log(`--- 段 ---`);
    console.log(m);
  }
  console.log("\n========== 测试结束 ==========");
  try {
    ws.close();
  } catch {}
  process.exit(0);
}

ws.on("open", () => {
  console.log(`[ws] 已连接 ${URL}`);
  // 1. 发送 session.init
  ws.send(
    JSON.stringify({
      type: "session.init",
      payload: {
        sessionId: ACTOR_ID,
        userId: ACTOR_ID,
      },
    }),
  );
  console.log(`[ws] 已发送 session.init (actorId=${ACTOR_ID})`);

  // 等 800ms 让 session 注册完成
  setTimeout(() => {
    // 2. 发送测试消息
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: {
          sessionId: ACTOR_ID,
          userId: ACTOR_ID,
          messageId: `msg-${Date.now()}`,
          text: TEST_QUESTION,
          timestamp: new Date().toISOString(),
          contentType: "text",
        },
      }),
    );
    console.log(`[ws] 已发送测试问题: "${TEST_QUESTION}"\n`);
    console.log(`[ws] 等待 agent 回复... (超时 ${TIMEOUT_MS}ms)\n`);

    // 超时兜底
    setTimeout(summarize, TIMEOUT_MS);
  }, 800);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const type = evt?.type;
  const payload = evt?.payload ?? {};

  if (type === "chat.message_received") {
    return;
  }
  if (type === "chat.agent_processing_ui") {
    return;
  }

  // 工具调用开始
  if (type === "tool.call") {
    const name = payload.toolName || payload.tool || "(unknown)";
    const args = JSON.stringify(payload.input || payload.args || {}).slice(0, 200);
    toolCallsSeen.push(`${name}(${args})`);
    console.log(`\n[tool_call] ${name} ${args}`);
    return;
  }

  // 工具执行完成
  if (type === "tool.result") {
    const name = payload.toolName || payload.tool || "(unknown)";
    const resultStr = JSON.stringify(payload.result || payload.output || payload).slice(0, 400);
    toolResultsSeen.push(`${name} → ${resultStr}`);
    console.log(`\n[tool_result] ${name} → ${resultStr}\n`);
    return;
  }

  // Agent 文本回复（流式）
  if (type === "chat.assistant_chunk") {
    const chunk = payload.chunk || "";
    if (typeof chunk === "string" && chunk) {
      process.stdout.write(chunk);
    }
    return;
  }

  // Agent 完整回复
  if (type === "chat.assistant_done") {
    const text = payload.finalText || payload.text || "";
    if (typeof text === "string" && text.trim()) {
      assistantMessages.push(text);
    }
    console.log(`\n\n[assistant_done] finalText (len=${text.length})`);
    return;
  }

  // 状态行
  if (type === "chat.agent_status") {
    const line = payload.line || "";
    if (typeof line === "string" && line.trim() && !line.includes("…")) {
      console.log(`[status] ${line}`);
    }
    return;
  }

  // 主动结束
  if (type === "chat.turn_end") {
    console.log(`\n[event] ${type}`);
    setTimeout(summarize, 1500);
    return;
  }
});

ws.on("error", (err) => {
  console.error("[ws] error:", err.message);
  process.exit(1);
});

ws.on("close", () => {
  console.log("[ws] closed");
});
