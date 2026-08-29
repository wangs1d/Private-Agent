/**
 * BrainStem（脑干）+ Cerebellum（小脑）单元测试。
 *
 * 脑干：持续感知节律——心跳扫描察觉 sustained_busy / late_night / 趋势翻转，
 *       合成 LifeSignal 回流 hub，30min 同 kind 重复抑制。
 * 小脑：时序协调——defer 队列 / 打断抑制 / 犹豫期复查 / reaper 超时降级。
 *
 * 不调 LLM，纯规则 + 定时器逻辑验证。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BrainStem } from "../src/brain/brain-stem.js";
import { Cerebellum } from "../src/brain/cerebellum.js";
import type {
  BrainDecision,
  BrainSignalInput,
  UserActivityState,
} from "../src/brain/types.js";
import type {
  LifeSignal,
  LifeSignalEvidenceWindow,
} from "../src/services/life-signal-types.js";

// ---- helpers ------------------------------------------------------------

function makeActivity(
  activity: UserActivityState["activity"],
  overrides: Partial<UserActivityState> = {},
): UserActivityState {
  return {
    actorId: "test-user",
    activity,
    confidence: 0.9,
    evidence: [],
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<BrainSignalInput> = {}): BrainSignalInput {
  return {
    actorId: "test-user",
    kind: "transaction_completed",
    title: "测试信号",
    importance: "medium",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<BrainDecision> = {}): BrainDecision {
  return {
    actorId: "test-user",
    outcome: "speak",
    valueScore: 8,
    disturbScore: 3,
    rationale: "测试决策",
    decidedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeLifeSignal(overrides: Partial<LifeSignal> = {}): LifeSignal {
  return {
    id: `sig-${Date.now()}-${Math.random()}`,
    actorId: "test-user",
    source: "desktop",
    kind: "desktop_active",
    title: "桌面活动",
    summary: "",
    tags: [],
    importance: "medium",
    evidence: [],
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 最小化 hub mock：记录 publish 的合成信号 + 返回 recentSignals/evidenceWindow */
function makeHubMock(opts: {
  recent?: LifeSignal[];
  evidenceWindow?: Partial<LifeSignalEvidenceWindow>;
} = {}) {
  const published: LifeSignal[] = [];
  const subscribers: Array<(s: LifeSignal) => void> = [];
  return {
    published,
    subscribe: (fn: (s: LifeSignal) => void) => {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    recentSignals: (_actorId: string, _limit?: number) => opts.recent ?? [],
    getEvidenceWindow: (_actorId: string): LifeSignalEvidenceWindow => ({
      actorId: "test-user",
      windowMs: 60_000,
      totalSignals: opts.evidenceWindow?.totalSignals ?? 0,
      recentSignals: opts.evidenceWindow?.recentSignals ?? [],
      trend: opts.evidenceWindow?.trend ?? "stable",
      directionScore: opts.evidenceWindow?.directionScore ?? 0,
      slopeScore: opts.evidenceWindow?.slopeScore ?? 0,
      turningPoints: opts.evidenceWindow?.turningPoints ?? 0,
      reversalDirection: opts.evidenceWindow?.reversalDirection ?? null,
      topicCounts: {},
      tagCounts: {},
      signalKinds: {},
    }),
    publish: (s: LifeSignal) => {
      published.push(s);
      for (const fn of subscribers) fn(s);
    },
  };
}

/** 最小化 awareness mock：返回固定活动状态 */
function makeAwarenessMock(activity: UserActivityState | null) {
  return {
    observe: (_actorId: string) => activity,
  };
}

/** 等待 ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 临时设置 BRAIN_STEM_SUSTAINED_BUSY_MS（脑干运行时读取，可在 sweep 前动态调整）。
 * 设为 0 时：busySince 记录后 now-since=0>=0 立即满足，模拟"已持续超过阈值"。
 */
async function withSustainedBusyMs<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BRAIN_STEM_SUSTAINED_BUSY_MS;
  process.env.BRAIN_STEM_SUSTAINED_BUSY_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.BRAIN_STEM_SUSTAINED_BUSY_MS;
    else process.env.BRAIN_STEM_SUSTAINED_BUSY_MS = prev;
  }
}

