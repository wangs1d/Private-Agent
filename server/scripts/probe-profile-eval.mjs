/**
 * 用户画像记忆质量评测台架（2026-09-29 P1-3，对标 Mem0/LoCoMo 的评测文化）。
 *
 * 走常驻实例 WS 真链，按脚本剧本与一个全新 actor 对话（显式事实→寒暄噪声→
 * 事实变化→跨会话提问），然后对画像文件与 agent 回答打分：
 *   - 召回率 recall：ground truth 事实在画像（深度合成后）中的覆盖比例
 *   - 误记防线：从未说过的干扰项不得出现在画像
 *   - 问答腿：全新会话凭画像答题（对什么过敏/在学什么/宠物现状）
 *
 * 用法：node scripts/probe-profile-eval.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = join(import.meta.dirname, "..");
const ACTOR = `profile-eval-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_FILE = join(ROOT, "..", "logs", "autostart", `server-${new Date().toISOString().slice(0, 10)}.log`);

function chat(sessionId, text, timeoutSec = 100) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3000/ws");
    let full = "";
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("超时")); }, timeoutSec * 1000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId: ACTOR } }));
      setTimeout(() => ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: { sessionId, userId: ACTOR, messageId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, text, timestamp: new Date().toISOString() },
      })), 250);
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

const profilePath = join(ROOT, "data", "user_profiles", ACTOR, "USER_PROFILE.md");
const readProfile = () => { try { return readFileSync(profilePath, "utf8"); } catch { return null; } };

/* ── ground truth ──
 * 剧本：S1 显式自我介绍（4 事实+1 寒暄）→ S2 噪声+软事实+状态变化（7 轮，跨过 12 阈值）
 * 干扰项「拿铁」从未出现，画像里不该有。 */
const GROUND_TRUTH = [
  { name: "称呼=顾清梧", keywords: ["顾清梧"] },
  { name: "城市=苏州", keywords: ["苏州"] },
  { name: "职业=嵌入式开发", keywords: ["嵌入式"] },
  { name: "香菜过敏", keywords: ["香菜"] },
  { name: "宠物=鹦鹉皮蛋", keywords: ["皮蛋", "鹦鹉"] },
  { name: "新爱好=黑胶唱机修复", keywords: ["黑胶"] },
  { name: "鹦鹉已送人（状态更新）", keywords: ["送"] },
];
const NEGATIVE = { name: "干扰项=拿铁（从未说过）", keywords: ["拿铁"] };

const FILLERS = ["在吗", "今天好热", "刚下班", "周没怎么出门", "哈欠连天", "喝口水去了", "随便唠唠"];

async function main() {
  const results = [];
  const report = (leg, pass, detail) => { results.push(pass); console.log(`${pass ? "✅" : "❌"} [${leg}] ${detail}`); };

  console.log(`=== 画像记忆质量评测 actor=${ACTOR} ===\n[阶段1] 剧本对话（13 轮，跨合成阈值）…`);

  // S1：显式事实
  await chat(ACTOR, "我叫顾清梧，在苏州做嵌入式开发，对香菜过敏，吃了就难受。");
  await chat(ACTOR, "家里养了只鹦鹉叫皮蛋，会学我说话。");
  await chat(ACTOR, FILLERS[0]);
  // S2：噪声 + 软事实 + 状态变化
  await chat(ACTOR + "-s2", FILLERS[1]);
  await chat(ACTOR + "-s2", FILLERS[2]);
  await chat(ACTOR + "-s2", "最近迷上了黑胶唱机修复，淘了台老唱机在拆着玩。");
  await chat(ACTOR + "-s2", FILLERS[3]);
  await chat(ACTOR + "-s2", "对了，上个月把皮蛋送给朋友了，它笼子太大我屋子小。");
  await chat(ACTOR + "-s2", FILLERS[4]);
  await chat(ACTOR + "-s2", FILLERS[5]);
  await chat(ACTOR + "-s2", FILLERS[6]);
  await chat(ACTOR + "-s2", "行了不聊了，去忙了");
  await chat(ACTOR + "-s2", "嗯");

  // 等深度合成（第 13 轮触达 12 阈值；给 LLM 120s；按行匹配防跨 actor 误拼）
  console.log("[阶段2] 等深度合成…");
  let synth = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const logs = readFileSync(LOG_FILE, "utf8");
    synth = logs.split("\n").some((l) => l.includes("深度画像合成完成") && l.includes(ACTOR));
    if (synth) break;
  }
  report("深度合成触发", synth, synth ? "合成日志命中" : "120s 未合成（召回按抽取后画像评）");
  await sleep(2000);

  // 召回率
  const profile = readProfile() ?? "";
  const missing = GROUND_TRUTH.filter((g) => !g.keywords.some((k) => profile.includes(k)));
  const negHit = NEGATIVE.keywords.some((k) => profile.includes(k));
  report(`召回率 ${GROUND_TRUTH.length - missing.length}/${GROUND_TRUTH.length}`,
    missing.length === 0,
    missing.length === 0 ? "全部 ground truth 进画像" : `缺: ${missing.map((m) => m.name).join("、")}`);
  report("误记防线", !negHit, negHit ? `⚠ 干扰项「拿铁」混进了画像` : "干扰项未混入");

  // 问答腿（全新会话，凭画像答题）
  console.log("[阶段3] 问答腿（全新会话）…");
  const qa = [
    { q: "我这就是想起来了——我对什么吃的过敏来着？", keywords: ["香菜"], name: "QA-过敏" },
    { q: "还有，我最近在捣鼓什么来着？", keywords: ["黑胶"], name: "QA-爱好" },
    { q: "我家宠物现在啥情况你还记得不？", keywords: ["送", "朋友", "皮蛋"], name: "QA-宠物现状" },
  ];
  let qaIdx = 0;
  for (const item of qa) {
    const reply = await chat(`${ACTOR}-qa-${qaIdx++}`, item.q);
    const hit = item.keywords.some((k) => reply.includes(k));
    report(item.name, hit, hit ? `命中：「${reply.slice(0, 90).replace(/\n/g, " ")}…」` : `未命中：「${reply.slice(0, 120)}」`);
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 评测汇总: ${pass}/${results.length} PASS ===`);
  console.log(`actor=${ACTOR}（数据保留可复查）`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error("评测异常:", e.message); process.exit(1); });
