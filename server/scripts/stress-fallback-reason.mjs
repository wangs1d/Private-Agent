/**
 * Fallback 触发压测脚本：定位 agent "无法回复" 的根因。
 *
 * 用法：
 *   node scripts/stress-fallback-reason.mjs [并发数] [每条消息重复次数] [服务器URL]
 *
 * 检测的 fallback 信号：
 *   - finalText 包含 "抱歉，我暂时无法生成回复" / "无法生成回复" / "请稍后重试"
 *   - 未收到 assistant_done（超时）
 *   - 收到 error 事件
 *   - finalText 为空字符串
 *
 * 输出每类消息的 fallback 命中率 + 错误样本，便于定位根因。
 */

import WebSocket from "ws";

const CONCURRENCY = parseInt(process.argv[2] ?? "3", 10);
const REPEAT = parseInt(process.argv[3] ?? "3", 10);
const SERVER_URL = process.argv[4] ?? "ws://localhost:3000/ws";

// 测试用例：覆盖不同场景（简单对话 / 提问 / 模糊追问 / 工具触发 / 多轮上下文）
const TEST_MESSAGES = [
  { tag: "greeting", text: "你好" },
  { tag: "greeting2", text: "在吗" },
  { tag: "question", text: "什么是人工智能？请简短回答" },
  { tag: "question2", text: "1+1等于几" },
  { tag: "vague", text: "嗯" },
  { tag: "vague2", text: "好的" },
  { tag: "vague3", text: "那个" },
  { tag: "thanks", text: "谢谢" },
  { tag: "chitchat", text: "今天心情不太好" },
  { tag: "long", text: "请用三句话介绍一下太阳系，每句话不超过20个字" },
  // 新增：用户截图中的真实场景（信息查询类问题，LLM 训练截止后可能没有的数据）
  { tag: "info_query", text: "kimi最新的模型kimi3怎么样" },
  { tag: "info_query2", text: "最近一周AI领域有什么重要新闻？" },
  { tag: "info_query3", text: "今天北京天气怎么样" },
];

const FALLBACK_SIGNATURES = [
  "抱歉，我暂时无法生成回复",
  "无法生成回复",
  "请稍后重试",
  "暂时无法生成",
];

