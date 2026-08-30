// 统一主动性管道单测：仲裁规则 / 在场 / 提案队列 / 管道端到端 / 频控持久化与自适应 / 临近日程扫描
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { arbitrate, nextQuietEnd, type ArbiterContext } from "../src/proactivity/arbiter.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProposalStore } from "../src/proactivity/proposal-store.js";
import { UpcomingScheduleWatcher } from "../src/proactivity/upcoming-schedule-watcher.js";
import type { ScheduleTaskRecord } from "../src/services/schedule-task-service.js";

// 固定本地时钟：正午（非静默时段）
const NOON = new Date(2026, 7, 30, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 7, 30, 23, 30, 0).getTime();

function proposal(overrides: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p_test",
    actorId: "user-a",
    kind: "schedule_upcoming",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "评审",
    summary: "马上评审",
    evidence: ["evidence-1"],
    directText: "15分钟后评审",
    createdAt: NOON,
    source: "test",
    ...overrides,
  };
}

function ctx(overrides: Partial<ArbiterContext> = {}): ArbiterContext {
  return {
    now: NOON,
    presence: "active",
    inConversation: false,
    isSuppressed: () => ({ suppressed: false, reason: "" }),
    socialCanTrigger: () => ({ allowed: true, reason: "ok" }),
    ...overrides,
  };
}

function task(overrides: Partial<ScheduleTaskRecord>): ScheduleTaskRecord {
  return {
    taskId: "t1",
    sessionId: "s1",
    description: "项目评审",
    kind: "reminder",
    recurrence: "none",
    timezone: "Asia/Shanghai",
    runAt: new Date(NOON + 10 * 60_000).toISOString(),
    nextRunAt: new Date(NOON + 10 * 60_000).toISOString(),
    status: "active",
    createdAt: new Date(NOON).toISOString(),
    updatedAt: new Date(NOON).toISOString(),
    ...overrides,
  };
}

// ─── 仲裁规则 ───

test("arbiter: 过期提案作废", () => {
  const d = arbitrate(proposal({ expiresAt: NOON - 1 }), ctx());
  assert.equal(d.verdict, "expired");
});

test("arbiter: 负反馈抑制优先", () => {
  const d = arbitrate(proposal(), ctx({ isSuppressed: () => ({ suppressed: true, reason: "user said stop" }) }));
  assert.equal(d.verdict, "suppressed");
});

test("arbiter: 静默时段非 critical defer 到早晨而非丢弃", () => {
  const d = arbitrate(proposal(), ctx({ now: NIGHT }));
  assert.equal(d.verdict, "deferred");
  assert.equal(d.reasonChain[0], "quiet_hours_defer_to_morning");
  assert.equal(d.deliverAfter, nextQuietEnd(new Date(NIGHT)));
});

test("arbiter: 静默时段 critical 立即投递", () => {
  const d = arbitrate(proposal({ importance: "critical" }), ctx({ now: NIGHT }));
  assert.equal(d.verdict, "delivered");
});

test("arbiter: must 层绕过社交预算（预算耗尽仍可达）", () => {
  let queried = false;
  const d = arbitrate(proposal({ tier: "must" }), ctx({
    socialCanTrigger: () => {
      queried = true;
      return { allowed: false, reason: "daily_budget_exhausted(6/6)" };
    },
  }));
  assert.equal(d.verdict, "delivered");
  assert.ok(!queried, "must 层不应查询社交预算");
});

test("arbiter: social 层预算耗尽被节流", () => {
  const d = arbitrate(proposal({ tier: "social" }), ctx({
    socialCanTrigger: () => ({ allowed: false, reason: "daily_budget_exhausted(6/6)" }),
  }));
  assert.equal(d.verdict, "throttled");
  assert.ok(d.reasonChain[0].startsWith("frequency_governor:"));
});

test("arbiter: 用户离线 social 提案挂起待重连", () => {
  const d = arbitrate(proposal({ tier: "social", importance: "medium" }), ctx({ presence: "offline" }));
  assert.equal(d.verdict, "deferred");
  assert.ok(d.reasonChain.includes("offline_wait_reconnect"));
});

test("arbiter: must 层离线照发（投递层换通道必达）", () => {
  const d = arbitrate(proposal({ tier: "must" }), ctx({ presence: "offline" }));
  assert.equal(d.verdict, "delivered");
  assert.ok(d.reasonChain.includes("deliver_now"));
});

test("arbiter: 对话中不打断非 interruptible 提案（短延迟 90s）", () => {
  const d = arbitrate(proposal({ tier: "social", interruptible: false }), ctx({ inConversation: true }));
  assert.equal(d.verdict, "deferred");
  assert.equal(d.deliverAfter, NOON + 90_000);
});

test("arbiter: critical 在对话中默认允许打断", () => {
  const d = arbitrate(proposal({ importance: "critical", tier: "social" }), ctx({ inConversation: true }));
  assert.equal(d.verdict, "delivered");
});

