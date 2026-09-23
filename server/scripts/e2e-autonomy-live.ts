/**
 * 自主性真实链路端到端验证（e2e-autonomy-live.ts）——「这事真的能跑通」的证据脚本。
 *
 * 进程内调用真实生产装配 createAppServices()（与 runtime-main.ts 同一入口），
 * chdir 到隔离沙箱数据目录（OS tmp，不触碰仓库 data/）+ 独立端口 3100 启动，然后：
 *   1. 真实 WS 客户端连 /ws 并 session.init（成为"在线设备"）
 *   2. HTTP 创建一条 10 分钟后的真实日程任务（POST /schedule/tasks）
 *   3. 等真实链条自己跑完：ScheduleSensor → SensorKernel → EvaluatorChain(20s flush)
 *      → meeting_soon(must) → ArbiterV2 → ProactivePipeline → WS fan-out
 *   4. 断言 WS 客户端真实收到 agent.proactive_message（含任务标题）
 *
 * 零 LLM 依赖（meeting_soon 模板直投）、零外呼（不加载 .env，推送 provider 全关）。
 * 运行：npx tsx scripts/e2e-autonomy-live.ts   （exit 0 = 全链路跑通）
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 3100;
const ACTOR = "local_user"; // 与评估器事件缺省 actorId 对齐（无 hub actor 时默认 local_user）
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-live-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
const log = (line: string): void => console.log(`[e2e-live] ${line}`);

const received: Array<Record<string, unknown>> = [];

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r !== null && r !== undefined) return r;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ── 1. chdir 沙箱后加载真实生产装配（data 全部落沙箱，仓库 data/ 不受影响）──
log(`沙箱数据目录: ${sandbox}（仓库 data/ 不受影响）`);
log("加载真实服务端（createAppServices 完整装配）…");
process.chdir(sandbox);
// 测试窗口内关闭静默时段（quiet-hours.ts 在模块加载时读 env）：
// 深夜运行本验证时，meeting_soon(must/high) 会被仲裁按 quiet_hours_defer_to_morning
// 顺延到早 7 点——那本身是正确行为，但为了让本验证拿到"投递到客户端"的完整证据，
// 这里把静默窗口配置为空。生产不受影响（不设置即默认 23-7）。
process.env.PROACTIVITY_QUIET_START = "0";
process.env.PROACTIVITY_QUIET_END = "0";
const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: PORT, host: "127.0.0.1" });
log(`服务端已监听 http://127.0.0.1:${PORT}`);

// ── 2. 真实 WS 客户端接入 ──
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    received.push(msg);
    if (msg.type === "agent.proactive_message") {
      log(`★ WS 客户端收到主动消息: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  } catch {
    /* 非 JSON 忽略 */
  }
});
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR } }));
await new Promise((r) => setTimeout(r, 1_500));
log(`WS 已连接并发送 session.init（actor=${ACTOR}），已收帧 ${received.length} 条`);

// ── 3. 创建真实日程任务（10 分钟后）──
const runAt = new Date(Date.now() + 10 * 60_000).toISOString();
const createRes = await fetch(`http://127.0.0.1:${PORT}/schedule/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionId: ACTOR,
    title: "季度评审会",
    description: "与产品团队过季度 OKR",
    kind: "reminder",
    recurrence: "none",
    runAt,
    reminderMessage: "季度评审会快开始了",
  }),
});
const created = (await createRes.json()) as { ok: boolean; task?: { taskId: string }; error?: unknown };
if (!created.ok) {
  log(`FAIL: 日程任务创建失败: ${JSON.stringify(created).slice(0, 400)}`);
  ws.close();
  process.exit(1);
}
log(`日程任务已创建（taskId=${created.task?.taskId}）→ 等待 ScheduleSensor 采集 → 评估器 20s 批处理 → 仲裁 → 投递`);

// ── 4. 等真实链路把主动消息送到 WS 客户端 ──
const hit = await waitFor(() => {
  const found = received.find(
    (m) => m.type === "agent.proactive_message" && JSON.stringify(m).includes("季度评审会"),
  );
  return found ?? null;
}, 420_000, 3_000);

// ── 5. 辅助证据：事件审计尾部 + 诊断摘要 ──
let events = "";
try {
  events = readFileSync(join(sandbox, "data", "proactivity", "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .slice(-4)
    .join("\n");
} catch {
  /* 尚无事件 */
}
let diagnostics = "";
try {
  const diag = (await (await fetch(`http://127.0.0.1:${PORT}/api/proactivity/diagnostics`)).json()) as Record<string, unknown>;
  diagnostics = JSON.stringify({ recentDecisions: diag.recentDecisions, presence: diag.presence }).slice(0, 900);
} catch {
  /* ignore */
}

log("──── 端到端结果 ────");
log(hit ? "PASS: 真实 WS 客户端收到了「真实日程任务 → 评估器 meeting_soon → 仲裁 → 管道 → 投递」的主动消息" : "FAIL: 420s 内未收到 meeting_soon 主动消息");
log(`events.ndjson 尾部:\n${events || "（无）"}`);
log(`diagnostics 摘要:\n${diagnostics}`);
ws.close();
try {
  await services.app.close();
} catch {
  /* ignore */
}
// 沙箱清理失败（Windows 下 SQLite 句柄可能延迟释放）不影响验证结论
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  log(`沙箱保留（清理被占用）: ${sandbox}`);
}
process.exit(hit ? 0 : 1);
