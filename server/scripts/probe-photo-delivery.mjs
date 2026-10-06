/**
 * 照片轮真链探针（2026-10-06「搜照片别回废话」验收，参照 probe-user-profile-live.mjs 骨架）。
 *
 * 走常驻实例(127.0.0.1:3000)的 WebSocket 真实聊天链路发一条搜照片消息，
 * 收 chat.assistant_done 后拼全文打印。验收点（人工比对）：
 *   1. 正文一两句话收束，没有「已确认的/能说的/没查到的」式分节盘点；
 *   2. 媒体卡（photos/mediaCards）里带回了照片；
 *   3. 每张照片有 caption（VLM 一图一句，异步生成，可能晚于 done 到达——
 *      caption 缺失不算失败，正文形态才是本探针的验收主体）。
 *
 * 用法: node scripts/probe-photo-delivery.mjs --userId=photo-probe-e2e --text="搜搜刘浩存的照片"
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
const userId = args.userId ?? "photo-probe-e2e";
const sessionId = args.sessionId ?? userId;
const timeoutMs = Number(args.timeout ?? 180) * 1000;
const text = args.text ?? "搜搜刘浩存的照片";

const ws = new WebSocket("ws://127.0.0.1:3000/ws");
const eventCounts = {};
let full = "";
let chunks = 0;
let donePayload = null;

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
          messageId: `probe-photo-${Date.now()}`,
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
  if (t !== "chat.assistant_chunk" && t !== "agent.embodiment.patch") {
    console.log(`[probe] ${t}:`, JSON.stringify(evt.payload ?? {}).slice(0, 400));
  }
  if (t === "chat.assistant_chunk") {
    const piece = evt.payload?.chunk ?? evt.payload?.text ?? evt.payload?.delta ?? "";
    if (piece) {
      full += piece;
      chunks++;
    }
  } else if (t === "chat.assistant_done") {
    donePayload = evt.payload ?? {};
    const doneText = donePayload.finalText ?? donePayload.text ?? donePayload.content ?? donePayload.message ?? "";
    if (!full && doneText) full = doneText;
    console.log("[probe] 事件统计:", JSON.stringify(eventCounts));
    console.log("[probe] ===== 最终回复（正文） =====");
    console.log(full || "(无文本)");
    console.log("[probe] ==============================");
    const cards = donePayload.mediaCards ?? donePayload.photos ?? [];
    if (Array.isArray(cards) && cards.length > 0) {
      console.log(`[probe] 媒体卡 ${cards.length} 张:`);
      for (const c of cards) {
        console.log(
          `  - type=${c.type} caption=${c.caption ? JSON.stringify(c.caption) : "(未生成/异步)"} mediaUrl=${(c.mediaUrl ?? c.thumbnailUrl ?? "").slice(0, 60)}`,
        );
      }
    } else {
      console.log("[probe] done payload 无 mediaCards 字段（键:", Object.keys(donePayload).join(","), "）");
    }
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
