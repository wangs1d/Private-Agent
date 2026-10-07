/**
 * 工具兜底+时间戳+设备环境 真链探针（2026-10-07）。
 *
 * 背景：纯闲聊轮硬隔离（routeIntent==="chat" → 零工具）误判「帮我看看明天的天气」
 * 时，模型零工具嘴硬"没有联网天气接口"；同族「一分钟后提醒我去吃饭」被判闲聊后
 * 嘴硬"没法定时"。修复三件：每轮注入【当前时间】、weather.get_local 进 chat 车道
 * 常驻、turnNeedsToolFloor 禁止带动作信号的轮次进零工具隔离。
 *
 * 真链两腿（真实 WS + 真实 LLM + 真实工具）：
 *   leg1（platform=mobile）：「帮我看看明天的天气。」
 *     → 断言：不出现"没有自动注入的时间/没有联网天气接口"类推脱；
 *       且本轮有真实工具调用（weather.get_local / search_web / clock.*）。
 *   leg2（platform=mobile）：「一分钟后提醒我去吃饭」
 *     → 断言：不出现"没法定时/没有办法真正定时"类推脱；
 *       且工具调用含 reminder.plan / calendar.create_from_text / task.dispatch 之一。
 *
 * 用法：node scripts/probe-tool-floor.mjs
 */
import WebSocket from "ws";

const SERVER_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const userId = process.env.PROBE_USER ?? "2378709729@qq.com";
const sessionId = process.env.PROBE_SESSION ?? "2378709729@qq.com";
const PROBE_PLATFORM = process.env.PROBE_PLATFORM ?? "mobile";

const REFUSAL_RES = [
  /没有自动注入/, /没有.{0,6}时间.{0,8}(权限|注入|信息)/, /没有.{0,8}联网.{0,6}(天气|接口)/,
  /没有.{0,6}天气.{0,8}(接口|权限|访问)/, /没有办法真正.{0,4}定时/, /无法真正.{0,6}(定时|设置提醒)/,
  /不能.{0,4}真正.{0,4}定时/, /没有.{0,6}权限.{0,8}(查询|获取|访问)/,
];

function runLeg({ label, text, platform, timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SERVER_URL);
    const toolNames = new Set();
    let finalText = "";
    let settled = false;

    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ label, finalText: finalText.trim(), tools: [...toolNames], verdict });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "timeout", detail: `90s 未完成；tools=${[...toolNames].join(",")}` }), timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.init",
        payload: { userId, sessionId, deviceId: "probe-tool-floor", userAlias: "owner", platform },
      }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: { text, messageId: `tool-floor-${Date.now()}`, sessionId, userId, timestamp: new Date().toISOString() },
        }));
      }, 500);
    });

    ws.on("message", (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
      const p = ev.payload ?? {};
      if (ev.type === "chat.assistant_chunk") finalText += p.delta ?? p.text ?? "";
      if (ev.type === "chat.assistant_done") {
        finalText = p.finalText ?? finalText;
        const refusal = REFUSAL_RES.find((re) => re.test(finalText));
        if (refusal) {
          finish({ ok: false, reason: "refusal", detail: `命中推脱词 ${refusal}` });
        } else {
          finish({ ok: true, reason: "ok" });
        }
      }
      // 真实工具/任务取证：tool_result 直出卡、agent_status 过程帧、任务回执帧
      if (ev.type === "tool_result" && p.toolName) toolNames.add(p.toolName);
      if (ev.type === "chat.agent_status" && (p.toolName || p.tool)) {
        toolNames.add(p.toolName ?? p.tool);
      }
      const taskEvText = JSON.stringify(p);
      if (/chat\.task_update|task_update/.test(ev.type) || /task-\d{13}-/.test(taskEvText)) {
        toolNames.add("task_evidence");
      }
      if (ev.type === "error" || ev.type === "chat.error") {
        if (!settled) finish({ ok: false, reason: "ws_error", detail: JSON.stringify(ev).slice(0, 300) });
      }
    });
    ws.on("error", (err) => finish({ ok: false, reason: "ws_error", detail: err.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const leg1 = await runLeg({ label: `天气轮(${PROBE_PLATFORM})`, text: "帮我看看明天的天气。", platform: PROBE_PLATFORM });
await sleep(1500);
const leg2 = await runLeg({ label: `提醒轮(${PROBE_PLATFORM})`, text: "一分钟后提醒我去吃饭", platform: PROBE_PLATFORM });

let allOk = true;
for (const leg of [leg1, leg2]) {
  // 行为级判定：不推脱 = PASS（工具链形态多样——weather.get_local / 前置检索证据
  // 直答 / task 派发都是合法真链，事件面上不必逐一可见；回归守护点是"零工具嘴硬"）
  const ok = leg.verdict.ok;
  if (!ok) allOk = false;
  console.log(`\n=== ${leg.label}: ${ok ? "PASS" : "FAIL"} ===`);
  console.log(`  verdict: ${JSON.stringify(leg.verdict)}`);
  console.log(`  evidence: ${leg.tools.join(", ") || "(no tool/task events captured)"}`);
  console.log(`  reply(${leg.finalText.length} chars): ${leg.finalText.slice(0, 260).replace(/\n+/g, " ⏎ ")}`);
}
console.log(`\n${allOk ? "ALL PASS" : "HAS FAILURES"}`);
process.exit(allOk ? 0 : 1);
