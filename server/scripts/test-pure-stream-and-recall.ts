/**
 * 2026-08-03 验证：纯流式渲染 + 记忆召回行为变更
 *
 * 验证目标：
 *   1. memory_commitments / memory_open_loops 相关度低于阈值时不注入 prompt
 *   2. system prompt 含【记忆使用方式】约束（不要主动提起过往承诺/提醒）
 *   3. 全局响应缓存对普通对话默认关闭（避免重复消息复读）
 *   4. 同话题承诺应保留
 *
 * 运行：npx tsx scripts/test-pure-stream-and-recall.ts
 */
import {
  sliceMemoryEntriesToPromptContext,
  finalizeChatSystemPrompt,
  appendMemoryRecallBehaviorSuffix,
} from "../src/agent/prompt-builder.js";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ${green("✓")} ${label}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  ${red("✗")} ${label}${detail ? " — " + detail : ""}`);
  }
}

console.log(bold("\n[Test 1] commitments/open_loops 相关度过滤"));

// 场景 A：用户问的是「日程/提醒」类话题，但 commitments 只有「健身/旅行」
// 等无关承诺。calendar topic vs general → topicRelevanceBoost = -0.35
// 加上 commitment 标签 +0.2，总分 0.2 (term 0) → 低于 0.4 阈值，不注入。
const entriesA = {
  memory_commitments: [
    "[Agent 承诺/结论] 帮你约下周三的健身课",
    "[Agent 承诺/结论] 帮你查一下下个月去三亚的机票",
  ].join("\n"),
  memory_open_loops: [
    "[待办] 提醒你周末收快递",
  ].join("\n"),
};

// "提醒我明天下午开会" 含「提醒/会议」字眼 → queryTopic = "calendar"
const slicedA = sliceMemoryEntriesToPromptContext(entriesA, "提醒我明天下午开会");

check("『提醒我明天下午开会』话题不应注入『健身课』承诺",
  !slicedA.memoryCommitments,
  `实际: ${slicedA.memoryCommitments || "(空)"}`);
check("『提醒我明天下午开会』话题不应注入『快递』未完成事项",
  !slicedA.memoryOpenLoops,
  `实际: ${slicedA.memoryOpenLoops || "(空)"}`);

console.log(bold("\n[Test 2] 同话题承诺应保留"));

// 场景 B：当前话题是 calendar，且 commitments 里也有 [topic:calendar] 标签
// → 同 topic +0.45 + commitment +0.2 = 0.65 → 高于 0.4 阈值，保留。
const entriesB = {
  memory_commitments: [
    "[Agent 承诺/结论][topic:calendar] 帮你约下周三的健身课",
    "[Agent 承诺/结论] 帮你查一下下个月去三亚的机票",
  ].join("\n"),
  memory_open_loops: [
    "[topic:calendar] 提醒你周末收快递",
  ].join("\n"),
};

const slicedB = sliceMemoryEntriesToPromptContext(entriesB, "提醒我明天下午开会");

check("calendar 话题应注入『健身课』承诺",
  !!slicedB.memoryCommitments,
  `实际: ${slicedB.memoryCommitments || "(空)"}`);
check("calendar 话题应过滤掉无标签的『三亚机票』承诺",
  !slicedB.memoryCommitments?.includes("三亚"),
  `实际: ${slicedB.memoryCommitments || "(空)"}`);

console.log(bold("\n[Test 3] system prompt 含【记忆使用方式】约束"));

const baseSystem = "你是 Private Agent。";
const finalSystem = finalizeChatSystemPrompt(baseSystem, {
  tools: false,
  masterSubAgentDelegate: false,
});

check("system prompt 包含【记忆使用方式】",
  finalSystem.includes("【记忆使用方式】"),
  "确保 LLM 知道 background memory 的使用边界");
check("system prompt 包含『保持沉默』",
  finalSystem.includes("保持沉默"),
  "确保不相关时静默而非复读");
check("system prompt 包含「你不需要主动提」类似表达",
  /不要.*主动|不是.*必须|保持沉默/.test(finalSystem),
  "确保有显式约束语");

// 验证 appendMemoryRecallBehaviorSuffix 单独可用且幂等
const once = appendMemoryRecallBehaviorSuffix(baseSystem);
const twice = appendMemoryRecallBehaviorSuffix(once);
check("appendMemoryRecallBehaviorSuffix 幂等",
  once === twice,
  "二次追加应原样返回");
check("单独追加含【记忆使用方式】",
  once.includes("【记忆使用方式】"),
  "marker 已就位");

console.log(bold("\n[Test 4] 全局响应缓存模块已删除"));

// 2026-08-03：响应缓存（ResponseCache / globalResponseCache / RESPONSE_CACHE_* env）
// 已整体删除，不再存在任何面向对话的缓存层。
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const agentCoreSource = readFileSync(join(import.meta.dirname, "../src/services/agent-core.ts"), "utf8");
check("agent-core.ts 不再包含 ResponseCache 类",
  !agentCoreSource.includes("class ResponseCache"),
  "缓存类已删除");
check("agent-core.ts 不再包含 globalResponseCache 引用",
  !agentCoreSource.includes("globalResponseCache"),
  "全局实例已删除");
check("agent-core.ts 不再包含 RESPONSE_CACHE env 读取",
  !agentCoreSource.includes("RESPONSE_CACHE"),
  "env 开关已删除");

console.log(bold(`\nSummary: ${green(`${passed} passed`)} | ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`));

if (failed > 0) {
  process.exit(1);
}
