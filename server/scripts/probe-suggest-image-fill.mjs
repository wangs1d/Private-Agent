// 真机 E2E：shopping.suggest 缺图候选网搜补图（2026-09-23 补图链路配套）。
//
// 前置：server 已重启至含补图链路的代码（ws://127.0.0.1:3000/ws）。
// 判定：
//   1. 回复 finalText 携带 product_compare 卡（AGENT_RESULT_CARD 标记）
//   2. 分侧 sides[] 全部带图，且图片 URL 是 /agent/images/（网搜转存 PNG），
//      而非 /api/recommendation/media/（商品库一手图）——证明补图真实发生
//   3. GET 图片 URL → HTTP 200 且 Content-Type: image/png
//
// 用法：node scripts/probe-suggest-image-fill.mjs
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const HTTP_BASE = process.env.HTTP_BASE ?? "http://127.0.0.1:3000";
const SESSION = process.env.E2E_SESSION ?? `e2e-suggest-img-${Date.now()}`;
const ROUND_TEXT =
  process.env.E2E_TEXT ?? "帮我推荐一款智能手表吧，说说理由";

const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(WS_URL);
  s.on("open", () => resolve(s));
  s.on("error", reject);
});

const chunks = new Map();
const done = [];
ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const p = evt.payload ?? {};
  if (evt.type === "chat.assistant_chunk") {
    chunks.set(p.messageId, (chunks.get(p.messageId) ?? "") + (p.delta ?? p.text ?? ""));
  } else if (evt.type === "chat.assistant_done") {
    done.push({ messageId: p.messageId, finalText: p.finalText ?? "" });
  }
});

ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: SESSION } }));
// 1.5s 内发送（赶在开场白入队前）：过晚发送会撞「开口打断抑制」或被路由进任务面
await new Promise((r) => setTimeout(r, 1500));

const sendMessage = (text) =>
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: SESSION,
        messageId: `e2e-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        timestamp: new Date().toISOString(),
      },
    }),
  );

const waitReply = async (baseline, ms) => {
  const deadline = Date.now() + ms;
  while (done.length === baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  return done.length > baseline;
};

console.log(`[probe] session=${SESSION}`);
console.log(`[probe] 用户：${ROUND_TEXT}`);
const before = done.length;
sendMessage(ROUND_TEXT);
// 开场白竞态兜底：新会话首个消息可能被「用户开口打断抑制」吞掉（60s 窗口），
// 65s 后未获回复则原样重发一次。
if (!(await waitReply(before, 65_000)) && done.length === before) {
  console.log("[probe] 疑似开场白竞态吞消息，65s 后重发");
  sendMessage(ROUND_TEXT);
}
await waitReply(before, 120_000);
ws.close();

const finalText =
  done.slice(before).map((d) => d.finalText).join("\n").trim() ||
  (chunks.get(done[before]?.messageId) ?? "").trim();
console.log(`\n[probe] 回复（前 300 字）：${finalText.slice(0, 300) || "(无回复)"}`);

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : `：${detail}`}`);
  if (!cond) failed += 1;
};

const cardStart = finalText.indexOf("[AGENT_RESULT_CARD_START]");
check("回复携带 AGENT_RESULT_CARD 标记", cardStart >= 0, "finalText 无卡片标记");
if (cardStart < 0) {
  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}
const cardJson = finalText
  .slice(cardStart + "[AGENT_RESULT_CARD_START]\n".length)
  .split("\n[AGENT_RESULT_CARD_END]")[0];
const card = JSON.parse(cardJson);

check("cardType=product_compare", card.cardType === "product_compare", card.cardType);
check(
  "分侧 sides 非空",
  Array.isArray(card.sides) && card.sides.length > 0,
  JSON.stringify(card.sides?.map((s) => s.label)),
);
console.log(`  sides: ${(card.sides ?? []).map((s) => `${s.side}=${s.label}`).join(" | ")}`);
console.log(`  images: ${(card.sides ?? []).map((s) => s.image).join(" , ")}`);

for (const s of card.sides ?? []) {
  check(`分侧 ${s.side} 带图`, Boolean(s.image), "无 image 字段");
  check(
    `分侧 ${s.side} 图为网搜转存 PNG（/agent/images/）`,
    typeof s.image === "string" && s.image.startsWith("/agent/images/"),
    `实际：${s.image}`,
  );
  if (typeof s.image === "string") {
    const res = await fetch(`${HTTP_BASE}${s.image}`);
    const ctype = res.headers.get("content-type") ?? "";
    check(
      `分侧 ${s.side} 图片可拉取（HTTP 200 image/png）`,
      res.status === 200 && ctype.includes("image/png"),
      `HTTP ${res.status} ${ctype}`,
    );
  }
}

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
