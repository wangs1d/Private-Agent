import test from "node:test";
import assert from "node:assert/strict";

/**
 * LLM 预算告警出口测试（2026-09-28 上线护栏）：
 * 阈值命中时 setBudgetAlertSink 注入的回调收到 BudgetStatus，
 * 每 key 每档（warn 80% / exceeded 100%）各触发一次，不刷屏。
 *
 * 运行：npx tsx --test test/llm-budget-alert.test.ts
 */

// 模块加载时读 env 定阈值：日限 100（80%=80 触发 warn）、会话限 0 关闭
process.env.AGENT_LLM_BUDGET_DAILY_TOKENS = "100";
process.env.AGENT_LLM_BUDGET_SESSION_TOKENS = "0";

const { recordBudgetUsage, setBudgetAlertSink, resetBudgetGuardForTest } = await import(
  "../src/services/llm-budget-guard.js"
);

test("日预算告警：80% warn 一次 → 100% exceeded 一次 → 同档不重复", () => {
  resetBudgetGuardForTest();
  const alerts: string[] = [];
  setBudgetAlertSink((status) => alerts.push(`${status.scope}:${status.level}`));
  try {
    const actor = "budget-alert-user";
    // 60：无告警
    recordBudgetUsage({ actorId: actor, tokens: 60 });
    assert.deepEqual(alerts, []);
    // 跨过 80% 线：warn 一次
    recordBudgetUsage({ actorId: actor, tokens: 25 });
    assert.deepEqual(alerts, ["daily:warn"]);
    // 仍在 warn 区间（85）：不重复
    recordBudgetUsage({ actorId: actor, tokens: 10 });
    assert.deepEqual(alerts, ["daily:warn"]);
    // 跨过 100%：exceeded 一次
    recordBudgetUsage({ actorId: actor, tokens: 20 });
    assert.deepEqual(alerts, ["daily:warn", "daily:exceeded"]);
    // 继续超限：不再重复
    recordBudgetUsage({ actorId: actor, tokens: 50 });
    assert.deepEqual(alerts, ["daily:warn", "daily:exceeded"]);
  } finally {
    setBudgetAlertSink(null);
    resetBudgetGuardForTest();
  }
});

test("告警出口抛错不影响记账主流程（hit 列表照常返回）", () => {
  resetBudgetGuardForTest();
  setBudgetAlertSink(() => {
    throw new Error("sink broken");
  });
  try {
    const hit = recordBudgetUsage({ actorId: "boom-user", tokens: 100 });
    assert.ok(hit.some((s) => s.scope === "daily" && s.level === "exceeded"));
  } finally {
    setBudgetAlertSink(null);
    resetBudgetGuardForTest();
  }
});
