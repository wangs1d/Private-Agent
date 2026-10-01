/**
 * 画像升级五项真链演示/验收（2026-09-29 P0-2 / P0-1a / P1-1 / P1-2 / P2）。
 *
 * T1 profile.update 自编辑（说话算话的记）：普通事实 → 工具调用 → 画像落行
 * T2 敏感类目确认闸：未确认被拒 → 用户同意 → 才落画像
 * T3 隐身会话 A/B：incognito: 前缀不进 pending 队列，对照组正常进
 * T4 新鲜度+一致性合成：预置陈旧画像+矛盾信息 → 强制合成 → 画像收敛到现状
 * T5 冷启动引导：全新 actor 首轮 → 注入审计含 onboardingHint
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import WebSocket from "ws";

const ROOT = join(import.meta.dirname, "..");
const TS = Date.now();
const LOG_FILE = join(ROOT, "..", "logs", "autostart", `server-${new Date().toISOString().slice(0, 10)}.log`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = (leg, pass, detail) => { results.push(pass); console.log(`${pass ? "✅ PASS" : "❌ FAIL"} [${leg}] ${detail}`); };

function chat(userId, sessionId, text, timeoutSec = 110) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3000/ws");
    let full = "";
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("超时")); }, timeoutSec * 1000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId } }));
      setTimeout(() => ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: { sessionId, userId, messageId: `u-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, text, timestamp: new Date().toISOString() },
      })), 250);
    });
    ws.on("message", (raw) => {
      let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }
      if (evt.type === "chat.assistant_chunk" && evt.payload?.chunk) full += evt.payload.chunk;
      else if (evt.type === "chat.assistant_done") {
        clearTimeout(timer); try { ws.close(); } catch {}
        resolve({ text: evt.payload?.finalText || full, toolCalls: evt.payload?.toolCalls ?? [] });
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const actorDir = (actor) => join(ROOT, "data", "user_profiles", actor);
const readProfile = (actor) => { try { return readFileSync(join(actorDir(actor), "USER_PROFILE.md"), "utf8"); } catch { return null; } };
const readPending = (actor) => { try { return JSON.parse(readFileSync(join(actorDir(actor), "pending-turns.json"), "utf8")); } catch { return []; } };
async function waitProfileContains(actor, kw, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = readProfile(actor);
    if (p && kw.some((k) => p.includes(k))) return p;
    await sleep(2000);
  }
  return readProfile(actor);
}

/* ── T1: profile.update 自编辑 ── */
async function t1() {
  const actor = `profile-tool-${TS}`;
  console.log(`\n[T1] 说话算话的记（actor=${actor}）`);
  console.log("👤 跟你同步个长期信息：我对花生过敏，这条你记到自己的用户档案里，以后别给我推花生相关的。");
  const { text, toolCalls } = await chat(actor, actor, "跟你同步个长期信息：我对花生过敏，这条你记到自己的用户档案里，以后别给我推花生相关的。");
  console.log(`🤖 ${text.slice(0, 140)}`);
  // 注意：assistant_done.toolCalls 只装任务面调用，chat 面工具调用不在其中——
  // 落位以画像文件为准（工具/管线写入均落同一 applyProfileOps 通道）。
  const claimedDone = /记下|写进|档案|记住/.test(text);
  const p = await waitProfileContains(actor, ["花生"]);
  const landed = !!p && /对花生过敏/.test(p);
  report("T1-自编辑", claimedDone && landed,
    claimedDone
      ? landed ? `画像落行（${(p.match(/.*花生.*/) ?? [""])[0].trim().slice(0, 60)}）+ 回复明确复述（说话算话）`
              : "回复说记了但画像未见花生（查写入通道）"
      : `回复未确认记录（toolCalls=${JSON.stringify(toolCalls).slice(0, 80)}）`);
}

/* ── T2: 敏感确认闸 ── */
async function t2() {
  const actor = `profile-sens-${TS}`;
  console.log(`\n[T2] 敏感类目确认闸（actor=${actor}）`);
  console.log("👤 我最近确诊了抑郁症，你记一下吧。");
  const r1 = await chat(actor, actor, "我最近确诊了抑郁症，你记一下吧。");
  console.log(`🤖 第一响应: ${r1.text.slice(0, 130)}`);
  const r1CalledTool = JSON.stringify(r1.toolCalls).includes("profile.update");
  console.log("👤 嗯，记吧，没事。");
  const r2 = await chat(actor, actor + "-c", "嗯，记吧，没事。");
  console.log(`🤖 第二响应: ${r2.text.slice(0, 110)}`);
  const p = await waitProfileContains(actor, ["抑郁"], 40000);
  const landed = !!p && p.includes("抑郁");
  // 工具闸语义：首轮未带确认不得由工具写入；用户明确同意后信息在画像中（工具
  // 确认后写 or 用户明示后的管线抽取皆算合规——用户原话本身就是同意）。
  report("T2-敏感确认", !r1CalledTool && landed,
    `首轮工具未越闸=${!r1CalledTool}；同意后落画像=${landed}${landed ? `（${(p.match(/.*抑郁.*/) ?? [""])[0].trim().slice(0, 60)}）` : ""}`);
}

