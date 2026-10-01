// 真机取证驱动：经 Dart VM service 直调 ext.pai.debug.sendChat，让真实 app
// 发一条闲聊（真实 WS → 服务端分泡 → 真实气泡渲染）。
// 用法: node bubble-app-drive.mjs <vmServiceHttpUri> [text] [waitMs]
// 例:   node bubble-app-drive.mjs http://127.0.0.1:58855/sAy9j4G-1-8=/ "在吗，晚上一起吃饭不" 12000
import WebSocket from "ws";

const httpUri = process.argv[2];
const text = process.argv[3] ?? "在吗，晚上一起吃饭不";
const waitMs = Number(process.argv[4] ?? "12000");
if (!httpUri) {
  console.error("need vm service http uri");
  process.exit(1);
}
const wsUri = httpUri.replace(/^http/, "ws").replace(/\/?$/, "/ws");

const ws = new WebSocket(wsUri);
let id = 0;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = `req-${++id}`;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params: params ?? {} }));
  });
}

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
});

ws.on("open", async () => {
  try {
    const vm = await call("getVM");
    const isolateId = vm.isolates?.[0]?.id;
    console.log(`isolate: ${isolateId}`);
    // 等 app 完全就绪（首帧 + WS 连接）
    await new Promise((r) => setTimeout(r, 3000));
    const t0 = Date.now();
    const resp = await call("ext.pai.debug.sendChat", { isolateId, text });
    console.log(`sendChat resp(${Date.now() - t0}ms): ${JSON.stringify(resp)}`);
    console.log(`wait ${waitMs}ms for reply bubbles...`);
    await new Promise((r) => setTimeout(r, waitMs));
    console.log("done - screenshot now");
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error(`drive failed: ${e.message}`);
    process.exit(1);
  }
});

ws.on("error", (e) => {
  console.error(`ws error: ${e.message}`);
  process.exit(1);
});
