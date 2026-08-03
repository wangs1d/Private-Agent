/**
 * 验证 Fast 模式下 LLM 看到的工具集不包含桌面工具污染。
 * 复现"现在几点"被 LLM 调截屏工具的 bug，并验证修复。
 */

import { resolveChatToolsForStream } from "../src/external-model/resolve-chat-tools.js";
import { FAST_LANE_TOOLS } from "../src/external-model/openai-compatible-tool-loop.js";

const DESKTOP_POLLUTING_TOOLS = [
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
  "desktop.open",
  "desktop.run_preset",
  "desktop.run_shell",
  "desktop.uia_query",
  "desktop.run_automation",
  "desktop.http_get",
  "desktop.web_search",
  "desktop.web_fetch",
];

const fastOpts = {
  chatToolsBuiltin: FAST_LANE_TOOLS,
  chatToolsExtra: [],
  toolExposureProfile: "contextual" as const,
  // 模拟用户开了 desktop 桥接的场景（修复前会被污染）
  desktopBridgeOnline: true,
  agentAccessMode: "full" as const,
  phoneBridgeOnline: false,
};

console.log("═══════════════════════════════════════════════");
console.log("  Fast 模式工具可见性测试（修复桌面工具污染）");
console.log("═══════════════════════════════════════════════\n");

const tools = resolveChatToolsForStream("现在几点", fastOpts);
const names = tools
  .map((t) => ("function" in t ? t.function.name : undefined))
  .filter((n): n is string => Boolean(n));

console.log(`Fast 模式 LLM 可见工具数: ${tools.length}`);
console.log("工具列表:");
for (const n of names) {
  const flagged = DESKTOP_POLLUTING_TOOLS.includes(n) ? "⚠ 桌面工具" : "✓ 轻量";
  console.log(`  [${flagged}] ${n}`);
}

// 验证关键期望
let failed = false;

console.log("\n══ 验证期望 ══");

// 1. clock 工具必须可见
const clockTools = names.filter((n) => n.startsWith("clock."));
console.log(`\n[1] clock 工具可见性: ${clockTools.length} 个`);
for (const t of clockTools) console.log(`  ✓ ${t}`);
if (clockTools.length === 0) {
  console.error("  ✗ clock 工具完全不可见，Fast 模式无法处理时间查询！");
  failed = true;
}

// 2. 不应包含任何 desktop 工具（修复核心）
const desktopLeaked = names.filter((n) => DESKTOP_POLLUTING_TOOLS.includes(n));
console.log(`\n[2] desktop 工具泄漏检测: ${desktopLeaked.length} 个`);
if (desktopLeaked.length > 0) {
  console.error(`  ✗ ${desktopLeaked.length} 个桌面工具污染 LLM:`);
  for (const t of desktopLeaked) console.error(`    - ${t}`);
  failed = true;
} else {
  console.log("  ✓ 无桌面工具污染，Fast 模式工具集干净");
}

// 3. weather/calendar 轻量工具应可见
const weather = names.includes("weather.get_local");
const calendar = names.includes("calendar.list_tasks");
console.log(`\n[3] 轻量工具: weather.get_local=${weather ? "✓" : "✗"}, calendar.list_tasks=${calendar ? "✓" : "✗"}`);
if (!weather || !calendar) failed = true;

// 4. 对比：Complex 模式下桌面工具应可见（不能误伤）
//    注意：Complex 模式走完整工具集（不传 chatToolsBuiltin，让它走 getBuiltinAgentChatTools 默认路径），
//    仅测试 desktopBridgeOnline + accessMode 触发桌面工具暴露的逻辑。
const complexOpts = {
  chatToolsBuiltin: undefined, // 显式 undefined 走默认全部工具
  chatToolsExtra: [],
  toolExposureProfile: "delegate" as const,
  desktopBridgeOnline: true,
  agentAccessMode: "full" as const,
  phoneBridgeOnline: false,
};
const complexTools = resolveChatToolsForStream("打开微信", complexOpts);
const complexNames = new Set(
  complexTools
    .map((t) => ("function" in t ? t.function.name : undefined))
    .filter((n): n is string => Boolean(n)),
);
const complexHasDesktop = complexNames.has("desktop.visual.screenshot");
console.log(`\n[4] Complex 模式 desktop 工具应可见: ${complexHasDesktop ? "✓" : "✗"}`);
if (!complexHasDesktop) {
  console.error("  ✗ Complex 模式反而看不到 desktop 工具，误伤了 Complex 路径！");
  failed = true;
}

console.log("\n═══════════════════════════════════════════════");
if (failed) {
  console.error("  ✗ 失败");
  process.exit(1);
} else {
  console.log("  ✅ 通过");
}
