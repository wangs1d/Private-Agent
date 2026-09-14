/**
 * realtime 链路冒烟测试（P3a）：向运行中的 server 发送黄金问题集，
 * 断言每个问题的轮次都触发了前置搜索（日志「前置检索证据已注入」计数递增）。
 * 不断言具体回答内容（事实会漂移），只锁「必真搜」的结构性保证。
 *
 * 用法: node scripts/smoke-realtime.mjs [日志文件路径]（默认 server/pai_test_run.log）
 * 退出码：0=全部通过；1=有问题未触发搜索（回归！）；2=连接失败。
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const logPath = process.argv[2] ?? "pai_test_run.log";
const url = "ws://127.0.0.1:3000/ws";
const sessionId = process.env.SMOKE_SESSION ?? "session-mvp-001";
const QUESTIONS = ["她最近在那", "比特币现在多少钱一个", "今天有什么大新闻"];

const countEvidence = () => {
  try {
    return (readFileSync(logPath, "utf8").match(/前置检索证据已注入/g) ?? []).length;
  } catch {
    return 0;
  }
};

function ask(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timeout"));
    }, 90_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId } }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: { sessionId, messageId: `msg-smoke-${Date.now()}`, text, timestamp: new Date().toISOString() },
        }));
      }, 800);
    });
    ws.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt?.type === "chat.assistant_done") {
          clearTimeout(timer);
          ws.close();
          resolve(String(evt.payload?.finalText ?? ""));
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const baseline = countEvidence();
console.log(`[smoke] 证据注入基线计数: ${baseline}`);
let failed = 0;
for (const q of QUESTIONS) {
  const before = countEvidence();
  try {
    await ask(q);
  } catch (e) {
    console.log(`✖ "${q}" 轮次失败: ${e.message}`);
    failed += 1;
    continue;
  }
  const after = countEvidence();
  const ok = after > before;
  console.log(`${ok ? "✔" : "✖"} "${q}" 证据注入 ${before} → ${after}`);
  if (!ok) failed += 1;
}
const total = countEvidence() - baseline;
console.log(`\n[smoke] ${QUESTIONS.length - failed}/${QUESTIONS.length} 通过，共 ${total} 次前置检索`);
process.exit(failed > 0 ? 1 : 0);
