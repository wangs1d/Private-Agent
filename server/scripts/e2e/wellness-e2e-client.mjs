/**
 * 女性关怀端到端真实测试客户端（连真实服务、走真实 LLM 工具链）。
 *
 *   node scripts/e2e/wellness-e2e-client.mjs
 *
 * 环境：E2E_ACTOR（默认 session-mvp-001）、E2E_WS_URL（默认 ws://127.0.0.1:3000/ws）。
 * 自动处理：agent.location_request → 回传模拟 GPS；捕获 agent.proactive_message
 * （周期临近提醒 / SOS critical 告警）；解析电话确认卡并模拟点击「确认拨打」。
 */
import WebSocket from "ws";

const ACTOR = process.env.E2E_ACTOR ?? "session-mvp-001";
const WS_URL = process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws";
const STEP_TIMEOUT_MS = 150_000;

const events = [];
const proactive = [];
let ws;
let nextMsgId = 0;

function send(type, payload) {
  const frame = JSON.stringify({ type, payload });
  ws.send(frame);
}

function nowIso() {
  return new Date().toISOString();
}

/** 等待一个满足条件的服务端事件（不消费其它事件）。 */
function waitFor(pred, timeoutMs, label) {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`等待 ${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const poll = setInterval(() => {
      const hit = events.find(pred);
      if (hit) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(hit);
      }
    }, 200);
  });
}

/** 发一条聊天消息并等 assistant_done。 */
async function chat(text) {
  const before = events.length;
  send("chat.user_message", {
    sessionId: ACTOR,
    userId: ACTOR,
    messageId: `e2e-${++nextMsgId}-${Date.now()}`,
    text,
    timestamp: nowIso(),
  });
  const done = await waitFor(
    (e, i) => e.type === "chat.assistant_done" && i >= before,
    STEP_TIMEOUT_MS,
    `assistant_done（${text.slice(0, 18)}…）`,
  );
  const textOut = extractText(done.payload);
  console.log(`\n【用户】${text}`);
  console.log(`【助手】${textOut.slice(0, 500)}`);
  return { done, text: textOut };
}

function extractText(payload) {
  if (!payload) return "";
  let text = payload.finalText ?? payload.text ?? payload.content ?? "";
  // 兼容 text 为整包 JSON 的历史格式
  if (typeof text === "string" && text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.finalText === "string") text = parsed.finalText;
    } catch {
      /* 原样使用 */
    }
  }
  if (Array.isArray(payload.blocks ?? payload.replyBlocks)) {
    const blocks = payload.blocks ?? payload.replyBlocks;
    text += "\n" + blocks.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
  }
  return String(text);
}

/** 从回复文本中解析电话确认卡。 */
function parsePhoneCard(text) {
  const m = text.match(/\[AGENT_RESULT_CARD_START\]\s*([\s\S]*?)\s*\[AGENT_RESULT_CARD_END\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`连接 ${WS_URL}（actor=${ACTOR}）…`);
  ws = new WebSocket(WS_URL);

  ws.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { type, payload } = frame;
    events.push({ type, payload, at: Date.now() });

    if (type === "agent.location_request") {
      // 模拟手机端 GPS 回包（按需定位链路的真实服务端往返）
      console.log(`  ↳ 收到定位请求（${payload?.reason ?? ""}）→ 回传模拟 GPS`);
      send("client.location_report", {
        jobId: payload?.jobId,
        latitude: 31.2304,
        longitude: 121.4737,
        city: "上海市",
        district: "浦东新区",
        label: "E2E模拟定位",
        source: "ondemand",
      });
    }
    if (type === "agent.proactive_message") {
      proactive.push(payload);
      console.log(`\n⚡ [主动消息] kind=${payload?.kind} importance=${payload?.importance} title=${payload?.title}`);
      console.log(`   ${String(payload?.text ?? payload?.summary ?? "").slice(0, 220)}`);
    }
    if (type === "error" || type === "error.event") {
      console.log(`\n✗ [服务端错误] ${JSON.stringify(payload).slice(0, 200)}`);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  send("session.init", { sessionId: ACTOR, userId: ACTOR });
  await sleep(1200);
  console.log("已连接并发送 session.init");

  // 先等服务端首个提醒 tick（60s 周期）再开始聊天：若先记录了「今天来了」，
  // 预测会顺延、临近提醒会被正确地不再触发（见 period-care-service runDue）。
  if (process.env.E2E_WAIT_TICK) {
    console.log(`… 等待提醒 tick（${process.env.E2E_WAIT_TICK}ms，期间不发言）`);
    await sleep(Number(process.env.E2E_WAIT_TICK));
  }

  const results = {};

  // S1 记录经期开始
  const s1 = await chat("我大姨妈来了,今天有点痛经");
  results.s1_log_start = /记录|收到|经期|开始|心疼|注意/.test(s1.text);

  // S2 查询预测
  const s2 = await chat("我下次月经大概什么时候来?");
  results.s2_prediction = /预计|大概|天|估算/.test(s2.text);

  // S3 配置紧急联系人
  const s3 = await chat("把我妈妈设为紧急联系人,电话13800000001");
  results.s3_contact = /紧急联系人|妈妈|保存|设好/.test(s3.text);

  // S4 SOS：定位回包 → 短信(未配置如实失败) → critical 告警
  const s4 = await chat("深夜打车有点害怕,帮我通知紧急联系人");
  await sleep(2500);
  const sosAlert = proactive.find((p) => p?.kind === "safety_sos");
  results.s4_sos_alert = Boolean(sosAlert);
  results.s4_sos_importance = sosAlert?.importance ?? "none";
  results.s4_reply_mentions_110 = /110|短信|联系/.test(s4.text);

  // S5 借口来电：prepare → 确认卡 → 点击确认 → start(手机桥离线如实失败)
  const s5 = await chat("给我打个电话,我要找个借口离开");
  const card = parsePhoneCard(s5.text) ?? parsePhoneCard(extractText(s5.done.payload));
  const callIdMatch = s5.text.match(/phone_call_([A-Za-z0-9_-]+)/);
  if (card || callIdMatch) {
    const callId = card?.actions?.[0]?.payload?.callId ?? callIdMatch?.[1];
    console.log(`\n  ↳ 检测到确认卡 cardId=${card?.cardId ?? `phone_call_${callId}`} → 模拟点击「确认拨打」`);
    send("chat.user_action", {
      sessionId: ACTOR,
      userId: ACTOR,
      messageId: `e2e-action-${Date.now()}`,
      label: "确认拨打",
      cardId: card?.cardId ?? `phone_call_${callId}`,
      actionId: "phone_call_confirm",
      payload: { callId },
      timestamp: nowIso(),
    });
    const s5b = await chat("确认拨打");
    results.s5_fake_call = /桥|离线|不在线|拨出|呼出|确认|失败|无法/.test(s5b.text);
  } else {
    results.s5_fake_call = false;
    console.log("  ↳ 未收到电话确认卡");
  }

  // 周期临近提醒（E2E_WAIT_TICK 模式下应已在开场等待期送达）
  if (!proactive.some((p) => p?.kind === "period_care")) {
    console.log("\n… 等待周期临近提醒 tick（最多 70s）");
    await sleep(70_000);
  }
  const reminder = proactive.find((p) => p?.kind === "period_care");
  results.s6_reminder = Boolean(reminder);

  // ─── 汇总 ───
  console.log("\n========== E2E 结果汇总 ==========");
  const checks = [
    ["S1 经期开始记录(回复确认)", results.s1_log_start],
    ["S2 周期预测(含估算口径)", results.s2_prediction],
    ["S3 紧急联系人保存", results.s3_contact],
    ["S4 SOS 触发 critical 全设备告警", results.s4_sos_alert && results.s4_sos_importance === "critical"],
    ["S4 SOS 回复提及 110/短信", results.s4_reply_mentions_110],
    ["S5 借口来电走完确认门(桥离线如实反馈)", results.s5_fake_call],
    ["S6 周期临近主动提醒送达", results.s6_reminder],
  ];
  let pass = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "✅" : "❌"} ${label}`);
    if (ok) pass += 1;
  }
  console.log(`\n${pass}/${checks.length} 项通过`);
  const exitOk = pass === checks.length;
  ws.close();
  process.exit(exitOk ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E 失败:", error.message);
  process.exit(1);
});
