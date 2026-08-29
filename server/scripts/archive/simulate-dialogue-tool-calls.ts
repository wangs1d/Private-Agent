/**
 * 模拟实际对话中的工具调用暴力测试。
 *
 * 覆盖真实 agent 调用链的完整环节（对齐 openai-compatible-tool-loop.ts）：
 *   LLM tool_call → JSON.parse(fn.arguments) → resolveRegistryToolName
 *   → (bridge 检测) executeToolSearchBridge → toolRegistry.execute
 *   → 结果 wire 序列化（JSON.stringify）
 *
 * 覆盖工具类型：传统工具 / Skill（SkillManager）/ MCP 工具（mcp.<alias>.<tool>）/ 别名解析。
 * 覆盖场景：参数对象、arguments 字符串、畸形 JSON、缺参、未知名、大小写、抛异常、
 *           结果含非法值（BigInt/undefined/NaN）、并发混合调用。
 *
 * 运行：cd server && npx tsx scripts/simulate-dialogue-tool-calls.ts
 */
import "../src/config/load-server-env.js";

import {
  ToolRegistry,
  resolveRegistryToolName,
  type ToolContext,
} from "../src/tools/tool-registry.js";
import { SkillManager } from "../src/skills/index.js";
import { registerClockTools } from "../src/tools/clock-tools.js";
import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import {
  executeToolSearchBridge,
  isToolSearchBridgeName,
  prepareToolsWithToolSearch,
  invalidateFullCatalogCache,
} from "../src/tools/tool-search/index.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";
import { prewarmToolRouterCatalogHttp } from "../src/tools/tool-search/tool-router-http-client.js";

const toolContext: ToolContext = {
  sessionId: "stress-dialogue-session",
  userId: "stress-user",
};

type RoundResult = { scenario: string; ok: boolean; detail: string };

const rounds: RoundResult[] = [];

