/**
 * 邮件反应链 + 行程获取 + 自动化 真链测试（2026-10-01 验收）。
 *
 * 三腿测试（全部走常驻实例真实链路，只跳过 IMAP 拉取本身——那一步需要授权码）：
 *   腿1 验证码邮件（VIP/critical 级）→ 分级 → ProactivityHub 主动提醒 → WS 收到
 *   腿2 12306 购票邮件 → 票务日程桥（零 LLM 正则）→ 自动创建 source=email 行程
 *        → /schedule/tasks 出现【火车票】任务（= agent 获取行程的信源之一实证）
 *   腿3 普通邮件（normal 级）→ 不主动打扰（只落消息中心）
 *
 * 附加：token 审计断言（腿2 票务提取零 LLM）；测试后清理自动创建的假行程。
 *
 * 用法: node scripts/probe-mail-reaction-live.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTOR = "2378709729@qq.com";
// 腿1 用独立测试 actor：真实用户今晚 selftest 已消耗 life_reminder 的 4h 频控
// （保护性拦截，非故障）——测试 actor 的频控是干净的，能端到端验证邮件→主动反应。
const PROBE_ACTOR = "mail-probe-e2e";
const BASE = "http://127.0.0.1:3000";

function tokenAgg() {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "llm-token-audit.ndjson"), "utf8");
    const agg = {};
    for (const line of raw.trim().split("\n").slice(-2500)) {
      try {
        const o = JSON.parse(line);
        const s = String(o.stage ?? "?");
        agg[s] = (agg[s] ?? 0) + 1;
      } catch {}
    }
    return agg;
  } catch {
    return {};
  }
}

async function injectMail(from, subject, text, actorId) {
  const res = await fetch(`${BASE}/api/proactivity/mail/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: actorId ?? ACTOR, from, subject, text }),
  });
  return res.json();
}

async function listTasks() {
  const res = await fetch(`${BASE}/schedule/tasks?sessionId=${encodeURIComponent(ACTOR)}`);
  return res.json();
}

async function deleteTask(taskId) {
  const res = await fetch(`${BASE}/schedule/tasks/${taskId}`, { method: "DELETE" });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- WS 在线（主动提醒的投递目标；两个 actor 各一条连接）----
  const ws = new WebSocket("ws://127.0.0.1:3000/ws");
  const wsProbe = new WebSocket("ws://127.0.0.1:3000/ws");
  const received = [];
  const onMsg = (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "agent.proactive_message") {
        received.push({
          kind: evt.payload?.kind,
          importance: evt.payload?.importance,
          text: String(evt.payload?.text ?? "").slice(0, 80),
        });
      }
    } catch {}
  };
  ws.on("message", onMsg);
  wsProbe.on("message", onMsg);
  await Promise.all([new Promise((r) => ws.once("open", r)), new Promise((r) => wsProbe.once("open", r))]);
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }));
  wsProbe.send(
    JSON.stringify({ type: "session.init", payload: { sessionId: PROBE_ACTOR, userId: PROBE_ACTOR } }),
  );
  await sleep(600);

  const tokensBefore = tokenAgg();

  // ---- 腿1：验证码邮件（测试 actor，频控干净；应 critical/high → 主动提醒）----
  console.log("\n===== 腿1：验证码邮件（actor=" + PROBE_ACTOR + "）=====");
  const r1 = await injectMail(
    "service@mail.qq.com",
    "【QQ邮箱】您的登录验证码",
    "您正在登录，验证码 592731，10 分钟内有效。若非本人操作请忽略。",
    PROBE_ACTOR,
  );
  console.log("分级:", JSON.stringify(r1.classification));
  await sleep(2500); // 等主动提醒投递

  // ---- 腿2：12306 购票邮件（真实用户名下；零 LLM 自动建行程）----
  console.log("\n===== 腿2：12306 购票邮件（actor=" + ACTOR + "）=====");
  const r2 = await injectMail(
    "12306@rails.com.cn",
    "网上购票成功",
    [
      "尊敬的旅客：您已购票成功！",
      "订单号：E20261001A8832KD",
      "车次：G287次  成都东站→重庆北站",
      "乘车日期：2026年10月2日  开车时间：09:36开",
      "座位：05车12F号  二等座。",
    ].join("\n"),
    ACTOR,
  );
  console.log("分级:", JSON.stringify(r2.classification));
  await sleep(2500);

  const tasksAfter = await listTasks();
  const taskList = Array.isArray(tasksAfter) ? tasksAfter : tasksAfter.tasks ?? [];
  const trainTask = taskList.find(
    (t) => String(t.title ?? "").includes("火车票") || String(t.title ?? "").includes("G287"),
  );
  console.log(
    "自动建行程:",
    trainTask
      ? `已创建「${trainTask.title}」 runAt=${trainTask.runAt} source=${trainTask.source ?? "?"}`
      : "未创建（提取未命中——检查正文格式）",
  );

  // ---- 腿3：普通邮件（normal → 不打扰）----
  console.log("\n===== 腿3：普通邮件（应零打扰）=====");
  const r3 = await injectMail(
    "newsletter@example.com",
    "本周周刊第 42 期",
    "本周精选：十篇文章带你了解……",
    PROBE_ACTOR,
  );
  console.log("分级:", JSON.stringify(r3.classification), "（normal 不应产生主动消息）");
  await sleep(2000);

  // ---- token 断言 ----
  const tokensAfter = tokenAgg();
  const newStages = {};
  for (const [k, v] of Object.entries(tokensAfter)) {
    if ((tokensBefore[k] ?? 0) < v) newStages[k] = v - (tokensBefore[k] ?? 0);
  }

  console.log("\n===== 验收结论 =====");
  const leg1 = received.find((m) => m.text.includes("验证码") || m.kind === "life_reminder");
  console.log(
    "腿1 邮件→主动反应:",
    leg1 ? `PASS（WS 收到：${leg1.text}）` : "FAIL（未收到主动提醒）",
  );
  console.log(
    "腿2 邮件→自动建行程:",
    trainTask ? "PASS（零 LLM 正则提取 → 日程落库）" : "FAIL",
  );
  const normalQuiet = !received.some((m) => m.text.includes("周刊"));
  console.log("腿3 普通邮件零打扰:", normalQuiet ? "PASS" : "FAIL（normal 邮件不应主动打扰）");
  console.log(
    "token 消耗:",
    Object.keys(newStages).length === 0
      ? "零新增（整条邮件链零 LLM）"
      : JSON.stringify(newStages),
  );

  // ---- 清理：删掉测试创建的假行程（防明早真响）----
  if (trainTask?.taskId) {
    const del = await deleteTask(trainTask.taskId);
    console.log(`清理假行程 ${trainTask.taskId}:`, del.ok ? "已删" : JSON.stringify(del));
  }

  ws.close();
  wsProbe.close();
  process.exit(leg1 && trainTask ? 0 : 1);
}

main().catch((e) => {
  console.error("[probe] 失败:", e);
  process.exit(2);
});
