/**
 * 方案 C 单测：commitment-board（承诺草稿板）。
 *
 * 覆盖：
 *   1. 显式通道 CRUD + 状态机（create 校验 / confirm / fulfill / cancel / update）
 *   2. 扫描循环（注入时钟）：临近提醒一次性 / 超时升级至封顶判 broken /
 *      依赖检查阻塞与解除 / 待确认过期
 *   3. 自动提取通道：置信度分级（>0.8 / 0.5-0.8 / <0.5）、证据落账回填、幂等
 *   4. commitment.* 工具（ToolRegistry 注册后全链路 round trip）
 *   5. 提取器纯函数：JSON 解析（无 LLM 调用）
 *   6. 待确认确认提醒（confirm_reminder，一次性）
 *
 * 测试封闭：临时 SQLite、注入时钟、无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CommitmentBoard,
  DEFAULT_ESCALATION_POLICY,
  commitmentProposalFromEvent,
  type CommitmentEvent,
  type CommitmentRecord,
} from "../src/agentic-memory/commitment-board.js";
import { AgenticLedger } from "../src/agentic-memory/ledger.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { COMMITMENT_CHAT_TOOLS, registerCommitmentTools } from "../src/tools/commitment-tools.js";

interface BoardCtx {
  board: CommitmentBoard;
  ledger: AgenticLedger;
  events: CommitmentEvent[];
  setNow: (iso: string) => void;
  dir: string;
}

async function withBoard(
  fn: (ctx: BoardCtx) => Promise<void>,
  opts?: { policy?: Partial<typeof DEFAULT_ESCALATION_POLICY> },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "commitment-board-"));
  const db = openAgenticSqlite(join(dir, "board.db"));
  const ledger = new AgenticLedger(db);
  let nowMs = Date.parse("2026-09-04T10:00:00Z");
  const board = new CommitmentBoard(db, () => new Date(nowMs));
  const events: CommitmentEvent[] = [];
  board.setNotifier((e) => events.push(e));
  const setNow = (iso: string) => {
    nowMs = Date.parse(iso);
  };
  try {
    await fn({ board, ledger, events, setNow, dir });
  } finally {
    board.close(); // board.close 会关 db，ledger 不再重复关
    await rm(dir, { recursive: true, force: true });
  }
  void opts;
}

const BASE = "2026-09-04T10:00:00Z";

// ============================================================
// 1. 显式通道 CRUD + 状态机
// ============================================================

test("create：参数校验与 deadline 规范化", async () => {
  await withBoard(async ({ board }) => {
    assert.ok("error" in board.create({ actorId: "u1", text: "  ", committedBy: "user" }));
    assert.ok("error" in board.create({ actorId: "", text: "送报告", committedBy: "user" }));
    assert.ok(
      "error" in board.create({ actorId: "u1", text: "送报告", committedBy: "someone" as never }),
    );
    assert.ok(
      "error" in board.create({ actorId: "u1", text: "送报告", committedBy: "user", deadline: "明天" }),
    );

    const ok = board.create({
      actorId: "u1",
      text: "用户承诺周五前发合同",
      committedBy: "user",
      deadline: "2026-09-05T18:00:00+08:00",
      dependencies: ["cmt_dep1"],
      notes: "口头承诺",
    });
    assert.ok("id" in ok);
    assert.equal(ok.status, "active");
    assert.equal(ok.source, "manual");
    assert.equal(ok.deadline, "2026-09-05T10:00:00.000Z", "deadline 规范化为 ISO UTC");
    assert.deepEqual(ok.dependencies, ["cmt_dep1"]);
    assert.deepEqual(ok.escalationPolicy, DEFAULT_ESCALATION_POLICY);
    assert.ok("id" in board.create({ actorId: "u1", text: "无期限承诺", committedBy: "agent" }));
  });
});

test("状态机：confirm/fulfill/cancel 的合法与非法流转", async () => {
  await withBoard(async ({ board }) => {
    const active = board.create({ actorId: "u1", text: "送报告", committedBy: "user" }) as {
      id: string;
    };
    // active 不能 confirm（仅 pending_confirmation 可以）
    assert.ok("error" in board.confirm(active.id));

    const fulfilled = board.fulfill(active.id);
    assert.ok("id" in fulfilled && fulfilled.status === "fulfilled");
    // 终态不可再变更
    assert.ok("error" in board.cancel(active.id));
    assert.ok("error" in board.update(active.id, { text: "改" }));
    assert.ok("error" in board.fulfill(active.id));

    const pending = board.create({
      actorId: "u1",
      text: "待确认承诺",
      committedBy: "user",
      status: "pending_confirmation",
    }) as { id: string };
    const confirmed = board.confirm(pending.id);
    assert.ok("id" in confirmed && confirmed.status === "active");

    const cancellable = board.create({ actorId: "u1", text: "会取消", committedBy: "agent" }) as {
      id: string;
    };
    const cancelled = board.cancel(cancellable.id, "对方撤回");
    assert.ok("id" in cancelled && cancelled.status === "cancelled");
    assert.match(board.get(cancellable.id)!.notes ?? "", /对方撤回/);
  });
});

test("update：期限变更重置提醒与升级计时", async () => {
  await withBoard(async ({ board, setNow }) => {
    const c = board.create({
      actorId: "u1",
      text: "给妈妈买生日礼物",
      committedBy: "user",
      deadline: "2026-09-04T11:00:00Z",
    }) as { id: string; reminderSentAt: string | null };

    // 进入提醒窗口 → 提醒一次
    setNow("2026-09-04T10:40:00Z");
    await board.scanOnce();
    assert.ok(board.get(c.id)!.reminderSentAt, "应已发提醒");

    // 改期后提醒计时重置，新窗口可再提醒
    const updated = board.update(c.id, { deadline: "2026-09-05T11:00:00Z" });
    assert.ok("id" in updated);
    assert.equal(board.get(c.id)!.reminderSentAt, null, "改期应重置提醒");

    // deadline 传 null 清除期限
    const cleared = board.update(c.id, { deadline: null });
    assert.ok("id" in cleared && cleared.deadline === null);
  });
});

// ============================================================
// 2. 扫描循环（注入时钟）
// ============================================================

test("扫描：临近提醒只发一次，不重复（单档显式配置）", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    board.create({
      actorId: "u1",
      text: "用户承诺今晚发周报",
      committedBy: "user",
      deadline: "2026-09-04T11:00:00Z",
      escalationPolicy: { remindBeforeMinTiers: [30] }, // 单档：保持旧的 30min 窗口语义
    });

    // 10:20（距截止 40min > remindBefore 30min）：不提醒
    setNow("2026-09-04T10:20:00Z");
    let report = await board.scanOnce();
    assert.equal(report.reminders, 0);

    // 10:40：进入 30min 窗口，提醒
    setNow("2026-09-04T10:40:00Z");
    report = await board.scanOnce();
    assert.equal(report.reminders, 1);
    assert.equal(events.at(-1)!.type, "reminder");

    // 10:50：不重复
    setNow("2026-09-04T10:50:00Z");
    report = await board.scanOnce();
    assert.equal(report.reminders, 0);
    assert.equal(events.filter((e) => e.type === "reminder").length, 1);
  });
});

test("扫描：超时升级按间隔重复，次数耗尽判 broken", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    // 缩短升级策略：超时后每 30min 升级一次，最多 2 次
    board.create({
      actorId: "u1",
      text: "供应商承诺下周交付",
      committedBy: "third_party",
      deadline: "2026-09-04T11:00:00Z",
      escalationPolicy: { escalateAfterMin: 30, maxEscalations: 2 },
    });

    // 11:10（超时 10min < 30min）：不升级
    setNow("2026-09-04T11:10:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e.type === "escalation").length, 0);

    // 11:35：第 1 次升级
    setNow("2026-09-04T11:35:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e.type === "escalation").length, 1);

    // 11:50（距上次升级 15min）：不升级
    setNow("2026-09-04T11:50:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e.type === "escalation").length, 1);

    // 12:10：第 2 次升级（封顶）
    setNow("2026-09-04T12:10:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e.type === "escalation").length, 2);
    assert.equal(board.list({ status: ["active"] }).length, 1, "还在 active");

    // 12:45：耗尽 → broken
    setNow("2026-09-04T12:45:00Z");
    const report = await board.scanOnce();
    assert.equal(report.broken, 1);
    assert.equal(events.at(-1)!.type, "broken");
    assert.equal(board.list({ status: ["broken"] }).length, 1);
  });
});

test("扫描：依赖未兑现冻结提醒/升级，兑现后解除", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    const dep = board.create({
      actorId: "u1",
      text: "用户提供合同扫描件",
      committedBy: "user",
      deadline: "2026-09-04T11:00:00Z",
      // 依赖项自身不参与升级断言：超长升级间隔避免污染「主承诺零升级」检查
      escalationPolicy: { escalateAfterMin: 9999, maxEscalations: 1 },
    }) as { id: string };
    const main = board.create({
      actorId: "u1",
      text: "Agent 承诺收到扫描件后 1 小时内发报告",
      committedBy: "agent",
      deadline: "2026-09-04T11:30:00Z",
      dependencies: [dep.id],
    });

    // 进入依赖的提醒窗口（10:40，距 11:00 截止 20min）：依赖本身提醒，主承诺因阻塞不提醒
    setNow("2026-09-04T10:40:00Z");
    const report = await board.scanOnce();
    assert.equal(report.reminders, 1, "只有依赖项提醒");
    assert.ok(board.get(main.id as string)!.dependencyBlocked, "主承诺应被依赖阻塞");

    // 主承诺超时但阻塞中：不升级
    setNow("2026-09-04T12:30:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e.type === "escalation").length, 0);

    // 依赖兑现 → 解除阻塞事件
    board.fulfill(dep.id);
    setNow("2026-09-04T12:31:00Z");
    const report2 = await board.scanOnce();
    assert.equal(report2.unblocked, 1);
    assert.equal(events.filter((e) => e.type === "dependency_unblocked").length, 1);
    assert.equal(board.get(main.id as string)!.dependencyBlocked, false);
  });
});

test("扫描：待确认承诺超期未确认 → broken(pending_expired)", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    board.create({
      actorId: "u1",
      text: "疑似承诺：用户提到要转账",
      committedBy: "user",
      deadline: "2026-09-04T11:00:00Z",
      status: "pending_confirmation",
    });
    setNow("2026-09-04T11:20:00Z");
    const report = await board.scanOnce();
    assert.equal(report.pendingExpired, 1);
    assert.equal(events.at(-1)!.type, "pending_expired");
    assert.equal(board.list({ status: ["broken"] }).length, 1);
  });
});

test("扫描：待确认承诺进入提醒窗口 → confirm_reminder 一次（P1-1）", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    board.create({
      actorId: "u1",
      text: "用户疑似答应周五发周报",
      committedBy: "user",
      deadline: "2026-09-04T11:00:00Z",
      status: "pending_confirmation",
    });

    // 10:00 创建（默认窗口=最大提醒档 24h 之外不算：deadline 前 24h 已覆盖，直接进窗口）
    setNow("2026-09-04T10:30:00Z");
    const report = await board.scanOnce();
    assert.equal(report.confirmReminders, 1, "进入 24h 窗口发一次确认提醒");
    const first = events.at(-1)!;
    assert.equal(first.type, "confirm_reminder");

    // 不重复
    setNow("2026-09-04T10:45:00Z");
    const again = await board.scanOnce();
    assert.equal(again.confirmReminders, 0);

    // 确认转 active 后：梯度提醒照常（confirm_reminder 只属 pending 阶段）
    const rec = board.list({ status: ["pending_confirmation"] })[0];
    assert.ok(rec);
    board.confirm(rec.id);
    setNow("2026-09-04T10:50:00Z");
    const afterConfirm = await board.scanOnce();
    assert.equal(afterConfirm.confirmReminders, 0);
    // active 且已进 2h 紧迫档窗口（10:50 距 11:00 仅 10min < 120min）→ gradient reminder
    assert.equal(afterConfirm.reminders, 1);
    assert.equal(events.at(-1)!.type, "reminder");
  });
});

test("扫描：候选池与无期限承诺不参与时间驱动", async () => {
  await withBoard(async ({ board, setNow }) => {
    board.create({ actorId: "u1", text: "低置信候选", committedBy: "user", status: "candidate", deadline: "2026-09-04T11:00:00Z" });
    board.create({ actorId: "u1", text: "无期限承诺", committedBy: "agent" });
    setNow("2026-09-05T20:00:00Z");
    const report = await board.scanOnce();
    assert.equal(report.reminders + report.escalations + report.broken, 0);
    assert.equal(report.scanned, 2);
  });
});

// ============================================================
// 3. 自动提取通道
// ============================================================

test("ingestExtracted：置信度分级 + 证据落账回填 + 幂等", async () => {
  await withBoard(async ({ board, ledger }) => {
    const created = board.ingestExtracted(
      "u1",
      [
        { text: "用户承诺周五前转账", committedBy: "user", deadline: "2026-09-05T10:00:00Z", confidence: 0.92, evidence: "我周五前一定把钱转给你" },
        { text: "用户提到可能帮朋友搬家", committedBy: "user", deadline: null, confidence: 0.65, evidence: "周六要是没事我就去帮忙搬家" },
        { text: "用户随口说下次请吃饭", committedBy: "user", deadline: null, confidence: 0.3, evidence: "下次请你吃饭" },
        { text: "无证据项应被丢弃", committedBy: "user", deadline: null, confidence: 0.9, evidence: "" },
      ],
      { sourceRef: "chat:turn-9", ledger },
    );

    assert.equal(created.length, 3, "无证据项被丢弃");
    const statuses = created.map((c) => c.status).sort();
    assert.deepEqual(statuses, ["active", "candidate", "pending_confirmation"]);

    // 每条都有账本证据
    for (const c of created) {
      assert.equal(c.evidenceLedgerIds.length, 1);
      const evidence = ledger.getById(c.evidenceLedgerIds[0]!);
      assert.ok(evidence);
      assert.equal(evidence.sourceRef, "chat:turn-9");
      assert.equal((evidence.metadata as { commitmentEvidence?: boolean }).commitmentEvidence, true);
    }

    // 幂等：同内容重复提取不新建
    const again = board.ingestExtracted(
      "u1",
      [{ text: "用户承诺周五前转账", committedBy: "user", deadline: null, confidence: 0.95, evidence: "重复提取" }],
      { sourceRef: "chat:turn-10", ledger },
    );
    assert.equal(again.length, 0);
  });
});

test("promoteCandidate：候选晋升", async () => {
  await withBoard(async ({ board }) => {
    const c = board.create({ actorId: "u1", text: "候选承诺", committedBy: "user", status: "candidate" }) as { id: string };
    const promoted = board.promoteCandidate(c.id, "pending_confirmation");
    assert.ok("id" in promoted && promoted.status === "pending_confirmation");
    assert.ok("error" in board.promoteCandidate(c.id, "active"), "非 candidate 不可晋升");
  });
});

// ============================================================
// 3.5 梯度提醒 / 依赖图 / 经验学习 / 证据作废（用户规格 2026-09-04）
// ============================================================

test("梯度提醒：24h 温和 + 2h 紧迫，各发一次", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    board.create({
      actorId: "u1",
      text: "用户承诺给客户报价",
      committedBy: "user",
      deadline: "2026-09-05T10:00:00Z", // T0
    });

    // T0-25h：还没进任何档
    setNow("2026-09-04T09:00:00Z");
    assert.equal((await board.scanOnce()).reminders, 0);

    // T0-23h：进 24h 档 → 温和提醒（带帮助提议）
    setNow("2026-09-04T11:00:00Z");
    assert.equal((await board.scanOnce()).reminders, 1);
    assert.equal(events.at(-1)!.tone, "gentle");
    assert.match(events.at(-1)!.message, /帮忙准备/);

    // T0-20h：不重复
    setNow("2026-09-04T14:00:00Z");
    assert.equal((await board.scanOnce()).reminders, 0);

    // T0-90min：进 2h 档 → 紧迫提醒
    setNow("2026-09-05T08:30:00Z");
    assert.equal((await board.scanOnce()).reminders, 1);
    assert.equal(events.at(-1)!.tone, "urgent");
    assert.match(events.at(-1)!.message, /仅剩/);

    // T0-30min：两档都已发
    setNow("2026-09-05T09:30:00Z");
    assert.equal((await board.scanOnce()).reminders, 0);
    assert.equal(events.filter((e) => e.type === "reminder").length, 2);
  });
});

test("依赖延期顺延：上游改期，下游 deadline 按原时差自动顺延（只延不缩）", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    const a = board.create({ actorId: "u1", text: "A 产品设计", committedBy: "user", deadline: "2026-09-07T10:00:00Z" }) as { id: string };
    const b = board.create({ actorId: "u1", text: "B 联系供应商打样", committedBy: "agent", deadline: "2026-09-09T10:00:00Z", dependencies: [a.id] }) as { id: string };
    const c = board.create({ actorId: "u1", text: "C 用户确认样品", committedBy: "user", deadline: "2026-09-11T10:00:00Z", dependencies: [b.id] }) as { id: string };

    setNow("2026-09-05T10:00:00Z");
    const updated = board.update(a.id, { deadline: "2026-09-08T10:00:00Z" }); // A 延后 1 天
    assert.ok("id" in updated);

    assert.equal(board.get(b.id)!.deadline, "2026-09-10T10:00:00.000Z", "B 顺延 1 天");
    assert.equal(board.get(c.id)!.deadline, "2026-09-12T10:00:00.000Z", "C 经 B 传递顺延");
    assert.equal(events.filter((e) => e.type === "deadline_shifted").length, 2);
    assert.equal(board.get(b.id)!.reminderTiersSent.length, 0, "顺延后提醒档重置");

    // 提前不算延期：A 提前 1 天 → B/C 保持不动
    const earlier = board.update(a.id, { deadline: "2026-09-07T10:00:00Z" });
    assert.ok("id" in earlier);
    assert.equal(board.get(b.id)!.deadline, "2026-09-10T10:00:00.000Z");
    assert.equal(events.filter((e) => e.type === "deadline_shifted").length, 2);
  });
});

test("依赖失败：上游 broken → 下游标记阻塞并发 dependency_blocked 事件", async () => {
  await withBoard(async ({ board, events, setNow }) => {
    const b = board.create({
      actorId: "u1",
      text: "B 供应商打样",
      committedBy: "third_party",
      deadline: "2026-09-04T09:00:00Z", // 创建时已过期
      escalationPolicy: { escalateAfterMin: 1, maxEscalations: 0 }, // 首轮扫描直接判 broken
    }) as { id: string };
    const c = board.create({
      actorId: "u1",
      text: "C 用户确认样品",
      committedBy: "user",
      deadline: "2026-09-10T10:00:00Z",
      dependencies: [b.id],
    });

    setNow("2026-09-04T10:00:00Z");
    const first = await board.scanOnce();
    assert.equal(board.get(b.id)!.status, "broken");

    // 同一轮或下一轮：C 检测到上游失败 → 阻塞 + 事件（broken 的上游从活跃列表
    // 消失但仍参与依赖判定）
    const report = first.blocked > 0 ? first : await board.scanOnce();
    assert.equal(report.blocked, 1);
    assert.equal(board.get(c.id as string)!.dependencyBlocked, true);
    assert.equal(events.at(-1)!.type, "dependency_blocked");
    assert.match(events.at(-1)!.message, /B 供应商打样/);
  });
});

test("经验学习：同承诺方反复违约后，新承诺提醒档自动提前（3天/1天/2小时）", async () => {
  await withBoard(async ({ board, setNow }) => {
    for (const text of ["用户答应交押金", "用户答应还书"]) {
      board.create({
        actorId: "u1",
        text,
        committedBy: "user",
        deadline: "2026-09-04T09:00:00Z",
        escalationPolicy: { escalateAfterMin: 1, maxEscalations: 0 },
      });
    }
    setNow("2026-09-04T10:00:00Z");
    await board.scanOnce();
    assert.equal(board.list({ status: ["broken"] }).length, 2);

    const next = board.create({ actorId: "u1", text: "用户答应交材料", committedBy: "user" }) as {
      escalationPolicy: { remindBeforeMinTiers: number[] };
    };
    assert.deepEqual(next.escalationPolicy.remindBeforeMinTiers, [4320, 1440, 120], "2 次违约 → 提前 3 天开始提醒");

    const agentC = board.create({ actorId: "u1", text: "我承诺整理资料", committedBy: "agent" }) as {
      escalationPolicy: { remindBeforeMinTiers: number[] };
    };
    assert.deepEqual(agentC.escalationPolicy.remindBeforeMinTiers, [1440, 120], "其他承诺方不受影响");
    assert.deepEqual(board.getFailurePattern("u1"), { user: 2, agent: 0, third_party: 0 });
  });
});

test("证据作废 → 承诺自动 superseded（幽灵幻觉治理）", async () => {
  await withBoard(async ({ board, ledger }) => {
    const created = board.ingestExtracted(
      "u1",
      [{ text: "用户承诺周五前转账", committedBy: "user", deadline: "2026-09-05T10:00:00Z", confidence: 0.9, evidence: "我周五前一定把钱转给你" }],
      { sourceRef: "chat:turn-1", ledger },
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]!.evidenceLedgerIds.length, 1);
    const evidenceId = created[0]!.evidenceLedgerIds[0]!;
    assert.equal(ledger.getById(evidenceId)!.claim, "我周五前一定把钱转给你");

    const marked = board.supersedeByEvidence([evidenceId], "void:test", "用户否认说过");
    assert.equal(marked.length, 1);
    assert.equal(board.get(created[0]!.id)!.status, "superseded");
    assert.equal(board.list({ status: ["active"] }).length, 0);
    assert.ok("error" in board.update(created[0]!.id, { text: "改" }), "终态不可更新");
  });
});

test("承诺方差异化提案：user 督促帮办 / agent 自跟踪 / third_party 授权代催 + 低价值沉默", async () => {
  await withBoard(async ({ board }) => {
    void board;
    const mk = (over: Partial<CommitmentRecord>): CommitmentEvent => ({
      type: "escalation",
      at: BASE,
      message: "",
      commitment: {
        id: "cmt_x",
        actorId: "u1",
        text: "周五前交报价",
        committedBy: "user",
        status: "active",
        deadline: "2026-09-05T10:00:00Z",
        dependencies: [],
        escalationPolicy: { ...DEFAULT_ESCALATION_POLICY },
        evidenceLedgerIds: [],
        source: "manual",
        confidence: null,
        reminderSentAt: null,
        reminderTiersSent: [],
        confirmReminderSentAt: null,
        escalationCount: 1,
        lastEscalatedAt: null,
        dependencyBlocked: false,
        createdAt: BASE,
        updatedAt: BASE,
        fulfilledAt: null,
        cancelledAt: null,
        brokenAt: null,
        supersededAt: null,
        notes: null,
        ...over,
      },
    });

    // user：督促 + 提供帮助，但明确不越权执行
    const userP = commitmentProposalFromEvent(mk({ committedBy: "user" }))!;
    assert.equal(userP.tier, "must");
    assert.equal(userP.importance, "high");
    assert.match(userP.directText, /不会替你直接执行/);

    // agent：自跟踪，给重试/用户定夺选项
    const agentP = commitmentProposalFromEvent(mk({ committedBy: "agent" }))!;
    assert.match(agentP.directText, /重试|调整方案/);

    // third_party：建议联系 + 代发催促需授权
    const tpP = commitmentProposalFromEvent(mk({ committedBy: "third_party" }))!;
    assert.equal(tpP.kind, "action.commitment.nudge");
    assert.equal(tpP.needsAuthorization, true);
    assert.match(tpP.directText, /代你发一条催促/);

    // 价值分级：自动提取低置信 → social 档（预算仲裁可沉默）；手动登记 → must
    assert.equal(commitmentProposalFromEvent(mk({ source: "auto", confidence: 0.55 }))!.tier, "social");
    assert.equal(commitmentProposalFromEvent(mk({ source: "manual" }))!.tier, "must");

    // 提醒语气分档：温和 → medium，紧迫 → high
    const gentle = commitmentProposalFromEvent({ ...mk({}), type: "reminder", tone: "gentle" })!;
    const urgent = commitmentProposalFromEvent({ ...mk({}), type: "reminder", tone: "urgent" })!;
    assert.equal(gentle.importance, "medium");
    assert.equal(urgent.importance, "high");
  });
});

// ============================================================
// 4. commitment.* 工具（ToolRegistry round trip）
// ============================================================

test("commitment 工具：create → list → confirm → update → fulfill/cancel 全链路", async () => {
  const dir = await mkdtemp(join(tmpdir(), "commitment-tools-"));
  const db = openAgenticSqlite(join(dir, "tools.db"));
  const board = new CommitmentBoard(db);
  const registry = new ToolRegistry();
  registerCommitmentTools(registry, { board });
  const context = { sessionId: "sess-1", userId: "user-1" };
  // ToolRegistry.execute 返回 { ok, result }（result 为处理器返回值）
  const call = async (name: string, input: Record<string, unknown>) => {
    const exec = await registry.execute(name, input, context);
    assert.ok(exec.ok, `${name} 执行失败: ${JSON.stringify(exec.result)}`);
    return exec.result as Record<string, unknown>;
  };

  try {
    // 工具声明完整（7 个：create/update/cancel/confirm/fulfill/list/retract）
    assert.equal(COMMITMENT_CHAT_TOOLS.length, 7);

    // create
    const created = (await call("commitment.create", {
      text: "用户承诺明天把设计稿发给 Agent",
      committedBy: "user",
      deadline: "2026-09-05T12:00:00Z",
    })) as unknown as { commitment: { id: string; status: string } };
    assert.equal(created.commitment.status, "active");
    const id = created.commitment.id;

    // 自动提取的待确认（board 直建）→ confirm 工具确认
    const pendingRec = board.create({
      actorId: "user-1",
      text: "疑似承诺：帮朋友代购",
      committedBy: "user",
      status: "pending_confirmation",
    });
    assert.ok("id" in pendingRec);
    const confirmed = (await call("commitment.confirm", { id: pendingRec.id })) as unknown as {
      commitment: { status: string };
    };
    assert.equal(confirmed.commitment.status, "active");

    // list（默认未完结）
    const listed = (await call("commitment.list", {})) as unknown as { count: number };
    assert.equal(listed.count, 2);

    // update 改期
    const updated = (await call("commitment.update", { id, deadline: "2026-09-06T12:00:00Z" })) as unknown as {
      commitment: { deadline: string };
    };
    assert.ok(updated.commitment.deadline.startsWith("2026-09-06"));

    // cancel 一条 + fulfill 一条
    const cancelled = (await call("commitment.cancel", { id, reason: "用户撤回" })) as unknown as {
      commitment: { status: string };
    };
    assert.equal(cancelled.commitment.status, "cancelled");
    const fulfilled = (await call("commitment.fulfill", { id: pendingRec.id })) as unknown as {
      commitment: { status: string };
    };
    assert.equal(fulfilled.commitment.status, "fulfilled");

    // includeDone 列全部
    const all = (await call("commitment.list", { includeDone: true })) as unknown as { count: number };
    assert.equal(all.count, 2);
    const open_ = (await call("commitment.list", {})) as unknown as { count: number };
    assert.equal(open_.count, 0);
  } finally {
    board.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 5. 提取器纯函数（不调 LLM）
// ============================================================

test("extractCommitments：无 API key 返回空（不抛错）", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { extractCommitments } = await import("../src/agentic-memory/commitment-extractor.js");
    assert.deepEqual(await extractCommitments("我承诺明天发报告"), []);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
