/**
 * 零工具出口闸扩面 + 显式禁网开关 E2E（2026-09-23 工具自决权改造验收）。
 *
 * 真实组件：streamCompletionWithTools 波次循环（真实闸逻辑）/ ToolRegistry /
 * web-search-consent / buildLaneCoreTools。mock 的只有 LLM（脚本化流式响应）。
 *
 * 场景：
 *   A realtime 意图 + 零工具 + 无证据 → 闸触发续波（realtime_intent_never_attempted）
 *   B realtime 意图 + 零工具 + 证据已注入 → 豁免（证据即答案，不空转）
 *   C media 意图 + 零工具 + 无证据 → 闸触发（media_intent_never_attempted）
 *   D write 意图 + 零工具 → 原闸保持（write_intent_never_attempted，回归）
 *   E 显式禁网识别：肯定/否定用例
 *   F 禁网过滤：chat Core 剥离联网族、保留本地工具
 *
 * 用法：npx tsx scripts/e2e-zero-tool-gate.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || mkdtempSync(join(tmpdir(), "pa-e2e-gate-"));
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";

/* ---------------- 真实模块 ---------------- */
const { streamCompletionWithTools, getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { isExplicitNoWebRequest, filterWebSearchTools } = await import(
  "../src/agent/web-search-consent.js"
);
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { TASK_CANCEL_TOOL_DEFINITION, TASK_STATUS_TOOL_DEFINITION } = await import(
  "../src/tools/task-plane-tools.js"
);
const { PERCEPTION_OVERVIEW_TOOL_DEFINITION } = await import("../src/tools/perception-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

/* ---------------- turn-trace 捕获 ---------------- */
const originalConsoleInfo = console.info;
const traces: any[] = [];
console.info = ((...args: unknown[]) => {
  const line = String(args[0] ?? "");
  if (line.startsWith("[turn-trace] ")) {
    try {
      traces.push(JSON.parse(line.slice("[turn-trace] ".length)));
    } catch {}
  }
  return originalConsoleInfo(...args);
}) as typeof console.info;

/* ---------------- 真实 ToolRegistry（少而真的执行器） ---------------- */
const registry = new ToolRegistry() as any;
registry.register("search_web", async (input: any) => ({
  ok: true,
  result: {
    provider: "fixture",
    items: [
      { title: "搜索结果 1", snippet: `关于「${input?.query ?? ""}」的真实摘要。`, url: "https://example.com/1" },
    ],
  },
}));
registry.register("search_images", async () => ({
  ok: true,
  result: { provider: "fixture", mediaType: "image", items: [{ title: "图 1", url: "https://example.com/i.jpg" }] },
}));
registry.register("reminder.plan", async () => ({ ok: true, result: { nextRunAtLocal: "2026-09-24 08:00" } }));

const toolCtx = {
  executeTool: async (name: string, args: Record<string, unknown>) => {
    try {
      const out = await registry.execute(name, args, { actorId: "gate-e2e" });
      return { ok: Boolean(out?.ok), result: (out?.result ?? out ?? {}) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
    }
  },
};

/* ---------------- 脚本化 LLM ---------------- */
type LoopScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> };

function chunksFor(step: LoopScriptStep): any[] {
  if (step.kind === "text") {
    return [
      { choices: [{ delta: { content: step.text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
  }
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0, id: step.id, type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function makeFakeClient(script: LoopScriptStep[]) {
  let callIndex = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          const step = script[Math.min(callIndex, script.length - 1)];
          callIndex += 1;
          return (async function* () {
            for (const c of chunksFor(step)) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, callCount: () => callIndex };
}

/* ---------------- 断言工具 ---------------- */
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  const mark = cond ? "✔" : "✖";
  if (!cond) failures += 1;
  originalConsoleInfo(`  ${mark} ${name}${cond ? "" : ` —— ${detail ?? ""}`}`);
}

// 与生产 agent-core 同源组装：task.dispatch 等经 extraDefinitions 晚绑定注入
const chatCore = buildLaneCoreTools("chat", getBuiltinAgentChatTools() as any, [
  TASK_DISPATCH_TOOL_DEFINITION,
  TASK_STATUS_TOOL_DEFINITION,
  TASK_CANCEL_TOOL_DEFINITION,
  PERCEPTION_OVERVIEW_TOOL_DEFINITION,
]);

async function runGateScenario(opts: {
  name: string;
  script: LoopScriptStep[];
  turnIntent: string;
  turnEvidenceInjected: boolean;
  expectGate?: string;
  expectCalls: number;
}): Promise<void> {
  originalConsoleInfo(`\n【${opts.name}】intent=${opts.turnIntent} evidence=${opts.turnEvidenceInjected}`);
  const before = traces.length;
  resetLlmUsageAuditForTest?.();
  const { client, callCount } = makeFakeClient(opts.script);
  const finalText = await streamCompletionWithTools(
    client,
    "mock-model",
    [
      { role: "system", content: "你是用户的私人助理。当前时间 2026-09-23。" },
      { role: "user", content: "（用户消息）" },
    ],
    () => {},
    toolCtx as never,
    {
      tools: chatCore,
      toolSearchSourceTools: chatCore,
      maxRounds: 4,
      turnIntent: opts.turnIntent,
      turnEvidenceInjected: opts.turnEvidenceInjected,
      audit: { sessionId: `gate-${opts.name}`, stage: "main_chat_tools" },
    },
  );
  const trace = traces[traces.length - 1];
  check("捕获 turn-trace", traces.length === before + 1);
  check(
    opts.expectGate ? `出口闸触发 ${opts.expectGate}` : "出口闸未触发",
    opts.expectGate
      ? trace?.exitGate?.fired === true && trace?.exitGate?.reason === opts.expectGate
      : trace?.exitGate?.fired !== true,
    `actual=${JSON.stringify(trace?.exitGate)}`,
  );
  check(
    `LLM 调用数=${opts.expectCalls}`,
    callCount() === opts.expectCalls,
    `actual=${callCount()}`,
  );
  check("最终文本非空", Boolean(finalText?.trim()));
}

/* ---------------- 场景执行 ---------------- */
originalConsoleInfo(`\n=== 零工具出口闸 + 禁网开关 E2E（chat Core=${chatCore.length} 工具）===\n`);

await runGateScenario({
  name: "A realtime零工具无证据",
  script: [
    { kind: "text", text: "今天比特币行情应该还不错。" },
    { kind: "tool", id: "t1", name: "search_web", args: { query: "比特币 今日 价格" } },
    { kind: "text", text: "刚查了下，比特币现在是 6.4 万美元。" },
  ],
  turnIntent: "realtime_lookup",
  turnEvidenceInjected: false,
  expectGate: "realtime_intent_never_attempted",
  expectCalls: 3,
});

await runGateScenario({
  name: "B realtime零工具但证据已注入",
  script: [{ kind: "text", text: "以检索块为准，比特币现在是 6.4 万美元。" }],
  turnIntent: "realtime_lookup",
  turnEvidenceInjected: true,
  expectGate: undefined,
  expectCalls: 1,
});

await runGateScenario({
  name: "C media零工具无证据",
  script: [
    { kind: "text", text: "她有很多好看的照片。" },
    { kind: "tool", id: "t2", name: "search_images", args: { query: "刘浩存 高清" } },
    { kind: "text", text: "图给你找到了。" },
  ],
  turnIntent: "media_retrieval",
  turnEvidenceInjected: false,
  expectGate: "media_intent_never_attempted",
  expectCalls: 3,
});

await runGateScenario({
  name: "D write零工具（回归原闸）",
  script: [
    { kind: "text", text: "好的，明天早上8点叫你。" },
    { kind: "tool", id: "t3", name: "reminder_plan", args: { text: "明天早上8点提醒" } },
    { kind: "text", text: "闹钟设好了，明天8点见。" },
  ],
  turnIntent: "action_write",
  turnEvidenceInjected: false,
  expectGate: "write_intent_never_attempted",
  expectCalls: 3,
});

originalConsoleInfo("\n【E】显式禁网识别");
check("「不要联网。列出…」命中", isExplicitNoWebRequest("不要联网。列出搬家要带的8样物品") === true);
check("「不用上网查了」命中", isExplicitNoWebRequest("这个不用上网查了，你直接说") === true);
check("「离线回答」命中", isExplicitNoWebRequest("离线回答我：黑洞是什么") === true);
check("「帮我联网搜一下天气」不误伤", isExplicitNoWebRequest("帮我联网搜一下天气") === false);
check("「搜索一下新闻」不误伤", isExplicitNoWebRequest("搜索一下今天的新闻") === false);
check("普通知识问答不误伤", isExplicitNoWebRequest("为什么天空是蓝色的") === false);

originalConsoleInfo("\n【F】禁网工具剥离");
const webNames = new Set(["search_web", "fetch_web", "search_images", "search_videos", "hot_rankings", "deep_search"]);
const filtered = filterWebSearchTools(chatCore as any);
const filteredNames = new Set(filtered.map((t: any) => t.function?.name));
check(
  "联网族全部剥离",
  [...webNames].every((n) => !filteredNames.has(n)),
  `残留=${[...webNames].filter((n) => filteredNames.has(n)).join(",")}`,
);
check(
  "本地工具保留（reminder/calendar/clock/task.dispatch）",
  ["reminder.plan", "calendar.create_from_text", "clock.get_current_time", "task.dispatch"].every((n) => filteredNames.has(n)),
);
check("剥离数量合理（chat Core 收缩但不空）", filtered.length >= 15 && filtered.length < chatCore.length, `before=${chatCore.length} after=${filtered.length}`);

console.info = originalConsoleInfo;
originalConsoleInfo(`\n=== 结果：${failures === 0 ? "全部通过 ✔" : `${failures} 项失败 ✖`} ===`);
process.exit(failures === 0 ? 0 : 1);
