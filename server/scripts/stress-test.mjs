/**
 * 高并发压测脚本：验证并发控制 + 回压 + 立即 ack 机制。
 *
 * 用法：
 *   node scripts/stress-test.mjs [并发连接数] [总消息数] [服务器URL] [消息文本]
 *
 * 默认：20 并发连接，20 条消息，ws://localhost:3000/ws，消息 "你好"
 *
 * 指标：
 *   - ack 延迟：从发送消息到收到 chat.message_received 的时间（应 < 5ms）
 *   - 首字延迟：从发送消息到收到第一个 chat.assistant_chunk 的时间
 *   - 完成延迟：从发送消息到收到 chat.assistant_done 的时间
 *   - 排队超时：收到"当前服务繁忙"的连接数
 *   - 并发快照：轮询 /system/concurrency 端点
 */

import WebSocket from "ws";

const CONCURRENCY = parseInt(process.argv[2] ?? "20", 10);
const TOTAL_MESSAGES = parseInt(process.argv[3] ?? String(CONCURRENCY), 10);
const SERVER_URL = process.argv[4] ?? "ws://localhost:3000/ws";
const MESSAGE_TEXT = process.argv[5] ?? "你好";
const HTTP_BASE = SERVER_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

console.log("═══════════════════════════════════════════════════");
console.log("  高并发压测");
console.log("───────────────────────────────────────────────────");
console.log(`  并发连接数:  ${CONCURRENCY}`);
console.log(`  总消息数:    ${TOTAL_MESSAGES}`);
console.log(`  服务器:      ${SERVER_URL}`);
console.log(`  消息文本:    ${MESSAGE_TEXT}`);
console.log(`  HTTP 监控:   ${HTTP_BASE}/system/concurrency`);
console.log("═══════════════════════════════════════════════════\n");

// ── 指标收集 ──────────────────────────────────────────

const results = [];
let concurrencyPollingActive = true;
const concurrencySnapshots = [];

async function pollConcurrency() {
  while (concurrencyPollingActive) {
    try {
      const res = await fetch(`${HTTP_BASE}/system/concurrency`);
      if (res.ok) {
        const data = await res.json();
        concurrencySnapshots.push({
          t: Date.now(),
          ...data,
        });
      }
    } catch {
      // 服务端可能未启动或端点不可用
    }
    await sleep(200);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 单客户端模拟 ──────────────────────────────────────

function runClient(clientId, userId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SERVER_URL);
    const msgId = `stress-${clientId}-${Date.now()}`;
    const sendTime = { msgSent: 0 };
    const metrics = {
      clientId,
      userId,
      msgId,
      connected: false,
      ackReceived: false,
      ackLatencyMs: null,
      firstChunkLatencyMs: null,
      doneLatencyMs: null,
      queued: false,
      error: null,
      finalText: null,
    };

    const timeout = setTimeout(() => {
      if (!metrics.doneLatencyMs) {
        metrics.error = "超时（60s 未完成）";
        try { ws.close(); } catch {}
        resolve(metrics);
      }
    }, 60_000);

    ws.on("open", () => {
      metrics.connected = true;
      // 1. 发送 session.init
      ws.send(JSON.stringify({
        type: "session.init",
        payload: { userId },
      }));
      // 服务端对普通 session.init 不发显式 ack，等待 500ms 让其处理完
      setTimeout(() => {
        sessionReady = true;
        // 2. 发送 chat.user_message，记录发送时间
        sendTime.msgSent = Date.now();
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: {
            text: MESSAGE_TEXT,
            messageId: msgId,
            sessionId: userId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }));
      }, 500);
    });

    let sessionReady = false;

    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const t = event.type;
      const p = event.payload ?? {};

      // 3. 收到 chat.message_received（立即 ack）
      if (t === "chat.message_received" && p.messageId === msgId) {
        metrics.ackReceived = true;
        metrics.ackLatencyMs = Date.now() - sendTime.msgSent;
        return;
      }

      // 4. 收到第一个 chat.assistant_chunk
      if (t === "chat.assistant_chunk" && p.traceId === msgId) {
        if (metrics.firstChunkLatencyMs === null) {
          metrics.firstChunkLatencyMs = Date.now() - sendTime.msgSent;
        }
        return;
      }

      // 5. 收到 chat.assistant_done
      if (t === "chat.assistant_done" && p.traceId === msgId) {
        metrics.doneLatencyMs = Date.now() - sendTime.msgSent;
        metrics.finalText = p.finalText ?? "";
        if (p.finalText?.includes("服务繁忙")) {
          metrics.queued = true;
        }
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(metrics);
        return;
      }

      // 错误事件
      if (t === "error" || t === "error_event" || t === "error.event") {
        if (p.code === "SESSION_REQUIRED" || p.code === "BAD_SESSION_INIT") {
          // session.init 可能需要重试
          return;
        }
        metrics.error = `${p.code ?? "unknown"}: ${p.message ?? ""}`;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(metrics);
      }
    });

    ws.on("error", (err) => {
      if (!metrics.connected) {
        metrics.error = `连接失败: ${err.message}`;
      }
      clearTimeout(timeout);
      resolve(metrics);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (!metrics.doneLatencyMs && !metrics.error) {
        metrics.error = "连接关闭但未完成";
      }
      resolve(metrics);
    });
  });
}

