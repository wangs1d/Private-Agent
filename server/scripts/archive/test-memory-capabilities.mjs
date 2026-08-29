/**
 * 记忆能力端到端验证脚本
 *
 * 验证三项能力是否真实生效：
 *   A. 短期记忆（会话内上下文）：同一 WS 会话多轮对话，验证 agent 记得前文
 *   B. 长期记忆（跨会话持久化）：HTTP remember 写入高重要性事实 → 换措辞 recall +
 *      新 WS 会话提问，验证跨会话仍能召回
 *   C. 图链接能力（humanLike 记忆图）：写入两条关联事实 → 检查记忆图节点/边，
 *      recall 触发联想后检查关联条目与关联节点
 *
 * 用法：node scripts/test-memory-capabilities.mjs
 *       node scripts/test-memory-capabilities.mjs ws://127.0.0.1:3000/ws
 */

import WebSocket from "ws";

const SERVER_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const HTTP_BASE = SERVER_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

// 独立测试 actor，避免污染真实用户（session-mvp-001）数据
const TEST_ACTOR = `mem-test-${Date.now().toString(36)}`;

const PASS = "✅ 通过";
const FAIL = "❌ 失败";
const WARN = "⚠️ 存疑";

function log(step, verdict, detail = "") {
  console.log(`\n[${step}] ${verdict} ${detail}`);
}

function short(s) {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 160) + "…" : t;
}

async function httpJson(method, path, body) {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

/**
 * WS 单会话多轮对话。每轮返回 { reply, interim, events }。
 */
function wsChat({ sessionId, userId, rounds, messageDelayMs = 1200 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const results = [];
    let roundIdx = -1;
    let current = null;
    let settled = false;
    let initDone = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      err ? reject(err) : resolve(results);
    };
    const hardTimeout = setTimeout(
      () => finish(new Error(`WS 会话 ${rounds.length} 轮 180s 超时`)),
      180_000,
    );

    const startRound = () => {
      roundIdx += 1;
      if (roundIdx >= rounds.length) return finish();
      current = {
        text: rounds[roundIdx],
        reply: "",
        interim: "",
        done: null,
        events: [],
        mode: null,
      };
      results.push(current);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ws.send(
        JSON.stringify({
          type: "chat.user_message",
          payload: {
            text: rounds[roundIdx],
            messageId: msgId,
            sessionId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }),
      );
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { userId, sessionId } }));
      setTimeout(() => {
        initDone = true;
        startRound();
      }, 400);
    });

    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(String(raw)); } catch { return; }
      if (ev.type === "error") {
        console.log(`  [ws error] ${JSON.stringify(ev.payload ?? {}).slice(0, 200)}`);
        if (!initDone) return finish(new Error("session.init 失败"));
        return;
      }
      if (ev.type === "chat.intent_detected") {
        if (current) current.mode = ev.payload?.mode ?? null;
        return;
      }
      if (ev.type === "chat.turn_started" || ev.type === "chat.message_received") {
        if (current && current.done === null) current.done = "processing";
        return;
      }
      if (ev.type === "chat.assistant_interim") {
        if (current) current.interim += ev.payload?.chunk ?? ev.payload?.text ?? "";
        return;
      }
      if (ev.type === "chat.assistant_chunk") {
        if (current) current.reply += ev.payload?.chunk ?? ev.payload?.text ?? "";
        return;
      }
      if (ev.type === "chat.assistant_done") {
        if (current) {
          current.done = "done";
          // 最终文本以 done 载荷的 finalText 为准（若有）
          const finalText = ev.payload?.finalText ?? ev.payload?.text;
          if (finalText) current.reply = finalText;
        }
        // 下一轮
        setTimeout(startRound, messageDelayMs);
        return;
      }
      if (ev.type === "chat.execution_event") {
        if (current) current.events.push(ev.payload);
        return;
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => {
      clearTimeout(hardTimeout);
      if (!settled) finish();
    });
  });
}

