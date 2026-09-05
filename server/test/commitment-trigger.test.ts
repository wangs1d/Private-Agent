// 方案 D：承诺触发源单测——board 事件 → 带效用元数据的提案（代催 ask_first /
// 低置信折算价值可沉默 / attach 接线），及与 Action Utility 评估器的端到端分支
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CommitmentTrigger,
  utilityForEvent,
} from "../src/proactivity/triggers/commitment-trigger.js";
import type { CommitmentEvent, CommitmentRecord } from "../src/agentic-memory/commitment-board.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { evaluateActionUtility, deriveNotifyValue } from "../src/proactivity/action-utility.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");

function record(overrides: Partial<CommitmentRecord> = {}): CommitmentRecord {
  return {
    id: "cmt_1",
    actorId: "user-a",
    text: "周五前把合同发给对方",
    committedBy: "third_party",
    status: "active",
    deadline: "2026-09-05T12:00:00.000Z",
    dependencies: [],
    escalationPolicy: { remindBeforeMin: 30, remindBeforeMinTiers: [1440, 120], escalateAfterMin: 60, maxEscalations: 3 },
    evidenceLedgerIds: ["led_1"],
    source: "manual",
    confidence: null,
    reminderSentAt: null,
    reminderTiersSent: [],
    confirmReminderSentAt: null,
    escalationCount: 0,
    lastEscalatedAt: null,
    dependencyBlocked: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    fulfilledAt: null,
    cancelledAt: null,
    brokenAt: null,
    supersededAt: null,
    notes: null,
    ...overrides,
  };
}

function makeTrigger() {
  const submitted: ProactiveProposal[] = [];
  let notifier: ((e: CommitmentEvent) => void) | null = null;
  const trigger = new CommitmentTrigger({
    board: {
      setNotifier: (fn) => {
        notifier = fn;
      },
    },
    submit: (p) => {
      submitted.push(p);
    },
    now: () => NOW,
  });
  trigger.attach();
  // fire 走 board notifier 路径（返回 void，断言看 submitted）；要拿提案对象直调 handleEvent
  const fire = (e: CommitmentEvent) => (notifier as unknown as (e: CommitmentEvent) => void)(e);
  return { trigger, submitted, fire };
}

test("commitment-trigger: attach 后 board 事件自动成提案进管道", () => {
  const { submitted, fire } = makeTrigger();
  fire({
    type: "reminder",
    commitment: record({ committedBy: "user" }),
    message: "提醒",
    tone: "gentle",
    at: new Date(NOW).toISOString(),
  });
  assert.equal(submitted.length, 1);
  const p = submitted[0];
  assert.equal(p.kind, "action.commitment");
  assert.equal(p.source, "commitment-board");
  assert.ok(p.utility, "提案携带效用元数据");
  assert.ok(p.evidence.some((e) => e.startsWith("ledger:")));
});

test("commitment-trigger: 代催（needsAuthorization）→ 不可逆+第三方+无授权 → ask_first + 提案级确认", () => {
  const { trigger } = makeTrigger();
  const p = trigger.handleEvent({
    type: "escalation",
    commitment: record({ committedBy: "third_party", escalationCount: 1 }),
    message: "对方超时未兑现",
    at: new Date(NOW).toISOString(),
  });
  assert.ok(p);
  assert.equal(p.kind, "action.commitment.nudge");
  assert.deepEqual(p.confirmAction, { label: "代发催促" }, "代催登记提案级确认");
  const u = p.utility;
  assert.ok(u);
  assert.equal(u.risk.reversible, false);
  assert.equal(u.risk.thirdPartyImpact, true);
  assert.equal(u.authorization, "none");
  const result = evaluateActionUtility({ kind: p.kind, risk: u.risk, authorization: u.authorization, value: u.value });
  assert.equal(result.branch, "ask_first");
});