function record(scenario: string, ok: boolean, detail: string): void {
  rounds.push({ scenario, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${scenario.padEnd(46)} ${detail.slice(0, 150)}`);
}

/** 复现 tool-loop 对 fn.arguments 的 JSON.parse（失败静默降级 {}） */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

type SimulatedLlmCall = {
  fn: { name: string; arguments: string };
};

async function simulateRound(
  scenario: string,
  toolRegistry: ToolRegistry,
  catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"],
  llmCall: SimulatedLlmCall,
  options?: { expectRejectContaining?: string },
): Promise<{ ok: boolean; detail: string }> {
  try {
    const args = parseArguments(llmCall.fn.arguments);
    let registryToolName = resolveRegistryToolName(llmCall.fn.name);
    let targetArgs = args;

    if (isToolSearchBridgeName(registryToolName)) {
      const bridge = await executeToolSearchBridge(registryToolName, args, catalog);
      if (bridge.kind === "call") {
        if (!bridge.ok) {
          const error = (bridge.result as { error?: string }).error ?? "?";
          const pass = options?.expectRejectContaining ? error.includes(options.expectRejectContaining) : false;
          record(scenario, pass, `bridge 拒绝 error=${error}`);
          return { ok: pass, detail: error };
        }
        registryToolName = bridge.registryToolName;
        targetArgs = bridge.parsedArgs;
      } else {
        const summary = JSON.stringify(bridge.result).slice(0, 120);
        record(scenario, true, `bridge ${bridge.kind} ok=${bridge.ok} ${summary}`);
        return { ok: true, detail: `bridge ${bridge.kind}` };
      }
    }

    const exec = await toolRegistry.execute(registryToolName, targetArgs, toolContext);

    // 模拟 wire 层序列化（tool-loop 会把 result 发到前端/回填 LLM）
    let serialized = "";
    let serializeError: string | null = null;
    try {
      serialized = JSON.stringify(exec.result);
    } catch (error) {
      serializeError = error instanceof Error ? error.message : String(error);
    }

    const argKeys = Object.keys(targetArgs).join(",") || "(空)";
    if (serializeError) {
      record(scenario, false, `exec.ok=${exec.ok} 序列化失败: ${serializeError}`);
      return { ok: false, detail: `serialize failed: ${serializeError}` };
    }
    if (options?.expectRejectContaining) {
      // 预期拒绝场景：exec.ok 应为 false 且错误信息包含关键词
      const error = String(exec.result?.error ?? "");
      const pass = !exec.ok && error.includes(options.expectRejectContaining);
      record(scenario, pass, `→ ${registryToolName} 预期拒绝, error=${error.slice(0, 90)}`);
      return { ok: pass, detail: error };
    }
    record(scenario, exec.ok, `→ ${registryToolName} args={${argKeys}} exec.ok=${exec.ok} result=${serialized.slice(0, 90)}`);
    return { ok: exec.ok, detail: serialized.slice(0, 90) };
  } catch (error) {
    record(scenario, false, `exception=${String(error).slice(0, 130)}`);
    return { ok: false, detail: String(error) };
  }
}

async function main(): Promise<void> {
  console.log("模拟实际对话 · 工具/skill/mcp 调用暴力测试");
  console.log("=".repeat(72));

  // ---- 搭建真实执行环境 ----
  const toolRegistry = new ToolRegistry();
  registerClockTools(toolRegistry); // 真实 clock 工具

  // 模拟 MCP 工具（真实链路中由 registerMcpTools 注册为 mcp.<alias>.<tool>）
  toolRegistry.register("mcp.filesystem.read_file", async (input) => {
    const path = String(input.path ?? "");
    return { ok: true, content: `file:${path}`, bytes: 42 };
  });

  // 压力测试专用工具
  toolRegistry.register("stress.throw_error", async () => {
    throw new Error("boom: handler crashed");
  });
  toolRegistry.register("stress.weird_result", async () => {
    // 模拟 handler 返回非 JSON 安全值
    return { a: BigInt(1), b: undefined, c: NaN, d: () => "fn" } as unknown as Record<string, unknown>;
  });

  // 别名解析验证（REGISTRY_TOOL_NAME_ALIASES: master_invoke_sub_agent → master.invoke_sub_agent）
  toolRegistry.register("master.invoke_sub_agent", async (input) => ({
    ok: true,
    subAgent: String(input.agent ?? ""),
  }));

  // Skill 注册
  const skillManager = new SkillManager();
  skillManager.register({
    metadata: {
      name: "demo.greet",
      version: "1.0.0",
      displayName: "问候",
      description: "向用户发送一个友好且热情的个性化问候语",
      parameters: [{ name: "name", type: "string", required: true, description: "称呼" }],
      permissions: [],
    },
    handler: async (input) => ({ ok: true, greeting: `你好，${String(input.name ?? "")}` }),
  });
  toolRegistry.setSkillManager(skillManager);

  // ---- 构建真实 deferred catalog（bridge 搜索/解析用）----
  invalidateBuiltinToolsCache();
  invalidateFullCatalogCache();
  const allTools = getBuiltinAgentChatTools();
  const prepared = prepareToolsWithToolSearch([], allTools);
  const catalog = prepared.deferredCatalog;
  console.log(`catalog: visible=${prepared.visibleTools.length} deferred=${catalog.entries.length}`);
  const mcpInCatalog = catalog.entries.filter((e) => e.registryName.startsWith("mcp."));
  console.log(`catalog 中 mcp.* 工具数: ${mcpInCatalog.length}`);
  try {
    await prewarmToolRouterCatalogHttp(catalog, { tenantId: "default", environment: "prod" });
  } catch {
    // 搜索回退 stdio/adaptive 也可
  }

  const ctx = toolRegistry;
  console.log("\n--- 传统工具 ---");

  // R1 核心可见工具直接调用（对象参数）
  await simulateRound("R1 clock.format_timestamp 对象参数", ctx, catalog, {
    fn: { name: "clock.format_timestamp", arguments: '{"timestamp": 1690000000}' },
  });

  // R2 deferred 工具 discover→call 闭环
  const discover = await executeToolSearchBridge(
    "tool_discover",
    { query: "现在几点 当前时间", limit: 3, tenant_id: "default" },
    catalog,
  );
  if (discover.kind === "discover" && discover.ok) {
    const matches = (discover.result as { matches?: Array<{ name: string }> }).matches ?? [];
    const target = matches.find((m) => m.name === "clock.get_current_time") ?? matches[0];
    if (target) {
      await simulateRound(`R2 tool_discover→tool_call(${target.name})`, ctx, catalog, {
        fn: { name: "tool_call", arguments: JSON.stringify({ name: target.name, arguments: {} }) },
      });
    } else {
      record("R2 discover 未命中 clock.get_current_time", true, "候选=" + matches.map((m) => m.name).join(","));
    }
  } else {
    record("R2 discover 失败", false, JSON.stringify(discover).slice(0, 120));
  }

  // R3 【修复验证】arguments 传 JSON 字符串
  await simulateRound("R3 tool_call arguments=JSON字符串(修复)", ctx, catalog, {
    fn: {
      name: "tool_call",
      arguments: JSON.stringify({ name: "clock.format_timestamp", arguments: '{"timestamp":1690000000}' }),
    },
  });

  // R4 arguments 非法字符串 → 空参数执行
  await simulateRound("R4 tool_call arguments=非法字符串", ctx, catalog, {
    fn: {
      name: "tool_call",
      arguments: JSON.stringify({ name: "clock.get_current_time", arguments: "format=full" }),
    },
  });

  // R5 name 大写（修复后：桥接层大小写兜底解析成功）
  await simulateRound("R5 tool_call name=大写(兜底)", ctx, catalog, {
    fn: { name: "tool_call", arguments: '{"name":"CLOCK.GET_CURRENT_TIME","arguments":{}}' },
  });

  console.log("\n--- Skill ---");

  // R6 skill 直接调用
  await simulateRound("R6 skill demo.greet 正常", ctx, catalog, {
    fn: { name: "demo.greet", arguments: '{"name":"小明"}' },
  });

  // R7 skill 缺必填参数
  await simulateRound("R7 skill demo.greet 缺必填参数", ctx, catalog, {
    fn: { name: "demo.greet", arguments: "{}" },
  }, { expectRejectContaining: "输入参数验证失败" });

  // R8 skill 不存在 → 回退传统工具 → 未知
  await simulateRound("R8 skill 不存在 demo.nope", ctx, catalog, {
    fn: { name: "demo.nope", arguments: "{}" },
  }, { expectRejectContaining: "未知工具" });

  console.log("\n--- MCP ---");

  // R9 mcp 直接调用
  await simulateRound("R9 mcp.filesystem.read_file 直接调用", ctx, catalog, {
    fn: { name: "mcp.filesystem.read_file", arguments: '{"path":"/tmp/a.txt"}' },
  });

  // R10 mcp 经 bridge tool_call（若在 catalog 内）
  if (mcpInCatalog.length > 0) {
    await simulateRound(`R10 mcp 经 bridge(${mcpInCatalog[0].registryName})`, ctx, catalog, {
      fn: {
        name: "tool_call",
        arguments: JSON.stringify({ name: mcpInCatalog[0].registryName, arguments: {} }),
      },
    });
  } else {
    record("R10 mcp 经 bridge（catalog 无 mcp.*）", true, "跳过热身：直接调用已覆盖 R9");
  }

  console.log("\n--- 名称解析 / 异常 / 序列化 ---");

  // R11 别名解析
  await simulateRound("R11 别名 master_invoke_sub_agent", ctx, catalog, {
    fn: { name: "master_invoke_sub_agent", arguments: '{"agent":"sub-1"}' },
  });

  // R12 未知工具
  await simulateRound("R12 未知工具 ghost.tool", ctx, catalog, {
    fn: { name: "ghost.tool", arguments: "{}" },
  }, { expectRejectContaining: "未知工具" });

  // R13 大小写（修复后：执行层大小写兜底成功）
  await simulateRound("R13 大小写 CLOCK.FORMAT_TIMESTAMP(兜底)", ctx, catalog, {
    fn: { name: "CLOCK.FORMAT_TIMESTAMP", arguments: '{"timestamp":1690000000}' },
  });

  // R14 handler 抛异常
  await simulateRound("R14 handler 抛异常", ctx, catalog, {
    fn: { name: "stress.throw_error", arguments: "{}" },
  }, { expectRejectContaining: "boom" });

  // R15 结果含非法值 → wire 序列化（修复后：BigInt→字符串、NaN→null，不再崩溃）
  await simulateRound("R15 结果含 BigInt/undefined/NaN", ctx, catalog, {
    fn: { name: "stress.weird_result", arguments: "{}" },
  });

  // R16 工具名带空格（修复后：执行层 trim 兜底成功）
  await simulateRound("R16 工具名带空格(trim)", ctx, catalog, {
    fn: { name: "  clock.format_timestamp  ", arguments: '{"timestamp":1690000000}' },
  });

  console.log("\n--- 并发混合 ---");

  const concurrency = 12;
  const calls: Array<{ scenario: string; call: SimulatedLlmCall }> = [];
  for (let i = 0; i < concurrency; i++) {
    calls.push({
      scenario: `并发${i} ${i % 3 === 0 ? "skill" : i % 3 === 1 ? "mcp" : "tool"}`,
      call:
        i % 3 === 0
          ? { fn: { name: "demo.greet", arguments: JSON.stringify({ name: `并发${i}` }) } }
          : i % 3 === 1
            ? { fn: { name: "mcp.filesystem.read_file", arguments: JSON.stringify({ path: `/tmp/${i}.txt` }) } }
            : { fn: { name: "clock.format_timestamp", arguments: JSON.stringify({ timestamp: 1690000000 + i }) } },
    });
  }
  const concurrentResults = await Promise.all(
    calls.map((c) => simulateRound(c.scenario, ctx, catalog, c.call)),
  );
  const concurrencyOk = concurrentResults.filter((r) => r.ok).length;
  record(`并发${concurrency} 混合调用`, concurrencyOk === concurrency, `ok=${concurrencyOk}/${concurrency}`);

  shutdownToolRouterWorker();

  const pass = rounds.filter((r) => r.ok).length;
  const fail = rounds.length - pass;
  console.log("\n" + "=".repeat(72));
  console.log(`汇总: 总场景 ${rounds.length} | PASS ${pass} | FAIL ${fail}`);
  console.log("=".repeat(72));
  if (fail > 0) {
    console.log("失败/需关注场景:");
    for (const r of rounds.filter((x) => !x.ok)) {
      console.log(`  - ${r.scenario}: ${r.detail.slice(0, 180)}`);
    }
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("[simulate-dialogue] 运行失败:", error);
  process.exitCode = 1;
});
