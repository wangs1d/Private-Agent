/**
 * P0-2 端到端：口语承诺捕获 → 承诺板 → 梯度提醒 → 仲裁 → 投递（全真实组件）。
 *
 * 唯一注入点：统一抽取的 LLM 客户端（fake）——生产链路里它就是那次
 * 「决策+记忆+承诺」的合并调用。这里特意让 fake 返回 decision="decay"
 * （4 字口语"明天发你"在记忆侧不值得存储），验证承诺不随记忆路由丢失：
 *
 *   ingestText(low-signal) → extractUnified(fake) → writeHook(生产同款门控)
 *     → CommitmentBoard.ingestExtracted → scanOnce(梯度提醒)
 *     → CommitmentTrigger.handleEvent(效用元数据) → arbitrate → verdict=delivered
 *
 * 另覆盖：
 *   - scope=high 灰度回退档（低信号不抽取）
 *   - 高信号但决策 reject：承诺照抓、记忆不落（P0-2 解耦的另一面）
 *
 * 测试封闭：临时 SQLite、注入时钟、fake LLM，无网络。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Memory } from "mem0ai/oss";

import { AgenticMemoryIngestService, type Mem0WriteEvent } from "../src/agentic-memory/ingest.js";
import { CommitmentBoard } from "../src/agentic-memory/commitment-board.js";
import type { CommitmentEvent } from "../src/agentic-memory/commitment-board.js";
import { AgenticLedger } from "../src/agentic-memory/ledger.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import type { UnifiedExtraction, UnifiedLlmClient } from "../src/agentic-memory/unified-extractor.js";
import { CommitmentTrigger } from "../src/proactivity/triggers/commitment-trigger.js";
import { arbitrate } from "../src/proactivity/arbiter.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOW = Date.parse("2026-09-05T10:00:00Z");
const DEADLINE = new Date(NOW + 23 * 3_600_000).toISOString();

/** fake LLM：默认记忆判 decay、承诺 confidence 0.9 —— 解耦场景的核心输入 */
function fakeClient(overrides?: Partial<UnifiedExtraction>): UnifiedLlmClient {
  const payload: UnifiedExtraction = {
    decision: "decay",
    semanticClass: "承诺",
    memories: [],
    commitments: [
      {
        text: "用户承诺明天把文件发给对方",
        committedBy: "user",
        deadline: DEADLINE,
        confidence: 0.9,
        evidence: "明天发你",
        category: "交付",
      },
    ],
    corrections: [],
    ...overrides,
  };
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      },
    },
  };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface E2eCtx {
  ingest: AgenticMemoryIngestService;
  board: CommitmentBoard;
  ledger: AgenticLedger;
  events: CommitmentEvent[];
  /** Mem0.add 调用计数（对象共享，断言取实时值） */
  mem0Writes: { count: number };
  dir: string;
  setNow: (ms: number) => void;
}

/**
 * 组装真实组件；钩子门控复刻 create-app-services 的承诺捕获段
 * （context=main、不看 highSignal、ingestExtracted 证据落账回填）。
 */
