/**
 * 端到端测试：主 Agent ↔ 子 Agent ↔ 子 Agent 消息共享总线
 *
 * 流程：
 * 1. WebSocket 连接 /ws
 * 2. 发 session.init 绑定 actorId
 * 3. 发 chat.user_message 触发主 Agent 委派（info 子 Agent 深度调研）
 * 4. 监听响应直到 chat.assistant_done 或超时
 * 5. HTTP GET /api/multi-agent/background-tasks 读取 sharedMessages 验证消息总线
 */
import { WebSocket } from "ws";

const WS_URL = "ws://localhost:3000/ws";
const HTTP_URL = "http://localhost:3000";
const TEST_USER = `test-shared-msg-${Date.now()}`;
const MSG_ID = `msg-${Date.now()}-shared`;

// 触发多子 Agent 协作的测试场景：
// "深度调研 + 多平台比价" → 路由到 info 子 Agent；可能触发 ask_peer(tech) 抓取 JS 页面
const TEST_TEXT =
  "帮我深度调研一下 MacBook Pro M4 2026 款，需要多平台比价和用户评测汇总";

console.log("=== 共享消息总线端到端测试 ===");
console.log(`用户: ${TEST_USER}`);
console.log(`消息: ${TEST_TEXT}\n`);

const ws = new WebSocket(WS_URL);
const events = [];
let done = false;
let startTime = 0;

ws.on("open", () => {
  console.log("[WS] 已连接");
  // 1. session.init
  ws.send(
    JSON.stringify({
      type: "session.init",
      payload: { userId: TEST_USER, sessionId: TEST_USER },
    }),
  );
  // 2. 等 500ms 后发消息
  setTimeout(() => {
    console.log("[WS] 发送 chat.user_message");
    startTime = Date.now();
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: {
          text: TEST_TEXT,
          messageId: MSG_ID,
          sessionId: TEST_USER,
          userId: TEST_USER,
          timestamp: new Date().toISOString(),
        },
      }),
    );
  }, 500);
});

ws.on("message", (data) => {
  const raw = data.toString();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const type = msg?.type ?? "(unknown)";
  events.push({ type, t: Date.now() - startTime, payload: msg?.payload });

  // 关键事件打印
  if (type === "tool.call") {
    const name = msg?.payload?.name ?? msg?.payload?.toolName;
    console.log(`  [tool.call] ${name}`);
  } else if (type === "tool.result") {
    const ok = msg?.payload?.ok;
    console.log(`  [tool.result] ok=${ok}`);
  } else if (type === "chat.agent_status") {
    const line = msg?.payload?.statusLine ?? msg?.payload?.line;
    if (line) console.log(`  [status] ${line}`);
  } else if (type === "chat.assistant_done") {
    console.log(`  [assistant_done] 收到最终回复`);
    done = true;
  } else if (type === "error.event") {
    console.log(`  [ERROR] ${JSON.stringify(msg?.payload).slice(0, 200)}`);
  }
});

ws.on("error", (err) => {
  console.error("[WS] 错误:", err.message);
});

// 超时控制：300s（含后台任务等待）
const TIMEOUT_MS = 300_000;
const timer = setTimeout(async () => {
  console.log(`\n[超时] ${TIMEOUT_MS / 1000}s 未收到 assistant_done，主动查询 sharedMessages`);
  await querySharedMessages();
  process.exit(0);
}, TIMEOUT_MS);

ws.on("close", async () => {
  console.log("[WS] 连接关闭");
  if (!done) {
    await querySharedMessages();
  }
  clearTimeout(timer);
  process.exit(0);
});

// 收到 assistant_done 后等待后台任务完成再查询
const doneChecker = setInterval(async () => {
  if (done) {
    clearInterval(doneChecker);
    clearTimeout(timer);
    // 给服务端 1s 写入 reports 的缓冲
    await new Promise((r) => setTimeout(r, 1000));
    // 后台子 Agent 可能仍在执行，轮询等待完成
    await waitForBackgroundCompletion();
    ws.close();
  }
}, 1000);