test("commitment-trigger: 手动承诺提醒 = 显式授权，可逆通知", () => {
  const event: CommitmentEvent = {
    type: "reminder",
    commitment: record({ committedBy: "user", source: "manual" }),
    message: "m",
    tone: "urgent",
    at: new Date(NOW).toISOString(),
  };
  const u = utilityForEvent(event, false, "high"); // urgent 提醒 → 草稿 importance=high
  assert.equal(u.authorization, "explicit");
  assert.equal(u.risk.reversible, true);
  // urgent 提醒 importance=high：净效用 0.7-0.3=0.4 > 0.15 → execute_silently（直接投递）
  const result = evaluateActionUtility({ kind: "k", risk: u.risk, authorization: u.authorization, value: u.value });
  assert.equal(result.branch, "execute_silently");
});

test("commitment-trigger: 置信度折算带下限（P1-2），低置信温和提醒不再整档静默", () => {
  const event: CommitmentEvent = {
    type: "reminder",
    commitment: record({ committedBy: "user", source: "auto", confidence: 0.55 }),
    message: "m",
    tone: "gentle",
    at: new Date(NOW).toISOString(),
  };
  const u = utilityForEvent(event, false, "medium"); // gentle 提醒 → 草稿 importance=medium
  assert.equal(u.authorization, "implicit");
  // 下限折算：0.7 + 0.3×0.55 = 0.865；0.45×0.865 ≈ 0.389 - 0.3 ≈ 0.089 ≥ 0 → 不沉默
  const base = deriveNotifyValue("medium");
  assert.ok(Math.abs(u.value.expectedValue - base.expectedValue * 0.865) < 1e-3);
  const result = evaluateActionUtility({ kind: "k", risk: u.risk, authorization: u.authorization, value: u.value });
  assert.notEqual(result.branch, "silence");
});

test("commitment-trigger: 待确认承诺不折算置信度（confirm_reminder 价值不打折）", () => {
  const event: CommitmentEvent = {
    type: "confirm_reminder",
    commitment: record({
      committedBy: "user",
      status: "pending_confirmation",
      source: "auto",
      confidence: 0.6,
    }),
    message: "m",
    at: new Date(NOW).toISOString(),
  };
  const u = utilityForEvent(event, false, "medium");
  const base = deriveNotifyValue("medium");
  assert.ok(Math.abs(u.value.expectedValue - base.expectedValue) < 1e-3, "pending 不乘置信度系数");
  const result = evaluateActionUtility({ kind: "k", risk: u.risk, authorization: u.authorization, value: u.value });
  assert.notEqual(result.branch, "silence");
});

test("commitment-trigger: 高置信自动承诺不被沉默", () => {
  const event: CommitmentEvent = {
    type: "escalation",
    commitment: record({ committedBy: "user", source: "auto", confidence: 0.95 }),
    message: "m",
    at: new Date(NOW).toISOString(),
  };
  const u = utilityForEvent(event, false, "high"); // escalation → 草稿 importance=high
  const result = evaluateActionUtility({ kind: "k", risk: u.risk, authorization: u.authorization, value: u.value });
  assert.notEqual(result.branch, "silence");
});

test("commitment-trigger: broken（critical）事件直达", () => {
  const { trigger } = makeTrigger();
  const p = trigger.handleEvent({
    type: "broken",
    commitment: record({ status: "broken", committedBy: "user" }),
    message: "违约",
    at: new Date(NOW).toISOString(),
  });
  assert.ok(p);
  assert.equal(p.importance, "critical");
  const u = p.utility;
  const result = evaluateActionUtility({ kind: p.kind, risk: u.risk, authorization: u.authorization, value: u.value });
  assert.notEqual(result.branch, "silence");
});

