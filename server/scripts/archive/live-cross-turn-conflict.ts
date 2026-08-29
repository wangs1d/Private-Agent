/**
 * 现场（真实模型驱动）验证：跨轮并行冲突
 * 场景：msg1 触发后台复杂任务（fast 先答，complex 后台跑）；
 *       msg1.fast 回复结束（assistant_done）后立刻发 msg2（新消息）；
 *       观察后台结果最终是「续接（KEEP）」还是「丢弃（DROP/串台/abort 短路）」
 *
 * 用法：
 *   npx tsx scripts/live-cross-turn-conflict.ts \
 *      "msg1...needs external..." \
 *      "msg2...new message..."
 */
import WebSocket from "ws";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const MSG1 = process.argv[2] ?? "帮我查一下 2026 年最新发布的 iPhone 和安卓旗舰机的价格对比，我在考虑换手机";
const MSG2 = process.argv[3] ?? "算了手机先不用查了，我们聊点别的吧";

const userId = `live-conflict-${Date.now()}`;
const sessionId = userId;

const events: Array<{ type: string; payload?: any }> = [];
let ws: WebSocket;

function log(kind: string, msg: string): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${kind} ${msg}`);
}

function donePayload(evt: any) {
  const p = evt.payload || {};
  return {
    source: p.source,
    mid: p.messageId,
    finalTextLen: (p.finalText || "").length,
    finalText: (p.finalText || "").slice(0, 120),
  };
}

function sendUser(text: string, mid: string): void {
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId, userId, messageId: mid, text, timestamp: new Date().toISOString() },
    }),
  );
}

const collected: Record<string, { text: string; done: boolean; source?: string }> = {};

ws = new WebSocket(URL);

ws.on("open", () => {
  log("conn", `已连接 ${URL}`);
  ws.send(JSON.stringify({ type: "session.init", payload: { userId, sessionId } }));
  log("send", `msg1(${MSG1})`);
  sendUser(MSG1, `m1-${Date.now()}`);
});

ws.on("message", (data) => {
  let ev: { type: string; messageType?: string; payload?: any };
  try {
    ev = JSON.parse(data.toString());
  } catch {
    return;
  }
  const type = ev.type || ev.messageType;
  const p = ev.payload || {};
  if (type === "session.init") return;

  if (type === "chat.assistant_chunk") {
    const mid = p.messageId || "";
    (collected[mid] ??= { text: "", done: false }).text += p.chunk || "";
    (collected[mid].source) ||= p.source || "";
    return;
  }

  if (type === "chat.assistant_done") {
    const mid = p.messageId || "";
    const src = p.source || "";
    (collected[mid] ??= { text: "", done: false });
    collected[mid].done = true;
    collected[mid].source ||= src;
    log("assistant_done", `mid=${mid} source=${src || "(main)"} final(len=${(p.finalText || "").length}) ${JSON.stringify((p.finalText || "").slice(0, 80))}`);

    // 完成 msg1 的主回复后，立刻注入 msg2（尽量落在后台任务执行期间）
    if (String(p.traceId).startsWith("m1-") && !String(mid).startsWith("assistant-m2")) {
      setTimeout(() => {
        log("send", `msg2(${MSG2})`);
        sendUser(MSG2, `m2-${Date.now()}`);
      }, 60);
    }
    return;
  }

  if (type === "chat.agent_status" || type === "chat.message_received" || type === "chat.base_done") return;

  if (type === "error" || type === "chat.error") {
    log("error", JSON.stringify(p));
  }
});

ws.on("close", () => {
  log("conn", "连接关闭");
  summarize();
  process.exit(0);
});
ws.on("error", (err) => {
  log("error", err.message || String(err));
  process.exit(1);
});

function summarize(): void {
  console.log("\n========== 汇总 ==========");
  for (const [mid, c] of Object.entries(collected)) {
    const tag = String(mid).startsWith("assistant-m1") ? "msg1-主回复" : String(mid).startsWith("assistant-m2") ? "msg2-回复" : "后台续接";
    console.log(`\n[${tag}] mid=${mid} source=${c.source || "(main)"} ${c.done ? "done" : "未done"}`);
    if (c.text) console.log(`  文本: ${c.text.slice(0, 150)}`);
  }
  const mainReplies = Object.values(collected).filter((c) => c.done);
  const backgroundFollowups = Object.values(collected).filter((c) => c.source === "parallel_live_complex" || c.source === "verdict_complex");
  console.log("\n判定结果:");
  console.log(`  主回复条数: ${mainReplies.length}`);
  console.log(`  后台续接气泡: ${backgroundFollowups.length} 条`);
  if (backgroundFollowups.length > 0) {
    console.log("  → 分类器判 KEEP：后台结果已自然续接进对话");
  } else {
    console.log("  → 无后台续接：结果为 DROP / abort 短路 / 或后续接（需对照服务端日志确认是哪条路径）");
  }
}

// 兜底退出
setTimeout(() => {
  log("timeout", "90s 超时关闭");
  summarize();
  ws.close();
  process.exit(0);
}, 90_000);