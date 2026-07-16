/**
 * 端到端测试：通过 WebSocket 调用 Agent，让它真实操控电脑完成
 *   "打开微信 找到M 发送消息 你在干嘛"
 *
 * 用法：tsx scripts/e2e-wechat-msg.ts
 *
 * 关键事件：
 *   - chat.assistant_chunk        Agent 流式文本
 *   - chat.execution_event        工具调用 / 子 Agent
 *   - chat.assistant_done         最终回复
 *   - chat.tool.call              工具调用（如 desktop.open / run_input）
 *   - chat.tool.result            工具结果
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3000/ws";
const ACTOR_ID = `e2e-test-${Date.now()}`;
const TASK_TEXT = "打开微信 找到M 发送消息 你在干嘛";

type EventLog = {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
};

const events: EventLog[] = [];
const toolCalls: Array<{ name: string; args: unknown; result?: unknown }> = [];

function logEvent(type: string, payload: Record<string, unknown>) {
  const entry: EventLog = { type, payload, ts: Date.now() };
  events.push(entry);
  // 关键事件高亮
  const isToolCall = type === "chat.tool.call" || type === "tool.call";
  const isToolResult = type === "chat.tool.result" || type === "tool.result";
  const isChunk = type === "chat.assistant_chunk";
  const isDone = type === "chat.assistant_done";
  const isError = type === "error" || type === "chat.error";
  const isExec = type === "chat.execution_event";

  if (isToolCall) {
    const name = (payload.name ?? payload.toolName) as string | undefined;
    const args = payload.arguments ?? payload.args ?? payload.input;
    console.log(`\n>>> [TOOL CALL] ${name}  args=${JSON.stringify(args).slice(0, 300)}`);
    if (name) toolCalls.push({ name, args });
  } else if (isToolResult) {
    const name = (payload.name ?? payload.toolName) as string | undefined;
    const result = payload.result ?? payload.output;
    const resultStr = JSON.stringify(result).slice(0, 500);
    console.log(`<<< [TOOL RESULT] ${name}  result=${resultStr}`);
    if (toolCalls.length > 0 && !toolCalls[toolCalls.length - 1].result) {
      toolCalls[toolCalls.length - 1].result = result;
    }
  } else if (isChunk) {
    const text = (payload.text ?? payload.delta ?? "") as string;
    process.stdout.write(text);
  } else if (isDone) {
    console.log(`\n\n=== [ASSISTANT DONE] ===`);
    const text = (payload.text ?? payload.content ?? "") as string;
    if (text) console.log(`Final: ${text}`);
  } else if (isError) {
    console.log(`\n!!! [ERROR] ${JSON.stringify(payload)}`);
  } else if (isExec) {
    const kind = (payload.kind ?? "") as string;
    const data = payload.data ?? payload.detail ?? {};
    console.log(`  * [EXEC] kind=${kind}  ${JSON.stringify(data).slice(0, 250)}`);
  } else if (
    type !== "ping" &&
    type !== "pong"
  ) {
    // 其他事件全部打印（调试模式）
    console.log(`  . [${type}] ${JSON.stringify(payload).slice(0, 300)}`);
  }
}

async function runTest(): Promise<void> {
  console.log(`[e2e] connecting ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL);
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log("\n[e2e] TIMEOUT (240s)");
      resolve();
    }, 240_000);
    let userMsgSent = false;
    ws.on("open", () => {
      console.log("[e2e] WS open, sending session.init");
      ws.send(
        JSON.stringify({
          type: "session.init",
          payload: {
            userId: ACTOR_ID,
            sessionId: ACTOR_ID,
            userAlias: "e2e-tester",
          },
        }),
      );
      // session.init 不回 ack 事件，短暂延迟后直接发用户消息
      setTimeout(() => {
        if (userMsgSent) return;
        userMsgSent = true;
        console.log("[e2e] sending chat.user_message");
        ws.send(
          JSON.stringify({
            type: "chat.user_message",
            payload: {
              sessionId: ACTOR_ID,
              userId: ACTOR_ID,
              messageId: `e2e-${Date.now()}`,
              text: TASK_TEXT,
              timestamp: new Date().toISOString(),
              agentAccessMode: "full",
            },
          }),
        );
      }, 800);
    });
    ws.on("message", (data: WebSocket.RawData) => {
      let msg: { type: string; payload: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      logEvent(msg.type, msg.payload ?? {});
      if (msg.type === "chat.assistant_done") {
        clearTimeout(timeout);
        setTimeout(() => resolve(), 1000);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await done;
  ws.close();

  // 输出汇总
  console.log("\n\n========== SUMMARY ==========");
  console.log(`Total events: ${events.length}`);
  console.log(`Tool calls: ${toolCalls.length}`);
  for (const t of toolCalls) {
    console.log(
      `  - ${t.name}: ${JSON.stringify(t.args).slice(0, 100)} => ${JSON.stringify(t.result).slice(0, 200)}`,
    );
  }
  // 关键判断
  const desktopOpen = toolCalls.some((t) => t.name === "desktop.open");
  const runInput = toolCalls.some((t) => t.name === "desktop.run_input");
  const uiaQuery = toolCalls.some((t) => t.name === "desktop.uia_query");
  const screenshot = toolCalls.some((t) => t.name === "desktop.visual.screenshot");
  console.log("\n========== VERDICT ==========");
  console.log(`desktop.open used:        ${desktopOpen ? "YES" : "NO"}`);
  console.log(`desktop.uia_query used:   ${uiaQuery ? "YES" : "NO"}`);
  console.log(`desktop.run_input used:   ${runInput ? "YES" : "NO"}`);
  console.log(`desktop.visual.screenshot used: ${screenshot ? "YES" : "NO"}`);
  if (desktopOpen && (runInput || uiaQuery)) {
    console.log("\n✅ Agent 按优先级路径调用了正确的桌面工具");
  } else {
    console.log("\n❌ Agent 没走预期路径，需要排查");
  }
}

runTest().catch((err) => {
  console.error("[e2e] FAILED:", err);
  process.exit(1);
});
