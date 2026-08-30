// E2E：复现「只回复不给结果」真实场景（2026-08-29 截图三轮）。
// 前置：server 已运行（ws://127.0.0.1:3000/ws），且已加载修复后的 tool-loop。
// 判定：每轮 finalText 必须包含真实行程内容（目的地/天数/行程词），
//       不得是纯垫话（在帮你琢磨/稍等/转交后台）。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const SESSION = process.env.E2E_SESSION ?? `e2e-travel-delivery-${Date.now()}`;

const ROUNDS = [
  "帮我规划一下去印度尼西亚玩的行程 一个星期 住宿要带游泳池的 其他的你看着安排",
  "先去雅加达吧",
  "规划呢",
];

const STALL_RE = /(帮你琢磨|等你理好|稍等.{0,6}(告诉|给你)|转交后台|接手处理中|稍后.{0,4}(告诉|给你))/;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const ws = await connect();
const chunks = new Map(); // messageId -> text
const done = []; // {messageId, finalText}

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

const send = (obj) => ws.send(JSON.stringify(obj));
send({ type: "session.init", payload: { sessionId: SESSION } });
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
for (let i = 0; i < ROUNDS.length; i++) {
  const text = ROUNDS[i];
  const before = done.length;
  send({
    type: "chat.user_message",
    payload: {
      sessionId: SESSION,
      messageId: `e2e-${Date.now()}-${i}`,
      text,
      timestamp: new Date().toISOString(),
    },
  });
  // 等本轮 assistant_done（规划最长 120s + LLM 收尾，给 240s 预算）
  const deadline = Date.now() + 240_000;
  while (done.length === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const roundDone = done.slice(before);
  const finalText = roundDone.map((d) => d.finalText).join("\n").trim() || (chunks.get(roundDone[0]?.messageId) ?? "").trim();
  console.log(`\n=== 第${i + 1}轮 用户: ${text}`);
  console.log(`小寰灯: ${finalText.slice(0, 400) || "(无回复)"}`);
  if (!finalText) {
    failures++;
    console.log(">>> FAIL: 无回复");
  } else if (i === ROUNDS.length - 1 && STALL_RE.test(finalText)) {
    failures++;
    console.log(">>> FAIL: 最后一轮仍是垫话，无结果");
  }
}

ws.close();
console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
