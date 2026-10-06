// 行动宣告兜底下线 · 静态架构行为回归（2026-10-06）。
//
// 背景：出口闸曾有「行动宣告未兑现」分支——文本正则判「模型只承诺要查/办但没调
// 工具」→ 注入指控指令强制续波。误伤两次（高危闸 substring、宣告闸「别让我看」
// 强制续波逼出凭空辩解泡「我没要查什么——…没在答应办事」），且工具调用质量
// 已由语义路由+出口自检（服务端事实判定）承担。经用户拍板整体下线。
//
// 契约：零工具轮一律单次调用收尾——无论回复措辞是否像「宣告」，都不再注入任何
// 宣告指控指令；其余出口闸分支（写意图/实时媒体意图/尝试全败/无正文）不受影响。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "announce-gate-removed-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOOL_ARCH = "static";
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

type AnyChunk = Record<string, unknown>;

function textChunks(text: string): AnyChunk[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { choices: [{ delta: { content: text.slice(0, mid) }, finish_reason: null }] },
    { choices: [{ delta: { content: text.slice(mid) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
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

function makeCtx() {
  return {
    ctx: {
      executeTool: async () => ({ ok: true, result: { items: [] } }),
    },
  };
}

const MESSAGES = [
  { role: "system", content: "你是用户的私人助理，回答风格短句口语化。" },
  { role: "user", content: "我就存" },
] as never;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "联网搜索公开网页信息（标题/摘要/链接）",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
] as never;

test("事故场景回归：否定语境回复零工具 → 单次调用收尾，无任何注入", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("行，你存。存了别让我看。\n\n不过话说回来，一点半了，明天不用早起？"),
  ]);
  const { ctx } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    MESSAGES,
    () => {},
    ctx,
    { tools: TOOLS, maxRounds: 4, audit: { sessionId: "announce-incident" } } as never,
  );

  assert.ok(out.includes("别让我看"), `原回复应原样收尾，实际: ${out.slice(0, 60)}`);
  assert.equal(requests.length, 1, `应单次调用收尾，实际 ${requests.length} 次调用`);
  const injected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("宣告"),
  );
  assert.ok(!injected, "不得注入任何宣告指控指令");
});

test("兜底下线：真实承诺措辞零工具也单次收尾（不再判措辞）", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("好，我这就去查一下比特币现在的价格。"),
  ]);
  const { ctx } = makeCtx();
  await streamCompletionWithTools(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是用户的私人助理。" },
      { role: "user", content: "比特币现在什么价格" },
    ] as never,
    () => {},
    ctx,
    { tools: TOOLS, maxRounds: 4, audit: { sessionId: "announce-removed" } } as never,
  );

  assert.equal(
    requests.length,
    1,
    `宣告兜底已下线，措辞不再触发续波，实际 ${requests.length} 次调用`,
  );
  const injected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("宣告"),
  );
  assert.ok(!injected, "不得注入宣告指控指令");
});
