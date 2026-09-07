/**
 * 召回精排器单测（P1）。
 *
 * 覆盖：off 恒等降级、llm 档 listwise 解析（正常/围栏/缺项/垃圾输出）、
 * api 档 Jina/Cohere 风格响应解析、超时降级、端点失败降级。
 * 测试封闭：LLM 注入 fake client；api 档 stub 全局 fetch；不依赖外部服务。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { rerankTexts } from "../src/agentic-memory/reranker.js";
import type { RerankLlmClient } from "../src/agentic-memory/reranker.js";

function makeLlmClient(output: string, calls: string[] = []): RerankLlmClient {
  return {
    chat: {
      completions: {
        async create(args) {
          calls.push(args.messages.map((m) => m.content).join("\n"));
          return { choices: [{ message: { content: output } }] };
        },
      },
    },
  };
}

const TEXTS = ["用户喜欢在周末爬山", "用户养了一只猫", "用户住在杭州"];

test("rerank：mode=off 恒等降级返回 null", async () => {
  const out = await rerankTexts("周末爬山", TEXTS, { mode: "off" });
  assert.equal(out, null);
});

test("rerank：空 query / 空候选返回 null；单候选返回恒等", async () => {
  assert.equal(await rerankTexts("  ", TEXTS, { mode: "llm" }), null);
  assert.equal(await rerankTexts("q", [], { mode: "llm" }), null);
  const single = await rerankTexts("q", ["唯一候选"], { mode: "off" });
  assert.deepEqual(single, [{ index: 0, relevance: 1 }]);
});

test("rerank：llm 档正常 JSON → 按 relevance 降序", async () => {
  const calls: string[] = [];
  const client = makeLlmClient(
    '{"scores":[{"index":2,"score":0.1},{"index":1,"score":0.95},{"index":3,"score":0.4}]}',
    calls,
  );
  const out = await rerankTexts("周末去哪玩", TEXTS, { mode: "llm", client });
  assert.ok(out, "应成功解析");
  assert.equal(out![0].index, 0, "LLM 输出 1-based index:1 → 0-based 0，最高分候选排第一");
  assert.equal(out![0].relevance, 0.95);
  assert.equal(out![1].index, 2, "次高分 index:3 → 0-based 2");
  assert.ok(calls[0]!.includes("周末去哪玩"), "query 进入 prompt");
  assert.ok(calls[0]!.includes("3. 用户住在杭州"), "候选编号进入 prompt");
});

test("rerank：llm 档容忍 ``` 围栏与前后杂文", async () => {
  const client = makeLlmClient('好的，结果如下：\n```json\n{"scores":[{"index":1,"score":0.9},{"index":2,"score":0.2},{"index":3,"score":0.5}]}\n```\n以上。');
  const out = await rerankTexts("query", TEXTS, { mode: "llm", client });
  assert.ok(out);
  assert.equal(out![0].index, 0);
});

test("rerank：llm 档缺打候选补 0 分（由调用方阈值闸决定去留）", async () => {
  const client = makeLlmClient('{"scores":[{"index":2,"score":1.0}]}');
  const out = await rerankTexts("query", TEXTS, { mode: "llm", client });
  assert.ok(out);
  assert.equal(out!.length, 3, "全部候选都有分数");
  assert.equal(out![out!.length - 1]!.relevance, 0);
});

test("rerank：llm 档垃圾输出/异常 → null 降级", async () => {
  const garbage = makeLlmClient("我觉得都挺相关的");
  assert.equal(await rerankTexts("query", TEXTS, { mode: "llm", client: garbage }), null);
  const throwing: RerankLlmClient = {
    chat: {
      completions: {
        async create() {
          throw new Error("boom");
        },
      },
    },
  };
  assert.equal(await rerankTexts("query", TEXTS, { mode: "llm", client: throwing }), null);
});

const ENDPOINT_ENV = "AGENT_MEMORY_RERANKER_ENDPOINT";

/** api 档需要端点配置：临时设置并测试后恢复 */
async function withApiEndpoint(fn: () => Promise<void>): Promise<void> {
  const saved = process.env[ENDPOINT_ENV];
  process.env[ENDPOINT_ENV] = "https://rerank.example.com/v1/rerank";
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[ENDPOINT_ENV];
    else process.env[ENDPOINT_ENV] = saved;
  }
}

test("rerank：api 档解析 Jina/Cohere 风格响应", async () => {
  await withApiEndpoint(async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url, init) => {
        assert.ok(String(init?.body).includes('"query"'), "POST body 携带 query");
        return new Response(
          JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.1 }] }),
          { status: 200 },
        );
      }) as typeof fetch;
      const out = await rerankTexts("query", TEXTS, {
        mode: "api",
        timeoutMs: 500,
        model: "bge-reranker-v2-m3",
      });
      assert.ok(out);
      assert.equal(out![0].index, 2);
      assert.equal(out![2].index, 1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test("rerank：api 档缺端点配置 → null；端点失败/超时 → null 降级（不阻塞召回）", async () => {
  const savedFetch = globalThis.fetch;
  try {
    // 未配置端点：api 档直接降级，不发请求
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    assert.equal(await rerankTexts("query", TEXTS, { mode: "api", timeoutMs: 200 }), null);
    assert.equal(called, false, "缺端点不应发起请求");
    if (saved !== undefined) process.env[ENDPOINT_ENV] = saved;

    await withApiEndpoint(async () => {
      // 端点 500
      globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
      assert.equal(await rerankTexts("query", TEXTS, { mode: "api", timeoutMs: 200 }), null);
      // 永不响应 → 超时
      globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
      const started = Date.now();
      const out = await rerankTexts("query", TEXTS, { mode: "api", timeoutMs: 30 });
      assert.equal(out, null);
      assert.ok(Date.now() - started < 2_000, "超时后应立即返回");
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});