// ── 统计计算 ──────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function printStats(label, values) {
  if (values.length === 0) {
    console.log(`  ${label}: 无数据`);
    return;
  }
  const min = Math.min(...values);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `  ${label.padEnd(20)} min=${min.toFixed(0)}ms  p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  max=${max.toFixed(0)}ms  avg=${avg.toFixed(0)}ms`,
  );
}

// ── 主流程 ────────────────────────────────────────────

async function main() {
  console.log("启动并发监控轮询...\n");
  pollConcurrency();

  // 分批启动客户端，模拟并发涌入
  const batchSize = Math.min(CONCURRENCY, TOTAL_MESSAGES);
  console.log(`启动 ${batchSize} 个并发连接...\n`);

  const t0 = Date.now();
  const promises = [];

  for (let i = 0; i < TOTAL_MESSAGES; i++) {
    const clientId = i + 1;
    const userId = `stress-user-${clientId}`;
    promises.push(runClient(clientId, userId));

    // 控制并发涌入速率：每批同时启动
    if (promises.length >= batchSize) {
      // 等待当前批次完成或达到批次大小
    }
  }

  const allResults = await Promise.all(promises);
  const totalTime = Date.now() - t0;

  concurrencyPollingActive = false;

  // ── 汇总报告 ────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  压测结果汇总");
  console.log("═══════════════════════════════════════════════════\n");

  const connected = allResults.filter((r) => r.connected);
  const acked = allResults.filter((r) => r.ackReceived);
  const chunked = allResults.filter((r) => r.firstChunkLatencyMs !== null);
  const done = allResults.filter((r) => r.doneLatencyMs !== null);
  const queued = allResults.filter((r) => r.queued);
  const errors = allResults.filter((r) => r.error);

  console.log(`  总消息数:        ${TOTAL_MESSAGES}`);
  console.log(`  连接成功:        ${connected.length}/${TOTAL_MESSAGES}`);
  console.log(`  收到 ack:        ${acked.length}/${TOTAL_MESSAGES}`);
  console.log(`  收到首字:        ${chunked.length}/${TOTAL_MESSAGES}`);
  console.log(`  收到完成:        ${done.length}/${TOTAL_MESSAGES}`);
  console.log(`  排队超时(429):   ${queued.length}`);
  console.log(`  错误:            ${errors.length}`);
  console.log(`  总耗时:          ${totalTime}ms\n`);

  console.log("── 延迟分布 ──────────────────────────────────────");
  printStats("ack 延迟", acked.map((r) => r.ackLatencyMs).filter((v) => v !== null));
  printStats("首字延迟(TTFT)", chunked.map((r) => r.firstChunkLatencyMs).filter((v) => v !== null));
  printStats("完成延迟", done.filter((r) => !r.queued).map((r) => r.doneLatencyMs));
  if (queued.length > 0) {
    printStats("排队超时延迟", queued.map((r) => r.doneLatencyMs));
  }

  // 并发快照摘要
  if (concurrencySnapshots.length > 0) {
    const peakTurnActive = Math.max(...concurrencySnapshots.map((s) => s.globalTurn?.active ?? 0));
    const peakTurnQueued = Math.max(...concurrencySnapshots.map((s) => s.globalTurn?.queued ?? 0));
    const peakToolActive = Math.max(
      ...concurrencySnapshots.map((s) =>
        Object.values(s.tools ?? {}).reduce((sum, t) => sum + (t.active ?? 0), 0)
      )
    );
    console.log("\n── 并发控制峰值 ──────────────────────────────────");
    console.log(`  全局 turn 并发峰值:  ${peakTurnActive} (max: ${concurrencySnapshots[0]?.globalTurn?.max ?? "?"})`);
    console.log(`  全局 turn 排队峰值:  ${peakTurnQueued}`);
    console.log(`  工具并发执行峰值:    ${peakToolActive}`);
    console.log(`  采样次数:            ${concurrencySnapshots.length}`);
  }

  // 错误详情
  if (errors.length > 0) {
    console.log("\n── 错误详情（前 5 条）────────────────────────────");
    errors.slice(0, 5).forEach((r) => {
      console.log(`  client#${r.clientId}: ${r.error}`);
    });
  }

  // 排队超时详情
  if (queued.length > 0) {
    console.log(`\n── 排队超时 (429) 详情 ──────────────────────────`);
    console.log(`  ${queued.length} 个请求因超过 MAX_CONCURRENT_TURNS(${concurrencySnapshots[0]?.globalTurn?.max ?? 8}) 排队超时被拒绝`);
    console.log(`  这是预期行为：回压机制生效，防止服务过载`);
  }

  console.log("\n═══════════════════════════════════════════════════\n");

  // 退出码：如果有非排队超时的错误，返回 1
  const realErrors = errors.filter((r) => !r.queued);
  process.exit(realErrors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("压测脚本异常:", e);
  process.exit(1);
});
