/**
 * 记忆生命周期「两阶段遗忘 + 分类 TTL」单测。
 *
 * 覆盖（2026-09 遗忘策略优化）：
 *   1. 分类 TTL：temporary_context 走 7 天档；stable_* / importance ≥ 0.8 豁免；
 *   2. access_count 延长有效期：高频召回的记忆比同龄低频记忆活得久；
 *   3. 两阶段第一阶段：到期记忆归档（archived_at）而非物理删，召回侧过滤；
 *   4. 两阶段第二阶段：归档超过保留期物理删（retention=0 永久保留）；
 *   5. lifecycle_kv 持久化：去重游标跨进程（实例重建）不再归零重扫；
 *   6. 召回过滤贯通：AgenticMemoryRetrievalService 不返回已归档记忆。
 *
 * 测试封闭：临时 SQLite / fake Mem0，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Memory } from "mem0ai/oss";

import { AgenticMemoryLifecycleService } from "../src/agentic-memory/memory-lifecycle.js";
import {
  MemoryReinforcementStore,
  configureMemoryReinforcement,
} from "../src/agentic-memory/memory-reinforcement.js";
import {
  AgenticMemoryRetrievalService,
} from "../src/agentic-memory/retrieval.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

const DAY_MS = 86_400_000;

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/** 最小 Mem0 OSS 内存替身：getAll/search/delete 满足 lifecycle 与 retrieval 需求。 */
function makeFakeMemory(items: Array<Record<string, unknown>>): Memory {
  const rows = new Map<string, Record<string, unknown>>();
  for (const item of items) rows.set(item.id as string, item);
  return {
    getAll: async () => ({ results: [...rows.values()] }),
    search: async () => ({ results: [] }),
    delete: async (id: string) => {
      rows.delete(id);
    },
    add: async () => ({ results: [] }),
    get: async () => ({}),
    update: async () => ({}),
    history: async () => [],
  } as unknown as Memory;
}

