/**
 * 多场景路由通道压测脚本：验证不同类型消息是否进入正确的处理通道。
 *
 * 用法：
 *   node scripts/stress-routing-channels.mjs [并发数] [每条重复次数] [服务器URL]
 *
 * 检测维度：
 *   1. fallback 命中率（"无法生成回复" / 超时 / 空响应）
 *   2. 路由通道推断（基于 execution_event 数量 + 延迟 + chunk 数）：
 *      - direct:   无 execution_event + 快速响应 → fast_chat/direct_llm（直答通道）
 *      - master:   少量 execution_event + 中等延迟 → master_only（主 Agent 工具通道）
 *      - delegate: 大量 execution_event + 长延迟 → master_delegate（子 Agent 委派通道）
 *   3. 每个场景的期望通道 vs 实际通道匹配度
 *
 * 场景分组（期望通道）：
 *   - 寒暄/简单问答 → 期望 direct（直答）
 *   - 知识问答 → 期望 direct（直答，LLM 参数化知识够）
 *   - 模糊追问 → 期望 direct（依赖上下文，轻量回复）
 *   - 工具任务 → 期望 master 或 delegate（需要工具/子 Agent）
 *   - 复杂任务 → 期望 delegate（需要子 Agent 委派）
 */

import WebSocket from "ws";

const CONCURRENCY = parseInt(process.argv[2] ?? "3", 10);
const REPEAT = parseInt(process.argv[3] ?? "2", 10);
const SERVER_URL = process.argv[4] ?? "ws://localhost:3001/ws";

