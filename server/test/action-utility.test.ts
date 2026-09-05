// 方案 A：Action Utility 评估器单测——确定性决策规则 / 风险合成 / 维度推导
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeRiskScore,
  deriveActValue,
  deriveNotifyValue,
  deriveRiskFromSteps,
  evaluateActionUtility,
  ASK_WORTHINESS_MIN_VALUE,
  EXECUTE_SILENTLY_THRESHOLD,
  RISK_UTILITY_DRAG,
  RISK_WEIGHTS,
} from "../src/proactivity/action-utility.js";

const SAFE_RISK = {
  reversible: true,
  financialImpact: "none",
  dataSensitivity: "none",
  thirdPartyImpact: false,
} as const;

// ─── 决策规则（顺序固定，先命中先出）───

test("规则1: 净效用为负 → silence（不值得做，也不值得问）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "explicit",
    value: { expectedValue: 0.2, interruptionCost: 0.5 },
  });
  assert.equal(r.branch, "silence");
  assert.ok(r.netUtility < 0);
  assert.match(r.reason, /net_utility_negative/);
});

test("规则1 优先于规则2: 不可逆但净效用为负 → silence（既不做也不问）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { ...SAFE_RISK, reversible: false },
    authorization: "explicit",
    value: { expectedValue: 0.1, interruptionCost: 0.4 }, // 0.1-0.4-0.2 < 0
  });
  assert.equal(r.branch, "silence");
});

test("规则2: 不可逆 → ask_first（高风险永不静默执行）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { ...SAFE_RISK, reversible: false },
    authorization: "explicit",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /irreversible_action/);
});

test("规则2: 高金融影响 → ask_first（即使可逆）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { ...SAFE_RISK, financialImpact: "high" },
    authorization: "explicit",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /high_financial_impact/);
});

test("规则3: 无授权且影响第三方 → ask_first", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { ...SAFE_RISK, thirdPartyImpact: true },
    authorization: "none",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /unauthorized_third_party/);
});

test("规则3 边界: 无授权但不影响第三方不走规则3（落入保守默认）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "none",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /conservative_default/);
});

test("规则4: 可逆+有授权+净效用超阈 → execute_silently", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "implicit",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(r.branch, "execute_silently");
  assert.ok(r.netUtility > EXECUTE_SILENTLY_THRESHOLD);
  assert.match(r.reason, /reversible_authorized_high_utility/);
});

test("规则5: 可逆+有授权但净效用未超阈 → ask_first（保守默认）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "implicit",
    value: { expectedValue: 0.42, interruptionCost: 0.3 }, // net=0.12 ≤ 0.15
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /conservative_default/);
});

test("规则5a: 期望价值低于「值得问」底线 → silence（问比做更打扰）", () => {
  assert.ok(0.2 < ASK_WORTHINESS_MIN_VALUE);
  const r = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "implicit",
    value: { expectedValue: 0.2, interruptionCost: 0.05 }, // net=0.15 未超阈，且价值低
  });
  assert.equal(r.branch, "silence");
  assert.match(r.reason, /low_value_not_worth_asking/);
});

test("规则5a 不越位: 不可逆动作即使低价值仍走规则2 ask_first（危险必须问）", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { ...SAFE_RISK, reversible: false },
    authorization: "explicit",
    value: { expectedValue: 0.25, interruptionCost: 0.05 }, // net=0 → 非负
  });
  assert.equal(r.branch, "ask_first");
  assert.match(r.reason, /irreversible_action/);
});

test("显式与隐式授权等价进入规则4；无授权不行", () => {
  for (const authorization of ["explicit", "implicit"] as const) {
    const r = evaluateActionUtility({
      kind: "test",
      risk: SAFE_RISK,
      authorization,
      value: { expectedValue: 0.9, interruptionCost: 0.1 },
    });
    assert.equal(r.branch, "execute_silently", `authorization=${authorization}`);
  }
  const none = evaluateActionUtility({
    kind: "test",
    risk: SAFE_RISK,
    authorization: "none",
    value: { expectedValue: 0.9, interruptionCost: 0.1 },
  });
  assert.equal(none.branch, "ask_first");
});

test("确定性：同输入两次评估结果完全一致（含浮点取整）", () => {
  const input = {
    kind: "test",
    risk: { reversible: false, financialImpact: "low", dataSensitivity: "personal", thirdPartyImpact: true },
    authorization: "none",
    value: { expectedValue: 0.7, interruptionCost: 0.2 },
  } as const;
  assert.deepEqual(evaluateActionUtility(input), evaluateActionUtility(input));
});