function setEnv(overrides: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("两阶段遗忘：分类 TTL + access_count 延长 + 归档/到期物理删 + 游标持久化", async () => {
  const restoreEnv = setEnv({
    AGENT_MEMORY_TTL_DAYS: "90",
    AGENT_MEMORY_TTL_TEMPORARY_DAYS: "7",
    AGENT_MEMORY_ARCHIVE_RETENTION_DAYS: "14",
    AGENT_MEMORY_REINFORCEMENT_ENABLED: "true",
    AGENT_MEMORY_DEDUP_SIMILARITY_THRESHOLD: "0.92",
  });
  const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
  const dbPath = join(dir, "agentic-memory.db");
  const openDbs: Array<{ close: () => void }> = [];

  try {
    const actor = "u_lifecycle";
    const now = Date.now();
    const items = [
      // A：temporary_context，20 天前 → 7 天档过期 → 归档
      {
        id: "a_temp",
        memory: "明天下午三点开会",
        updatedAt: isoDaysAgo(20, now),
        metadata: { actorId: actor, importance: 0.37, memorySemanticClass: "temporary_context" },
      },
      // B：stable_identity → 核心事实豁免（即使 importance < 0.8）
      {
        id: "b_stable",
        memory: "用户住在上海",
        updatedAt: isoDaysAgo(400, now),
        metadata: { actorId: actor, importance: 0.79, memorySemanticClass: "stable_identity" },
      },
      // C：无语义类低重要性，100 天前 → 常规 90 天×0.8=72 天过期 → 归档
      {
        id: "c_regular",
        memory: "上周尝试了素食餐厅",
        updatedAt: isoDaysAgo(100, now),
        metadata: { actorId: actor, importance: 0.3 },
      },
      // D：与 C 同龄但被召回 10 次 → 有效期 ×2=144 天 → 存活
      {
        id: "d_accessed",
        memory: "每周三晚上打球",
        updatedAt: isoDaysAgo(100, now),
        metadata: { actorId: actor, importance: 0.3 },
      },
      // E：importance ≥ 0.8 → 豁免
      {
        id: "e_core",
        memory: "用户对花生过敏",
        updatedAt: isoDaysAgo(400, now),
        metadata: { actorId: actor, importance: 0.9 },
      },
    ];
    const fakeMemory = makeFakeMemory(items);

    const mainDb = openAgenticSqlite(dbPath);
    openDbs.push(mainDb);
    const reinforcement = new MemoryReinforcementStore(mainDb);
    // D 模拟高频召回：access_count=10 → 有效期上限 ×2
    for (let i = 0; i < 10; i++) reinforcement.touch(["d_accessed"], actor, now - i * 1_000);

    const lifecycle = new AgenticMemoryLifecycleService(fakeMemory, reinforcement);
    const result = await lifecycle.runCycle();

    // 第一阶段：A/C 归档未物理删；B/D/E 存活
    assert.equal(result.archived, 2, `应归档 2 条（实际 ${result.archived}）`);
    assert.equal(result.purged, 0);
    const archivedIds = reinforcement.getArchivedIds(["a_temp", "b_stable", "c_regular", "d_accessed", "e_core"]);
    assert.deepEqual([...archivedIds].sort(), ["a_temp", "c_regular"]);

    const allAfter = (await fakeMemory.getAll({})) as { results: Array<{ id: string }> };
    assert.equal(allAfter.results.length, 5, "归档阶段不得物理删除向量库记录");

    // 第二阶段：retention=0 → 归档永久保留不物理删
    const restoreZero = setEnv({ AGENT_MEMORY_ARCHIVE_RETENTION_DAYS: "0" });
    const r2 = await lifecycle.runCycle();
    assert.equal(r2.purged, 0, "retention=0 时归档不物理删");
    restoreZero();

    // 归档时间回拨到保留期之前 → 下轮物理删（含 bridge 通知 + 侧表回收）
    const rawDb = openAgenticSqlite(dbPath);
    openDbs.push(rawDb);
    rawDb
      .prepare(`UPDATE memory_reinforcement SET archived_at = ? WHERE mem0_id IN ('a_temp','c_regular')`)
      .run(now - 15 * DAY_MS);
    const r3 = await lifecycle.runCycle();
    assert.equal(r3.purged, 2, "超过保留期的归档应物理删");
    const allAfterPurge = (await fakeMemory.getAll({})) as { results: Array<{ id: string }> };
    assert.deepEqual(
      allAfterPurge.results.map((r) => r.id).sort(),
      ["b_stable", "d_accessed", "e_core"],
    );
    assert.equal(reinforcement.getArchivedIds(["a_temp", "c_regular"]).size, 0, "物理删后侧表行应回收");

    // 游标持久化：重建 lifecycle 实例后游标不归零（重启不再全量重扫）
    const rebuilt = new AgenticMemoryLifecycleService(fakeMemory, reinforcement);
    const snapshot = rebuilt.getStatsSnapshot();
    assert.ok(snapshot.dedupCursorMs > 0, "去重游标应从 kv 恢复");
    assert.equal(snapshot.archivedRows, 0);
  } finally {
    for (const db of openDbs) {
      try {
        db.close();
      } catch {
        // 已关闭则忽略
      }
    }
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
});

test("召回过滤：已归档记忆不再出现在检索结果中", async () => {
  const restoreEnv = setEnv({ AGENT_MEMORY_REINFORCEMENT_ENABLED: "true" });
  const dir = await mkdtemp(join(tmpdir(), "retrieval-test-"));
  let db: { close: () => void } | null = null;
  try {
    const actor = "u_retrieval";
    db = openAgenticSqlite(join(dir, "db.sqlite"));
    const reinforcement = new MemoryReinforcementStore(db);
    configureMemoryReinforcement(reinforcement);
    reinforcement.archiveIds(["archived_1"], actor);

    const fakeMemory = {
      search: async () => ({
        results: [
          { id: "archived_1", memory: "旧的手机号 13800000000", score: 0.95, metadata: { context: "main" } },
          { id: "live_1", memory: "用户喜欢手冲咖啡", score: 0.9, metadata: { context: "main" } },
        ],
      }),
    } as unknown as Memory;

    const retrieval = new AgenticMemoryRetrievalService(fakeMemory);
    const text = await retrieval.buildRecall(actor, "手机号是多少");
    assert.ok(!text.includes("13800000000"), "已归档记忆不应被召回");
    assert.ok(text.includes("手冲咖啡"), "未归档记忆正常召回");

    const structured = await retrieval.searchStructured(actor, "咖啡偏好");
    assert.equal(structured.length, 1);
    assert.equal(structured[0]!.content, "用户喜欢手冲咖啡");
    configureMemoryReinforcement(null);
  } finally {
    db?.close();
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reinforcement 归档语义：重复归档不覆盖时间，purgeActor 级联回收归档行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-test-"));
  let db: { close: () => void } | null = null;
  try {
    db = openAgenticSqlite(join(dir, "db.sqlite"));
    const store = new MemoryReinforcementStore(db);
    const first = store.archiveIds(["m1"], "u1", 1_000);
    assert.equal(first, 1);
    // 触碰不应复活归档行（touch 走 upsert，archived_at 保留）
    store.touch(["m1"], "u1", 2_000);
    // 二次归档：已归档的不重复计数
    const second = store.archiveIds(["m1"], "u1", 3_000);
    assert.equal(second, 0);
    const stats = store.getStats(["m1"]);
    assert.equal(stats.get("m1")?.accessCount, 1);

    assert.equal(store.purgeActor("u1"), 1);
    assert.equal(store.getStats(["m1"]).size, 0);
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
