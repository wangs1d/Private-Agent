import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";

// ---- 环境准备（须在动态 import 服务模块前完成：超时常量为模块加载期 IIFE 读取）----
process.env.VIRTUAL_PHONE_USER_CALL_AGENT_TIMEOUT_MS = "400";
const tmpDir = await mkdtemp(join(tmpdir(), "vp-service-test-"));
process.env.VIRTUAL_PHONES_FILE = join(tmpDir, "virtual-phones.json");

const { VirtualPhoneService } = await import("../src/services/virtual-phone-service.js");
const { WsConnectionRegistry } = await import("../src/services/ws-connection-registry.js");

type SentEvent = { type: string; payload: Record<string, unknown> };

class FakeSocket {
  sent: SentEvent[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentEvent);
  }
}

function makeService(opts?: { paired?: boolean }) {
  const registry = new WsConnectionRegistry();
  const sockets = new Map<string, FakeSocket>();
  const connect = (id: string): FakeSocket => {
    const s = new FakeSocket();
    sockets.set(id, s);
    registry.register(id, s);
    return s;
  };
  const tts = {
    synthesizeMp3Base64: async (text: string) => ({
      ok: true as const,
      format: "mp3" as const,
      base64: Buffer.from(text).toString("base64"),
    }),
  };
  const pairing = { arePaired: () => opts?.paired ?? true };
  const service = new VirtualPhoneService(
    tts as never,
    registry,
    pairing as never,
  );
  return { service, connect, sockets };
}

function eventsOf(sock: FakeSocket, type: string): SentEvent[] {
  return sock.sent.filter((e) => e.type === type);
}

