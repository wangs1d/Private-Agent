/**
 * 测试信息综合能力：发送一个分析类问题，收集完整回复
 * 用法: node scripts/test-synthesis.mjs "你的问题"
 */
import WebSocket from "ws";

const WS_URL = process.argv[3] ?? "ws://localhost:3000/ws";
const QUESTION = process.argv[2] ?? "最近美股为什么大跌？分析一下原因";
const USER_ID = "test-synthesis-user";

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main() {
  console.log(`[test] 连接 ${WS_URL} ...`);
  const ws = await connectWs(WS_URL);
  console.log(`[test] 已连接，发送问题: "${QUESTION}"\n`);

  // session.init
  ws.send(JSON.stringify({ type: "session.init", payload: { userId: USER_ID } }));
  await new Promise((r) => setTimeout(r, 500));

  const msgId = `test-${Date.now()}`;
  let finalText = "";
  let allChunks = [];
  let toolEvents = [];
  let statusLines = [];

  const handler = (raw) => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    const t = evt?.type ?? "";
    const p = evt?.payload ?? {};

    if (t === "chat.assistant_chunk" && p.traceId === msgId) {
      if (p.delta) allChunks.push(p.delta);
      return;
    }
    if (t === "chat.assistant_done" && p.traceId === msgId) {
      finalText = p.finalText ?? "";
      return;
    }
    // 工具/进度事件
    if (t.includes("tool") || t.includes("agent_status") || t.includes("status")) {
      const name = p.name || p.tool || p.toolName || "";
      const text = p.text || p.message || p.userFacingText || "";
      if (name) toolEvents.push(`${t}: ${name}`);
      if (text) statusLines.push(text);
    }
  };

  ws.on("message", handler);

  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: {
      userId: USER_ID,
      messageId: msgId,
      sessionId: USER_ID,
      text: QUESTION,
      timestamp: new Date().toISOString(),
    },
  }));

  // 等待回复完成（最多 120s）
  const startTime = Date.now();
  while (!finalText && Date.now() - startTime < 120000) {
    await new Promise((r) => setTimeout(r, 500));
  }

  ws.off("message", handler);
  ws.close();

  // 输出结果
  console.log("=".repeat(60));
  console.log("【问题】", QUESTION);
  console.log("=".repeat(60));

  if (statusLines.length > 0) {
    console.log("\n【进度话】");
    statusLines.forEach((s) => console.log(`  > ${s}`));
  }

  if (toolEvents.length > 0) {
    console.log("\n【工具调用】");
    toolEvents.forEach((e) => console.log(`  - ${e}`));
  }

  console.log("\n" + "=".repeat(60));
  console.log("【Agent 完整回复】");
  console.log("=".repeat(60));
  console.log(finalText || allChunks.join("") || "(空回复)");
  console.log("=".repeat(60));
  console.log(`耗时: ${Date.now() - startTime}ms`);
}

main().catch((err) => {
  console.error("[test] 失败:", err);
  process.exit(1);
});
