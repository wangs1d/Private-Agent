/**
 * 五子棋联调：HTTP 流程 +（可选）WebSocket 对话开桌。
 * 用法：node test-ws-gomoku.mjs
 */
import WebSocket from "ws";

const HTTP_BASE = process.env.HTTP_BASE ?? "http://127.0.0.1:3000";
const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const RUN_CHAT = process.env.RUN_GOMOKU_CHAT === "1";

async function httpJson(path, opts = {}) {
  const r = await fetch(`${HTTP_BASE}${path}`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

async function testHttpGomoku() {
  const agentSid = `agent-${Date.now()}`;
  const userSid = `user-${Date.now()}`;

  const create = await httpJson("/world/gomoku/tables", {
    method: "POST",
    body: JSON.stringify({ sessionId: agentSid }),
  });
  if (!create.ok || !create.json?.playUrl) {
    throw new Error(`开桌失败: ${JSON.stringify(create.json)}`);
  }
  const tableId = create.json.table?.tableId;
  const playUrl = create.json.playUrl;
  console.log("[HTTP] create ok", { tableId, playUrl });

  const join = await httpJson("/world/gomoku/join", {
    method: "POST",
    body: JSON.stringify({ sessionId: userSid, tableId, role: "player" }),
  });
  if (!join.ok) throw new Error(`加入失败: ${JSON.stringify(join.json)}`);
  console.log("[HTTP] join ok", join.json.playUrl);

  const play = await httpJson("/world/gomoku/play", {
    method: "POST",
    body: JSON.stringify({ sessionId: agentSid, tableId, row: 7, col: 7 }),
  });
  if (!play.ok) throw new Error(`落子失败: ${JSON.stringify(play.json)}`);
  console.log("[HTTP] agent play ok, current:", play.json.snapshot?.currentPlayer);

  return { tableId, playUrl, agentSid, userSid };
}

async function testChatGomoku() {
  const sid = `chat-gomoku-${Date.now()}`;
  const mid = "msg-gomoku-test";
  const ws = new WebSocket(WS_URL);
  let full = "";
  const tools = [];
  let done = false;
  let sawPlayUrl = false;

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 8000);
  });

  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid, userId: sid } }));
  await new Promise((r) => setTimeout(r, 500));

  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "chat.assistant_chunk") full += m.payload?.chunk ?? "";
    if (m.type === "tool.call") tools.push(m.payload?.toolName);
    if (m.type === "tool.result") {
      tools.push(`${m.payload?.toolName}:${m.payload?.ok ? "ok" : "fail"}`);
      if (m.payload?.result?.playUrl) {
        sawPlayUrl = true;
        tools.push(`playUrl=${m.payload.result.playUrl}`);
      }
    }
    if (m.type === "chat.assistant_done") {
      full = m.payload?.finalText ?? full;
      done = true;
    }
  });

  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: sid, userId: sid, messageId: mid, text: "陪我下一盘五子棋" },
    }),
  );

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("chat timeout 120s")), 120000);
    const poll = setInterval(() => {
      if (done || sawPlayUrl) {
        clearTimeout(t);
        clearInterval(poll);
        resolve();
      }
    }, 200);
  });

  ws.close();
  const hasPlayUrl =
    /https?:\/\/[^\s]+#\/gomoku\//.test(full) || tools.some((t) => t.startsWith("playUrl="));
  const usedRegister = tools.some((t) => String(t).includes("open_registry"));
  console.log("[CHAT] tools:", tools.join(", "));
  console.log("[CHAT] reply excerpt:", full.slice(0, 280));
  if (usedRegister) throw new Error("不应调用 Agent World 注册工具");
  if (!hasPlayUrl) throw new Error("回复或 tool.result 中缺少 playUrl");
  console.log("[CHAT] ok");
}

async function main() {
  console.log("=== 五子棋联调 ===");
  console.log("HTTP_BASE:", HTTP_BASE);
  await testHttpGomoku();
  console.log("[HTTP] all passed");
  if (RUN_CHAT) {
    await testChatGomoku();
  } else {
    console.log("[CHAT] skipped (set RUN_GOMOKU_CHAT=1 to enable, needs LLM API key)");
  }
  console.log("=== PASS ===");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
