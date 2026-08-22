/**
 * 临时诊断：连接运行中 Flutter 应用的 Dart VM Service，
 * 抓取最近的日志（Flutter.Error / Flutter.ImageError / 网络错误）与当前 isolate 信息。
 * 用法：node scripts/_dbg-vm-errors.mjs http://127.0.0.1:57232/3TWy9weabTU=/
 */
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://127.0.0.1:57232/3TWy9weabTU=/";
const wsUrl = BASE.replace(/^http/, "ws") + "/ws";

let seq = 0;
const pending = new Map();
const logs = [];

const ws = new WebSocket(wsUrl);

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = String(++seq);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function onEvent(evt) {
  const kind = evt?.kind ?? "";
  const method = evt?.method ?? "";
  if (method === "Logging" || kind === "Logging") {
    const rec = evt?.params?.logRecord ?? {};
    const ts = new Date(rec?.time).toLocaleTimeString();
    const level = rec?.level?.name ?? "?";
    const msg = rec?.message?.value ?? rec?.message ?? "";
    logs.push(`[${ts}][${level}] ${msg}`);
    if (logs.length > 60) logs.shift();
  }
  if (kind === "Flutter.Error" || kind === "Flutter.FrameworkInitialization" ||
      kind === "Flutter.ImageError" || method === "Flutter.Error") {
    logs.push(`[FLUTTER ERROR] ${JSON.stringify(evt).slice(0, 1500)}`);
  }
}

ws.on("open", async () => {
  try {
    const vm = await call("getVM");
    const isolateIds = (vm?.result?.isolates ?? []).map((i) => i.id);
    console.log("ISOLATES:", isolateIds);
    for (const id of isolateIds) {
      const iso = await call("getIsolate", { isolateId: id });
      const r = iso?.result ?? {};
      console.log(`\n=== isolate ${id} ===`);
      console.log("name:", r.name);
      if (r.extensionRPCs) {
        const rel = r.extensionRPCs.filter((e) => /log|error|image/i.test(e));
        if (rel.length) console.log("relevant extensions:", rel.join(", "));
      }
      // 订阅日志流
      await call("streamListen", { streamId: "Logging" });
      await call("streamListen", { streamId: "Extension" });
    }
    console.log("\nLISTENING for events (30s)...");
    // 让事件积累一段时间
    await new Promise((res) => setTimeout(res, 25_000));
    console.log("\n=== COLLECTED LOGS ===");
    console.log(logs.length ? logs.join("\n") : "(no logs captured)");
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
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method && m.method.startsWith("streamNotify")) {
    onEvent(m.params?.event ?? {});
  }
});

ws.on("error", (e) => {
  console.log("WS ERROR:", e.message);
  process.exit(1);
});
