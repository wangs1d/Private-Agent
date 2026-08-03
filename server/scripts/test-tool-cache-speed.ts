/**
 * 工具缓存速度测试。
 * 验证工具结果缓存在 60s 内相同参数复用结果，减少重复 API 调用。
 */
import { ToolRegistry } from "../src/tools/tool-registry.js";

// 模拟一个慢工具（如天气 API 调用）
const registry = new ToolRegistry();
registry.register("weather.get_local", async (input) => {
  // 模拟网络延迟 800ms
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    ok: true,
    result: {
      temperature: 22,
      humidity: 65,
      condition: "晴",
      location: input.location || "未知",
      timestamp: new Date().toISOString(),
    },
  };
});

registry.register("search_web", async (input) => {
  // 模拟搜索延迟 1200ms
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    ok: true,
    result: {
      items: [
        { title: "结果 1", url: "https://example.com/1", snippet: "摘要 1" },
        { title: "结果 2", url: "https://example.com/2", snippet: "摘要 2" },
      ],
      query: input.query,
      timestamp: new Date().toISOString(),
    },
  };
});

const context = {
  sessionId: "test-session",
  agentAccessMode: "full" as const,
};

async function testTool(name: string, input: Record<string, unknown>, label: string) {
  const start = Date.now();
  const result = await registry.execute(name, input, context);
  const duration = Date.now() - start;
  console.log(`${label}: ${duration}ms`);
  return { result, duration };
}

console.log("=".repeat(60));
console.log("工具缓存速度测试");
console.log("=".repeat(60));

// 测试 1: weather.get_local - 首次调用（无缓存）
console.log("\n[weather.get_local] 首次调用（无缓存）:");
const r1 = await testTool("weather.get_local", { location: "北京" }, "第 1 次");

// 测试 2: weather.get_local - 第二次调用（相同参数，应命中缓存）
console.log("[weather.get_local] 第二次调用（相同参数，应命中缓存）:");
const r2 = await testTool("weather.get_local", { location: "北京" }, "第 2 次");

// 测试 3: weather.get_local - 不同参数（不命中缓存）
console.log("[weather.get_local] 第三次调用（不同参数，不命中缓存）:");
const r3 = await testTool("weather.get_local", { location: "上海" }, "第 3 次");

// 测试 4: search_web - 首次调用
console.log("\n[search_web] 首次调用（无缓存）:");
const s1 = await testTool("search_web", { query: "AI 新闻" }, "第 1 次");

// 测试 5: search_web - 第二次调用（相同参数，应命中缓存）
console.log("[search_web] 第二次调用（相同参数，应命中缓存）:");
const s2 = await testTool("search_web", { query: "AI 新闻" }, "第 2 次");

// 测试 6: 不可缓存工具（如 desktop.open）
registry.register("desktop.open", async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { ok: true, result: { path: input.path } };
});

console.log("\n[desktop.open] 不可缓存工具（每次都要执行）:");
const d1 = await testTool("desktop.open", { path: "notepad.exe" }, "第 1 次");
const d2 = await testTool("desktop.open", { path: "notepad.exe" }, "第 2 次");

console.log("\n" + "=".repeat(60));
console.log("结果汇总:");
console.log("=".repeat(60));
console.log(`weather.get_local (北京): 第 1 次 ${r1.duration}ms → 第 2 次 ${r2.duration}ms (缓存命中应 <10ms)`);
console.log(`weather.get_local (上海): 第 3 次 ${r3.duration}ms (不同参数，不命中缓存)`);
console.log(`search_web (AI 新闻):     第 1 次 ${s1.duration}ms → 第 2 次 ${s2.duration}ms (缓存命中应 <10ms)`);
console.log(`desktop.open:             第 1 次 ${d1.duration}ms → 第 2 次 ${d2.duration}ms (不可缓存，每次 ~500ms)`);

// 验证缓存效果
const weatherSpeedup = r1.duration / r2.duration;
const searchSpeedup = s1.duration / s2.duration;
console.log("\n加速比:");
console.log(`  weather.get_local: ${weatherSpeedup.toFixed(1)}x`);
console.log(`  search_web:        ${searchSpeedup.toFixed(1)}x`);

if (r2.duration < 10 && s2.duration < 10) {
  console.log("\n✓ 缓存生效：相同参数查询从 ~1s 降到 <10ms");
} else {
  console.log("\n✗ 缓存未生效：第二次调用仍然较慢");
}