// ========================================================================
// BrainStem（脑干）
// ========================================================================

test("BrainStem: 订阅 hub 后累积已知 actor", async () => {
  const hub = makeHubMock();
  const stem = new BrainStem();
  stem.registerLifeSignalHub(hub);
  stem.registerAwareness(makeAwarenessMock(null));
  await stem.start();

  hub.publish(makeLifeSignal({ actorId: "user-A" }));
  hub.publish(makeLifeSignal({ actorId: "user-B" }));

  await sleep(5);
  const snap = stem.snapshot();
  assert.equal(snap.activeActors, 2, "应累积 2 个已知 actor");
  await stem.stop();
});

test("BrainStem: sustained_busy——持续 busy >90min 触发合成信号", async () => {
  // 脑干自己维护 busySince（第一次扫到 busy 记录 now），不依赖信号时间。
  // 设阈值为 0：busySince 记录后 now-since=0>=0 立即满足，模拟"已持续超过 90min"。
  await withSustainedBusyMs(0, async () => {
    const hub = makeHubMock({ recent: [makeLifeSignal()] });
    const stem = new BrainStem();
    stem.registerLifeSignalHub(hub);
    stem.registerAwareness(makeAwarenessMock(makeActivity("busy")));
    await stem.start();

    // 先 publish 一条信号让 actor 进入 knownActors
    hub.publish(makeLifeSignal());
    await sleep(5);

    // 手动触发一次扫描（不等 45s 心跳）
    await stem.sweepOnce();

    const synth = hub.published.find((s) => s.kind === "sustained_busy");
    assert.ok(synth, "应发出 sustained_busy 合成信号");
    assert.equal(synth!.source, "agent_inference");
    assert.equal(synth!.importance, "medium");
    await stem.stop();
  });
});

test("BrainStem: sustained_busy 未达阈值不触发", async () => {
  // 10 分钟前的信号——busy 持续时间不足 90min
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const hub = makeHubMock({
    recent: [makeLifeSignal({ occurredAt: tenMinAgo })],
  });
  const stem = new BrainStem();
  stem.registerLifeSignalHub(hub);
  stem.registerAwareness(makeAwarenessMock(makeActivity("busy")));
  await stem.start();

  // 先 publish 一条信号让 actor 进入 knownActors
  hub.publish(makeLifeSignal({ occurredAt: tenMinAgo }));
  await sleep(5);

  await stem.sweepOnce();
  // published 包含初始 publish 的 1 条，合成信号应为 0
  const synthCount = hub.published.filter(
    (s) => s.source === "agent_inference",
  ).length;
  assert.equal(synthCount, 0, "未达 90min 阈值不应发合成信号");
  await stem.stop();
});

test("BrainStem: 趋势翻转——evidenceWindow 有 turningPoints 时发 trend_reversal", async () => {
  const hub = makeHubMock({
    recent: [makeLifeSignal()],
    evidenceWindow: {
      turningPoints: 3,
      reversalDirection: "downward",
      slopeScore: -0.5,
    },
  });
  const stem = new BrainStem();
  stem.registerLifeSignalHub(hub);
  stem.registerAwareness(makeAwarenessMock(null));
  await stem.start();

  // 先 publish 一条信号让 actor 进入 knownActors
  hub.publish(makeLifeSignal());
  await sleep(5);

  await stem.sweepOnce();
  const synth = hub.published.find((s) => s.kind === "trend_reversal_downward");
  assert.ok(synth, "应发出 trend_reversal_downward 信号");
  assert.equal(synth!.importance, "high");
  await stem.stop();
});

test("BrainStem: 重复抑制——同 kind 30min 内不重复发", async () => {
  const hub = makeHubMock({
    recent: [makeLifeSignal()],
    evidenceWindow: { turningPoints: 2, reversalDirection: "upward" },
  });
  const stem = new BrainStem();
  stem.registerLifeSignalHub(hub);
  stem.registerAwareness(makeAwarenessMock(null));
  await stem.start();

  // 先 publish 一条信号让 actor 进入 knownActors
  hub.publish(makeLifeSignal());
  await sleep(5);

  await stem.sweepOnce();
  await stem.sweepOnce(); // 立即再扫一次
  await stem.sweepOnce();

  const reversalCount = hub.published.filter(
    (s) => s.kind === "trend_reversal_upward",
  ).length;
  assert.equal(reversalCount, 1, "同 kind 30min 内只发一次");
  assert.equal(stem.snapshot().syntheticSignalsEmitted, 1);
  await stem.stop();
});

