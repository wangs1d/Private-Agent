/**
 * 临时诊断：在运行中 Flutter 应用的 Dart VM Service 里执行一段代码，
 * 用应用自身的 dart:io HttpClient 请求目标图片 URL，并通过 dart:developer log
 * 把结果打回 Logging 流。用于判断「后端文件存在 + HTTP 200」但前端破图的原因。
 * 用法：node scripts/_dbg-vm-http.mjs <vmServiceBaseUrl> <imageUrl>
 */
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://127.0.0.1:57232/3TWy9weabTU=/";
const IMG_URL = process.argv[3] ??
  "http://127.0.0.1:3000/agent/images/session-mvp-001/1787160724031-0df73475.png";
const wsUrl = BASE.replace(/^http/, "ws") + "/ws";

let seq = 0;
const pending = new Map();
const logs = [];

const ws = new WebSocket(wsUrl);
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function onEvent(evt) {
  const method = evt?.method ?? "";
  const kind = evt?.kind ?? "";
  if (method === "Logging") {
    const rec = evt?.params?.logRecord ?? {};
    const msg = rec?.message?.value ?? rec?.message ?? "";
    if (String(msg).includes("DBGHTTP")) logs.push(msg);
  }
  if (kind === "Flutter.ImageError") {
    logs.push("[IMAGE ERROR] " + JSON.stringify(evt).slice(0, 800));
  }
}

const probe = `
import 'dart:developer' as dev;
import 'dart:io';
(() async {
  final sw = Stopwatch()..start();
  try {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    final req = await client.getUrl(Uri.parse('${IMG_URL}'));
    final res = await req.close();
    final status = res.statusCode;
    await res.drain<void>();
    dev.log('DBGHTTP url=' + '${IMG_URL}' + ' status=' + status.toString() + ' ms=' + sw.elapsedMilliseconds.toString());
    client.close(force: true);
  } catch (e) {
    dev.log('DBGHTTP url=' + '${IMG_URL}' + ' ERR=' + e.toString() + ' ms=' + sw.elapsedMilliseconds.toString());
  }
})();
'started'
`;

ws.on("open", async () => {
  try {
    const vm = await call("getVM");
    const isolates = vm?.result?.isolates ?? [];
    console.log("ISOLATES:", isolates.map((i) => i.id));
    for (const iso of isolates) {
      await call("streamListen", { streamId: "Logging" });
      const r = await call("getIsolate", { isolateId: iso.id });
      const libs = r?.result?.libraries ?? [];
      const entry = libs.find((l) => /main\.dart/.test(l.uri || ""));
      if (!entry) continue;
      const ev = await call("evaluate", {
        isolateId: iso.id,
        targetId: entry.id,
        expression: probe,
      });
      console.log("EVAL:", JSON.stringify(ev?.result ?? ev?.error ?? {}).slice(0, 300));
      break;
    }
    console.log("LISTENING 12s for probe result...");
    await new Promise((res) => setTimeout(res, 12_000));
    console.log("=== PROBE LOGS ===");
    console.log(logs.length ? logs.join("\n") : "(no DBGHTTP log captured)");
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
  if (m.method && m.method.startsWith("streamNotify")) {
    onEvent(m.params?.event ?? {});
  }
});

ws.on("error", (e) => { console.log("WS ERROR:", e.message); process.exit(1); });
