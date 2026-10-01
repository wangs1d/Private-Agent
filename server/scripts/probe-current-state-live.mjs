/**
 * 当下状态块真链探针（2026-10-01 P0「顺嘴要贴此刻」验收）。
 *
 * 链路：WorldBoard.current（真实传感）→ agentCore.setCurrentStateProvider
 * → prompt builder【当下状态】块 → 聊天模型回复。
 *
 * 步骤：
 *   1. 读 data/proactivity/world-board.json 拿真实账号的 current 真值（参考答案）
 *   2. WS 真实聊天链路问「我现在在干嘛」
 *   3. 断言回复引用了板上的焦点种类（行为级证明模型看到了此刻状态）
 *
 * 用法: node scripts/probe-current-state-live.mjs [--userId=2378709729@qq.com]
 * 注意：向真实账号会话发一条验收消息（会留在会话线程里）。
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(2, i), a.slice(i + 1)];
    }),
);

const boardPath = join(process.cwd(), "data", "proactivity", "world-board.json");
const board = JSON.parse(readFileSync(boardPath, "utf8"));

// 真实账号 = 最近交互的 actor（与 bootstrap primaryActor 同口径）
const actorId = args.userId ?? args.actorId ?? "";
const actorData = actorId
  ? board.actors?.[actorId]
  : null;
if (!actorData) {
  console.error(`[probe] 板上找不到 actor=${actorId || "(未指定)"}，可用: ${Object.keys(board.actors ?? {}).filter((k) => !k.includes("e2e") && !k.includes("bench") && !k.includes("profile-") && !k.includes("probe")).join(", ")}`);
  process.exit(2);
}
const focus = actorData.current?.screenFocus;
const presence = actorData.current?.presence;
console.log(`[probe] 板上真值 actor=${actorId}`);
console.log(`  screenFocus: ${JSON.stringify(focus)}`);
console.log(`  presence:    ${JSON.stringify(presence)}`);
if (!focus && !presence) {
  console.error("[probe] 板上 current 层无数据，先等传感信号入板再跑");
  process.exit(2);
}

// 焦点种类 → 回复应出现的关键词族（行为断言用）
const FOCUS_HINTS = {
  game: ["游戏", "打游", "玩"],
  coding: ["代码", "编码", "写码", "开发", "IDE", "编辑器"],
  browsing: ["浏览", "网页", "上网", "浏览器"],
  meeting: ["会议", "开会"],
  video: ["视频", "看片", "B站", "追"],
  music: ["音乐", "听歌"],
  chat: ["聊天软件", "微信", "IM"],
  office: ["文档", "办公", "Office"],
  terminal: ["终端", "命令行", "终端里"],
  idle: ["空闲", "闲置", "没在", "挂着"],
};
const kind = String(focus?.kind ?? "").toLowerCase();
const hints = FOCUS_HINTS[kind] ?? [];

const userId = actorId;
const sessionId = `${userId}`;
const timeoutMs = 90 * 1000;
const ws = new WebSocket("ws://127.0.0.1:3000/ws");
let full = "";
let chunks = 0;

const timer = setTimeout(() => {
  console.error(`[probe] 超时，已收 ${chunks} chunks`);
  process.exit(2);
}, timeoutMs);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId } }));
  setTimeout(() => {
    ws.send(
      JSON.stringify({
        type: "chat.user_message",
        payload: {
          sessionId,
          userId,
          messageId: `probe-cs-${Date.now()}`,
          text: "别翻记忆也别猜，就凭你此刻的感知说一句：我这会儿在干嘛？",
          timestamp: new Date().toISOString(),
        },
      }),
    );
    console.log(`[probe] 已发送提问 (actor=${userId})`);
  }, 300);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const t = evt.type ?? "?";
  if (t === "chat.assistant_chunk") {
    const piece = evt.payload?.chunk ?? evt.payload?.text ?? evt.payload?.delta ?? "";
    if (piece) {
      full += piece;
      chunks++;
    }
  } else if (t === "chat.assistant_done") {
    const doneText = evt.payload?.finalText ?? evt.payload?.text ?? "";
    if (!full && doneText) full = doneText;
    clearTimeout(timer);
    console.log("\n[probe] ===== 回复 =====");
    console.log(full || "(空)");
    const hit = hints.some((h) => full.includes(h));
    const staleNote = full.includes("看不到") || full.includes("不知道") || full.includes("感知不到");
    console.log(`\n[probe] 焦点=${kind} 期望词族=[${hints.join("/")}] 命中=${hit}${staleNote ? "（回复自述无法感知——检查注入链）" : ""}`);
    ws.close();
    process.exit(hit ? 0 : 1);
  }
});

ws.on("error", (err) => {
  console.error(`[probe] WS 错误: ${err.message}`);
  process.exit(2);
});
