// PerceptionFeed（通用感知层）单测：
// 滚动窗口、增量消费（consumeWindow 水位）、recent 背景上下文、pendingCount。
import assert from "node:assert/strict";
import test from "node:test";

import { PerceptionFeed } from "../src/proactivity/perception-feed.js";

const ACTOR = "actor-1";

test("pushObservation + consumeWindow：增量返回新观察并推进水位", () => {
  const feed = new PerceptionFeed();
  feed.pushObservation(ACTOR, "conversation_turn", "用户说：在忙项目", "low");
  feed.pushObservation(ACTOR, "task_completed", "复杂任务完成：周报", "high");

  const first = feed.consumeWindow(ACTOR);
  assert.equal(first.length, 2);
  assert.equal(first[0].type, "conversation_turn");
  assert.equal(first[1].salience, "high");

  // 已消费：再次 consume 无新观察（调用方据此跳过 LLM 评估，零开销）
  assert.equal(feed.consumeWindow(ACTOR).length, 0);
  assert.equal(feed.pendingCount(ACTOR), 0);

  // 新观察到来后才再次返回
  feed.pushObservation(ACTOR, "schedule_snapshot", "今日日程：SCH|count=2", "medium");
  const second = feed.consumeWindow(ACTOR);
  assert.equal(second.length, 1);
  assert.equal(second[0].type, "schedule_snapshot");
});

test("consumeWindow：无观察的 actor 返回空数组不抛错", () => {
  const feed = new PerceptionFeed();
  assert.deepEqual(feed.consumeWindow("nobody"), []);
});

test("滚动窗口：超过 40 条丢最旧", () => {
  const feed = new PerceptionFeed();
  for (let i = 0; i < 45; i++) {
    feed.pushObservation(ACTOR, "tick", `观察 ${i}`, "low");
  }
  const all = feed.recent(ACTOR, 100);
  assert.equal(all.length, 40);
  assert.equal(all[0].content, "观察 5"); // 最旧的 5 条被挤出
  assert.equal(all[39].content, "观察 44");
});

test("recent：只读不推进水位，返回最近 N 条", () => {
  const feed = new PerceptionFeed();
  for (let i = 0; i < 8; i++) {
    feed.pushObservation(ACTOR, "tick", `观察 ${i}`, "low");
  }
  const recent = feed.recent(ACTOR, 3);
  assert.equal(recent.length, 3);
  assert.equal(recent[2].content, "观察 7");

  // recent 不消费：pendingCount 仍为全部
  assert.equal(feed.pendingCount(ACTOR), 8);
  assert.equal(feed.consumeWindow(ACTOR).length, 8);
});

test("多 actor 隔离", () => {
  const feed = new PerceptionFeed();
  feed.pushObservation("a", "conversation_turn", "A 的观察", "low");
  feed.pushObservation("b", "conversation_turn", "B 的观察", "low");
  assert.equal(feed.consumeWindow("a").length, 1);
  assert.equal(feed.consumeWindow("b").length, 1);
  assert.equal(feed.consumeWindow("a").length, 0);
});

test("metadata 透传", () => {
  const feed = new PerceptionFeed();
  feed.pushObservation(ACTOR, "rhythm_overwork", "过劳信号", "high", 12345, {
    continuousWorkHours: 3.5,
  });
  const [obs] = feed.consumeWindow(ACTOR);
  assert.equal(obs.metadata?.continuousWorkHours, 3.5);
  assert.equal(obs.observedAt, 12345);
});
