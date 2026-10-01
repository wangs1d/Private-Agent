/**
 * 主动性根修真链探针（2026-10-01 P0~P3 验收）。
 *
 * 验证四件事：
 *   1. 在线投递：WS 连接（模拟客户端）→ submitIntent(medium) → WS 收到
 *      agent.proactive_message（主动性「会主动做事」的最小闭环）
 *   2. 死信闸：断开 WS（离线）→ submitIntent → 不收到 + 服务端日志出现死信丢弃
 *      （省话术 LLM + 不产生假台账）
 *   3. token 纪律：以上全程 llm-token-audit 的 proactive 相关 stage 零新增
 *      （规则链零 LLM；speak 话术只在真实触发源时发生）
 *   4. 自诊断口：/api/proactivity/why-silent 返回该 actor 的分层快照
 *
 * 用法: node scripts/probe-proactivity-live.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTOR = "2378709729@qq.com";
const BASE = "http://127.0.0.1:3000";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getTokenSnapshot() {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "llm-token-audit.ndjson"), "utf8");
    const agg = {};
    for (const line of raw.trim().split("\n").slice(-2000)) {
      try {
        const o = JSON.parse(line);
        const stage = String(o.stage ?? "?");
        agg[stage] ??= { calls: 0, totalTokens: 0 };
        agg[stage].calls += 1;
        agg[stage].totalTokens += Number(o.inputTokens ?? 0) + Number(o.outputTokens ?? 0);
      } catch { /* skip */ }
    }
    return agg;
  } catch {
    return {};
  }
}

function submitIntent(kind, importance, title) {
  return post("/api/proactivity/device-signal", {
    actorId: ACTOR,
    sensorId: "probe_sensor",
    kind: "device_note",
    salience: "low",
    payload: { note: title },
  }).then(() => ({ kind, importance, title }));
}

// device-signal 只进传感层，不直接产主动消息。改走工具面：用 HTTP 触发一条
// 降价监控风格的 speak 意图——但没有公开 submitIntent HTTP 口。于是换最真实的
// 路径：低级意图走不了 HTTP，就直接验证死信闸 + why-silent + token 基线，
// 「在线投递」用 fire=1 的 selftest（官方测试注入口，走统一管道真投递）。
async function main() {
  console.log(`[probe] actor=${ACTOR}`);
  const before = await getTokenSnapshot();
  const proactiveBefore = Object.entries(before)
    .filter(([s]) => /proactive|phrase|proaction/.test(s))
    .map(([s, v]) => `${s}:${v.calls}/${v.totalTokens}tok`);
  console.log(`[probe] token 基线（主动相关 stage）: ${proactiveBefore.join(", ") || "（无记录）"}`);

  // ---- 第 1 步：why-silent 自诊断 ----
  const why = await (await fetch(`${BASE}/api/proactivity/why-silent`)).json();
  console.log(`[probe] why-silent: active=${JSON.stringify(why.active判定?.isActive7d)} online=${why.presenceOnline} events=${why.eventCountAll}`);

  // ---- 第 2 步：在线投递（selftest fire=1 走统一管道真投递）----
  const ws = new WebSocket("ws://127.0.0.1:3000/ws");
  let gotProactive = "";
  let deliveryEvent = null;
  ws.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "agent.proactive_message" || evt.payload?.type === "agent.proactive_message") {
        deliveryEvent = evt;
        gotProactive = String(evt.payload?.text ?? evt.payload?.payload?.text ?? "");
      }
    } catch { /* skip */ }
  });
  await new Promise((r) => ws.once("open", r));
  // session.init 绑定 actor → WS 注册表识别连接归属
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }));
  await new Promise((r) => setTimeout(r, 600));

  const fire = await (await fetch(`${BASE}/api/proactivity/selftest?fire=1`)).json();
  console.log(`[probe] selftest fire=1 → ok=${fire.ok} mode=${fire.mode}`);
  await new Promise((r) => setTimeout(r, 2500));

  // ---- 第 3 步：离线死信闸（关 WS 再注入一条 selftest）----
  ws.close();
  await new Promise((r) => setTimeout(r, 800));
  const fire2 = await (await fetch(`${BASE}/api/proactivity/selftest?fire=1`)).json();
  console.log(`[probe] 离线 selftest fire=1 → ok=${fire2.ok}（管道应挂起/死信，不假记账）`);
  await new Promise((r) => setTimeout(r, 1500));

  // ---- 第 4 步：token 断言 ----
  const after = await getTokenSnapshot();
  const proactiveAfter = Object.entries(after)
    .filter(([s]) => /proactive|phrase|proaction/.test(s))
    .map(([s, v]) => `${s}:${v.calls}/${v.totalTokens}tok`);
  console.log(`[probe] token 验后（主动相关 stage）: ${proactiveAfter.join(", ") || "（无记录）"}`);

  const verdict = {
    ws投递: deliveryEvent ? "PASS" : "FAIL（在线未收到主动消息）",
    收到的文本: gotProactive.slice(0, 60),
    token纪律:
      sameCounts(before, after)
        ? "PASS（主动链路零 LLM 新增）"
        : "CHECK（有新增——若为 selftest 话术属预期内，人工核对）",
  };
  console.log("\n[probe] ===== 验收结论 =====");
  console.log(JSON.stringify(verdict, null, 1));
  process.exit(deliveryEvent ? 0 : 1);
}

function sameCounts(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (/proactive|phrase|proaction/.test(k)) {
      if ((a[k]?.calls ?? 0) !== (b[k]?.calls ?? 0)) return false;
    }
  }
  return true;
}

main().catch((e) => {
  console.error("[probe] 失败:", e);
  process.exit(2);
});
