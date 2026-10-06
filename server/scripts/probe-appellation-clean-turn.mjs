/**
 * 治啰嗦验收探针（2026-10-06）：清史后以真实用户身份走 WS 全链发一轮
 * 「以后叫我王哥」，收集 assistant 分泡/终文，验证：
 *  1. 回复短（不含档案/校验过程交代）；
 *  2. 不再自动带上一轮内容（session-recap 不注入）。
 * 用法：node scripts/probe-appellation-clean-turn.mjs [text]
 */
import WebSocket from "ws";

const SERVER_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const userId = process.env.PROBE_USER ?? "2378709729@qq.com";
const sessionId = process.env.PROBE_SESSION ?? "2378709729@qq.com";
const text = process.argv[2] ?? "以后叫我王哥";

const ws = new WebSocket(SERVER_URL);
const events = [];
let finalText = "";
let done = false;

const timer = setTimeout(() => {
  console.error("[probe] 120s 超时");
  process.exit(1);
}, 120_000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { userId, sessionId } }));
  setTimeout(() => {
    const messageId = `gov-probe-${Date.now()}`;
    events.push({ type: "SEND", payload: { text, messageId } });
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: { text, messageId, sessionId, userId, timestamp: new Date().toISOString() },
    }));
  }, 500);
});

ws.on("message", (raw) => {
  let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
  const p = ev.payload ?? {};
  if (ev.type === "chat.assistant_chunk") {
    finalText += p.delta ?? p.text ?? "";
  }
  if (ev.type === "chat.assistant_done") {
    finalText = p.finalText ?? finalText;
    done = true;
    clearTimeout(timer);
    console.log("=== finalText ===");
    console.log(finalText);
    console.log("=== length:", finalText.length, "chars ===");
    ws.close();
    process.exit(0);
  }
  if (ev.type === "error" || ev.type === "chat.error" || p.code) {
    console.error("[probe][error-event]", JSON.stringify(ev).slice(0, 500));
  }
  events.push({ type: ev.type, keys: Object.keys(p) });
});

ws.on("error", (err) => {
  console.error("[probe] ws error", err.message);
  process.exit(1);
});

setTimeout(() => {
  if (!done) {
    console.log("[probe] no assistant_done in 45s; events so far:");
    console.log(events.slice(-20).map((e) => e.type).join(", "));
    console.log("partial text:", finalText);
    process.exit(2);
  }
}, 45_000);
