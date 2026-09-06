/**
 * tool-router 主通路端点守卫回归（2026-09-06）。
 *
 * 契约：
 *   1. 预算：primary 尝试超过 TOOL_ROUTER_PRIMARY_BUDGET_MS 即抛
 *      PrimaryBudgetExceededError，不等底层慢操作；
 *   2. 熔断：连续 failures_to_open 次失败 → canAttempt()=false（零等待降级），
 *      冷却结束后半开放行，成功即闭合；
 *   3. 降级链：primary 被跳过/超预算时，searchWithAdaptiveFallback 必须落到
 *      进程内 adaptive 并返回正确结果（召回永不因 primary 挂而失败）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "router-guard-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";

const {
  RouterEndpointGuard,
  withPrimaryBudget,
  PrimaryBudgetExceededError,
  resetRouterEndpointGuard,
  getRouterEndpointGuard,
} = await import("../src/tools/tool-search/router-endpoint-guard.js");

function withEnvSync<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("预算：超时抛 PrimaryBudgetExceededError，不等待慢操作", async () => {
  const t0 = Date.now();
  await assert.rejects(
    withPrimaryBudget(
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5_000)),
      80,
    ),
    PrimaryBudgetExceededError,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1_000, `预算应在 ~80ms 生效，实际 ${elapsed}ms`);
});

test("预算：按时完成则正常透传结果", async () => {
  const result = await withPrimaryBudget(Promise.resolve("ok"), 500);
  assert.equal(result, "ok");
});

test("熔断：连续失败达到阈值 → 跳过 primary；冷却后半开；成功闭合", async () => {
  const guard = new RouterEndpointGuard();
  withEnvSync(
    {
      TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN: "2",
      TOOL_ROUTER_PRIMARY_COOLDOWN_MS: "50",
    },
    () => {
      assert.equal(guard.canAttempt().allowed, true);
      guard.recordFailure();
      assert.equal(guard.canAttempt().allowed, true, "未达阈值不熔断");
      guard.recordFailure({ budgetAbort: true });
      assert.equal(guard.snapshot().state, "open");
      assert.equal(guard.canAttempt().allowed, false, "达到阈值即熔断");
      assert.ok(guard.canAttempt().reason?.includes("circuit open"));
    },
  );
  await sleep(70);
  withEnvSync({ TOOL_ROUTER_PRIMARY_COOLDOWN_MS: "50" }, () => {
    assert.equal(guard.canAttempt().allowed, true, "冷却结束应半开放行");
    guard.recordSuccess();
    assert.equal(guard.snapshot().state, "closed", "成功后闭合");
  });
});

test("守卫单例：resetForTest 后恢复放行", () => {
  withEnvSync(
    { TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN: "1", TOOL_ROUTER_PRIMARY_COOLDOWN_MS: "60000" },
    () => {
      const guard = getRouterEndpointGuard();
      resetRouterEndpointGuard();
      assert.equal(guard.canAttempt().allowed, true);
      guard.recordFailure();
      assert.equal(guard.canAttempt().allowed, false);
      resetRouterEndpointGuard();
      assert.equal(guard.canAttempt().allowed, true);
    },
  );
});

test("降级链：primary 熔断时 searchWithAdaptiveFallback 落到进程内 adaptive", async () => {
  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
    "../src/tools/tool-search/index.js"
  );

  process.env.AGENT_TOOL_SEARCH_BACKEND = "tool_router";
  process.env.TOOL_ROUTER_HTTP_URL = "http://127.0.0.1:9"; // 端口 9：拒绝连接（快速失败）
  process.env.TOOL_ROUTER_STDIO_DISABLED = "1"; // 禁止 spawn Python
  process.env.TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN = "2";
  process.env.TOOL_ROUTER_PRIMARY_BUDGET_MS = "1000";
  resetRouterEndpointGuard();

  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const catalog = prepared.deferredCatalog;

  // 第一次：primary 连接失败（记账）→ adaptive 兜底，结果正确
  const t0 = Date.now();
  const r1 = await executeToolSearchBridge(
    "tool_discover",
    { query: "北京今天天气怎么样", limit: 3 },
    catalog,
  );
  const firstMs = Date.now() - t0;
  const names1 = ((r1.result as { matches?: Array<{ name: string }> }).matches ?? []).map(
    (m) => m.name,
  );
  assert.equal(
    names1[0],
    "weather.get_local",
    `adaptive 兜底应正确召回，实际：${names1.join(",")}`,
  );

  // 第二次失败后熔断打开：后续查询零等待直落 adaptive（不应再尝试 primary）
  const r2 = await executeToolSearchBridge(
    "tool_discover",
    { query: "找几张猫的照片", limit: 3 },
    catalog,
  );
  const names2 = ((r2.result as { matches?: Array<{ name: string }> }).matches ?? []).map(
    (m) => m.name,
  );
  assert.ok(names2.length > 0, "熔断后 adaptive 兜底仍应出结果");

  // 熔断状态下第三次应明显更快（无 primary 连接尝试开销）
  const t2 = Date.now();
  await executeToolSearchBridge("tool_discover", { query: "现在几点了", limit: 3 }, catalog);
  const thirdMs = Date.now() - t2;
  const snap = getRouterEndpointGuard().snapshot();
  assert.equal(snap.state, "open", "连续失败后应处于熔断态");
  assert.ok(snap.totalFailures >= 2, `应至少记录 2 次 primary 失败，实际 ${snap.totalFailures}`);
  assert.ok(
    thirdMs < Math.max(200, firstMs),
    `熔断后查询 (${thirdMs}ms) 应不慢于首查 (${firstMs}ms)`,
  );

  // 清理：恢复进程内 backend，重置守卫，避免影响其他测试
  delete process.env.TOOL_ROUTER_HTTP_URL;
  delete process.env.TOOL_ROUTER_STDIO_DISABLED;
  process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
  resetRouterEndpointGuard();
});
