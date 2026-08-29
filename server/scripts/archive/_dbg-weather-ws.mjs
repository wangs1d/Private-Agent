const WS_URL = process.env.WS_URL ?? "ws://localhost:3000/ws";
const QUERY = process.argv[2] ?? "今天上海天气怎么样";
// 模拟真实用户 GPS：设置 TEST_LAT/TEST_LON 时，收到 agent.location_request 会回传此坐标。
const TEST_LAT = Number(process.env.TEST_LAT ?? "");
const TEST_LON = Number(process.env.TEST_LON ?? "");
const TEST_CITY = process.env.TEST_CITY ?? "";
const userId = `verify-w-${Date.now()}`;

const ws = new WebSocket(WS_URL);
let done = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "session.init", payload: { userId, sessionId: userId } }));
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: userId, userId, messageId: `m-${Date.now()}`, text: QUERY, timestamp: new Date().toISOString() },
    }),
  );
  console.log(`[send] ${QUERY}`);
};

ws.onmessage = (event) => {
  let evt;
  try {
    evt = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const p = evt.payload ?? {};
  // 模拟客户端响应实时位置请求
  if (evt.type === "agent.location_request" && Number.isFinite(TEST_LAT) && Number.isFinite(TEST_LON)) {
    const report = {
      type: "client.location_report",
      payload: {
        jobId: p.jobId,
        latitude: TEST_LAT,
        longitude: TEST_LON,
        ...(TEST_CITY ? { city: TEST_CITY } : {}),
      },
    };
    ws.send(JSON.stringify(report));
    console.log(`[LOCATION_REPLY] ${JSON.stringify(report.payload)}`);
    return;
  }
  if (evt.type === "chat.assistant_chunk") {
    process.stdout.write(`[chunk:${p.phase ?? "?"}] ${p.chunk ?? ""}\n`);
  } else if (evt.type === "chat.assistant_done") {
    console.log(`[DONE] finalText=${JSON.stringify(p.finalText)} toolCalls=${JSON.stringify(p.toolCalls)}`);
    done = true;
    ws.close();
  } else if (evt.type === "tool_call" || evt.type === "tool_call_start" || evt.type === "chat.tool_call") {
    console.log(`[TOOL_CALL] ${JSON.stringify(p)}`);
  } else if (evt.type === "tool_result" || evt.type === "chat.tool_result") {
    const res = p.result;
    console.log(`[TOOL_RESULT] ok=${p.ok} name=${p.toolName ?? p.name} result=${JSON.stringify(res)?.slice(0, 500)}`);
  } else if (evt.type === "chat.agent_status") {
    console.log(`[STATUS] ${p.line ?? ""}`);
  } else if (evt.type === "error" || evt.type === "chat.error") {
    console.log(`[ERROR] ${JSON.stringify(p)}`);
  } else {
    console.log(`[${evt.type}] ${JSON.stringify(p)?.slice(0, 300)}`);
  }
};

ws.onclose = () => {
  console.log("\n[conn] closed");
  process.exit(0);
};
ws.onerror = (err) => {
  console.error("[conn] error:", err.message ?? err);
  process.exit(1);
};

setTimeout(() => {
  if (!done) {
    console.error("\n[timeout] 60s no done");
    process.exit(2);
  }
}, 60_000);
