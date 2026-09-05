/**
 * 方案 D 单测：provenance（溯源作废）。
 *
 * 覆盖：
 *   1. 依赖图登记：recordDerivations 去重、getDerivations、findSourcesOf
 *   2. invalidateSource：账本 void 哨兵 + Mem0 删除 + 认知图 overridden + 边失效
 *   3. invalidateClaim：断言级级联（mem0Id 反查 Mem0 / 节点 metadata.mem0Ids 反查图）
 *   4. 与方案 A/B 集成：bridge 统一写入 + 账本落账后的真实级联链路
 *
 * 测试封闭：fake Mem0、临时 SQLite、真实 AgenticLedger。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProvenanceService } from "../src/agentic-memory/provenance.js";
import type { ProvenanceGraphLike, EvidenceVoidedInfo } from "../src/agentic-memory/provenance.js";
import { AgenticLedger, LEDGER_VOID_PREFIX } from "../src/agentic-memory/ledger.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

const LLM_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;

/** fake 认知图：内存节点表 + attachNodeMetadata 落 patch */
function makeFakeGraph() {
  const nodes = new Map<string, { id: string; deletionStage: string; metadata: Record<string, unknown> }>();
  const graph: ProvenanceGraphLike = {
    getAllNodes(actorId: string) {
      void actorId;
      return [...nodes.values()];
    },
    attachNodeMetadata(_actorId: string, nodeId: string, patch: Record<string, unknown>) {
      const node = nodes.get(nodeId);
      if (!node) return false;
      node.metadata = { ...node.metadata, ...patch };
      return true;
    },
  };
  return { graph, nodes };
}

function makeFakeMemory() {
  const deleted: string[] = [];
  return {
    memory: {
      async delete(id: string) {
        deleted.push(id);
        return { message: "ok" };
      },
    },
    deleted,
  };
}

interface ProvCtx {
  provenance: ProvenanceService;
  ledger: AgenticLedger;
  nodes: Map<string, { id: string; deletionStage: string; metadata: Record<string, unknown> }>;
  deleted: string[];
  dir: string;
}

