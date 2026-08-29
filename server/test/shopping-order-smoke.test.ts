/**
 * shopping-order 能力模块安全冒烟测试。
 *
 * 验证护栏逻辑（不花真钱、不产生订单）：
 *   1. 工具 schema（4 个工具名 + 参数结构）
 *   2. 意图规则（prefix + 4 exact）
 *   3. 分类映射
 *   4. ToolRegistry 注册
 *   5. 沙箱模式下可调用（不因 agentAccessMode="sandbox" 被拒绝）
 *   6. 平台白名单拒绝（unknown platform）
 *   7. 无 Cookie 拒绝（沙箱下未导入 Cookie）
 *   8. confirm=true 缺 token 拒绝
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import {
  SHOPPING_ORDER_CHAT_TOOLS,
  SHOPPING_ORDER_INTENT_RULES,
  SHOPPING_ORDER_CATEGORY_MAPPING,
  registerShoppingOrderTools,
} from "../src/tools/capability-modules/shopping-order/index.js";
import type { ToolContext, ToolHandler, ToolRegistry } from "../src/tools/tool-registry.js";

/** 简易 mock registry，只记录注册的 handler（ToolRegistry 是 class 不是 interface，用 cast 绕过）。 */
class MockRegistry {
  readonly handlers = new Map<string, ToolHandler>();
  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

/** 构造测试用 ToolContext。 */
function makeCtx(mode: "full" | "sandbox" = "sandbox"): ToolContext {
  return {
    sessionId: "test-session-smoke",
    userId: "test-user-smoke",
    agentAccessMode: mode,
  };
}

/** 在临时数据目录中跑测试（无 Cookie 文件）。 */
async function withTempDataDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shopping-order-smoke-"));
  const prev = process.env.BROWSER_SESSION_DATA_DIR;
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.BROWSER_SESSION_DATA_DIR;
    else process.env.BROWSER_SESSION_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("SHOPPING_ORDER_CHAT_TOOLS has 4 tools with correct names", () => {
  const names = SHOPPING_ORDER_CHAT_TOOLS
    .map((t) => (t.type === "function" ? t.function?.name : null))
    .filter((n): n is string => Boolean(n));
  assert.equal(names.length, 4);
  assert.deepEqual(
    [...names].sort(),
    ["shopping.order.cancel", "shopping.order.place", "shopping.order.search", "shopping.order.track"],
  );
  // 每个工具必须有 description + parameters
  for (const tool of SHOPPING_ORDER_CHAT_TOOLS) {
    if (tool.type !== "function") continue;
    assert.ok(tool.function.description?.length, `${tool.function.name} 缺 description`);
    assert.ok(tool.function.parameters, `${tool.function.name} 缺 parameters`);
    assert.equal(tool.function.parameters?.type, "object");
    assert.equal(tool.function.parameters?.additionalProperties, false);
  }
});

test("shopping.order.search schema has platform enum + required query", () => {
  const tool = SHOPPING_ORDER_CHAT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "shopping.order.search",
  );
  assert.ok(tool);
  const params = (tool as { function: { parameters: { properties: Record<string, unknown>; required: string[] } } }).function.parameters;
  const platformProp = params.properties.platform as { enum: string[] };
  assert.ok(platformProp.enum.includes("taobao"));
  assert.ok(platformProp.enum.includes("jd"));
  assert.ok(platformProp.enum.includes("meituan"));
  assert.deepEqual(params.required, ["platform", "query"]);
});

test("shopping.order.place schema has two-stage confirm fields", () => {
  const tool = SHOPPING_ORDER_CHAT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "shopping.order.place",
  );
  assert.ok(tool);
  const params = (tool as { function: { parameters: { properties: Record<string, unknown>; required: string[] } } }).function.parameters;
  assert.ok(params.properties.confirm, "place 缺 confirm 字段");
  assert.ok(params.properties.confirmationToken, "place 缺 confirmationToken 字段");
  // confirm 不在 required（默认 false），item 必须
  assert.deepEqual(params.required, ["platform", "item"]);
});

test("SHOPPING_ORDER_INTENT_RULES has prefix rule + 4 exact rules", () => {
  const prefixRules = SHOPPING_ORDER_INTENT_RULES.filter((r) => "prefix" in r);
  const exactRules = SHOPPING_ORDER_INTENT_RULES.filter((r) => "exact" in r);
  assert.equal(prefixRules.length, 1);
  assert.equal(prefixRules[0]?.prefix, "shopping.order.");
  assert.equal(exactRules.length, 4);
  const exactNames = exactRules.map((r) => (r as { exact: string }).exact).sort();
  assert.deepEqual(exactNames, [
    "shopping.order.cancel",
    "shopping.order.place",
    "shopping.order.search",
    "shopping.order.track",
  ]);
  // prefix 规则必须有 negativeAliases（区分 shopping.suggest / wallet / fetch_page）
  const meta = prefixRules[0]?.metadata;
  assert.ok(meta?.negativeAliases?.some((a) => /suggest|推荐/.test(a)));
  assert.ok(meta?.negativeAliases?.some((a) => /wallet|记账/.test(a)));
});

