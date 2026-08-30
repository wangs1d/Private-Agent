/**
 * 记忆召回回归测试基准（memory recall benchmark）
 *
 * 目的：给"召回是否准确 / 是否串台"一个可量化、可回归的裁判。
 * 2026-08 前后串台问题反复修补（recall-gate / GLOBAL_MEMORY_RULE / prompt-assembler
 * 家族合并），但一直没有客观指标——本基准填充这个空缺。
 *
 * 覆盖维度与记分：
 *   A. 换说法召回（recall）：用户换个说法问，已存事实能否被召回；
 *   B. 无关不误召回（precision）：与已存事实无关的查询，不得带出个人事实；
 *   C. 跨用户隔离（isolation）：A 用户的事实绝不能被 B 用户召回（串台防护）；
 *   D. 冲突/时效覆盖：新事实与旧事实冲突时的行为（当前为已知缺口，见下）。
 *
 * 运行：cd server && npx tsx --test test/memory-recall-benchmark.test.ts
 *
 * 设计约束：
 *   - 完全离线封闭：夹具摘除全部 LLM/embedding 密钥环境变量，
 *     检索走关键词 + cosineLikeScore 降级路径，任何机器结果一致；
 *   - 用例使用真实生活语料（符合产品定位：生活管家），查询用自然口语换说法，
 *     保留必要的词面重叠（离线通道依赖关键词重叠，真 embedding 上线后可放宽）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HumanLikeMemoryService,
  type HumanLikeMemoryStoreShape,
} from "../src/services/human-like-memory-service.js";

// ── 环境封闭：与 human-like-memory-dreaming.test.ts 同源 ─────────────────────
const LLM_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_EMBEDDINGS_MODEL",
  "AGENT_EMBEDDING_API_KEY",
  "MOONSHOT_API_KEY",
  "EXTERNAL_MODEL_PROVIDER",
  "EXTERNAL_MODEL_FAILOVER_CHAIN",
] as const;

async function withMemoryService(
  fn: (service: HumanLikeMemoryService, store: () => HumanLikeMemoryStoreShape) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-benchmark-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  for (const key of LLM_ENV_KEYS) delete process.env[key];
  const service = new HumanLikeMemoryService(join(dir, "memory.json"), join(dir, "policy.json"));
  try {
    await service.load();
    const store = (): HumanLikeMemoryStoreShape =>
      (service as unknown as { store: HumanLikeMemoryStoreShape }).store;
    await fn(service, store);
  } finally {
    await service.shutdown();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── 断言辅助 ────────────────────────────────────────────────────────────────

/** 召回并把 recalledNodeIds 映射为可读 summary 列表 */
async function recallSummaries(
  service: HumanLikeMemoryService,
  store: () => HumanLikeMemoryStoreShape,
  actorId: string,
  query: string,
): Promise<string[]> {
  const result = await service.buildRecall(actorId, query, { crossDomain: true });
  return result.recalledNodeIds.map((id) => store().nodes[id]?.summary ?? id);
}

// ── A. 换说法召回（recall）───────────────────────────────────────────────────
// 生活域语料：用户陈述事实 → 数轮之后用不同说法询问 → 事实必须被召回。

interface RecallCase {
  /** 用户陈述（ingest 原文） */
  tell: string;
  /** 之后的自然询问（换说法） */
  ask: string;
  /** 必须被召回的事实包含的关键词（在原陈述中应可识别） */
  expectKeyword: string;
}

const RECALL_CASES: RecallCase[] = [
  {
    tell: "我对芒果过敏，吃了会起疹子",
    ask: "我有什么过敏的东西吗",
    expectKeyword: "芒果",
  },
  {
    // 离线通道依赖词面重叠（真 embedding 上线后可换成完全无重叠的说法）
    tell: "我每天早上七点起床跑步半小时",
    ask: "我早上跑步的习惯是什么样",
    expectKeyword: "跑步",
  },
  {
    tell: "我家 wifi 密码是 cafe1234",
    ask: "我家 wifi 的密码是多少",
    expectKeyword: "cafe1234",
  },
  {
    tell: "我妻子叫林晓雨，她是一名小学老师",
    ask: "我妻子叫什么名字来着",
    expectKeyword: "林晓雨",
  },
  {
    tell: "我在杭州一家互联网公司做后端开发",
    ask: "我在杭州做什么工作来着",
    expectKeyword: "后端",
  },
  {
    tell: "我养了一只叫团子的橘猫，它今年三岁",
    ask: "我家团子今年几岁了",
    expectKeyword: "团子",
  },
  {
    tell: "每周五晚上我都要给父母打电话",
    ask: "我要什么时候给父母打电话",
    expectKeyword: "周五",
  },
];