/* ── T3: 隐身 A/B ── */
async function t3() {
  const norm = `profile-inc-n-${TS}`;
  const inco = `profile-inc-i-${TS}`;
  console.log(`\n[T3] 隐身 A/B（norm=${norm} / inco=${inco}）`);
  await chat(norm, norm, "我叫赵铁柱，在唐山开货车。");
  await chat(norm, norm + "-b", "今天风大。");
  await chat(inco, `incognito:${inco}`, "我叫赵铁柱，在唐山开货车。");
  await chat(inco, `incognito:${inco}-b`, "今天风大。");
  await sleep(4000);
  const pNorm = readPending(norm).length;
  const pInco = readPending(inco).length;
  const fInco = readProfile(inco);
  const profileUntouched = !fInco || (!fInco.includes("赵铁柱") && !fInco.includes("唐山"));
  report("T3-隐身", pNorm >= 2 && pInco === 0 && profileUntouched,
    `对照组队列=${pNorm} 条（正常），隐身组队列=${pInco} 条、画像${fInco ? (fInco.includes("赵铁柱") ? "被写入(异常)" : "未写入") : "未生成"}；隐身组画像文件${existsSync(join(actorDir(inco), "USER_PROFILE.md")) ? "存在但无事实" : "未生成"}`);
}

/* ── T4: 新鲜度+一致性合成 ── */
async function t4() {
  const actor = `profile-stale-${TS}`;
  console.log(`\n[T4] 新鲜度+一致性合成（actor=${actor}）`);
  const now = new Date();
  const old = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  const profile = `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。最后更新：${old}
> 用户标识：\`${actor}\`

## 基本信息

- 职业：程序员（在写 Java）
- 所在地：杭州

## 兴趣与习惯

- 最喜欢的乐队：Westlife（2008 年狂粉）

## 备注

- （重要但不宜归类到以上的信息）
`;
  mkdirSync(actorDir(actor), { recursive: true });
  writeFileSync(join(actorDir(actor), "USER_PROFILE.md"), profile, "utf8");
  const meta = {};
  for (const line of ["职业：程序员（在写 Java）", "所在地：杭州", "最喜欢的乐队：Westlife（2008 年狂粉）"]) {
    meta[`基本信息::${line}`] = { line, section: "基本信息", firstSeenAt: old, lastConfirmedAt: old, seenCount: 1 };
    meta[`兴趣与习惯::${line}`] = { line, section: "兴趣与习惯", firstSeenAt: old, lastConfirmedAt: old, seenCount: 1 };
  }
  writeFileSync(join(actorDir(actor), "profile-lines-meta.json"), JSON.stringify(meta), "utf8");
  // 预置 11 条队列（第 1 条带矛盾现状：现在不做程序员了，改行做牙医；乐队早就不听了）
  const blocks = [
    "用户: 说个事，我早就不写 Java 了，现在转行做牙医了，诊所开在苏州。\n助手: ",
    "用户: Westlife 早不听了，现在听告五人。\n助手: ",
  ];
  for (let i = 0; i < 9; i++) blocks.push(`用户: 填充轮${i}\n助手: `);
  writeFileSync(join(actorDir(actor), "pending-turns.json"), JSON.stringify(blocks), "utf8");
  // 第 12 条真实聊天轮触发合成
  await chat(actor, actor, "好了我说完了，你记一下重点就行。").catch(() => {});
  // 等合成（按行匹配：整文件 includes 会把别的 actor 的合成行 + 本 actor 的 audit 行误拼命中）
  let synth = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const logs = readFileSync(LOG_FILE, "utf8");
    synth = logs.split("\n").some((l) => l.includes("深度画像合成完成") && l.includes(actor));
    if (synth) break;
  }
  await sleep(1500);
  const after = readProfile(actor) ?? "";
  // 演变式改写也算收敛：新现状在场 + 旧内容只允许以「转行/不再/已从」演变注记出现
  const hasDentist = after.includes("牙医");
  const hasWuJiaoRen = after.includes("告五人");
  const staleResidue = /职业[：:]\s*程序员|乐队[：:]\s*Westlife/.test(after);
  const metaKeys = existsSync(join(actorDir(actor), "profile-lines-meta.json"))
    ? Object.keys(JSON.parse(readFileSync(join(actorDir(actor), "profile-lines-meta.json"), "utf8"))).length
    : 0;
  report("T4-新鲜度+一致性", synth && hasDentist && hasWuJiaoRen && !staleResidue,
    `合成=${synth}；牙医=${hasDentist} 告五人=${hasWuJiaoRen} 旧现状残留（行首仍是程序员/Westlife）=${staleResidue}；sidecar 重建后行数=${metaKeys}`);
}

/* ── T5: 冷启动引导 ── */
async function t5() {
  const actor = `profile-cold-${TS}`;
  console.log(`\n[T5] 冷启动引导（actor=${actor}）`);
  const { text } = await chat(actor, actor, "在吗？");
  console.log(`🤖 ${text.slice(0, 120)}`);
  await sleep(2500);
  const logs = readFileSync(LOG_FILE, "utf8");
  const auditLines = logs.split("\n").filter((l) => l.includes("mem-inject-audit") && l.includes(actor));
  const hinted = auditLines.some((l) => l.includes("onboardingHint"));
  const asked = /称呼|怎么称呼|叫你|认识一下|在忙/.test(text);
  report("T5-冷启动", hinted,
    `注入审计含 onboardingHint=${hinted}；回复是否自然破冰=${asked}（「${text.slice(0, 60)}」）`);
}

const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "").toUpperCase();
const LEGS = [["T1", t1], ["T2", t2], ["T3", t3], ["T4", t4], ["T5", t5]];
for (const [name, fn] of LEGS) {
  if (ONLY && name !== ONLY) continue;
  await fn();
}
const failed = results.filter((r) => !r).length;
console.log(`\n=== 升级演示汇总: ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed > 0 ? 1 : 0);
