/**
 * 高危闸根修真链探针 v2（2026-09-28）：
 * 复现「帮我查查这周有什么新动态」原话（trajectories traceId 6af460f9cccfb1e6
 * 里 social.get_feed 被 brain_center 连拦 5 次的同一输入）。该输入走 task_plane
 * 后台任务车道，回包异步，所以改为轮询 evolution-trajectories.jsonl 落盘。
 *   node scripts/e2e/gate-rootfix-probe.mjs
 */
import WebSocket from "ws";
import { readFileSync, statSync } from "node:fs";

const ACTOR = process.env.E2E_ACTOR ?? "xiaoyu-e2e";
const TEXT = process.env.E2E_TEXT ?? "帮我查查这周有什么新动态，挑重点讲给我";
const TRAJ = "data/evolution-trajectories.jsonl";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT ?? 360_000);

const sizeBefore = statSync(TRAJ).size;
const ws = new WebSocket(process.env.E2E_WS_URL ?? "ws://127.0.0.1:3000/ws");

ws.on("message", (raw) => {
  try {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "agent.location_request") {
      ws.send(
        JSON.stringify({
          type: "client.location_report",
          payload: {
            jobId: frame.payload?.jobId,
            latitude: 31.2304,
            longitude: 121.4737,
            city: "上海市",
            source: "ondemand",
          },
        }),
      );
    }
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => ws.once("open", r));
ws.send(
  JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, userId: ACTOR } }),
);
await sleep(1000);
const msgId = `gate-fix-${Date.now()}`;
ws.send(
  JSON.stringify({
    type: "chat.user_message",
    payload: {
      sessionId: ACTOR,
      userId: ACTOR,
      messageId: msgId,
      text: TEXT,
      timestamp: new Date().toISOString(),
    },
  }),
);
console.log(`[probe] sent: ${TEXT} (messageId=${msgId})`);

// 轮询 trajectories 增量，找本轮 trajectory_finalize
const deadline = Date.now() + TIMEOUT_MS;
let hit = null;
while (Date.now() < deadline && !hit) {
  await sleep(3000);
  let stat;
  try {
    stat = statSync(TRAJ);
  } catch {
    continue;
  }
  if (stat.size <= sizeBefore) continue;
  const tail = readFileSync(TRAJ)
    .subarray(Math.max(0, sizeBefore - 64))
    .toString("utf8");
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line);
      if (
        o.type === "trajectory_finalize" &&
        typeof o.userSnippet === "string" &&
        o.userSnippet.includes("这周") &&
        o.chatUserMessageId !== msgId // 排除自己（messageId 不同，保险）
      ) {
        hit = o;
      }
    } catch {}
  }
}
ws.close();

if (!hit) {
  console.log("[probe] 超时未等到 trajectory_finalize");
  process.exit(2);
}

console.log(`=== traceId=${hit.traceId} ts=${hit.ts} ===`);
console.log("=== assistant reply (前 300 字) ===");
console.log(String(hit.assistantSnippet ?? "").slice(0, 300));
console.log("=== tools ===");
for (const t of hit.tools ?? []) {
  console.log(
    `${t.ok ? "OK  " : "FAIL"} ${String(t.name).padEnd(20)} ${String(t.snippet ?? "").slice(0, 130)}`,
  );
}
const socialBlocked = (hit.tools ?? []).some(
  (t) => t.name === "social.get_feed" && String(t.snippet ?? "").includes("High-risk"),
);
console.log(
  socialBlocked
    ? ">>> VERDICT: FAIL —— social.get_feed 仍被 High-risk 文案拦截"
    : ">>> VERDICT: PASS —— 本轮无 High-risk 误拦",
);
process.exit(socialBlocked ? 1 : 0);
