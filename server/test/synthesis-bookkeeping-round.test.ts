import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAndSelectStrategy } from "../src/agent/synthesis-strategy.js";

// ===== 记账轮短路（2026-10-06 治啰嗦 P0-2）=====
// profile.update 等记账型工具的回执不是可组织成回复的检索数据；
// 只有记账回执的轮次不得叠加「信息用足/按主题分节」展开策略，
// 否则一句「以后叫我王哥」会被写成研究报告（真机事故形态）。

test("bookkeeping-only round yields no expansion strategy", () => {
  const directive = evaluateAndSelectStrategy(
    [
      { toolName: "profile.update", ok: true, result: { ok: true, hint: "已写入画像。", recorded: "称呼：王哥" } },
    ],
    "以后叫我王哥",
  );
  assert.equal(directive.strategy, "direct_answer");
  assert.equal(directive.instruction, "");
  assert.equal(directive.quality.level, "empty");
});

test("bookkeeping tools do not inflate mixed-round data quality", () => {
  // 记账回执 + 一次真实搜索：策略只按搜索结果评估，profile.update 的 hint 文本
  // 不计入内容长度（否则回执文本会虚增 totalContentLength 顶高档位）。
  const withBookkeeping = evaluateAndSelectStrategy(
    [
      { toolName: "profile.update", ok: true, result: { ok: true, hint: "已写入画像。" } },
      { toolName: "search_web", ok: true, result: { items: [{ title: "t", snippet: "s" }] } },
    ],
    "帮我查一下最近的安排",
  );
  const searchOnly = evaluateAndSelectStrategy(
    [{ toolName: "search_web", ok: true, result: { items: [{ title: "t", snippet: "s" }] } }],
    "帮我查一下最近的安排",
  );
  assert.equal(withBookkeeping.strategy, searchOnly.strategy);
  assert.equal(withBookkeeping.quality.totalContentLength, searchOnly.quality.totalContentLength);
});
