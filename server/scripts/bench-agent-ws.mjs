/**
 * Agent 响应速度基准测试（端到端 WS 协议层）
 *
 * 覆盖两种典型路径：
 *   A. 正常对话（fast_chat / direct_llm，无工具）
 *   B. 后台工具调用（master_delegate / plan_execute / direct_llm + tool）
 *
 * 指标（相对 t0 = 用户消息发送时刻）：
 *   - ack_latency         : chat.message_received 延迟（应 < 5ms）
 *   - interim_latency     : chat.assistant_interim 延迟（仅工具任务，应 50~200ms）
 *   - ttft                : 首个 chat.assistant_chunk 延迟
 *   - tool_call_latency   : tool.call → tool.result 的工具执行耗时
 *   - total_latency       : chat.assistant_done 总耗时
 *
 * 用法：
 *   node scripts/bench-agent-ws.mjs
 *   node scripts/bench-agent-ws.mjs ws://localhost:3000/ws
 *   node scripts/bench-agent-ws.mjs ws://localhost:3000/ws 3   # 每个场景跑 3 次
 */

import WebSocket from "ws";

const SERVER_URL = process.argv[2] ?? "ws://localhost:3000/ws";
const ROUNDS = Number.parseInt(process.argv[3] ?? "3", 10);

const HTTP_BASE = SERVER_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

// 6 个典型场景：覆盖 fast_chat / direct_llm / 工具调用 / 多步任务
const SCENARIOS = [
  {
    id: "S1_greeting",
    label: "寒暄 (fast_chat)",
    text: "你好",
    expectTool: false,
  },
  {
    id: "S2_general_qa",
    label: "通用问答 (direct_llm 无工具)",
    text: "用一句话介绍一下量子计算",
    expectTool: false,
  },
  {
    id: "S3_web_search",
    label: "联网搜索 (tool.search_web)",
    text: "帮我搜索一下 2026 年 AI 行业最新趋势",
    expectTool: true,
    expectToolName: "search_web",
  },
  {
    id: "S4_weather",
    label: "查天气 (tool.weather)",
    text: "北京明天天气怎么样",
    expectTool: true,
    expectToolName: "weather",
  },
  {
    id: "S5_code_run",
    label: "代码沙箱 (tool.code.run)",
    text: "用 Python 算一下 1 加到 100 的结果",
    expectTool: true,
    expectToolName: "code.run",
  },
  {
    id: "S6_multi_step",
    label: "多步任务 (plan_execute)",
    text: "先搜索一下今天的 AI 新闻，然后整理成三点摘要",
    expectTool: true,
  },
];

// ── 单次请求测量 ──────────────────────────────────────

function runOne(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const userId = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const t0 = { sent: 0 };
    const metrics = {
      t0: 0,
      ack: 0,
      interim: null,
      firstChunk: null,
      lastChunk: null,
      toolCalls: [],
      toolResults: [],
      done: null,
      finalText: null,
      agentStatusLines: [],
    };
    let resolved = false;
    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(metrics);
    };

    const timeout = setTimeout(() => finish(new Error("60s 超时未完成")), 60_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
      setTimeout(() => {
        t0.sent = Date.now();
        metrics.t0 = t0.sent;
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: {
            text,
            messageId: msgId,
            sessionId: userId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }));
      }, 300);
    });

    ws.on("message", (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      const t = event.type;
      const p = event.payload ?? {};
      const now = Date.now();

      if (t === "chat.message_received" && p.messageId === msgId) {
        metrics.ack = now;
        return;
      }
      if (t === "chat.assistant_interim" && p.traceId === msgId) {
        if (metrics.interim == null) metrics.interim = now;
        return;
      }
      if (t === "chat.assistant_chunk" && p.traceId === msgId) {
        if (metrics.firstChunk == null) metrics.firstChunk = now;
        metrics.lastChunk = now;
        return;
      }
      if (t === "chat.agent_status" && p.traceId === msgId) {
        metrics.agentStatusLines.push({ at: now - t0.sent, line: p.line });
        return;
      }
      if (t === "tool.call" && p.traceId === msgId) {
        metrics.toolCalls.push({ at: now - t0.sent, toolName: p.toolName, input: p.input });
        return;
      }
      if (t === "tool.result" && p.traceId === msgId) {
        metrics.toolResults.push({
          at: now - t0.sent,
          toolName: p.toolName,
          ok: p.ok,
          durationMs: p.durationMs,
        });
        return;
      }
      if (t === "chat.assistant_done" && p.traceId === msgId) {
        metrics.done = now;
        metrics.finalText = p.finalText ?? "";
        clearTimeout(timeout);
        finish();
        return;
      }
      if (t === "error" || t === "error_event" || t === "error.event") {
        if (p.code === "SESSION_REQUIRED" || p.code === "BAD_SESSION_INIT") return;
        clearTimeout(timeout);
        finish(new Error(`${p.code ?? "unknown"}: ${p.message ?? ""}`));
      }
    });

    ws.on("error", (err) => { clearTimeout(timeout); finish(new Error(`WS 错误: ${err.message}`)); });
    ws.on("close", () => { clearTimeout(timeout); if (!resolved) finish(new Error("连接关闭但未完成")); });
  });
}

