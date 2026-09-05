/**
 * 记忆系统整体优化批次单测（2026-09-04）。
 *
 * 覆盖：
 *   1. 统一抽取器纯函数（P1-6）：JSON 剥壳 / 决策校验 / 承诺+纠正规范化
 *   2. ledger FTS5 检索 + 保留策略 + purgeActor（P1-10 / P0-2）
 *   3. bridge 删除调和 / 删除失败封顶 / 存量回填 / purgeActor（P0-3 / P2-15 / P0-2）
 *   4. board 升级退避表 / 类别维度经验学习 / statsByStatus（P2-14 / P2-13）
 *   5. 认知图 SQLite 行级持久化 round-trip 与 JSON 迁移（P1-9）
 *
 * 全部封闭：fake Mem0、临时目录、无外部 LLM。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalize as normalizeUnified,
  parseJsonObject,
} from "../src/agentic-memory/unified-extractor.js";
import { AgenticLedger } from "../src/agentic-memory/ledger.js";
import { MemoryBridgeService } from "../src/agentic-memory/memory-bridge-service.js";
import type { BridgeGraphLike } from "../src/agentic-memory/memory-bridge-service.js";
import { CommitmentBoard } from "../src/agentic-memory/commitment-board.js";
import { GraphSqlitePersistence } from "../src/services/graph-sqlite-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

// ============================================================
// 1. 统一抽取器纯函数（P1-6）
// ============================================================

test("parseJsonObject：容忍围栏与杂文，坏 JSON 返回 null", () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('前置说明 {"decision":"remember"} 后缀'), {
    decision: "remember",
  });
  assert.equal(parseJsonObject("不是 json"), null);
  assert.equal(parseJsonObject('{"broken": '), null);
});

test("normalizeUnified：决策校验 / 承诺规范化 / 纠正项 / 无效决策拒绝", () => {
  const ok = normalizeUnified({
    decision: "remember",
    semanticClass: "承诺",
    memories: ["用户周五前转账给供应商", "", "x"],
    commitments: [
      {
        text: "用户承诺周五前转账",
        committedBy: "user",
        deadline: "2026-09-05T10:00:00Z",
        confidence: 1.5,
        evidence: "我周五前一定转",
        category: "转账",
      },
      { text: "无证据丢弃", committedBy: "user", deadline: null, confidence: 0.9, evidence: "" },
      { text: "方向非法丢弃", committedBy: "robot", deadline: null, confidence: 0.9, evidence: "x" },
    ],
    corrections: [
      { oldClaim: "9月去北京出差", newClaim: "行程取消" },
      { oldClaim: "", newClaim: "x" },
    ],
  });
  assert.ok(ok);
  assert.equal(ok.decision, "remember");
  assert.deepEqual(ok.memories, ["用户周五前转账给供应商"]);
  assert.equal(ok.commitments.length, 1);
  assert.equal(ok.commitments[0]!.confidence, 1);
  assert.equal(ok.commitments[0]!.category, "转账");
  assert.deepEqual(ok.corrections, [{ oldClaim: "9月去北京出差", newClaim: "行程取消" }]);

  assert.equal(normalizeUnified({ decision: "maybe" }), null);
  assert.equal(normalizeUnified({ decision: "reject", memories: ["不应带出"] })!.memories.length, 0);
});

// ============================================================
// 2. ledger：FTS5 检索 / 保留策略 / purgeActor
// ============================================================

test("ledger：FTS5 检索命中与活跃过滤，purgeActor 清库", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-fts-"));
  try {
    const ledger = new AgenticLedger(openAgenticSqlite(join(dir, "l.db")));
    const r1 = ledger.append({ actorId: "u1", claim: "用户承诺周五前转账给供应商", sourceRef: "chat:1" })!;
    ledger.append({ actorId: "u1", claim: "用户喜欢在周末爬山", sourceRef: "chat:2" });
    ledger.append({ actorId: "u2", claim: "用户承诺下周交付样品", sourceRef: "chat:3" });

    const hits = ledger.searchByClaim("u1", "转账");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.id, r1.id);
    assert.equal(ledger.searchByClaim("u2", "转账").length, 0, "actor 隔离");

    ledger.supersede(r1.id, "led_new", "测试");
    assert.equal(ledger.searchByClaim("u1", "转账").length, 0, "被替代断言不入检索");

    const purged = ledger.purgeActor("u1");
    assert.ok(purged >= 2);
    assert.equal(ledger.listActiveByActor("u1").length, 0);
    assert.equal(ledger.listActiveByActor("u2").length, 1);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger：pruneSuperseded 只物理删除超期被替代记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-prune-"));
  try {
    const db = openAgenticSqlite(join(dir, "l.db"));
    const ledger = new AgenticLedger(db);
    const old = ledger.append({ actorId: "u1", claim: "旧断言被替代", sourceRef: "chat:1" })!;
    ledger.append({ actorId: "u1", claim: "活跃断言保留", sourceRef: "chat:2" });
    ledger.supersede(old.id, "led_replacement", "替代");
    // 手工把 superseded_at 拨老（31 天前）
    db
      .prepare(`UPDATE ledger_records SET superseded_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), old.id);

    assert.equal(ledger.pruneSuperseded(30), 1, "超期被替代记录删除");
    assert.equal(ledger.pruneSuperseded(30), 0, "幂等");
    assert.equal(ledger.getById(old.id), null);
    assert.ok(ledger.listActiveByActor("u1").length === 1, "活跃记录不受影响");
    assert.equal(ledger.pruneSuperseded(0), 0, "0=关闭");
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 3. bridge：删除调和 / 失败封顶 / 回填 / purgeActor
// ============================================================

function makeGraphFixture() {
  const nodes = new Map<
    string,
    { id: string; actorId: string; summary: string; deletionStage: string; metadata: Record<string, unknown> }
  >();
  const graph: BridgeGraphLike = {
    async ingest(actorId, text, source) {
      const id = `n_${nodes.size + 1}`;
      nodes.set(id, {
        id,
        actorId,
        summary: text.trim().replace(/\s+/g, " "),
        deletionStage: "active",
        metadata: {},
      });
      void source;
      return id;
    },
    getAllNodes(actorId) {
      return [...nodes.values()].filter((n) => n.actorId === actorId);
    },
    attachNodeMetadata(_actorId, nodeId, patch) {
      const n = nodes.get(nodeId);
      if (!n) return false;
      n.metadata = { ...n.metadata, ...patch };
      return true;
    },
    async buildRecall() {
      return { recalledNodeIds: [], confidence: 0, text: "" };
    },
    getNodeSummariesByIds() {
      return [];
    },
  };
  return { graph, nodes };
}

async function withOptBridge(
  fn: (ctx: {
    bridge: MemoryBridgeService;
    graph: ReturnType<typeof makeGraphFixture>["graph"];
    nodes: ReturnType<typeof makeGraphFixture>["nodes"];
  }) => Promise<void>,
  opts?: {
    memory?: { delete(id: string): Promise<unknown>; getAll?(): Promise<unknown> };
    extracted?: Array<{ id: string; memory: string }>;
  },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-opt-"));
  try {
    const { graph, nodes } = makeGraphFixture();
    const memory = opts?.memory ?? { async delete() {} };
    const bridge = new MemoryBridgeService(
      memory,
      graph,
      { async writeDecidedDetailed() { return opts?.extracted ?? []; } },
      { async searchStructured() { return []; } },
      openAgenticSqlite(join(dir, "b.db")),
    );
    try {
      await fn({ bridge, graph, nodes });
    } finally {
      bridge.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bridge：handleMem0Deleted 修剪 mem0Ids，摘空 tombstone；purgeActor 清理", async () => {
  const deleted: string[] = [];
  await withOptBridge(
    async ({ bridge }) => {
      await bridge.writeUnified("u1", "chat:1", "内容文本", { context: "main", highSignal: true });
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 1);

      bridge.handleMem0Deleted(["m0-1"]);
      let links = bridge.listLinks({ activeOnly: true });
      assert.equal(links.length, 1, "部分删除 → 修剪不 tombstone");
      assert.deepEqual(links[0]!.mem0Ids, ["m0-2"]);

      bridge.handleMem0Deleted(["m0-2"]);
      links = bridge.listLinks({ activeOnly: true });
      assert.equal(links.length, 0, "摘空 → tombstone");
      assert.equal(bridge.listLinks().length, 1);
      assert.equal(bridge.listLinks()[0]!.lastStage, "mem0_pruned");

      bridge.handleMem0Deleted(["m0-1", "m0-2"]); // 幂等
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 0);

      await bridge.writeUnified("u2", "chat:9", "另一用户内容", { context: "main", highSignal: true });
      assert.equal(bridge.purgeActor("u1"), 1);
      assert.equal(bridge.listLinks().filter((l) => l.actorId === "u1").length, 0);
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 1, "u2 不受影响");
    },
    {
      memory: {
        async delete(id: string) {
          deleted.push(id);
        },
      },
      extracted: [
        { id: "m0-1", memory: "断言一" },
        { id: "m0-2", memory: "断言二" },
      ],
    },
  );
  void deleted;
});

test("bridge：writeUnified 的 ingest fake 产出两条 mem0（配合调和用）", async () => {
  await withOptBridge(
    async ({ bridge }) => {
      const result = await bridge.writeUnified("u1", "chat:1", "内容文本", {
        context: "main",
        highSignal: true,
      });
      assert.equal(result.mem0Items.length, 2);
    },
    {
      memory: { async delete() {} },
      extracted: [
        { id: "m0-1", memory: "断言一" },
        { id: "m0-2", memory: "断言二" },
      ],
    },
  );
});

test("bridge：syncForgetting 删除连续失败 3 轮后 tombstone（delete_failed）", async () => {
  await withOptBridge(
    async ({ bridge, graph }) => {
      await bridge.writeUnified("u1", "chat:1", "内容文本内容", { context: "main", highSignal: true });
      const node = graph.getAllNodes("u1")[0]!;
      node.deletionStage = "soft_deleted";

      await bridge.syncForgetting("u1");
      await bridge.syncForgetting("u1");
      const report = await bridge.syncForgetting("u1");
      assert.equal(report.forgottenLinks, 1, "第 3 轮失败后 tombstone");
      assert.equal(bridge.listLinks()[0]!.lastStage, "delete_failed");

      const after = await bridge.syncForgetting("u1");
      assert.equal(after.scannedLinks, 0, "tombstone 后不再重扫");
    },
    {
      memory: {
        async delete() {
          throw new Error("qdrant down");
        },
      },
      extracted: [{ id: "m0-stuck", memory: "删不掉的记忆" }],
    },
  );
});

test("bridge：backfillLinks 用文本相似度回填存量 linkage（零 LLM）", async () => {
  await withOptBridge(
    async ({ bridge, nodes }) => {
      nodes.set("n_legacy", {
        id: "n_legacy",
        actorId: "u1",
        summary: "用户喜欢在周末爬山，每周都去",
        deletionStage: "active",
        metadata: {},
      });

      const report = await bridge.backfillLinks("u1");
      assert.equal(report.nodesMatched, 1);
      const node = nodes.get("n_legacy")!;
      assert.deepEqual(node.metadata.mem0Ids, ["m0-old"]);
      assert.equal(node.metadata.backfilled, true);

      const again = await bridge.backfillLinks("u1");
      assert.equal(again.nodesMatched, 0, "幂等：已有 linkage 跳过");
    },
    {
      memory: {
        async delete() {},
        async getAll() {
          return {
            results: [
              { id: "m0-old", memory: "用户喜欢在周末爬山，每周都去", metadata: { actorId: "u1" } },
              { id: "m0-other", memory: "完全无关的另一条记忆内容", metadata: { actorId: "u1" } },
            ],
          };
        },
      },
    },
  );
});

// ============================================================
// 4. board：升级退避 / 类别经验学习 / statsByStatus
// ============================================================

async function withOptBoard(fn: (ctx: { board: CommitmentBoard; setNow: (iso: string) => void }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "board-opt-"));
  let nowMs = Date.parse("2026-09-04T10:00:00Z");
  const board = new CommitmentBoard(openAgenticSqlite(join(dir, "b.db")), () => new Date(nowMs));
  try {
    await fn({ board, setNow: (iso) => { nowMs = Date.parse(iso); } });
  } finally {
    board.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("board：升级退避表按次数取值（[1,2,3]分钟快进验证），固定 escalateAfterMin 兼容", async () => {
  await withOptBoard(async ({ board, setNow }) => {
    const events: string[] = [];
    board.setNotifier((e) => events.push(e.type));
    board.create({
      actorId: "u1",
      text: "第三方承诺交付",
      committedBy: "third_party",
      deadline: "2026-09-04T09:00:00Z", // 创建时已超时 1h
      escalationPolicy: { escalateAfterMinSchedule: [60, 360, 1440], maxEscalations: 3 },
    });

    // 10:00（超时 60min = step1）→ 第 1 次升级
    setNow("2026-09-04T10:00:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e === "escalation").length, 1);

    // 12:00（距上次 120min < step2=360min）→ 不升级
    setNow("2026-09-04T12:00:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e === "escalation").length, 1);

    // 16:30（距上次 390min ≥ 360min）→ 第 2 次升级
    setNow("2026-09-04T16:30:00Z");
    await board.scanOnce();
    assert.equal(events.filter((e) => e === "escalation").length, 2);

    // 旧语义兼容：显式固定 escalateAfterMin 且无退避表 → 固定间隔
    const board2Dir = await mkdtemp(join(tmpdir(), "board-opt2-"));
    let now2 = Date.parse("2026-09-04T10:00:00Z");
    const board2 = new CommitmentBoard(openAgenticSqlite(join(board2Dir, "b.db")), () => new Date(now2));
    try {
      board2.create({
        actorId: "u1",
        text: "固定间隔承诺",
        committedBy: "user",
        deadline: "2026-09-04T09:00:00Z",
        escalationPolicy: { escalateAfterMin: 30, maxEscalations: 2 },
      });
      const policy = board2.list({ status: ["active"] })[0]!.escalationPolicy;
      assert.deepEqual(policy.escalateAfterMinSchedule, [], "显式固定间隔 → 退避表清空");
    } finally {
      board2.close();
      await rm(board2Dir, { recursive: true, force: true });
    }
  });
});

test("board：类别维度经验学习——同类违约 2 次提前提醒，异类不触发", async () => {
  await withOptBoard(async ({ board, setNow }) => {
    setNow("2026-09-04T10:00:00Z");
    for (const text of ["答应交报价一", "答应交报价二"]) {
      board.create({
        actorId: "u1",
        text,
        committedBy: "user",
        category: "报价",
        deadline: "2026-09-04T09:00:00Z",
        escalationPolicy: { escalateAfterMin: 1, maxEscalations: 0 },
      });
    }
    await board.scanOnce(); // 两条 broken

    const hot = board.create({ actorId: "u1", text: "再交一次报价", committedBy: "user", category: "报价" }) as {
      escalationPolicy: { remindBeforeMinTiers: number[] };
    };
    assert.deepEqual(hot.escalationPolicy.remindBeforeMinTiers, [4320, 1440, 120], "同类 2 次违约 → 提前");

    const cold = board.create({ actorId: "u1", text: "约定会面时间", committedBy: "user", category: "会面" }) as {
      escalationPolicy: { remindBeforeMinTiers: number[] };
    };
    assert.deepEqual(cold.escalationPolicy.remindBeforeMinTiers, [1440, 120], "异类不受影响");

    assert.deepEqual(board.getFailurePatternByCategory("u1"), { "user:报价": 2 });
    assert.deepEqual(board.statsByStatus(), { active: 2, broken: 2 });
  });
});

// ============================================================
// 5. 认知图 SQLite 行级持久化（P1-9）
// ============================================================

test("graph-sqlite：save/load round-trip + hash-diff 增量 + JSON 迁移种子", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-sqlite-"));
  try {
    const path = join(dir, "human-memory.json"); // 仿真实命名 → 生成 human-memory.sqlite
    const store = {
      version: 1,
      domains: { profile: { id: "profile" } },
      nodes: {
        n1: { id: "n1", summary: "节点一" },
        n2: { id: "n2", summary: "节点二" },
      },
      edges: { e1: { id: "e1", from: "n1", to: "n2" } },
      versions: {},
      communities: {},
    };

    const p1 = new GraphSqlitePersistence(path);
    await p1.load();
    p1.save(store);
    p1.close();

    const p2 = new GraphSqlitePersistence(path);
    const { data } = await p2.load();
    assert.deepEqual(data!.nodes, store.nodes);
    assert.deepEqual(data!.edges, store.edges);

    // 增量：改 n1、删 n2、加 n3
    const next = structuredClone(store) as typeof store;
    (next.nodes.n1 as { summary: string }).summary = "节点一（改）";
    delete next.nodes.n2;
    next.nodes.n3 = { id: "n3", summary: "节点三" };
    p2.save(next);
    p2.close();

    const p3 = new GraphSqlitePersistence(path);
    const { data: reloaded } = await p3.load();
    assert.equal((reloaded!.nodes!.n1 as { summary: string }).summary, "节点一（改）");
    assert.equal(reloaded!.nodes!.n2, undefined);
    assert.ok(reloaded!.nodes!.n3);
    p3.close();

    // JSON 迁移种子：删库后仅存 json → 自动导入
    await rm(join(dir, "human-memory.sqlite"), { force: true });
    await writeFile(path, JSON.stringify({ version: 1, nodes: { j1: { id: "j1" } } }), "utf8");
    const p4 = new GraphSqlitePersistence(path);
    const { data: migrated } = await p4.load();
    assert.ok(migrated!.nodes!.j1, "旧 JSON 自动种子迁移");
    p4.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
