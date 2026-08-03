/**
 * 测试 Fast 车道轻量工具集：验证 clock 工具在 Fast 模式下可用，
 * 并测量 clock.get_current_time 的执行速度。
 */

import { FAST_LANE_TOOLS } from "../src/external-model/openai-compatible-tool-loop.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { registerClockTools } from "../src/tools/clock-tools.js";

// ─── 验证 FAST_LANE_TOOLS 包含预期工具 ───────────────────────────
const toolNames = FAST_LANE_TOOLS.map((t) =>
  "function" in t ? t.function.name : "(custom)",
);

console.log("FAST_LANE_TOOLS 包含的工具:");
for (const name of toolNames) {
  console.log(`  - ${name}`);
}

const expected = [
  "clock.get_current_time",
  "clock.get_user_location",
  "clock.get_date",
  "clock.format_timestamp",
  "weather.get_local",
  "calendar.list_tasks",
];

let missing = false;
for (const name of expected) {
  if (!toolNames.includes(name)) {
    console.error(`✗ 缺少工具: ${name}`);
    missing = true;
  }
}
if (missing) {
  process.exit(1);
}
console.log(`\n✓ 全部 ${expected.length} 个预期工具均存在\n`);

// ─── 测量 clock.get_current_time 执行速度 ───────────────────────
const registry = new ToolRegistry();
registerClockTools(registry);

async function benchClockGetCurrentTime(runs: number): Promise<void> {
  const times: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = await registry.execute("clock.get_current_time", {}, {
      sessionId: "test-session",
    });
    const elapsed = performance.now() - start;
    times.push(elapsed);

    if (i === 0) {
      // 首次运行打印结果
      const r = result.result as Record<string, unknown>;
      const ct = r.currentTime as Record<string, unknown>;
      console.log("clock.get_current_time 返回值:");
      console.log(`  local:  ${ct?.local}`);
      console.log(`  weekday: ${ct?.weekday}`);
      console.log(`  timezone: ${r.timezone}`);
      console.log(`  message: ${r.message}`);
    }
  }

  // 统计
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const min = times[0];
  const max = times[times.length - 1];

  console.log(`\n.clock.get_current_time 性能（${runs} 次运行）:`);
  console.log(`  min:  ${min.toFixed(2)}ms`);
  console.log(`  p50:  ${p50.toFixed(2)}ms`);
  console.log(`  avg:  ${avg.toFixed(2)}ms`);
  console.log(`  p99:  ${p99.toFixed(2)}ms`);
  console.log(`  max:  ${max.toFixed(2)}ms`);
}

// ─── 测量 clock.get_date 执行速度 ────────────────────────────────
async function benchClockGetDate(runs: number): Promise<void> {
  const times: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await registry.execute("clock.get_date", {}, {
      sessionId: "test-session",
    });
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];

  console.log(`\nclock.get_date 性能（${runs} 次运行）:`);
  console.log(`  p50:  ${p50.toFixed(2)}ms`);
  console.log(`  avg:  ${avg.toFixed(2)}ms`);
}

// ─── 运行测试 ────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  Fast 车道轻量工具集测试");
  console.log("═══════════════════════════════════════════════\n");

  await benchClockGetCurrentTime(20);
  await benchClockGetDate(20);

  // 验证时间正确性
  const now = new Date();
  const expectedHour = now.getHours();
  const result = await registry.execute("clock.get_current_time", {}, {
    sessionId: "test-session",
  });
  const ct = (result.result as Record<string, unknown>).currentTime as Record<string, unknown>;
  const localStr = ct?.local as string;
  console.log(`\n══ 时间正确性验证 ══`);
  console.log(`  系统时间: ${now.toLocaleString("zh-CN", { hour12: false })}`);
  console.log(`  工具返回: ${localStr}`);
  console.log(`  时区: Asia/Shanghai (UTC+8)`);

  // 从工具返回中提取小时
  const hourMatch = localStr.match(/(\d{2}):\d{2}:\d{2}/);
  if (hourMatch) {
    const toolHour = parseInt(hourMatch[1], 10);
    if (Math.abs(toolHour - expectedHour) <= 1) {
      console.log(`  ✓ 时间正确（系统 ${expectedHour} 时 vs 工具 ${toolHour} 时）`);
    } else {
      console.error(`  ✗ 时间偏差过大！（系统 ${expectedHour} 时 vs 工具 ${toolHour} 时）`);
      process.exit(1);
    }
  }

  console.log("\n✅ 全部测试通过");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
