/**
 * 用户画像真链探针（2026-09-29「画像是否真的被改写/被用在对话中」验证）。
 *
 * 走常驻实例(127.0.0.1:3000)的 WebSocket 真实聊天链路:
 *   连 /ws → session.init → chat.user_message → 收流(chat.assistant_chunk)
 *   → chat.assistant_done 后拼全文退出。打印事件类型统计与最终回复。
 *
 * 用法:
 *   node scripts/probe-user-profile-live.mjs --userId=profile-probe-e2e --text="你好"
 *   (--text 缺省时用内置个人信息喂料话术;--timeout=90s 上限)
 */
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(2, i), a.slice(i + 1)];
    }),
);
const userId = args.userId ?? "profile-probe-e2e";
const sessionId = args.sessionId ?? userId;
const timeoutMs = Number(args.timeout ?? 120) * 1000;
const text =
  args.text ??
  "跟你聊聊我自己吧：我叫周明远，在成都当消防员，平时休息日最大的爱好是钓鱼和听评书，最近刚开始学日语，每天早上背五十音图。";

const ws = new WebSocket("ws://127.0.0.1:3000/ws");
const eventCounts = {};
let full = "";
let chunks = 0;

const timer = setTimeout(() => {
  console.error(`[probe] 超时 ${timeoutMs / 1000}s，已收 ${chunks} chunks，强制退出`);
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
          messageId: `probe-${Date.now()}`,
          text,
          timestamp: new Date().toISOString(),
        },
      }),
    );
    console.log(`[probe] 已发送 user_message (actor=${userId}):\n  ${text}\n`);
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
  eventCounts[t] = (eventCounts[t] ?? 0) + 1;
  if (t === "chat.assistant_chunk") {
    if (chunks === 0) console.log("[probe] 首个 chunk payload 结构:", JSON.stringify(evt.payload).slice(0, 500));
    const piece = evt.payload?.chunk ?? evt.payload?.text ?? evt.payload?.delta ?? "";
    if (piece) {
      full += piece;
      chunks++;
    }
  } else if (t === "chat.assistant_done") {
    if (chunks === 0) console.log("[probe] done payload 结构:", JSON.stringify(evt.payload).slice(0, 800));
    const doneText = evt.payload?.finalText ?? evt.payload?.text ?? evt.payload?.content ?? evt.payload?.message ?? "";
    if (!full && doneText) full = doneText;
    console.log("[probe] 事件统计:", JSON.stringify(eventCounts));
    console.log("[probe] ===== 最终回复 =====");
    console.log(full || "(无文本)");
    console.log("[probe] ======================");
    clearTimeout(timer);
    setTimeout(() => process.exit(0), 500);
  } else if (t === "error" || t === "error.frame") {
    console.error("[probe] 服务端错误:", JSON.stringify(evt.payload).slice(0, 300));
    clearTimeout(timer);
    process.exit(1);
  }
});

ws.on("error", (e) => {
  console.error("[probe] WS 错误:", e.message);
  process.exit(1);
});
