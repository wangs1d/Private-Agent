import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeActorKey, actorIdVariants } from "../src/agentic-memory/actor-key.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { AgenticLedger } from "../src/agentic-memory/ledger.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { registerMemoryComponents } from "../src/agentic-memory/index.js";
import { clearAllMemoryForActor } from "../src/services/memory-clear-service.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

// 隔离：digest 落临时文件，避免测试写真实 data（存量数据保护铁律）
process.env.AGENT_DAILY_DIGEST_FILE = join(mkdtempSync(join(tmpdir(), "actor-key-")), "digests.json");

test("sanitizeActorKey 保留 @，仅替换文件系统不友好字符", () => {
  assert.equal(sanitizeActorKey("2378709729@qq.com"), "2378709729@qq.com");
  assert.equal(sanitizeActorKey("user:name/x"), "user_name_x");
  assert.equal(sanitizeActorKey(""), "");
});

test("actorIdVariants：普通 id 单形式，带 @ id 覆盖双形式", () => {
  assert.deepEqual(actorIdVariants("session-mvp-001"), ["session-mvp-001"]);
  assert.deepEqual(actorIdVariants("2378709729@qq.com"), [
    "2378709729@qq.com",
    "2378709729_qq.com",
  ]);
  assert.deepEqual(actorIdVariants(""), []);
});

test("清空记忆按双形式 purge：下划线 actor 的 ledger/事实行必须一并清掉（2026-10-04 事故回归）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-key-clear-"));
  const db = openAgenticSqlite(join(dir, "agentic-memory.db"));
  const ledger = new AgenticLedger(db);
  const factStore = new StructuredFactStore(db);

  // 三方种子：@ 形式（交互链）/ 下划线形式（夜间固化链）/ 无关第三者
  const ins = db.prepare(
    `INSERT INTO ledger_records (id, actor_id, claim, source_ref, source_type, confidence, mem0_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  ins.run("l1", "probe-clear@qq.com", "claim-interactive", "test", "test", 1, null, null, now);
  ins.run("l2", "probe-clear_qq.com", "claim-journal-fixation", "test", "test", 1, null, null, now);
  ins.run("l3", "other@qq.com", "claim-keep", "test", "test", 1, null, null, now);
  factStore.applyFact({ actorId: "probe-clear_qq.com", field: "称呼", value: "王哥", confidence: 1.0 });

  registerMemoryComponents({ ledger, factStore });
  const sync = new AgentMemorySyncService(join(dir, "agent-memory-sync.json"));
  await sync.load();

  const result = await clearAllMemoryForActor("probe-clear@qq.com", {
    externalChat: { clearSession: () => {} } as unknown as ExternalChatProvider,
    agentMemorySyncService: sync,
  });

  const remaining = db.prepare(`SELECT actor_id FROM ledger_records`).all().map((r) => r.actor_id);
  assert.ok(!remaining.includes("probe-clear@qq.com"), "@ 形式的行应被清掉");
  assert.ok(!remaining.includes("probe-clear_qq.com"), "下划线形式的固化行必须被清掉（事故回归点）");
  assert.ok(remaining.includes("other@qq.com"), "无关 actor 不受影响");
  const factRows = db.prepare(`SELECT COUNT(*) AS c FROM structured_facts`).get() as { c: number };
  assert.equal(factRows.c, 0, "下划线 actor 的事实行也要清掉");
  // 测试环境 mem0/图记忆未装配：相应路径判空跳过，不炸、计数为 0
  assert.equal(result.agenticMemory, 0);
  assert.equal(result.humanMemoryNodes, 0);
});
