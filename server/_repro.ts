import { writeFileSync } from "node:fs";
import { ChatThreadStore, buildMessageTimestampPrefix } from "./src/external-model/chat-thread-store.js";

const now = new Date();
const y = new Date();
y.setDate(y.getDate() - 1);
const t = new Date();
t.setDate(t.getDate() - 2);

const s = new ChatThreadStore(null);
const msgs: any[] = [
  { role: "system", content: "system" },
  { role: "user", content: buildMessageTimestampPrefix(t) + " 前天我去公园了" },
  { role: "assistant", content: buildMessageTimestampPrefix(t) + " 公园好玩吗" },
  { role: "user", content: buildMessageTimestampPrefix(y) + " 昨天买了新手机" },
  { role: "assistant", content: buildMessageTimestampPrefix(y) + " 什么型号" },
  { role: "user", content: buildMessageTimestampPrefix(now) + " 今天天气怎么样" },
  { role: "assistant", content: buildMessageTimestampPrefix(now) + " 今天晴天" },
];
let out: string;
try {
  s.trimThread(msgs, 2);
  out = "LEN=" + msgs.length + "\n" + msgs.map((m) => m.role + " => " + (typeof m.content === "string" ? m.content : "[multi]")).join("\n");
} catch (e) {
  out = "THREW: " + (e as Error).message + "\n" + ((e as Error).stack ?? "");
}
writeFileSync("./_repro.out.json", JSON.stringify(out));