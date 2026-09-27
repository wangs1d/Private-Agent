import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientPushPort } from "../src/ports/client-push-port.js";
import { ProactiveCaller } from "../src/proactivity/proactive-caller.js";
import type { TtsService } from "../src/services/tts-service.js";
import { VirtualPhoneService } from "../src/services/virtual-phone-service.js";

/** 收集推送给用户的 WS 帧（供断言），trySend 永远成功。 */
function makeRegistry(): { port: ClientPushPort; frames: Array<{ to: string; body: Record<string, unknown> }> } {
  const frames: Array<{ to: string; body: Record<string, unknown> }> = [];
  const port: ClientPushPort = {
    trySend: (to: string, data: string) => {
      frames.push({ to, body: JSON.parse(data) as Record<string, unknown> });
      return true;
    },
    isOnline: () => true,
  };
  return { port, frames };
}

const ttsStub = {
  synthesizeMp3Base64: async () => ({ ok: false as const, reason: "tts_disabled_for_test" }),
} as unknown as TtsService;

function makePhone(): { phone: VirtualPhoneService; frames: Array<{ to: string; body: Record<string, unknown> }> } {
  const { port, frames } = makeRegistry();
  return { phone: new VirtualPhoneService(ttsStub, port), frames };
}

test("电话实时语音：开关与上下文人设（来电汇报 / 用户来电 / 未知通话）", async () => {
  const { phone } = makePhone();
  assert.equal(phone.isRealtimeVoice(), false);
  phone.setRealtimeVoiceEnabled(true);
  assert.equal(phone.isRealtimeVoice(), true);

  // 未知通话 → null（duplex 用默认人设）
  assert.equal(phone.getCallVoiceContext("no-such-call"), null);

  // agent_to_user：带汇报稿
  await phone.callUser({
    fromActorId: "actor-1",
    toUserId: "user-1",
    transcript: "明天上午十点有产品评审会",
    ringStyle: "reminder",
    ringPhase: { enableRingingPhase: false },
  });
  const callId = lastIncomingCallId(phone);
  assert.ok(callId, "应有活跃通话");
  const agentCtx = phone.getCallVoiceContext(callId);
  assert.ok(agentCtx?.includes("你主动打给用户"));
  assert.ok(agentCtx?.includes("明天上午十点有产品评审会"));
  assert.ok(agentCtx?.includes("实时语音通话"));

  // user_to_agent：带留言
  phone.endCall(callId, "test_end");
  phone.ensureNumber("user-2");
  const dial = await phone.handleUserCallAgent({
    fromUserId: "user-2",
    toActorId: "actor-2",
    userMessage: "帮我查一下快递",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(dial.ok, true);
  const userCtx = phone.getCallVoiceContext(dial.callId ?? "");
  assert.ok(userCtx?.includes("用户主动来电"));
  assert.ok(userCtx?.includes("帮我查一下快递"));
  phone.endCall(dial.callId ?? "", "test_end");
});

/** 从服务内部取最近一个活跃通话 callId（测试辅助，走 busy 探测接口语义）。 */
function lastIncomingCallId(phone: VirtualPhoneService): string | null {
  const probe = phone as unknown as { callSessions: Map<string, { callId: string }> };
  const first = probe.callSessions.keys().next();
  return first.done ? null : first.value;
}

test("电话实时语音：waitForCallEnd 挂断即唤醒 / 未知通话立即 true / 超时 false", async () => {
  const { phone } = makePhone();
  await phone.callUser({
    fromActorId: "actor-1",
    toUserId: "user-1",
    transcript: "测试",
    ringStyle: "reminder",
    ringPhase: { enableRingingPhase: false },
  });
  const callId = lastIncomingCallId(phone);
  assert.ok(callId);

  const waiting = phone.waitForCallEnd(callId, 5000);
  phone.endCall(callId, "user_hangup");
  assert.equal(await waiting, true);

  assert.equal(await phone.waitForCallEnd("no-such-call", 1000), true);

  await phone.callUser({
    fromActorId: "actor-1",
    toUserId: "user-1",
    transcript: "测试2",
    ringStyle: "reminder",
    ringPhase: { enableRingingPhase: false },
  });
  const callId2 = lastIncomingCallId(phone);
  assert.ok(callId2);
  const t0 = Date.now();
  assert.equal(await phone.waitForCallEnd(callId2, 120), false);
  assert.ok(Date.now() - t0 >= 100);
  phone.endCall(callId2, "test_end");
});

test("电话实时语音：user_to_agent 接通走 realtime 分支（不调 LLM、无开场 TTS）", async () => {
  const { phone, frames } = makePhone();
  phone.setRealtimeVoiceEnabled(true);
  let handlerCalled = 0;
  phone.setUserCallAgentHandler(async () => {
    handlerCalled += 1;
    return { replyText: "不该被调用的开场白" };
  });
  phone.ensureNumber("user-rt");
  const dial = await phone.handleUserCallAgent({
    fromUserId: "user-rt",
    toActorId: "actor-rt",
    userMessage: "",
    ringPhase: { enableRingingPhase: false },
  });
  assert.equal(dial.ok, true);
  // completeUserCallAgent 是异步续体，等它跑完
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(handlerCalled, 0); // realtime 模式不调首问 LLM
  const connected = frames
    .map((f) => f.body)
    .filter((b) => (b.payload as Record<string, unknown> | undefined)?.status === "connected");
  assert.ok(connected.length >= 1);
  const payload = connected[connected.length - 1].payload as Record<string, unknown>;
  assert.equal(payload.realtimeVoice, true);
  assert.equal(payload.tts, undefined); // 无开场 TTS，用户先开口
  phone.endCall(dial.callId ?? "", "test_end");
});

test("提醒电话：realtime 模式下对话循环让位（LLM 零调用），挂断即收尾回灌 replied", async () => {
  const { phone, frames } = makePhone();
  phone.setRealtimeVoiceEnabled(true);
  const dataPath = mkdtempSync(join(tmpdir(), "vp-realtime-test-"));
  let llmCalls = 0;
  const caller = new ProactiveCaller({
    virtualPhone: phone,
    turnLlm: async () => {
      llmCalls += 1;
      return "不该被调用";
    },
    dataPath,
  });
  const placing = caller.callAndReport({
    actorId: "user-1",
    kind: "schedule_change",
    // critical：绕开静默时段门，测试不受运行时刻影响
    importance: "critical",
    title: "日程变更",
    report: "明早八点的会改到九点",
  });
  // 呼叫带 6s 振铃前摇：等前摇结束（connecting 帧，此刻会话已登记）再挂断
  let connecting: Record<string, unknown> | undefined;
  const t0 = Date.now();
  while (!connecting && Date.now() - t0 < 10000) {
    connecting = frames
      .map((f) => f.body)
      .find((b) => (b.payload as Record<string, unknown> | undefined)?.status === "connected");
    if (!connecting) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(connecting, "应推送接通帧");
  const callId = (connecting.payload as Record<string, unknown>).callId as string;
  phone.endCall(callId, "user_hangup");
  const result = await placing;
  assert.equal(result.outcome, "replied");
  assert.equal(llmCalls, 0); // 对话由 realtime 引擎接管，旧循环零调用
  void dataPath;
});
