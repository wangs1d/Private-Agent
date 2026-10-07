/**
 * MiniMax-M3 工具调用真机探针：验证工具调用走结构化 tool_calls 还是泄漏进 content 文本。
 *
 * 背景（2026-10-07 线上截图）：主模型切到 MiniMax 后，模型把幻觉出来的工具调用
 * （reminder_plan / whenOffsetSeconds —— 注意与真实工具 reminder.plan schema 不符）
 * 以 <tool_call><invoke name=...> XML 形式写进正文，工具从未被执行。
 *
 * 用法（server 目录下）：node --import tsx test/tmp-probe/probe-minimax-toolcall.ts
 */
import "../../src/config/load-server-env.js";
import OpenAI from "openai";

const apiKey = process.env.MINIMAX_API_KEY?.trim();
if (!apiKey) {
  console.error("MINIMAX_API_KEY 未配置");
  process.exit(1);
}
const baseURL = (process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim();
const model = (process.env.MINIMAX_MODEL ?? "MiniMax-M3").trim();
const client = new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 1 });

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "reminder.plan",
      description:
        "【生活助手】按用户原句创建定时提醒并写入服务端日程。带明确时间点的单次提醒必须直接调用本工具，不要追问。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，须含时间与提醒事项" },
          shortTitle: { type: "string", description: "简洁展示标题" },
          category: { type: "string", enum: ["itinerary", "trivia"] },
          reminderMessage: { type: "string", description: "到点时展示给用户的友好提醒文案" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "calendar.list_tasks",
      description: "【内置 Calendar】查询当前用户已创建的定时日程/提醒（含下次执行时间）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

const SYSTEM =
  "你是用户的私人助理，称呼用户为「王哥」。回答要简短口语化。工具调用必须走系统提供的 function calling 通道，禁止在正文里输出任何 XML/标签形式的工具调用。";

interface RunResult {
  label: string;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  contentHasToolXml: boolean;
}

async function run(label: string, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], extra: Record<string, unknown> = {}): Promise<RunResult> {
  process.stdout.write(`\n===== ${label} =====\n`);
  const request = {
    model,
    messages,
    tools: TOOLS,
    tool_choice: "auto" as const,
    parallel_tool_calls: true,
    stream: true,
    stream_options: { include_usage: true },
    // 与 minimax-provider 的 minimaxExtraBody 对齐
    reasoning_split: true,
    thinking: { type: "disabled" },
    ...extra,
  };
  const stream = await client.chat.completions.create(
    request as Parameters<typeof client.chat.completions.create>[0],
  );
  let content = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let finishReason: string | null = null;
  for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === "string") {
        if (delta.content) {
          content += delta.content;
          process.stdout.write(`[C] ${JSON.stringify(delta.content)}\n`);
        }
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
      }
      const dts = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(dts)) {
        for (const dt of dts) {
          const idx = typeof dt.index === "number" ? dt.index : toolCalls.length;
          while (toolCalls.length <= idx) toolCalls.push({ id: "", name: "", arguments: "" });
          const fn = dt.function as { name?: string; arguments?: string } | undefined;
          if (typeof dt.id === "string" && dt.id) toolCalls[idx].id += dt.id;
          if (fn?.name) toolCalls[idx].name += fn.name;
          if (fn?.arguments) toolCalls[idx].arguments += fn.arguments;
        }
        process.stdout.write(`[T] ${JSON.stringify(dts).slice(0, 300)}\n`);
      }
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
      process.stdout.write(`[finish] ${choice.finish_reason}\n`);
    }
  }
  const contentHasToolXml = /<\s*(minimax:)?tool_call|<\s*invoke\s+name=|<\s*parameter\s+name=/i.test(content);
  console.log(`--- content(${content.length} chars) reasoning(${reasoning.length} chars)`);
  console.log("content:", JSON.stringify(content.slice(0, 800)));
  console.log("toolCalls:", JSON.stringify(toolCalls));
  console.log("finishReason:", finishReason, "| contentHasToolXml:", contentHasToolXml);
  return { label, content, reasoning, toolCalls, finishReason, contentHasToolXml };
}

// 场景 A：最直接 —— 用户要设提醒，应产生结构化 reminder.plan 调用
const a = await run("A: 直接设提醒（1分钟后吃饭）", [
  { role: "system", content: SYSTEM },
  { role: "user", content: "1分钟后提醒我吃饭" },
]);

// 场景 B：复刻截图 —— 先查过任务（空），再次要设提醒
const b = await run("B: 二次设置（截图场景：list_tasks 为空后重设）", [
  { role: "system", content: SYSTEM },
  { role: "user", content: "1分钟后提醒我吃饭" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_test_1",
        type: "function",
        function: { name: "calendar.list_tasks", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_test_1", content: JSON.stringify({ ok: true, tasks: [] }) },
  { role: "user", content: "1分钟后提醒我吃饭" },
]);

console.log("\n===== 汇总 =====");
for (const r of [a, b]) {
  console.log(
    `${r.label}: finish=${r.finishReason} toolCalls=${r.toolCalls.length} contentXml=${r.contentHasToolXml}`,
  );
}
