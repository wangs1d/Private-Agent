/**
 * task 车道 router-first E2E 台架（2026-09-23 token 优化验收）。
 *
 * 回答一个问题：task 车道可见集只剩桥工具（tool_discover/tool_call）后，
 * 一个任务轮的 discover→call→作答 三波流程是否真实走通。
 *
 * 真实组件：resolveChatToolPlanForStream 暴露管线（agent-core 同款 explicit
 * 空白名单）/ prepareTools 延迟目录 / streamCompletionWithTools 波次循环 /
 * ToolRegistry 执行 / BM25 检索。mock 的只有 LLM（脚本化流式响应）。
 *
 * 用法：
 *   npx tsx scripts/e2e-task-router-first.ts          # 脚本 LLM（确定性）
 *   npx tsx scripts/e2e-task-router-first.ts --live   # 真实 LLM 冒烟（1 轮，走 .env key）
 */
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || mkdtempSync(join(tmpdir(), "pa-e2e-task-rf-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";

const { getBuiltinAgentChatTools, streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { resolveChatToolPlanForStream } = await import("../src/external-model/resolve-chat-tools.js");
const { prepareTools } = await import("../src/gateway/index.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");

const corpus: any[] = [...getBuiltinAgentChatTools(), TASK_DISPATCH_TOOL_DEFINITION];

/* ---------------- 真实 ToolRegistry ---------------- */
const registry = new ToolRegistry() as any;
let weatherCalls = 0;
registry.register("weather.get_local", async (input: any) => {
  weatherCalls += 1;
  return { city: input?.city ?? "杭州", condition: "多云", tempC: 26 };
});
registry.register("search_web", async (input: any) => ({
  results: [
    { title: "结果 1", snippet: `关于「${input?.query ?? ""}」的摘要（台架 fixture）。`, url: "https://example.com/1" },
  ],
}));
const toolCtx = {
  executeTool: (name: string, args: Record<string, unknown>) =>
    registry.execute(name, args, { sessionId: "e2e-task-rf" }),
};

/* ---------------- task 车道装配（agent-core router-first 同款） ---------------- */
function taskLanePlanRouterFirst() {
  return resolveChatToolPlanForStream(undefined, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: [], // router-first：可见候选为空，桥工具由 prepareTools 自动注入
    chatToolsExtra: corpus,
  } as any);
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  const mark = cond ? "✔" : "✖";
  if (!cond) failures += 1;
  console.info(`  ${mark} ${name}${cond ? "" : ` —— ${detail ?? ""}`}`);
}

/* ---------------- 脚本化客户端（确定性流程验证） ---------------- */
type LoopScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> };

function chunksFor(step: LoopScriptStep): any[] {
  const chunks: any[] = [];
  if (step.kind === "text") {
    chunks.push({ choices: [{ delta: { content: step.text }, finish_reason: null }] });
    chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  } else {
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0, id: step.id, type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          }],
        },
        finish_reason: null,
      }],
    });
    chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  }
  return chunks;
}

