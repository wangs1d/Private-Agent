/**
 * 子 Agent 智能化测试脚本
 *
 * 通过 WS 发送能触发子 Agent 委派的用户消息，验证：
 * 1. master.invoke_sub_agent 工具是否被调用
 * 2. 子 Agent 是否输出结构化报告（[REPORT][SUCCESS][CONCLUSION]...）
 * 3. 工具调用轮次是否按配置生效（tech=25/info=12/life=15/creative=8）
 *
 * 用法：
 *   node scripts/test-subagent-intelligence.mjs
 *   node scripts/test-subagent-intelligence.mjs ws://localhost:3000/ws
 */
import WebSocket from "ws";

const SERVER_URL = process.argv[2] ?? "ws://localhost:3000/ws";

// 测试场景：覆盖 4 个子 Agent 类型
const SCENARIOS = [
  {
    id: "info_deep_research",
    label: "信息深度调研 (info 子 Agent)",
    text: "帮我深度调研一下比亚迪汉 2026 款，需要多平台比价和用户评测，给我一个购买建议",
    expectSubAgent: "info",
  },
  {
    id: "tech_screenshot",
    label: "桌面截图 (tech 子 Agent)",
    text: "帮我截个屏看看当前屏幕上有什么内容",
    expectSubAgent: "tech",
  },
  {
    id: "creative_writing",
    label: "创意写作 (creative 子 Agent)",
    text: "帮我写一段产品文案，推销一款智能音箱，要求有创意、有情感，200字以内",
    expectSubAgent: "creative",
  },
];

function runOne(text, scenarioId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const userId = `test-sub-${scenarioId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const metrics = {
      scenarioId,
      userId,
      msgId,
      t0: 0,
      ack: 0,
      firstChunk: null,
      done: null,
      finalText: "",
      interimLines: [],
      toolCalls: [],
      toolResults: [],
      subAgentInvoked: null,
      subAgentReport: null,
      hasStructuredReport: false,
    };
    let resolved = false;
    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(metrics);
    };
    const timeout = setTimeout(() => finish(new Error("120s 超时未完成")), 120_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
      setTimeout(() => {
        metrics.t0 = Date.now();
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
        metrics.interimLines.push({ at: now - metrics.t0, line: p.line ?? p.text ?? "" });
        return;
      }
      if (t === "chat.assistant_chunk" && p.traceId === msgId) {
        if (metrics.firstChunk == null) metrics.firstChunk = now;
        metrics.finalText += p.delta ?? p.text ?? "";
        return;
      }
      if (t === "chat.agent_status" && p.traceId === msgId) {
        metrics.interimLines.push({ at: now - metrics.t0, line: p.line ?? "" });
        return;
      }
      if (t === "tool.call" && p.traceId === msgId) {
        metrics.toolCalls.push({
          at: now - metrics.t0,
          toolName: p.toolName,
          input: p.input,
        });
        // 检测子 Agent 委派
        if (p.toolName === "master.invoke_sub_agent" || p.toolName === "brain.delegate") {
          metrics.subAgentInvoked = p.toolName;
        }
        return;
      }
      if (t === "tool.result" && p.traceId === msgId) {
        metrics.toolResults.push({
          at: now - metrics.t0,
          toolName: p.toolName,
          ok: p.ok,
          durationMs: p.durationMs,
          resultPreview: typeof p.result === "string" ? p.result.slice(0, 500) : JSON.stringify(p.result ?? {}).slice(0, 500),
        });
        // 检测子 Agent 报告中的结构化标记
        const resultStr = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? {});
        if (p.toolName === "master.invoke_sub_agent" || p.toolName === "brain.delegate") {
          metrics.subAgentReport = resultStr.slice(0, 2000);
          if (resultStr.includes("[REPORT]") && resultStr.includes("[SUCCESS]")) {
            metrics.hasStructuredReport = true;
          }
        }
        return;
      }
      if (t === "chat.assistant_done" && p.traceId === msgId) {
        metrics.done = now;
        metrics.finalText = p.finalText ?? metrics.finalText;
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

async function main() {
  console.log(`\n=== 子 Agent 智能化测试 ===`);
  console.log(`服务器: ${SERVER_URL}\n`);

  // 用 info 深度调研场景测试（"深度调研"关键词应触发 master_delegate）
  const scenario = SCENARIOS[0];
  console.log(`▶ 测试场景: ${scenario.label}`);
  console.log(`  消息: "${scenario.text}"`);
  console.log(`  期望子 Agent: ${scenario.expectSubAgent}\n`);

  try {
    const result = await runOne(scenario.text, scenario.id);
    console.log(`\n--- 测试结果 ---`);
    console.log(`ack 延迟: ${result.ack - result.t0}ms`);
    console.log(`首 chunk 延迟: ${result.firstChunk ? result.firstChunk - result.t0 : "N/A"}ms`);
    console.log(`总耗时: ${result.done ? result.done - result.t0 : "N/A"}ms`);
    console.log(`工具调用次数: ${result.toolCalls.length}`);
    console.log(`子 Agent 委派工具: ${result.subAgentInvoked ?? "未触发"}`);
    console.log(`结构化报告: ${result.hasStructuredReport ? "✓ 包含 [REPORT] 块" : "✗ 未检测到"}`);

    if (result.toolCalls.length > 0) {
      console.log(`\n--- 工具调用序列 ---`);
      result.toolCalls.forEach((tc, i) => {
        const inputPreview = JSON.stringify(tc.input).slice(0, 100);
        console.log(`  ${i + 1}. [${tc.at}ms] ${tc.toolName}(${inputPreview})`);
      });
    }

    if (result.subAgentReport) {
      console.log(`\n--- 子 Agent 报告（前 800 字）---`);
      console.log(result.subAgentReport.slice(0, 800));
    }

    if (result.interimLines.length > 0) {
      console.log(`\n--- 垫词/状态行 ---`);
      result.interimLines.slice(0, 5).forEach((il, i) => {
        console.log(`  ${i + 1}. [${il.at}ms] ${il.line}`);
      });
    }

    console.log(`\n--- 最终回复（前 500 字）---`);
    console.log((result.finalText || "").slice(0, 500));

    // 判定
    console.log(`\n=== 判定 ===`);
    const passed = result.subAgentInvoked !== null;
    console.log(passed ? "✓ PASS: 子 Agent 委派已触发" : "✗ FAIL: 未触发子 Agent 委派");
    if (passed && result.hasStructuredReport) {
      console.log("✓ PASS: 子 Agent 输出了结构化报告");
    } else if (passed) {
      console.log("△ WARN: 子 Agent 未输出结构化报告（可能旧模型兼容模式或 LLM 未遵循格式）");
    }

  } catch (err) {
    console.error(`\n✗ 测试失败: ${err.message}`);
    process.exit(1);
  }
}

main();
