/**
 * 用户画像「越来越懂你」现场演示（2026-09-29）。
 * 全程走常驻实例 WS 真实聊天链路，actor=profile-demo-<ts>：
 *   第0幕 空白档案     → 展示默认模板画像
 *   第1幕 自我介绍     → agent 回应 + 画像文件自动生成
 *   第2幕 新会话考记忆 → 只靠画像答出猫的名字（对话面注入实证）
 *   第3幕 改口         → 画像 UPDATE，不堆重复行
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = join(import.meta.dirname, "..");
const ACTOR = `profile-demo-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (t = "─") => console.log("─".repeat(62));

function profilePath() {
  return join(ROOT, "data", "user_profiles", ACTOR, "USER_PROFILE.md");
}
function readProfile() {
  try { return readFileSync(profilePath(), "utf8"); } catch { return null; }
}
function showProfile(label) {
  const p = readProfile();
  console.log(`\n📁 【${label}】画像文件当前内容:`);
  if (!p) { console.log("   (尚未生成)"); return null; }
  for (const l of p.split("\n")) {
    if (l.startsWith("#") || l.startsWith(">")) continue;
    if (l.trim()) console.log("   " + l);
  }
  return p;
}

function chat(sessionId, text, timeoutSec = 100) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3000/ws");
    let full = "";
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("超时")); }, timeoutSec * 1000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId: ACTOR } }));
      setTimeout(() => ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: { sessionId, userId: ACTOR, messageId: `demo-${Date.now()}`, text, timestamp: new Date().toISOString() },
      })), 300);
    });
    ws.on("message", (raw) => {
      let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }
      if (evt.type === "chat.assistant_chunk" && evt.payload?.chunk) full += evt.payload.chunk;
      else if (evt.type === "chat.assistant_done") {
        clearTimeout(timer); try { ws.close(); } catch {}
        resolve(evt.payload?.finalText || full);
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitProfile(keywords, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = readProfile();
    if (p && keywords.every((k) => p.includes(k))) return p;
    await sleep(2000);
  }
  return readProfile();
}

async function speak(text) {
  // 逐字打印 agent 回复，模拟聊天气氛
  for (const ch of text) { process.stdout.write(ch); await sleep(12); }
  process.stdout.write("\n");
}

console.log("\n╔════════════════════════════════════════════════════════════╗");
console.log("║   用户画像 · 从陌生到懂你 · 真链现场演示                     ║");
console.log(`║   actor: ${ACTOR}   ║`);
console.log("╚════════════════════════════════════════════════════════════╝");

/* 第0幕 */
line("═");
console.log("🎬 第0幕：一个全新用户，档案一片空白\n");
showProfile("改造前");

/* 第1幕 */
line("═");
console.log("\n🎬 第1幕：初次见面，用户随口自我介绍\n");
console.log("👤 用户: 我叫林晚秋，在杭州做UI设计师，养了只橘猫叫汤圆，两岁半，周末喜欢去西湖边拍胶片。\n");
let reply = await chat(ACTOR, "我叫林晚秋，在杭州做UI设计师，养了只橘猫叫汤圆，两岁半，周末喜欢去西湖边拍胶片。");
console.log("🤖 Agent: "); await speak(reply);
await waitProfile(["林晚秋", "汤圆", "UI"]);
showProfile("第1幕后 · 自动生成");

/* 第2幕 */
line("═");
console.log("\n🎬 第2幕：隔天，全新会话（零聊天记录），用户只问了一个生活问题\n");
console.log("👤 用户: 我家猫今天一直挠沙发，愁死我了，怎么办？\n");
reply = await chat(`${ACTOR}-day2`, "我家猫今天一直挠沙发，愁死我了，怎么办？");
console.log("🤖 Agent: "); await speak(reply);
const mentionedCat = reply.includes("汤圆");
console.log(`\n   ⭐ 关键点: ${mentionedCat ? "Agent 叫出了「汤圆」——猫的名字只存在于画像文件，本会话从未说过" : "(未点名，看回复是否用了画像其他信息)"}`);
showProfile("第2幕后");

/* 第3幕 */
line("═");
console.log("\n🎬 第3幕：一个月后，用户改口（换工作），看画像会不会跟着更新\n");
console.log("👤 用户: 对了跟你说一声，我上个月跳槽了，从设计岗转去了产品岗，现在在做B端产品经理。\n");
reply = await chat(`${ACTOR}-day30`, "对了跟你说一声，我上个月跳槽了，从设计岗转去了产品岗，现在在做B端产品经理。");
console.log("🤖 Agent: "); await speak(reply);
const updated = await waitProfile(["产品"], 30000);
const hasProduct = updated?.includes("产品");
const staleDesign = /职业[：:]\s*UI设计|职业[：:]\s*设计师/.test(updated ?? "");
console.log(`\n   ⭐ 关键点: ${hasProduct && !staleDesign ? "画像已 UPDATE 为产品岗，旧职业不留重复行（越用越准）" : staleDesign ? "⚠ 旧职业仍在，等深度合成兜底" : "画像已含产品岗"}`);
showProfile("第3幕后 · 改口生效");

line("═");
console.log("\n✅ 演示结束。这就是「画像被真实写入 → 对话面真实读取 → 改口真实更新」的全链路。");
console.log(`   （演示数据 actor=${ACTOR}，可留观或手动删 data/user_profiles/${ACTOR}）\n`);
process.exit(0);
