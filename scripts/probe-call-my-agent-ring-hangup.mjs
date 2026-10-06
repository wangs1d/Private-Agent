/**
 * 真链探针：振铃期挂断 → 立即再呼（回归「会话登记提前到振铃前」的收尾守卫）。
 * 用法：node scripts/probe-call-my-agent-ring-hangup.mjs [userId]
 * 验证腿：
 *   ① 振铃 5s 前摇内挂断 → 服务端正常收尾（ended，无残留忙线）；
 *   ② 立即再呼 → 正常走完 ringing→connecting→connected（不被已挂断的
 *      残留续体顶成 busy，也不复用死会话推进接通）。
 *   ③ 探针呼叫必须 hangup 收尾（findActiveSessionByUser 无 TTL，残留挡忙线）。
 */
import WebSocket from "ws";

const userId = process.argv[2] ?? `probe-ring-hangup-${Date.now().toString(36)}@test.local`;
const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const nonce = Date.now().toString(36);

const ws = new WebSocket(wsUrl);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
let callId = "";
let endedSeen = false;
let secondConnected = false;
let busyBlocked = false;
let secondCallRinging = false;

const finish = () => {
  const pass = endedSeen && secondConnected && !busyBlocked;
  console.log(
    `\n结论: 振铃期挂断收尾=${endedSeen ? "✔" : "✘"} 再呼接通=${secondConnected ? "✔" : "✘"} 无误拦=${!busyBlocked ? "✔" : "✘"} → ${pass ? "PASS" : "FAIL"}`,
  );
  ws.close();
  process.exit(pass ? 0 : 1);
};

ws.on("open", () => {
  console.log(`[${stamp()}] WS open → ${wsUrl}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: `probe-rh-${nonce}`, deviceId: "probe-device", userAlias: "probe", platform: "desktop", userId },
  }));
  setTimeout(() => {
    console.log(`[${stamp()}] → phone.call_my_agent（第①通）`);
    ws.send(JSON.stringify({ type: "phone.call_my_agent", payload: {} }));
  }, 800);
  // 振铃中（5s 前摇内）挂断
  setTimeout(() => {
    console.log(`[${stamp()}] → phone.call_hangup（振铃期挂断）${callId}`);
    ws.send(JSON.stringify({ type: "phone.call_hangup", payload: { callId } }));
  }, 2500);
  // 立即再呼：应正常接通
  setTimeout(() => {
    secondCallRinging = true;
    console.log(`[${stamp()}] → phone.call_my_agent（第②通，应接通）`);
    ws.send(JSON.stringify({ type: "phone.call_my_agent", payload: {} }));
  }, 4200);
  setTimeout(() => {
    console.log(`[${stamp()}] → phone.call_hangup（收尾）`);
    ws.send(JSON.stringify({ type: "phone.call_hangup", payload: { callId } }));
  }, 10500);
  setTimeout(finish, 12500);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const type = evt.type ?? "?";
  const p = evt.payload ?? evt;
  if (type === "agent.embodiment.command") return; // 自主漫游噪音，不入证
  console.log(`[${stamp()}] ← ${type}: ${JSON.stringify(p).slice(0, 220)}`);
  if (type === "agent.phone.call_status") {
    if (p.status === "ringing" && !callId) callId = p.callId;
    if (p.status === "ringing" && secondCallRinging) callId = p.callId; // 第二通的新 callId
    if (p.status === "ended") endedSeen = true;
    if (p.status === "connected") secondConnected = true;
  }
  if (type === "error.event" && p.code === "PHONE_CALL_FAILED") {
    busyBlocked = true;
  }
});

ws.on("error", (err) => {
  console.error(`WS error: ${err.message}`);
  process.exit(1);
});
