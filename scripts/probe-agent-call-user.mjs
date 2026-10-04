/**
 * 真链探针：agent 外呼用户（phone.call_user 全链）。
 * 用法：node scripts/probe-agent-call-user.mjs [userId] [通话文本]
 *
 * 腿：
 *   ① WS 以用户身份在线（与桌面客户端同构，userId 广播可达）；
 *   ② 独立 sessionId 发 chat.user_message 要求 agent 立即拨打；
 *   ③ 观察 chat.assistant_done 文案（agent 对呼叫结果的陈述）与
 *      VirtualPhoneIncoming 推送是否到达。
 * 探针收尾：若收到来电，模拟客户端接听→挂断，避免残留占忙线。
 */
import WebSocket from "ws";

const userId = process.argv[2] ?? "2378709729@qq.com";
const ask = process.argv[3] ?? "马上给我打一通电话，直接调用 phone.call_user 工具拨出，不要反问。";
const hangupDelayMs = Number(process.argv[4] ?? 2000); // 收到来电后多久模拟挂断
const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const nonce = Date.now().toString(36);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

const ws = new WebSocket(wsUrl);
let incomingArrived = false;
let incomingCallId = "";
let finalTexts = [];

ws.on("open", () => {
  console.log(`[${stamp()}] WS open → ${wsUrl} (userId=${userId})`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: `probe-agent-call-${nonce}`, deviceId: "probe-device", userAlias: "probe", platform: "desktop", userId },
  }));
  setTimeout(() => {
    console.log(`[${stamp()}] → chat.user_message: "${ask}"`);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: `probe-agent-call-${nonce}`,
        userId,
        messageId: `probe-${nonce}`,
        text: ask,
        timestamp: new Date().toISOString(),
      },
    }));
  }, 800);
  setTimeout(finish, 75_000);
});

ws.on("message", (raw) => {
  let evt;
  try { evt = JSON.parse(raw.toString()); } catch { return; }
  const type = evt.type ?? "?";
  const payload = evt.payload ?? evt;
  if (type === "agent.embodiment.command") return;
  if (type === "chat.stream_segment" || type === "chat.stream") return; // 流噪音
  console.log(`[${stamp()}] ← ${type}: ${JSON.stringify(payload).slice(0, 400)}`);

  if (type === "agent.phone.incoming" || type === "agent.phone.ringing_start") {
    incomingArrived = true;
    if (!incomingCallId) incomingCallId = payload?.callId ?? "";
    console.log(`>>> ★ 来电推送到达（${type}）callId=${incomingCallId}`);
    setTimeout(() => {
      console.log(`[${stamp()}] → 模拟客户端挂断 ${incomingCallId}`);
      ws.send(JSON.stringify({ type: "phone.call_hangup", payload: { callId: incomingCallId } }));
    }, hangupDelayMs);
  }
  if (type === "chat.assistant_done" || type === "chat.assistant_done") {
    const text = String(payload?.finalText ?? payload?.text ?? "");
    if (text) finalTexts.push(text);
  }
});

async function finish() {
  console.log(`\n===== 结论 =====`);
  console.log(`来电推送: ${incomingArrived ? "✔ 到达 WS" : "✘ 未到达"}`);
  for (const t of finalTexts) console.log(`agent 回复: ${t.slice(0, 500)}`);
  ws.close();
  process.exit(incomingArrived ? 0 : 1);
}

ws.on("close", (code) => console.log(`[${stamp()}] WS close ${code}`));
ws.on("error", (err) => console.error(`[${stamp()}] WS error: ${err.message}`));
