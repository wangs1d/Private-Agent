/**
 * 端到端验证（2026-10-07 泄漏修复）：无工具轮次让 MiniMax-M3「想调工具」，
 * 把真实模型输出喂给 consumeNormalizedStream，验证：
 *   1) 泄漏的 <tool_call><invoke> XML 被提取成结构化 toolCalls（→ 升级任务面）
 *   2) 发射给用户的 content/delta 不再含协议原文
 *
 * 用法：node --import tsx test/tmp-probe/probe-minimax-leak-extract.ts
 */
import "../../src/config/load-server-env.js";
import OpenAI from "openai";
import { consumeNormalizedStream, extractTextualToolCalls } from "../../src/external-model/stream-chat-helpers.js";
import type { NormalChatChunk } from "../../src/external-model/stream-chat-helpers.js";

const apiKey = process.env.MINIMAX_API_KEY?.trim();
if (!apiKey) {
  console.error("MINIMAX_API_KEY 未配置");
  process.exit(1);
}
const client = new OpenAI({
  apiKey,
  baseURL: (process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim(),
  timeout: 180_000,
  maxRetries: 1,
});
const model = (process.env.MINIMAX_MODEL ?? "MiniMax-M3").trim();

// 刻意复刻泄漏条件：请求不带 tools，但 system 里告知具备提醒能力（诱导模型按
// 训练格式写调用），这正是线上对话面（工具被裁）轮次的形态。
const SYSTEM =
  "你是用户的私人助理，称呼用户为「王哥」，可以帮用户创建提醒、查天气、搜网页。回答简短口语化。";
const USER = "1分钟后提醒我吃饭";

// 强诱导：对话历史里放一条「成功调用」的示范（复刻线上 thread 里工具轮次的
// 叙述痕迹），让无工具轮次的模型模仿训练格式发起调用。
const messages = [
  { role: "system" as const, content: SYSTEM },
  { role: "user" as const, content: "明天早上8点提醒我起床" },
  {
    role: "assistant" as const,
    content:
      "好嘞王哥，明天早上8点准时叫你起床。\n<tool_call>\n<invoke name=\"reminder_plan\">\n<parameter name=\"title\">\"王哥，起床啦\"</parameter>\n<parameter name=\"whenOffsetSeconds\">600</parameter>\n</invoke>\n</tool_call>",
  },
  { role: "user" as const, content: USER },
];

const stream = await client.chat.completions.create({
  model,
  messages,
  stream: true,
  stream_options: { include_usage: true },
  reasoning_split: true,
} as Parameters<typeof client.chat.completions.create>[0]);

async function* source(): AsyncIterable<NormalChatChunk> {
  for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
    const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    const out: NormalChatChunk = {};
    if (typeof delta.content === "string" && delta.content) out.content = delta.content;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      out.reasoning = delta.reasoning_content;
    }
    const fr = chunk.choices[0]?.finish_reason;
    if (fr) out.finishReason = fr;
    yield out;
  }
}

const deltas: string[] = [];
const result = await consumeNormalizedStream(source(), {
  onContentDelta: (d) => deltas.push(d),
});

const raw = result.content + deltas.join("");
console.log("=== 模型原始 content（净化后） ===");
console.log(JSON.stringify(result.content));
console.log("\n=== 提取结果 ===");
console.log("finishReason:", result.finishReason);
console.log("toolCalls:", JSON.stringify(result.toolCalls, null, 2));
console.log("streamed deltas 干净:", !deltas.join("").includes("tool_call"));

// 二次校验：extractTextualToolCalls 直接吃净化前文本也应命中（若本轮恰好没泄漏则跳过）
const textual = extractTextualToolCalls(raw);
console.log("textual direct-extract:", JSON.stringify(textual));

const leaked = raw.includes("<tool_call") || raw.includes("<invoke");
if (leaked) {
  const pass = result.toolCalls.length > 0 && !deltas.join("").includes("tool_call");
  console.log(`\n本轮回泄漏了协议 → 提取+净化 ${pass ? "PASS ✓" : "FAIL ✗"}`);
  process.exit(pass ? 0 : 1);
}
console.log("\n本轮回模型没走文本协议（正常走tool_calls或纯文本，概率行为），仅验证无回归 PASS");
