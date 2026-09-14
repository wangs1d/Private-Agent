/**
 * 豆包式列队发送（2026-09-14）排队语义补充测试。
 *
 * 在 A1 证据测试（message-batch-processor-queueing.test.ts）之上，
 * 固化客户端排队 UI 依赖的行为契约：
 *   1. 处理中连发多条（≥3）→ 严格按发送顺序逐条处理，每条独立回复，不合并；
 *   2. 每条排队消息获得单调递增的 generation（客户端以 isStaleTurn 门控迟到输出）；
 *   3. 处理中到达 + 客户端上报 processing_ui active=false（锁定本轮）的组合下，
 *      队列语义不变：不合并进活动轮，仍依次处理。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { MessageBatchProcessor } = await import("../src/ws/message-batch-processor.js");

const msg = (id: string, text: string) => ({
  text,
  originalMessageId: id,
  userId: "u1",
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("列队：处理中连发多条按发送顺序依次处理，每条独立回复不合并", async () => {
  const processor = new MessageBatchProcessor();
  const handled: string[] = [];
  const generations: number[] = [];
  let releaseTurn!: () => void;
  let turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  const onReady = async (merged: { text: string }, turn: { generation: number }) => {
    handled.push(merged.text);
    generations.push(turn.generation);
    await turnGate;
  };

  // 第 1 条：开始处理并挂住（模拟进行中的长轮次）
  processor.submit("s1", msg("m1", "调研最近的热点话题"), onReady);
  await tick();
  await tick();
  assert.deepEqual(handled, ["调研最近的热点话题"]);

  // 处理中连发第 2、3 条：入队，不被立即处理，也不与活动轮合并
  // （submit 每次会整体覆盖 onReady 处理器，必须与生产路径一致地传入）
  processor.submit("s1", msg("m2", "基于热点写活动提案"), onReady);
  processor.submit("s1", msg("m3", "把最佳提案做成 PPT"), onReady);
  await tick();
  await tick();
  assert.deepEqual(handled, ["调研最近的热点话题"], "排队消息不得在当前轮 settle 前处理");

  // 第 1 轮结束 → 第 2 条按序处理
  releaseTurn();
  releaseTurn = (() => {
    let r!: () => void;
    turnGate = new Promise<void>((resolve) => (r = resolve));
    return r;
  })();
  await tick();
  await tick();
  assert.deepEqual(handled, ["调研最近的热点话题", "基于热点写活动提案"]);

  // 第 2 轮结束 → 第 3 条按序处理
  releaseTurn();
  await tick();
  await tick();
  assert.deepEqual(handled, [
    "调研最近的热点话题",
    "基于热点写活动提案",
    "把最佳提案做成 PPT",
  ]);

  // 每条消息独立一轮，generation 严格单调递增（迟到输出靠它门控）
  assert.equal(generations.length, 3);
  assert.ok(generations[0] < generations[1] && generations[1] < generations[2]);
  // 队列已清空
  assert.equal(processor.getQueueSize("s1"), 0);
});

test("列队：轮次结束后旧 generation 标记为 stale（客户端据此丢弃迟到输出）", async () => {
  const processor = new MessageBatchProcessor();
  let releaseTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  processor.submit("s1", msg("m1", "第一轮"), async () => {
    await gate;
  });
  await tick();
  await tick();

  processor.submit("s1", msg("m2", "第二轮"), async () => {});
  releaseTurn();
  await tick();
  await tick();

  // 第 1 轮期间的 generation 已过期：第 2 轮 generation 必然更大
  const staleProbe = { generation: 1 };
  assert.equal(processor.isStaleTurn("s1", staleProbe.generation), true);
  assert.equal(processor.isStaleTurn("s1", 999), true);
});

test("列队：客户端上报 processing_ui 关闭（锁定本轮）后，新消息仍按队列依次处理", async () => {
  const processor = new MessageBatchProcessor();
  const handled: string[] = [];
  let releaseTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  processor.submit("s1", msg("m1", "第一轮"), async (merged) => {
    handled.push(merged.text);
    await gate;
  });
  await tick();
  await tick();

  // 客户端隐藏「处理中」UI → 锁定本轮不可再合并
  processor.setClientProcessingUiActive("s1", false);
  // 处理中新消息：必须排队，不因锁定被合并/丢弃
  processor.submit("s1", msg("m2", "排队消息"), async (merged) => {
    handled.push(merged.text);
  });
  await tick();
  await tick();
  assert.deepEqual(handled, ["第一轮"]);

  releaseTurn();
  await tick();
  await tick();
  assert.deepEqual(handled, ["第一轮", "排队消息"]);
});
