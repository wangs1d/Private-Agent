/**
 * 用户画像根修四腿真链探针电池（2026-09-29 P0/P1/P2 落地验收）。
 *
 * 走常驻实例 WS 真实聊天链路，全新测试 actor（profile-battery-<ts>）：
 *   腿A 写入回归    — 喂个人信息 → 画像文件必须落位（防退化）
 *   腿B 读取判别    — 画像植入哨兵行（对话从未说过）→ 新会话提问 → 回复必须含哨兵（北极星）
 *   腿C 助手半边    — pending-turns.json 末条「助手:」非空（原 bug：恒空串）
 *   腿D 合成触发    — 寒暄轮攒队列至阈值 → 深度合成日志出现 → 队列清空
 *   影响腿 对话     — 新会话自由问「你还记得我什么」看画像参与生成
 *   影响腿 任务面   — 任务轮 audit 含 toneGuidance（personalization 真读了画像）
 *
 * 用法：node scripts/probe-user-profile-battery.mjs [--synthesis-turns=12] [--keep]
 * （--keep 保留测试 actor 数据便于排查；默认保留——画像在 data/user_profiles 可手工删）
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
const LOG_FILE = join(ROOT, "..", "logs", "autostart", `server-${new Date().toISOString().slice(0, 10)}.log`);

const args = Object.fromEntries(
  process.argv.filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return [a.slice(2, i), a.slice(i + 1)];
  }),
);
const ACTOR = `profile-battery-${Date.now()}`;
const SYNTH_TURNS = Number(args["synthesis-turns"] ?? 12);

const results = [];
function report(leg, pass, detail) {
  results.push({ leg, pass, detail });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"} [${leg}] ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WS 真链发一轮，返回最终回复全文 */
