// ProactivityHub LLM 通用路径测试：
// 默认关闭回归（PROACTIVITY_LLM_INITIATIVE 未设 → 零 LLM 调用，2026-09-23 用户拍板：
// token 账本实测通用路径纯烧钱零投递，默认翻回关）+ 显式开启后的评估/频控/缓存/去抖行为。
// 与 proactivity-hub.test.ts 分文件运行（node:test 每文件独立进程，env 互不串扰）。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { LlmCompleteFn } from "../src/proactivity/initiative-engine.js";
import { resetExemplars } from "../src/proactivity/semantic-trigger-matcher.js";

delete process.env.PROACTIVITY_LLM_INITIATIVE;

beforeEach(() => resetExemplars());

const ACTOR = "actor-llm-lane";

type PublishedSignal = { actorId: string; kind: string; importance: string };

function makeDeps(overrides?: {
  llmComplete?: LlmCompleteFn;
  frequencyGovernor?: FrequencyGovernor;
  suppressionStore?: {
    isSuppressed: (actorId: string, kind: string, text?: string) => { suppressed: boolean; reason: string };
  };
}) {
  const signals: PublishedSignal[] = [];
  const deps = {
    publishSignal: (s: PublishedSignal) => {
      signals.push(s);
    },
    executeTool: async () => ({ ok: true, result: {} }),
    getLastInteractionAt: () => Date.now(),
    llmComplete: overrides?.llmComplete,
    // 默认禁用静默时段（避免 23-7 点跑测试随机失败）；预算耗尽用例单独注入 dailyBudget=0
    frequencyGovernor:
      overrides?.frequencyGovernor ??
      new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true }),
    ...(overrides?.suppressionStore ? { suppressionStore: overrides.suppressionStore } : {}),
  };
  return { deps, signals };
}

/** speak 决策 JSON（LLM mock 的标准返回） */
function speakDecision(): string {
  return JSON.stringify({
    mode: "speak",
    kind: "care",
    importance: "medium",
    rationale: "用户连续熬夜，值得关怀一句",
    messageHint: "注意休息，别硬撑",
    actions: [],
  });
}

test("默认关闭：未设 PROACTIVITY_LLM_INITIATIVE 时通用路径零 LLM 调用", async () => {
  delete process.env.PROACTIVITY_LLM_INITIATIVE; // 用例内设置：顶层赋值会在模块加载时污染全部用例
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");

  await hub.onTick(ACTOR, new Date());

  assert.equal(llmCalls, 0, "默认关闭状态下不应调 LLM 评估（零 token）");
  assert.equal(signals.length, 0, "通用路径关闭时不应有 LLM 来源信号");
  assert.ok(hub.getFeed().pendingCount(ACTOR) > 0, "观察保留在窗口，开启后可消费");
});

// ── 以下：显式开启（PROACTIVITY_LLM_INITIATIVE=1）后的通用路径行为 ──

test("显式开启：通用路径真实生效", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");

  await hub.onTick(ACTOR, new Date());

  assert.equal(llmCalls, 1, "开启状态下应调用 LLM 评估");
  assert.equal(signals.length, 1, "speak 决策应发布主动信号");
});

test("预算耗尽：评估照常（预算与评估解耦），发送由频控拦截", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const governor = new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true, dailyBudget: 0 });
  const { deps, signals } = makeDeps({ llmComplete, frequencyGovernor: governor });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");

  await hub.onTick(ACTOR, new Date());

  assert.equal(llmCalls, 1, "预算只约束发送，不拦评估（agent 保持有想法，表达被节制）");
  assert.equal(signals.length, 0, "预算耗尽时 speak 决策应被频控拦截，不发布信号");
  assert.equal(hub.getFeed().pendingCount(ACTOR), 0, "观察已被消费（评估真实发生）");
});

test("LLM 决策被负反馈抑制拦截后，同指纹窗口重复到达不再调 LLM", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({
    llmComplete,
    suppressionStore: {
      isSuppressed: () => ({ suppressed: true, reason: "用户明确说过别再提加班话题" }),
    },
  });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 0, "抑制命中不应发布信号");

  // 同内容观察再次到达 → 同指纹 → 负向缓存命中，跳过 LLM
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1, "同指纹窗口命中负向缓存，不应重复调 LLM");
});

test("LLM 决策被分 kind 冷却拦截后记入负向缓存（同类窗口不白调 LLM）", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);

  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 1, "首次 care 决策应放行发布");

  // 同内容观察再次到达 → LLM 再判 care → 分 kind 冷却拦截（care 8h）→ 记入负向缓存
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 2, "冷却期内同指纹窗口仍会调 LLM 一次（拦截前无法预知 kind）");
  assert.equal(signals.length, 1, "冷却拦截不应新增信号");

  // 第三次到达 → 负向缓存命中，跳过 LLM
  hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 2, "拦截已入缓存，同指纹窗口不应再调 LLM");
});

test("对话后去抖评估：observeConversationTurn 触发通用路径（不必等周期 tick）", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  process.env.PROACTIVITY_INITIATIVE_DEBOUNCE_MS = "10";
  try {
    let llmCalls = 0;
    const llmComplete: LlmCompleteFn = async () => {
      llmCalls += 1;
      return speakDecision();
    };
    const { deps, signals } = makeDeps({ llmComplete });
    const hub = new ProactivityHub(deps);

    hub.observeConversationTurn(ACTOR, "今天聊了很多工作的事，有点累");
    // L0 分诊：补一条 medium 观察，让去抖评估的窗口可进 LLM
    hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
    // 去抖 10ms 后应触发评估（连续对话轮会重置定时器，这里单轮即可）
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(llmCalls >= 1, "对话结束后应触发去抖评估");
    assert.equal(hub.getFeed().pendingCount(ACTOR), 0, "评估应消费感知流窗口");
  } finally {
    delete process.env.PROACTIVITY_INITIATIVE_DEBOUNCE_MS;
  }
});

test("对话后去抖评估：连续对话轮重置定时器（等用户停下才评估）", async () => {
  process.env.PROACTIVITY_LLM_INITIATIVE = "1";
  process.env.PROACTIVITY_INITIATIVE_DEBOUNCE_MS = "50";
  try {
    let llmCalls = 0;
    const llmComplete: LlmCompleteFn = async () => {
      llmCalls += 1;
      return speakDecision();
    };
    const { deps } = makeDeps({ llmComplete });
    const hub = new ProactivityHub(deps);

    hub.observeConversationTurn(ACTOR, "第一句");
    await new Promise((r) => setTimeout(r, 20));
    hub.observeConversationTurn(ACTOR, "第二句（应重置去抖定时器）");
    // L0 分诊：补一条 medium 观察，让去抖评估的窗口可进 LLM
    hub.getFeed().pushObservation(ACTOR, "schedule_snapshot", "今日日程：15:00 例会", "medium");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(llmCalls, 0, "去抖窗口内的新对话轮应重置定时器，未到时间不评估");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(llmCalls, 1, "用户停下后（最后一次对话 + 去抖时长）评估恰好一次");
  } finally {
    delete process.env.PROACTIVITY_INITIATIVE_DEBOUNCE_MS;
  }
});