// ─── 在场判定 ───

test("presence: active/idle/offline 三态", () => {
  const presence = new PresenceService();
  assert.equal(presence.getPresence("u"), "offline");
  presence.markConnected("u", NOON - 1000);
  assert.equal(presence.getPresence("u", NOON), "active");
  presence.markConnected("u", NOON - 11 * 60_000);
  assert.equal(presence.getPresence("u", NOON), "idle");
  presence.markDisconnected("u");
  assert.equal(presence.getPresence("u", NOON), "offline");
});

// ─── 提案队列 ───

test("proposal-store: 同 dedupKey 合并保留最新且 deliverAfter 取更晚", () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
  try {
    const path = join(dir, "proposals.json");
    const store = new ProposalStore(path);
    assert.equal(store.enqueue(proposal({ dedupKey: "k", deliverAfter: NOON })), true);
    assert.equal(store.enqueue(proposal({ dedupKey: "k", title: "新内容" })), false);
    assert.equal(store.listPending().length, 1);
    assert.equal(store.listPending()[0].title, "新内容");
    assert.equal(store.listPending()[0].deliverAfter, NOON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal-store: 落盘重启恢复待发区", () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
  try {
    const path = join(dir, "proposals.json");
    const store = new ProposalStore(path);
    store.enqueue(proposal({ dedupKey: "kp" }));
    store.logDecision({ proposal: proposal(), verdict: "deferred", reasonChain: ["r1"] });
    store.flush();
    const restored = new ProposalStore(path);
    assert.equal(restored.listPending().length, 1);
    assert.equal(restored.recentDecisions()[0].reasonChain[0], "r1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 管道端到端 ───

type Harness = {
  pipeline: ProactivePipeline;
  presence: PresenceService;
  governor: FrequencyGovernor;
  delivered: Array<{ actorId: string; json: string }>;
  offlineStored: Array<{ actorId: string; text: string }>;
  spoken: ProactiveProposal[];
  dir: string;
};

function makeHarness(opts: { now?: number; dailyBudget?: number; failSend?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "proactive-pipe-"));
  const presence = new PresenceService();
  const governor = new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true, dailyBudget: opts.dailyBudget ?? 6 });
  const delivered: Array<{ actorId: string; json: string }> = [];
  const offlineStored: Array<{ actorId: string; text: string }> = [];
  const spoken: ProactiveProposal[] = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor,
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        if (opts.failSend) return false;
        delivered.push({ actorId, json });
        return true;
      },
      offlineStore: {
        createOutbound: async (input) => {
          offlineStored.push({ actorId: input.actorId, text: input.text });
          return {};
        },
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    speak: (p) => spoken.push(p),
    nowFn: () => opts.now ?? NOON,
  });
  return { pipeline, presence, governor, delivered, offlineStored, spoken, dir };
}

