/**
 * 2026-08-03 验证：Fast 模式工具集包含日程/提醒创建工具
 *
 * 背景：用户设置提醒被路由到 fast 模式，但 fastLane 原本只有只读的
 * calendar.list_tasks，LLM 看不到创建工具 → 口头答应"已设置"却没写入日程。
 *
 * 验证目标：
 *   1. getFastLaneTools() 包含 calendar.create_task / create_from_text / reminder.plan / delete_task
 *   2. 模拟「设置提醒」fast 模式请求，resolveChatToolsForStream 返回的工具含创建工具
 *
 * 运行：npx tsx scripts/test-fast-reminder-tools.ts
 */
import { getFastLaneTools } from "../src/external-model/openai-compatible-tool-loop.js";
import { resolveChatToolsForStream } from "../src/external-model/resolve-chat-tools.js";

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

console.log(bold("\n[Test 1] getFastLaneTools() 包含创建工具"));

const fastTools = getFastLaneTools();
const fastNames = fastTools
  .map((t) => (t.type === "function" ? t.function?.name : undefined))
  .filter((n): n is string => Boolean(n));

console.log(`  fastLane 工具数: ${fastTools.length}`);
console.log(`  工具列表: ${fastNames.join(", ")}`);

const expectedWriteTools = [
  "calendar.create_task",
  "calendar.create_from_text",
  "reminder.plan",
  "calendar.delete_task",
];
for (const name of expectedWriteTools) {
  check(`包含 ${name}`, fastNames.includes(name));
}
check("保留只读 calendar.list_tasks", fastNames.includes("calendar.list_tasks"));

console.log(bold("\n[Test 2] 模拟「设置提醒」fast 模式工具可见性"));

// 模拟 agent-core.ts fast 分支的 streamOpts（与生产代码一致）
const opts = {
  chatToolsBuiltin: fastTools,
  chatToolsExtra: [],
  toolExposureProfile: "contextual" as const,
};

const cases: Array<{ text: string; expectInclude: string[] }> = [
  { text: "晚上8点提醒我吃药", expectInclude: ["calendar.create_task", "reminder.plan", "calendar.create_from_text"] },
  { text: "明天9点帮我设置一个开会提醒", expectInclude: ["calendar.create_task", "reminder.plan", "calendar.create_from_text"] },
  { text: "帮我加个日程，后天下午3点健身", expectInclude: ["calendar.create_task", "calendar.create_from_text"] },
  { text: "现在几点", expectInclude: [], expectNotInclude: ["calendar.create_task"] },
];

for (const c of cases) {
  const visible = resolveChatToolsForStream(c.text, opts);
  const visibleNames = visible
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  console.log(`\n  用户输入: "${c.text}"`);
  console.log(`  可见工具(${visibleNames.length}): ${visibleNames.join(", ")}`);
  for (const expected of c.expectInclude) {
    check(`含 ${expected}`, visibleNames.includes(expected));
  }
  const notInclude = (c as { expectNotInclude?: string[] }).expectNotInclude ?? [];
  for (const n of notInclude) {
    check(`不含 ${n}`, !visibleNames.includes(n));
  }
}

console.log(bold(`\nSummary: ${green(`${passed} passed`)} | ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`));

if (failed > 0) {
  process.exit(1);
}
