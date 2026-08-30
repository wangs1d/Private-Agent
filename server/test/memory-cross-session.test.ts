import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import { MemoryManagerService } from "../src/services/memory-manager-service.js";
import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { NarrativeMemoryFacade } from "../src/services/narrative-memory-port.js";
import { DailyJournalService } from "../src/services/daily-journal-service.js";

// 真实服务栈，验证「跨会话记忆连续性」在记忆架构重构后的端到端闭环（actorId 稳定 + sessionId 不同）：
// 白天 STM 台账按会话隔离、跨会话可达由当日 journal 词法检索承担；
// 夜晚 journal 固化进长期记忆图后，新会话 recall 由长期图承担。
// 不使用 mock narrative：走真实 HumanLikeMemoryService 的 ingest/buildRecall（离线降级到关键词检索）。
const dir = mkdtempSync(join(tmpdir(), "stm-cross-session-"));

const gateway = await initShortTermMemoryGatewayService(join(dir, "short-term-task-stack.json"));
const humanLike = new HumanLikeMemoryService(join(dir, "human-like-memory.json"));
const facade = new NarrativeMemoryFacade(null, null, null, humanLike);
const memoryManager = new MemoryManagerService(facade, null, {
  enabled: true,
  onlineConsolidationThreshold: 1,
});

// 真实桌面/WS 场景：单个人工智能体用户通过环境变量注入稳定 PAI_ACTOR_ID，
// 而每次会话 sessionId 不同（actorId !== sessionId）。
const actorId = "user-1";
const sessionA = "session-A";
const sessionB = "session-B";

test("跨会话：白天跨会话可达由 journal 承担，STM 不跨会话泄漏", async () => {
  const journal = new DailyJournalService(dir);

  // ---- 会话 A：事实只在本会话透露（STM 台账按会话收录 + journal 落盘）----
  gateway.reconcileTaskAfterTurn(sessionA, "帮我找刘浩存的照片", "为你整理刘浩存的高清写真集。");
  journal.appendTurn(actorId, sessionA, "帮我找刘浩存的照片", "为你整理刘浩存的高清写真集。");
  await new Promise((r) => setTimeout(r, 80));

  // STM 不跨会话泄漏：会话B 的台账查不到会话A内容（避免串台）
  assert.equal(gateway.searchEpisodic(sessionB, "刘浩存").length, 0, "STM 台账应按会话隔离");

  // 白天跨会话可达：journal 近 N 天词法检索命中（无需等夜晚固化，零 embedding）
  const hits = await journal.searchRange(actorId, "刘浩存 照片", 3);
  assert.ok(hits.length > 0, "白天跨会话应由当日 journal 检索承担");
});

test("跨会话：夜晚 journal 固化进长期图，新会话 recall 可命中", async () => {
  const journal = new DailyJournalService(dir);
  journal.appendTurn(actorId, sessionA, "我的项目用的是TypeScript", "了解，TypeScript 技术栈。");
  await new Promise((r) => setTimeout(r, 80));

  // 模拟夜晚固化（consolidateDailyJournals 同款语义）：消费未固化行 → 写入长期图 → 标记已固化
  const unconsolidated = await journal.getUnconsolidatedLines(actorId);
  assert.ok(unconsolidated.length > 0, "应有未固化日志");
  for (const { dateKey, lines } of unconsolidated) {
    for (const line of lines) {
      const m = line.trim().match(/^- \[(\d{2}:\d{2})\]\s+(?:[\w-]{0,10}\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
      if (!m) continue;
      await facade.ingest(actorId, `[日志固化 ${dateKey} ${m[1]}] ${m[3]}`, "journal:consolidate", {
        highSignal: false,
      });
    }
    await journal.markConsolidated(actorId, [dateKey]);
  }

  // 固化后新会话 recall 可命中（跨会话连续由长期记忆图承载）
  const recall = await facade.buildNarrativeRecall(actorId, "TypeScript 项目");
  assert.ok(recall, "夜晚固化后新会话应能召回跨会话事实");
});

test("跨会话连续性持久：固化完成后 journal 标记不重复轮询", async () => {
  const journal = new DailyJournalService(dir);
  const after = await journal.getUnconsolidatedLines(actorId);
  assert.equal(after.length, 0, "固化完成后不应再有未处理日志（幂等，不重复固化）");
});
// ---- searchEpisodic BM25 混合打分升级 ----

test("searchEpisodic BM25 升级：罕见实词命中的轮次排序前置，检索契约不变", () => {
  const sA = "session-bm25-a";
  const sB = "session-bm25-b";
  // 轮 1：含罕见实体词（高 IDF）
  gateway.reconcileTaskAfterTurn(sA, "帮我确认 QUANTUM_FLUX_PARAM 的校准值", "QUANTUM_FLUX_PARAM 校准值为 0.87。");
  // 轮 2-3：只有高频字（的/我/吗）与 query 部分重叠的低信息轮
  gateway.reconcileTaskAfterTurn(sA, "我的的确认一下的吗", "好的的确认完了。");
  gateway.reconcileTaskAfterTurn(sA, "那之后我们就收尾吧", "好的，收尾完成。");

  const hits = gateway.searchEpisodic(sA, "QUANTUM_FLUX_PARAM 校准确认");
  assert.ok(hits.length > 0, "应命中");
  assert.ok(
    hits[0]!.user.includes("QUANTUM_FLUX_PARAM"),
    `罕见实词轮应排第一，实际: ${JSON.stringify(hits.map((h) => h.user))}`,
  );

  // 跨会话隔离契约不受升级影响
  assert.equal(gateway.searchEpisodic(sB, "QUANTUM_FLUX_PARAM").length, 0);
});
