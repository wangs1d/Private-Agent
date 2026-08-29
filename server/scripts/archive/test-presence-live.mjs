/**
 * 临时测试：验证 complex 执行期间的"主动在场（presence）"多步回复效果。
 * 发送一条 complex 消息，按时间线记录：承接垫词 / 主动在场互动 / 工具 / 流式正文 / 最终文本。
 * 结果写入同目录 presence-test-dialogue.txt（UTF-8），并在 stdout 打印简要时间线。
 *
 * 用法：node scripts/test-presence-live.mjs "你的问题"
 */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_URL = "ws://127.0.0.1:3000/ws";
const TEXT = process.argv[2] ?? "帮我看一下马尔代夫的消费情况";
const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "presence-test-dialogue.txt");

const userId = `presence-test-${Date.now()}`;
const msgId = `msg-${Date.now()}`;
const t0 = Date.now();
const lines = [];
const push = (kind, text) => {
  const at = Date.now() - t0;
  lines.push({ at, kind, text });
  const prefix = `[+${String(at).padStart(6)}ms]`;
  const short = String(text).replace(/\n/g, " ").slice(0, 90);
  console.log(`${prefix} ${kind.padEnd(10)} ${short}`);
};

let streamBuf = "";
let doneFired = false;
let doneFinal = null;

const ws = new WebSocket(SERVER_URL);
const finish = (reason) => {
  if (doneFired) return;
  doneFired = true;
  try { ws.close(); } catch {}
  const out = [];
  out.push(`# presence 对话记录  query=${TEXT}`);
  out.push(`# user: ${TEXT}`);
  for (const l of lines) out.push(`[+${l.at}ms] ${l.kind}: ${l.text}`);
  if (streamBuf) out.push(`[stream 累积正文]: ${streamBuf}`);
  if (doneFinal !== null) out.push(`[assistant_done finalText]: ${doneFinal}`);
  out.push(`# 结束原因: ${reason}`);
  writeFileSync(OUT_FILE, out.join("\n") + "\n", "utf8");
  console.log(`\n已写入 ${OUT_FILE}`);
  process.exit(0);
};

const timeout = setTimeout(() => finish("90s 超时"), 90_000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
  setTimeout(() => {
    push("USER", TEXT);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: { text: TEXT, messageId: msgId, sessionId: userId, userId, timestamp: new Date().toISOString() },
    }));
  }, 300);
});

ws.on("message", (raw) => {
  let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
  const t = ev.type;
  const p = ev.payload ?? {};
  if (p.traceId && p.traceId !== msgId) return;

  switch (t) {
    case "chat.message_received":
      if (p.messageId === msgId) push("ack", "服务端已接收");
      break;
    case "chat.assistant_chunk": {
      const chunk = p.chunk ?? "";
      if (!chunk) break;
      if (p.phase === "interim") push("interim垫词", chunk);
      else streamBuf += chunk;
      break;
    }
    case "chat.agent_status":
      if (p.line) push("status", p.line);
      break;
    case "tool.call":
      push("tool.start", `${p.toolName} input=${JSON.stringify(p.input ?? {}).slice(0, 120)}`);
      break;
    case "tool.result":
      push("tool.end", `${p.toolName} ok=${p.ok}`);
      break;
    case "chat.assistant_done":
      if (p.traceId === msgId) {
        doneFinal = p.finalText ?? "";
        push("done", `finalText(${doneFinal.length}字)`);
        clearTimeout(timeout);
        finish("assistant_done");
      }
      break;
    case "error":
    case "error.event":
    case "error_event":
      push("ERROR", `${p.code ?? ""} ${p.message ?? ""}`);
      clearTimeout(timeout);
      finish("error");
      break;
    default:
      break;
  }
});

ws.on("error", (e) => { push("WS-ERR", e.message); finish("ws error"); });
ws.on("close", () => { if (!doneFired) finish("连接关闭"); });
