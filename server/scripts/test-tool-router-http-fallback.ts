/**
 * tool-router 回退逻辑测试：HTTP 服务不可达时，searchDeferredToolsViaToolRouter
 * 应自动回退 stdio bridge_worker 子进程，不影响检索结果。
 */
import "../src/config/load-server-env.js";

import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import {
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import { searchDeferredToolsViaToolRouter } from "../src/tools/tool-search/tool-router-adapter.js";

async function main(): Promise<void> {
  // 指向不存在的 HTTP 服务 → 应打印回退警告并走 stdio
  process.env.TOOL_ROUTER_HTTP_URL = "http://127.0.0.1:9999";
  console.log("[fallback-test] TOOL_ROUTER_HTTP_URL 指向不可达服务，期望回退 stdio");

  invalidateBuiltinToolsCache();
  invalidateFullCatalogCache();
  const allTools = getBuiltinAgentChatTools();
  const prepared = prepareToolsWithToolSearch([], allTools);

  const result = await searchDeferredToolsViaToolRouter(
    prepared.deferredCatalog,
    "what time is it now",
    5,
    { tenantId: "default", agentContextHash: "fallback-test" },
  );
  console.log(`[fallback-test] 回退检索返回 ${result.length} 条:`);
  console.log(JSON.stringify(result.slice(0, 3).map((m) => ({ name: m.name, score: m.score }))));
  if (result.length === 0 || result[0]?.name !== "clock.get_current_time") {
    console.error("[fallback-test] 回退结果不符合预期");
    process.exit(1);
  }
  console.log("[fallback-test] 回退 stdio 成功，结果正确");
}

main().catch((error) => {
  console.error("[fallback-test] 失败:", error);
  process.exit(1);
});
