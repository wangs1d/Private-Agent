import { test } from "node:test";
import assert from "node:assert";
import {
  parseFastVerdict,
  stripFastVerdictMarker,
  normalizeFastVerdict,
  VerdictStreamGuard,
} from "../src/utils/fast-verdict.js";

test("parseFastVerdict 命中 need_complex+task_spec", () => {
  const reply =
    "我先帮你查一下最新信息。<<<verdict:{\"need_complex\":true,\"difficulty\":\"needs_external\",\"task_spec\":{\"goal\":\"查询2026年奥斯卡最佳影片\",\"expected_output\":\"影片名+导演\",\"tool_hints\":[\"web.search\"],\"budget\":{\"max_tool_rounds\":2,\"max_llm_calls\":3}}}>>>";
  const v = parseFastVerdict(reply);
  assert.ok(v);
  assert.equal(v!.need_complex, true);
  assert.equal(v!.difficulty, "needs_external");
  assert.equal(v!.task_spec!.goal, "查询2026年奥斯卡最佳影片");
  assert.deepEqual(v!.task_spec!.tool_hints, ["web.search"]);
  assert.equal(v!.task_spec!.budget!.max_tool_rounds, 2);
});

test("parseFastVerdict difficulty=multi_step 自动判 need_complex", () => {
  const v = parseFastVerdict(
    "好的，我去查一下。<<<verdict:{\"need_complex\":false,\"difficulty\":\"multi_step\",\"task_spec\":{\"goal\":\"多步任务\"}}>>>",
  );
  assert.ok(v);
  assert.equal(v!.need_complex, true);
  assert.equal(v!.task_spec!.goal, "多步任务");
});

test("parseFastVerdict simple 且 need_complex=false → need_complex=false", () => {
  const v = parseFastVerdict(
    "好的没问题。<<<verdict:{\"need_complex\":false,\"difficulty\":\"simple\"}>>>",
  );
  assert.ok(v);
  assert.equal(v!.need_complex, false);
});

test("parseFastVerdict 需要 complex 但缺 task_spec → null（回退既有路径）", () => {
  const v = parseFastVerdict(
    "需要查一下。<<<verdict:{\"need_complex\":true,\"difficulty\":\"needs_external\"}>>>",
  );
  assert.equal(v, null);
});

test("parseFastVerdict 非法 JSON / 未命中标记 → null", () => {
  assert.equal(parseFastVerdict("正常回复没有标记"), null);
  assert.equal(parseFastVerdict("<<<verdict:not-json>>>"), null);
  assert.equal(parseFastVerdict(""), null);
});

test("parseFastVerdict 兼容 json 代码块包裹", () => {
  const v = parseFastVerdict(
    "xxxxx<<<verdict:```json\n{\"need_complex\":true,\"difficulty\":\"needs_external\",\"task_spec\":{\"goal\":\"g\"}}\n```>>>",
  );
  assert.ok(v);
  assert.equal(v!.task_spec!.goal, "g");
});

test("stripFastVerdictMarker 剥离标记，保留正文", () => {
  const body = "我先帮你查一下最新信息。";
  const reply =
    body +
    '<<<verdict:{"need_complex":true,"difficulty":"needs_external","task_spec":{"goal":"g"}}>>>';
  assert.equal(stripFastVerdictMarker(reply), body);
});

test("stripFastVerdictMarker 无标记 → 原样返回", () => {
  assert.equal(stripFastVerdictMarker("正常回复"), "正常回复");
  assert.equal(stripFastVerdictMarker(""), "");
});

test("normalizeFastVerdict 结构加固", () => {
  const raw = {
    need_complex: true,
    difficulty: "needs_external",
    task_spec: { goal: "g", tool_hints: [123, "a"], budget: { max_tool_rounds: 5 } },
  };
  const v = normalizeFastVerdict(raw);
  assert.ok(v);
  assert.deepEqual(v!.task_spec!.tool_hints, ["a"]);
  assert.equal(v!.task_spec!.budget!.max_tool_rounds, 5);
});