// 真·分绿泡探针：发一条闲聊，抓 chunk 的 messageId 分配与 done 的 bubbles 对账数组。
// 用法: node bubble-probe.mjs [消息文本] [超时ms] [voice=1 模拟语音模式回归腿]
import WebSocket from "ws";

const text = process.argv[2] ?? "在吗？哎 在呢 有什么事 说";
const budgetMs = Number(process.argv[3] ?? "60000");
const voiceMode = process.argv[4] === "voice";
const ts0 = Date.now();
const elapsed = () => `${((Date.now() - ts0) / 1000).toFixed(2)}s`;

const ws = new WebSocket("ws://127.0.0.1:3000/ws");

const timer = setTimeout(() => {
  console.log(`[${elapsed()}] !! 探针超时（${budgetMs}ms）未收到 done`);
  ws.close();
  process.exit(2);
}, budgetMs);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: "probe-bubble" } }));
  setTimeout(() => {
    // 语音态按 actor 持久：非 voice 腿先复位 active=false，voice 腿置 true
    console.log(`[${elapsed()}] → mode.changed active=${voiceMode}`);
    ws.send(JSON.stringify({ type: "mode.changed", payload: { active: voiceMode, source: "probe" } }));
    setTimeout(() => {
      console.log(`[${elapsed()}] → chat.user_message: ${text}${voiceMode ? " [voice]" : ""}`);
      ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: { sessionId: "probe-bubble", text, messageId: `probe-${ts0}`, timestamp: new Date(ts0).toISOString() },
      }));
    }, 300);
  }, 400);
});

const chunks = [];
ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const t = msg.type ?? "?";
  const p = msg.payload ?? {};
  if (t === "chat.assistant_chunk") {
    chunks.push(p);
    console.log(`[${elapsed()}] chunk msgId=${p.messageId} seq=${p.sequence} bubbleIndex=${p.bubbleIndex ?? "-"} text=${JSON.stringify(p.chunk)}`);
  } else if (t === "chat.assistant_done") {
    // 只认本轮 trace 的前台 done；任务面异步收尾/上一轮迟到的 done 跳过
    if (p.source === "task_plane" || (p.traceId && p.traceId !== `probe-${ts0}`)) {
      console.log(`[${elapsed()}] (skip 非本轮 done: msgId=${p.messageId} source=${p.source ?? "-"})`);
      return;
    }
    console.log(`[${elapsed()}] DONE msgId=${p.messageId}`);
    console.log(`  finalText: ${JSON.stringify(p.finalText)}`);
    console.log(`  bubbles: ${JSON.stringify(p.bubbles ?? null)}`);
    console.log(`  finalTextReplacesStream: ${p.finalTextReplacesStream ?? false}`);
    console.log(`  mediaCards: ${(p.mediaCards ?? []).length} renderBlocks: ${(p.renderBlocks ?? []).length} blocks: ${(p.blocks ?? []).length}`);
    // 断言腿：多泡时 chunk 的 messageId 必须各泡独立且与 done.bubbles 对齐
    if (p.bubbles && p.bubbles.length > 1) {
      const ids = new Set(chunks.map((c) => c.messageId));
      const bubbleIds = new Set(p.bubbles.map((b) => b.id));
      const aligned = [...ids].every((id) => bubbleIds.has(id));
      console.log(`  [ASSERT] chunk 涉及 ${ids.size} 个 messageId，bubbles ${p.bubbles.length} 条，对齐=${aligned}`);
    }
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } else if (t === "chat.turn_started" || t === "chat.intent_detected") {
    console.log(`[${elapsed()}] ${t}`);
  } else if (t === "chat.agent_status") {
    // 安静
  } else if (t === "error.event") {
    console.log(`[${elapsed()}] ERROR: ${JSON.stringify(p).slice(0, 300)}`);
  }
});

ws.on("error", (e) => {
  console.log(`[${elapsed()}] ws error: ${e.message}`);
  clearTimeout(timer);
  process.exit(1);
});
