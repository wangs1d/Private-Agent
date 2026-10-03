/**
 * 真链探针：复现「呼叫我的 Agent」WS 链路（与桌面客户端同构）。
 * 用法：node scripts/probe-call-my-agent-gate.mjs [userId]
 * 验证腿：
 *   ① 无号用户首呼 → 服务端代持申领并接通（realtimeVoice=true）；
 *   ② 通话中再呼 → busy 拒绝：error.event(PHONE_CALL_FAILED) + 对话气泡
 *      （chat.assistant_done source=task_plane，agent 在聊天流里主动说明）；
 *   ③ 探针呼叫必须 hangup 收尾（findActiveSessionByUser 无 TTL，残留挡忙线）。
 */
import WebSocket from "ws";

const userId = process.argv[2] ?? "2378709729@qq.com";
const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const nonce = Date.now().toString(36);

const ws = new WebSocket(wsUrl);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
let firstCallId = "";
let secondCallRejected = false;
let bubbleArrived = false;

const hangup = (callId) => {
  if (!callId) return;
  console.log(`[${stamp()}] → phone.call_hangup ${callId}`);
  ws.send(JSON.stringify({ type: "phone.call_hangup", payload: { callId } }));
};

const finish = () => {
  const pass = secondCallRejected && bubbleArrived;
  console.log(`\n[${stamp()}] 结论: busy拒绝=${secondCallRejected ? "✔" : "✘"} 对话气泡=${bubbleArrived ? "✔" : "✘"} → ${pass ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(pass ? 0 : 1);
};

ws.on("open", () => {
  console.log(`[${stamp()}] WS open → ${wsUrl}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: `probe-call-gate-${nonce}`, deviceId: "probe-device", userAlias: "probe", platform: "desktop", userId },
  }));
  setTimeout(() => {
    console.log(`[${stamp()}] → phone.call_my_agent（第①通）`);
    ws.send(JSON.stringify({ type: "phone.call_my_agent", payload: {} }));
  }, 800);
  // 振铃 5s 后接通；第 4s 发第二通必撞忙线护栏
  setTimeout(() => {
    console.log(`[${stamp()}] → phone.call_my_agent（第②通，应busy拒绝）`);
    ws.send(JSON.stringify({ type: "phone.call_my_agent", payload: {} }));
  }, 4000);
  setTimeout(() => hangup(firstCallId), 7500);
  setTimeout(finish, 9000);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const type = evt.type ?? "?";
  const payload = evt.payload ?? evt;
  if (type === "agent.embodiment.command") return; // 自主漫游噪音，不入证
  console.log(`[${stamp()}] ← ${type}: ${JSON.stringify(payload).slice(0, 260)}`);
  if (type === "agent.phone.call_status" && payload?.status === "connected") {
    firstCallId = payload?.callId ?? "";
    console.log(`>>> ① 呼叫接通（realtimeVoice=${payload?.realtimeVoice}，号码代持已落盘）`);
  }
  if (type === "error.event" && payload?.code === "PHONE_CALL_FAILED") {
    secondCallRejected = true;
    console.log(`>>> ② busy 拒绝（error.event）`);
  }
  if (
    type === "chat.assistant_done" &&
    payload?.source === "task_plane" &&
    String(payload?.finalText ?? "").includes("通话中")
  ) {
    bubbleArrived = true;
    console.log(`>>> ② 对话气泡已落（agent 主动说明）`);
  }
});

ws.on("close", (code) => console.log(`[${stamp()}] WS close ${code}`));
ws.on("error", (err) => console.error(`[${stamp()}] WS error: ${err.message}`));