test("基准 A：换说法召回（recall）", async () => {
  await withMemoryService(async (service, store) => {
    const actor = "bench-recall";
    for (const c of RECALL_CASES) {
      await service.ingest(actor, c.tell, "chat:user", {
        metadata: { salience: 0.8, userImportance: 0.7 },
      });
    }

    const misses: string[] = [];
    for (const c of RECALL_CASES) {
      const summaries = await recallSummaries(service, store, actor, c.ask);
      const hit = summaries.some((s) => s.includes(c.expectKeyword));
      if (!hit) {
        misses.push(`ask="${c.ask}" 未召回含 "${c.expectKeyword}" 的事实（召回: ${JSON.stringify(summaries)}）`);
      }
    }

    const score = RECALL_CASES.length - misses.length;
    console.log(
      `[MemoryRecallBenchmark] A.换说法召回: ${score}/${RECALL_CASES.length}`,
    );
    assert.deepEqual(misses, []);
  });
});

// ── B. 无关不误召回（precision）──────────────────────────────────────────────

const PRECISION_QUERIES = [
  "今天天气怎么样",
  "帮我讲个笑话",
  "现在几点了",
];

test("基准 B：无关查询不误召回个人事实（precision）", async () => {
  await withMemoryService(async (service, store) => {
    const actor = "bench-precision";
    await service.ingest(actor, "我对芒果过敏，吃了会起疹子", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });
    await service.ingest(actor, "我养了一只叫团子的橘猫", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.7 },
    });

    const leaks: string[] = [];
    for (const query of PRECISION_QUERIES) {
      const summaries = await recallSummaries(service, store, actor, query);
      const leaked = summaries.filter(
        (s) => s.includes("芒果") || s.includes("团子") || s.includes("橘猫"),
      );
      if (leaked.length > 0) {
        leaks.push(`query="${query}" 误召回: ${JSON.stringify(leaked)}`);
      }
    }

    const score = PRECISION_QUERIES.length - leaks.length;
    console.log(`[MemoryRecallBenchmark] B.无关不误召回: ${score}/${PRECISION_QUERIES.length}`);
    assert.deepEqual(leaks, []);
  });
});

// ── C. 跨用户隔离（isolation / 串台防护）────────────────────────────────────

test("基准 C：跨用户记忆隔离（串台防护）", async () => {
  await withMemoryService(async (service, store) => {
    // 用户 A 的私人事实
    await service.ingest("bench-user-a", "我对芒果过敏，吃了会起疹子", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });
    await service.ingest("bench-user-a", "我妻子叫林晓雨，她是一名小学老师", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });
    // 用户 B 自己的事实
    await service.ingest("bench-user-b", "我在成都做产品经理", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });

    // B 问 A 才有答案的问题 → 不得召回 A 的记忆
    const bAskAOnly = await recallSummaries(service, store, "bench-user-b", "我有什么过敏的东西吗");
    assert.deepEqual(
      bAskAOnly.filter((s) => s.includes("芒果") || s.includes("林晓雨")),
      [],
      `B 召回了 A 的私人事实（串台）: ${JSON.stringify(bAskAOnly)}`,
    );

    // B 问自己领域的问题 → 只召回自己的
    const bAskOwn = await recallSummaries(service, store, "bench-user-b", "我的职业是什么");
    assert.deepEqual(
      bAskOwn.filter((s) => s.includes("林晓雨") || s.includes("芒果")),
      [],
      `B 的召回混入了 A 的事实: ${JSON.stringify(bAskOwn)}`,
    );

    console.log("[MemoryRecallBenchmark] C.跨用户隔离: 2/2");
  });
});

// ── D. 冲突/时效覆盖（已知缺口，显式跟踪）───────────────────────────────────
//
// 已知缺口：2026-08 记忆架构重构移除了偏好变更检测——新旧事实作为独立节点
// 共存（均 active/unknown），不创建 "updates" 边、不降权旧事实（见
// human-like-memory-dreaming.test.ts 的对应用例）。
// 因此下面的场景当前无法断言"以新事实为准"。用 test({ skip }) 显式挂账，
// 偏好变更检测重新落地后取消 skip 即成为回归门禁。

test("基准 D：冲突事实应以新为准（已知缺口：偏好变更检测已移除）", { skip: "已知缺口：新设计移除偏好变更检测，新旧事实共存且旧事实不降权" }, async () => {
  await withMemoryService(async (service, store) => {
    const actor = "bench-conflict";
    await service.ingest(actor, "我住在北京", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });
    await service.ingest(actor, "我最近搬到上海定居了", "chat:user", {
      metadata: { salience: 0.8, userImportance: 0.8 },
    });

    const summaries = await recallSummaries(service, store, actor, "我住在哪个城市");
    const newFactFirst = summaries.findIndex((s) => s.includes("上海"));
    const oldFactIndex = summaries.findIndex((s) => s.includes("北京"));
    assert.ok(newFactFirst >= 0, "新事实应被召回");
    assert.ok(
      oldFactIndex === -1 || newFactFirst < oldFactIndex,
      "新事实应排在旧事实之前",
    );
  });
});