test("pipeline: 在线 directText 零 LLM 直投 + outcome 记录", async () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000); // active 但非对话中
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
    assert.equal(h.spoken.length, 0, "directText 提案不调 LLM");
    const payload = JSON.parse(h.delivered[0].json);
    assert.equal(payload.type, "agent.proactive_message");
    assert.ok(payload.payload.deliveryId);
    assert.equal(payload.payload.importance, "high");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pipeline.diagnostics().recentOutcomes.at(-1)?.outcome, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 无 directText 提案走 speak 闭环（唯一 LLM 点）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal({ directText: undefined, tier: "social", kind: "greeting" }));
    assert.equal(h.spoken.length, 1);
    assert.equal(h.delivered.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 同 dedupKey 二次提交合并（待发区内 + 已投递窗口内都防重）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal());
    // 已投递后短窗口内重提交（如 watcher 重启重扫同一会议）→ 合并
    const again = h.pipeline.submitProposal(proposal({ title: "重复" }));
    assert.equal(again.verdict, "merged");
    assert.equal(h.delivered.length, 1);
    // 挂起中的提案同键重提交 → 合并
    h.presence.markDisconnected("user-a");
    h.pipeline.submitProposal(proposal({ dedupKey: "k-pending", tier: "social", importance: "medium" }));
    const dupPending = h.pipeline.submitProposal(proposal({ dedupKey: "k-pending", tier: "social", importance: "medium" }));
    assert.equal(dupPending.verdict, "merged");
    assert.equal(h.pipeline.diagnostics().pending.length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 离线 social 提案挂起 → 重连 flush 后经 MessageHub 离线必达", async () => {
  const h = makeHarness({ failSend: true });
  try {
    const d1 = h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium" }));
    assert.equal(d1.verdict, "deferred");
    assert.equal(h.pipeline.diagnostics().pending.length, 1);
    // 重连（idle：11 分钟前标记，非对话中）→ flush 重仲裁 → WS 失败 → MessageHub 落库
    h.presence.markConnected("user-a", NOON - 11 * 60_000);
    h.pipeline.flushDue(NOON);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.offlineStored.length, 1, "离线应落 MessageHub");
    assert.equal(h.pipeline.diagnostics().pending.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 对话中提案延迟 90s 后自动投递", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON); // 刚活跃 = 对话中
    const d = h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", interruptible: false }));
    assert.equal(d.verdict, "deferred");
    assert.equal(h.delivered.length, 0);
    h.pipeline.flushDue(NOON + 90_001);
    assert.equal(h.delivered.length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: social 层预算耗尽节流（governor 共享口径）", () => {
  const h = makeHarness({ dailyBudget: 1 });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const first = h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s1" }));
    assert.equal(first.verdict, "delivered");
    const second = h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s2" }));
    assert.equal(second.verdict, "throttled");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: must 层不占社交预算（预算耗尽仍投递）", () => {
  const h = makeHarness({ dailyBudget: 1 });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s1" }));
    const must = h.pipeline.submitProposal(proposal({ tier: "must", dedupKey: "m1" }));
    assert.equal(must.verdict, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 连续忽略 → 自适应冷却上升（分寸感回灌）", async () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    for (let i = 0; i < 5; i++) {
      h.pipeline.submitProposal(proposal({ tier: "social", kind: "followup", dedupKey: `f${i}` }));
    }
    const before = h.governor.snapshot().cooldowns.followup;
    const ids = h.pipeline.diagnostics().recentOutcomes.map((o) => o.deliveryId);
    for (const id of ids) h.pipeline.recordOutcome(id, "ignored");
    const after = h.governor.snapshot().cooldowns.followup;
    assert.ok(after > before, `忽略 5 次后冷却应上升 ${before} -> ${after}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: unknown deliveryId 的 outcome 返回 false", () => {
  const h = makeHarness();
  try {
    assert.equal(h.pipeline.recordOutcome("nope", "accepted"), false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 频控持久化 ───

test("governor: 快照恢复（重启不重置预算与冷却）", () => {
  const g1 = new FrequencyGovernor({ ignoreEnv: true });
  g1.record("u", "care", new Date(NOON - 60_000));
  g1.noteOutcome("care", false);
  const snap = g1.snapshot();
  const g2 = new FrequencyGovernor({ ignoreEnv: true });
  g2.restore(snap);
  assert.equal(g2.usageSnapshot()[0].dailyCount, 1);
  assert.equal(g2.snapshot().cooldowns.care, snap.cooldowns.care);
  // 恢复后 kind 冷却沿用：1 分钟前刚触发过 care（8h 冷却）→ 拦截
  const v = g2.canTrigger("u", "care", "medium", new Date(NOON));
  assert.equal(v.allowed, false);
  assert.ok(v.reason.startsWith("kind_cooldown"), `reason=${v.reason}`);
});

test("governor: 自适应冷却上下界（负反馈×1.5 上限 48h，正反馈回落不低于默认）", () => {
  const g = new FrequencyGovernor({ ignoreEnv: true });
  const base = g.snapshot().cooldowns.care;
  for (let i = 0; i < 30; i++) g.noteOutcome("care", false);
  assert.ok(g.snapshot().cooldowns.care <= 48 * 60 * 60 * 1000);
  for (let i = 0; i < 30; i++) g.noteOutcome("care", true);
  assert.equal(g.snapshot().cooldowns.care, base);
});

// ─── 临近日程扫描 ───

test("watcher: itinerary 提醒在提前量窗口内产出提案；trivia/agent_task/已开始/还早 不产", () => {
  const submitted: ProactiveProposal[] = [];
  const watcher = new UpcomingScheduleWatcher({
    listTasks: () => [
      task({ taskId: "t-in", runAt: new Date(NOON + 10 * 60_000).toISOString(), nextRunAt: new Date(NOON + 10 * 60_000).toISOString() }),
      task({ taskId: "t-trivia", category: "trivia", description: "[节律提醒:water] 喝水" }),
      task({ taskId: "t-agent", kind: "agent_task", description: "自动化" }),
      task({ taskId: "t-early", runAt: new Date(NOON + 40 * 60_000).toISOString(), nextRunAt: new Date(NOON + 40 * 60_000).toISOString() }),
      task({ taskId: "t-past", runAt: new Date(NOON - 10 * 60_000).toISOString(), nextRunAt: new Date(NOON - 10 * 60_000).toISOString() }),
    ],
    submit: (p) => submitted.push(p),
  });
  watcher.scan(NOON);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].kind, "schedule_upcoming");
  assert.equal(submitted[0].tier, "must");
  assert.equal(submitted[0].importance, "high");
  assert.equal(submitted[0].expiresAt, NOON + 10 * 60_000);
  assert.ok(submitted[0].directText?.includes("分钟"));
  // 二次扫描不重复提案
  watcher.scan(NOON);
  assert.equal(submitted.length, 1);
});