async function chatTurn(sessionId, text, timeoutSec = 120) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:3000/ws");
    let full = "";
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`WS 轮超时 ${timeoutSec}s`));
    }, timeoutSec * 1000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId: ACTOR } }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: { sessionId, userId: ACTOR, messageId: `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, timestamp: new Date().toISOString() },
        }));
      }, 300);
    });
    ws.on("message", (raw) => {
      let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }
      if (evt.type === "chat.assistant_chunk" && evt.payload?.chunk) full += evt.payload.chunk;
      else if (evt.type === "chat.assistant_done") {
        clearTimeout(timer);
        const t = evt.payload?.finalText || full;
        try { ws.close(); } catch {}
        resolve(t);
      } else if (evt.type === "error" || evt.type === "error.frame") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error(`服务端错误: ${JSON.stringify(evt.payload).slice(0, 200)}`));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const profilePath = join(DATA_DIR, "user_profiles", ACTOR, "USER_PROFILE.md");
const pendingPath = join(DATA_DIR, "user_profiles", ACTOR, "pending-turns.json");
const readProfile = () => { try { return readFileSync(profilePath, "utf8"); } catch { return null; } };
const readPending = () => { try { return JSON.parse(readFileSync(pendingPath, "utf8")); } catch { return []; } };

/** 轮询等待画像包含全部关键词（LLM 抽取 fire-and-forget） */
async function waitProfileContains(keywords, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = readProfile();
    if (p && keywords.every((k) => p.includes(k))) return p;
    await sleep(2000);
  }
  return readProfile();
}

function logTailSince(marker) {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n");
    const idx = lines.lastIndexOf(marker);
    return lines.slice(idx >= 0 ? idx : -400).join("\n");
  } catch { return ""; }
}

console.log(`=== 用户画像四腿探针电池 actor=${ACTOR} 阈值=${SYNTH_TURNS} ===\n`);

/* ── 腿A：写入回归（chat 面，两轮个人信息） ── */
try {
  console.log("[腿A] 发送个人信息轮 1/2…");
  await chatTurn(ACTOR, "跟你聊聊我自己：我叫沈青川，在青城山当登山向导，最讨厌吃香菜，养了条边牧叫阿黄。");
  console.log("[腿A] 发送个人信息轮 2/2…");
  await chatTurn(ACTOR, "补充一下：我每周三休息，休息日喜欢窝家里拼高达模型，最近在考攀岩教练证。");
  const profile = await waitProfileContains(["沈青川", "青城山", "向导", "香菜", "阿黄", "高达"]);
  if (profile) {
    const missing = ["沈青川", "青城山", "向导", "香菜", "阿黄", "高达"].filter((k) => !profile.includes(k));
    report("A-写入", missing.length === 0, missing.length === 0
      ? `画像 6/6 事实落位（${profile.length} chars）`
      : `画像缺 ${missing.join("/")}；现画像：\n${profile}`);
  } else {
    report("A-写入", false, "30s 内画像文件未出现");
  }
} catch (e) { report("A-写入", false, `异常: ${e.message}`); }

/* ── 腿B：读取判别（北极星：画像独有信息必须被 agent 用上） ── */
try {
  const before = readProfile();
  if (!before) { report("B-判别", false, "画像不存在，跳过"); throw new Error("skip"); }
  // 植入哨兵行（对话从未说过；锚点按关键词「香菜」定位行，不假设抽取器的行格式）
  // 竞态防护：腿A的抽取 LLM 可能仍在途，其整文重写会覆盖哨兵——植后观察稳定窗，
  // 被覆盖就重植，直到连续两次读取哨兵都在（抽取链静止）再提问。
  const SENTINEL = "幸运数字：47（探针哨兵）";
  const plantSentinel = () => {
    const cur = readProfile();
    if (!cur) return null;
    if (cur.includes(SENTINEL)) return cur;
    const lines = cur.split("\n");
    const anchorIdx = lines.findIndex((l) => l.includes("香菜") && l.trim().startsWith("-"));
    const insertAt = anchorIdx >= 0 ? anchorIdx + 1 : lines.findIndex((l) => l.trim() === "## 兴趣与习惯") + 1;
    lines.splice(Math.max(1, insertAt), 0, `- ${SENTINEL}`);
    writeFileSync(profilePath, lines.join("\n"), "utf8");
    return lines.join("\n");
  };
  let stable = null;
  for (let i = 0; i < 22; i++) {
    plantSentinel();
    await sleep(4000);
    const cur = readProfile();
    // 双条件才算静止：哨兵在场 + 画像文件 mtime 已 20s 无写入（在途抽取的
    // 整文重写会落在"植入后的一次读取"之后，只读一次会被咬）
    let quiet = false;
    try { quiet = Date.now() - statSync(profilePath).mtimeMs > 20000; } catch {}
    if (cur && cur.includes(SENTINEL) && quiet) { stable = cur; break; }
  }
  if (!stable) { report("B-判别", false, "哨兵 88s 内无法稳定（抽取链持续覆盖）"); throw new Error("skip"); }
  writeFileSync(profilePath, stable, "utf8");
  console.log("[腿B] 哨兵已稳定植入，新会话提问…");
  let reply = await chatTurn(`${ACTOR}-b-sentinel`, "我档案里记着我的幸运数字，是多少？照着档案答。");
  let hit = reply.includes("47");
  if (!hit) {
    console.log("[腿B] 首问未命中（模型歧义），换强锚定话术重问一次…");
    reply = await chatTurn(`${ACTOR}-b-sentinel-2`, "翻一下你的用户画像档案，里面有一条幸运数字，原样报出来。");
    hit = reply.includes("47");
  }
  report("B-判别", hit, hit
    ? `北极星达成——回复含哨兵 47：「${reply.slice(0, 120)}」`
    : `两次提问均不含画像哨兵 47：「${reply.slice(0, 160)}」`);
  // 清掉哨兵行，不污染后续腿
  writeFileSync(profilePath, before, "utf8");
} catch (e) { if (e.message !== "skip") report("B-判别", false, `异常: ${e.message}`); }

/* ── 腿C：助手半边（pending-turns 末条助手非空） ── */
try {
  await sleep(3000);
  const pending = readPending();
  const last = pending[pending.length - 1] ?? "";
  const m = last.match(/助手:\s*([\s\S]*)$/);
  const assistantSide = m ? m[1].trim() : "";
  report("C-助手半边", assistantSide.length > 0,
    `队列 ${pending.length} 条；末条助手侧 ${assistantSide ? `${assistantSide.length} 字（"${assistantSide.slice(0, 60)}…"）` : "为空（bug 未修）"}`);
} catch (e) { report("C-助手半边", false, `异常: ${e.message}`); }

/* ── 腿D：合成触发（寒暄轮攒队列 → 深度合成 → 队列清空） ── */
try {
  const logMarker = `[battery-D-start ${ACTOR}]`;
  console.log(`[腿D] 用寒暄轮攒队列到 ${SYNTH_TURNS} 条…`);
  console.log(`     （日志标记：${logMarker}）`);
  const FILLERS = ["在吗", "今天有点累", "嗯嗯", "刚吃完饭", "外面下雨了", "哈喽", "随便聊聊", "你忙啥呢", "喝口水", "下午好", "晚上好", "又是新的一天", "有点困", "刚下班", "挺好的"];
  let sent = 0;
  let guard = 0;
  while (sent < SYNTH_TURNS + 4 && guard++ < 60) {
    const pending = readPending();
    if (pending.length >= SYNTH_TURNS) break;
    const text = FILLERS[sent % FILLERS.length];
    await chatTurn(`${ACTOR}-d-filler`, text, 90).catch(() => {});
    sent++;
    await sleep(1500);
  }
  // 等合成日志（30s debounce + LLM 时长，给足 90s）
  let synthLine = "";
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const logs = readFileSync(LOG_FILE, "utf8");
    const lines = logs.split("\n").filter((l) => l.includes("深度画像合成完成") && l.includes(ACTOR));
    if (lines.length > 0) { synthLine = lines[lines.length - 1]; break; }
  }
  const pendingAfter = readPending().length;
  if (synthLine) {
    report("D-合成触发", pendingAfter < SYNTH_TURNS,
      `深度合成已触发（日志命中），合成后队列剩 ${pendingAfter} 条`);
  } else {
    report("D-合成触发", false, `90s 内未见合成日志；队列 ${readPending().length} 条（阈值 ${SYNTH_TURNS}）`);
  }
} catch (e) { report("D-合成触发", false, `异常: ${e.message}`); }

/* ── 影响腿1：对话面新会话综合问（画像+记忆协同） ── */
try {
  const reply = await chatTurn(`${ACTOR}-impact-chat`, "咱们换话题——你还记得我是谁吗？平时喜欢干什么？有什么讨厌的东西？");
  const hits = ["沈青川", "青城山", "向导", "高达", "攀岩", "香菜", "阿黄"].filter((k) => reply.includes(k));
  report("影响-对话面", hits.length >= 4,
    `新会话综合问命中 ${hits.length}/7 项（${hits.join("/")}）：「${reply.slice(0, 150)}」`);
} catch (e) { report("影响-对话面", false, `异常: ${e.message}`); }

/* ── 影响腿2：任务面（audit 验证 personalization 注入） ── */
try {
  const auditMarker = `[impact-task-start ${ACTOR}]`;
  console.log(`     （日志标记：${auditMarker}）`);
  await chatTurn(`${ACTOR}-impact-task`, "帮我看看明天青城山那边适不适合徒步，要不要带雨具", 150);
  await sleep(3000);
  const logs = readFileSync(LOG_FILE, "utf8");
  const auditLines = logs.split("\n").filter((l) => l.includes("mem-inject-audit") && l.includes(ACTOR));
  const last = auditLines[auditLines.length - 1] ?? "";
  const hasTone = last.includes("toneGuidance");
  const hasProfile = last.includes("userProfileSummary") || last.includes("userProfile");
  report("影响-任务面", hasTone && hasProfile,
    `任务轮 audit: toneGuidance=${hasTone} 画像块=${hasProfile}｜${last.slice(0, 220)}`);
} catch (e) { report("影响-任务面", false, `异常: ${e.message}`); }

/* ── 汇总 ── */
const failed = results.filter((r) => !r.pass);
console.log(`\n=== 电池汇总: ${results.length - failed.length}/${results.length} PASS ===`);
for (const r of results) console.log(`${r.pass ? "  ✅" : "  ❌"} ${r.leg}: ${r.detail.slice(0, 160)}`);
console.log(`\n测试 actor=${ACTOR}（数据保留在 data/user_profiles/${ACTOR}，可手工删除）`);
process.exit(failed.length > 0 ? 1 : 0);