function isFallbackText(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  return FALLBACK_SIGNATURES.some((sig) => t.includes(sig));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runClient(clientId, userId, msgTag, msgText) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SERVER_URL);
    const msgId = `fb-${clientId}-${msgTag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sendTime = { msgSent: 0 };
    const metrics = {
      clientId,
      userId,
      msgTag,
      msgText,
      msgId,
      connected: false,
      ackReceived: false,
      ackLatencyMs: null,
      firstChunkLatencyMs: null,
      doneLatencyMs: null,
      chunkCount: 0,
      executionEventCount: 0,         // 工具执行事件数
      subAgentInvocationCount: 0,     // 子 Agent 委派事件数
      toolCallNames: [],              // 实际调用的工具名
      routeMode: null,                // 从后端日志/cognize 返回中读到的路由模式
      finalText: "",
      error: null,
      isFallback: false,
      events: [],
    };

    const timeout = setTimeout(() => {
      if (metrics.doneLatencyMs === null) {
        metrics.error = "超时（90s 未完成）";
        metrics.isFallback = true;
        try { ws.close(); } catch {}
        resolve(metrics);
      }
    }, 90_000);

    ws.on("open", () => {
      metrics.connected = true;
      ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
      setTimeout(() => {
        sendTime.msgSent = Date.now();
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: {
            text: msgText,
            messageId: msgId,
            sessionId: userId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }));
      }, 500);
    });

    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = event.type;
      const p = event.payload ?? {};
      metrics.events.push(t);

      if (t === "chat.message_received" && p.messageId === msgId) {
        metrics.ackReceived = true;
        metrics.ackLatencyMs = Date.now() - sendTime.msgSent;
        return;
      }
      if (t === "chat.assistant_chunk" && p.traceId === msgId) {
        metrics.chunkCount++;
        if (metrics.firstChunkLatencyMs === null) {
          metrics.firstChunkLatencyMs = Date.now() - sendTime.msgSent;
        }
        return;
      }
      // 路由模式（从后端元数据读）
      if (t === "chat.route_decided" || t === "chat.route_info" || t === "chat.routing") {
        if (p.mode && !metrics.routeMode) metrics.routeMode = p.mode;
        return;
      }
      // 子 Agent 委派事件
      if (t.includes("delegate") || t.includes("sub_agent") || t.includes("subagent") || t.includes("master.invoke_sub_agent")) {
        metrics.subAgentInvocationCount++;
        return;
      }
      // 工具执行事件
      if (t.includes("tool_call") || t.includes("tool_execution") || t.includes("tool.result") || t === "tool.call" || t === "tool.result" || t === "chat.tool_call" || t === "chat.tool_result") {
        metrics.executionEventCount++;
        const toolName = p.name || p.tool || p.toolName;
        if (toolName && !metrics.toolCallNames.includes(toolName)) {
          metrics.toolCallNames.push(toolName);
        }
        return;
      }
      if (t === "chat.assistant_done" && p.traceId === msgId) {
        metrics.doneLatencyMs = Date.now() - sendTime.msgSent;
        metrics.finalText = p.finalText ?? "";
        if (isFallbackText(metrics.finalText)) {
          metrics.isFallback = true;
        }
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(metrics);
        return;
      }
      if (t === "error" || t === "error_event" || t === "error.event") {
        if (p.code === "SESSION_REQUIRED" || p.code === "BAD_SESSION_INIT") return;
        metrics.error = `${p.code ?? "unknown"}: ${p.message ?? ""}`;
        metrics.isFallback = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(metrics);
      }
    });

    ws.on("error", (err) => {
      if (!metrics.connected) {
        metrics.error = `连接失败: ${err.message}`;
        metrics.isFallback = true;
      }
      clearTimeout(timeout);
      resolve(metrics);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (metrics.doneLatencyMs === null && !metrics.error) {
        metrics.error = "连接关闭但未完成";
        metrics.isFallback = true;
      }
      resolve(metrics);
    });
  });
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Fallback 触发压测");
  console.log("───────────────────────────────────────────────────");
  console.log(`  并发数:       ${CONCURRENCY}`);
  console.log(`  每条重复:     ${REPEAT}`);
  console.log(`  服务器:       ${SERVER_URL}`);
  console.log(`  测试用例数:   ${TEST_MESSAGES.length}`);
  console.log(`  总请求数:     ${TEST_MESSAGES.length * REPEAT}`);
  console.log("═══════════════════════════════════════════════════\n");

  const allTasks = [];
  let clientId = 0;
  // 按用例 × 重复构造任务，并发数受 CONCURRENCY 控制
  for (const tc of TEST_MESSAGES) {
    for (let r = 0; r < REPEAT; r++) {
      clientId++;
      allTasks.push({ tc, clientId });
    }
  }

  const results = [];
  const t0 = Date.now();
  // 简单并发池
  let cursor = 0;
  async function worker() {
    while (cursor < allTasks.length) {
      const idx = cursor++;
      const { tc, clientId } = allTasks[idx];
      const userId = `fb-user-${clientId}`;
      const res = await runClient(clientId, userId, tc.tag, tc.text);
      results.push(res);
      const flag = res.isFallback ? "FALLBACK" : "OK";
      const tools = res.toolCallNames.length > 0 ? `tools=[${res.toolCallNames.join(",")}]` : "";
      const sub = res.subAgentInvocationCount > 0 ? `sub=${res.subAgentInvocationCount}` : "";
      const txt = (res.finalText || res.error || "").slice(0, 30);
      console.log(
        `  [#${String(clientId).padStart(3)}] ${flag.padEnd(8)} ${tc.tag.padEnd(13)} ` +
        `done=${res.doneLatencyMs ?? "-"}ms exec=${res.executionEventCount} ${sub} ${tools} :: ${txt}`,
      );
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  const totalTime = Date.now() - t0;

  // 汇总
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  汇总报告");
  console.log("═══════════════════════════════════════════════════\n");

  const total = results.length;
  const fallbacks = results.filter((r) => r.isFallback);
  const oks = results.filter((r) => !r.isFallback);
  console.log(`  总请求:           ${total}`);
  console.log(`  成功:             ${oks.length} (${((oks.length / total) * 100).toFixed(1)}%)`);
  console.log(`  Fallback/失败:    ${fallbacks.length} (${((fallbacks.length / total) * 100).toFixed(1)}%)`);
  console.log(`  总耗时:           ${totalTime}ms`);

  // 按用例分组命中率
  console.log("\n── 按消息类型分组的 fallback 命中率 ──────────────");
  const byTag = new Map();
  for (const r of results) {
    if (!byTag.has(r.msgTag)) byTag.set(r.msgTag, { total: 0, fallback: 0, samples: [] });
    const g = byTag.get(r.msgTag);
    g.total++;
    if (r.isFallback) {
      g.fallback++;
      if (g.samples.length < 2) g.samples.push({ error: r.error, finalText: r.finalText.slice(0, 80), events: r.events });
    }
  }
  for (const [tag, g] of byTag) {
    const rate = ((g.fallback / g.total) * 100).toFixed(0);
    console.log(`  ${tag.padEnd(12)} ${g.fallback}/${g.total} (${rate}%)  样本: ${JSON.stringify(g.samples[0] ?? {}).slice(0, 200)}`);
  }

  // 错误类型分布
  console.log("\n── 失败原因分布 ──────────────────────────────────");
  const reasonMap = new Map();
  for (const r of fallbacks) {
    let reason;
    if (r.error?.includes("超时")) reason = "timeout";
    else if (r.error?.includes("连接失败")) reason = "connect_failed";
    else if (r.error?.includes("关闭但未完成")) reason = "closed_incomplete";
    else if (r.error) reason = "error_event";
    else if (isFallbackText(r.finalText) && !r.finalText.trim()) reason = "empty_finalText";
    else if (r.finalText.includes("无法生成回复")) reason = "fallback_text_explicit";
    else reason = "other";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of reasonMap) {
    console.log(`  ${reason.padEnd(28)} ${count}`);
  }

  // 延迟分布（仅成功）
  const doneLat = oks.map((r) => r.doneLatencyMs).filter((v) => v != null);
  if (doneLat.length > 0) {
    console.log("\n── 成功请求延迟分布 ──────────────────────────────");
    console.log(`  min=${Math.min(...doneLat)}ms p50=${percentile(doneLat, 50)}ms p95=${percentile(doneLat, 95)}ms max=${Math.max(...doneLat)}ms`);
  }

  // 采样几条 fallback 的完整文本
  console.log("\n── Fallback 样本（最多 5 条）──────────────────────");
  fallbacks.slice(0, 5).forEach((r, i) => {
    console.log(`  [样本${i + 1}] tag=${r.msgTag} error=${r.error ?? "无"}`);
    console.log(`         finalText="${r.finalText.slice(0, 120)}"`);
    console.log(`         chunks=${r.chunkCount} events=${r.events.join(",")}`);
  });

  console.log("\n═══════════════════════════════════════════════════\n");
  process.exit(fallbacks.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("压测脚本异常:", e);
  process.exit(1);
});
