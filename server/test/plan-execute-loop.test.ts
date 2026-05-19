import test from "node:test";
import assert from "node:assert/strict";

import {
  parseExecutionPlan,
  parseVerifyDecision,
  planExecuteSessionId,
} from "../src/agent/plan-execute-loop.js";

test("parseExecutionPlan accepts minimal JSON object", () => {
  const raw =
    '{"goal":"查 weather","steps":[{"id":"a","intent":"拿天气","successCriteria":"拿到温度"}]}';
  const p = parseExecutionPlan(raw);
  assert.ok(p);
  assert.equal(p?.goal, "查 weather");
  assert.equal(p?.steps.length, 1);
  assert.equal(p?.steps[0]?.id, "a");
  assert.equal(p?.steps[0]?.intent, "拿天气");
  assert.equal(p?.steps[0]?.successCriteria, "拿到温度");
});

test("parseExecutionPlan rejects empty goal", () => {
  const p = parseExecutionPlan('{"goal":"  ","steps":[{"id":"1","intent":"x"}]}');
  assert.equal(p, null);
});

test("parseExecutionPlan extracts JSON from surrounding text", () => {
  const raw = 'sure {"goal":"g","steps":[{"id":"1","intent":"step one"}]}';
  const p = parseExecutionPlan(raw);
  assert.ok(p);
  assert.equal(p?.goal, "g");
});

test("parseVerifyDecision requires boolean pass", () => {
  assert.equal(parseVerifyDecision('{}'), null);
});

test("parseVerifyDecision parses pass gaps reflection", () => {
  const d = parseVerifyDecision('{"pass":false,"gaps":["missing data"],"reflection":"retry"}');
  assert.ok(d);
  assert.equal(d?.pass, false);
  assert.deepEqual(d?.gaps, ["missing data"]);
  assert.equal(d?.reflection, "retry");
});

test("planExecuteSessionId is deterministic", () => {
  assert.equal(
    planExecuteSessionId("actor-1", "msg-x"),
    "actor-1\u007fpe\u007fmsg-x",
  );
});