// 场景定义：tag / text / 期望通道
// expectedLane: "direct" | "master" | "delegate" | "any_tool"（master 或 delegate 都可）
const SCENARIOS = [
  // ── 寒暄类（期望 direct）──
  { group: "greeting", tag: "hello", text: "你好", expected: "direct" },
  { group: "greeting", tag: "thanks", text: "谢谢", expected: "direct" },
  { group: "greeting", tag: "bye", text: "再见", expected: "direct" },
  { group: "greeting", tag: "whoareyou", text: "你是谁", expected: "direct" },

  // ── 模糊追问/超短消息（期望 direct）──
  { group: "ambiguous", tag: "en", text: "嗯", expected: "direct" },
  { group: "ambiguous", tag: "ok", text: "好的", expected: "direct" },
  { group: "ambiguous", tag: "then", text: "然后呢", expected: "direct" },
  { group: "ambiguous", tag: "why", text: "为什么", expected: "direct" },

  // ── 知识问答（期望 direct）──
  { group: "knowledge", tag: "ai", text: "什么是人工智能？", expected: "direct" },
  { group: "knowledge", tag: "math", text: "1+1等于几？", expected: "direct" },
  { group: "knowledge", tag: "solar", text: "太阳系有几颗行星？", expected: "direct" },
  { group: "knowledge", tag: "history", text: "中国第一个皇帝是谁？", expected: "direct" },

  // ── 工具任务（期望 master 或 delegate）──
  { group: "tool", tag: "weather", text: "今天天气怎么样？", expected: "any_tool" },
  { group: "tool", tag: "time", text: "现在几点了？", expected: "any_tool" },
  { group: "tool", tag: "search", text: "帮我搜索一下最新的AI新闻", expected: "any_tool" },

  // ── 复杂任务（期望 delegate）──
  { group: "complex", tag: "compare", text: "帮我对比一下 MacBook Pro 和 ThinkPad 的优缺点，做个详细评测", expected: "delegate" },
  { group: "complex", tag: "plan", text: "帮我策划一个三天的北京旅游攻略，包括景点、美食和住宿", expected: "delegate" },
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

/**
 * 推断路由通道：基于 execution_event 数量 + 延迟 + chunk 数
 * - direct:   executionEvent=0 + doneLatency<4000ms → fast_chat/direct_llm
 * - master:   executionEvent 1-8 + doneLatency 3000-12000ms → master_only
 * - delegate: executionEvent>8 或 doneLatency>12000ms → master_delegate
 */
function inferLane(metrics) {
  const execCount = metrics.executionEventCount;
  const doneLat = metrics.doneLatencyMs ?? 999999;
  const chunkCount = metrics.chunkCount;

  // 无工具执行事件 + 快速响应 + 有文本 → 直答通道
  if (execCount === 0 && doneLat < 4000 && chunkCount > 0) return "direct";
  // 少量工具事件 + 中等延迟 → 主 Agent 工具通道
  if (execCount > 0 && execCount <= 8 && doneLat < 12000) return "master";
  // 大量工具事件 或 超长延迟 → 子 Agent 委派通道
  if (execCount > 8 || doneLat >= 12000) return "delegate";
  // 兜底：有工具事件但延迟短 → master
  if (execCount > 0) return "master";
  return "direct";
}

function laneMatches(actual, expected) {
  if (expected === "any_tool") return actual === "master" || actual === "delegate";
  return actual === expected;
}

function runClient(clientId, userId, scenario) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SERVER_URL);
    const msgId = `rt-${clientId}-${scenario.tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sendTime = { msgSent: 0 };
    const metrics = {
      clientId,
      userId,
      tag: scenario.tag,
      group: scenario.group,
      expected: scenario.expected,
      msgText: scenario.text,
      msgId,
      connected: false,
      ackReceived: false,
      ackLatencyMs: null,
      firstChunkLatencyMs: null,
      doneLatencyMs: null,
      chunkCount: 0,
      executionEventCount: 0,
      finalText: "",
      error: null,
      isFallback: false,
      inferredLane: null,
      laneCorrect: false,
    };

    const timeout = setTimeout(() => {
      if (metrics.doneLatencyMs === null) {
        metrics.error = "超时（90s 未完成）";
        metrics.isFallback = true;
        metrics.inferredLane = inferLane(metrics);
        metrics.laneCorrect = laneMatches(metrics.inferredLane, scenario.expected);
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
            text: scenario.text,
            messageId: msgId,
            sessionId: userId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }));
      }, 400);
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

      if (t === "chat.message_received" && p.messageId === msgId) {
        metrics.ackReceived = true;
        metrics.ackLatencyMs = Date.now() - sendTime.msgSent;
        return;
      }
      // 统计工具执行事件（各种执行相关事件）
      if (t.includes("execution") || t.includes("tool") || t.includes("delegate") || t.includes("sub_agent") || t.includes("subagent")) {
        if (t !== "chat.assistant_chunk") metrics.executionEventCount++;
      }
      if (t === "chat.assistant_chunk" && p.traceId === msgId) {
        metrics.chunkCount++;
        if (metrics.firstChunkLatencyMs === null) {
          metrics.firstChunkLatencyMs = Date.now() - sendTime.msgSent;
        }
        return;
      }
      if (t === "chat.assistant_done" && p.traceId === msgId) {
        metrics.doneLatencyMs = Date.now() - sendTime.msgSent;
        metrics.finalText = p.finalText ?? "";
        if (isFallbackText(metrics.finalText)) {
          metrics.isFallback = true;
        }
        metrics.inferredLane = inferLane(metrics);
        metrics.laneCorrect = laneMatches(metrics.inferredLane, scenario.expected);
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(metrics);
        return;
      }
      if (t === "error" || t === "error_event" || t === "error.event") {
        if (p.code === "SESSION_REQUIRED" || p.code === "BAD_SESSION_INIT") return;
        metrics.error = `${p.code ?? "unknown"}: ${p.message ?? ""}`;
        metrics.isFallback = true;
        metrics.inferredLane = inferLane(metrics);
        metrics.laneCorrect = laneMatches(metrics.inferredLane, scenario.expected);
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
      metrics.inferredLane = inferLane(metrics);
      metrics.laneCorrect = laneMatches(metrics.inferredLane, scenario.expected);
      resolve(metrics);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (metrics.doneLatencyMs === null && !metrics.error) {
        metrics.error = "连接关闭但未完成";
        metrics.isFallback = true;
      }
      metrics.inferredLane = inferLane(metrics);
      metrics.laneCorrect = laneMatches(metrics.inferredLane, scenario.expected);
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
  console.log("  多场景路由通道压测");
  console.log("───────────────────────────────────────────────────");
  console.log(`  并发数:       ${CONCURRENCY}`);
  console.log(`  每条重复:     ${REPEAT}`);
  console.log(`  服务器:       ${SERVER_URL}`);
  console.log(`  场景数:       ${SCENARIOS.length}`);
  console.log(`  总请求数:     ${SCENARIOS.length * REPEAT}`);
  console.log("═══════════════════════════════════════════════════\n");

  const allTasks = [];
  let clientId = 0;
  for (const sc of SCENARIOS) {
    for (let r = 0; r < REPEAT; r++) {
      clientId++;
      allTasks.push({ sc, clientId });
    }
  }

  const results = [];
  const t0 = Date.now();
  let cursor = 0;
  async function worker() {
    while (cursor < allTasks.length) {
      const idx = cursor++;
      const { sc, clientId } = allTasks[idx];
      const userId = `rt-user-${clientId}`;
      const res = await runClient(clientId, userId, sc);
      results.push(res);
      const flag = res.isFallback ? "FALLBACK" : "OK";
      const laneFlag = res.laneCorrect ? "LANE_OK" : "LANE_WRONG";
      const txt = (res.finalText || res.error || "").slice(0, 35);
      console.log(
        `  [#${String(clientId).padStart(3)}] ${flag.padEnd(8)} ${laneFlag.padEnd(10)} ` +
        `${sc.group.padEnd(10)}/${sc.tag.padEnd(10)} ` +
        `${(res.inferredLane ?? "?").padEnd(8)} (exp ${sc.expected.padEnd(8)}) ` +
        `done=${res.doneLatencyMs ?? "-"}ms exec=${res.executionEventCount} :: ${txt}`,
      );
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  const totalTime = Date.now() - t0;

  // === 汇总 ===
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  汇总报告");
  console.log("═══════════════════════════════════════════════════\n");

  const total = results.length;
  const fallbacks = results.filter((r) => r.isFallback);
  const oks = results.filter((r) => !r.isFallback);
  const laneOks = results.filter((r) => r.laneCorrect);
  console.log(`  总请求:           ${total}`);
  console.log(`  成功:             ${oks.length} (${((oks.length / total) * 100).toFixed(1)}%)`);
  console.log(`  Fallback:         ${fallbacks.length} (${((fallbacks.length / total) * 100).toFixed(1)}%)`);
  console.log(`  路由通道正确:     ${laneOks.length}/${total} (${((laneOks.length / total) * 100).toFixed(1)}%)`);
  console.log(`  总耗时:           ${totalTime}ms`);

  // 按场景分组统计
  console.log("\n── 按场景分组的路由通道分布 ──────────────────────");
  const groups = new Map();
  for (const r of results) {
    const key = `${r.group}/${r.tag}`;
    if (!groups.has(key)) groups.set(key, { total: 0, fallback: 0, lanes: {}, laneCorrect: 0, samples: [] });
    const g = groups.get(key);
    g.total++;
    if (r.isFallback) g.fallback++;
    const lane = r.inferredLane ?? "unknown";
    g.lanes[lane] = (g.lanes[lane] ?? 0) + 1;
    if (r.laneCorrect) g.laneCorrect++;
    if (g.samples.length < 1) {
      g.samples.push({ text: r.finalText.slice(0, 60), exec: r.executionEventCount, done: r.doneLatencyMs });
    }
  }
  console.log("  场景".padEnd(30) + "期望".padEnd(10) + "实际分布".padEnd(28) + "正确率".padEnd(10) + "FB".padEnd(6) + "样本");
  for (const [key, g] of groups) {
    const laneStr = Object.entries(g.lanes).map(([l, c]) => `${l}:${c}`).join(" ");
    const correctRate = ((g.laneCorrect / g.total) * 100).toFixed(0);
    const sample = g.samples[0];
    const expectedLane = SCENARIOS.find((s) => `${s.group}/${s.tag}` === key)?.expected ?? "?";
    console.log(
      `  ${key.padEnd(28)} ${expectedLane.padEnd(10)}` +
      `${laneStr.padEnd(26)} ${(correctRate + "%").padEnd(8)} ${String(g.fallback).padEnd(4)}` +
      ` exec=${sample?.exec} done=${sample?.done}ms`,
    );
  }

  // 按组别汇总
  console.log("\n── 按组别汇总 ────────────────────────────────────");
  const byGroup = new Map();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, { total: 0, fallback: 0, laneCorrect: 0, lanes: {} });
    const g = byGroup.get(r.group);
    g.total++;
    if (r.isFallback) g.fallback++;
    if (r.laneCorrect) g.laneCorrect++;
    const lane = r.inferredLane ?? "unknown";
    g.lanes[lane] = (g.lanes[lane] ?? 0) + 1;
  }
  for (const [group, g] of byGroup) {
    const laneStr = Object.entries(g.lanes).map(([l, c]) => `${l}:${c}`).join(" ");
    const correctRate = ((g.laneCorrect / g.total) * 100).toFixed(0);
    const fbRate = ((g.fallback / g.total) * 100).toFixed(0);
    console.log(`  ${group.padEnd(12)} 总=${g.total} 正确率=${correctRate}% FB=${g.fallback}(${fbRate}%) 通道=[${laneStr}]`);
  }

  // 延迟分布
  const doneLat = oks.map((r) => r.doneLatencyMs).filter((v) => v != null);
  if (doneLat.length > 0) {
    console.log("\n── 成功请求延迟分布 ──────────────────────────────");
    console.log(`  min=${Math.min(...doneLat)}ms p50=${percentile(doneLat, 50)}ms p95=${percentile(doneLat, 95)}ms max=${Math.max(...doneLat)}ms`);
  }

  // 路由错误样本
  const laneWrongs = results.filter((r) => !r.laneCorrect && !r.isFallback);
  if (laneWrongs.length > 0) {
    console.log(`\n── 路由通道错误样本（${laneWrongs.length} 条，最多展示 5 条）──`);
    laneWrongs.slice(0, 5).forEach((r, i) => {
      console.log(`  [${i + 1}] ${r.group}/${r.tag} 期望=${r.expected} 实际=${r.inferredLane} exec=${r.executionEventCount} done=${r.doneLatencyMs}ms`);
      console.log(`      文本="${r.finalText.slice(0, 80)}"`);
    });
  }

  // Fallback 样本
  if (fallbacks.length > 0) {
    console.log(`\n── Fallback 样本（${fallbacks.length} 条，最多展示 5 条）──`);
    fallbacks.slice(0, 5).forEach((r, i) => {
      console.log(`  [${i + 1}] ${r.group}/${r.tag} error=${r.error ?? "无"} 文本="${r.finalText.slice(0, 80)}"`);
    });
  }

  console.log("\n═══════════════════════════════════════════════════\n");
  process.exit(fallbacks.length > 0 || laneOks.length < total ? 1 : 0);
}

main().catch((e) => {
  console.error("压测脚本异常:", e);
  process.exit(1);
});
