/**
 * fast 车道统一出口仲裁（2026-09-02）行为测试。
 *
 * 背景：fast 车道「调了工具但失败」的轮次曾被所有兜底漏掉——升级保底判据是
 * 「零工具执行」（失败执行也计数 → 丧失升级资格），波次耗尽的 schema-less
 * summary 路径又完全绕过收尾检查。真实案例「帮我搜索景甜的照片」：search_images
 * 失败 → 模型拿机制话收场，无重试、无升级。
 *
 * 覆盖场景：
 *   A. 媒体诉求 + search_images 失败 → 出口仲裁升级 complex（哨兵携带尝试记录）
 *   B. search_images 成功 → 真实工具执行 + 正常收尾（不升级）
 *   C. 失败换路预算：失败后 fast 追加 1 波，search_web 重试真实执行并成功
 *   D. 零工具 + 联网诉求：强制联网重试一次后仍不满足 → 升级（旧保底行为保留）
 *   E. 升级继承负载：哨兵构造/解析/格式化回环
 *
 * 用 mock LLM client（脚本化 chunk 流）+ 真实 executeTool 执行器驱动，
 * 断言工具是否被「真实调用」而非仅出现在模型文本里。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-arbiter-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  buildEscalationSentinel,
  parseEscalationPayload,
  formatEscalationAttempts,
  isEscalationSignal,
  ESCALATION_SENTINEL,
} = await import("../src/tools/escalation-tool.js");

/* ---------------- mock LLM client（脚本化 chunk 流） ---------------- */

type AnyChunk = Record<string, unknown>;