test("SHOPPING_ORDER_CATEGORY_MAPPING has correct name + keywords", () => {
  assert.equal(SHOPPING_ORDER_CATEGORY_MAPPING.name, "shopping_order");
  assert.ok(SHOPPING_ORDER_CATEGORY_MAPPING.keywords.length >= 20);
  // 必须覆盖平台关键词
  assert.ok(SHOPPING_ORDER_CATEGORY_MAPPING.keywords.includes("淘宝"));
  assert.ok(SHOPPING_ORDER_CATEGORY_MAPPING.keywords.includes("京东"));
  assert.ok(SHOPPING_ORDER_CATEGORY_MAPPING.keywords.includes("下单"));
});

test("registerShoppingOrderTools registers 4 tools in registry", () => {
  const registry = new MockRegistry();
  const service = {} as ShoppingOrderService; // 只测注册，handler 不实际调用
  registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
  assert.equal(registry.handlers.size, 4);
  for (const name of ["shopping.order.search", "shopping.order.place", "shopping.order.track", "shopping.order.cancel"]) {
    assert.ok(registry.handlers.has(name), `未注册 ${name}`);
  }
});

test("sandbox mode does NOT reject shopping tools (access mode independent)", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("sandbox");

    // 沙箱模式下不应因访问模式被拒绝，而是因其他护栏（无 Cookie / 平台白名单）返回错误
    const searchResult = await registry.handlers.get("shopping.order.search")!({ platform: "taobao", query: "test" }, ctx);
    assert.equal(searchResult.ok, false);
    // 错误应是 Cookie 相关，而非「沙箱/完全访问」
    assert.match((searchResult as { error: string }).error, /未导入|Cookie|授权/);
    assert.doesNotMatch((searchResult as { error: string }).error, /沙箱|完全访问/);

    const trackResult = await registry.handlers.get("shopping.order.track")!({ platform: "taobao" }, ctx);
    assert.equal(trackResult.ok, false);
    assert.match((trackResult as { error: string }).error, /未导入|Cookie|授权/);
    assert.doesNotMatch((trackResult as { error: string }).error, /沙箱|完全访问/);

    // cancel 阶段一不需要 Cookie，沙箱下应能正常生成 token
    const cancelResult = await registry.handlers.get("shopping.order.cancel")!({ platform: "taobao", orderId: "123" }, ctx);
    assert.equal(cancelResult.ok, true);
    assert.equal((cancelResult as { needsConfirmation: boolean }).needsConfirmation, true);

    await service.dispose();
  });
});

test("unknown platform is rejected (platform whitelist)", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    // pdd 暂未实现 adapter
    const result = await registry.handlers.get("shopping.order.search")!({ platform: "pdd", query: "test" }, ctx);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /暂不支持/);

    await service.dispose();
  });
});

test("missing platform/query params are rejected", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    const noPlatform = await registry.handlers.get("shopping.order.search")!({ query: "test" }, ctx);
    assert.equal(noPlatform.ok, false);
    assert.match((noPlatform as { error: string }).error, /缺少 platform/);

    const noQuery = await registry.handlers.get("shopping.order.search")!({ platform: "taobao" }, ctx);
    assert.equal(noQuery.ok, false);
    assert.match((noQuery as { error: string }).error, /缺少 query/);

    await service.dispose();
  });
});

test("full access + taobao but no cookie → cookie rejection (no real browser launched)", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    // 未导入任何 Cookie，应在启动 Playwright 之前就返回 cookie 错误
    const result = await registry.handlers.get("shopping.order.search")!({ platform: "taobao", query: "iPhone" }, ctx);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /未导入|Cookie|授权/);

    await service.dispose();
  });
});

test("place with confirm=true but no token is rejected", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    const result = await registry.handlers.get("shopping.order.place")!({
      platform: "taobao",
      item: "iPhone",
      confirm: true,
      // 故意不传 confirmationToken
    }, ctx);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /confirmationToken/);

    await service.dispose();
  });
});

test("cancel with confirm=true but no token is rejected", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    const result = await registry.handlers.get("shopping.order.cancel")!({
      platform: "taobao",
      orderId: "123456",
      confirm: true,
    }, ctx);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /confirmationToken/);

    await service.dispose();
  });
});

test("cancel stage1 (confirm=false) generates confirmation token", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    // cancel 阶段一不需要 Cookie（只生成 token），应返回 needsConfirmation + token
    const result = await registry.handlers.get("shopping.order.cancel")!({
      platform: "taobao",
      orderId: "123456",
      confirm: false,
    }, ctx);
    assert.equal(result.ok, true);
    assert.equal((result as { needsConfirmation: boolean }).needsConfirmation, true);
    assert.ok((result as { confirmationToken: string }).confirmationToken);
    assert.match((result as { summary: string }).summary, /取消订单/);

    await service.dispose();
  });
});

test("place stage1 with no cookie is rejected before browser launch", async () => {
  await withTempDataDir(async () => {
    const browserSessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({ browserSessionService });
    const registry = new MockRegistry();
    registerShoppingOrderTools(registry as unknown as ToolRegistry, { shoppingOrderService: service });
    const ctx = makeCtx("full");

    // place 阶段一会先搜索（需要 Cookie），应在搜索阶段就因无 Cookie 被拒
    const result = await registry.handlers.get("shopping.order.place")!({
      platform: "taobao",
      item: "iPhone 15",
      confirm: false,
    }, ctx);
    assert.equal(result.ok, false);
    // 可能是搜索阶段无 Cookie，也可能是后续 getCookieAndSiteId 无 Cookie
    assert.match((result as { error: string }).error, /未导入|Cookie|授权/);

    await service.dispose();
  });
});
