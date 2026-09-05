/**
 * 统一出口自检 TurnOutcomeGate（2026-09-05 双面架构）行为测试。
 *
 * 旧契约（2026-09-02 车道内升级）已退役：fast 车道出口仲裁返回升级哨兵 →
 * agent-core 删线程整轮重放 complex。新契约：
 *   - 只有任务面进工具循环（对话面零工具）；
 *   - 出口自检不分车道：「诉求未满足」∧ 预算有余 → 注入一次换路续波指令，
 *     在原轨迹内纠错；预算耗尽 → 如实收尾（honest），不再有哨兵/重放。
 *
 * 覆盖场景：
 *   A. 媒体诉求 + search_images 失败 → 出口自检换路续波（不产生哨兵），
 *      模型换 search_web 拿到真实结果后收尾
 *   B. search_images 成功 → 真实工具执行 + 正常收尾（不触发自检）
 *   C. 失败换路预算：失败后追加 1 波，重试轮带 schema（预算行为保留）
 *   D. 零工具调用 + 联网诉求：强制联网重试一次仍不满足 → 换路续波一次，
 *      预算耗尽后如实收尾（不再返回哨兵）
 *   E. escalate 哨兵工具已从工具集中移除
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

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-gate-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

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

/* ---------------- A. 媒体诉求 + 图片搜索失败 → 出口自检换路续波 ---------------- */

test("A. search_images 失败 + 媒体诉求 → 出口自检换路续波，search_web 拿到真实结果后收尾", async () => {
  const { client, requests } = makeFakeClient([
    // wave 0：模型调用 search_images（真实执行器返回失败）
    toolCallChunks([{ id: "call_a1", name: "search_images", args: { query: "景甜 近照" } }]),
    // wave 1：模型拿机制话收场（复刻线上真实回复形态）→ 出口自检判「诉求未满足」
    textChunks(HEDGE_REPLY),
    // wave 2（出口自检换路续波）：模型换 search_web，成功
    toolCallChunks([{ id: "call_a2", name: "search_web", args: { query: "景甜 最新 照片" } }]),
    // 充分性探测（无 schema 汇总）：正常回答
    textChunks(FINAL_ANSWER),
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
      maxRounds: 4,
      extraBody: { fastProfile: true },
      audit: { sessionId: "gate-images-fail" },
    },
  );

  // search_images 真实执行失败（+确定性重试）→ 出口自检续波 → search_web 真实成功
  assert.equal(
    executed.some((e) => e.name === "search_images" && !e.ok),
    true,
    "search_images 应被真实执行且失败",
  );
  assert.equal(
    executed.some((e) => e.name === "search_web" && e.ok),
    true,
    `出口自检后应换 search_web 真实执行，实际: ${JSON.stringify(executed.map((e) => [e.name, e.ok]))}`,
  );
  // 不再产生升级哨兵——拿到真实结果后正常收尾
  assert.ok(!out.includes("__ESCALATE_TO_COMPLEX__"), "不得返回升级哨兵");
  assert.ok(out.includes("路透"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
  // 出口自检的换路指令确实注入过
  const injected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("出口自检"),
  );
  assert.ok(injected, "续波前应注入出口自检换路指令");
});

/* ---------------- B. 图片搜索成功 → 真实执行 + 正常收尾 ---------------- */

test("B. search_images 成功 → 工具真实执行，正常收尾不触发自检", async () => {
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
      audit: { sessionId: "gate-images-ok" },
    },
  );

  assert.equal(executed.length, 1, "search_images 应被真实执行 1 次");
  assert.equal(executed[0].ok, true);
  assert.ok(out.includes("路透"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
});

/* ---------------- C. 失败换路预算：失败后追加 1 波，重试轮带 schema ---------------- */

test("C. 失败换路预算保留：失败后追加 1 波，重试轮带 schema", async () => {
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
      audit: { sessionId: "gate-retry-budget" },
    },
  );

  // 换路重试真实执行：search_images 失败×2 波（各含重试）→ search_web 成功 1 次
  assert.equal(
    executed.length,
    5,
    `应真实执行 5 次，实际: ${JSON.stringify(executed.map((e) => [e.name, e.args.query, e.ok]))}`,
  );
  assert.equal(executed.filter((e) => e.name === "search_web").length, 1, "search_web 应真实执行 1 次");
  assert.ok(!out.includes("__ESCALATE_TO_COMPLEX__"), "不得返回升级哨兵");
  // 硬证据：第 3 轮（wave 2）是带 schema 的规划轮——没有失败换路预算时
  // wave 1 结束即波次耗尽，第 3 轮会是无 schema 的 summary（requests[2].tools === undefined）
  assert.ok(Array.isArray(requests[2]?.tools), "第 3 轮应为带 schema 的规划轮（失败换路预算生效）");
});

/* ---------------- D. 零工具调用 + 道歉式收场：续波后仍不满足 → 如实收尾 ---------------- */

test("D. 零工具 + 道歉式收场：出口自检续波后仍不满足 → 如实收尾（不再有哨兵）", async () => {
  const HEDGE_NO_DATA = "王哥，这个我手头没有现成数据，暂时答不了你。";
  const { client, requests } = makeFakeClient([
    // wave 0：模型一个工具都不调，含糊作答 → 出口自检判「诉求未满足」
    textChunks(HEDGE_NO_DATA),
    // 出口自检换路续波：模型仍然不调工具、继续含糊
    textChunks(HEDGE_NO_DATA),
    // 再次含糊 → 预算耗尽，如实收尾
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
      audit: { sessionId: "gate-zero-tool" },
    },
  );

  assert.equal(executed.length, 0, "模型始终未调工具");
  assert.ok(!out.includes("__ESCALATE_TO_COMPLEX__"), "预算耗尽后应如实收尾，不得返回哨兵");
  // 出口自检换路指令发生过（话题无关：判定只看「无实质成功结果 + 道歉式风格」）
  const gateNudge = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("出口自检"),
  );
  assert.ok(gateNudge, "应给过一次出口自检换路续波");
  // 预算封顶：续波后不再无限循环（调用数有界）
  assert.ok(requests.length <= 5, `调用数应有界，实际 ${requests.length}`);
});

/* ---------------- E. escalate 哨兵工具已移除 ---------------- */

test("E. escalate 哨兵机制退役：fastLane 工具集与常驻列表不再包含它", async () => {
  const { getFastLaneTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const names = getFastLaneTools().map(
    (t) => (t as { function?: { name?: string } }).function?.name ?? "",
  );
  assert.equal(
    names.includes("agent.escalate_to_complex"),
    false,
    "fastLane 工具集不得再包含 escalate 工具",
  );
});
