/**
 * 结构化 LLM 调用契约（structured-call）行为测试。
 *
 * 契约（2026-10-07 对齐主流网关）：
 * - 永不抛错：所有失败折叠为 reason 联合类型（provider_disabled/timeout/call_error/unparseable）；
 * - 网关式重试：超时/坏输出原参重试；异常去参（response_format）重试；默认最多 2 次；
 * - parse 回调返回 null = 坏输出触发重试；成功时带回 attempts 可观测计数；
 * - 默认 ephemeralTurn / suppressRuntimeSuffixes（结构化调用语义）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { structuredCall } = await import("../src/external-model/structured-call.js");

type Opts = Record<string, unknown>;

function scriptedProvider(
  script: Array<
    | { kind: "return"; value: string }
    | { kind: "throw"; error: Error }
    | { kind: "hang"; ms: number }
  >,
  enabled = true,
) {
  const calls = { count: 0, opts: [] as Opts[] };
  const step = (i: number) => script[Math.min(i, script.length - 1)]!;
  const provider = {
    id: "openai",
    isEnabled: () => enabled,
    streamCompletion: async (
      _sid: string,
      _turn: { text: string },
      _onDelta: unknown,
      _x: unknown,
      opts?: Opts,
    ) => {
      const s = step(calls.count);
      calls.count += 1;
      calls.opts.push(opts ?? {});
      if (s.kind === "throw") throw s.error;
      if (s.kind === "hang") await new Promise((r) => setTimeout(r, s.ms));
      return s.kind === "return" ? s.value : "";
    },
  };
  return { provider: provider as never, calls };
}

const numParse = (raw: string) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

test("契约：成功路径返回 value/raw/attempts，默认带 ephemeral 与 json mode", async () => {
  const { provider, calls } = scriptedProvider([{ kind: "return", value: "42" }]);
  const result = await structuredCall<number>(provider, "sess-1", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    jsonMode: true,
    parse: numParse,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, 42);
  assert.equal(result.raw, "42");
  assert.equal(result.attempts, 1);
  assert.equal(calls.opts[0]?.responseFormat, "json_object");
  assert.equal(calls.opts[0]?.ephemeralTurn, true);
  assert.equal(calls.opts[0]?.suppressRuntimeSuffixes, true);
  assert.equal(calls.opts[0]?.functionalSuffixes, false);
  assert.equal(calls.opts[0]?.maxOutputTokens, 192);
});

test("契约：provider 未启用 → provider_disabled，零调用", async () => {
  const { provider, calls } = scriptedProvider([{ kind: "return", value: "42" }], false);
  const result = await structuredCall<number>(provider, "sess-2", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    jsonMode: false,
    parse: numParse,
  });
  assert.deepEqual(result, { ok: false, reason: "provider_disabled", attempts: 0 });
  assert.equal(calls.count, 0);
});

test("契约：超时原参重试；两试皆超时 → timeout", async () => {
  const { provider, calls } = scriptedProvider([{ kind: "hang", ms: 200 }]);
  const result = await structuredCall<number>(provider, "sess-3", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 30,
    jsonMode: true,
    parse: numParse,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "timeout");
  assert.equal(result.attempts, 2);
  assert.equal(calls.count, 2);
  assert.equal(calls.opts[1]?.responseFormat, "json_object", "超时重试保持原参");
});

test("契约：坏输出重试一次后成功 → ok 且 attempts=2", async () => {
  const { provider, calls } = scriptedProvider([
    { kind: "return", value: "not a number" },
    { kind: "return", value: "42" },
  ]);
  const result = await structuredCall<number>(provider, "sess-4", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    jsonMode: false,
    parse: numParse,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, 42);
  assert.equal(result.attempts, 2);
  assert.equal(calls.count, 2);
});

test("契约：异常去参重试（json mode 自适应）；两试皆异常 → call_error 带 lastError", async () => {
  const { provider, calls } = scriptedProvider([
    { kind: "throw", error: new Error("response_format unsupported") },
    { kind: "throw", error: new Error("still down") },
  ]);
  const result = await structuredCall<number>(provider, "sess-5", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    jsonMode: true,
    parse: numParse,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "call_error");
  assert.ok(result.lastError instanceof Error);
  assert.equal(calls.count, 2);
  assert.equal(calls.opts[0]?.responseFormat, "json_object");
  assert.equal(calls.opts[1]?.responseFormat, undefined, "异常重试应去掉 response_format");
});

test("契约：maxAttempts=1 时失败不重试，首次即折叠为最终 reason", async () => {
  const { provider, calls } = scriptedProvider([{ kind: "throw", error: new Error("down") }]);
  const result = await structuredCall<number>(provider, "sess-6", "prompt", {
    label: "test",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    jsonMode: false,
    parse: numParse,
    maxAttempts: 1,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "call_error");
  assert.equal(result.attempts, 1);
  assert.equal(calls.count, 1);
});