test("BrainStem: 无信号 actor 不触发任何合成", async () => {
  const hub = makeHubMock({ recent: [] });
  const stem = new BrainStem();
  stem.registerLifeSignalHub(hub);
  stem.registerAwareness(makeAwarenessMock(null));
  await stem.start();

  // 先 publish 一条信号让 actor 进入 knownActors
  hub.publish(makeLifeSignal({ actorId: "empty-user" }));
  await sleep(5);

  await stem.sweepOnce();
  assert.equal(hub.published.length, 1, "只有初始 publish 的 1 条，无合成信号");
  await stem.stop();
});

// ========================================================================
// Cerebellum（小脑）
// ========================================================================

test("Cerebellum: 用户 idle 时立即执行（带犹豫延迟）", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("idle")));
  await cerebellum.start();

  let fired = false;
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_immediate" }),
    async () => {
      fired = true;
    },
  );
  // Step 5 动态犹豫期：medium importance 范围 1.5-3.5s，需覆盖上限 + 缓冲
  await sleep(3700);
  assert.equal(fired, true, "idle 状态应在犹豫后执行");
  await cerebellum.stop();
});

test("Cerebellum: 用户 busy 时 defer 不立即执行", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("busy")));
  await cerebellum.start();

  let fired = false;
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_busy_defer" }),
    async () => {
      fired = true;
    },
  );
  await sleep(2700);
  assert.equal(fired, false, "busy 状态应 defer，不执行");
  assert.equal(cerebellum.snapshot().pendingCount, 1, "应有 1 个 defer 待复查");
  await cerebellum.stop();
});

test("Cerebellum: 用户 sleeping 时 defer 不立即执行", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("sleeping")));
  await cerebellum.start();

  let fired = false;
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_sleep_defer" }),
    async () => {
      fired = true;
    },
  );
  await sleep(2700);
  assert.equal(fired, false, "sleeping 状态应 defer");
  await cerebellum.stop();
});

test("Cerebellum: interrupt 清空 defer 队列 + 设抑制窗口", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("busy")));
  await cerebellum.start();

  let fired = false;
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_interrupt" }),
    async () => {
      fired = true;
    },
  );
  assert.equal(cerebellum.snapshot().pendingCount, 1, "defer 入队");

  // 用户开口打断
  cerebellum.interrupt("test-user");
  const snap = cerebellum.snapshot();
  assert.equal(snap.pendingCount, 0, "打断后 defer 队列清空");
  assert.equal(snap.interruptedCount, 1, "打断计数 +1");
  assert.ok(snap.lastInterruptAt, "记录打断时间");
  await cerebellum.stop();
});

test("Cerebellum: 抑制窗口内新决策直接 defer（不抢话）", async () => {
  const cerebellum = new Cerebellum();
  // 用户 idle（本应立即执行），但抑制窗口会拦截
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("idle")));
  await cerebellum.start();

  // 先触发一次打断，设 60s 抑制窗口
  cerebellum.interrupt("test-user");

  let fired = false;
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_suppress" }),
    async () => {
      fired = true;
    },
  );
  await sleep(2700);
  assert.equal(fired, false, "抑制窗口内应 defer，不执行");
  assert.equal(cerebellum.snapshot().pendingCount, 1, "进入 defer 队列");
  await cerebellum.stop();
});

test("Cerebellum: 犹豫期内被打断则取消执行", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("idle")));
  await cerebellum.start();

  let fired = false;
  // schedule 立即执行分支会 setTimeout 0.8-2.5s，期间打断应取消
  const schedulePromise = cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_hesitate_cancel" }),
    async () => {
      fired = true;
    },
  );
  // 立即打断（在犹豫期内）
  await schedulePromise;
  cerebellum.interrupt("test-user");

  await sleep(2700);
  assert.equal(fired, false, "犹豫期内被打断应取消执行");
  await cerebellum.stop();
});

