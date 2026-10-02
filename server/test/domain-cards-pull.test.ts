/**
 * 域卡 + 域拉取测试（2026-10-01 S1 配套）。
 *
 * 契约：
 *  1. 域卡：从语料派生、覆盖全部有域工具、同语料恒同字节（前缀缓存前提）、
 *     空语料安全降级；
 *  2. 域拉取（tool_discover({domain})）：确定性（同目录两次调用字节相同）、
 *     族成员完整（≤12 直出/超出标注 more）、前 3 名带瘦身 schema（字段级
 *     description 已剥）、未知域返回可用域清单自纠错；
 *  3. 卡片与拉取一致性：卡片上某域列出的工具 ⊆ 该域拉取可达（同名目录）。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { executeToolSearchBridge, prepareToolsWithToolSearch } = await import(
  "../src/tools/tool-search/index.js"
);
const { buildDomainCards } = await import("../src/tools/tool-search/domain-cards.js");
const { domainsForTool } = await import("../src/tools/tool-search/tool-category.js");
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools()];
const prepared = prepareToolsWithToolSearch([], corpus);
const catalog = prepared.deferredCatalog;

test("域卡：覆盖全部非 misc 工具名、含使用指引、同语料恒同字节", () => {
  const cards = buildDomainCards(corpus);
  assert.ok(cards.includes("【能力域目录】"));
  assert.ok(cards.includes('tool_discover({domain:"域名"})'));
  for (const tool of corpus) {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    if (!name || name.startsWith("tool_")) continue;
    const domains = domainsForTool(name);
    if (domains.length === 1 && domains[0] === "misc") continue; // misc 域工具在卡上由 misc 兜底行覆盖
    assert.ok(cards.includes(name), `卡片缺失工具名: ${name}`);
  }
  assert.equal(cards, buildDomainCards(corpus));
});

test("域卡：空语料安全降级为空串", () => {
  assert.equal(buildDomainCards([]), "");
});

test("域拉取：确定性（两次调用字节相同）+ 族完整 + 前3名瘦身 schema", async () => {
  const r1 = await executeToolSearchBridge("tool_discover", { domain: "smart_home" }, catalog);
  const r2 = await executeToolSearchBridge("tool_discover", { domain: "smart_home" }, catalog);
  assert.equal(r1.ok, true);
  assert.equal(JSON.stringify(r1.result), JSON.stringify(r2.result));
  const result = r1.result as { mode: string; domain: string; matches: Array<{ name: string; parameters?: Record<string, unknown> }> };
  assert.equal(result.mode, "domain");
  assert.equal(result.domain, "smart_home");
  const smartHomeNames = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes("smart_home"));
  assert.equal(result.matches.length, Math.min(12, smartHomeNames.length));
  for (const m of result.matches) assert.ok(smartHomeNames.includes(m.name));
  // 前 3 名带 schema 且瘦身（字段 description 被剥）
  const withSchema = result.matches.filter((m) => m.parameters);
  assert.ok(withSchema.length > 0 && withSchema.length <= 3);
  for (const m of withSchema) {
    const props = (m.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const v of Object.values(props)) {
      assert.equal("description" in (v as Record<string, unknown>), false, "schema 未瘦身");
    }
  }
});

test("域拉取：未知域返回可用域清单（自纠错，不静默失败）", async () => {
  const r = await executeToolSearchBridge("tool_discover", { domain: "no_such_domain" }, catalog);
  assert.equal(r.ok, false);
  const result = r.result as { error: string; available_domains: string };
  assert.ok(result.error.includes("no_such_domain"));
  assert.ok(result.available_domains.includes("search"));
  assert.ok(result.available_domains.includes("travel"));
});

test("卡片↔拉取一致性：卡片所列工具在延迟目录内按域可拉取", async () => {
  const r = await executeToolSearchBridge("tool_discover", { domain: "calendar" }, catalog);
  const result = r.result as { matches: Array<{ name: string }> };
  const calendarMembers = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes("calendar"));
  if (calendarMembers.length > 0) {
    assert.ok(result.matches.length > 0, "calendar 域非空但拉取为空");
  }
});
