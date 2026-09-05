// ProactivityHub 通用路径「默认开启」回归测试：
// PROACTIVITY_LLM_INITIATIVE 默认翻为 1（2026-09-05），本文件不设该 env，
// 断言默认状态下 LLM 通用路径真实生效、预算耗尽前置短路、拦截后负向缓存。
// 与 proactivity-hub.test.ts 分文件运行（node:test 每文件独立进程，env 互不串扰）。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { LlmCompleteFn } from "../src/proactivity/initiative-engine.js";
import { resetExemplars } from "../src/proactivity/semantic-trigger-matcher.js";

delete process.env.PROACTIVITY_LLM_INITIATIVE;

beforeEach(() => resetExemplars());

const ACTOR = "actor-default-on";

type PublishedSignal = { actorId: string; kind: string; importance: string };

/** 决策缓存与抑制都是词法指纹级：同内容观察 → 同指纹 */
const OBS_TEXT = "用户说：最近项目加班到半夜，有点撑不住";

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
    getLastInteractionAt: () => Date.now(), // 刚交互过：不触发问候快路径，直通通用路径
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

test("默认开启：未设 PROACTIVITY_LLM_INITIATIVE 时通用路径仍生效", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");

  await hub.onTick(ACTOR, new Date());

  assert.equal(llmCalls, 1, "默认开启状态下应调用 LLM 评估");
  assert.equal(signals.length, 1, "speak 决策应发布主动信号");
  assert.equal(signals[0].kind, "care");
});

test("预算耗尽：跳过 LLM 评估且观察流不被消费（预算重置后仍可评估）", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const governor = new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true, dailyBudget: 0 });
  const { deps } = makeDeps({ llmComplete, frequencyGovernor: governor });
  const hub = new ProactivityHub(deps);
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");

  await hub.onTick(ACTOR, new Date());

  assert.equal(llmCalls, 0, "预算耗尽时不应白调 LLM");
  assert.equal(hub.getFeed().pendingCount(ACTOR), 1, "观察不应被消费，留待预算重置后评估");
});

test("LLM 决策被负反馈抑制拦截后，同指纹窗口重复到达不再调 LLM", async () => {
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
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 0, "抑制命中不应发布信号");

  // 同内容观察再次到达 → 同指纹 → 负向缓存命中，跳过 LLM
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1, "同指纹窗口命中负向缓存，不应重复调 LLM");
});

test("LLM 决策被分 kind 冷却拦截后记入负向缓存（同类窗口不白调 LLM）", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return speakDecision();
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);

  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 1, "首次 care 决策应放行发布");

  // 同内容观察再次到达 → LLM 再判 care → 分 kind 冷却拦截（care 8h）→ 记入负向缓存
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 2, "冷却期内同指纹窗口仍会调 LLM 一次（拦截前无法预知 kind）");
  assert.equal(signals.length, 1, "冷却拦截不应新增信号");

  // 第三次到达 → 负向缓存命中，跳过 LLM
  hub.getFeed().pushObservation(ACTOR, "conversation_turn", OBS_TEXT, "low");
  await hub.onTick(ACTOR, new Date());
  assert.equal(llmCalls, 2, "拦截已入缓存，同指纹窗口不应再调 LLM");
});
