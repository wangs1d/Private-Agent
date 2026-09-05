/**
 * 双面架构真实对话冒烟测试（E2E）。
 *
 * 前置：服务端已在 3210 端口启动（隔离 PA_DATA_DIR），已配置真实 provider。
 * 用法：node scripts/smoke-dual-plane.mjs
 *
 * 用例：
 *   1. 闲聊（在吗）              → 预期对话面：零工具事件，直接秒答
 *   2. 查价格（比特币多少钱）      → 预期任务面：工具调用（搜索），真实数据回复
 *   3. 天气（今天天气怎么样）      → 预期任务面：工具调用，真实数据回复
 *   4. 写操作（明天9点提醒喝水）   → 预期任务面：提醒/日程工具真实落库
 *   5. 闲聊（谢谢）              → 预期对话面
 */
import WebSocket from "ws";

const PORT = process.env.SMOKE_PORT ?? "3210";
const URL = `ws://127.0.0.1:${PORT}/ws`;
const SESSION = "smoke-dual-plane";

const CASES = [
  { id: "1-闲聊", text: "在吗", expect: "对话面：零工具事件，直接回复" },
  { id: "2-查价格", text: "现在比特币大概多少钱一个？", expect: "任务面：真实调用搜索工具，回复含真实价格" },
  { id: "3-天气", text: "今天天气怎么样？", expect: "任务面：真实调用天气/搜索工具" },
  { id: "4-写操作", text: "明天早上9点提醒我喝水", expect: "任务面：提醒工具真实创建，回复确认时间" },
  { id: "5-闲聊收尾", text: "谢谢啦", expect: "对话面：零工具事件" },
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function runCase(ws, c, seq) {
  return new Promise((resolve) => {
    const trace = {
      intent: null,
      tools: [],
      statuses: [],
      chunks: [],
      done: false,
      error: null,
      t0: Date.now(),
      firstDeltaMs: null,
    };
    const timer = setTimeout(() => {
      trace.error = "timeout(90s)";
      finish();
    }, 90_000);

    const onMsg = (raw) => {
      let ev;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const p = ev.payload ?? {};
      switch (ev.type) {
        case "chat.intent_detected":
          trace.intent = `${p.mode ?? "?"} reasons=${JSON.stringify(p.reasons ?? []).slice(0, 120)}`;
          break;
        case "chat.execution_event":
          if (p.kind === "tool_call") {
            trace.tools.push(p.toolCall?.name ?? p.toolName ?? "?");
          }
          break;
        case "chat.agent_status":
          trace.statuses.push(p.line ?? "");
          break;
        case "chat.assistant_chunk":
          if (trace.firstDeltaMs == null) trace.firstDeltaMs = Date.now() - trace.t0;
          if (typeof p.chunk === "string") trace.chunks.push(p.chunk);
          else if (typeof p.delta === "string") trace.chunks.push(p.delta);
          break;
        case "chat.assistant_done":
          trace.done = true;
          break;
        case "error_event":
          trace.error = `${p.code}: ${p.message}`;
          break;
        default:
          break;
      }
    };
    const finish = () => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      resolve(trace);
    };
    ws.on("message", onMsg);
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: {
          sessionId: SESSION,
          messageId: `smoke-${seq}-${Date.now()}`,
          text: c.text,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    // assistant_done 之后的剩余事件（分段补发等）留 1.5s 窗口再收尾
    const poll = setInterval(() => {
      if (trace.done) {
        clearInterval(poll);
        setTimeout(finish, 1500);
      }
    }, 200);
    setTimeout(() => clearInterval(poll), 91_000);
  });
}

const ws = await connect();
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: SESSION } }));
await new Promise((r) => setTimeout(r, 1200));

let seq = 0;
for (const c of CASES) {
  seq += 1;
  const t = await runCase(ws, c, seq);
  const text = t.chunks.join("").replace(/\s+/g, " ").trim();
  console.log(`\n━━━ 用例 ${c.id}：「${c.text}」`);
  console.log(`  预期: ${c.expect}`);
  console.log(`  路由: ${t.intent ?? "(无 intent 事件)"}`);
  console.log(`  工具: ${t.tools.length ? t.tools.join(", ") : "(无)"}`);
  console.log(`  首字延迟: ${t.firstDeltaMs ?? "-"}ms  总耗时: ${(Date.now() - t.t0) / 1000 | 0}s`);
  console.log(`  回复: ${text.slice(0, 300) || "(空)"}`);
  if (t.error) console.log(`  ⚠️ ${t.error}`);
}
ws.close();
console.log("\n冒烟完成。");
process.exit(0);
