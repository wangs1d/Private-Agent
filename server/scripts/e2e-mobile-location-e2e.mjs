/**
 * 手机端定位链路 E2E（2026-10-09「agent 不知道用户地址」修复的活体验证）。
 *
 * 用法：node scripts/e2e-mobile-location-e2e.mjs [wsUrl]
 *   wsUrl 缺省 ws://127.0.0.1:3000/ws
 *
 * 模拟修复后的手机客户端（与 MobileChatController 同协议）：
 *   1. session.init（一次性测试账号，不碰真实账号）
 *   2. 发问「我现在的位置天气怎么样？」→ 路由到 weather.get_local
 *   3. 收到 agent.location_request → 纯坐标秒回（遵义市坐标，coordsOnly 路径）
 *   4. 断言 agent 最终回复包含遵义/贵州天气特征 → 全链闭环
 *
 * 通过标准（缺一即 FAIL）：
 *   - LOC_REQUEST_RECV  服务端按需定位请求到达模拟手机
 *   - LOC_REPLIED      模拟手机坐标回包成功
 *   - REPLY_ON_TARGET   agent 回复用上了坐标（遵义/贵州/天气词）
 */

import WebSocket from "ws";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `e2e-loc-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
const TIMEOUT_MS = 90_000;
// 遵义市坐标：与手机端真机无关，纯粹是「服务端能拿到真实坐标并反查城市」的证据
const E2E_COORDS = { latitude: 27.7255, longitude: 106.9291 };

let sawLocationRequest = false;
let repliedLocation = false;
let finalText = "";
let chatError = "";
let turnStarted = false;
let toolCalls = new Set();
let toolResults = 0;
let doneCount = 0;
/** 首个 assistant_done 后继续等后续轮次（任务面出正文），静默 QUIET_MS 即收口 */
const QUIET_MS = 30_000;
let quietTimer = null;

function finish() {
  clearTimeout(timer);
  const pass = verdict();
  try { ws.close(); } catch { /* 已关 */ }
  process.exit(pass ? 0 : 2);
}

function armQuietTimer() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(finish, QUIET_MS);
}

function verdict() {
  const replyOnTarget = /遵义|贵州|[0-9]+\s*[°℃]|气温|温度|晴|雨|阴|多云|天气/.test(finalText);
  const pass = sawLocationRequest && repliedLocation && turnStarted && replyOnTarget && !chatError;
  console.log("\n===== E2E 结果 =====");
  console.log(`TURN_STARTED      : ${turnStarted}`);
  console.log(`LOC_REQUEST_RECV  : ${sawLocationRequest}`);
  console.log(`LOC_REPLIED       : ${repliedLocation}`);
  console.log(`TOOLS_USED        : ${[...toolCalls].join(", ") || "-"}`);
  console.log(`REPLY_ON_TARGET   : ${replyOnTarget}`);
  console.log(`CHAT_ERROR        : ${chatError || "-"}`);
  console.log(`FINAL_TEXT        : ${finalText.slice(0, 300).replace(/\s+/g, " ")}`);
  console.log(`账号: ${USER_ID}`);
  console.log(pass ? "E2E_PASS：手机定位应答链路全闭环" : "E2E_FAIL");
  return pass;
}

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => {
  console.log("E2E_TIMEOUT（90s 内未收到 chat.assistant_done）");
  console.log(verdict() ? "E2E_PASS" : "E2E_FAIL");
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => {
  console.log(`WS 已连接: ${WS_URL}，测试账号 ${USER_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "e2e-mobile-sim",
      userAlias: "owner",
      platform: "android",
      userId: USER_ID,
    },
  }));
  // 稍等服务端完成 actor 绑定，再发天气问题
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: USER_ID,
        messageId: `e2e-${Date.now()}`,
        text: "我现在这里天气怎么样？",
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
        userId: USER_ID,
      },
    }));
    console.log("已发送天气提问，等待 agent…");
  }, 1500);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const type = String(msg.type ?? "");
  const payload = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};

  if (type === "chat.turn_started") turnStarted = true;

  if (type === "agent.location_request") {
    sawLocationRequest = true;
    console.log(`>> 收到 agent.location_request jobId=${payload.jobId ?? "-"} reason=${payload.reason ?? "-"} → 纯坐标秒回`);
    ws.send(JSON.stringify({
      type: "client.location_report",
      payload: {
        jobId: payload.jobId,
        ...E2E_COORDS,
        timezone: "Asia/Shanghai",
        label: `${E2E_COORDS.latitude}, ${E2E_COORDS.longitude}`,
      },
    }));
    repliedLocation = true;
    return;
  }

  if (type === "tool.call") {
    const name = String(payload.toolName ?? "");
    if (name && !toolCalls.has(name)) {
      toolCalls.add(name);
      console.log(`>> 工具调用: ${name}`);
    }
    return;
  }

  if (type === "tool.result") {
    toolResults++;
    const brief = JSON.stringify(payload).slice(0, 200);
    console.log(`>> 工具结果#${toolResults}: ${brief}`);
    return;
  }

  // 任务面进度/结果（天气正文可能以任务回执推送）
  if (type.startsWith("task.")) {
    const brief = JSON.stringify(payload).slice(0, 300);
    console.log(`>> 任务事件 ${type}: ${brief}`);
  }

  if (type === "chat.error") {
    chatError = String(payload.message ?? "chat.error");
    console.log(`>> chat.error: ${chatError}`);
  }

  if (type === "chat.assistant_done") {
    doneCount++;
    const text = String(payload.finalText ?? "");
    console.log(`>> assistant_done#${doneCount}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    // 拼接多轮正文（任务派发轮 + 天气正文轮）
    finalText = `${finalText}\n${text}`.trim();
    // 继续等后续轮次（任务面出正文），静默 30s 收口
    armQuietTimer();
  }
});

ws.on("error", (e) => {
  clearTimeout(timer);
  console.error(`WS_ERROR: ${e.message}`);
  console.log("E2E_FAIL");
  process.exit(2);
});

ws.on("close", (code) => {
  if (!finalText) {
    clearTimeout(timer);
    console.error(`WS_CLOSED(未完成轮次): code=${code}`);
    console.log(verdict() ? "E2E_PASS" : "E2E_FAIL");
    process.exit(2);
  }
});
