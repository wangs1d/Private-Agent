/**
 * 工具调用链暴力测试（stress test）。
 *
 * 目标：验证 agent 调用工具链在走 tool-router 新架构时的健壮性，
 * 重点覆盖“解析问题”：
 *
 * Part 1 — Python tool-router HTTP 服务（默认 http://127.0.0.1:8787）
 *   - /api/resource/search：畸形/边界 query、limit 边界、缺失字段
 *   - /api/intent/decompose：畸形 query
 *   - /api/catalog/init：畸形资源
 *   - /api/resource/load：不存在/空/畸形 id
 *   - 并发搜索
 *
 * Part 2 — TS 桥接解析层（agent 真实调用链 executeToolSearchBridge）
 *   - tool_call：arguments 为字符串/数组/null/数字（LLM 常见解析偏差）
 *   - tool_search / tool_discover / tool_describe：畸形参数
 *   - 模拟 tool-loop 的 fn.arguments JSON.parse（单引号/尾逗号/空串/非法）
 *
 * 运行：cd server && npx tsx scripts/stress-test-tool-chain.ts
 * 前置：tool-router FastAPI 服务已启动（TOOL_ROUTER_HTTP_URL=http://127.0.0.1:8787）
 */
import "../src/config/load-server-env.js";

import { performance } from "node:perf_hooks";

import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import {
  executeToolSearchBridge,
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import {
  resolveToolRouterHttpUrl,
  prewarmToolRouterCatalogHttp,
} from "../src/tools/tool-search/tool-router-http-client.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";

const BASE = resolveToolRouterHttpUrl();
const COL_WIDTH = 56;

type CaseResult = { name: string; ok: boolean; detail: string };

const results: CaseResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const flag = ok ? "PASS" : "FAIL";
  console.log(`  [${flag}] ${name.padEnd(COL_WIDTH - 10)} ${detail.slice(0, 160)}`);
}