// ─── 风险分合成 ───

test("风险分: 权重合成（不可逆0.4 + 高金融0.3 + 敏感数据0.2 + 第三方0.1 封顶1）", () => {
  assert.equal(
    computeRiskScore({ reversible: false, financialImpact: "high", dataSensitivity: "sensitive", thirdPartyImpact: true }),
    1,
  );
  assert.equal(computeRiskScore(SAFE_RISK), 0);
  // 不可逆 + 第三方 = 0.5
  assert.equal(computeRiskScore({ ...SAFE_RISK, reversible: false, thirdPartyImpact: true }), 0.5);
  // 低金融 0.3*0.4 + personal 数据 0.2*0.4 = 0.2
  assert.equal(
    computeRiskScore({ ...SAFE_RISK, financialImpact: "low", dataSensitivity: "personal" }),
    0.2,
  );
  const weightsSum =
    RISK_WEIGHTS.irreversible + RISK_WEIGHTS.financialHigh + RISK_WEIGHTS.dataSensitive + RISK_WEIGHTS.thirdParty;
  assert.ok(Math.abs(weightsSum - 1) < 1e-9);
});

test("风险拖累计入净效用: riskScore=1 时扣 RISK_UTILITY_DRAG", () => {
  const r = evaluateActionUtility({
    kind: "test",
    risk: { reversible: true, financialImpact: "high", dataSensitivity: "sensitive", thirdPartyImpact: true },
    authorization: "explicit",
    value: { expectedValue: 0.6, interruptionCost: 0.1 },
  });
  assert.equal(r.riskScore, 0.6); // 0.3+0.2+0.1（可逆）
  assert.ok(Math.abs(r.netUtility - (0.6 - 0.1 - RISK_UTILITY_DRAG * 0.6)) < 1e-9);
  assert.equal(r.branch, "ask_first"); // 高金融 → 规则2
});

// ─── 行动步骤风险推导 ───

test("deriveRiskFromSteps: 删除/外发类不可逆，涉钱高档，通信类涉第三方", () => {
  const media = deriveRiskFromSteps([{ tool: "media.play", args: { trackId: "t1" } }]);
  assert.equal(media.reversible, true);
  assert.equal(media.financialImpact, "none");
  assert.equal(media.thirdPartyImpact, false);

  const send = deriveRiskFromSteps([{ tool: "message.send", args: { to: "friend", text: "hi" } }]);
  assert.equal(send.reversible, false);
  assert.equal(send.thirdPartyImpact, true);

  const pay = deriveRiskFromSteps([{ tool: "wallet.purchase", args: { amount: 9.9 } }]);
  assert.equal(pay.reversible, false);
  assert.equal(pay.financialImpact, "high");

  const health = deriveRiskFromSteps([{ tool: "health.query", args: {} }]);
  assert.equal(health.dataSensitivity, "personal");
});

test("deriveRiskFromSteps: postpone 可逆（post 正则不误伤）；run_shell/kill 不可逆且不误伤 skill", () => {
  const postpone = deriveRiskFromSteps([{ tool: "calendar.postpone", args: { eventId: "e1" } }]);
  assert.equal(postpone.reversible, true, "postpone 是可逆操作");

  const shell = deriveRiskFromSteps([{ tool: "run_shell", args: { cmd: "ls" } }]);
  assert.equal(shell.reversible, false, "黑名单级工具必须先问（否则静默执行被拦后无声无息）");

  const skill = deriveRiskFromSteps([{ tool: "skill.invoke", args: { name: "travel" } }]);
  assert.equal(skill.reversible, true, "skill 不应被 \\bkill 误伤");
});

// ─── 通知/行动默认价值维度 ───

test("deriveNotifyValue: medium 及以上净效用非负，low 为负（→ silenced）", () => {
  const low = deriveNotifyValue("low");
  assert.ok(low.expectedValue - low.interruptionCost < 0, "low 应被沉默");
  for (const imp of ["critical", "high", "medium"] as const) {
    const v = deriveNotifyValue(imp);
    assert.ok(v.expectedValue - v.interruptionCost >= 0, `${imp} 净效用非负`);
  }
});

test("deriveActValue: 后台静默执行打扰成本低于通知基线", () => {
  const act = deriveActValue("high");
  const notify = deriveNotifyValue("high");
  assert.ok(act.interruptionCost < notify.interruptionCost);
  // 可逆+隐式授权+high → execute_silently
  const r = evaluateActionUtility({ kind: "k", risk: SAFE_RISK, authorization: "implicit", value: act });
  assert.equal(r.branch, "execute_silently");
});