async function withE2e(
  fn: (ctx: E2eCtx) => Promise<void>,
  opts?: { client?: UnifiedLlmClient },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "commitment-e2e-"));
  const db = openAgenticSqlite(join(dir, "e2e.db"));
  const ledger = new AgenticLedger(db);
  let nowMs = NOW;
  const board = new CommitmentBoard(db, () => new Date(nowMs));
  const events: CommitmentEvent[] = [];
  board.setNotifier((e) => events.push(e));

  const addedToMem0 = { count: 0 };
  const memoryStub = {
    add: async () => {
      addedToMem0.count += 1;
      return { results: [{ id: "m1", memory: "stub" }] };
    },
  } as unknown as Memory;

  const ingest = new AgenticMemoryIngestService(memoryStub);
  if (opts?.client) ingest.setExtractionClient(opts.client);
  ingest.addWriteHook((event: Mem0WriteEvent) => {
    if (event.context !== "main") return;
    board.ingestExtracted(event.actorId, event.commitments ?? [], {
      sourceRef: event.sourceId,
      ledger,
    });
  });

  try {
    await fn({
      ingest,
      board,
      ledger,
      events,
      mem0Writes: addedToMem0,
      dir,
      setNow: (ms) => (nowMs = ms),
    });
  } finally {
    board.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("e2e：4 字口语承诺（低信号 decay）→ 板 → 温和提醒 → 仲裁 delivered", async () => {
  const savedScope = process.env.AGENT_COMMITMENT_EXTRACT_SCOPE;
  delete process.env.AGENT_COMMITMENT_EXTRACT_SCOPE; // 缺省 all
  try {
    await withE2e(
      async ({ ingest, board, ledger, events, setNow }) => {
        // "明天发你"：4 字、低信号（无 highSignal 标记）、fake 判记忆 decay
        await ingest.ingestText("user-e2e", "chat:turn-1", "明天发你", { context: "main" });

        await waitFor(() => board.list({ status: ["active", "pending_confirmation"] }).length > 0);
        const created = board.list({ status: ["active"] })[0];
        assert.ok(created, "confidence 0.9 > 0.8 → 直接 active");
        assert.equal(created.committedBy, "user");
        assert.equal(created.source, "auto");
        assert.equal(created.deadline, DEADLINE);
        assert.ok(created.evidenceLedgerIds.length > 0, "证据落账并回填 evidenceLedgerIds");
        assert.ok(ledger.getById(created.evidenceLedgerIds[0]!), "账本可溯源");

        // deadline 前 23h → 1440min 温和提醒档
        setNow(NOW + 60_000);
        const report = await board.scanOnce();
        assert.equal(report.reminders, 1);
        const reminder = events.at(-1)!;
        assert.equal(reminder.type, "reminder");

        // 承诺触发源 → 带效用元数据的提案
        let proposal: ProactiveProposal | null = null;
        const trigger = new CommitmentTrigger({
          board: { setNotifier: () => {} },
          submit: (p) => (proposal = p),
          now: () => new Date(NOW + 60_000),
        });
        const p = trigger.handleEvent(reminder);
        assert.ok(p);
        assert.equal(p.tier, "must", "conf 0.9 非低价值提案");
        assert.ok(p.utility);

        // 仲裁：活跃、非对话、无负反馈 → delivered（不沉默）
        const decision = arbitrate(p, {
          now: NOW + 60_000,
          presence: "active",
          inConversation: false,
          isSuppressed: () => ({ suppressed: false, reason: "" }),
          socialCanTrigger: () => ({ allowed: true, reason: "test" }),
        });
        assert.equal(decision.verdict, "delivered");
        assert.notEqual(decision.utility?.branch, "silence");
      },
      { client: fakeClient() },
    );
  } finally {
    if (savedScope === undefined) delete process.env.AGENT_COMMITMENT_EXTRACT_SCOPE;
    else process.env.AGENT_COMMITMENT_EXTRACT_SCOPE = savedScope;
  }
});

test("e2e：scope=high 灰度回退档——低信号写入不触发承诺抽取", async () => {
  const savedScope = process.env.AGENT_COMMITMENT_EXTRACT_SCOPE;
  process.env.AGENT_COMMITMENT_EXTRACT_SCOPE = "high";
  try {
    await withE2e(
      async ({ ingest, board }) => {
        await ingest.ingestText("user-e2e", "chat:turn-1", "明天发你", { context: "main" });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(board.list({ status: ["active", "pending_confirmation", "candidate"] }).length, 0);
      },
      { client: fakeClient() },
    );
  } finally {
    if (savedScope === undefined) delete process.env.AGENT_COMMITMENT_EXTRACT_SCOPE;
    else process.env.AGENT_COMMITMENT_EXTRACT_SCOPE = savedScope;
  }
});

test("e2e：高信号但决策 reject——承诺照抓、记忆不落（解耦的另一面）", async () => {
  await withE2e(
    async ({ ingest, board, mem0Writes }) => {
      await ingest.ingestText("user-e2e", "chat:turn-2", "我答应周五前把报价发给客户", {
        highSignal: true,
        context: "main",
      });
      await waitFor(() => board.list({ status: ["active"] }).length > 0);
      assert.equal(board.list({ status: ["active"] })[0]!.committedBy, "user");
      assert.equal(mem0Writes.count, 0, "reject 决策不写 Mem0，承诺不受影响");
    },
    {
      client: fakeClient({
        decision: "reject",
        memories: [],
      }),
    },
  );
});
