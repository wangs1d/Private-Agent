/**
 * 方案 B 单测：agentic-memory/ledger（语义账本）。
 *
 * 覆盖：
 *   1. append-only 基础：append/appendBatch/getById/字段规范化/置信度钳制
 *   2. sourceType 推断与显式指定
 *   3. supersede：单条一次性替代、按来源批量作废、stats
 *   4. ingest 写入钩子集成：Mem0 infer 结果 → 账本落 claim（含 mem0Id 关联）
 *
 * 测试封闭：临时 SQLite、fake Mem0，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgenticLedger,
  inferLedgerSourceType,
  LEDGER_VOID_PREFIX,
} from "../src/agentic-memory/ledger.js";
import { AgenticMemoryIngestService } from "../src/agentic-memory/ingest.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import type { Memory } from "mem0ai/oss";

const LLM_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;

async function withLedger(fn: (ledger: AgenticLedger, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of LLM_ENV_KEYS) delete process.env[k];
  const ledger = new AgenticLedger(openAgenticSqlite(join(dir, "ledger.db")));
  try {
    await fn(ledger, dir);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ============================================================
// 1. append-only 基础
// ============================================================

test("append：落库断言含全部字段，空 claim 拒绝", async () => {
  await withLedger(async (ledger) => {
    const rec = ledger.append({
      actorId: "user-1",
      claim: "用户 2026-09-01 入职新公司",
      sourceRef: "chat:turn-100",
      confidence: 1.7, // 超界应钳到 1
      mem0Id: "m0-x1",
      metadata: { context: "main" },
    });
    assert.ok(rec);
    assert.match(rec.id, /^led_/);
    assert.equal(rec.sourceType, "chat");
    assert.equal(rec.confidence, 1);
    assert.equal(rec.mem0Id, "m0-x1");
    assert.deepEqual(rec.metadata, { context: "main" });
    assert.equal(rec.supersededBy, null);

    assert.equal(ledger.append({ actorId: "user-1", claim: "   ", sourceRef: "chat:turn-1" }), null);
    assert.equal(ledger.append({ actorId: "", claim: "x", sourceRef: "chat:turn-1" }), null);
  });
});

test("appendBatch / getById / listBySource（含被替代过滤）", async () => {
  await withLedger(async (ledger) => {
    const recs = ledger.appendBatch([
      { actorId: "user-1", claim: "用户喜欢爬山", sourceRef: "chat:turn-1", mem0Id: "m0-1" },
      { actorId: "user-1", claim: "用户养猫一只", sourceRef: "chat:turn-1", mem0Id: "m0-2" },
      { actorId: "user-1", claim: "用户在成都工作", sourceRef: "notes:doc-9", mem0Id: "m0-3" },
    ]);
    assert.equal(recs.length, 3);

    const byId = ledger.getById(recs[0]!.id);
    assert.ok(byId);
    assert.equal(byId.claim, "用户喜欢爬山");

    const fromTurn1 = ledger.listBySource("chat:turn-1");
    assert.equal(fromTurn1.length, 2);

    ledger.supersede(recs[0]!.id, recs[1]!.id, "内容重复");
    assert.equal(ledger.listBySource("chat:turn-1").length, 1);
    assert.equal(ledger.listBySource("chat:turn-1", { includeSuperseded: true }).length, 2);
    // 已替代记录不可二次替代
    assert.equal(ledger.supersede(recs[0]!.id, "led_other", "再试"), false);
  });
});

// ============================================================
// 2. sourceType 推断
// ============================================================

test("inferLedgerSourceType：前缀推断 + 默认 chat", () => {
  assert.equal(inferLedgerSourceType("chat:turn-1"), "chat");
  assert.equal(inferLedgerSourceType("notes:doc-9"), "notes");
  assert.equal(inferLedgerSourceType("tool:browser:run-3"), "tool");
  assert.equal(inferLedgerSourceType("digest:2026-09-01"), "digest");
  assert.equal(inferLedgerSourceType("world:event-7"), "world");
  assert.equal(inferLedgerSourceType("system:sleep"), "system");
  assert.equal(inferLedgerSourceType("未知来源"), "chat");
});

test("append：显式 sourceType 覆盖推断", async () => {
  await withLedger(async (ledger) => {
    const rec = ledger.append({
      actorId: "user-1",
      claim: "用户手动登记的事实",
      sourceRef: "chat:turn-2",
      sourceType: "manual",
    });
    assert.equal(rec!.sourceType, "manual");
  });
});

// ============================================================
// 3. supersede / stats
// ============================================================

test("supersedeBySource：批量作废写 void 哨兵；stats 汇总正确", async () => {
  await withLedger(async (ledger) => {
    ledger.appendBatch([
      { actorId: "user-1", claim: "断言A", sourceRef: "chat:turn-5" },
      { actorId: "user-1", claim: "断言B", sourceRef: "chat:turn-5" },
      { actorId: "user-1", claim: "断言C", sourceRef: "chat:turn-6" },
    ]);

    const voidToken = `${LEDGER_VOID_PREFIX}source:chat:turn-5`;
    const n = ledger.supersedeBySource("chat:turn-5", voidToken, "来源撤回");
    assert.equal(n, 2);

    const superseded = ledger.listBySource("chat:turn-5", { includeSuperseded: true });
    assert.ok(superseded.every((r) => r.supersededBy === voidToken));
    assert.ok(superseded.every((r) => r.supersedeReason === "来源撤回"));

    const stats = ledger.stats();
    assert.deepEqual(stats, { total: 3, active: 1, superseded: 2 });
  });
});

test("listActiveByActor / searchByClaim", async () => {
  await withLedger(async (ledger) => {
    ledger.appendBatch([
      { actorId: "user-1", claim: "用户喜欢爬山", sourceRef: "chat:1" },
      { actorId: "user-2", claim: "用户喜欢爬山", sourceRef: "chat:2" },
      { actorId: "user-1", claim: "用户在写一本书", sourceRef: "chat:3" },
    ]);
    assert.equal(ledger.listActiveByActor("user-1").length, 2);
    assert.equal(ledger.searchByClaim("user-1", "爬山").length, 1);
    assert.equal(ledger.searchByClaim("user-2", "书").length, 0);
  });
});

// ============================================================
// 4. ingest 写入钩子集成（Mem0 infer 结果 → 账本）
// ============================================================

test("writeDecidedDetailed 触发 writeHooks：抽取条目落账并带 mem0Id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-ingest-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of LLM_ENV_KEYS) delete process.env[k];

  const ledger = new AgenticLedger(openAgenticSqlite(join(dir, "ledger.db")));
  const extracted = [
    { id: "m0-a", memory: "用户 9 月要去北京出差" },
    { id: "m0-b", memory: "用户团队有 5 个人" },
  ];
  const fakeMemory = {
    async add(_m: unknown, opts: { metadata?: Record<string, unknown> }) {
      return { results: extracted.map((e) => ({ ...e, metadata: opts?.metadata })) };
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(fakeMemory);

  // 复刻 create-app-services 的钩子接线：claim = Mem0 infer 抽取结果
  ingest.addWriteHook((event) => {
    ledger.appendBatch(
      event.results.map((item) => ({
        actorId: event.actorId,
        claim: item.memory,
        sourceRef: event.sourceId,
        mem0Id: item.id,
        metadata: { context: event.context, highSignal: event.highSignal },
      })),
    );
  });

  try {
    const results = await ingest.writeDecidedDetailed(
      "user-1",
      "chat:turn-77",
      "我 9 月要去北京出差，团队有 5 个人",
      "main",
      true,
    );
    assert.equal(results.length, 2);

    const claims = ledger.listBySource("chat:turn-77");
    assert.equal(claims.length, 2);
    assert.ok(claims.every((c) => c.sourceType === "chat"));
    assert.deepEqual(
      claims.map((c) => c.mem0Id).sort(),
      ["m0-a", "m0-b"],
      "每条 claim 应回填对应 Mem0 id",
    );
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("writeDecidedDetailed：空内容/无抽取结果不触发钩子", async () => {
  const fakeMemory = {
    async add() {
      return { results: [] };
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(fakeMemory);
  let hookFired = 0;
  ingest.addWriteHook(() => {
    hookFired += 1;
  });

  assert.deepEqual(await ingest.writeDecidedDetailed("user-1", "chat:1", "  ", "main", true), []);
  assert.deepEqual(await ingest.writeDecidedDetailed("user-1", "chat:1", "正常内容", "main", true), []);
  assert.equal(hookFired, 0);
});
