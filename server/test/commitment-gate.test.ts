/**
 * 出口诚实闸（2026-09-05 前后台架构）测试。
 *
 * 契约：前台回复含「已办妥/这就去办」类承诺话术 → hasCommitmentClaim 为真，
 * agent-core 出口处若本轮无任何工具动作则自动补派后台任务。
 * 本文件覆盖判定函数本身；补派执行端在 agent-core.dispatchBackgroundTask。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { hasCommitmentClaim } = await import("../src/agent/commitment-gate.js");

test("完成承诺：已办妥类断言命中", () => {
  for (const text of [
    "好的，已经帮你设置好了提醒。",
    "已创建日程：明天上午八点开会。",
    "订好了，明天下午 3 点的会议室。",
    "已经记下了，回头提醒你。",
    "下单成功了，预计三天送达。",
  ]) {
    assert.equal(hasCommitmentClaim(text), true, `「${text}」应识别为完成承诺`);
  }
});

test("即时承诺：这就去办类断言命中", () => {
  for (const text of ["在办了", "这就去订", "马上帮你设置。", "这就去处理"]) {
    assert.equal(hasCommitmentClaim(text), true, `「${text}」应识别为即时承诺`);
  }
});

test("未然/否定语境不命中", () => {
  for (const text of [
    "还没设置好，等一下哦。",
    "这个我帮不了你，无法下单。",
    "你现在方便说一下要订几点的吗？",
    "失败了，支付通道超时。",
    "今天聊得真开心，改天再约！",
    "哈哈笑死我了",
  ]) {
    assert.equal(hasCommitmentClaim(text), false, `「${text}」不应识别为承诺`);
  }
});
