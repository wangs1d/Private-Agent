import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// 隔离持久化路径（persistPath 每次访问实时读取环境变量）
process.env.VIRTUAL_PHONES_FILE = join(await mkdtemp(join(tmpdir(), "vp-handler-test-")), "virtual-phones.json");

import { VirtualPhoneService } from "../src/services/virtual-phone-service.js";
import { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";
import { PhoneCallHandler } from "../src/services/intelligent-reminder/phone-call-handler.js";
import type { ReminderInstance } from "../src/services/intelligent-reminder/types.js";

type SentEvent = { type: string; payload: Record<string, unknown> };

class FakeSocket {
  sent: SentEvent[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentEvent);
  }
}

async function until(fn: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeFixture(opts?: { chatShouldFail?: boolean; omitActorId?: boolean }) {
  const registry = new WsConnectionRegistry();
  const sock = new FakeSocket();
  registry.register("user-1", sock);

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
    { arePaired: () => true } as never,
  );

  let chatCalls = 0;
  const voice = {
    chatCompletion: async () => {
      chatCalls += 1;
      if (opts?.chatShouldFail) throw new Error("llm unavailable");
      return "好的，我再帮您留意。";
    },
    generateAndSpeak: async () => Buffer.alloc(0),
  };

  const notifications: SentEvent[] = [];
  const handler = new PhoneCallHandler({
    virtualPhoneService: service,
    voiceDialogueService: voice as never,
    sendToClient: async (_userId, payload) => {
      notifications.push(payload as SentEvent);
    },
    logger: { info: () => {}, error: () => {} },
  });

  const instance: ReminderInstance = {
    config: {
      id: randomUUID(),
      title: "开会提醒",
      message: "记得下午三点开会",
      priority: "high",
      initialLevel: "phone_call",
      scheduledAt: new Date(),
      metadata: {
        userId: "user-1",
        ...(opts?.omitActorId ? {} : { actorId: "actor-1" }),
      },
    },
    currentLevel: "phone_call",
    status: "active",
    createdAt: new Date(),
    escalationCount: 0,
    phoneConfig: { ringDurationMs: 10, maxRingDurationSec: 5 },
  };

  return { handler, service, sock, notifications, instance, getChatCalls: () => chatCalls };
}

function eventsOf(sock: FakeSocket, type: string): SentEvent[] {
  return sock.sent.filter((e) => e.type === type);
}

async function startReminderCall(
  fixture: ReturnType<typeof makeFixture>,
): Promise<{ promise: Promise<void>; callId: string }> {
  const promise = fixture.handler.handle(fixture.instance);
  await until(
    () => eventsOf(fixture.sock, "agent.phone.call_connecting").length > 0,
    2000,
    "call_connecting",
  );
  const callId = (eventsOf(fixture.sock, "agent.phone.call_connecting")[0].payload as Record<string, unknown>)
    .callId as string;
  return { promise, callId };
}

test("提醒电话：用户回复确认词 → 播告别语 + reminder_call_completed", async () => {
  const fixture = makeFixture();
  const { promise, callId } = await startReminderCall(fixture);
  assert.equal(fixture.handler.getActiveCallCount(), 1);

  const delivered = fixture.service.deliverCallReply(callId, "收到");
  assert.equal(delivered.ok, true);
  assert.equal(delivered.handled, "reminder_dialogue");

  await promise;

  assert.ok(
    fixture.notifications.some((n) => n.type === "reminder_call_completed"),
    "应发送 reminder_call_completed",
  );
  const voiceReplies = eventsOf(fixture.sock, "agent.phone.voice_reply").map(
    (e) => e.payload as Record<string, unknown>,
  );
  assert.ok(
    voiceReplies.some((p) => String(p.transcript).includes("再见")),
    "应推送告别语音",
  );
  assert.equal(fixture.handler.getActiveCallCount(), 0);
});

test("提醒电话：非确认词回复走 LLM 对话并语音回应", async () => {
  const fixture = makeFixture();
  const { promise, callId } = await startReminderCall(fixture);

  const delivered = fixture.service.deliverCallReply(callId, "等等，几点开会？");
  assert.equal(delivered.ok, true);

  await until(
    () =>
      eventsOf(fixture.sock, "agent.phone.voice_reply").some((e) =>
        String((e.payload as Record<string, unknown>).transcript).includes("好的，我再帮您留意。"),
      ),
    2000,
    "llm voice reply",
  );
  assert.equal(fixture.getChatCalls(), 1, "LLM 对话应被调用一次");

  // 确认后正常结束
  assert.equal(fixture.service.deliverCallReply(callId, "退下").ok, true);
  await promise;
  assert.ok(fixture.notifications.some((n) => n.type === "reminder_call_completed"));
});

test("提醒电话：LLM 失败时语音推送兜底话术", async () => {
  const fixture = makeFixture({ chatShouldFail: true });
  const { promise, callId } = await startReminderCall(fixture);

  assert.equal(fixture.service.deliverCallReply(callId, "今天天气怎么样").ok, true);

  await until(
    () =>
      eventsOf(fixture.sock, "agent.phone.voice_reply").some((e) =>
        String((e.payload as Record<string, unknown>).transcript).includes("请回复\"退下\""),
      ),
    2000,
    "fallback voice reply",
  );

  assert.equal(fixture.service.deliverCallReply(callId, "收到").ok, true);
  await promise;
});

test("提醒电话：无用户输入时按 maxRingDurationSec 超时退出，不算完成", async () => {
  const fixture = makeFixture();
  fixture.instance.phoneConfig = { ringDurationMs: 10, maxRingDurationSec: 0.3 };

  const promise = fixture.handler.handle(fixture.instance);
  await until(
    () => eventsOf(fixture.sock, "agent.phone.call_connecting").length > 0,
    2000,
    "call_connecting",
  );

  await promise;

  assert.ok(
    !fixture.notifications.some((n) => n.type === "reminder_call_completed"),
    "超时不应发 reminder_call_completed",
  );
  assert.equal(fixture.handler.getActiveCallCount(), 0);
});

test("提醒电话：metadata 缺 actorId → reminder_call_failed", async () => {
  const fixture = makeFixture({ omitActorId: true });
  await fixture.handler.handle(fixture.instance);

  assert.ok(fixture.notifications.some((n) => n.type === "incoming_reminder_call"));
  assert.ok(fixture.notifications.some((n) => n.type === "reminder_call_failed"));
});

test("提醒电话：forceEndCall 挂断等待中的交互且不算完成", async () => {
  const fixture = makeFixture();
  const { promise } = await startReminderCall(fixture);

  assert.equal(fixture.handler.forceEndCall(fixture.instance.config.id), true);
  await promise;

  assert.ok(!fixture.notifications.some((n) => n.type === "reminder_call_completed"));
});
