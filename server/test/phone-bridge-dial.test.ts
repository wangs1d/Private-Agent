/**
 * phone.dial（真机桥接拨号）回归。
 *
 * 覆盖：号码归一化 / 紧急号码拒绝 / 同轮去重 / 桥接离线门控 /
 * 参数透传（mode/contactName/reason）/ 失败不进去重缓存 /
 * LLM schema 注册与 phone.dial 门控名单。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import {
  normalizeDialNumber,
  registerPhoneBridgeTools,
} from "../src/tools/phone-bridge-tools.js";
import { PHONE_BRIDGE_CHAT_TOOL_DEFINITIONS } from "../src/tools/phone-bridge-chat-tools.js";

type InvokeCall = { actorId: string; action: string; params: Record<string, unknown> };

function makeRegistry(invokeImpl?: (call: InvokeCall) => Record<string, unknown>) {
  const calls: InvokeCall[] = [];
  const bridge = {
    invoke: async (actorId: string, action: string, params: Record<string, unknown>) => {
      const call = { actorId, action, params };
      calls.push(call);
      return invokeImpl ? invokeImpl(call) : { ok: true, state: "dialing" };
    },
  };
  const registry = new ToolRegistry();
  registerPhoneBridgeTools(registry, { bridge: bridge as never });
  return { registry, calls };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "session-dial-test",
    userId: "user-dial-test",
    chatUserMessageId: "msg-round-1",
    phoneBridgeOnline: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeDialNumber
// ---------------------------------------------------------------------------

test("normalizeDialNumber: 常规号码保留数字与 + 前缀", () => {
  assert.equal(normalizeDialNumber("+86 138 0013 8000"), "+8613800138000");
  assert.equal(normalizeDialNumber("10086"), "10086");
  assert.equal(normalizeDialNumber("010-12345678"), "01012345678");
  assert.equal(normalizeDialNumber("  95588 "), "95588");
});

test("normalizeDialNumber: 紧急号码与不合法输入一律拒绝", () => {
  for (const n of ["110", "119", "120", "122", "112", "999", "911", "000", "+110"]) {
    assert.equal(normalizeDialNumber(n), null, `应拒绝紧急号码 ${n}`);
  }
  assert.equal(normalizeDialNumber(""), null);
  assert.equal(normalizeDialNumber("abcd"), null);
  assert.equal(normalizeDialNumber("123"), null); // 过短
  assert.equal(normalizeDialNumber("1".repeat(21)), null); // 过长
});

// ---------------------------------------------------------------------------
// phone.dial 工具行为
// ---------------------------------------------------------------------------

test("phone.dial: 桥接离线直接拒绝，不触达 bridge", async () => {
  const { registry, calls } = makeRegistry();
  const r = await registry.execute(
    "phone.dial",
    { number: "13800138000" },
    makeCtx({ phoneBridgeOnline: false }),
  );
  assert.equal(r.ok, true); // execute 外层成功，业务失败在 result 里
  assert.equal(r.result.ok, false);
  assert.match(String(r.result.error), /phone bridge is not online/);
  assert.equal(calls.length, 0);
});

test("phone.dial: 正常拨打透传 mode/contactName/reason，默认 direct", async () => {
  const { registry, calls } = makeRegistry();
  const r = await registry.execute(
    "phone.dial",
    { number: "+86 138 0013 8000", contactName: "张三", reason: "用户要求", mode: "weird" },
    makeCtx(),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, "user-dial-test");
  assert.equal(calls[0].action, "dial");
  assert.equal(calls[0].params.number, "+8613800138000");
  assert.equal(calls[0].params.mode, "direct"); // 非法 mode 归一为 direct
  assert.equal(calls[0].params.contactName, "张三");
  assert.equal(calls[0].params.reason, "用户要求");
});

test("phone.dial: 同轮同号码去重，跨轮放行", async () => {
  const { registry, calls } = makeRegistry();
  const input = { number: "13800138000" };

  const first = await registry.execute("phone.dial", input, makeCtx());
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);

  const dup = await registry.execute("phone.dial", input, makeCtx());
  assert.equal(dup.ok, true);
  assert.equal(dup.result.deduped, true);
  assert.equal(calls.length, 1, "同轮重复调用不应再次触达 bridge");

  // draft 模式视为不同调用意图？——否：去重键只看号码，同轮仍拦截
  const dupDraft = await registry.execute(
    "phone.dial",
    { ...input, mode: "draft" },
    makeCtx(),
  );
  assert.equal(dupDraft.result.deduped, true);
  assert.equal(calls.length, 1);

  // 跨轮（不同 chatUserMessageId）重新放行
  const nextRound = await registry.execute(
    "phone.dial",
    input,
    makeCtx({ chatUserMessageId: "msg-round-2" }),
  );
  assert.equal(nextRound.ok, true);
  assert.equal(nextRound.result.deduped, undefined);
  assert.equal(calls.length, 2);
});

test("phone.dial: 失败不进去重缓存，同轮可重试", async () => {
  // 去重缓存是模块级、跨用例共享的：这里用独立的 actor/round/number 隔离
  let fail = true;
  const { registry, calls } = makeRegistry(() =>
    fail ? { ok: false, error: "cancelled" } : { ok: true, state: "dialing" },
  );
  const input = { number: "13900139000" };
  const ctx = makeCtx({ userId: "user-dial-retry", chatUserMessageId: "msg-retry-1" });

  const first = await registry.execute("phone.dial", input, ctx);
  assert.equal(first.result.ok, false);
  assert.equal(calls.length, 1);

  fail = false;
  const retry = await registry.execute("phone.dial", input, ctx);
  assert.equal(retry.ok, true);
  assert.equal(retry.result.deduped, undefined);
  assert.equal(calls.length, 2, "首次失败后同轮重试应真正触达 bridge");
});

test("phone.dial: 紧急号码在服务端拒绝，不触达 bridge", async () => {
  const { registry, calls } = makeRegistry();
  const r = await registry.execute("phone.dial", { number: "120" }, makeCtx());
  assert.equal(r.result.ok, false);
  assert.match(String(r.result.error), /紧急号码/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// schema 与门控名单
// ---------------------------------------------------------------------------

test("phone.dial: LLM schema 已注册且 required=[number]", () => {
  const def = PHONE_BRIDGE_CHAT_TOOL_DEFINITIONS.find(
    (t) => t.function.name === "phone.dial",
  );
  assert.ok(def, "phone.dial 应存在于桥接 chat 工具定义中");
  const params = def.function.parameters as Record<string, unknown> & {
    required?: string[];
    properties: Record<string, { enum?: string[] }>;
  };
  assert.deepEqual(params.required, ["number"]);
  assert.deepEqual(params.properties.mode.enum, ["direct", "draft"]);
});