async function main() {
  console.log("==================================================");
  console.log("记忆能力端到端验证");
  console.log(`测试 Actor: ${TEST_ACTOR}`);
  console.log(`服务端: ${SERVER_URL} (HTTP: ${HTTP_BASE})`);
  console.log("==================================================");

  // ── 阶段 A：短期记忆（会话内上下文） ──────────────────────
  console.log("\n════════ 阶段 A：短期记忆（同一会话内多轮上下文） ════════");
  const stRounds = [
    "记住：我下周一要出差去深圳，客户公司叫华强科技，对接人姓王。",
    "这次深圳的会预计开两天，住在南山科技园附近的酒店。",
    "我这次出差要去见哪家公司？（不要联网，直接回答）",
  ];
  const stReplies = await wsChat({
    sessionId: TEST_ACTOR,
    userId: TEST_ACTOR,
    rounds: stRounds,
  });
  stReplies.forEach((r, i) => {
    console.log(`\n── 轮次 ${i + 1}: "${stRounds[i]}"`);
    console.log(`    mode: ${r.mode ?? "未知"} | 事件: ${[...new Set(r.events.map((e) => e.kind))].join(",") || "无"}`);
    console.log(`    回复: ${short(r.reply)}`);
    if (r.events.some((e) => e.kind === "tool_call")) {
      const t = r.events.find((e) => e.kind === "tool_call");
      console.log(`    工具调用: ${t?.toolCall?.name}${t?.toolCall?.argsPreview ? " " + short(String(t.toolCall.argsPreview)) : ""}`);
    }
  });

  const lastReply = stReplies[2]?.reply ?? "";
  // 问题「我这次出差要去见哪家公司？」的正确答案是公司名「华强科技」：
  // 只要回答出现「华强」即通过；不强制同时出现「深圳/出差」（否则会把答对公司名的回答误判为失败）。
  const shortTermHit = lastReply.includes("华强");
  log(
    "A.短期记忆(会话内)",
    shortTermHit ? PASS : FAIL,
    shortTermHit
      ? "—— 第3轮正确回述了第1轮的公司名"
      : `—— 第3轮未回述「华强科技」，回复: ${short(lastReply)}`,
  );

  // ── 阶段 B：长期记忆（跨会话持久化 + 语义召回） ──────────────
  console.log("\n════════ 阶段 B：长期记忆（HTTP 写入 → 换措辞召回） ════════");
  const facts = [
    {
      content: "用户养了一只白色短毛猫，名字叫咪咪，今年两岁。",
      kind: "fact",
      domain: "semantic",
      importance: "high",
      source: "memory_capability_test",
    },
    {
      content: "咪咪最爱的食物是三文鱼味的猫粮，不喜欢牛肉味。",
      kind: "fact",
      domain: "semantic",
      importance: "high",
      source: "memory_capability_test",
    },
    {
      content: "用户计划下个月从北京搬到上海浦东新区，租房预算八千。",
      kind: "fact",
      domain: "semantic",
      importance: "high",
      source: "memory_capability_test",
    },
  ];
  for (const f of facts) {
    const r = await httpJson("POST", "/brain/memory/remember", { actorId: TEST_ACTOR, item: f });
    console.log(`写入记忆: ${f.content} → ${r.status === 200 ? "ok" : `FAIL(${r.status}) ${r.text.slice(0, 120)}`}`);
  }
  // 等待异步写入完成（narrative.ingest 是异步链路）
  await new Promise((r) => setTimeout(r, 4000));

  const recallQueries = [
    { q: "我家猫喜欢吃什么猫粮？", expect: ["三文鱼"] },
    { q: "我下个月要搬家去哪里？", expect: ["上海", "浦东"] },
    { q: "我养的宠物叫什么名字？", expect: ["咪咪"] },
  ];
  const recallResults = [];
  for (const { q, expect } of recallQueries) {
    const r = await httpJson("POST", "/brain/memory/recall", { actorId: TEST_ACTOR, query: q });
    const items = r.json?.result?.items ?? [];
    const joined = items.map((it) => it.content).join("\n");
    recallResults.push({ q, expect, joined, items });
    const hit = expect.some((kw) => joined.includes(kw));
    console.log(`\n召回 "${q}" → ${hit ? "命中" : "未命中"} (${items.length} 条)`);
    for (const it of items.slice(0, 3)) {
      console.log(`   · [${(it.score ?? 0).toFixed(2)}] ${short(it.content)}`);
    }
  }
  const longTermHit = recallResults.filter((r) => r.expect.some((kw) => r.joined.includes(kw))).length;
  log(
    "B.长期记忆(语义召回)",
    longTermHit >= 2 ? PASS : longTermHit >= 1 ? WARN : FAIL,
    `—— ${longTermHit}/${recallQueries.length} 条换措辞查询命中`,
  );

  // 跨会话真实对话验证：新 WS 会话（不同 sessionId）问长期记忆内容
  console.log("\n──── B2：跨会话真实对话（新 sessionId 提问） ────");
  const ltReplies = await wsChat({
    sessionId: `${TEST_ACTOR}-session2`,
    userId: TEST_ACTOR, // 同一 userId → 同一 actor，验证跨会话记忆
    rounds: ["你还记得我养的猫叫什么名字吗？它喜欢吃什么？（不要联网）"],
    messageDelayMs: 800,
  });
  const ltReply = ltReplies[0]?.reply ?? "";
  console.log(`回复: ${short(ltReply)}`);
  const crossSessionHit = ltReply.includes("咪咪") || ltReply.includes("三文鱼");
  log(
    "B2.长期记忆(跨会话)",
    crossSessionHit ? PASS : FAIL,
    crossSessionHit
      ? "—— 新会话仍能说出猫名/食物"
      : `—— 新会话未召回，回复: ${short(ltReply)}`,
  );

  // ── 阶段 C：图链接能力（humanLike 记忆图） ────────────────
  console.log("\n════════ 阶段 C：图链接能力（记忆图节点/边 + 关联） ════════");

  // 触发一次 recall（≥2 条命中会触发 associationSynthesizer 异步合成 + 联想图扩散）
  await httpJson("POST", "/brain/memory/recall", {
    actorId: TEST_ACTOR,
    query: "我的猫和我的搬家计划",
  });
  // 等待联想合成（LLM 异步）+ 回灌 humanLike 图完成
  await new Promise((r) => setTimeout(r, 10000));

  // 读取 human-memory.json 检查测试 actor 的图节点
  const fs = await import("node:fs");
  const { readFileSync } = fs;
  let graph = null;
  let actorNodes = [];
  let edgeList = [];
  let assocHits = [];
  let associatedNodes = [];
  try {
    graph = JSON.parse(readFileSync(new URL("../data/human-memory.json", import.meta.url), "utf8"));
  } catch (e) {
    log("C.图数据读取", FAIL, e.message);
  }

  if (graph) {
    const nodes = graph.nodes ?? {};
    actorNodes = Object.values(nodes).filter((n) => n.actorId === TEST_ACTOR);
    const edges = graph.edges ?? {};
    edgeList = Object.values(edges).filter((e) => e.actorId === TEST_ACTOR);
    console.log(`\n测试 Actor 记忆图节点数: ${actorNodes.length}`);
    console.log(`测试 Actor 关联边数: ${edgeList.length}`);
    for (const n of actorNodes.slice(0, 8)) {
      console.log(`   · ${short(String(n.summary ?? n.content ?? n.id))}`);
    }

    // 再次 recall 验证联想条目（association source 的 item）
    const assocRecall = await httpJson("POST", "/brain/memory/recall", {
      actorId: TEST_ACTOR,
      query: "咪咪 三文鱼 猫粮",
      limit: 8,
    });
    const assocItems = assocRecall.json?.result?.items ?? [];
    assocHits = assocItems.filter((it) => it.source === "association" || String(it.content).startsWith("联想记忆") || String(it.content).startsWith("关联节点"));
    console.log(`\n联想触发后 recall 命中 ${assocItems.length} 条，其中联想/关联条目 ${assocHits.length} 条`);
    for (const it of assocHits.slice(0, 4)) {
      console.log(`   · [${it.source}] ${short(it.content)}`);
    }

    // 联想合成回灌检查：humanLike 图中 metadata.associated=true 或 source=association 的节点
    associatedNodes = actorNodes.filter((n) => {
      const m = n.metadata ?? {};
      return m.associated === true || m.associationConfidence !== undefined || n.source === "association";
    });
    console.log(`联想合成回灌到记忆图的 associated 节点: ${associatedNodes.length} 条`);
    for (const n of associatedNodes.slice(0, 4)) {
      const m = n.metadata ?? {};
      console.log(
        `   · [conf=${m.associationConfidence ?? "-"}] ${short(String(n.summary ?? n.content ?? n.id))}`,
      );
    }

    const graphVerdict = actorNodes.length >= 2;
    const assocVerdict = assocHits.length > 0 || associatedNodes.length > 0;
    log(
      "C1.记忆图节点形成",
      graphVerdict ? PASS : FAIL,
      `—— 写入 3 条事实形成 ${actorNodes.length} 个图节点`,
    );
    log(
      "C2.记忆图关联边",
      edgeList.length > 0 ? PASS : WARN,
      `—— ${edgeList.length} 条关联边（图链接：相关记忆间建立连线）`,
    );
    log(
      "C3.联想扩散/合成",
      assocVerdict ? PASS : WARN,
      assocVerdict
        ? `—— recall 带出 ${assocHits.length} 条联想条目 / 回灌 ${associatedNodes.length} 条关联节点`
        : "—— 未发现联想条目或关联节点（可能联想配置未启用或置信不足）",
    );
  }

  // 连续性诊断锚点：后端返回字段为 recentRecalls（diagnoseContinuity / buildContinuityDiagnosis）
  const diag = await httpJson("POST", "/brain/memory/continuity/diagnose", { actorId: TEST_ACTOR });
  const diagResult = diag.json?.result;
  if (diagResult) {
    const anchors = diagResult.recentRecalls ?? diagResult.anchors ?? diagResult.recentAnchors ?? [];
    const hasAnchor = Array.isArray(anchors) && anchors.length > 0;
    log(
      "C4.召回锚点记录",
      hasAnchor ? PASS : WARN,
      hasAnchor ? `—— 已记录 ${anchors.length} 条召回锚点（诊断接口）` : "—— 无锚点记录",
    );
  }

  // ── 汇总 ────────────────────────────────────────────────
  console.log("\n==================================================");
  console.log("验证汇总");
  console.log("  短期记忆(会话内回述)      : " + (shortTermHit ? "真实具备" : "未通过"));
  console.log("  长期记忆(换措辞语义召回)  : " + (longTermHit >= 2 ? "真实具备" : "未通过/存疑"));
  console.log("  长期记忆(跨会话真实对话)  : " + (crossSessionHit ? "真实具备" : "未通过"));
  console.log(`  图节点形成                : ${graph ? (actorNodes.length >= 2 ? "真实具备" : "未通过") : "未读取到图"}`);
  console.log("  图关联边/联想扩散         : " + (graph && (edgeList.length > 0 || assocHits.length > 0) ? "真实具备" : "存疑"));
  console.log(`  测试 Actor: ${TEST_ACTOR}`);
  console.log("==================================================");
  clearTimeout(hardTimeout);
}

let hardTimeout;
const mainPromise = main();
hardTimeout = setTimeout(() => {
  console.log("\n整体超时（300s），终止。");
  process.exit(1);
}, 300_000);
await mainPromise;
clearTimeout(hardTimeout);
process.exit(0);