async function until(fn: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 号码申领
// ============================================================

test("ensureNumber 分配 6 位号码且幂等", async () => {
  const { service } = makeService();
  const first = service.ensureNumber("actor-a");
  assert.match(first, /^\d{6}$/);
  assert.equal(service.ensureNumber("actor-a"), first);
  assert.equal(service.resolveActorByPhone(first), "actor-a");
});

test("ensureNumber 持久化到 VIRTUAL_PHONES_FILE", async () => {
  const { service } = makeService();
  const num = service.ensureNumber("actor-persist");
  await sleep(50);
  const raw = JSON.parse(await readFile(process.env.VIRTUAL_PHONES_FILE!, "utf8")) as {
    byActor: Record<string, string>;
  };
  assert.equal(raw.byActor["actor-persist"], num);
});

// ============================================================
// placeCall（Agent → Agent）
// ============================================================

test("placeCall：主叫未申领号码时报错", async () => {
  const { service } = makeService();
  const targetNum = service.ensureNumber("actor-target");
  const result = await service.placeCall({
    fromActorId: "actor-caller",
    toPhone: targetNum,
    transcript: "你好",
    ringStyle: "peer",
    initiatedBy: "user",
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /申领/);
});

test("placeCall：被叫号码未注册时报错", async () => {
  const { service } = makeService();
  service.ensureNumber("actor-caller");
  const result = await service.placeCall({
    fromActorId: "actor-caller",
    toPhone: "999999",
    transcript: "你好",
    ringStyle: "peer",
    initiatedBy: "user",
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /未注册/);
});

test("placeCall：成功向被叫 Agent 推送来电（含 TTS）", async () => {
  const { service, connect } = makeService();
  const fromPhone = service.ensureNumber("actor-caller");
  const toPhone = service.ensureNumber("actor-target");
  const sock = connect("actor-target");

  const result = await service.placeCall({
    fromActorId: "actor-caller",
    toPhone,
    transcript: "我是主叫 Agent",
    ringStyle: "peer",
    initiatedBy: "user",
  });

  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  assert.equal(result.fromPhone, fromPhone);

  const incoming = eventsOf(sock, "agent.phone.incoming");
  assert.equal(incoming.length, 1);
  const payload = incoming[0].payload as Record<string, unknown>;
  assert.equal(payload.callId, result.callId);
  assert.equal(payload.direction, "agent_to_agent");
  assert.equal(payload.transcript, "我是主叫 Agent");
  const tts = payload.tts as Record<string, unknown>;
  assert.equal(tts.format, "mp3");
});

test("placeCall：要求配对且未配对时拒绝", async () => {
  const { service } = makeService({ paired: false });
  service.ensureNumber("actor-caller");
  const toPhone = service.ensureNumber("actor-target");
  const prev = process.env.AGENT_RELAY_REQUIRE_PAIR;
  process.env.AGENT_RELAY_REQUIRE_PAIR = "1";
  try {
    const result = await service.placeCall({
      fromActorId: "actor-caller",
      toPhone,
      transcript: "你好",
      ringStyle: "peer",
      initiatedBy: "user",
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /配对/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_RELAY_REQUIRE_PAIR;
    else process.env.AGENT_RELAY_REQUIRE_PAIR = prev;
  }
});

// ============================================================
// callUser / callUserWithRinging（Agent → 用户）
// ============================================================

test("callUser 推送 incoming 且 replyEnabled，回复路由进 userReplyHandler", async () => {
  const { service, connect } = makeService();
  service.ensureNumber("actor-agent");
  const sock = connect("user-1");

  const replies: Array<{ callId: string; fromActorId: string; toUserId: string; text: string }> = [];
  service.setUserReplyHandler(async (params) => {
    replies.push(params);
  });

  const result = await service.callUser({
    fromActorId: "actor-agent",
    toUserId: "user-1",
    transcript: "提醒您喝水",
    ringStyle: "peer",
  });

  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  const callId = result.callId!;

  const incoming = eventsOf(sock, "agent.phone.incoming");
  assert.equal(incoming.length, 1);
  const payload = incoming[0].payload as Record<string, unknown>;
  assert.equal(payload.direction, "agent_to_user");
  assert.equal(payload.replyEnabled, true);
  assert.equal(payload.callId, callId);

  // 用户回复 → 路由进 Agent 对话管线处理器
  const delivered = service.deliverCallReply(callId, "知道了谢谢", "user-1");
  assert.equal(delivered.ok, true);
  assert.equal(delivered.handled, "chat");
  await until(() => replies.length > 0, 1000, "reply handler");
  assert.equal(replies[0].callId, callId);
  assert.equal(replies[0].fromActorId, "actor-agent");
  assert.equal(replies[0].toUserId, "user-1");
  assert.equal(replies[0].text, "知道了谢谢");
});

test("callUserWithRinging 两阶段推送（ringing_start → call_connecting）", async () => {
  const { service, connect } = makeService();
  service.ensureNumber("actor-agent");
  const sock = connect("user-1");

  const result = await service.callUserWithRinging({
    fromActorId: "actor-agent",
    toUserId: "user-1",
    transcript: "会议十分钟后开始",
    ringStyle: "reminder",
    ringPhase: { enableRingingPhase: true, ringDurationMs: 20 },
  });

  assert.equal(result.ok, true);
  const ringing = eventsOf(sock, "agent.phone.ringing_start");
  assert.equal(ringing.length, 1);
  assert.equal((ringing[0].payload as Record<string, unknown>).status, "ringing");

  const connecting = eventsOf(sock, "agent.phone.call_connecting");
  assert.equal(connecting.length, 1);
  const payload = connecting[0].payload as Record<string, unknown>;
  assert.equal(payload.status, "connected");
  assert.equal(payload.transcript, "会议十分钟后开始");
  assert.equal(payload.replyEnabled, true);

  // 接通后回复可路由（replyEnabled 的消费路径）
  const replies: Array<{ text: string }> = [];
  service.setUserReplyHandler(async (p) => {
    replies.push(p);
  });
  const delivered = service.deliverCallReply(result.callId!, "收到", "user-1");
  assert.equal(delivered.ok, true);
  await until(() => replies.length > 0, 1000, "reply handler");
  assert.equal(replies[0].text, "收到");
});

// ============================================================
// handleUserCallAgent（用户 → Agent）接通闭环
// ============================================================

test("用户呼叫 Agent：connecting → connected（Agent 回应 + TTS）", async () => {
  const { service, connect } = makeService();
  service.ensureNumber("actor-agent");
  const sock = connect("user-1");

  service.setUserCallAgentHandler(async ({ userMessage }) => {
    assert.equal(userMessage, "帮我看看今天日程");
    return { replyText: "您好，今天下午三点有个会议。" };
  });

  const result = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-agent",
    userMessage: "帮我看看今天日程",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(result.ok, true);

  await until(
    () => eventsOf(sock, "agent.phone.call_status").some((e) => (e.payload as Record<string, unknown>).status === "connected"),
    2000,
    "connected status",
  );

  const statuses = eventsOf(sock, "agent.phone.call_status").map((e) => e.payload as Record<string, unknown>);
  assert.ok(statuses.some((p) => p.status === "connecting"));
  const connected = statuses.find((p) => p.status === "connected")!;
  assert.equal(connected.direction, "user_to_agent");
  assert.equal(connected.transcript, "您好，今天下午三点有个会议。");
  const tts = connected.tts as Record<string, unknown>;
  assert.equal(tts.format, "mp3");
});

test("用户呼叫 Agent：Agent 处理器抛错时按兜底话术接通", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  service.setUserCallAgentHandler(async () => {
    throw new Error("llm down");
  });

  const result = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-x",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(result.ok, true);

  await until(
    () => eventsOf(sock, "agent.phone.call_status").some((e) => (e.payload as Record<string, unknown>).status === "connected"),
    2000,
    "connected status",
  );
  const connected = eventsOf(sock, "agent.phone.call_status")
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p.status === "connected")!;
  assert.match(String(connected.transcript), /接通/);
});

test("用户呼叫 Agent：Agent 回应超时按兜底话术接通", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  service.setUserCallAgentHandler(() => new Promise(() => {})); // 永不返回

  const result = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-x",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(result.ok, true);

  await until(
    () => eventsOf(sock, "agent.phone.call_status").some((e) => (e.payload as Record<string, unknown>).status === "connected"),
    3000,
    "connected status (timeout fallback)",
  );
  const connected = eventsOf(sock, "agent.phone.call_status")
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p.status === "connected")!;
  assert.match(String(connected.transcript), /接通/);
});

// ============================================================
// 通话回复总线 / endCall
// ============================================================

test("waitForCallReply 被 deliverCallReply 唤醒", async () => {
  const { service } = makeService();
  const waitPromise = service.waitForCallReply("call-wait-1", 2000);
  const delivered = service.deliverCallReply("call-wait-1", "收到");
  assert.equal(delivered.ok, true);
  assert.equal(delivered.handled, "reminder_dialogue");
  const input = await waitPromise;
  assert.deepEqual(input, { text: "收到" });
});

test("waitForCallReply 超时返回 null", async () => {
  const { service } = makeService();
  const input = await service.waitForCallReply("call-wait-2", 30);
  assert.equal(input, null);
});

test("deliverCallReply：未知通话报错", () => {
  const { service } = makeService();
  const result = service.deliverCallReply("no-such-call", "hello");
  assert.equal(result.ok, false);
  assert.match(result.error!, /不存在/);
});

test("deliverCallReply：非通话归属方被拒绝", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  const result = await service.callUser({
    fromActorId: "actor-agent",
    toUserId: "user-1",
    transcript: "hi",
    ringStyle: "peer",
  });
  assert.equal(result.ok, true);
  const delivered = service.deliverCallReply(result.callId!, "hi", "user-2");
  assert.equal(delivered.ok, false);
  assert.match(delivered.error!, /不属于/);
  assert.equal(sock.sent.length, 1); // 未产生额外推送
});

