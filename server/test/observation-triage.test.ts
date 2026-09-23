// L0 观察分诊（observation-triage）单元测试——2026-09-23 token 架构优化。
// 通用路径在调 LLM 前按窗口显著性过滤：纯低显著噪声直接跳过（零 token），
// medium/high 窗口才进 InitiativeEngine 评估。
import assert from "node:assert/strict";
import test from "node:test";

import { triageObservations } from "../src/proactivity/observation-triage.js";
import type { Observation } from "../src/proactivity/proactivity-types.js";

const obs = (
  type: string,
  salience: Observation["salience"],
  content = `${type} 内容`,
): Observation => ({ actorId: "t", type, content, salience, observedAt: Date.now() });

test("空窗口 → skip", () => {
  const v = triageObservations([]);
  assert.equal(v.action, "skip");
  assert.equal(v.reason, "empty_window");
});

test("纯低显著噪声（对话轮/活跃）→ skip，且标记无高显著", () => {
  const v = triageObservations([
    obs("conversation_turn", "low", "用户说：帮我看看这个报错"),
    obs("user_activity", "low", "用户活跃（来源：conversation）"),
    obs("conversation_turn", "low", "用户说：好了"),
  ]);
  assert.equal(v.action, "skip");
  assert.equal(v.reason, "background_noise_only");
  assert.equal(v.hasHighSalience, false);
});

test("含 high 显著观察 → evaluate（工具清单依据）", () => {
  const v = triageObservations([
    obs("conversation_turn", "low"),
    obs("message_unread_burst", "high", "未读爆发"),
  ]);
  assert.equal(v.action, "evaluate");
  assert.equal(v.hasHighSalience, true);
  assert.equal(v.highCount, 1);
});

test("仅 medium 观察（日程快照/兴趣热议）→ evaluate，但不算高显著", () => {
  const v = triageObservations([
    obs("conversation_turn", "low"),
    obs("schedule_snapshot", "medium", "今日日程有变化"),
  ]);
  assert.equal(v.action, "evaluate");
  assert.equal(v.hasHighSalience, false);
  assert.equal(v.mediumCount, 1);
});

test("未知类型但 salience=low → skip（生产方的显著性声明是权威）", () => {
  // salience 是观察生产方的声明：声明为 low 就不触发评估，否则任何模块推
  // 自定义低显著观察都会重新灌开 LLM 洪水（9166 次/月的教训）
  const v = triageObservations([obs("exotic_sensor_event", "low")]);
  assert.equal(v.action, "skip");
  assert.equal(v.reason, "background_noise_only");
});