// ── 统计工具 ──────────────────────────────────────────

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(samples) {
  if (samples.length === 0) return null;
  return {
    n: samples.length,
    min: Math.min(...samples),
    p50: pct(samples, 50),
    p90: pct(samples, 90),
    max: Math.max(...samples),
    avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

function fmt(s) {
  if (!s) return "—";
  return `n=${s.n}  min=${s.min}ms  p50=${s.p50}ms  p90=${s.p90}ms  max=${s.max}ms  avg=${s.avg}ms`;
}

// ── 主流程 ──────────────────────────────────────────

async function checkHealth() {
  try {
    const res = await fetch(`${HTTP_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Agent 响应速度基准测试（端到端 WS 协议层）");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  服务器:     ${SERVER_URL}`);
  console.log(`  场景数:     ${SCENARIOS.length}`);
  console.log(`  每场景轮次: ${ROUNDS}`);
  console.log("════════════════════════════════════════════════════════════\n");

  const healthy = await checkHealth();
  if (!healthy) {
    console.error(`❌ 无法访问 ${HTTP_BASE}/health，请确认 server 已启动`);
    process.exit(1);
  }
  console.log("✓ Server 健康检查通过\n");

  const reportRows = [];

  for (const sc of SCENARIOS) {
    console.log(`▶ 场景 ${sc.id}: ${sc.label}`);
    console.log(`  输入: "${sc.text}"`);

    const samples = {
      ack: [],
      interim: [],
      ttft: [],
      toolCallGap: [],
      total: [],
      toolCount: [],
      chunkCount: [],
    };

    for (let r = 1; r <= ROUNDS; r++) {
      process.stdout.write(`  Round ${r}/${ROUNDS} ... `);
      try {
        const m = await runOne(sc.text);
        const ack = m.ack - m.t0;
        const ttft = m.firstChunk ? m.firstChunk - m.t0 : null;
        const total = m.done - m.t0;
        const interim = m.interim ? m.interim - m.t0 : null;

        samples.ack.push(ack);
        if (interim != null) samples.interim.push(interim);
        if (ttft != null) samples.ttft.push(ttft);
        samples.total.push(total);
        samples.toolCount.push(m.toolCalls.length);
        samples.chunkCount.push(
          m.lastChunk && m.firstChunk
            ? Math.max(1, Math.round((m.lastChunk - m.firstChunk) / 50))
            : 0
        );

        // 工具执行耗时（如果有多次 tool.result，按每一次记）
        for (const tr of m.toolResults) {
          if (typeof tr.durationMs === "number") {
            samples.toolCallGap.push(tr.durationMs);
          }
        }

        const toolSummary = m.toolCalls.length
          ? `tools=[${m.toolCalls.map((tc) => tc.toolName).join(",")}]`
          : "no-tool";
        console.log(`ack=${ack}ms  ttft=${ttft ?? "—"}ms  total=${total}ms  ${toolSummary}`);
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
      // 避免打满 Moonshot 限流
      await new Promise((r) => setTimeout(r, 1500));
    }

    const row = {
      id: sc.id,
      label: sc.label,
      expectTool: sc.expectTool,
      ack: summarize(samples.ack),
      interim: summarize(samples.interim),
      ttft: summarize(samples.ttft),
      toolExec: summarize(samples.toolCallGap),
      total: summarize(samples.total),
      toolCount: summarize(samples.toolCount),
    };
    reportRows.push(row);

    console.log(`  ── 汇总（${ROUNDS} 轮）──`);
    console.log(`  ack 延迟:    ${fmt(row.ack)}`);
    if (row.interim) console.log(`  interim 延迟: ${fmt(row.interim)}`);
    console.log(`  TTFT:        ${fmt(row.ttft)}`);
    if (row.toolExec) console.log(`  工具执行:    ${fmt(row.toolExec)}`);
    console.log(`  总耗时:      ${fmt(row.total)}`);
    console.log("");
  }

  // ── 汇总表 ────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  汇总报告");
  console.log("════════════════════════════════════════════════════════════\n");
  console.log(
    "场景".padEnd(30) +
    "ack p50".padEnd(12) +
    "interim p50".padEnd(14) +
    "TTFT p50".padEnd(12) +
    "工具 p50".padEnd(12) +
    "总 p50".padEnd(12) +
    "工具数".padEnd(8)
  );
  console.log("─".repeat(100));
  for (const r of reportRows) {
    console.log(
      r.label.padEnd(30) +
      `${r.ack?.p50 ?? "—"}ms`.padEnd(12) +
      `${r.interim?.p50 ?? "—"}ms`.padEnd(14) +
      `${r.ttft?.p50 ?? "—"}ms`.padEnd(12) +
      `${r.toolExec?.p50 ?? "—"}ms`.padEnd(12) +
      `${r.total?.p50 ?? "—"}ms`.padEnd(12) +
      `${r.toolCount?.avg ?? 0}`.padEnd(8)
    );
  }
  console.log("");

  // ── 健康判定 ────────────────────────────────────────
  console.log("── 健康判定 ──────────────────────────────────────────────");
  const checks = [
    { name: "ack 延迟 < 50ms", pass: reportRows.every((r) => r.ack && r.ack.p50 < 50) },
    { name: "寒暄场景 TTFT < 1500ms", pass: (() => {
      const s = reportRows.find((r) => r.id === "S1_greeting");
      return s?.ttft && s.ttft.p50 < 1500;
    })() },
    { name: "通用问答 TTFT < 2000ms", pass: (() => {
      const s = reportRows.find((r) => r.id === "S2_general_qa");
      return s?.ttft && s.ttft.p50 < 2000;
    })() },
    { name: "工具任务有 interim ack", pass: (() => {
      const toolScenarios = reportRows.filter((r) => r.expectTool);
      return toolScenarios.length > 0 && toolScenarios.every((r) => r.interim != null);
    })() },
    { name: "工具任务 TTFT < 5000ms", pass: (() => {
      const toolScenarios = reportRows.filter((r) => r.expectTool);
      return toolScenarios.every((r) => r.ttft && r.ttft.p50 < 5000);
    })() },
    { name: "无超时", pass: reportRows.every((r) => r.total != null) },
  ];
  for (const c of checks) {
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
  }
  console.log("");
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
