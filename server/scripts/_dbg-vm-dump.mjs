/**
 * 临时诊断：通过 VM Service 扩展 `ext.flutter.debugDumpApp` 导出当前 widget 树，
 * 提取其中 Image/NetworkImage 的加载地址，确认前端实际请求的图片 URL。
 * 用法：node scripts/_dbg-vm-dump.mjs <vmServiceBaseUrl>
 */
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://127.0.0.1:57236/j0WOU6kzDcE=/";
const wsUrl = BASE.replace(/^http/, "ws") + "/ws";

let seq = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

ws.on("open", async () => {
  try {
    const vm = await call("getVM");
    const isolates = vm?.result?.isolates ?? [];
    console.log("ISOLATES:", isolates.map((i) => i.id));
    for (const iso of isolates) {
      let dump = "";
      try {
        const r = await call("callServiceExtension", {
          isolateId: iso.id,
          method: "ext.flutter.debugDumpApp",
        });
        dump = r?.result?.data ?? r?.result?.value ?? "";
      } catch (e) {
        console.log("callServiceExtension failed, trying direct RPC:", e.message?.slice(0, 120));
        try {
          const r = await call("ext.flutter.debugDumpApp", { isolateId: iso.id });
          dump = r?.result?.data ?? r?.result?.value ?? "";
        } catch (e2) {
          console.log("direct RPC failed:", e2.message?.slice(0, 200));
        }
      }
      // 只打印与图片/网络相关的行
      const lines = String(dump).split("\n").filter((l) =>
        /image|Image|http|NetworkImage|FileImage|MemoryImage/i.test(l));
      console.log(`\n=== IMAGE-RELATED LINES (${lines.length}) ===`);
      lines.slice(0, 120).forEach((l) => console.log(l));
      console.log(`\nDUMP TOTAL LINES: ${String(dump).split("\n").length}`);
      break;
    }
  } catch (err) {
    console.log("ERR:", err.message ?? String(err));
  }
  ws.close();
  process.exit(0);
});

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m);
    return;
  }
});

ws.on("error", (e) => { console.log("WS ERROR:", e.message); process.exit(1); });