test("Cerebellum: clearPending 清空指定 actor 的 defer 队列", async () => {
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("busy")));
  await cerebellum.start();

  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_clear" }),
    async () => {},
  );
  await cerebellum.schedule(
    makeDecision(),
    makeSignal({ kind: "test_clear_2" }),
    async () => {},
  );
  assert.equal(cerebellum.snapshot().pendingCount, 2);

  cerebellum.clearPending("test-user");
  assert.equal(cerebellum.snapshot().pendingCount, 0, "clearPending 后队列空");
  await cerebellum.stop();
});

// ========================================================================
// BrainCenter 集成（scheduleProactive 降级 + interruptProactive 代理）
// ========================================================================

test("BrainCenter.scheduleProactive: 小脑未注册时直接 fire（降级）", async () => {
  // 直接用 BrainCenter（不注册 cerebellum）验证降级路径
  const { BrainCenter } = await import("../src/brain/brain-center.js");
  const bc = new BrainCenter();

  let fired = false;
  await bc.scheduleProactive(
    makeDecision(),
    makeSignal({ kind: "test_degrade" }),
    async () => {
      fired = true;
    },
  );
  assert.equal(fired, true, "小脑未注册时应直接 fire，不 defer");
});

test("BrainCenter.interruptProactive: 小脑未注册时空操作（不报错）", async () => {
  const { BrainCenter } = await import("../src/brain/brain-center.js");
  const bc = new BrainCenter();
  // 不应抛错
  bc.interruptProactive("test-user");
  assert.ok(true, "小脑未注册时 interruptProactive 空操作正常");
});

test("BrainCenter.scheduleProactive + 注册小脑: 走 cerebellum.schedule", async () => {
  const { BrainCenter } = await import("../src/brain/brain-center.js");
  const bc = new BrainCenter();
  const cerebellum = new Cerebellum();
  cerebellum.registerAwareness(makeAwarenessMock(makeActivity("busy")));
  bc.registerCerebellum(cerebellum);

  let fired = false;
  await bc.scheduleProactive(
    makeDecision(),
    makeSignal({ kind: "test_via_cerebellum" }),
    async () => {
      fired = true;
    },
  );
  // busy → defer，不应执行
  await sleep(2700);
  assert.equal(fired, false, "通过 BrainCenter 调用应走小脑 defer 逻辑");
  assert.equal(cerebellum.snapshot().pendingCount, 1);
});

// ========================================================================
// 闭环场景：脑干合成信号 → 小脑 defer（模拟"自己察觉但用户忙"）
// ========================================================================

test("闭环: 脑干察觉 sustained_busy → 合成信号回流 → 可被小脑 defer", async () => {
  await withSustainedBusyMs(0, async () => {
    const hub = makeHubMock({ recent: [makeLifeSignal()] });
    const stem = new BrainStem();
    stem.registerLifeSignalHub(hub);
    stem.registerAwareness(makeAwarenessMock(makeActivity("busy")));
    await stem.start();

    // 先 publish 一条信号让 actor 进入 knownActors
    hub.publish(makeLifeSignal());
    await sleep(5);

    await stem.sweepOnce();

    const synth = hub.published.find((s) => s.kind === "sustained_busy");
    assert.ok(synth, "脑干应察觉 sustained_busy");

    // 假设这个合成信号经过 ProactionCortex.decide 后 outcome=speak，
    // 交给小脑调度——用户仍 busy，应 defer 不立即打扰
    const cerebellum = new Cerebellum();
    cerebellum.registerAwareness(makeAwarenessMock(makeActivity("busy")));
    await cerebellum.start();

    let fired = false;
    await cerebellum.schedule(
      makeDecision({ rationale: "sustained_busy 提醒" }),
      makeSignal({
        kind: "sustained_busy",
        title: synth!.title,
        importance: "medium",
      }),
      async () => {
        fired = true;
      },
    );
    await sleep(2700);
    assert.equal(fired, false, "用户 busy，小脑应 defer 不打扰");
    assert.equal(cerebellum.snapshot().pendingCount, 1, "进 defer 队列等 reaper 复查");

    await stem.stop();
    await cerebellum.stop();
  });
});