test("cancelCallReplyWaiters 使等待方以 null 收尾", async () => {
  const { service } = makeService();
  const waitPromise = service.waitForCallReply("call-wait-3", 5000);
  service.cancelCallReplyWaiters("call-wait-3");
  assert.equal(await waitPromise, null);
});

test("endCall 推送 ended 并清理：后续回复与二次挂断报错", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  const result = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-x",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(result.ok, true);
  const callId = result.callId!;

  const ended = service.endCall(callId, "user_hangup");
  assert.equal(ended.ok, true);

  await until(
    () => eventsOf(sock, "agent.phone.call_status").some((e) => (e.payload as Record<string, unknown>).status === "ended"),
    1000,
    "ended status",
  );
  const endedPayload = eventsOf(sock, "agent.phone.call_status")
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p.status === "ended")!;
  assert.equal(endedPayload.reason, "user_hangup");

  assert.equal(service.endCall(callId).ok, false);
  assert.equal(service.deliverCallReply(callId, "hello").ok, false);
});

test("pushVoiceReply 推送 voice_reply 事件（含 TTS）", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  const result = await service.pushVoiceReply("call-vr-1", "user-1", "这是语音回应");
  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);

  const vr = eventsOf(sock, "agent.phone.voice_reply");
  assert.equal(vr.length, 1);
  const payload = vr[0].payload as Record<string, unknown>;
  assert.equal(payload.callId, "call-vr-1");
  assert.equal(payload.transcript, "这是语音回应");
  assert.equal((payload.tts as Record<string, unknown>).format, "mp3");
});