test("commitment-trigger: dedupKey 沿用承诺板梯度档（同档不重复）", () => {
  const { submitted, fire } = makeTrigger();
  fire({ type: "reminder", commitment: record({ id: "cmt_x", committedBy: "user" }), message: "m", tone: "gentle", at: "t" });
  fire({ type: "reminder", commitment: record({ id: "cmt_x", committedBy: "user" }), message: "m", tone: "urgent", at: "t" });
  const keys = submitted.map((p) => p.dedupKey);
  assert.equal(new Set(keys).size, 2, "温和/紧迫档不同键");
  fire({ type: "escalation", commitment: record({ id: "cmt_x", committedBy: "user", escalationCount: 1 }), message: "m", at: "t" });
  fire({ type: "escalation", commitment: record({ id: "cmt_x", committedBy: "user", escalationCount: 1 }), message: "m", at: "t" });
  const esc = submitted.slice(-2).map((p) => p.dedupKey);
  assert.equal(esc.length, 2, "同一次升级重复事件由管道 dedup 兜底");
  assert.equal(esc[0], esc[1]);
});

// ─── 代催真实外发闭环（contact 登记 → 提案携带 → 批准后 sendCommitmentNudge）───

import { CommitmentBoard, composeCommitmentNudgeText } from "../src/agentic-memory/commitment-board.js";
import { sendCommitmentNudge } from "../src/proactivity/triggers/commitment-trigger.js";

test("代发闭环: 承诺带 contact 时升级提案携带 contact detail", () => {
  const { trigger } = makeTrigger();
  const p = trigger.handleEvent({
    type: "escalation",
    commitment: record({
      id: "cmt_c1",
      committedBy: "third_party",
      escalationCount: 1,
      contact: { platform: "wechat", channelId: "conv-9", participantName: "张总" },
    }),
    message: "对方超时未兑现",
    at: new Date(NOW).toISOString(),
  });
  assert.ok(p);
  assert.equal(p.detail?.commitmentId, "cmt_c1");
  assert.equal(p.detail?.contactPlatform, "wechat");
  assert.equal(p.detail?.contactChannelId, "conv-9");
  assert.equal(p.detail?.contactName, "张总");
  assert.match(p.directText, /张总/, "确认文案点名代发对象");
});

test("代发闭环: 承诺无 contact 时不带 detail（批准后无法外发，仅留痕）", () => {
  const { trigger } = makeTrigger();
  const p = trigger.handleEvent({
    type: "escalation",
    commitment: record({ id: "cmt_c2", committedBy: "third_party", escalationCount: 1 }),
    message: "m",
    at: new Date(NOW).toISOString(),
  });
  assert.ok(p);
  assert.equal(p.detail, undefined);
});

test("代发闭环: sendCommitmentNudge 真实外发（gateway 送达 + hub 落库 + 板上留痕）", async () => {
  const board = new CommitmentBoard();
  try {
    const created = board.create({
      actorId: "user-a",
      text: "周五前交付合同",
      committedBy: "third_party",
      contact: { platform: "wechat", channelId: "conv-9", participantName: "张总" },
    });
    assert.ok(created && "id" in created);
    const outbound: Array<Record<string, unknown>> = [];
    const gw: Array<Record<string, unknown>> = [];
    const result = await sendCommitmentNudge(
      {
        createOutbound: (input) => {
          outbound.push(input);
          return {};
        },
        gatewaySend: (input) => {
          gw.push(input);
          return Promise.resolve({ ok: true, delivered: true, message: "bridge delivered" });
        },
        getCommitment: (id) => board.get(id),
        updateCommitmentNotes: (id, notes) => board.update(id, { notes }),
      },
      {
        proposalId: "p1",
        actorId: "user-a",
        kind: "action.commitment.nudge",
        tier: "must",
        importance: "high",
        dedupKey: "k",
        title: "t",
        summary: "s",
        evidence: [],
        createdAt: NOW,
        source: "commitment-board",
        detail: { commitmentId: created.id, contactPlatform: "wechat", contactChannelId: "conv-9", contactName: "张总" },
      },
    );
    assert.deepEqual(result, { sent: true, delivered: true, detail: "催促消息已送达对方会话" });
    assert.equal(gw.length, 1);
    assert.equal(gw[0].channelId, "conv-9");
    assert.match(String(gw[0].text), /代催/);
    assert.match(String(gw[0].text), /周五前交付合同/, "文案含承诺内容");
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].participantName, "张总");
    const stored = board.get(created.id);
    assert.match(stored?.notes ?? "", /已代发催促.*delivered=yes/);
  } finally {
    board.close();
  }
});

