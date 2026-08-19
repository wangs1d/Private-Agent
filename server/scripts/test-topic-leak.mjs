/**
 * 话题串台根治验证脚本
 *
 * 场景：同一 WS 会话先聊"搬家/华强科技"（话题 A），随后用户明确切换话题
 * 到无关的"电影/家具"（话题 B）。验证：
 *   1. 话题 A 的长期记忆（搬家/华强科技）在切换到话题 B 时【不再串入】回复；
 *   2. 话题 A 轮次本身仍能正常召回（不移除应有的短期/长期能力）。
 *
 * 用法：node scripts/test-topic-leak.mjs [ws://127.0.0.1:3000/ws]
 */
import WebSocket from "ws";

const SERVER_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const HTTP_BASE = SERVER_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

const TEST_ACTOR = `leak-test-${Date.now().toString(36)}`;
const PASS = "✅ 通过";
const FAIL = "❌ 失败";

function short(s) {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 200) + "…" : t;
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

function wsChat({ sessionId, userId, rounds, messageDelayMs = 1500 }) {
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
      current = { text: rounds[roundIdx], reply: "", done: null, mode: null };
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
      setTimeout(() => { initDone = true; startRound(); }, 400);
    });

    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(String(raw)); } catch { return; }
      if (ev.type === "error") {
        console.log(`  [ws error] ${JSON.stringify(ev.payload ?? {}).slice(0, 200)}`);
        if (!initDone) return finish(new Error("session.init 失败"));
        return;
      }
      if (ev.type === "chat.intent_detected") { if (current) current.mode = ev.payload?.mode ?? null; return; }
      if (ev.type === "chat.turn_started" || ev.type === "chat.message_received") { if (current) current.done = "processing"; return; }
      if (ev.type === "chat.assistant_interim") { if (current) current.interim += ev.payload?.chunk ?? ""; return; }
      if (ev.type === "chat.assistant_chunk") { if (current) current.reply += ev.payload?.chunk ?? ""; return; }
      if (ev.type === "chat.assistant_done") {
        if (current) {
          current.done = "done";
          const finalText = ev.payload?.finalText ?? ev.payload?.text;
          if (finalText) current.reply = finalText;
        }
        setTimeout(startRound, messageDelayMs);
        return;
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => { clearTimeout(hardTimeout); if (!settled) finish(); });
  });
}

async function main() {
  console.log("==================================================");
  console.log("话题串台根治验证");
  console.log(`测试 Actor: ${TEST_ACTOR}`);
  console.log(`服务端: ${SERVER_URL}`);
  console.log("==================================================");

  // ── 准备：写入"搬家/华强科技"长期记忆（话题 A） ──────────────
  console.log("\n[准备] 写入话题 A 长期记忆（搬家 / 华强科技）…");
  const facts = [
    { content: "用户下个月要从北京搬到上海浦东新区，租房预算八千。", kind: "fact", domain: "semantic", importance: "high", source: "topic_leak_test" },
    { content: "用户出差的客户公司叫华强科技，对接人姓王。", kind: "fact", domain: "semantic", importance: "high", source: "topic_leak_test" },
  ];
  for (const f of facts) {
    const r = await httpJson("POST", "/brain/memory/remember", { actorId: TEST_ACTOR, item: f });
    console.log(`  写入: ${short(f.content)} → ${r.status === 200 ? "ok" : `FAIL(${r.status})`}`);
  }
  await new Promise((r) => setTimeout(r, 4000));

  // ── 阶段 1：同一会话先聊话题 A（搬家） ──────────────────────
  console.log("\n════════ 阶段 1：会话内聊话题 A（搬家） ════════");
  const rounds = [
    "我要搬家了，帮我看看搬家公司。",
    "上海浦东那边的搬家公司怎么收费？",
  ];
  const sessionId = TEST_ACTOR;
  const replies = await wsChat({ sessionId, userId: TEST_ACTOR, rounds });
  replies.forEach((r, i) => {
    console.log(`\n── 轮次 ${i + 1}: "${rounds[i]}"`);
    console.log(`   mode: ${r.mode ?? "未知"}`);
    console.log(`   回复: ${short(r.reply)}`);
  });

  // ── 阶段 2：切换话题 B（电影）盘查是否串台 ──────────────────
  console.log("\n════════ 阶段 2：切换话题 B（电影）盘查串台 ════════");
  const switchReplies = await wsChat({
    sessionId,
    userId: TEST_ACTOR,
    rounds: ["咱们切换到轻松话题吧，最近有什么好看的科幻电影推荐？"],
    messageDelayMs: 800,
  });
  const switchReply = switchReplies[0]?.reply ?? "";
  console.log(`\n── 切换话题轮:`);
  console.log(`   mode: ${switchReplies[0]?.mode ?? "未知"}`);
  console.log(`   回复: ${short(switchReply)}`);

  // 串台判定：回复应聚焦电影，不应携带话题 A 的搬家/华强/浦东记忆
  const leakKeywords = ["搬家", "华强", "浦东", "上海", "租房", "八千", "搬家公司"];
  const leaked = leakKeywords.filter((kw) => switchReply.includes(kw));
  const isMovieFocus = /电影|科幻|推荐|影片|大片|片子/i.test(switchReply);

  console.log("\n[判定] 切换话题 B 后：");
  console.log(`  是否聚焦电影: ${isMovieFocus ? "是" : "否，可能未聚焦"}`);
  console.log(`  串入场的关键词: ${leaked.length ? leaked.join("、") : "无 ✓"}`);

  const noLeak = leaked.length === 0;
  log(
    "话题切换不串台",
    noLeak ? PASS : FAIL,
    noLeak ? `—— 回复聚焦电影，未串入搬家/华强记忆` : `—— 回复串入了话题 A 记忆: ${leaked.join("、")}`,
  );

  // ── 阶段 3：下一轮回到话题 A 追问，验证既有能力未误杀 ──────────
  console.log("\n════════ 阶段 3：回到话题 A 追问（验证召回未被误杀） ════════");
  const backReplies = await wsChat({
    sessionId,
    userId: TEST_ACTOR,
    rounds: ["对了，我之前说要搬去哪个城市来着？"],
    messageDelayMs: 800,
  });
  const backReply = backReplies[0]?.reply ?? "";
  console.log(`\n── 追问轮回复: ${short(backReply)}`);
  const backHit = backReply.includes("上海") || backReply.includes("浦东");
  log(
    "话题 A 召回未被误杀",
    backHit ? PASS : FAIL,
    backHit ? `—— 能回述搬家目的地（上海/浦东）` : `—— 未能回述搬家目的地`,
  );

  console.log("\n==================================================");
  console.log("汇总");
  console.log(`  话题切换不串台      : ${noLeak ? "通过" : "失败"}`);
  console.log(`  话题A召回未被误杀   : ${backHit ? "通过" : "失败"}`);
  console.log(`  测试 Actor: ${TEST_ACTOR}`);
  console.log("==================================================");

  process.exit(0);
}

function log(step, verdict, detail) {
  console.log(`\n[${step}] ${verdict} ${detail}`);
}

await main();