async function runScripted(): Promise<void> {
  console.info("\n=== task 车道 router-first E2E（脚本 LLM）===\n");

  const plan = taskLanePlanRouterFirst();
  check("agent-core 同款装配：visibleTools 为空（零业务 schema 进 prompt）", plan.visibleTools.length === 0);
  check("延迟目录语料 = 全量 corpus", plan.searchableTools.length === corpus.length);

  const prepared = await prepareTools(plan.visibleTools, plan.searchableTools, {
    userText: "今天杭州天气怎么样",
  });
  const visibleNames = prepared.visibleTools.map((t: any) => t.function?.name).sort();
  check(
    `prepareTools 自动注入桥工具（可见 ${prepared.visibleTools.length} 个：${visibleNames.join(",")}）`,
    prepared.toolSearchActive && visibleNames.includes("tool_discover") && visibleNames.includes("tool_call"),
  );
  check(`延迟目录条数 = ${prepared.deferredToolCount}（全量业务工具可达）`, prepared.deferredToolCount >= corpus.length - 1);

  const script: LoopScriptStep[] = [
    { kind: "tool", id: "d1", name: "tool_discover", args: { query: "查询本地天气", limit: 3 } },
    { kind: "tool", id: "c1", name: "tool_call", args: { name: "weather.get_local", arguments: { city: "杭州" } } },
    { kind: "text", text: "杭州现在多云，26 度，适合出门。" },
  ];
  let callIndex = 0;
  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (req: any) => {
          requests.push(req);
          const step = script[Math.min(callIndex, script.length - 1)];
          callIndex += 1;
          return (async function* () {
            for (const c of chunksFor(step)) yield c;
          })();
        },
      },
    },
  };

  const finalText = await streamCompletionWithTools(
    client as never,
    "mock-model",
    [
      { role: "system", content: "你是用户的私人助理。" },
      { role: "user", content: "今天杭州天气怎么样" },
    ],
    () => {},
    toolCtx as never,
    {
      tools: plan.visibleTools,
      toolSearchSourceTools: plan.searchableTools,
      maxRounds: 4,
      audit: { sessionId: "e2e-task-rf", stage: "task_plane_light" },
    },
  );

  check(`discover→call→作答 三波流程完成（LLM 调用 ${callIndex} 次）`, callIndex === 3);
  check("weather.get_local 经 tool_call 桥真实执行", weatherCalls === 1);
  check("最终作答送达", finalText.includes("26 度"));

  // 每波请求里的可见工具规模（router-first 的核心收益）
  const toolsCharsPerWave = requests.map((r) => JSON.stringify(r.tools ?? []).length);
  check(
    `每波 tools 段体积 = ${toolsCharsPerWave.join("/")} 字符（桥工具级别，非 36 工具全量）`,
    toolsCharsPerWave.every((n) => n < 2500),
  );
}

/* ---------------- live 冒烟（真实 LLM，1 轮） ---------------- */
async function runLive(): Promise<void> {
  console.info("\n=== task 车道 router-first LIVE 冒烟（真实 LLM）===\n");
  const { resolvePrimaryLlmClientConfig } = await import("../src/external-model/resolve-provider.js");
  const cfg = resolvePrimaryLlmClientConfig();
  if (!cfg?.apiKey) {
    console.info("  ⚠ 未配置 API key，跳过 live 冒烟");
    return;
  }
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, defaultHeaders: cfg.headers });
  console.info(`  provider=${cfg.providerId ?? "?"} model=${cfg.model}`);

  const plan = taskLanePlanRouterFirst();
  const prepared = await prepareTools(plan.visibleTools, plan.searchableTools, {
    userText: "帮我查一下现在杭州的天气",
  });
  console.info(`  可见工具: ${prepared.visibleTools.map((t: any) => t.function?.name).join(", ")}；延迟目录 ${prepared.deferredToolCount} 条`);

  const finalText = await streamCompletionWithTools(
    client as never,
    cfg.model,
    [
      { role: "system", content: "你是用户的私人助理。工具调用原则：业务工具在延迟目录中，先 tool_discover 检索再 tool_call 执行。" },
      { role: "user", content: "帮我查一下现在杭州的天气" },
    ],
    () => {},
    toolCtx as never,
    {
      tools: plan.visibleTools,
      toolSearchSourceTools: plan.searchableTools,
      maxRounds: 4,
      audit: { sessionId: "e2e-task-rf-live", stage: "task_plane_light" },
    },
  );
  console.info(`  模型作答: ${finalText.slice(0, 120)}`);
  check("live：weather.get_local 被执行（router-first 链路真实走通）", weatherCalls >= 1);
  check("live：有正文作答", finalText.trim().length > 0);
}

runScripted()
  .then(runLive)
  .then(() => {
    console.info(failures === 0 ? "\n全部通过 ✔\n" : `\n${failures} 项失败 ✖\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
