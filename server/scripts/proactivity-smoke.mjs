// 主动性模块 · 真实服务器冒烟测试。
//
// 流程：隔离数据目录启动真实服务器（src/index.ts 完整装配）→ WS 客户端以
// session.init 上线 → 触发 /api/proactivity/selftest?fire=1 注入测试提案 →
// 断言 WS 收到 agent.proactive_message（对话界面通道的主动消息）→
// 校验 diagnostics 端点可解释性 → 优雅关闭。
//
// 运行：node scripts/proactivity-smoke.mjs（自身用 ws 客户端，无需 tsx）
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 3457);
const ACTOR = "local_user"; // selftest 的 primaryActor 兜底即 local_user，投递 fan-out 按此对齐
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "proactivity-smoke-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${ok || !detail ? "" : ` —— ${detail}`}`);
  if (!ok) failures += 1;
};

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("http timeout")));
  });

// ─── 1. 启动真实服务器（隔离 data 目录） ───
const child = spawn(process.execPath, ["--import", pathToFileURL(join(serverDir, "scripts", "_tsx-register.mjs")).href, join(serverDir, "src", "index.ts")], {
  cwd: dataDir,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLogs = [];
child.stdout.on("data", (c) => serverLogs.push(c.toString()));
child.stderr.on("data", (c) => serverLogs.push(c.toString()));
const serverLog = () => serverLogs.join("");

async function waitReady(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server 提前退出 code=${child.exitCode}\n${serverLog().slice(-3000)}`);
    try {
      const r = await httpGet("/api/proactivity/diagnostics");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`server ${timeoutMs}ms 未就绪\n${serverLog().slice(-3000)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`[smoke] 启动真实服务器 PORT=${PORT} data=${dataDir}`);
  await waitReady();
  check("真实服务器启动（嵌入式完整装配）", true);

  // ─── 2. WS 客户端上线（对话界面通道） ───
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const received = [];
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
    } catch {}
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("ws 连接超时")), 15_000);
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { userId: ACTOR, capabilities: { mediaPlayback: false } } }));
  await sleep(1500);
  // init 成功的判定：无鉴权/身份类错误事件（绑定成功的最终证据是后续主动消息送达本 socket）
  const initErr = received.find((m) => /AUTH_REQUIRED|BAD_SESSION|SESSION_REQUIRED/.test(String(m.payload?.code ?? "")) || /error/i.test(m.type ?? ""));
  check("WS session.init 上线（无鉴权/身份错误）", !initErr, JSON.stringify(initErr ?? {}).slice(0, 120));

  // ─── 3. 触发主动性自检注入（真实管道投递） ───
  const fire = await httpGet("/api/proactivity/selftest?fire=1");
  check("GET /api/proactivity/selftest?fire=1 返回 200", fire.status === 200, `status=${fire.status}`);
  const fireBody = JSON.parse(fire.body);
  const deliveryVerdict = fireBody?.delivery?.verdict;
  console.log(`[smoke] selftest fire delivery=${deliveryVerdict} (${fireBody?.delivery?.reasonChain?.join(";") ?? ""})`);
  check("selftest 注入经真实管道即时投递", deliveryVerdict === "delivered", JSON.stringify(fireBody?.delivery ?? fireBody).slice(0, 160));

  // ─── 4. 断言 WS 收到主动消息（对话界面通道） ───
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !received.some((m) => m.type === "agent.proactive_message")) {
    await sleep(500);
  }
  const proactive = received.find((m) => m.type === "agent.proactive_message");
  check("WS 收到 agent.proactive_message（对话界面通道主动消息）", !!proactive, proactive ? `「${proactive.payload?.title ?? ""}」` : `收到 ${received.length} 条: ${received.map((m) => m.type).join(",").slice(0, 200)}`);

  // ─── 5. outcome 反馈回传（客户端回执闭环） ───
  if (proactive?.payload?.deliveryId) {
    const ack = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/api/proactivity/outcome", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ deliveryId: proactive.payload.deliveryId, outcome: "accepted" }));
    });
    check("POST /api/proactivity/outcome 回执闭环", ack.status === 200 || ack.status === 204, `status=${ack.status} ${ack.body.slice(0, 80)}`);
  }

  // ─── 6. 诊断端点：投递决策全程可解释 ───
  const diag = await httpGet("/api/proactivity/diagnostics");
  const diagBody = JSON.parse(diag.body);
  check("diagnostics 可解释（recentDecisions/recentOutcomes 非空）", diag.status === 200 && (diagBody.recentDecisions?.length ?? 0) > 0 && (diagBody.recentOutcomes?.length ?? 0) > 0);

  // ─── 7. 传感器层快照 ───
  const sensors = await httpGet("/api/proactivity/sensors");
  check("GET /api/proactivity/sensors 传感器层可观测", sensors.status === 200);
} catch (err) {
  check("冒烟流程", false, String(err));
} finally {
  try {
    ws?.close();
  } catch {}
  child.kill("SIGINT");
  await sleep(2000);
  if (child.exitCode === null) child.kill("SIGKILL");
}

// 数据目录留档（调试用，不自动删）
console.log(`[smoke] data 目录保留：${dataDir}`);
const allOk = failures === 0;
console.log(allOk ? "\n✅ 冒烟测试全部通过" : `\n❌ 冒烟测试 ${failures} 项未通过`);
if (!allOk) console.log(serverLog().slice(-4000));
process.exit(allOk ? 0 : 1);
