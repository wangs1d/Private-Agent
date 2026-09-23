// E2E：搜索卡意图仲裁（2026-09-22）。
// 前置：server 已运行（ws://127.0.0.1:3000/ws）且带 searchMediaHasItems 守卫。
// 判定：
//   A. 搜照片轮：mediaCards 非空（照片真实产出）时，finalText 不得再附
//      search_result 文字卡（[AGENT_RESULT_CARD_START]）——照片是唯一主形态。
//   B. 搜资讯轮：无媒体产出时 search_result 卡照常附（零图/纯文字兜底不回归）。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** 跑一轮全新会话，收集 done 事件；返回 { finalText, mediaCards, blocks } */
async function runTurn(userText) {
  const session = `e2e-search-arb-${Date.now()}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (evt.type === "chat.assistant_done") {
      dones.push(evt.payload ?? {});
    }
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: session,
        messageId: `e2e-${Date.now()}`,
        text: userText,
        timestamp: new Date().toISOString(),
      },
    }),
  );
  const deadline = Date.now() + 240_000;
  while (dones.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
  const done = dones[0] ?? {};
  return {
    finalText: String(done.finalText ?? "").trim(),
    mediaCards: Array.isArray(done.mediaCards) ? done.mediaCards : [],
    blocks: Array.isArray(done.blocks) ? done.blocks : [],
  };
}

function cardTypesIn(text) {
  const types = [];
  for (const m of text.matchAll(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g)) {
    try {
      types.push(JSON.parse(m[1].trim()).cardType);
    } catch {
      types.push("<parse-fail>");
    }
  }
  return types;
}

let failures = 0;

// ─── A. 搜照片：有图 → 文字卡让位 ───
console.log("=== A. 搜照片轮（应只有照片卡，无文字搜索卡）===");
const a = await runTurn("搜索刘浩存的照片");
console.log(`mediaCards: ${a.mediaCards.length} 张`);
console.log(`finalText 卡类型: [${cardTypesIn(a.finalText).join(", ") || "无"}]`);
console.log(`正文预览: ${a.finalText.slice(0, 160).replace(/\n/g, " ")}`);
if (a.mediaCards.length === 0) {
  failures++;
  console.log(">>> FAIL: 照片未产出（mediaCards 为空），A 场景前提不成立");
} else if (a.finalText.includes("[AGENT_RESULT_CARD_START]")) {
  failures++;
  console.log(">>> FAIL: 有图轮次仍附了文字卡（让位守卫未生效）");
} else {
  console.log(">>> PASS: 照片主形态，无文字卡");
}

// ─── A2. 双意图轮（用户截图原始场景）：search_images + search_web 同轮执行，
//          有图 → 文字卡仍必须让位 ───
console.log("\n=== A2. 双意图轮（搜照片+查动态，两工具同跑，仍应无文字卡）===");
const a2 = await runTurn("搜索刘浩存的照片，顺便查一下她最近的动态");
console.log(`mediaCards: ${a2.mediaCards.length} 张`);
console.log(`finalText 卡类型: [${cardTypesIn(a2.finalText).join(", ") || "无"}]`);
console.log(`正文预览: ${a2.finalText.slice(0, 160).replace(/\n/g, " ")}`);
if (a2.mediaCards.length === 0) {
  console.log(">>> SKIP: 本轮规划器未派图片工具（mediaCards 为空），双意图前提不成立");
} else if (a2.finalText.includes("[AGENT_RESULT_CARD_START]")) {
  failures++;
  console.log(">>> FAIL: 图文同轮时文字卡未让位（守卫未生效）");
} else {
  console.log(">>> PASS: 图文同轮，照片主形态，文字卡让位");
}

// ─── B. 搜资讯：纯文字 → 文字卡照常 ───
console.log("\n=== B. 搜资讯轮（应附 search_result 文字卡）===");
const b = await runTurn("帮我搜一下刘浩存最近的资讯和动态");
console.log(`mediaCards: ${b.mediaCards.length} 张`);
console.log(`finalText 卡类型: [${cardTypesIn(b.finalText).join(", ") || "无"}]`);
console.log(`正文预览: ${b.finalText.slice(0, 160).replace(/\n/g, " ")}`);
if (!cardTypesIn(b.finalText).includes("search_result")) {
  failures++;
  console.log(">>> FAIL: 纯资讯轮未附 search_result 卡（兜底被误伤）");
} else {
  console.log(">>> PASS: 文字卡照常附");
}

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
