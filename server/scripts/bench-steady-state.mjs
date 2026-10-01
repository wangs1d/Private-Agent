/**
 * 稳态延迟探针：同一 WS 会话连续 3 轮纯聊天，测每轮 ack/TTFT/总耗时 + chunk 数。
 * 区分「新会话冷开销」（记忆召回/缓存冷）与「稳态每轮开销」。
 * 用法：node scripts/bench-steady-state.mjs
 */
import WebSocket from "ws";

const SERVER_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const userId = `bench-steady-${Date.now()}`;
const TURNS = ["你好", "今天状态怎么样", "给我讲个冷笑话"];

function runTurn(ws, text, msgId) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const m = { t0, ack: null, firstChunk: null, chunkCount: 0, lastChunk: null, done: null, finalTextLen: 0 };
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(m);
    };
    const timer = setTimeout(() => finish(new Error("90s 超时")), 90_000);
    const onMessage = (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
      const p = ev.payload ?? {};
      const now = Date.now();
      if (ev.type === "chat.message_received" && p.messageId === msgId) { m.ack = now - t0; return; }
      if (ev.type === "chat.assistant_chunk" && p.traceId === msgId) {
        if (m.firstChunk == null) m.firstChunk = now - t0;
        m.lastChunk = now - t0;
        m.chunkCount += 1;
        return;
      }
      if (ev.type === "chat.assistant_done" && p.traceId === msgId) {
        m.done = now - t0;
        m.finalTextLen = (p.finalText ?? "").length;
        ws.off("message", onMessage);
        finish();
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: { text, messageId: msgId, sessionId: userId, userId, timestamp: new Date().toISOString() },
    }));
  });
}

const ws = new WebSocket(SERVER_URL);
ws.on("error", (e) => { console.error("WS 错误:", e.message); process.exit(1); });
ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
  await new Promise((r) => setTimeout(r, 300));
  console.log(`会话: ${userId}（同一会话连发 ${TURNS.length} 轮）`);
  for (let i = 0; i < TURNS.length; i++) {
    const msgId = `steady-${i}-${Date.now()}`;
    process.stdout.write(`轮${i + 1} "${TURNS[i]}" ... `);
    try {
      const m = await runTurn(ws, TURNS[i], msgId);
      const gap = m.firstChunk != null && m.done != null ? m.done - m.firstChunk : null;
      console.log(
        `ack=${m.ack}ms  TTFT=${m.firstChunk ?? "—"}ms  done=${m.done}ms  chunks=${m.chunkCount}` +
        `  首 chunk 占比=${m.firstChunk != null && m.done ? Math.round((m.firstChunk / m.done) * 100) + "%" : "—"}  文本${m.finalTextLen}字`
      );
      if (gap != null && m.chunkCount <= 2) console.log(`    ↑ 零星 chunk：流被扣住，首字出现在完成前 ${m.done - m.firstChunk}ms`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  try { ws.close(); } catch {}
  process.exit(0);
});
