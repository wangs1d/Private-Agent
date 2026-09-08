/**
 * A1（2026-09-08）同 session 排队行为测试。
 *
 * 背景：plane=task 轮被前台 turn 全程 await（agent-core.ts launchComplexBackgroundTask），
 * 该 turn 在 MessageBatchProcessor.onReady 中迟迟不 settle，processing 槽被占满整个
 * 任务时长（硬超时兜底 600s）。本测试固化当前行为契约：
 *   1. 长任务轮执行期间，同 session 的新消息进入 messageQueue 排队，等当前轮结束才处理
 *      ——即"任务执行期间用户可继续发消息（互不阻塞）"承诺在同 session 内的差距证据；
 *   2. 其他 session 不受影响（B 不等 A）。
 * 解耦方案（任务提交即释放 session 槽）待产品决策；若未来落地，测试 1 需要同步改写。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { MessageBatchProcessor } = await import("../src/ws/message-batch-processor.js");

const msg = (text: string) => ({
  text,
  originalMessageId: `m-${text}`,
  userId: "u1",
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("A1 证据：长任务轮期间同 session 新消息排队，轮结束后依次处理", async () => {
  const processor = new MessageBatchProcessor();
  const handled: string[] = [];
  let releaseFirst!: () => void;
  const firstTurnGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  // 第一条：模拟 plane=task 长任务轮（onReady 在任务完成前不 settle）
  processor.submit("s1", msg("帮我订明天去上海的机票"), async (merged) => {
    handled.push(merged.text);
    await firstTurnGate;
  });
  await tick();
  await tick();
  assert.deepEqual(handled, ["帮我订明天去上海的机票"], "第一条消息应已开始处理");

  // 处理中发第二条：应入队，不被立即处理
  processor.submit("s1", msg("顺便查下明天上海天气"), async (merged) => {
    handled.push(merged.text);
  });
  await tick();
  await tick();
  assert.deepEqual(
    handled,
    ["帮我订明天去上海的机票"],
    "长任务轮 settle 前，同 session 新消息必须排队（不可并行处理）",
  );

  // 任务轮结束 → 队列中的消息被依次处理
  releaseFirst();
  await tick();
  await tick();
  assert.deepEqual(handled, ["帮我订明天去上海的机票", "顺便查下明天上海天气"]);
});

test("A1 对照：长任务轮不阻塞其他 session 的消息处理", async () => {
  const processor = new MessageBatchProcessor();
  const handled: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  processor.submit("sA", msg("A 的长任务"), async (merged) => {
    handled.push(merged.text);
    await gateA;
  });
  await tick();
  await tick();
  assert.deepEqual(handled, ["A 的长任务"]);

  // sA 仍在处理中，sB 的消息应立即处理
  processor.submit("sB", msg("B 的闲聊"), async (merged) => {
    handled.push(merged.text);
  });
  await tick();
  await tick();
  assert.deepEqual(handled, ["A 的长任务", "B 的闲聊"], "跨 session 不排队");

  releaseA();
  await tick();
});