async function waitForBackgroundCompletion() {
  console.log("\n=== 等待后台子 Agent 完成 ===");
  const maxPolls = 30; // 最多等 30 * 5s = 150s
  for (let i = 0; i < maxPolls; i++) {
    const url = `${HTTP_URL}/api/multi-agent/background-tasks?sessionId=${TEST_USER}&messageId=${MSG_ID}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      const running = data.inFlightInTurn ?? 0;
      const completed = data.completedReportsInTurn ?? 0;
      console.log(
        `  [轮询 ${i + 1}/${maxPolls}] inFlight=${running} completed=${completed} slots=${data.activeSubAgentSlots}`,
      );
      if (running === 0 && data.activeSubAgentSlots === 0) {
        console.log(`  ✓ 后台任务已全部完成（${completed} 份报告）`);
        break;
      }
    } catch (err) {
      console.log(`  [轮询 ${i + 1}] 查询失败: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await querySharedMessages();
}

async function querySharedMessages() {
  console.log("\n=== 查询共享消息总线 ===");
  const url = `${HTTP_URL}/api/multi-agent/background-tasks?sessionId=${TEST_USER}&messageId=${MSG_ID}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(`HTTP ${res.status}`);
    console.log(`completedReportsInTurn: ${data.completedReportsInTurn}`);
    console.log(`inFlightInTurn: ${data.inFlightInTurn}`);
    console.log(`activeSubAgentSlots: ${data.activeSubAgentSlots}`);

    if (data.reports?.length) {
      console.log("\n--- reports ---");
      for (const r of data.reports) {
        console.log(
          `  [${r.agentType}] success=${r.success} ${r.executionTime}ms\n    preview: ${r.reportPreview?.slice(0, 150)}...`,
        );
      }
    }

    const msgs = data.sharedMessages ?? [];
    console.log(`\n--- sharedMessages (${msgs.length} 条) ---`);
    if (msgs.length === 0) {
      console.log("  (无消息) 主 Agent 可能未触发委派，或路由到 master-only");
    } else {
      // 按 kind 分类统计
      const byKind = {};
      for (const m of msgs) {
        const k = m.kind ?? "notice";
        byKind[k] = (byKind[k] ?? 0) + 1;
      }
      console.log("  按类型统计:", byKind);

      for (const m of msgs) {
        const to = m.to === "broadcast" ? "📢广播" : `→${m.to}`;
        const time = new Date(m.timestamp).toLocaleTimeString("zh-CN");
        console.log(
          `  [${m.kind ?? "notice"}] ${m.from} ${to} (${time})\n    ${m.content?.slice(0, 200)}`,
        );
      }
    }

    // 验证断言
    console.log("\n=== 验证断言 ===");
    const hasDirective = msgs.some((m) => m.kind === "directive");
    const hasNotice = msgs.some((m) => m.kind === "notice");
    const hasMasterSender = msgs.some((m) => m.from === "master");
    const hasSubAgentSender = msgs.some(
      (m) => m.from !== "master" && m.kind !== "directive",
    );
    const hasBroadcast = msgs.some((m) => m.to === "broadcast");

    console.log(
      `  ${hasDirective ? "✓" : "✗"} 主→子 directive（主 Agent 委派指令写入总线）`,
    );
    console.log(
      `  ${hasNotice ? "✓" : "✗"} 子→广播 notice（子 Agent 报告就绪写入总线）`,
    );
    console.log(
      `  ${hasMasterSender ? "✓" : "✗"} master 作为发送方`,
    );
    console.log(
      `  ${hasSubAgentSender ? "✓" : "✗"} 子 Agent 作为发送方`,
    );
    console.log(`  ${hasBroadcast ? "✓" : "✗"} 存在 broadcast 广播消息`);

    const pass = msgs.length > 0 && hasDirective && hasNotice;
    console.log(
      `\n${pass ? "✓ 测试通过：消息共享总线正常工作" : "✗ 测试未通过：未观察到完整的消息共享链路"}`,
    );
  } catch (err) {
    console.error("查询失败:", err.message);
  }
}
