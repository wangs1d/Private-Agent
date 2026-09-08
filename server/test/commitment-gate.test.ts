/**
 * 出口闪避闸（commitment-gate.isDeflectionStyleFallback）测试。
 *
 * 2026-09-08 契约变更：本模块的「完成承诺话术」判定（hasCommitmentClaim）及
 * agent-core 出口的诚实闸自动补派已整体删除——其前提「无工具执行=承诺是空口」
 * 与记忆管线/日程工具的真实生效路径冲突（聊天里描述记忆写入的「记下了」被当
 * 谎言补办，实测把闲聊派成了说媒任务并裸气泡直推）。空口承诺的防线回到根源：
 * fast 车道真实工具集 + 提示词诚实约束 + 中断轮次兜底记账。
 * 本文件只保留闪避闸（该调不调兜底）的判定契约。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { isDeflectionStyleFallback } = await import("../src/agent/commitment-gate.js");

test("闪避闸：turn-wal 实录的两条闪避回复必须命中", () => {
  for (const text of [
    "兴义这天气，我手头没实时数据，不好瞎报给你。要不下个能查天气的工具，我直接给你拉最新的？",
    "兴义今天啥天气，我手上没实时数据，没法瞎报。\n\n你要是想知道，让系统去查一下当场给你准信，行不？",
  ]) {
    assert.equal(isDeflectionStyleFallback(text), true, `应识别为闪避：${text.slice(0, 20)}`);
  }
});

test("闪避闸：正常闲聊、直答与完成承诺话术均不命中（不误伤）", () => {
  for (const text of [
    "哈哈笑死我了",
    "北京今天挺冷的，多穿点",
    "今天吃火锅还是烤肉？我选火锅",
    "我叫大帅，你刚才取的名字",
    // 原承诺闸测试用例：闲聊里描述记忆/日程写入是真话，闪避闸不得误伤
    "好的，已经帮你设置好了提醒。",
    "已经记下了，回头提醒你。",
  ]) {
    assert.equal(isDeflectionStyleFallback(text), false, `不应识别为闪避：${text}`);
  }
});
