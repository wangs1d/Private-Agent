import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

// ---- 环境准备（须在动态 import 服务模块前完成：超时常量为模块加载期 IIFE 读取）----
process.env.VIRTUAL_PHONE_USER_CALL_AGENT_TIMEOUT_MS = "400";
const tmpDir = await mkdtemp(join(tmpdir(), "vp-service-test-"));
process.env.VIRTUAL_PHONES_FILE = join(tmpDir, "virtual-phones.json");
process.env.VIRTUAL_PHONE_CALLS_FILE = join(tmpDir, "virtual-phone-calls.json");
process.env.VIRTUAL_PHONE_HISTORY_DIR = join(tmpDir, "virtual-phone-history");

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

function makeService() {
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
  const service = new VirtualPhoneService(
    tts as never,
    registry,
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
  service.ensureNumber("user-1"); // 门禁：主叫用户须已申领站内号码
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
  service.ensureNumber("user-1");
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
  service.ensureNumber("user-1");
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

test("门禁：未申领号码的用户发起呼叫被拒绝", async () => {
  const { service } = makeService();
  service.ensureNumber("actor-agent");
  const result = await service.handleUserCallAgent({
    fromUserId: "user-no-number",
    toActorId: "actor-agent",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /申领/);
});

test("releaseNumber：释放后可重新申领、重复释放报错", () => {
  const { service } = makeService();
  service.ensureNumber("user-1");
  assert.equal(service.releaseNumber("user-1").ok, true);
  assert.equal(service.getPhoneForActor("user-1"), undefined);
  const again = service.releaseNumber("user-1");
  assert.equal(again.ok, false);
  assert.match(again.error!, /尚未申领/);
  // 释放后可再次申领到新号
  assert.match(service.ensureNumber("user-1"), /^\d{6}$/);
});

test("忙线护栏：同用户第二通 Agent 来电被拒且不覆盖第一通", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-1");
  const first = await service.callUser({
    fromActorId: "actor-a",
    toUserId: "user-1",
    transcript: "第一通",
    ringStyle: "peer",
  });
  assert.equal(first.ok, true);
  const second = await service.callUser({
    fromActorId: "actor-b",
    toUserId: "user-1",
    transcript: "第二通",
    ringStyle: "peer",
  });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  // 用户只收到一条真来电 + 一条 busy 状态，不存在第二条 incoming
  assert.equal(eventsOf(sock, "agent.phone.incoming").length, 1);
  assert.ok(
    eventsOf(sock, "agent.phone.call_status").some(
      (e) => (e.payload as Record<string, unknown>).status === "busy",
    ),
  );
});

test("忙线护栏：用户通话中再次发起呼叫被拒", async () => {
  const { service } = makeService();
  service.ensureNumber("user-1");
  const first = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-a",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(first.ok, true);
  const second = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-b",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  service.endCall(first.callId!, "user_hangup");
  const third = await service.handleUserCallAgent({
    fromUserId: "user-1",
    toActorId: "actor-b",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(third.ok, true); // 挂断后可再次发起
});

test("重启恢复：遗留会话补推 ended(server_restart) 并清理落盘", async () => {
  const { service, connect } = makeService();
  const sock = connect("user-9");
  // 独立会话文件路径：避开全局写队列中早前测试排队持久化的竞态覆盖
  const recoverFile = join(tmpDir, `calls-recover-${Date.now()}.json`);
  const prev = process.env.VIRTUAL_PHONE_CALLS_FILE;
  process.env.VIRTUAL_PHONE_CALLS_FILE = recoverFile;
  try {
    await writeFile(
      recoverFile,
      JSON.stringify({
        sessions: [
          {
            callId: "stale-1",
            fromActorId: "actor-a",
            toUserId: "user-9",
            direction: "agent_to_user",
            createdAt: Date.now() - 1000,
          },
        ],
      }),
      "utf8",
    );
    await service.load();
    const ended = eventsOf(sock, "agent.phone.call_status").find(
      (e) => (e.payload as Record<string, unknown>).status === "ended",
    );
    assert.ok(ended, "应收到 ended");
    assert.equal((ended!.payload as Record<string, unknown>).reason, "server_restart");
    assert.equal(existsSync(recoverFile), false, "会话文件应被清空");
  } finally {
    process.env.VIRTUAL_PHONE_CALLS_FILE = prev;
  }
});

test("通话记录落盘：endCall 后写入 history 目录（含语音稿与结束原因）", async () => {
  const { service, connect } = makeService();
  connect("user-h");
  const r = await service.callUser({
    fromActorId: "actor-a",
    toUserId: "user-h",
    transcript: "记录测试",
    ringStyle: "peer",
  });
  service.endCall(r.callId!, "user_hangup");
  await new Promise((r) => setTimeout(r, 80));
  const files = await readdir(process.env.VIRTUAL_PHONE_HISTORY_DIR!);
  const target = files.find((f) => f.includes(r.callId!));
  assert.ok(target, "应存在该通话的记录文件");
  const raw = JSON.parse(
    await readFile(join(process.env.VIRTUAL_PHONE_HISTORY_DIR!, target!), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(raw.endReason, "user_hangup");
  assert.equal(raw.initialTranscript, "记录测试");
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
  service.ensureNumber("user-1");
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