function textChunks(text: string): AnyChunk[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { choices: [{ delta: { content: text.slice(0, mid) }, finish_reason: null }] },
    { choices: [{ delta: { content: text.slice(mid) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function toolCallChunks(calls: Array<{ id: string; name: string; args: object }>): AnyChunk[] {
  const chunks: AnyChunk[] = [];
  calls.forEach((c, i) => {
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: i,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  return chunks;
}

function makeFakeClient(script: AnyChunk[][]) {
  let i = 0;
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          const chunks = script[Math.min(i, script.length - 1)];
          i += 1;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, requests };
}

/* ---------------- 场景数据 ---------------- */

function tool(name: string, desc: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: desc,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  };
}

const TOOLS: ChatCompletionTool[] = [
  tool("search_web", "联网搜索公开网页信息（标题/摘要/链接）"),
  tool("search_images", "图片搜索：按关键词返回真实图片列表"),
];

const HEDGE_REPLY =
  "王哥，景甜的照片啊，我这边图片搜索那条路这次没打通，翻不到她现在的近照。想看她的照片，最稳的还是直接去她微博那边翻。";
const FINAL_ANSWER = "查到了。景甜工作室刚发了新剧路透图，我挑了三张清晰的，点开就能看。";

function makeMessages(userText: string) {
  return [
    { role: "system", content: "你是用户的私人助理，回答风格短句口语化。" },
    { role: "user", content: userText },
  ];
}

/**
 * 执行器：默认全部成功；`fail` 列表中的工具真实执行失败（会触发内置的
 * 非超时失败确定性重试 1 次，即单次失败调用 = 2 次真实执行）。
 */
function makeCtx(opts?: { fail?: string[] }) {
  const executed: Array<{ name: string; args: Record<string, unknown>; ok: boolean }> = [];
  const fail = new Set(opts?.fail ?? []);
  return {
    ctx: {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        if (fail.has(name)) {
          executed.push({ name, args, ok: false });
          return { ok: false, result: { error: "图片搜索上游超时 (upstream 504)" } };
        }
        executed.push({ name, args, ok: true });
        return {
          ok: true,
          result: {
            items: [
              { title: "景甜新剧路透", url: "https://example.com/a", snippet: "工作室发布" },
            ],
          },
        };
      },
    },
    executed,
  };
}

/* ---------------- A. 媒体诉求 + 图片搜索失败 → 出口仲裁升级 ---------------- */

test("A. search_images 失败 + 媒体诉求 → 出口仲裁升级，哨兵携带尝试记录", async () => {
  const { client, requests } = makeFakeClient([
    // wave 0：模型调用 search_images（真实执行器返回失败）
    toolCallChunks([{ id: "call_a1", name: "search_images", args: { query: "景甜 近照" } }]),
    // wave 1：模型拿机制话收场（复刻线上真实回复形态）
    textChunks(HEDGE_REPLY),
  ]);

  const { ctx, executed } = makeCtx({ fail: ["search_images"] });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我找景甜的照片") as never,
    () => {},
    ctx,
    {
      tools: TOOLS as never,
      maxRounds: 2,
      extraBody: { fastProfile: true },
      audit: { sessionId: "arb-images-fail" },
    },
  );

  // 工具被真实调用（失败 + 内置确定性重试 1 次 = 2 次真实执行）
  assert.equal(executed.length, 2, "search_images 应被真实执行（失败 + 确定性重试）");
  assert.equal(executed.every((e) => !e.ok), true, "两次执行均失败");
  // 收尾不是机制话，而是升级哨兵
  assert.equal(isEscalationSignal(out), true, `应返回升级哨兵，实际: ${out.slice(0, 60)}`);
  const payload = parseEscalationPayload(out);
  assert.ok(payload, "哨兵应可解析");
  assert.equal(payload.attempts.length, 1);
  assert.equal(payload.attempts[0].tool, "search_images");
  assert.equal(payload.attempts[0].ok, false);
  assert.ok(payload.attempts[0].input?.includes("景甜"), "尝试记录应携带关键入参");
});

/* ---------------- B. 图片搜索成功 → 真实执行 + 正常收尾 ---------------- */

test("B. search_images 成功 → 工具真实执行，正常收尾不升级", async () => {
  const { client } = makeFakeClient([
    // wave 0：search_images 成功
    toolCallChunks([{ id: "call_b1", name: "search_images", args: { query: "景甜 近照" } }]),
    // 充分性探测（无 schema 汇总）：正常回答
    textChunks(FINAL_ANSWER),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我找景甜的照片") as never,
    () => {},
    ctx,
    {
      tools: TOOLS as never,
      maxRounds: 2,
      extraBody: { fastProfile: true },
      audit: { sessionId: "arb-images-ok" },
    },
  );

  assert.equal(executed.length, 1, "search_images 应被真实执行 1 次");
  assert.equal(executed[0].ok, true);
  assert.equal(isEscalationSignal(out), false, "工具成功满足诉求，不应升级");
  assert.ok(out.includes("路透"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
});

/* ---------------- C. 失败换路预算：失败后追加 1 波，换工具重试成功 ---------------- */

test("C. search_images 失败后换 search_web 重试：失败换路预算生效，重试轮带 schema", async () => {
  const { client, requests } = makeFakeClient([
    // wave 0：search_images 失败（+内置确定性重试）
    toolCallChunks([{ id: "call_c1", name: "search_images", args: { query: "景甜 近照" } }]),
    // wave 1：再次失败——在原始 maxRounds=2 内波次已耗尽
    toolCallChunks([{ id: "call_c2", name: "search_images", args: { query: "景甜 工作室" } }]),
    // wave 2（只有失败换路预算才存在的波次）：模型换 search_web，成功
    toolCallChunks([{ id: "call_c3", name: "search_web", args: { query: "景甜 最新 消息" } }]),
    // 充分性探测（无 schema 汇总）：正常回答
    textChunks(FINAL_ANSWER),
  ]);

  const { ctx, executed } = makeCtx({ fail: ["search_images"] });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我搜索景甜的照片") as never,
    () => {},
    ctx,
    {
      tools: TOOLS as never,
      maxRounds: 2,
      extraBody: { fastProfile: true },
      audit: { sessionId: "arb-retry-budget" },
    },
  );

  // 换路重试真实执行：search_images 失败×2 波（各含重试）→ search_web 成功 1 次
  assert.equal(
    executed.length,
    5,
    `应真实执行 5 次，实际: ${JSON.stringify(executed.map((e) => [e.name, e.args.query, e.ok]))}`,
  );
  assert.equal(executed.filter((e) => e.name === "search_web").length, 1, "search_web 应真实执行 1 次");
  assert.equal(isEscalationSignal(out), false, "重试成功拿到实质结果，不应升级");
  assert.ok(out.includes("路透"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
  // 硬证据：第 3 轮（wave 2）是带 schema 的规划轮——没有失败换路预算时
  // wave 1 结束即波次耗尽，第 3 轮会是无 schema 的 summary（requests[2].tools === undefined）
  assert.ok(Array.isArray(requests[2]?.tools), "第 3 轮应为带 schema 的规划轮（失败换路预算生效）");
});

/* ---------------- D. 零工具 + 联网诉求：强制联网重试后仍不满足 → 升级 ---------------- */

test("D. 零工具 + 联网诉求：强制联网重试一次仍不满足 → 出口仲裁升级", async () => {
  const HEDGE_NO_DATA = "王哥，这个我手头没有现成数据，暂时答不了你。";
  const { client, requests } = makeFakeClient([
    // wave 0：模型一个工具都不调，直接含糊作答
    textChunks(HEDGE_NO_DATA),
    // 强制联网重试轮：模型仍然不调工具、继续含糊
    textChunks(HEDGE_NO_DATA),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我查一下景甜最近在忙什么") as never,
    () => {},
    ctx,
    {
      tools: TOOLS as never,
      maxRounds: 2,
      extraBody: { fastProfile: true },
      audit: { sessionId: "arb-zero-tool" },
    },
  );

  assert.equal(executed.length, 0, "模型始终未调工具");
  assert.equal(isEscalationSignal(out), true, `含糊收场应升级 complex，实际: ${out.slice(0, 60)}`);
  const payload = parseEscalationPayload(out);
  assert.ok(payload);
  assert.equal(payload.attempts.length, 0, "无工具执行 → 尝试记录为空");
  // 强制联网重试确实发生过（system 注入出现任一请求中）
  const injected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("fresh web evidence"),
  );
  assert.ok(injected, "升级前应先给过一次轨迹内强制联网重试");
});

/* ---------------- E. 升级继承负载：构造/解析/格式化回环 ---------------- */

test("E. 升级哨兵负载：构造 → 解析 → 格式化回环", () => {
  // 纯哨兵向后兼容
  assert.equal(isEscalationSignal(ESCALATION_SENTINEL), true);
  assert.equal(parseEscalationPayload(ESCALATION_SENTINEL)?.attempts.length, 0);

  const attempts = [
    { tool: "search_images", ok: false, input: "景甜 近照", detail: "图片搜索上游超时 (upstream 504)" },
    { tool: "search_web", ok: true, input: "景甜 最新 消息" },
  ];
  const sentinel = buildEscalationSentinel(attempts);
  assert.equal(isEscalationSignal(sentinel), true);
  const parsed = parseEscalationPayload(sentinel);
  assert.ok(parsed);
  assert.equal(parsed.attempts.length, 2);
  assert.equal(parsed.attempts[0].tool, "search_images");
  assert.equal(parsed.attempts[1].ok, true);

  // 正常回复文本绝不会被误判为升级
  assert.equal(isEscalationSignal("好的，2分钟后叫你睡觉哦"), false);
  assert.equal(parseEscalationPayload("正常回复"), null);

  // 格式化输出供 complex prompt 注入
  const block = formatEscalationAttempts(attempts);
  assert.ok(block.includes("1. search_images(景甜 近照) → 执行失败：图片搜索上游超时"));
  assert.ok(block.includes("2. search_web(景甜 最新 消息) → 执行成功但未满足诉求"));
});