async function httpPost(
  path: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<{ status: number; payload: any; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    return { status: response.status, payload, raw };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Part 1 ----

async function part1HttpService(): Promise<void> {
  console.log("\n" + "=".repeat(72));
  console.log("Part 1 — Python tool-router HTTP 服务暴力测试");
  console.log("=".repeat(72));

  // 1.0 健康检查（GET 端点）
  try {
    const res = await fetch(`${BASE}/api/resource/health-check`, {
      method: "GET",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const payload = await res.json();
    record(
      "health-check(GET)",
      res.status === 200 && payload?.ok === true,
      `status=${res.status} ok=${payload?.ok ?? "?"}`,
    );
  } catch (error) {
    record("health-check(GET)", false, String(error));
  }

  // 1.1 search 畸形 query 系列
  const queries: Array<{ label: string; query: string }> = [
    { label: "空字符串", query: "" },
    { label: "纯空格", query: "   " },
    { label: "纯符号", query: "!@#$%^&*()_+{}[]|\\:;\"'<>,.?/~`" },
    { label: "emoji 表情", query: "🔔⏰ 提醒 📅 🛒 买菜 🏪" },
    { label: "中文长句", query: "明天下午三点提醒我去机场接客户并顺便查一下附近餐厅的营业时间" },
    { label: "混合语言", query: "weather 天气 tomorrow 明天 30度 high fever" },
    { label: "JSON 注入", query: '{"a":1,"b":["x","y"]}' },
    { label: "SQL 注入", query: "'; DROP TABLE tools;--" },
    { label: "控制字符", query: "ab\x00cd\x01ef\n\t\r" },
    { label: "超长 5000 字符", query: "a".repeat(5000) },
    { label: "重复关键词 1000", query: "reminder reminder ".repeat(500) },
    { label: "仅数字", query: "1234567890" },
    { label: "仅标点+中文", query: "。。。？？！！" },
    { label: "反斜杠结尾", query: "path\\to\\nowhere\\" },
    { label: "制表符填充", query: "\t\t\t  calendar \t\t" },
  ];
  for (const { label, query } of queries) {
    const t0 = performance.now();
    try {
      const res = await httpPost("/api/resource/search", {
        raw_user_query: query,
        agent_context_hash: `stress-${label}`,
        tenant_id: "default",
        environment: "prod",
        limit: 5,
      });
      const ms = (performance.now() - t0).toFixed(1);
      if (res.status !== 200) {
        record(`search:${label}`, false, `HTTP ${res.status} raw=${res.raw.slice(0, 120)}`);
      } else if (res.payload?.ok !== true) {
        record(`search:${label}`, false, `ok=false error=${JSON.stringify(res.payload)}`);
      } else if (!Array.isArray(res.payload?.data?.candidates)) {
        record(`search:${label}`, false, `candidates 非数组: ${JSON.stringify(res.payload?.data ?? res.payload).slice(0, 120)}`);
      } else {
        const names = res.payload.data.candidates.map((c: any) => c.name);
        record(`search:${label}`, true, `candidates=${names.length} ${names.slice(0, 3).join(",") || "(空目录)"} ${ms}ms`);
      }
    } catch (error) {
      record(`search:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 1.2 search limit 边界
  const limits: Array<{ label: string; limit: unknown }> = [
    { label: "limit=0", limit: 0 },
    { label: "limit=-1", limit: -1 },
    { label: "limit=99999", limit: 99999 },
    { label: "limit=字符串abc", limit: "abc" },
    { label: "limit=字符串5.5", limit: "5.5" },
    { label: "limit=null", limit: null },
    { label: "limit=缺失", limit: undefined },
    { label: "limit=布尔true", limit: true },
    { label: "limit=对象", limit: { n: 3 } },
    { label: "limit=数组", limit: [3] },
  ];
  for (const { label, limit } of limits) {
    const body: Record<string, unknown> = {
      raw_user_query: "set a reminder",
      agent_context_hash: `stress-limit-${label}`,
      tenant_id: "default",
      environment: "prod",
    };
    if (limit !== undefined) body.limit = limit;
    try {
      const res = await httpPost("/api/resource/search", body);
      const data = res.payload?.data;
      const candidates = Array.isArray(data?.candidates) ? data.candidates : null;
      record(
        `search:limit-${label}`,
        res.status === 200 && res.payload?.ok === true && candidates !== null,
        `status=${res.status} ok=${res.payload?.ok ?? "?"} candidates=${candidates?.length ?? "非数组"}`,
      );
    } catch (error) {
      record(`search:limit-${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 1.3 intent/decompose 畸形 query
  const decomposeQueries = ["", "   ", "\x00\x01", "🔔⏰", "a".repeat(8000), "  remind  me  "];
  for (const q of decomposeQueries) {
    try {
      const res = await httpPost("/api/intent/decompose", {
        raw_user_query: q,
        agent_context_hash: "stress-decompose",
      });
      const data = res.payload?.data;
      const intent = data?.intent ?? null;
      const confidence = data?.confidence ?? null;
      record(
        `decompose:${JSON.stringify(q.slice(0, 20))}`,
        res.status === 200 && res.payload?.ok === true && typeof intent === "string" && typeof confidence === "number",
        `status=${res.status} intent=${JSON.stringify(intent)} conf=${confidence}`,
      );
    } catch (error) {
      record(`decompose:${JSON.stringify(q.slice(0, 20))}`, false, String(error).slice(0, 120));
    }
  }

  // 1.4 catalog/init 畸形资源
  const initCases: Array<{ label: string; body: unknown }> = [
    { label: "空 resources", body: { resources: [], edges: [] } },
    {
      label: "缺 name 的资源",
      body: { resources: [{ level1: { resource_id: "x", description: "no name" }, level3: { tool: null } }], edges: [] },
    },
    {
      label: "resource_id 超长",
      body: {
        resources: [
          {
            level1: {
              resource_id: "r".repeat(5000),
              resource_type: "tool",
              name: "tool_" + "x".repeat(5000),
              description: "d",
              domain: "misc",
            },
            level3: { tool: { parameters: {}, required: [] } },
          },
        ],
        edges: [],
      },
    },
    {
      label: "unicode 特殊字符",
      body: {
        resources: [
          {
            level1: {
              resource_id: "中文_工具.⏰",
              resource_type: "tool",
              name: "中文工具⏰",
              description: "描述<tag>&amp; \\\"引号\\\" \u0000空字符",
              domain: "misc",
            },
            level3: { tool: { parameters: { type: "object", properties: { "a.b": { type: "string" } } }, required: [] } },
          },
        ],
        edges: [],
      },
    },
    {
      label: "level3 全 null",
      body: {
        resources: [
          {
            level1: {
              resource_id: "y",
              resource_type: "tool",
              name: "y",
              description: "no level3",
              domain: "misc",
            },
            level3: null,
          },
        ],
        edges: [],
      },
    },
  ];
  for (const { label, body } of initCases) {
    try {
      const res = await httpPost("/api/catalog/init", body);
      record(
        `init:${label}`,
        res.status === 200 && res.payload?.ok === true,
        `status=${res.status} ok=${res.payload?.ok ?? "?"} summary=${JSON.stringify(res.payload?.data?.summary ?? res.payload?.detail ?? "").slice(0, 120)}`,
      );
    } catch (error) {
      record(`init:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 1.5 resource/load 畸形 id
  // 注意：当前服务目录未注册真实 catalog，所有 id 均应 404（不崩溃即可）
  const loadIds = ["", "  ", "nonexistent_tool_xyz", "clock.get_current_time", "中文", "a".repeat(3000)];
  for (const id of loadIds) {
    try {
      const res = await httpPost("/api/resource/load", { resource_id: id });
      const ok = res.status === 404;
      record(
        `load:${JSON.stringify(id.slice(0, 20))}`,
        ok,
        `status=${res.status} body=${res.raw.slice(0, 100)}`,
      );
    } catch (error) {
      record(`load:${JSON.stringify(id.slice(0, 20))}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 1.6 并发搜索压力（30 并发）
  const CONCURRENCY = 30;
  const t0 = performance.now();
  const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
    httpPost("/api/resource/search", {
      raw_user_query: i % 2 === 0 ? "what time is it now" : "set a reminder 提醒我买菜",
      agent_context_hash: `stress-conc-${i}`,
      tenant_id: "default",
      environment: "prod",
      limit: 5,
    }),
  );
  const settled = await Promise.allSettled(tasks);
  const okCount = settled.filter(
    (s) => s.status === "fulfilled" && s.value.status === 200 && s.value.payload?.ok === true,
  ).length;
  const elapsed = (performance.now() - t0).toFixed(1);
  record(`search:并发${CONCURRENCY}`, okCount === CONCURRENCY, `ok=${okCount}/${CONCURRENCY} ${elapsed}ms`);
}

// ---------------------------------------------------------------- Part 2 ----

function simulateToolLoopArgumentsParse(raw: string): Record<string, unknown> {
  // 复现 openai-compatible-tool-loop.ts 的解析：JSON.parse 失败静默降级 {}
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function part2BridgeParsing(): Promise<void> {
  console.log("\n" + "=".repeat(72));
  console.log("Part 2 — TS 桥接解析层暴力测试（executeToolSearchBridge）");
  console.log("=".repeat(72));

  invalidateBuiltinToolsCache();
  invalidateFullCatalogCache();
  const allTools = getBuiltinAgentChatTools();
  const prepared = prepareToolsWithToolSearch([], allTools);
  const deferredCatalog = prepared.deferredCatalog;
  console.log(`\n工具目录: visible=${prepared.visibleTools.length} deferred=${prepared.deferredCatalog.entries.length} searchActive=${prepared.toolSearchActive}`);

  // 预热真实 catalog 到 HTTP 服务（保证搜索有真实候选）
  try {
    await prewarmToolRouterCatalogHttp(deferredCatalog, { tenantId: "default", environment: "prod" });
    console.log("HTTP catalog prewarm 完成");
  } catch (error) {
    console.warn("HTTP prewarm 失败（后续搜索可能空）：", String(error));
  }

  // 2.1 tool_call 参数解析（重点：LLM 常把 arguments 传成字符串）
  const callCases: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: "arguments 为 JSON 字符串", args: { name: "clock.get_current_time", arguments: '{"format":"full"}' } },
    { label: "arguments 为普通字符串", args: { name: "clock.get_current_time", arguments: "format=full" } },
    { label: "arguments 为 null", args: { name: "clock.get_current_time", arguments: null } },
    { label: "arguments 为数组", args: { name: "clock.get_current_time", arguments: ["format", "full"] } },
    { label: "arguments 为数字", args: { name: "clock.get_current_time", arguments: 42 } },
    { label: "arguments 缺失", args: { name: "clock.get_current_time" } },
    { label: "arguments 为布尔", args: { name: "clock.get_current_time", arguments: true } },
    { label: "name 不存在", args: { name: "nonexistent_tool_xyz", arguments: { a: 1 } } },
    { label: "name 大写变体", args: { name: "CLOCK.GET_CURRENT_TIME", arguments: {} } },
    { label: "name 为空串", args: { name: "", arguments: {} } },
    { label: "name 缺失", args: { arguments: {} } },
    { label: "name 带空格", args: { name: " clock.get_current_time ", arguments: {} } },
  ];
  for (const { label, args } of callCases) {
    try {
      const bridge = await executeToolSearchBridge("tool_call", args, deferredCatalog);
      if (bridge.kind === "call" && bridge.ok) {
        const parsedKeys = Object.keys(bridge.parsedArgs ?? {}).join(",") || "(空)";
        record(`tool_call:${label}`, true, `→ ${bridge.registryToolName} args={${parsedKeys}}`);
      } else if (bridge.kind === "call" && !bridge.ok) {
        const err = (bridge.result as { error?: string }).error ?? "?";
        record(`tool_call:${label}`, true, `ok=false error=${err}`);
      } else {
        record(`tool_call:${label}`, false, `异常返回 kind=${bridge.kind}`);
      }
    } catch (error) {
      record(`tool_call:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 2.2 tool_search 边界
  const searchCases: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: "空 query", args: { query: "" } },
    { label: "query 缺失", args: {} },
    { label: "query 纯空格", args: { query: "   " } },
    { label: "query emoji", args: { query: "🔔 提醒我 ⏰" } },
    { label: "limit 字符串", args: { query: "reminder", limit: "3" } },
    { label: "limit 负数", args: { query: "reminder", limit: -5 } },
    { label: "limit 超大", args: { query: "reminder", limit: 99999 } },
    { label: "include_schema 字符串", args: { query: "reminder", include_schema: "yes" } },
    { label: "query 超长", args: { query: "x".repeat(4000) } },
  ];
  for (const { label, args } of searchCases) {
    try {
      const bridge = await executeToolSearchBridge("tool_search", args, deferredCatalog);
      if (bridge.kind !== "search") {
        record(`tool_search:${label}`, false, `返回 kind=${bridge.kind}`);
        continue;
      }
      if (!bridge.ok) {
        const err = (bridge.result as { error?: string }).error ?? "?";
        record(`tool_search:${label}`, true, `ok=false error=${err.slice(0, 80)}`);
      } else {
        const matches = (bridge.result.matches as Array<{ name: string; score?: number }>) ?? [];
        const names = matches.slice(0, 3).map((m) => m.name).join(",") || "(空)";
        record(`tool_search:${label}`, true, `count=${matches.length} ${names}`);
      }
    } catch (error) {
      record(`tool_search:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 2.3 tool_discover 边界
  const discoverCases: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: "仅 query", args: { query: "check my wallet balance" } },
    { label: "query+name", args: { query: "wallet balance", name: "wallet.get_balance" } },
    { label: "仅 name 不存在", args: { name: "no_such_tool" } },
    { label: "无 query 无 name", args: {} },
    { label: "include_schema 为 true", args: { query: "reminder", include_schema: true } },
    { label: "name 带前缀点", args: { name: "..clock..get_current_time.." } },
  ];
  for (const { label, args } of discoverCases) {
    try {
      const bridge = await executeToolSearchBridge("tool_discover", args, deferredCatalog);
      if (bridge.kind !== "discover") {
        record(`tool_discover:${label}`, false, `返回 kind=${bridge.kind}`);
        continue;
      }
      if (!bridge.ok) {
        const err = (bridge.result as { error?: string }).error ?? "?";
        record(`tool_discover:${label}`, true, `ok=false error=${err.slice(0, 80)}`);
      } else {
        const r = bridge.result as { mode?: string; tool?: unknown; matches?: Array<{ name: string }>; count?: number };
        const matches = r.matches ?? [];
        const names = matches.slice(0, 3).map((m) => m.name).join(",") || "(空)";
        record(`tool_discover:${label}`, true, `mode=${r.mode} count=${r.count ?? "?"} ${names}`);
      }
    } catch (error) {
      record(`tool_discover:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 2.4 tool_describe 边界
  const describeCases: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: "存在", args: { name: "clock.get_current_time" } },
    { label: "不存在", args: { name: "ghost_tool" } },
    { label: "空 name", args: { name: "" } },
    { label: "name 缺失", args: {} },
  ];
  for (const { label, args } of describeCases) {
    try {
      const bridge = await executeToolSearchBridge("tool_describe", args, deferredCatalog);
      if (bridge.kind !== "describe") {
        record(`tool_describe:${label}`, false, `返回 kind=${bridge.kind}`);
        continue;
      }
      if (!bridge.ok) {
        const err = (bridge.result as { error?: string }).error ?? "?";
        record(`tool_describe:${label}`, true, `ok=false error=${err.slice(0, 80)}`);
      } else {
        record(`tool_describe:${label}`, true, `schema=${JSON.stringify((bridge.result as { name?: string }).name ?? "?").slice(0, 60)}`);
      }
    } catch (error) {
      record(`tool_describe:${label}`, false, `exception=${String(error).slice(0, 120)}`);
    }
  }

  // 2.5 未知桥接工具名
  try {
    const bridge = await executeToolSearchBridge("tool_hack", { query: "x" }, deferredCatalog);
    record(
      "未知桥接名 tool_hack",
      bridge.kind === "search" && bridge.ok === false,
      `kind=${bridge.kind} ok=${bridge.ok} error=${((bridge.result as { error?: string })?.error ?? "?").slice(0, 80)}`,
    );
  } catch (error) {
    record("未知桥接名 tool_hack", false, `exception=${String(error).slice(0, 120)}`);
  }

  // 2.6 模拟 tool-loop 顶层 fn.arguments JSON.parse
  const parseCases: Array<{ label: string; raw: string }> = [
    { label: "合法对象", raw: '{"query":"x"}' },
    { label: "单引号 JSON", raw: "{'query':'x'}" },
    { label: "尾逗号", raw: '{"query":"x",}' },
    { label: "空串", raw: "" },
    { label: "null", raw: "null" },
    { label: "数组 JSON", raw: '[{"a":1}]' },
    { label: "字符串 JSON", raw: '"hello"' },
    { label: "纯文本", raw: "just text" },
    { label: "截断 JSON", raw: '{"query":"x' },
    { label: "undefined 字面", raw: "undefined" },
    { label: "NaN 字面", raw: "NaN" },
    { label: "深层嵌套", raw: '{"a":{"b":{"c":{"d":[1,2,{"e":null}]}}}}' },
  ];
  for (const { label, raw } of parseCases) {
    const parsed = simulateToolLoopArgumentsParse(raw);
    const keys = Object.keys(parsed ?? {}).join(",") || "(空对象/降级{})";
    record(`parse:${label}`, true, `keys=${keys}`);
  }
}

// ------------------------------------------------------------------ main ----

async function main(): Promise<void> {
  if (!BASE) {
    console.error("TOOL_ROUTER_HTTP_URL 未配置，无法测试 HTTP 服务。请先启动 tool-router。");
    process.exit(1);
  }
  console.log(`tool-router 目标: ${BASE}`);
  console.log(`后端模式: AGENT_TOOL_SEARCH_BACKEND=${process.env.AGENT_TOOL_SEARCH_BACKEND ?? "(默认 tool_router)"}`);

  await part1HttpService();
  await part2BridgeParsing();

  shutdownToolRouterWorker();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log("\n" + "=".repeat(72));
  console.log(`汇总: 总用例 ${results.length} | PASS ${pass} | FAIL ${fail}`);
  console.log("=".repeat(72));
  if (fail > 0) {
    console.log("失败用例:");
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}: ${r.detail.slice(0, 160)}`);
    }
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("[stress-test] 运行失败:", error);
  process.exitCode = 1;
});
