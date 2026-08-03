/**
 * 复现用户截图中的两个 case:
 *   1) "算了 看看今天的科技新闻吧"
 *   2) "今天的a股怎么样"
 *
 * 抓取所有 chat.* 事件，重点观察：
 *   - 是否有 search_web 工具调用
 *   - 主回复文本内容（是否含 "没听清" 兜底）
 *   - 工具链路是否报错
 *
 * 用法: tsx scripts/diag-fallback-repro.ts
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3000/ws";
const CASES = [
  { name: "科技新闻", text: "算了 看看今天的科技新闻吧" },
  { name: "A股行情", text: "今天的a股怎么样" },
];

type EventLog = { type: string; payload: Record<string, unknown>; ts: number };

async function runCase(c: { name: string; text: string }): Promise<{
  finalText: string;
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }>;
  chunkTexts: string[];
  errors: string[];
  execEvents: Array<{ kind: string; data: unknown }>;
}> {
  const actorId = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const toolCalls: Array<{ name: string; args: unknown; result?: unknown }> = [];
  const chunkTexts: string[] = [];
  const errors: string[] = [];
  const execEvents: Array<{ kind: string; data: unknown }> = [];
  let finalText = "";
  let mainReplyStarted = false;

  console.log(`\n========== CASE: ${c.name} ==========`);
  console.log(`User: ${c.text}`);

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      console.log(`  [TIMEOUT 90s]`);
      ws.close();
      resolve();
    }, 90_000);
    let userMsgSent = false;
    let streamBuffer = "";
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.init",
          payload: { userId: actorId, sessionId: actorId, userAlias: "diag" },
        }),
      );
      setTimeout(() => {
        if (userMsgSent) return;
        userMsgSent = true;
        ws.send(
          JSON.stringify({
            type: "chat.user_message",
            payload: {
              sessionId: actorId,
              userId: actorId,
              messageId: `diag-${Date.now()}`,
              text: c.text,
              timestamp: new Date().toISOString(),
              agentAccessMode: "full",
            },
          }),
        );
      }, 800);
    });
    ws.on("message", (raw) => {
      let msg: { type: string; payload: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = msg.type;
      const p = msg.payload ?? {};
      if (t === "chat.assistant_chunk" || t === "assistant_chunk") {
        const text = ((p.text ?? p.delta ?? "") as string) || "";
        if (text) {
          if (!mainReplyStarted) {
            console.log(`  [INTERIM] ${text}`);
            mainReplyStarted = true;
          } else {
            streamBuffer += text;
            process.stdout.write(text);
          }
        }
        chunkTexts.push(text);
      } else if (t === "chat.tool.call" || t === "tool.call") {
        const name = (p.name ?? p.toolName) as string;
        const args = p.arguments ?? p.args ?? p.input;
        console.log(`\n  >>> [TOOL CALL] ${name}  args=${JSON.stringify(args).slice(0, 280)}`);
        toolCalls.push({ name, args });
      } else if (t === "chat.tool.result" || t === "tool.result") {
        const name = (p.name ?? p.toolName) as string;
        const result = p.result ?? p.output;
        const resultStr = JSON.stringify(result).slice(0, 280);
        console.log(`  <<< [TOOL RESULT] ${name}  result=${resultStr}`);
        if (toolCalls.length > 0 && !toolCalls[toolCalls.length - 1].result) {
          toolCalls[toolCalls.length - 1].result = result;
        }
      } else if (t === "chat.assistant_done" || t === "assistant_done") {
        finalText =
          (p.finalText as string) ??
          (p.text as string) ??
          (p.content as string) ??
          streamBuffer;
        console.log(`\n  [ASSISTANT DONE] final=${finalText}`);
        clearTimeout(timeout);
        setTimeout(() => {
          ws.close();
          resolve();
        }, 800);
      } else if (t === "chat.error" || t === "error") {
        errors.push(JSON.stringify(p).slice(0, 400));
        console.log(`  !!! [ERROR] ${JSON.stringify(p).slice(0, 400)}`);
      } else if (t === "chat.execution_event" || t === "execution_event") {
        const kind = (p.kind ?? "") as string;
        const data = p.data ?? p.detail ?? {};
        execEvents.push({ kind, data });
        console.log(`  * [EXEC] kind=${kind}  ${JSON.stringify(data).slice(0, 280)}`);
      } else if (t === "interim.message" || t === "chat.interim") {
        const text = (p.text ?? p.content ?? "") as string;
        if (text) console.log(`  [INTERIM-EVT] ${text}`);
      } else if (t !== "ping" && t !== "pong") {
        console.log(`  . [${t}] ${JSON.stringify(p).slice(0, 200)}`);
      }
    });
    ws.on("error", (err) => {
      errors.push(err.message);
      console.log(`  !!! [WS ERROR] ${err.message}`);
      clearTimeout(timeout);
      resolve();
    });
    ws.on("close", () => resolve());
  });

  return { finalText, toolCalls, chunkTexts, errors, execEvents };
}

async function main() {
  console.log(`[diag] WS: ${WS_URL}`);
  // 顺序跑两个 case,避免 WS 并发抢占
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    if (i > 0) {
      console.log(`\n[diag] cooling 3s before next case ...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    const r = await runCase(c);
    console.log(`\n---------- VERDICT [${c.name}] ----------`);
    console.log(`  Final reply : ${r.finalText.slice(0, 240)}`);
    console.log(`  Tool calls  : ${r.toolCalls.length}`);
    for (const tc of r.toolCalls) {
      console.log(
        `    - ${tc.name}: ${JSON.stringify(tc.args).slice(0, 80)} => ${JSON.stringify(tc.result ?? "").slice(0, 160)}`,
      );
    }
    const hasSearch = r.toolCalls.some(
      (t) => t.name === "search_web" || t.name === "fetch_web" || t.name === "info_hub.search",
    );
    const hasApologyFallback = /(没听清|没听清楚|不清楚|再说一遍|没收到|没反应过来|刚没听)/.test(
      r.finalText,
    );
    const hasStuckInLoop = /我(刚|也)?(没)?(听|听清|听清楚|听不到|没听到)/.test(r.finalText);
    console.log(`  search_web called : ${hasSearch ? "YES" : "NO ❌"}`);
    console.log(`  Fallback detected : ${hasApologyFallback || hasStuckInLoop ? "YES ❌" : "NO"}`);
    console.log(`  Errors            : ${r.errors.length}`);
    for (const e of r.errors) console.log(`    ! ${e}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
