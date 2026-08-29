import assert from "node:assert/strict";
import test from "node:test";
import { MeituanService } from "../src/services/meituan-service.js";
import { registerMeituanTools } from "../src/tools/meituan-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "test-session-mt-001",
    userId: "test-user-mt-001",
    ...overrides,
  };
}

function makeService(): MeituanService {
  return new MeituanService({
    accessToken: "test-token",
    skillId: "19",
    apiBaseUrl: "https://mock-meituan-api.local/api/v2/ai-hub",
  });
}

test("MeituanService - estimatePrice returns reasonable range", () => {
  const service = makeService();

  const short = service.estimatePrice("文件");
  assert.ok(short.low < short.high);
  assert.ok(short.low > 0);

  const medium = service.estimatePrice("一份文件需要从A送到B");
  assert.ok(medium.low >= short.low);

  const long = service.estimatePrice("一份很重要的文件需要从公司送到客户那里，包含合同和多份资料");
  assert.ok(long.low >= medium.low);
});

test("MeituanService - config overrides work", () => {
  const service = new MeituanService({
    accessToken: "custom-token",
    skillId: "42",
    apiBaseUrl: "https://custom-api.local",
  });

  const estimate = service.estimatePrice("test");
  assert.ok(estimate.low > 0);
  assert.ok(estimate.high > estimate.low);
});

test("Meituan tools - meituan.estimate_price", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.estimate_price",
    { description: "帮我送一份文件到对面大楼" },
    makeContext()
  );

  assert.equal(result.ok, true);
  assert.ok(result.result.estimatedLow);
  assert.ok(result.result.estimatedHigh);
  assert.equal(result.result.currency, "CNY");
});

test("Meituan tools - meituan.estimate_price without description", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.estimate_price",
    { description: "" },
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Meituan tools - meituan.pricing without addresses", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.pricing",
    {},
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Meituan tools - meituan.create_order without required fields", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.create_order",
    {},
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Meituan tools - meituan.query_order without orderId", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.query_order",
    {},
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Meituan tools - meituan.cancel_order without orderId", async () => {
  const registry = new ToolRegistry();
  const service = makeService();
  registerMeituanTools(registry, service);

  const result = await registry.execute(
    "meituan.cancel_order",
    {},
    makeContext()
  );

  assert.equal(result.ok, false);
});
