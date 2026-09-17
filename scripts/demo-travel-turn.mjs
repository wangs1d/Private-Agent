/**
 * 临时演示脚本：以客户端同款协议连 WS，发一条旅游规划消息，
 * 抓取 chat.assistant_done 载荷验证「正文在前 + 行程卡收尾 + autoOpen=false」。
 * 用与应用相同的默认会话（session-mvp-001），消息会实时出现在运行中的 App 里。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const WS_URL = process.env.DEMO_WS_URL ?? "ws://127.0.0.1:3000/ws";
const SESSION_ID = process.env.DEMO_SESSION ?? "session-mvp-001";
const TEXT =
  process.env.DEMO_TEXT ??
  "帮我规划去印度尼西亚巴厘岛玩5天，住宿要带私人泳池，预算充足，再推荐一些好玩的项目";

const ws = new WebSocket(WS_URL);
const events = [];
let done = false;
const t0 = Date.now();
const timer = setTimeout(() => {
  console.error("[demo] 超时（240s）未收到 assistant_done，已收到事件：", [...new Set(events.map((e) => e.type))].join(", "));
  process.exit(2);
}, 300_000);

ws.on("open", () => {
  console.log("[demo] connected:", WS_URL);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: SESSION_ID, deviceId: "demo-script", userAlias: "owner" },
  }));
  setTimeout(() => {
    const userMsg = {
      sessionId: SESSION_ID,
      messageId: `msg-demo-${Date.now()}`,
      text: TEXT,
      timestamp: new Date().toISOString(),
      agentAccessMode: "full",
    };
    console.log("[demo] -> chat.user_message:", TEXT);
    ws.send(JSON.stringify({ type: "chat.user_message", payload: userMsg }));
  }, 800);
});

ws.on("message", (raw) => {
  let evt;
  try { evt = JSON.parse(raw.toString()); } catch { return; }
  const type = evt.type ?? "(unknown)";
  const p = evt.payload ?? {};
  if (type === "chat.assistant_chunk") {
    const delta = p.delta ?? p.text ?? "";
    if (delta) process.stdout.write(delta);
    return;
  }
  if (type === "chat.status" || type === "chat.tool_status" || type === "agent.status" || type === "chat.task_update") {
    console.log(`\n[demo][${Math.round((Date.now() - t0) / 1000)}s] ${type}: ${p.text ?? p.status ?? p.state ?? p.message ?? ""}`);
    return;
  }
  events.push({ type, payload: p });
  if (type === "chat.assistant_done") {
    const hasText = (p.finalText ?? "").trim().length > 0;
    const isTaskResult = p.source === "task_plane";
    console.log(`\n\n===== assistant_done (${p.source ?? "chat"}) hasText=${hasText} =====`);
    if (hasText) {
      console.log("finalText:\n" + (p.finalText ?? "").slice(0, 2500));
      console.log("\nblocks:", p.blocks ? JSON.stringify(p.blocks.map((b) => b.type)) : "(none)");
      if (p.blocks) {
        for (const b of p.blocks) {
          if (b.type === "card") {
            const c = b.card;
            console.log("  card:", JSON.stringify({
              cardType: c.cardType, title: c.title, autoOpen: c.autoOpen,
              items: Array.isArray(c.items) ? c.items.length : 0, footer: c.footer,
            }));
          } else {
            console.log("  text:", JSON.stringify((b.text ?? "").slice(0, 100)));
          }
        }
      }
      writeFileSync(new URL("../data/demo-travel-done.json", import.meta.url), JSON.stringify(p, null, 2));
      console.log(`\n[demo] payload saved (source=${p.source ?? "chat"})`);
      done = true;
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
    console.log("[demo] 空 done（任务已派发），继续等待任务面结果…");
  }
});

ws.on("error", (e) => { console.error("[demo] ws error:", e.message); });
ws.on("close", () => { if (!done) console.log("[demo] closed before done"); });
