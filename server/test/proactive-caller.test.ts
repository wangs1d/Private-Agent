// ProactiveCaller 单测：真实来电汇报 + 通话内多轮对话 + 结果回灌 + 策略闸门。
// mock VirtualPhoneService（同接口）+ mock turnLlm（零外网零真实 LLM）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProactiveCaller, type CallOutcome } from "../src/proactivity/proactive-caller.js";
import type { VirtualPhoneService } from "../src/services/virtual-phone-service.js";

type CallScript = Array<"silent" | { user: string }>;

function mockPhone(script: CallScript, opts: { pushOk?: boolean } = {}) {
  const state = {
    calls: [] as string[],
    voiceReplies: [] as string[],
    ended: [] as string[],
    callId: "call-1",
    pushed: opts.pushOk !== false,
  };
  const service = {
    async callUserWithRinging(params: { transcript: string }) {
      state.calls.push(params.transcript);
      if (!state.pushed) return { ok: true, callId: state.callId, pushed: false };
      return { ok: true, callId: state.callId, pushed: true };
    },
    async waitForCallReply(_callId: string, _timeoutMs: number) {
      const next = script.shift();
      if (next === undefined || next === "silent") return null;
      return { text: typeof next === "string" ? next : next.user };
    },
    async pushVoiceReply(_callId: string, _toUserId: string, transcript: string) {
      state.voiceReplies.push(transcript);
      return { ok: true, pushed: true };
    },
    endCall(callId: string, reason: string) {
      state.ended.push(`${callId}:${reason}`);
      return { ok: true };
    },
  } as unknown as VirtualPhoneService & typeof state;
  return Object.assign(service, state);
}

function mockLlm(replies: string[]) {
  let i = 0;
  const fn = async () => replies[Math.min(i++, replies.length - 1)];
  return Object.assign(fn, { calls: () => i });
}

function makeCaller(phone: VirtualPhoneService, turnLlm: unknown, opts: { env?: Record<string, string> } = {}) {
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const outcomes: Array<{ kind: string; outcome: CallOutcome; transcript: Array<{ role: string; content: string }> }> = [];
  const fallbacks: string[] = [];
  const caller = new ProactiveCaller({
    virtualPhone: phone,
    turnLlm: turnLlm as never,
    dataPath: mkdtempSync(join(tmpdir(), "caller-")),
    fallbackTextDelivery: (_actorId, _title, text) => fallbacks.push(text),
    onOutcome: (input) =>
      outcomes.push({ kind: input.kind, outcome: input.outcome, transcript: input.transcript }),
  });
  for (const k of Object.keys(opts.env ?? {})) delete process.env[k];
  return { caller, outcomes, fallbacks };
}

test("呼叫闭环: 振铃→接通播报→两轮对话→结束→outcome=replied", async () => {
  process.env.PROACTIVE_CALL_ENABLED = "1";
  const phone = mockPhone([{ user: "什么事？" }, { user: "好的我知道了，再见" }]);
  const llm = mockLlm(["李雷把周会推迟到周四了，要我跟 calendar 改一下吗？", "好的，那先这样。"]);
  const { caller, outcomes } = makeCaller(phone, llm, { env: { PROACTIVE_CALL_ENABLED: "1" } });
  const result = await caller.callAndReport({
    actorId: "u1",
    kind: "schedule_change",
    importance: "high",
    title: "行程变化",
    report: "你关注的事有变化：李雷那边说周会推迟。",
    context: "来自消息监控",
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "replied");
  assert.equal(phone.calls.length, 1, "真实发起了一通电话");
  assert.equal(phone.voiceReplies.length, 2, "每轮用户发言都有 TTS 回应");
  assert.equal(phone.ended.length, 1, "通话被服务端正常结束");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "replied");
  assert.ok(outcomes[0].transcript.length >= 4, "通话记录含双方发言");
  assert.equal(llm.calls(), 1, "结束语走 END 短路，只耗一次 LLM");
});

test("呼叫闸门: 冷却期内第二次呼叫被拦 + 文本兜底", async () => {
  const phone = mockPhone([{ user: "嗯，知道了，再见" }]);
  const { caller, fallbacks } = makeCaller(phone, mockLlm(["好的。"]));
  const r1 = await caller.callAndReport({ actorId: "u1", kind: "schedule_change", importance: "high", title: "t1", report: "r1" });
  assert.equal(r1.outcome, "replied");
  // 同 kind 冷却 30min：模拟立即第二次
  const r2 = await caller.callAndReport({ actorId: "u1", kind: "schedule_change", importance: "high", title: "t2", report: "r2" });
  assert.equal(r2.ok, false);
  assert.equal(r2.outcome, "cooldown");
  assert.equal(phone.calls.length, 1, "冷却期内不再拨打");
  assert.equal(fallbacks.length, 1, "被拦事件文本兜底（信息必达）");
});

test("呼叫降级: 振铃后无人应答 → no_response + 文本补达（不空响）", async () => {
  const phone = mockPhone(["silent"]);
  const { caller, outcomes, fallbacks } = makeCaller(phone, mockLlm(["x"]));
  const result = await caller.callAndReport({ actorId: "u1", kind: "commitment_chain", importance: "high", title: "t", report: "r" });
  assert.equal(result.outcome, "no_response");
  assert.equal(fallbacks.length, 1, "无应答自动文本补达");
  assert.equal(outcomes[0].outcome, "no_response");
});

test("呼叫降级: 设备全离线（推送失败）→ 不拨打直接文本", async () => {
  const phone = mockPhone([], { pushOk: false });
  const { caller, outcomes, fallbacks } = makeCaller(phone, mockLlm(["x"]));
  const result = await caller.callAndReport({ actorId: "u1", kind: "meeting_soon", importance: "high", title: "t", report: "r" });
  assert.equal(result.outcome, "no_device");
  assert.equal(fallbacks.length, 1);
  assert.equal(outcomes[0].outcome, "no_device");
});

test("呼叫闸门: kill switch 全关（零拨打零 LLM）", async () => {
  const phone = mockPhone([{ user: "喂" }]);
  const llm = mockLlm(["x"]);
  const { caller, fallbacks } = makeCaller(phone, llm);
  process.env.PROACTIVE_CALL_ENABLED = "0";
  const result = await caller.callAndReport({ actorId: "u1", kind: "schedule_change", importance: "critical", title: "t", report: "r" });
  delete process.env.PROACTIVE_CALL_ENABLED;
  assert.equal(result.outcome, "disabled");
  assert.equal(phone.calls.length, 0);
  assert.equal(llm.calls(), 0);
  assert.equal(fallbacks.length, 1);
});