test("代发闭环: 网关未配置 bridge（delivered 缺省）→ 仍提交并标记排队", async () => {
  const board = new CommitmentBoard();
  try {
    const created = board.create({
      actorId: "user-a",
      text: "周二回款",
      committedBy: "third_party",
      contact: { platform: "qq", channelId: "conv-q" },
    });
    assert.ok(created && "id" in created);
    const result = await sendCommitmentNudge(
      {
        createOutbound: () => ({}),
        gatewaySend: () => Promise.resolve({ ok: true, message: "queued locally; qq bridge send url not configured" }),
        getCommitment: (id) => board.get(id),
        updateCommitmentNotes: (id, notes) => board.update(id, { notes }),
      },
      {
        proposalId: "p2",
        actorId: "user-a",
        kind: "action.commitment.nudge",
        tier: "must",
        importance: "high",
        dedupKey: "k2",
        title: "t",
        summary: "s",
        evidence: [],
        createdAt: NOW,
        source: "commitment-board",
        detail: { commitmentId: created.id, contactPlatform: "qq", contactChannelId: "conv-q" },
      },
    );
    assert.equal(result.sent, true);
    assert.equal(result.delivered, false);
    assert.match(result.detail, /排队|queued|提交/);
  } finally {
    board.close();
  }
});

test("代发闭环: 缺 contact detail / 承诺非 active → 拒发并说明", async () => {
  const board = new CommitmentBoard();
  try {
    const noContact = await sendCommitmentNudge(
      {
        createOutbound: () => {
          throw new Error("不应外发");
        },
        gatewaySend: () => {
          throw new Error("不应外发");
        },
        getCommitment: (id) => board.get(id),
        updateCommitmentNotes: () => {},
      },
      {
        proposalId: "p3", actorId: "u", kind: "action.commitment.nudge", tier: "must", importance: "high",
        dedupKey: "k3", title: "t", summary: "s", evidence: [], createdAt: NOW, source: "commitment-board",
      },
    );
    assert.equal(noContact.sent, false);
    assert.match(noContact.detail, /缺少代催目标渠道/);

    const cancelled = board.create({ actorId: "u", text: "x", committedBy: "third_party", contact: { platform: "wechat", channelId: "c" } });
    assert.ok(cancelled && "id" in cancelled);
    board.cancel(cancelled.id, "改期了");
    const notActive = await sendCommitmentNudge(
      {
        createOutbound: () => {
          throw new Error("不应外发");
        },
        gatewaySend: () => {
          throw new Error("不应外发");
        },
        getCommitment: (id) => board.get(id),
        updateCommitmentNotes: () => {},
      },
      {
        proposalId: "p4", actorId: "u", kind: "action.commitment.nudge", tier: "must", importance: "high",
        dedupKey: "k4", title: "t", summary: "s", evidence: [], createdAt: NOW, source: "commitment-board",
        detail: { commitmentId: cancelled.id, contactPlatform: "wechat", contactChannelId: "c" },
      },
    );
    assert.equal(notActive.sent, false);
    assert.match(notActive.detail, /cancelled/);
  } finally {
    board.close();
  }
});

test("代发闭环: 催促文案确定性组装（代发标注 + 承诺内容 + 截止）", () => {
  const text = composeCommitmentNudgeText(record({ text: "归还设备", deadline: "2026-09-10T18:00:00.000Z" }));
  assert.match(text, /【代催】/);
  assert.match(text, /归还设备/);
  assert.match(text, /2026-09-10/);
});