async function withProvenance(fn: (ctx: ProvCtx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provenance-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of LLM_ENV_KEYS) delete process.env[k];

  const db = openAgenticSqlite(join(dir, "prov.db"));
  const ledger = new AgenticLedger(db);
  const { graph, nodes } = makeFakeGraph();
  const { memory, deleted } = makeFakeMemory();
  const provenance = new ProvenanceService(memory, graph, ledger, db);

  try {
    await fn({ provenance, ledger, nodes, deleted, dir });
  } finally {
    provenance.close(); // 关 db；ledger 共用同一连接不重复关
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ============================================================
// 1. 依赖图登记
// ============================================================

test("recordDerivations：登记 + 同源同 id 去重 + 查询", async () => {
  await withProvenance(async ({ provenance }) => {
    const n1 = provenance.recordDerivations("chat:turn-1", "u1", {
      mem0Ids: ["m0-1", "m0-2"],
      ledgerIds: ["led-1"],
      graphNodeIds: ["mem-a"],
    });
    assert.equal(n1, 4);

    // 重复登记：全部去重
    const n2 = provenance.recordDerivations("chat:turn-1", "u1", {
      mem0Ids: ["m0-1", "m0-2"],
      ledgerIds: ["led-1"],
      graphNodeIds: ["mem-a"],
    });
    assert.equal(n2, 0);

    // 新增部分登记：只插新增
    const n3 = provenance.recordDerivations("chat:turn-1", "u1", { mem0Ids: ["m0-3"] });
    assert.equal(n3, 1);

    assert.equal(provenance.getDerivations("chat:turn-1").length, 5);
    assert.deepEqual(
      provenance.findSourcesOf("mem0", "m0-2").map((e) => e.sourceRef),
      ["chat:turn-1"],
    );
    assert.equal(provenance.findSourcesOf("ledger", "led-1").length, 1);
    assert.equal(provenance.getDerivations("chat:none").length, 0);
  });
});

// ============================================================
// 2. 来源级作废
// ============================================================

test("invalidateSource：三存储级联 + 边失效 + 二次作废幂等", async () => {
  await withProvenance(async ({ provenance, ledger, nodes, deleted }) => {
    // 造数据：账本两条 claim + Mem0 两条 + 图节点两个（其一挂 mem0Ids）
    ledger.appendBatch([
      { actorId: "u1", claim: "断言A", sourceRef: "chat:turn-9", mem0Id: "m0-a" },
      { actorId: "u1", claim: "断言B", sourceRef: "chat:turn-9", mem0Id: "m0-b" },
    ]);
    nodes.set("mem-1", { id: "mem-1", deletionStage: "active", metadata: {} });
    nodes.set("mem-2", { id: "mem-2", deletionStage: "active", metadata: { mem0Ids: ["m0-a"] } });
    provenance.recordDerivations("chat:turn-9", "u1", {
      ledgerIds: ["led-x1", "led-x2"],
      mem0Ids: ["m0-a", "m0-b"],
      graphNodeIds: ["mem-1"],
    });

    const report = await provenance.invalidateSource("chat:turn-9", "消息被撤回");

    assert.equal(report.ledgerSuperseded, 2, "账本两条 claim 作废");
    assert.equal(report.mem0Deleted, 2, "Mem0 两条删除");
    assert.equal(report.graphOverridden, 2, "mem-1 经边标记 + mem-2 经元数据反查标记");
    assert.equal(report.edgesInvalidated, 5);
    assert.deepEqual([...deleted].sort(), ["m0-a", "m0-b"]);

    // 账本侧：void 哨兵 + 原因
    const superseded = ledger.listBySource("chat:turn-9", { includeSuperseded: true });
    assert.ok(superseded.every((r) => r.supersededBy === `${LEDGER_VOID_PREFIX}source:chat:turn-9`));
    assert.ok(superseded.every((r) => r.supersedeReason === "消息被撤回"));

    // 图侧：overridden 标记
    const o1 = nodes.get("mem-1")!.metadata.overridden as { by: string; reason: string };
    const o2 = nodes.get("mem-2")!.metadata.overridden as { by: string; reason: string };
    assert.equal(o1.by, "source:chat:turn-9");
    assert.equal(o2.reason, "消息被撤回");

    // 依赖边全部失效
    assert.equal(provenance.getDerivations("chat:turn-9").length, 0);
    assert.equal(provenance.getDerivations("chat:turn-9", { includeInvalidated: true }).length, 5);

    // 二次作废：无活跃边，全部零动作
    const again = await provenance.invalidateSource("chat:turn-9", "再作废");
    assert.equal(again.edgesInvalidated, 0);
    assert.equal(again.mem0Deleted, 0);
    assert.equal(deleted.length, 2);

    // stats
    const stats = provenance.stats();
    assert.deepEqual(stats, { total: 5, active: 0, invalidated: 5 });
  });
});

// ============================================================
// 3. 断言级作废
// ============================================================

test("invalidateClaim：claim → Mem0 → 图节点级联", async () => {
  await withProvenance(async ({ provenance, ledger, nodes, deleted }) => {
    const rec = ledger.append({
      actorId: "u1",
      claim: "用户 9 月要去北京出差",
      sourceRef: "chat:turn-1",
      mem0Id: "m0-trip",
    });
    nodes.set("mem-trip", {
      id: "mem-trip",
      deletionStage: "active",
      metadata: { mem0Ids: ["m0-trip"] },
    });
    nodes.set("mem-other", { id: "mem-other", deletionStage: "active", metadata: {} });
    provenance.recordDerivations("chat:turn-1", "u1", { ledgerIds: [rec!.id] });

    const report = await provenance.invalidateClaim(rec!.id, "行程取消，断言失效");
    assert.equal(report.ledgerSuperseded, 1);
    assert.equal(report.mem0Deleted, 1);
    assert.deepEqual(deleted, ["m0-trip"]);
    assert.equal(report.graphOverridden, 1, "仅挂该 mem0Id 的节点被标记");
    assert.ok(nodes.get("mem-trip")!.metadata.overridden, "目标节点已标记 overridden");
    assert.equal(nodes.get("mem-other")!.metadata.overridden, undefined, "无关节点不受影响");

    const superseded = ledger.getById(rec!.id)!;
    assert.equal(superseded.supersededBy, `${LEDGER_VOID_PREFIX}claim:${rec!.id}`);
  });
});

test("invalidateClaim：不存在的断言返回错误明细", async () => {
  await withProvenance(async ({ provenance }) => {
    const report = await provenance.invalidateClaim("led-missing", "测试");
    assert.equal(report.ledgerSuperseded, 0);
    assert.ok(report.mem0DeleteErrors.some((e) => e.includes("不存在")));
  });
});

// ============================================================
// 4. A+B+D 集成：bridge 写入 → 账本落账 → 溯源登记 → 来源作废
// ============================================================

test("onEvidenceVoided：来源/断言作废时回调携带账本 id（承诺板级联入口）", async () => {
  await withProvenance(async ({ provenance, ledger }) => {
    const fired: EvidenceVoidedInfo[] = [];
    provenance.setEvidenceVoidedHook((info) => fired.push(info));

    const r1 = ledger.append({ actorId: "u1", claim: "断言1", sourceRef: "chat:turn-3" });
    const r2 = ledger.append({ actorId: "u1", claim: "断言2", sourceRef: "chat:turn-3" });
    provenance.recordDerivations("chat:turn-3", "u1", { ledgerIds: [r1!.id, r2!.id] });

    await provenance.invalidateSource("chat:turn-3", "消息被撤回");
    assert.equal(fired.length, 1);
    assert.deepEqual([...fired[0]!.ledgerIds].sort(), [r1!.id, r2!.id].sort());
    assert.equal(fired[0]!.voidToken, `${LEDGER_VOID_PREFIX}source:chat:turn-3`);
    assert.equal(fired[0]!.reason, "消息被撤回");

    const r3 = ledger.append({ actorId: "u1", claim: "断言3", sourceRef: "chat:turn-4", mem0Id: "m0-9" });
    provenance.recordDerivations("chat:turn-4", "u1", { ledgerIds: [r3!.id] });
    await provenance.invalidateClaim(r3!.id, "被证伪");
    assert.equal(fired.length, 2);
    assert.deepEqual(fired[1]!.ledgerIds, [r3!.id]);

    // 无钩子/无账本边时不炸：再作废一次已失效来源
    await provenance.invalidateSource("chat:turn-3", "二次");
    assert.equal(fired.length, 2);
  });
});

test("集成：统一写入链路的溯源可追溯（bridge 接口形态的登记侧）", async () => {
  await withProvenance(async ({ provenance, ledger }) => {
    // 模拟 create-app-services 钩子行为：Mem0 infer 结果 → 账本 → 溯源
    const results = [
      { id: "m0-i1", memory: "用户 9 月要去北京出差" },
      { id: "m0-i2", memory: "用户团队有 5 个人" },
    ];
    const records = ledger.appendBatch(
      results.map((item) => ({
        actorId: "u1",
        claim: item.memory,
        sourceRef: "chat:turn-42",
        mem0Id: item.id,
      })),
    );
    provenance.recordDerivations("chat:turn-42", "u1", {
      mem0Ids: results.map((r) => r.id),
      ledgerIds: records.map((r) => r.id),
      graphNodeIds: ["mem-bridge-1"],
    });

    assert.equal(provenance.getDerivations("chat:turn-42").length, 5);

    // 来源作废后：claim 全 void、Mem0 全删、可重登记（新写入不受旧作废影响）
    const report = await provenance.invalidateSource("chat:turn-42", "撤回");
    assert.equal(report.ledgerSuperseded, 2);
    assert.equal(report.mem0Deleted, 2);

    const reReg = provenance.recordDerivations("chat:turn-42", "u1", { mem0Ids: ["m0-new"] });
    assert.equal(reReg, 1, "作废后同源可登记新派生物");
    assert.equal(provenance.getDerivations("chat:turn-42").length, 1);
  });
});
