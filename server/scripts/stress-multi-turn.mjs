/**
 * 多轮对话衔接压测
 * 验证追问场景下 Agent 能否正确理解上下文
 *
 * 用法: node scripts/stress-multi-turn.mjs [并发数] [重复次数] [ws_url]
 */
import WebSocket from "ws";

const CONCURRENCY = parseInt(process.argv[2] ?? "1", 10);
const REPEATS = parseInt(process.argv[3] ?? "1", 10);
const WS_URL = process.argv[4] ?? "ws://localhost:3000/ws";

// 多轮对话场景：每轮是连续的追问链
const MULTI_TURN_SCENARIOS = [
  {
    name: "kimi3 追问链",
    messages: [
      { tag: "kimi3_1", text: "kimi3性能怎么样" },
      { tag: "kimi3_2", text: "kimi的新模型啊" },
      { tag: "kimi3_3", text: "kimi3啊" },
    ],
  },
  {
    name: "天气追问链",
    messages: [
      { tag: "weather_1", text: "北京今天天气怎么样" },
      { tag: "weather_2", text: "那上海呢" },
      { tag: "weather_3", text: "明天呢" },
    ],
  },
  {
    name: "AI新闻追问链",
    messages: [
      { tag: "news_1", text: "最近AI有什么大新闻" },
      { tag: "news_2", text: "详细说说" },
      { tag: "news_3", text: "还有吗" },
    ],
  },
  {
    name: "寒暄+追问",
    messages: [
      { tag: "greet", text: "你好" },
      { tag: "follow1", text: "最近忙吗" },
      { tag: "follow2", text: "嗯嗯" },
    ],
  },
];

function makeClientId() {
  return `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function runMultiTurnScenario(ws, scenario, userId) {
  const results = [];
  // 每个场景开始前发 session.init
  ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
  await new Promise((r) => setTimeout(r, 300));
  for (const msg of scenario.messages) {
    const result = await new Promise((resolve) => {
      const msgId = `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sendTime = Date.now();
      let chunks = 0;
      let finalText = "";
      let firstChunkMs = null;
      let doneMs = null;
      let execCount = 0;
      let toolNames = [];

      const handler = (raw) => {
        let evt;
        try { evt = JSON.parse(raw); } catch { return; }
        const t = evt?.type;
        const p = evt?.payload ?? {};
        if (t === "chat.ack" && p.messageId === msgId) return;
        if (t === "chat.assistant_chunk" && p.traceId === msgId) {
          chunks++;
          if (firstChunkMs === null) firstChunkMs = Date.now() - sendTime;
          return;
        }
        if (t === "chat.assistant_done" && p.traceId === msgId) {
          doneMs = Date.now() - sendTime;
          finalText = p.finalText ?? "";
          ws.off("message", handler);
          resolve({
            tag: msg.tag,
            text: msg.text,
            chunks,
            firstChunkMs,
            doneMs,
            finalText,
            execCount,
            toolNames,
          });
          return;
        }
        // 工具执行事件
        if (t.includes("tool_call") || t.includes("tool.result") || t.includes("tool_execution")) {
          execCount++;
          const toolName = p.name || p.tool || p.toolName;
          if (toolName && !toolNames.includes(toolName)) toolNames.push(toolName);
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: {
          userId,
          messageId: msgId,
          sessionId: userId,
          text: msg.text,
          timestamp: new Date().toISOString(),
        },
      }));
      // 超时兜底
      setTimeout(() => {
        ws.off("message", handler);
        resolve({
          tag: msg.tag,
          text: msg.text,
          chunks,
          firstChunkMs,
          doneMs,
          finalText,
          execCount,
          toolNames,
          timeout: true,
        });
      }, 120000);
    });
    results.push(result);
    // 实时输出每轮结果
    const flag = result.timeout ? "TIMEOUT" : !result.finalText ? "EMPTY" : "OK";
    const tools = result.toolNames.length > 0 ? `tools=[${result.toolNames.join(",")}]` : "";
    const txt = (result.finalText || "(空)").slice(0, 60);
    console.log(
      `  [${scenario.name}] ${flag.padEnd(8)} ${result.tag.padEnd(12)} done=${result.doneMs ?? "-"}ms exec=${result.execCount} ${tools} :: ${txt}`,
    );
    // 每轮之间等 500ms，让 thread store 写入
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

async function runClient(clientId, userId) {
  const ws = await connectWs(WS_URL);
  const allResults = [];

  for (const scenario of MULTI_TURN_SCENARIOS) {
    const results = await runMultiTurnScenario(ws, scenario, userId);
    allResults.push({ scenario: scenario.name, results });
  }

  ws.close();
  return allResults;
}

async function main() {
  const totalRequests = CONCURRENCY * REPEATS * MULTI_TURN_SCENARIOS.reduce((s, sc) => s + sc.messages.length, 0);
  console.log("═══════════════════════════════════════════════════");
  console.log("  多轮对话衔接压测");
  console.log("───────────────────────────────────────────────────");
  console.log(`  并发数:       ${CONCURRENCY}`);
  console.log(`  每条重复:     ${REPEATS}`);
  console.log(`  服务器:       ${WS_URL}`);
  console.log(`  场景数:       ${MULTI_TURN_SCENARIOS.length}`);
  console.log(`  总请求数:     ${totalRequests}`);
  console.log("═══════════════════════════════════════════════════");
  console.log("");

  const allResults = [];
  const startTime = Date.now();

  const workers = [];
  for (let c = 0; c < CONCURRENCY; c++) {
    const clientId = makeClientId();
    const userId = `mt-user-${c}`;
    workers.push(
      (async () => {
        for (let r = 0; r < REPEATS; r++) {
          const results = await runClient(clientId, userId);
          allResults.push(...results);
        }
      })(),
    );
  }
  await Promise.all(workers);

  const totalMs = Date.now() - startTime;

  // 汇总
  let totalMsgs = 0;
  let totalTimeouts = 0;
  let totalFallbacks = 0;

  for (const entry of allResults) {
    console.log(`── ${entry.scenario} ──`);
    for (const r of entry.results) {
      totalMsgs++;
      if (r.timeout) totalTimeouts++;
      const hasFallback =
        !r.finalText ||
        /无法生成回复|暂时无法|抱歉|卡住了|稍后重试|没听懂|我没听懂|你说啥/i.test(r.finalText);
      if (hasFallback) totalFallbacks++;

      const flag = r.timeout ? "TIMEOUT" : hasFallback ? "FALLBACK" : "OK";
      const tools = r.toolNames.length > 0 ? `tools=[${r.toolNames.join(",")}]` : "";
      const txt = (r.finalText || "(空)").slice(0, 60);
      console.log(
        `  ${flag.padEnd(8)} ${r.tag.padEnd(12)} done=${r.doneMs ?? "-"}ms exec=${r.execCount} ${tools} :: ${txt}`,
      );
    }
    console.log("");
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  汇总报告");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  总消息:           ${totalMsgs}`);
  console.log(`  超时:             ${totalTimeouts} (${((totalTimeouts / totalMsgs) * 100).toFixed(1)}%)`);
  console.log(`  Fallback/断片:    ${totalFallbacks} (${((totalFallbacks / totalMsgs) * 100).toFixed(1)}%)`);
  console.log(`  总耗时:           ${totalMs}ms`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
