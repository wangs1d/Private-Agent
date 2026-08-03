/**
 * 综合验证：
 *   1. BM25 跨轮缓存（全量索引复用）
 *   2. selectRelevantTools 兜底按优先级排序
 *   3. tool_choice 扩展强制（clock/weather/search）
 *   4. brain.list_capabilities include_schema 参数
 *   5. 自我进化 skill 注册 → ToolRegistry.list() → CapabilityCortex → tool-search 全链路
 *
 * 用法：tsx scripts/test-self-evolution-and-optimizations.ts
 */
import { CapabilityCortex } from "../src/brain/capability-cortex.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SkillManager } from "../src/skills/index.js";
import {
  getBuiltinAgentChatTools,
  selectRelevantTools,
  setBrainChatTools,
} from "../src/external-model/openai-compatible-tool-loop.js";
import { BRAIN_TOOLS } from "../src/tools/brain-tools.js";
import {
  prepareToolsWithToolSearch,
  invalidateFullCatalogCache,
} from "../src/tools/tool-search/index.js";
import { searchDeferredTools } from "../src/tools/tool-search/catalog.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}`);
  }
}

async function main(): Promise<void> {
  // 模拟 bootstrap：注入 brain tools schema
  setBrainChatTools(BRAIN_TOOLS);

  // ================================================================
  // 测试 1：BM25 跨轮缓存 —— 两次 prepareToolsWithToolSearch 复用全量索引
  // ================================================================
  console.log("\n[Test 1] BM25 跨轮缓存（全量索引复用）");

  const allTools = getBuiltinAgentChatTools();
  console.log(`  builtin tools 总数 = ${allTools.length}`);

  // 第一次调用：构建全量索引
  invalidateFullCatalogCache();
  const t0 = Date.now();
  const turn1 = prepareToolsWithToolSearch(allTools.slice(0, 10), allTools);
  const t1 = Date.now();
  console.log(`  第一次 prepare（含建索引）耗时 ${t1 - t0}ms，deferred=${turn1.deferredToolCount}`);

  // 第二次调用：复用全量索引，只过滤 entries
  const t2 = Date.now();
  const turn2 = prepareToolsWithToolSearch(allTools.slice(0, 15), allTools);
  const t3 = Date.now();
  console.log(`  第二次 prepare（复用索引）耗时 ${t3 - t2}ms，deferred=${turn2.deferredToolCount}`);

  assert(
    turn2.deferredToolCount < turn1.deferredToolCount,
    "第二次 visible 更多 → deferred 更少（缓存复用正确）",
  );

  // ================================================================
  // 测试 2：兜底按优先级排序 —— "在吗"命中很少时兜底选通用工具
  // ================================================================
  console.log("\n[Test 2] selectRelevantTools 兜底按优先级排序");

  const selected = selectRelevantTools("在吗", allTools, {
    minTools: 5,
    maxTools: allTools.length,
    includeAlwaysIncluded: true,
  });
  const selectedNames = selected
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  console.log(`  输入「在吗」选中 ${selectedNames.length} 个工具`);
  console.log(`  前 5：${selectedNames.slice(0, 5).join(", ")}`);

  assert(
    selectedNames.includes("search_web"),
    "兜底补充含 search_web（通用工具优先级最高）",
  );
  assert(
    selectedNames.includes("clock.get_current_time"),
    "ALWAYS_INCLUDED_TOOLS 含 clock.get_current_time",
  );

  // ================================================================
  // 测试 3：tool_choice 扩展强制 —— 时间/天气/搜索类强制调工具
  // ================================================================
  console.log("\n[Test 3] tool_choice 扩展强制（验证关键词命中）");

  // 验证 isExplicitPhoneCallRequest 仍生效
  const phoneSelected = selectRelevantTools("给我打个电话", allTools, {
    minTools: 4,
    maxTools: allTools.length,
    includeAlwaysIncluded: true,
  });
  const phoneNames = phoneSelected
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  assert(
    phoneNames.includes("phone.call_user"),
    "phone.call_user 被选中（电话关键词命中）",
  );

  // 验证 weather 工具被 weather 关键词命中
  const weatherSelected = selectRelevantTools("今天天气怎么样", allTools, {
    minTools: 4,
    maxTools: allTools.length,
    includeAlwaysIncluded: true,
  });
  const weatherNames = weatherSelected
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  console.log(`  「今天天气怎么样」选中：${weatherNames.slice(0, 8).join(", ")}`);
  assert(
    weatherNames.includes("weather.get_local"),
    "weather.get_local 被「天气」关键词命中",
  );

  // ================================================================
  // 测试 4：brain.list_capabilities include_schema 参数
  // ================================================================
  console.log("\n[Test 4] brain.list_capabilities include_schema 参数");

  assert(
    BRAIN_TOOLS.some(
      (t) => t.type === "function" && t.function?.name === "brain.list_capabilities",
    ),
    "BRAIN_TOOLS 包含 brain.list_capabilities",
  );

  const listCapTool = BRAIN_TOOLS.find(
    (t) => t.type === "function" && t.function?.name === "brain.list_capabilities",
  );
  const hasIncludeSchema =
    listCapTool?.type === "function" &&
    listCapTool.function.parameters?.properties &&
    "include_schema" in (listCapTool.function.parameters as { properties: Record<string, unknown> }).properties;
  assert(
    Boolean(hasIncludeSchema),
    "brain.list_capabilities schema 含 include_schema 参数",
  );

  // ================================================================
  // 测试 5：自我进化 skill 全链路
  //   注册 → ToolRegistry.list() → CapabilityCortex → tool-search
  // ================================================================
  console.log("\n[Test 5] 自我进化 skill 注册与识别全链路");

  // 构造 SkillManager + ToolRegistry
  const skillManager = new SkillManager();
  const toolRegistry = new ToolRegistry();
  toolRegistry.setSkillManager(skillManager);

  // 注册一个虚拟的 community skill（模拟 self.create_skill 的产物）
  const skillName = "weather.forecast_advanced";
  const skillDef = {
    metadata: {
      name: skillName,
      version: "1.0.0",
      displayName: "高级天气预报",
      description: "查询未来7天详细天气预报，含降水概率和风力",
      kind: "community" as const,
      parameters: [
        {
          name: "city",
          type: "string" as const,
          required: true,
          description: "城市名",
        },
        {
          name: "days",
          type: "number" as const,
          required: false,
          description: "预报天数（1-7）",
          default: 7,
        },
      ],
      permissions: [],
      timeoutMs: 10000,
      maxRetries: 1,
    },
    handler: async () => ({ ok: true, forecast: "晴" }),
  };
  skillManager.register(skillDef, { autoEnable: true, trustByDefault: true });

  // 5a. ToolRegistry.list() 立即看到新 skill
  const allToolNames = toolRegistry.list();
  console.log(`  ToolRegistry.list() 含 ${allToolNames.length} 个工具`);
  console.log(`  含 weather.forecast_advanced? ${allToolNames.includes(skillName)}`);
  assert(
    allToolNames.includes(skillName),
    "ToolRegistry.list() 立即看到新注册的 weather.forecast_advanced",
  );

  // 5b. CapabilityCortex attachToolNames 后 introspect 返回的 phone domain 含真实工具
  const cortex = new CapabilityCortex();
  cortex.attachToolNames(allToolNames);
  const weatherDomain = cortex.snapshot().find((c) => c.domain === "weather");
  console.log(`  weather domain tools = [${weatherDomain?.tools.join(", ")}]`);
  assert(
    weatherDomain?.tools.includes("weather.forecast_advanced") ?? false,
    "weather domain 含新注册的 weather.forecast_advanced",
  );

  // 5c. tool-search prepareToolsWithToolSearch 后 deferred catalog 含新 skill
  // 构造一个含新 skill schema 的工具列表
  const newSkillChatTool: ChatCompletionTool = {
    type: "function",
    function: {
      name: skillName,
      description: skillDef.metadata.description,
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名" },
          days: { type: "number", description: "预报天数", default: 7 },
        },
        required: ["city"],
      },
    },
  };
  // 失效缓存，让新 skill 进全量索引
  invalidateFullCatalogCache();
  const visibleWithCore = [...allTools.slice(0, 5)]; // 只暴露 5 个核心工具
  const searchableWithNew = [...allTools, newSkillChatTool];
  const prepared = prepareToolsWithToolSearch(visibleWithCore, searchableWithNew);
  console.log(`  prepared: visible=${prepared.coreToolCount}, deferred=${prepared.deferredToolCount}`);

  // 用 tool_discover 搜索新 skill
  const searchHits = searchDeferredTools(prepared.deferredCatalog, "天气预报 降水 风力", 5);
  console.log(`  tool_discover 搜「天气预报」命中 ${searchHits.length} 个：`);
  searchHits.forEach((h) => console.log(`    - ${h.name} (score=${h.score})`));
  assert(
    searchHits.some((h) => h.name === skillName),
    "tool_discover 能搜到新注册的 weather.forecast_advanced skill",
  );

  // 5d. selectRelevantTools 能选中（如果新 skill 的关键词命中）
  // 新 skill 名含 "weather"，TOOL_CATEGORY_MAPPINGS 的 weather 分类应命中
  const weatherSearch = selectRelevantTools("查天气预报", [newSkillChatTool, ...allTools.slice(0, 20)], {
    minTools: 3,
    maxTools: 30,
    includeAlwaysIncluded: true,
  });
  const weatherSearchNames = weatherSearch
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  console.log(`  selectRelevantTools「查天气预报」选中 ${weatherSearchNames.length} 个`);
  assert(
    weatherSearchNames.includes(skillName),
    "selectRelevantTools 能选中新注册的 weather.forecast_advanced",
  );

  // ================================================================
  // 测试 6：invalidateFullCatalogCache 让 BM25 索引重建后新 skill 可搜
  // ================================================================
  console.log("\n[Test 6] invalidateFullCatalogCache 后新 skill 可搜");

  // 先建一次不含新 skill 的索引
  invalidateFullCatalogCache();
  const turnOld = prepareToolsWithToolSearch([], allTools);
  const oldHits = searchDeferredTools(turnOld.deferredCatalog, "weather forecast advanced", 5);
  const oldHas = oldHits.some((h) => h.name === skillName);
  console.log(`  旧索引含 weather.forecast_advanced? ${oldHas}`);

  // 再建一次含新 skill 的索引（invalidate 后重建）
  invalidateFullCatalogCache();
  const turnNew = prepareToolsWithToolSearch([], [...allTools, newSkillChatTool]);
  const newHits = searchDeferredTools(turnNew.deferredCatalog, "weather forecast advanced", 5);
  const newHas = newHits.some((h) => h.name === skillName);
  console.log(`  新索引含 weather.forecast_advanced? ${newHas}`);
  assert(
    !oldHas,
    "旧索引不含新 skill（全量 builtin 没有它）",
  );
  assert(
    newHas,
    "invalidateFullCatalogCache 后重建索引含新 skill",
  );

  // ================================================================
  // 总结
  // ================================================================
  console.log("\n========== 总结 ==========");
  console.log(`通过：${pass}，失败：${fail}`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("测试执行失败：", err);
  process.exit(1);
});
